import { Worker } from 'worker_threads';
import {
  readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync, unlinkSync, rmSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { cpus } from 'os';
import { createHash } from 'crypto';
import sharp from 'sharp';
sharp.concurrency(1); // keep libvips from fanning out across all cores
import { MapMeta, writeViewer } from './viewer';
import { NBTParser, findChildTagAtPath } from 'mc-anvil';
import type { TagData } from 'mc-anvil';
import type { TileResult, BiomeCells } from './worker';
import { buildBiomeGeoJSON, BIOME_NONE, type GeoJSON } from './biomevector';
import { TINTS, BLOCK_ALIASES, BIOME_ALIASES, LEGACY_BIOME_IDS, SUBMERGED_PLANTS } from './gamedata';
import { renderConfig } from './renderconfig';
import { startPlayerTracker } from './players';

const TILE = 512; // Leaflet tileSize; one base tile == one region
const MANIFEST = 'render-manifest.json';
const MANIFEST_VERSION = 2; // bumped for the biome super-tile layout

// Bump only when the coloring *algorithm* changes — shading math, the blur, the
// water-depth formula, the fallback colour — i.e. logic that isn't already
// captured by the colour-table, render-config, or TINTS hashes below. (Changing
// a colour table, a MAP_* setting/default, or which blocks tint is detected
// automatically, so those don't need a bump.)
const RENDER_VERSION = 6;

// Colour tables whose contents feed the render signature (resolved like the worker).
const MAP_COLORS_PATH = process.env.MAP_COLORS_PATH ?? resolve(process.cwd(), 'assets/map_colors.json');
const BIOME_COLORS_PATH = process.env.BIOME_COLORS_PATH ?? resolve(process.cwd(), 'assets/biome_colors.json');

// A short hash of everything (besides the world) that affects rendered pixels:
// the colour tables, the resolved render config (MAP_* env-or-default), and the
// tint rules. When it changes, cached tiles are stale and the map is redrawn.
function renderSignature(): string {
  const h = createHash('sha1').update(`render:${RENDER_VERSION}`);
  for (const p of [MAP_COLORS_PATH, BIOME_COLORS_PATH]) {
    try { h.update(readFileSync(p)); } catch { h.update('\0missing\0'); }
  }
  h.update('\0cfg=' + JSON.stringify(renderConfig()));
  h.update('\0tints=' + JSON.stringify(TINTS));
  h.update('\0aliases=' + JSON.stringify(BLOCK_ALIASES));
  h.update('\0biomealiases=' + JSON.stringify(BIOME_ALIASES));
  h.update('\0legacybiomes=' + JSON.stringify(LEGACY_BIOME_IDS));
  h.update('\0submerged=' + JSON.stringify([...SUBMERGED_PLANTS]));
  return h.digest('hex').slice(0, 16);
}

// Biome vector layer: the worker decides the cell resolution (it's in each
// region's payload); regions are grouped into BIOME_SUPER x BIOME_SUPER
// super-tiles to cut the viewer's request count.
const BIOME_TOL_CELLS = 2; // "medium" simplification (tolerance in cells, ~8 blocks)
const BIOME_SUPER = 5; // regions per super-tile side (5x5 = 25 regions/file)
const BIOMES_DIR = 'biomes'; // super-tile biome GeoJSON, served to the viewer

// Minecraft version this renderer was written for. The bundled map_colors.json /
// biome_colors.json and the TINTS table in gamedata.ts were generated against
// it; if a world reports a different DataVersion the colors may be stale and
// should be regenerated with the map-color-dump mod for that version.
const TARGET_VERSION = '26.2';
const TARGET_DATA_VERSION = 4903;

// --- region folder resolution (modern layout + legacy fallback) -------------
function regionDir(worldPath: string, dimension: string): string {
  const [ns, p] = (dimension.includes(':')
    ? dimension.split(':')
    : ['minecraft', dimension]) as [string, string];
  const modern = join(worldPath, 'dimensions', ns, p, 'region');
  if (existsSync(modern)) return modern;
  const legacy: Record<string, string> = {
    'minecraft:overworld': join(worldPath, 'region'),
    'minecraft:the_nether': join(worldPath, 'DIM-1', 'region'),
    'minecraft:the_end': join(worldPath, 'DIM1', 'region'),
  };
  const fb = legacy[`${ns}:${p}`];
  if (fb && existsSync(fb)) return fb;
  throw new Error(`No region folder for ${ns}:${p} (looked in ${modern})`);
}

type RegionFile = { file: string; rx: number; rz: number };
type Job = RegionFile & { since: number; mtimeMs: number };

function listRegions(dir: string): RegionFile[] {
  const out: RegionFile[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
    if (m) out.push({ file: join(dir, f), rx: +m[1], rz: +m[2] });
  }
  return out;
}

// --- render manifest (incremental state) ------------------------------------
type RegionEntry = { lastUpdate: number; mtimeMs: number };
type Manifest = {
  version: number;
  dimension: string;
  tileSize: number;
  originRx: number;
  originRz: number;
  maxZoom: number;
  renderSig: string; // fingerprint of colour tables + pixel env (see renderSignature)
  regions: Record<string, RegionEntry>;
};

function loadManifest(outDir: string): Manifest | null {
  const f = join(outDir, MANIFEST);
  if (!existsSync(f)) return null;
  try {
    const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
    if (m && m.version === MANIFEST_VERSION && m.regions) return m;
  } catch { /* fall through to full redraw */ }
  return null;
}

// Can we reuse the cached tile grid? Only if the render signature matches (else
// colours/tints changed and every tile is stale), the dimension/tileSize match,
// and every current region still maps into the cached origin + maxZoom envelope
// (else the tile coordinates would shift and the whole pyramid is invalid).
function reusable(m: Manifest | null, dimension: string, regions: RegionFile[], renderSig: string): m is Manifest {
  if (!m || m.renderSig !== renderSig || m.dimension !== dimension || m.tileSize !== TILE) return false;
  const grid = 2 ** m.maxZoom;
  for (const r of regions) {
    const tx = r.rx - m.originRx;
    const ty = r.rz - m.originRz;
    if (tx < 0 || ty < 0 || tx >= grid || ty >= grid) return false;
  }
  return true;
}

// --- spawn + version from level.dat -----------------------------------------
type WorldVersion = { name: string | null; dataVersion: number | null };

function readLevel(worldPath: string): {
  spawn: { x: number; z: number } | null;
  version: WorldVersion | null;
} {
  const f = join(worldPath, 'level.dat');
  if (!existsSync(f)) return { spawn: null, version: null };
  try {
    const buf = readFileSync(f);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const root = new NBTParser(ab).getTag() as TagData; // NBTParser auto-gunzips

    let spawn: { x: number; z: number } | null = null;
    const pos = findChildTagAtPath('Data/spawn/pos', root);
    if (pos && Array.isArray(pos.data) && pos.data.length >= 3) {
      spawn = { x: Number(pos.data[0]), z: Number(pos.data[2]) };
    } else {
      const sx = findChildTagAtPath('Data/SpawnX', root);
      const sz = findChildTagAtPath('Data/SpawnZ', root);
      if (sx && sz) spawn = { x: Number(sx.data), z: Number(sz.data) };
    }

    const nameT = findChildTagAtPath('Data/Version/Name', root);
    const dvT = findChildTagAtPath('Data/DataVersion', root);
    const name = nameT && typeof nameT.data === 'string' ? nameT.data : null;
    const dataVersion = dvT && (typeof dvT.data === 'number' || typeof dvT.data === 'bigint')
      ? Number(dvT.data)
      : null;
    const version = name !== null || dataVersion !== null ? { name, dataVersion } : null;

    return { spawn, version };
  } catch {
    return { spawn: null, version: null };
  }
}

// --- worker pool ------------------------------------------------------------
function runWorker(job: Job): Promise<TileResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(join(__dirname, 'worker.js'), { workerData: job });
    w.once('message', (msg: TileResult) => {
      resolve(msg);
      void w.terminate();
    });
    w.once('error', reject);
  });
}

