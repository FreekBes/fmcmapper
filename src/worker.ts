import { parentPort, workerData } from 'worker_threads';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import sharp from 'sharp';
sharp.concurrency(1);
import { AnvilParser, findChildTag } from 'mc-anvil';
import {
  topColumns, colorRGB, shadeRGB, loadColorTable, loadBiomeColors, EMPTY_HEIGHT,
} from './chunkmap';
import type { BiomeColor } from './chunkmap';
import { TINTS } from './gamedata';
import { renderConfig } from './renderconfig';

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
  // Neighbour offsets whose biome halo this region feeds and where an edge chunk
  // changed since last render — i.e. neighbours to redraw so their cross-region
  // blur stays correct. (Shading invalidation is handled separately.)
  dirtyEdges: [number, number][];
};

const { file, rx, rz, since, mtimeMs } = workerData as Job;

// Loaded once per worker. Override paths with MAP_COLORS_PATH / BIOME_COLORS_PATH.
const table = loadColorTable(process.env.MAP_COLORS_PATH);
const biomeColors = loadBiomeColors(process.env.BIOME_COLORS_PATH);

// Pixel brightness/blend settings. Defaults live in renderconfig.ts, which the
// render signature hashes — so changing one there forces a redraw automatically.
const { brightness: BRIGHTNESS, foliage: FOLIAGE, grass: GRASS, dryFoliage: DRY_FOLIAGE, water: WATER_BRIGHT, blendR: BLEND_R } = renderConfig();

const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
// A valid region starts with an 8 KiB header (location + timestamp tables); a
// shorter file is empty or truncated (common in worlds, or mid-write) and would
// make mc-anvil's header parse read past the end. Treat any such failure as an
// empty region (no chunks) instead of crashing the worker.
let chunks: ReturnType<AnvilParser['getAllChunks']> = [];
try {
  if (ab.byteLength >= 8192) chunks = new AnvilParser(ab).getAllChunks();
  else console.warn(`[worker] region ${file} is empty or truncated (${ab.byteLength} bytes); skipping`);
} catch (e) {
  console.warn(`[worker] could not parse region ${file}; skipping: ${e instanceof Error ? e.message : e}`);
}

