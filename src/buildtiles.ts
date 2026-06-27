import { Worker } from 'worker_threads';
import {
  readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync, unlinkSync, rmSync,
} from 'fs';
import { join, dirname } from 'path';
import { cpus } from 'os';
import sharp from 'sharp';
sharp.concurrency(1); // keep libvips from fanning out across all cores
import { MapMeta, writeViewer } from './viewer';
import { NBTParser, findChildTagAtPath } from 'mc-anvil';
import type { TagData } from 'mc-anvil';
import type { TileResult } from './worker';

const TILE = 512; // Leaflet tileSize; one base tile == one region
const MANIFEST = 'render-manifest.json';
const MANIFEST_VERSION = 1;

// Minecraft version this renderer was written for. The bundled map_colors.json /
// biome_colors.json and the TINTS table in chunkmap.ts were generated against
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
  regions: Record<string, RegionEntry>;
};

function loadManifest(outDir: string): Manifest | null {
  const f = join(outDir, MANIFEST);
  if (!existsSync(f)) return null;
  try {
    const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
    if (m && m.version === MANIFEST_VERSION && m.regions) return m;
  } catch { /* fall through to full rebuild */ }
  return null;
}

// Can we reuse the cached tile grid? Only if dimension/tileSize match and every
// current region still maps into the cached origin + maxZoom envelope (else the
// tile coordinates would shift and the whole pyramid is invalid).
function reusable(m: Manifest | null, dimension: string, regions: RegionFile[]): m is Manifest {
  if (!m || m.dimension !== dimension || m.tileSize !== TILE) return false;
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

// Build one overview tile by compositing up to 4 children (z+1) and halving.
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

// --- main -------------------------------------------------------------------
async function main(): Promise<void> {
  // Inputs come from positional args, falling back to env vars. Args take
  // precedence so a CLI invocation can override the environment.
  const [argWorld, argDimension, argOut] = process.argv.slice(2);
  const worldPath = argWorld ?? process.env.WORLD_PATH ?? './world';
  const dimension = argDimension ?? process.env.DIMENSION ?? 'minecraft:overworld';
  const outDir = argOut ?? process.env.OUTPUT_PATH ?? './output';
  if (!worldPath) {
    console.error(
      'usage: node buildtiles.js <worldPath> [dimension] [outDir]\n' +
      '   or: WORLD_PATH=... [DIMENSION=...] [OUTPUT_PATH=...] node buildtiles.js\n' +
      'other env vars: TILER_JOBS (worker count), TILER_FULL=1 (force full rebuild)',
    );
    process.exit(1);
  }

  // Concurrency: default to half the cores to keep temps/CPU down.
  const JOBS = Math.max(1, Number(process.env.TILER_JOBS) || Math.floor(cpus().length / 2));
  const forceFull = process.env.TILER_FULL === '1' || process.env.TILER_FULL === 'true';

  const regions = listRegions(regionDir(worldPath, dimension));
  if (regions.length === 0) {
    console.error('no region files found');
    process.exit(1);
  }

  const { spawn, version } = readLevel(worldPath);
  if (version && version.dataVersion !== null && version.dataVersion !== TARGET_DATA_VERSION) {
    console.error(
      `WARNING: world reports Minecraft ${version.name ?? '?'} (DataVersion ${version.dataVersion}), ` +
      `but this renderer was built for ${TARGET_VERSION} (DataVersion ${TARGET_DATA_VERSION}). ` +
      `The bundled map_colors.json / biome_colors.json may be out of date — regenerate them with ` +
      `the map-color-dump mod for this version.`,
    );
  }
  const minRx = Math.min(...regions.map(r => r.rx));
  const maxRx = Math.max(...regions.map(r => r.rx));
  const minRz = Math.min(...regions.map(r => r.rz));
  const maxRz = Math.max(...regions.map(r => r.rz));
  const Tx = maxRx - minRx + 1;
  const Ty = maxRz - minRz + 1;

  const cached = loadManifest(outDir);
  const incr = !forceFull && reusable(cached, dimension, regions);

  const originRx = incr ? cached.originRx : minRx;
  const originRz = incr ? cached.originRz : minRz;
  const MAXZOOM = incr ? cached.maxZoom : Math.ceil(Math.log2(Math.max(Tx, Ty, 1)));
  const prevRegions: Record<string, RegionEntry> = incr ? cached.regions : {};
  const grid = 2 ** MAXZOOM;

  const tilesRoot = join(outDir, 'tiles');
  if (!incr) rmSync(tilesRoot, { recursive: true, force: true }); // clean full rebuild
  mkdirSync(tilesRoot, { recursive: true });

  const reason = incr ? '' : ` (${forceFull ? 'forced' : cached ? 'world grew/changed' : 'first run'})`;
  console.error(`${incr ? 'incremental' : 'full'} build${reason} — regions: ${regions.length}, grid base ${Tx}x${Ty}, origin (${originRx},${originRz}), zooms 0..${MAXZOOM}, spawn: ${spawn ? `${spawn.x},${spawn.z}` : 'unknown'}, jobs: ${JOBS}`);

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
      newRegions[key] = prev; // unchanged file -> keep tile + entry
      skippedFile++;
      continue;
    }
    jobs.push({ file: r.file, rx: r.rx, rz: r.rz, since: prev ? prev.lastUpdate : -1, mtimeMs });
  }

  // Phase 1: (re)render changed base tiles.
  let rendered = 0;
  let skippedLU = 0;
  await pool(jobs, JOBS, runWorker, (res) => {
    const key = `${res.rx},${res.rz}`;
    newRegions[key] = { lastUpdate: res.lastUpdate, mtimeMs: res.mtimeMs };
    if (!res.rendered) { skippedLU++; return; }
    const tx = res.rx - originRx;
    const ty = res.rz - originRz;
    if (res.png) writePng(tilePath(tilesRoot, MAXZOOM, tx, ty), res.png);
    else rmTile(tilesRoot, MAXZOOM, tx, ty); // region became empty
    baseDirty.add(`${tx},${ty}`);
    if (++rendered % 20 === 0) console.error(`rendered: ${rendered}`);
  });

  // Regions that disappeared since last run: drop their tile, dirty the parents.
  let deleted = 0;
  for (const key of Object.keys(prevRegions)) {
    if (presentKeys.has(key)) continue;
    const [drx, drz] = key.split(',').map(Number);
    const tx = drx - originRx;
    const ty = drz - originRz;
    if (tx >= 0 && ty >= 0 && tx < grid && ty < grid) {
      rmTile(tilesRoot, MAXZOOM, tx, ty);
      baseDirty.add(`${tx},${ty}`);
    }
    deleted++;
  }
  console.error(`base: rendered ${rendered}, unchanged-file ${skippedFile}, unchanged-content ${skippedLU}, deleted ${deleted}`);

  // Phase 2: rebuild only the overview tiles above something that changed.
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
    if (arr.length) console.error(`zoom ${z}: ${made}/${arr.length} tiles`);
    dirty = parents;
  }

  const manifestOut: Manifest = {
    version: MANIFEST_VERSION,
    dimension,
    tileSize: TILE,
    originRx,
    originRz,
    maxZoom: MAXZOOM,
    regions: newRegions,
  };
  writeFileSync(join(outDir, MANIFEST), JSON.stringify(manifestOut));

  const meta: MapMeta = {
    maxZoom: MAXZOOM,
    minX: originRx * TILE,
    minZ: originRz * TILE,
    tileSize: TILE,
    spawn,
    dimension,
    version,
    targetVersion: { name: TARGET_VERSION, dataVersion: TARGET_DATA_VERSION },
  };
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  writeViewer(outDir, meta);
  console.error(`done (${incr ? 'incremental' : 'full'}). serve ${outDir}/ over HTTP and open index.html`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
