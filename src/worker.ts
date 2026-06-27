import { parentPort, workerData } from 'worker_threads';
import { readFileSync } from 'fs';
import sharp from 'sharp';
sharp.concurrency(1);
import { AnvilParser, findChildTag } from 'mc-anvil';
import {
  topColumns, colorRGB, shadeRGB, loadColorTable, loadBiomeColors, TINTS, EMPTY_HEIGHT,
} from './chunkmap';
import type { BiomeColor } from './chunkmap';

const SIZE = 512; // one region = 512x512 blocks
const BIOME_RES = 4; // sample biomes every 4 blocks (Minecraft's native biome cell)
const BIOME_CELLS = SIZE / BIOME_RES; // 128 cells per region side

// `since` = the LastUpdate this region was last rendered at (-1 = never).
type Job = { file: string; rx: number; rz: number; since: number; mtimeMs: number };
// Per-region surface biome map: `res`-block cells, `data` indexes `palette`
// (255 = no biome). The grid is square; its side is derivable as region/res.
export type BiomeCells = { res: number; palette: string[]; data: number[] };
export type TileResult = {
  rx: number;
  rz: number;
  lastUpdate: number; // max LastUpdate across the region's chunks (-1 if none)
  mtimeMs: number; // echoed back so the parent can store it
  rendered: boolean; // did we actually (re)render this region?
  png: Buffer | null; // present iff rendered and the region has terrain
  biome: BiomeCells | null; // present iff rendered and the region has terrain
};

const { file, rx, rz, since, mtimeMs } = workerData as Job;

// Loaded once per worker. Override paths with MAP_COLORS_PATH / BIOME_COLORS_PATH.
const table = loadColorTable(process.env.MAP_COLORS_PATH);
const biomeColors = loadBiomeColors(process.env.BIOME_COLORS_PATH);

// Overall darkening (1 = none). Per-type factors below stack on top of this.
const BRIGHTNESS = process.env.MAP_BRIGHTNESS !== undefined ? Number(process.env.MAP_BRIGHTNESS) : 1;
// Leaves are a dark texture x the biome tint in-game; the raw tint alone is too
// bright, so darken leaf blocks extra (foliage-tinted + fixed birch/spruce).
const FOLIAGE = process.env.MAP_FOLIAGE_BRIGHTNESS !== undefined ? Number(process.env.MAP_FOLIAGE_BRIGHTNESS) : 0.55;
// Water gets a little extra darkening on top of its depth shading.
const WATER_BRIGHT = process.env.MAP_WATER_BRIGHTNESS !== undefined ? Number(process.env.MAP_WATER_BRIGHTNESS) : 0.7;
const GRASS = process.env.MAP_GRASS_BRIGHTNESS !== undefined ? Number(process.env.MAP_GRASS_BRIGHTNESS) : 0.8;
// Biome tint blend radius (box of (2r+1)^2 biomes), like vanilla "Biome Blend".
// 0 disables blending. Default 2 -> 5x5.
const BLEND_R = process.env.MAP_BIOME_BLEND !== undefined
  ? Math.max(0, Math.min(8, Math.trunc(Number(process.env.MAP_BIOME_BLEND))))
  : 2;

const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const chunks = new AnvilParser(ab).getAllChunks();

// mc-anvil 2.x reads a scalar TAG_Long little-endian (NBT is big-endian), so
// LastUpdate comes back byte-swapped. A real tick count is a small non-negative
// number; if the value is implausible we swap the bytes back. The guard means a
// future mc-anvil fix won't get double-corrected.
function readLong(raw: number | bigint): number {
  let v = typeof raw === 'bigint' ? raw : BigInt(Math.trunc(raw));
  if (v < 0n || v > 1n << 40n) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    v = b.readBigInt64BE(0);
  }
  return Number(v);
}

// Max LastUpdate (game ticks) across this region's chunks. `missing` counts
// chunks whose tag we couldn't read, so we re-render rather than risk skipping.
let lastUpdate = -1;
let missing = 0;
for (const c of chunks) {
  const t = findChildTag(c.root, x => x.name === 'LastUpdate');
  if (t && (typeof t.data === 'number' || typeof t.data === 'bigint')) {
    const v = readLong(t.data);
    if (v > lastUpdate) lastUpdate = v;
  } else {
    missing++;
  }
}

// Re-render if we've never rendered this region, it advanced, or we couldn't
// verify a chunk's timestamp.
const rendered = since < 0 || missing > 0 || lastUpdate > since;

const baseX = rx * SIZE;
const baseZ = rz * SIZE;

