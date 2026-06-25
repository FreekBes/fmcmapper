import { Worker } from 'worker_threads';
import {
  readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { cpus } from 'os';
import sharp from 'sharp';
sharp.concurrency(1); // keep libvips from fanning out across all cores
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
function indexHtml(maxZoom: number, minX: number, minZ: number, spawn: { x: number; z: number } | null): string {
  const initialZoom = Math.max(0, maxZoom - 2);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Dimension map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html,body,#map{height:100%;margin:0;background:#0b0b0b}
  /* keep block-pixels crisp when zoomed past native zoom (no smoothing) */
  .leaflet-tile{image-rendering:pixelated;image-rendering:-moz-crisp-edges;image-rendering:crisp-edges}
  .coord{background:rgba(0,0,0,.6);color:#eee;font:12px/1.4 monospace;padding:4px 8px;border-radius:4px}
</style>
</head>
<body>
<div id="map"></div>
<script>
  var MAXZOOM = ${maxZoom};
  var MINX = ${minX};     // world block X of native pixel column 0
  var MINZ = ${minZ};     // world block Z of native pixel row 0
  var SPAWN = ${spawn ? JSON.stringify(spawn) : 'null'};

  var map = L.map('map', { crs: L.CRS.Simple, minZoom: 0, maxZoom: MAXZOOM + 2 });

  L.tileLayer('tiles/{z}/{x}/{y}.png', {
    tileSize: ${TILE},
    minZoom: 0,
    maxZoom: MAXZOOM + 2,    // a couple of upscaled over-zoom steps
    maxNativeZoom: MAXZOOM,
    minNativeZoom: 0,ht
    noWrap: true
  }).addTo(map);

  // latlng -> Minecraft block coords (native pixel == world block at MAXZOOM)
  function toBlock(latlng) {
    var p = map.project(latlng, MAXZOOM);
    return { x: Math.floor(MINX + p.x), z: Math.floor(MINZ + p.y) };
  }
  // Minecraft block coords -> latlng
  function fromBlock(x, z) {
    return map.unproject(L.point(x - MINX, z - MINZ), MAXZOOM);
  }

  var Coords = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
      var d = L.DomUtil.create('div', 'coord');
      d.textContent = 'move the cursor';
      this._d = d;
      return d;
    },
    set: function (x, z) { this._d.textContent = 'X ' + x + '   Z ' + z; }
  });
  var coords = new Coords();
  map.addControl(coords);
  map.on('mousemove', function (e) { var b = toBlock(e.latlng); coords.set(b.x, b.z); });

  if (SPAWN) {
    var c = fromBlock(SPAWN.x, SPAWN.z);
    map.setView(c, ${initialZoom});
    L.circleMarker(c, { radius: 5, weight: 2, color: '#fff', fillColor: '#e33', fillOpacity: 1 })
      .addTo(map)
      .bindTooltip('Spawn (' + SPAWN.x + ', ' + SPAWN.z + ')');
  } else {
    map.setView([0, 0], 0);
  }
</script>
</body>
</html>
`;
}

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

  writeFileSync(join(outDir, 'index.html'), indexHtml(MAXZOOM, minRx * TILE, minRz * TILE, spawn));
  console.error(`done. serve ${outDir}/ over HTTP and open index.html`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