async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
  onResult: (r: R) => void,
): Promise<void> {
  let i = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length || 1)) },
    async () => {
      while (i < items.length) onResult(await fn(items[i++]));
    },
  );
  await Promise.all(runners);
}

// --- tile IO ----------------------------------------------------------------
const tilePath = (root: string, z: number, x: number, y: number): string =>
  join(root, String(z), String(x), `${y}.png`);

function writePng(p: string, buf: Buffer): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
}

function rmTile(root: string, z: number, x: number, y: number): void {
  const p = tilePath(root, z, x, y);
  try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
}

// --- biome super-tiles ------------------------------------------------------
// Biomes are fixed at world-gen, so a region's polygons only need (re)drawing
// when that region itself (re)renders. To keep the viewer's request count down,
// regions are grouped into BIOME_SUPER x BIOME_SUPER "super-tiles", one GeoJSON
// file each. Every feature is tagged with its region id, so when a single region
// re-renders we drop just that region's features from the super-tile and re-add
// the new ones — no separate cache, no global re-merge. Coordinates are global,
// so the pieces line up.
type BiomeFeature = GeoJSON['features'][number];

const superId = (tx: number, ty: number): string =>
  `${Math.floor(tx / BIOME_SUPER)}_${Math.floor(ty / BIOME_SUPER)}`;