function skip(): void {
  parentPort!.postMessage({ rx, rz, lastUpdate, mtimeMs, rendered: false, png: null, biome: null } as TileResult);
}

// Downsample the per-block surface biome grid to one sample per BIOME_RES block
// cell, with a compact local palette (index 255 = no biome).
function biomeCells(biome: (string | null)[]): BiomeCells {
  const palette: string[] = [];
  const idOf = new Map<string, number>();
  const data = new Array<number>(BIOME_CELLS * BIOME_CELLS).fill(255);
  for (let cz = 0; cz < BIOME_CELLS; cz++) {
    for (let cx = 0; cx < BIOME_CELLS; cx++) {
      const nm = biome[(cz * BIOME_RES) * SIZE + cx * BIOME_RES];
      if (!nm) continue;
      let id = idOf.get(nm);
      if (id === undefined) { id = palette.length; idOf.set(nm, id); palette.push(nm); }
      data[cz * BIOME_CELLS + cx] = id;
    }
  }
  return { res: BIOME_RES, palette, data };
}

// ---------------------------------------------------------------------------
// Biome tint blending: average each kind's per-pixel biome color over a box,
// so colors fade smoothly across biome borders instead of stepping in blocks.
// ---------------------------------------------------------------------------

type Field = { r: Int16Array; g: Int16Array; b: Int16Array; v: Uint8Array };

function tintField(
  biome: (string | null)[],
  pick: (bc: BiomeColor) => number,
): Field {
  const N = SIZE * SIZE;
  const r = new Int16Array(N);
  const g = new Int16Array(N);
  const b = new Int16Array(N);
  const v = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const bn = biome[i];
    if (!bn) continue;
    const bc = biomeColors.get(bn);
    if (!bc) continue;
    const rgb = pick(bc);
    if (rgb < 0) continue;
    r[i] = (rgb >> 16) & 255;
    g[i] = (rgb >> 8) & 255;
    b[i] = rgb & 255;
    v[i] = 1;
  }
  return { r, g, b, v };
}

// Separable box blur that averages only over valid cells (so no-biome holes and
// region edges don't darken the result).
function blur(src: Field, rad: number): Field {
  const N = SIZE * SIZE;
  const hr = new Float32Array(N);
  const hg = new Float32Array(N);
  const hb = new Float32Array(N);
  const hc = new Int32Array(N);

  for (let y = 0; y < SIZE; y++) {
    const row = y * SIZE;
    let sr = 0, sg = 0, sb = 0, sc = 0;
    for (let x = 0; x <= rad && x < SIZE; x++) {
      if (src.v[row + x]) { sr += src.r[row + x]; sg += src.g[row + x]; sb += src.b[row + x]; sc++; }
    }
    for (let x = 0; x < SIZE; x++) {
      hr[row + x] = sr; hg[row + x] = sg; hb[row + x] = sb; hc[row + x] = sc;
      const out = x - rad;
      if (out >= 0 && src.v[row + out]) { sr -= src.r[row + out]; sg -= src.g[row + out]; sb -= src.b[row + out]; sc--; }
      const inn = x + rad + 1;
      if (inn < SIZE && src.v[row + inn]) { sr += src.r[row + inn]; sg += src.g[row + inn]; sb += src.b[row + inn]; sc++; }
    }
  }

  const r = new Int16Array(N);
  const g = new Int16Array(N);
  const b = new Int16Array(N);
  const v = new Uint8Array(N);
  for (let x = 0; x < SIZE; x++) {
    let sr = 0, sg = 0, sb = 0, sc = 0;
    for (let y = 0; y <= rad && y < SIZE; y++) {
      const i = y * SIZE + x; sr += hr[i]; sg += hg[i]; sb += hb[i]; sc += hc[i];
    }
    for (let y = 0; y < SIZE; y++) {
      const i = y * SIZE + x;
      if (sc > 0) { r[i] = Math.round(sr / sc); g[i] = Math.round(sg / sc); b[i] = Math.round(sb / sc); v[i] = 1; }
      const out = y - rad;
      if (out >= 0) { const j = out * SIZE + x; sr -= hr[j]; sg -= hg[j]; sb -= hb[j]; sc -= hc[j]; }
      const inn = y + rad + 1;
      if (inn < SIZE) { const j = inn * SIZE + x; sr += hr[j]; sg += hg[j]; sb += hb[j]; sc += hc[j]; }
    }
  }
  return { r, g, b, v };
}

