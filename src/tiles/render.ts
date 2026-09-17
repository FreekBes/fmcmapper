// One incremental render pass: discover regions, decide what changed, farm the
// changed ones out to the worker pool, then rebuild the affected biome super-tiles
// and overview pyramid and write the manifest. Ties together world/, the worker
// pool, tile IO and the biome layer.

import { mkdirSync, writeFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { cpus } from 'os';
import { MapMeta, writeViewer } from '../viewer';
import { TARGET_VERSION, TARGET_DATA_VERSION } from '../gamedata';
import type { Job, TileResult } from './worker';
import { regionDir, listRegions } from '../world/regions';
import { readLevel } from '../world/level';
import { TILE, BIOMES_DIR, BIOME_SUPER } from './constants';
import { MANIFEST, renderSignature, loadManifest, reusable, buildManifest, type RegionEntry } from './manifest';
import { WorkerPool, pool } from './pool';
import { tilePath, writePng, rmTile, buildOverviews } from './io';
import { superId, regionFeatures, updateSuperTiles, writeBiomeIndex, type BiomeFeature } from './biomelayer';

// The built worker sits at the build root; this module lives one dir down (tiles/).
const WORKER_SCRIPT = join(__dirname, 'worker.js');

export async function render(worldPath: string, dimension: string, outDir: string): Promise<void> {
  // Concurrency: default to a quarter of the cores to keep RAM/temps/CPU down.
  const JOBS = Math.max(1, Number(process.env.TILER_JOBS) || Math.floor(cpus().length / 4));
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

  // One pool of persistent workers for both worker phases; torn down before the
  // sharp-heavy overview phase (phase 2) so the render threads don't sit idle
  // holding memory while the parent composites tiles.
  const workerPool = new WorkerPool(JOBS, WORKER_SCRIPT);
  try {
    await pool(jobs, JOBS, j => workerPool.run(j), (res) => {
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
      await pool(forcedJobs, JOBS, j => workerPool.run(j), applyResult);
      console.log(`edge redraws: ${forcedJobs.length} neighbour tile(s)`);
    }
  } finally {
    await workerPool.destroy();
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
  await buildOverviews(tilesRoot, baseDirty, MAXZOOM, JOBS);

  writeFileSync(join(outDir, MANIFEST), JSON.stringify(buildManifest({
    dimension,
    tileSize: TILE,
    originRx,
    originRz,
    maxZoom: MAXZOOM,
    renderSig,
    regions: newRegions,
  })));

  // Refresh the biome index so the viewer knows which region polygons to load.
  writeBiomeIndex(biomesDir);

  console.log(`done ${incr ? 'incremental' : 'full'} render pass at ${new Date().toISOString()}`);
}
