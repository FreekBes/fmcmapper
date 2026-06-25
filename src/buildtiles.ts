import { Worker } from 'worker_threads';
import {
  readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync,
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

function listRegions(dir: string): RegionFile[] {
  const out: RegionFile[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
    if (m) out.push({ file: join(dir, f), rx: +m[1], rz: +m[2] });
  }
  return out;
}

// --- spawn from level.dat ---------------------------------------------------
function readSpawn(worldPath: string): { x: number; z: number } | null {
  const f = join(worldPath, 'level.dat');
  if (!existsSync(f)) return null;
  try {
    const buf = readFileSync(f);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const root = new NBTParser(ab).getTag() as TagData; // NBTParser auto-gunzips

    // Current layout: Data/spawn { pos: int[ x, y, z ], yaw, pitch, dimension }
    const pos = findChildTagAtPath('Data/spawn/pos', root);
    if (pos && Array.isArray(pos.data) && pos.data.length >= 3) {
      return { x: Number(pos.data[0]), z: Number(pos.data[2]) };
    }

    // Legacy layout: Data/SpawnX, Data/SpawnZ
    const sx = findChildTagAtPath('Data/SpawnX', root);
    const sz = findChildTagAtPath('Data/SpawnZ', root);
    if (sx && sz) return { x: Number(sx.data), z: Number(sz.data) };

    return null;
  } catch {
    return null;
  }
}

// --- worker pool ------------------------------------------------------------
function runWorker(job: RegionFile): Promise<TileResult> {
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
    { length: Math.max(1, Math.min(limit, items.length)) },
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

// --- Leaflet viewer ---------------------------------------------------------
// --- main -------------------------------------------------------------------
async function main(): Promise<void> {
  const [worldPath, dimension = 'minecraft:overworld', outDir = 'tiles_out'] =
    process.argv.slice(2);
  if (!worldPath) {
    console.error('usage: node buildtiles.js <worldPath> [dimension] [outDir]');
    process.exit(1);
  }

  // Concurrency: default to half the cores to keep temps/CPU down.
  // Override with TILER_JOBS=N (e.g. TILER_JOBS=2 for very low load).
  const JOBS = Math.max(1, Number(process.env.TILER_JOBS) || Math.floor(cpus().length / 2));

  const regions = listRegions(regionDir(worldPath, dimension));
  if (regions.length === 0) {
    console.error('no region files found');
    process.exit(1);
  }

  const spawn = readSpawn(worldPath);
  const minRx = Math.min(...regions.map(r => r.rx));
  const maxRx = Math.max(...regions.map(r => r.rx));
  const minRz = Math.min(...regions.map(r => r.rz));
  const maxRz = Math.max(...regions.map(r => r.rz));
  const Tx = maxRx - minRx + 1;
  const Ty = maxRz - minRz + 1;
  const MAXZOOM = Math.ceil(Math.log2(Math.max(Tx, Ty, 1)));
  const tilesRoot = join(outDir, 'tiles');
  mkdirSync(tilesRoot, { recursive: true });

  console.error(`regions: ${regions.length}, base grid: ${Tx}x${Ty}, zooms: 0..${MAXZOOM}, spawn: ${spawn ? `${spawn.x},${spawn.z}` : 'unknown'}, jobs: ${JOBS}`);

  // Phase 1: native-zoom base tiles (workers encode PNGs in parallel).
  let written = 0;
  await pool(regions, JOBS, runWorker, ({ rx, rz, png }) => {
    if (!png) return;
    writePng(tilePath(tilesRoot, MAXZOOM, rx - minRx, rz - minRz), png);
    if (++written % 20 === 0) console.error(`base tiles: ${written}`);
  });
  console.error(`base tiles written: ${written}`);

  // Phase 2: overviews, one zoom at a time, parallel within a zoom.
  for (let z = MAXZOOM - 1; z >= 0; z--) {
    const span = 2 ** (MAXZOOM - z);
    const nx = Math.ceil(Tx / span);
    const ny = Math.ceil(Ty / span);
    const coords: Array<[number, number]> = [];
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) coords.push([x, y]);
    let made = 0;
    await pool(coords, JOBS, ([x, y]) => buildParent(tilesRoot, z, x, y), ok => { if (ok) made++; });
    console.error(`zoom ${z}: ${made} tiles`);
  }

  const meta: MapMeta = { maxZoom: MAXZOOM, minX: minRx * TILE, minZ: minRz * TILE, tileSize: TILE, spawn, dimension };
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  writeViewer(outDir, meta);
  console.error(`done. serve ${outDir}/ over HTTP and open index.html`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