// Polygonize one region's cells into features (global CRS.Simple coords), each
// tagged with its region id so it can be replaced independently later.
function regionFeatures(
  cells: BiomeCells, rx: number, rz: number, rid: string,
  minX: number, minZ: number, maxZoom: number,
): BiomeFeature[] {
  const size = TILE / cells.res; // square grid side, e.g. 512/4 = 128
  const grid = new Uint16Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = cells.data[i] === 255 ? BIOME_NONE : cells.data[i];
  const gj = buildBiomeGeoJSON(
    { grid, width: size, height: size, res: cells.res, minBlockX: rx * TILE, minBlockZ: rz * TILE, palette: cells.palette },
    minX, minZ, maxZoom, BIOME_TOL_CELLS,
  );
  for (const f of gj.features) (f.properties as { r?: string }).r = rid;
  return gj.features;
}

// Apply this run's per-region changes to the affected super-tile files: drop the
// changed regions' old features, add their new ones (null = region went away).
function updateSuperTiles(dir: string, changes: Map<string, Map<string, BiomeFeature[] | null>>): void {
  for (const [sid, regionMap] of changes) {
    const p = join(dir, `${sid}.geojson`);
    let features: BiomeFeature[] = [];
    if (existsSync(p)) {
      try { features = (JSON.parse(readFileSync(p, 'utf8')) as GeoJSON).features; } catch { /* redraw */ }
    }
    // Drop features of the regions being replaced/removed, keep the rest.
    features = features.filter(f => !regionMap.has((f.properties as { r?: string }).r ?? ''));
    for (const feats of regionMap.values()) if (feats) features.push(...feats);
    if (features.length) writeFileSync(p, JSON.stringify({ type: 'FeatureCollection', features }));
    else { try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ } }
  }
}

// List the super-tile GeoJSON files present so the viewer knows what to fetch.
function writeBiomeIndex(dir: string): void {
  const ids: string[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^(-?\d+_-?\d+)\.geojson$/.exec(f);
    if (m) ids.push(m[1]);
  }
  writeFileSync(join(dir, 'index.json'), JSON.stringify(ids));
}