async function render(): Promise<void> {
  const name: (string | null)[] = new Array(SIZE * SIZE).fill(null);
  const biome: (string | null)[] = new Array(SIZE * SIZE).fill(null);
  const depth = new Int32Array(SIZE * SIZE);
  const height = new Int32Array(SIZE * SIZE).fill(EMPTY_HEIGHT);
  let any = false;

  // Pass 1: fill per-region name / biome / depth / height grids.
  for (const chunk of chunks) {
    const cols = topColumns(chunk, table);
    if (!cols) continue;
    for (let clz = 0; clz < 16; clz++) {
      for (let clx = 0; clx < 16; clx++) {
        const cc = clz * 16 + clx;
        const nm = cols.names[cc];
        if (nm === null) continue;
        const lx = cols.ox + clx - baseX;
        const lz = cols.oz + clz - baseZ;
        if (lx < 0 || lx >= SIZE || lz < 0 || lz >= SIZE) continue;
        const idx = lz * SIZE + lx;
        name[idx] = nm;
        biome[idx] = cols.biomes[cc];
        depth[idx] = cols.depths[cc];
        height[idx] = cols.heights[cc];
        any = true;
      }
    }
  }

  if (!any) {
    // Region has no renderable terrain (e.g. all chunks deleted): no tile.
    parentPort!.postMessage({ rx, rz, lastUpdate, mtimeMs, rendered: true, png: null, biome: null } as TileResult);
    return;
  }

  const blendGrass = BLEND_R > 0 ? blur(tintField(biome, bc => bc.grass), BLEND_R) : null;
  const blendFoliage = BLEND_R > 0 ? blur(tintField(biome, bc => bc.foliage), BLEND_R) : null;
  const blendWater = BLEND_R > 0 ? blur(tintField(biome, bc => bc.water), BLEND_R) : null;

  const tintBase = (kind: 'grass' | 'foliage' | 'water', idx: number): number => {
    const fld = kind === 'grass' ? blendGrass : kind === 'foliage' ? blendFoliage : blendWater;
    if (fld && fld.v[idx]) return (fld.r[idx] << 16) | (fld.g[idx] << 8) | fld.b[idx];
    const bn = biome[idx];
    const bc = bn ? biomeColors.get(bn) : undefined;
    return bc ? bc[kind] : -1;
  };

  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let lz = 0; lz < SIZE; lz++) {
    for (let lx = 0; lx < SIZE; lx++) {
      const idx = lz * SIZE + lx;
      const nm = name[idx];
      if (nm === null) continue;

      // Vanilla shading: compare against the block to the NORTH (-Z = up on the
      // tile). At the region's north edge the neighbour is in another region
      // (not available here) -> use the flat shade (1).
      let shadeIndex = 1;
      if (lz > 0) {
        const hN = height[(lz - 1) * SIZE + lx];
        if (hN !== EMPTY_HEIGHT) {
          const h = height[idx];
          shadeIndex = h > hN ? 2 : h < hN ? 0 : 1;
        }
      }

      const tint = TINTS[nm];
      // Water is shaded by depth (shallow bright -> deep dark), with a 1px
      // checkerboard dither, like the vanilla map. Overrides the height shade.
      if (tint === 'water') {
        const d0 = depth[idx] * 0.1 + ((lx + lz) & 1) * 0.2;
        shadeIndex = d0 < 0.5 ? 2 : d0 > 0.9 ? 0 : 1;
      }
      // Leaf blocks (foliage tint, or fixed birch/spruce) get extra darkening.
      const isLeaf = tint === 'foliage' || typeof tint === 'number';

      let r: number, g: number, b: number;
      if (tint === undefined) {
        [r, g, b] = colorRGB(table, nm, shadeIndex);
      } else {
        const base = typeof tint === 'number' ? tint : tintBase(tint, idx);
        [r, g, b] = base >= 0 ? shadeRGB(base, shadeIndex) : colorRGB(table, nm, shadeIndex);
      }

      const f = isLeaf
        ? BRIGHTNESS * FOLIAGE
        : tint === 'water'
          ? BRIGHTNESS * WATER_BRIGHT
          : tint === 'grass'
            ? BRIGHTNESS * GRASS
            : BRIGHTNESS;
      const p = idx * 4;
      rgba[p] = Math.min(255, Math.round(r * f));
      rgba[p + 1] = Math.min(255, Math.round(g * f));
      rgba[p + 2] = Math.min(255, Math.round(b * f));
      rgba[p + 3] = 255;
    }
  }
  const png = await sharp(Buffer.from(rgba), { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .png()
    .toBuffer();
  parentPort!.postMessage({ rx, rz, lastUpdate, mtimeMs, rendered: true, png, biome: biomeCells(biome) } as TileResult);
}

if (!rendered) skip();
else void render();