// Open a neighbouring region file as a parser, or null if absent/unreadable.
function openRegion(path: string): AnvilParser | null {
  if (!existsSync(path)) return null;
  try {
    const b = readFileSync(path);
    return new AnvilParser(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  } catch { return null; }
}

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
// We also record which region edges hold a chunk that changed since last render:
// a neighbour's biome blur halo reads our edge, so a changed edge chunk means
// that neighbour must redraw. A corner chunk feeds the side + diagonal neighbours.
const dirtyDirs = new Set<string>();
const markDirty = (lcx: number, lcz: number): void => {
  const ex = lcx === 0 ? -1 : lcx === 31 ? 1 : 0; // west/east edge, else interior
  const ez = lcz === 0 ? -1 : lcz === 31 ? 1 : 0; // north/south edge, else interior
  if (ez) dirtyDirs.add(`0,${ez}`);
  if (ex) dirtyDirs.add(`${ex},0`);
  if (ex && ez) dirtyDirs.add(`${ex},${ez}`); // corner chunk also feeds the diagonal
};
let lastUpdate = -1;
let missing = 0;
for (const c of chunks) {
  try {
    const t = findChildTag(c.root, x => x.name === 'LastUpdate');
    let changed = true; // unreadable timestamp -> treat as changed (conservative)
    if (t && (typeof t.data === 'number' || typeof t.data === 'bigint')) {
      const v = readLong(t.data);
      if (v > lastUpdate) lastUpdate = v;
      changed = v > since;
    } else {
      missing++;
    }
    if (changed) {
      const co = c.getChunkCoordinates();
      if (co) markDirty(co[0] - rx * 32, co[1] - rz * 32);
    }
  } catch {
    missing++; // corrupt chunk -> force a re-render, but never crash the worker
  }
}
const dirtyEdges: [number, number][] = [...dirtyDirs].map(s => {
  const [a, b] = s.split(',').map(Number);
  return [a, b];
});

// Re-render if we've never rendered this region, it advanced, or we couldn't
// verify a chunk's timestamp.
const rendered = since < 0 || missing > 0 || lastUpdate > since;

const baseX = rx * SIZE;
const baseZ = rz * SIZE;

function skip(): void {
  parentPort!.postMessage({ rx, rz, lastUpdate, mtimeMs, rendered: false, png: null, biome: null, dirtyEdges } as TileResult);
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

// Heights of the block row immediately NORTH of this region (world Z = baseZ-1),
// read from the south edge of the region above. The top row's vanilla north-
// shading needs the neighbour's heights; without them it falls back to flat,
// leaving a seam at every region boundary. Fetches only the 32 edge chunks of
// the neighbour (each getChunkContainingCoordinate decompresses just that one
// chunk), leaving EMPTY_HEIGHT where the region/chunk is absent.
//
// NB: use getChunkContainingCoordinate, NOT getChunkAtChunkCoordinates — the
// latter is broken in mc-anvil 2.0.15 (its predicate is inverted, so a matching
// lookup returns undefined; verified 0/1024). y=0 is arbitrary: containsCoordinate
// only requires y in [-64, 256], then matches the chunk's column.
function northEdgeHeights(): Int32Array {
  const edge = new Int32Array(SIZE).fill(EMPTY_HEIGHT);
  const parser = openRegion(join(dirname(file), `r.${rx}.${rz - 1}.mca`));
  if (!parser) return edge;
  const wz = rz * SIZE - 1; // world Z of the row immediately north of this region
  for (let cx = 0; cx < 32; cx++) {
    let cols;
    try {
      const chunk = parser.getChunkContainingCoordinate([baseX + cx * 16, 0, wz]);
      cols = chunk ? topColumns(chunk, table) : null;
    } catch { continue; }
    if (!cols) continue;
    for (let clx = 0; clx < 16; clx++) {
      const lx = cols.ox + clx - baseX;
      if (lx >= 0 && lx < SIZE) edge[lx] = cols.heights[15 * 16 + clx]; // local z=15 = south row
    }
  }
  return edge;
}

// ---------------------------------------------------------------------------
// Biome tint blending: average each kind's per-pixel biome color over a box,
// so colors fade smoothly across biome borders instead of stepping in blocks.
// ---------------------------------------------------------------------------

type Field = { r: Int16Array; g: Int16Array; b: Int16Array; v: Uint8Array };

// The biome-driven tint kinds and how each reads its colour off a BiomeColor.
// (BiomeColor uses camelCase `dryFoliage`; the tint id is snake_case.)
type TintKind = 'grass' | 'foliage' | 'dry_foliage' | 'water';
const PICK: Record<TintKind, (bc: BiomeColor) => number> = {
  grass: bc => bc.grass,
  foliage: bc => bc.foliage,
  dry_foliage: bc => bc.dryFoliage,
  water: bc => bc.water,
};

// Fallback tint for biome-tinted blocks when no biome data is available (e.g. a
// pre-1.18 world, where biomes aren't parsed). Without it those blocks drop to
// their plain map colour — or, for an id missing from the colour table (1.16's
// `minecraft:grass` was renamed `short_grass` in 1.20), to a hashed colour that
// can come out purple. These are Minecraft's no-biome default grass/foliage/water
// colours; dry-foliage barely appears in such worlds.
const DEFAULT_TINT: BiomeColor = { grass: 0x91bd59, foliage: 0x48b518, dryFoliage: 0x96a053, water: 0x3f76e4 };

function tintField(grid: (string | null)[], dim: number, pick: (bc: BiomeColor) => number): Field {
  const N = dim * dim;
  const r = new Int16Array(N);
  const g = new Int16Array(N);
  const b = new Int16Array(N);
  const v = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const bn = grid[i];
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

// Separable box blur over a dim x dim grid that averages only over valid cells
// (so no-biome holes and grid edges don't darken the result).
function blur(src: Field, dim: number, rad: number): Field {
  const N = dim * dim;
  const hr = new Float32Array(N);
  const hg = new Float32Array(N);
  const hb = new Float32Array(N);
  const hc = new Int32Array(N);

  for (let y = 0; y < dim; y++) {
    const row = y * dim;
    let sr = 0, sg = 0, sb = 0, sc = 0;
    for (let x = 0; x <= rad && x < dim; x++) {
      if (src.v[row + x]) { sr += src.r[row + x]; sg += src.g[row + x]; sb += src.b[row + x]; sc++; }
    }
    for (let x = 0; x < dim; x++) {
      hr[row + x] = sr; hg[row + x] = sg; hb[row + x] = sb; hc[row + x] = sc;
      const out = x - rad;
      if (out >= 0 && src.v[row + out]) { sr -= src.r[row + out]; sg -= src.g[row + out]; sb -= src.b[row + out]; sc--; }
      const inn = x + rad + 1;
      if (inn < dim && src.v[row + inn]) { sr += src.r[row + inn]; sg += src.g[row + inn]; sb += src.b[row + inn]; sc++; }
    }
  }

  const r = new Int16Array(N);
  const g = new Int16Array(N);
  const b = new Int16Array(N);
  const v = new Uint8Array(N);
  for (let x = 0; x < dim; x++) {
    let sr = 0, sg = 0, sb = 0, sc = 0;
    for (let y = 0; y <= rad && y < dim; y++) {
      const i = y * dim + x; sr += hr[i]; sg += hg[i]; sb += hb[i]; sc += hc[i];
    }
    for (let y = 0; y < dim; y++) {
      const i = y * dim + x;
      if (sc > 0) { r[i] = Math.round(sr / sc); g[i] = Math.round(sg / sc); b[i] = Math.round(sb / sc); v[i] = 1; }
      const out = y - rad;
      if (out >= 0) { const j = out * dim + x; sr -= hr[j]; sg -= hg[j]; sb -= hb[j]; sc -= hc[j]; }
      const inn = y + rad + 1;
      if (inn < dim) { const j = inn * dim + x; sr += hr[j]; sg += hg[j]; sb += hb[j]; sc += hc[j]; }
    }
  }
  return { r, g, b, v };
}

// Build the region's biome grid extended by a BLEND_R-wide halo on all sides,
// filled from the 8 neighbouring regions, so the blur blends biome tints across
// region borders instead of clipping at them. Halo cells stay null where a
// neighbour region/chunk is absent (the blur just averages what's there). Each
// neighbour chunk is decompressed once (cached) via getChunkContainingCoordinate.
const NEIGHBOURS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];
function extendedBiome(biome: (string | null)[], h: number, ew: number): (string | null)[] {
  const eb: (string | null)[] = new Array(ew * ew).fill(null);
  for (let lz = 0; lz < SIZE; lz++)
    for (let lx = 0; lx < SIZE; lx++)
      eb[(lz + h) * ew + (lx + h)] = biome[lz * SIZE + lx];
  if (h === 0) return eb;
  for (const [dx, dz] of NEIGHBOURS) {
    const parser = openRegion(join(dirname(file), `r.${rx + dx}.${rz + dz}.mca`));
    if (!parser) continue;
    const cache = new Map<string, ReturnType<typeof topColumns>>();
    const ex0 = dx < 0 ? 0 : dx > 0 ? h + SIZE : h, ex1 = dx < 0 ? h : dx > 0 ? ew : h + SIZE;
    const ez0 = dz < 0 ? 0 : dz > 0 ? h + SIZE : h, ez1 = dz < 0 ? h : dz > 0 ? ew : h + SIZE;
    for (let ez = ez0; ez < ez1; ez++) {
      for (let ex = ex0; ex < ex1; ex++) {
        const wx = baseX - h + ex, wz = baseZ - h + ez;
        const ck = `${wx >> 4},${wz >> 4}`;
        let cols = cache.get(ck);
        if (cols === undefined) {
          try {
            const ch = parser.getChunkContainingCoordinate([wx, 0, wz]);
            cols = ch ? topColumns(ch, table) : null;
          } catch { cols = null; }
          cache.set(ck, cols);
        }
        if (cols) eb[ez * ew + ex] = cols.biomes[(wz - cols.oz) * 16 + (wx - cols.ox)];
      }
    }
  }
  return eb;
}

async function render(): Promise<void> {
  const name: (string | null)[] = new Array(SIZE * SIZE).fill(null);
  const biome: (string | null)[] = new Array(SIZE * SIZE).fill(null);
  const depth = new Int32Array(SIZE * SIZE);
  const height = new Int32Array(SIZE * SIZE).fill(EMPTY_HEIGHT);
  let any = false;

  // Pass 1: fill per-region name / biome / depth / height grids.
  for (const chunk of chunks) {
    let cols;
    try {
      cols = topColumns(chunk, table);
    } catch {
      continue; // skip a corrupt chunk rather than failing the whole region
    }
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
    parentPort!.postMessage({ rx, rz, lastUpdate, mtimeMs, rendered: true, png: null, biome: null, dirtyEdges } as TileResult);
    return;
  }

  // Blur over the region extended by a BLEND_R halo of neighbouring biomes, so
  // tints blend across region borders. With BLEND_R = 0 the halo is empty and
  // the blur is a no-op (each cell keeps its own tint).
  const H = BLEND_R;
  const EW = SIZE + 2 * H;
  const eb = extendedBiome(biome, H, EW);
  // One blurred tint field per kind, keyed for direct lookup.
  const blends = {
    grass: blur(tintField(eb, EW, PICK.grass), EW, H),
    foliage: blur(tintField(eb, EW, PICK.foliage), EW, H),
    dry_foliage: blur(tintField(eb, EW, PICK.dry_foliage), EW, H),
    water: blur(tintField(eb, EW, PICK.water), EW, H),
  } as Record<TintKind, Field>;

  // `ei` is the index into the extended grid for region cell (lx, lz). Prefer the
  // blurred value; fall back to the cell's own biome colour where the blur saw no
  // valid samples.
  const tintBase = (kind: TintKind, ei: number): number => {
    const fld = blends[kind];
    if (fld.v[ei]) return (fld.r[ei] << 16) | (fld.g[ei] << 8) | fld.b[ei];
    const bn = eb[ei];
    const bc = bn ? biomeColors.get(bn) : undefined;
    const c = bc ? PICK[kind](bc) : -1;
    // No biome (or the biome lacks this tint) -> use the default tint, never the
    // block's map colour / hashed fallback.
    return c >= 0 ? c : PICK[kind](DEFAULT_TINT);
  };

  const northEdge = northEdgeHeights();

  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let lz = 0; lz < SIZE; lz++) {
    for (let lx = 0; lx < SIZE; lx++) {
      const idx = lz * SIZE + lx;
      const ei = (lz + H) * EW + (lx + H); // same cell in the haloed blur grid
      const nm = name[idx];
      if (nm === null) continue;

      const tint = TINTS[nm];
      let shadeIndex = 1;
      if (tint === 'water') {
        // Water is shaded by depth (shallow bright -> deep dark) with a 1px
        // checkerboard dither, like the vanilla map — not by the north height,
        // so skip that comparison entirely.
        const d0 = depth[idx] * 0.1 + ((lx + lz) & 1) * 0.2;
        shadeIndex = d0 < 0.5 ? 2 : d0 > 0.9 ? 0 : 1;
      } else {
        // Vanilla shading: compare against the block to the NORTH (-Z = up on the
        // tile). At the region's north edge the neighbour lives in the region above,
        // whose south-edge heights we loaded into northEdge so the seam matches.
        const hN = lz > 0 ? height[(lz - 1) * SIZE + lx] : northEdge[lx];
        if (hN !== EMPTY_HEIGHT) {
          const h = height[idx];
          shadeIndex = h > hN ? 2 : h < hN ? 0 : 1;
        }
      }
      // Leaf blocks (foliage tint, or fixed birch/spruce) get extra darkening.
      const isLeaf = tint === 'foliage' || typeof tint === 'number';

      let r: number, g: number, b: number;
      if (tint === undefined) {
        [r, g, b] = colorRGB(table, nm, shadeIndex);
      } else {
        const base = typeof tint === 'number' ? tint : tintBase(tint, ei);
        [r, g, b] = base >= 0 ? shadeRGB(base, shadeIndex) : colorRGB(table, nm, shadeIndex);
      }

      const f = isLeaf
        ? BRIGHTNESS * FOLIAGE
        : tint === 'water'
          ? BRIGHTNESS * WATER_BRIGHT
          : tint === 'grass'
            ? BRIGHTNESS * GRASS
            : tint === 'dry_foliage'
              ? BRIGHTNESS * DRY_FOLIAGE
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
  parentPort!.postMessage({ rx, rz, lastUpdate, mtimeMs, rendered: true, png, biome: biomeCells(biome), dirtyEdges } as TileResult);
}

if (!rendered) {
  skip();
} else {
  // Backstop: if rendering the region throws for any reason (corrupt data, an
  // mc-anvil parser overflow, etc.), skip this region instead of crashing the
  // worker and aborting the whole map.
  render().catch((e) => {
    console.warn(`[worker] failed to render region ${file}; skipping: ${e instanceof Error ? e.message : e}`);
    skip();
  });
}