// Draw one overview tile by compositing up to 4 children (z+1) and halving.
async function buildParent(root: string, z: number, x: number, y: number): Promise<boolean> {
  const composites: sharp.OverlayOptions[] = [];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const cp = tilePath(root, z + 1, x * 2 + dx, y * 2 + dy);
      if (existsSync(cp)) composites.push({ input: cp, top: dy * TILE, left: dx * TILE });
    }
  }
  if (composites.length === 0) return false;
  // Two stages: sharp applies resize BEFORE composite within one pipeline, so
  // composite into a full-size raw buffer first, then resize that separately.
  const composited = await sharp({
    create: { width: TILE * 2, height: TILE * 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .raw()
    .toBuffer();
  const out = await sharp(composited, { raw: { width: TILE * 2, height: TILE * 2, channels: 4 } })
    .resize(TILE, TILE) // lanczos downscale, alpha-aware
    .png()
    .toBuffer();
  writePng(tilePath(root, z, x, y), out);
  return true;
}

// --- render one pass --------------------------------------------------------
async function render(worldPath: string, dimension: string, outDir: string): Promise<void> {
  // Concurrency: default to half the cores to keep temps/CPU down.
  const JOBS = Math.max(1, Number(process.env.TILER_JOBS) || Math.floor(cpus().length / 2));
  const forceFull = process.env.TILER_FULL === '1' || process.env.TILER_FULL === 'true';

  const regions = listRegions(regionDir(worldPath, dimension));
  if (regions.length === 0) throw new Error('no region files found');

  const { spawn, version } = readLevel(worldPath);
  if (version && version.dataVersion !== null) {
    if (version.dataVersion > TARGET_DATA_VERSION) {
      console.warn(
        `WARNING: world reports Minecraft ${version.name ?? '?'} (DataVersion ${version.dataVersion}), ` +
        `but this renderer was built for ${TARGET_VERSION} (DataVersion ${TARGET_DATA_VERSION}). ` +
        `The bundled map_colors.json / biome_colors.json may be out of date — regenerate them with ` +
        `the map-color-dump mod for this version.`,
      );
    }
    else if (version.dataVersion < TARGET_DATA_VERSION) {
      console.warn(
        `WARNING: world reports Minecraft ${version.name ?? '?'} (DataVersion ${version.dataVersion}), ` +
        `but this renderer was built for ${TARGET_VERSION} (DataVersion ${TARGET_DATA_VERSION}). ` +
        `The bundled map_colors.json / biome_colors.json may be too new and incompatible.`,
      );
    }
  }
  const minRx = Math.min(...regions.map(r => r.rx));
  const maxRx = Math.max(...regions.map(r => r.rx));
  const minRz = Math.min(...regions.map(r => r.rz));
  const maxRz = Math.max(...regions.map(r => r.rz));
  const Tx = maxRx - minRx + 1;
  const Ty = maxRz - minRz + 1;

  const cached = loadManifest(outDir);
  const renderSig = renderSignature();
  const incr = !forceFull && reusable(cached, dimension, regions, renderSig);

  const originRx = incr ? cached.originRx : minRx;
  const originRz = incr ? cached.originRz : minRz;
  const MAXZOOM = incr ? cached.maxZoom : Math.ceil(Math.log2(Math.max(Tx, Ty, 1)));
  const prevRegions: Record<string, RegionEntry> = incr ? cached.regions : {};
  const grid = 2 ** MAXZOOM;
  const minX = originRx * TILE; // world block X/Z of native pixel (0,0)
  const minZ = originRz * TILE;

  const tilesRoot = join(outDir, 'tiles');
  const biomesDir = join(outDir, BIOMES_DIR);
  if (!incr) {
    rmSync(tilesRoot, { recursive: true, force: true }); // clean full redraw
    rmSync(biomesDir, { recursive: true, force: true });
  }
  mkdirSync(tilesRoot, { recursive: true });
  mkdirSync(biomesDir, { recursive: true });

  const why = forceFull ? 'forced'
    : !cached ? 'first run'
      : cached.renderSig !== renderSig ? 'render settings changed'
        : 'world grew/changed';
  const reason = incr ? '' : ` (${why})`;
  console.log(`${incr ? 'incremental' : 'full'} draw${reason} — regions: ${regions.length}, grid base ${Tx}x${Ty}, origin (${originRx},${originRz}), zooms 0..${MAXZOOM}, spawn: ${spawn ? `${spawn.x},${spawn.z}` : 'unknown'}, jobs: ${JOBS}`);

  // Write meta.json + the viewer up front so the map server can serve the page
  // immediately; tiles then appear (or refresh) as this render produces them.
  // Everything the viewer needs (origin, zoom, spawn, version) is known by now.
  const meta: MapMeta = {
    maxZoom: MAXZOOM,
    minX,
    minZ,
    tileSize: TILE,
    spawn,
    dimension,
    version,
    targetVersion: { name: TARGET_VERSION, dataVersion: TARGET_DATA_VERSION },
    biomeSuper: BIOME_SUPER,
  };
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  writeViewer(outDir, meta);

  // Decide which regions to hand to workers. Files whose mtime is unchanged are
  // skipped without parsing at all.
  const presentKeys = new Set(regions.map(r => `${r.rx},${r.rz}`));
  const newRegions: Record<string, RegionEntry> = {};
  const baseDirty = new Set<string>(); // "tx,ty" at MAXZOOM
  const jobs: Job[] = [];
  let skippedFile = 0;
  for (const r of regions) {
    const key = `${r.rx},${r.rz}`;
    const prev = prevRegions[key];
    let mtimeMs = 0;
    try { mtimeMs = statSync(r.file).mtimeMs; } catch { /* treat as changed */ }
    if (incr && prev && prev.mtimeMs === mtimeMs) {
      newRegions[key] = prev; // unchanged file -> keep tile + super-tile entry
      skippedFile++;
      continue;
    }
    jobs.push({ file: r.file, rx: r.rx, rz: r.rz, since: prev ? prev.lastUpdate : -1, mtimeMs });
  }

  const byKey = new Map(regions.map(r => [`${r.rx},${r.rz}`, r]));
  const jobKeys = new Set(jobs.map(j => `${j.rx},${j.rz}`));

  // Phase 1: (re)render changed base tiles. Per-region biome changes are
  // collected by super-tile and applied together after deletions.
  const biomeChanges = new Map<string, Map<string, BiomeFeature[] | null>>();
  const noteBiome = (tx: number, ty: number, feats: BiomeFeature[] | null): void => {
    const sid = superId(tx, ty);
    let m = biomeChanges.get(sid);
    if (!m) { m = new Map(); biomeChanges.set(sid, m); }
    m.set(`${tx}_${ty}`, feats);
  };
  let rendered = 0;
  let skippedLU = 0;
  const applyResult = (res: TileResult): void => {
    const key = `${res.rx},${res.rz}`;
    newRegions[key] = { lastUpdate: res.lastUpdate, mtimeMs: res.mtimeMs };
    if (!res.rendered) { skippedLU++; return; }
    const tx = res.rx - originRx;
    const ty = res.rz - originRz;
    if (res.png) writePng(tilePath(tilesRoot, MAXZOOM, tx, ty), res.png);
    else rmTile(tilesRoot, MAXZOOM, tx, ty); // region became empty
    noteBiome(tx, ty, res.biome ? regionFeatures(res.biome, res.rx, res.rz, `${tx}_${ty}`, minX, minZ, MAXZOOM) : null);
    baseDirty.add(`${tx},${ty}`);
    rendered++;
  };

  // Neighbours to redraw because a chunk on this region's edge changed: the south
  // neighbour's top-row shading reads our south-edge heights, and every neighbour's
  // biome blur halo reads the edge facing it. Both needs are covered by dirtyEdges
  // (the south direction is flagged exactly when a south-edge chunk changed), so an
  // interior-only change forces nothing.
  const forceKeys = new Set<string>();
  const collectForce = (res: TileResult): void => {
    if (!res.rendered) return;
    for (const [dx, dz] of res.dirtyEdges) {
      const nk = `${res.rx + dx},${res.rz + dz}`;
      if (!jobKeys.has(nk) && byKey.has(nk)) forceKeys.add(nk);
    }
  };

  await pool(jobs, JOBS, runWorker, (res) => {
    applyResult(res);
    collectForce(res);
    if (res.rendered && rendered % 20 === 0) console.log(`rendered: ${rendered} / ${jobs.length}`);
  });
  if (rendered % 20 !== 0) console.log(`rendered: ${rendered} / ${jobs.length}`);

  // Phase 1b: redraw the flagged neighbours so their cross-region shading/blur
  // stays correct. Forced (since = -1); their own edges are unchanged, so they
  // don't cascade further.
  const forcedJobs: Job[] = [];
  for (const nk of forceKeys) {
    const r = byKey.get(nk)!;
    let mtimeMs = 0;
    try { mtimeMs = statSync(r.file).mtimeMs; } catch { /* treat as changed */ }
    forcedJobs.push({ file: r.file, rx: r.rx, rz: r.rz, since: -1, mtimeMs });
  }
  if (forcedJobs.length) {
    await pool(forcedJobs, JOBS, runWorker, applyResult);
    console.log(`edge redraws: ${forcedJobs.length} neighbour tile(s)`);
  }

  // Regions that disappeared since last run: drop their tile, dirty the parents.
  let deleted = 0;
  for (const key of Object.keys(prevRegions)) {
    if (presentKeys.has(key)) continue;
    const [drx, drz] = key.split(',').map(Number);
    const tx = drx - originRx;
    const ty = drz - originRz;
    if (tx >= 0 && ty >= 0 && tx < grid && ty < grid) {
      rmTile(tilesRoot, MAXZOOM, tx, ty);
      noteBiome(tx, ty, null);
      baseDirty.add(`${tx},${ty}`);
    }
    deleted++;
  }
  console.log(`base: rendered ${rendered}, unchanged-file ${skippedFile}, unchanged-content ${skippedLU}, deleted ${deleted}`);

  // Apply the collected biome changes to their super-tile files.
  updateSuperTiles(biomesDir, biomeChanges);

  // Phase 2: redraw only the overview tiles above something that changed.
  let dirty = baseDirty;
  for (let z = MAXZOOM - 1; z >= 0; z--) {
    const parents = new Set<string>();
    for (const k of dirty) {
      const [x, y] = k.split(',').map(Number);
      parents.add(`${x >> 1},${y >> 1}`);
    }
    const arr = [...parents].map(k => k.split(',').map(Number) as [number, number]);
    let made = 0;
    await pool(arr, JOBS, async ([x, y]) => {
      const ok = await buildParent(tilesRoot, z, x, y);
      if (!ok) rmTile(tilesRoot, z, x, y); // all children gone
      return ok;
    }, ok => { if (ok) made++; });
    if (arr.length) console.log(`zoom ${z}: ${made}/${arr.length} tiles`);
    dirty = parents;
  }

  const manifestOut: Manifest = {
    version: MANIFEST_VERSION,
    dimension,
    tileSize: TILE,
    originRx,
    originRz,
    maxZoom: MAXZOOM,
    renderSig,
    regions: newRegions,
  };
  writeFileSync(join(outDir, MANIFEST), JSON.stringify(manifestOut));

  // Refresh the biome index so the viewer knows which region polygons to load.
  writeBiomeIndex(biomesDir);

  console.log(`done ${incr ? 'incremental' : 'full'}) render pass at ${new Date().toISOString()})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- main -------------------------------------------------------------------
async function main(): Promise<void> {
  // Inputs come from positional args, falling back to env vars. Args take
  // precedence so a CLI invocation can override the environment. The optional
  // --once flag forces a single render and exit, even if RENDER_INTERVAL is set.
  const rawArgs = process.argv.slice(2);
  const once = rawArgs.includes('--once');
  const [argWorld, argDimension, argOut] = rawArgs.filter(a => a !== '--once');
  const worldPath = argWorld ?? process.env.WORLD_PATH ?? './world';
  const dimension = argDimension ?? process.env.DIMENSION ?? 'minecraft:overworld';
  const outDir = argOut ?? process.env.OUTPUT_PATH ?? './output';

  // Check if the world path exists and is a directory.
  if (!existsSync(worldPath) || !statSync(worldPath).isDirectory()) {
    console.error(`world path does not exist or is not a directory: ${worldPath}`);
    process.exit(1);
  }

  // Service mode: when RENDER_INTERVAL (minutes) is set, keep re-rendering so a
  // live world's tiles stay fresh — each pass is incremental, so unchanged
  // regions are skipped. Unset or 0 -> render once and exit (one-shot).
  const intervalMin = once ? 0 : Math.max(0, Number(process.env.RENDER_INTERVAL) || 0);
  if (!intervalMin) {
    console.log('one-shot mode: rendering once and exiting');
    await render(worldPath, dimension, outDir);
    return;
  }

  console.log(`service mode: rendering now, then every ${intervalMin}min`);
  // Live player tracking runs alongside the render loop in this same process —
  // a no-op (returns null) unless RCON is configured. See players.ts.
  const stopPlayers = startPlayerTracker();
  // Stop immediately on signal, abandoning any in-progress render — we don't
  // need a complete tile set at all times; the next run picks up where it left
  // off (the manifest is only updated on a fully completed render).
  const onSignal = (sig: string) => {
    console.log(`${sig} received — stopping`);
    stopPlayers?.();
    process.exit(0);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  for (;;) {
    try {
      console.log(`render pass starting at ${new Date().toISOString()}`);
      await render(worldPath, dimension, outDir);
    } catch (e) {
      console.error(`render failed (will retry in ${intervalMin}min):`, e instanceof Error ? e.message : e);
    }
    console.log(`render service sleeping for ${intervalMin}min`);
    await sleep(intervalMin * 60000);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
