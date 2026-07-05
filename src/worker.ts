import { parentPort } from 'worker_threads';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import sharp from 'sharp';
sharp.concurrency(1);
sharp.cache(false); // don't retain decoded pixels in libvips' native cache
import { AnvilParser, Chunk, NBTParser, findChildTag } from 'mc-anvil';
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
export type Job = { file: string; rx: number; rz: number; since: number; mtimeMs: number };
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

// ---------------------------------------------------------------------------
// Load-once, reused for every job this worker handles. The worker is persistent
// (see the message handler at the bottom): the parent's pool feeds it one region
// job at a time, so parsing the colour tables / render config here happens once
// per worker rather than once per region. Override paths with MAP_COLORS_PATH /
// BIOME_COLORS_PATH.
// ---------------------------------------------------------------------------
const table = loadColorTable(process.env.MAP_COLORS_PATH);
const biomeColors = loadBiomeColors(process.env.BIOME_COLORS_PATH);

// Pixel brightness/blend settings. Defaults live in renderconfig.ts, which the
// render signature hashes — so changing one there forces a redraw automatically.
const { brightness: BRIGHTNESS, foliage: FOLIAGE, grass: GRASS, grassFoliage: GRASS_FOLIAGE, dryFoliage: DRY_FOLIAGE, water: WATER_BRIGHT, blendR: BLEND_R } = renderConfig();

// Hand a file's bytes to the parser without copying when possible. readFileSync
// returns a dedicated (unpooled) Buffer for anything larger than half the Buffer
// pool — which region files always are — so its backing ArrayBuffer is exactly
// this file and can be used directly. We only fall back to a copy in the unlikely
// case the Buffer is a view into a shared pool (small/partial reads). The parser
// only ever reads here, so sharing the store is safe.
function fileArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
    ? (buf.buffer as ArrayBuffer)
    : (buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

// Open a neighbouring region file as a parser, or null if absent/unreadable.
function openRegion(path: string): AnvilParser | null {
  if (!existsSync(path)) return null;
  try {
    return new AnvilParser(fileArrayBuffer(readFileSync(path)));
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

// Downsample the surface biome grid to one sample per BIOME_RES block cell, with
// a compact local palette (index 255 = no biome). Reads the region's biomes from
// the centre of the haloed grid `eb` (offset by H on each axis, stride EW), so we
// don't keep a second region-sized biome array alongside it.
function biomeCells(eb: (string | null)[], ew: number, h: number): BiomeCells {
  const palette: string[] = [];
  const idOf = new Map<string, number>();
  const data = new Array<number>(BIOME_CELLS * BIOME_CELLS).fill(255);
  for (let cz = 0; cz < BIOME_CELLS; cz++) {
    for (let cx = 0; cx < BIOME_CELLS; cx++) {
      const nm = eb[(cz * BIOME_RES + h) * ew + (cx * BIOME_RES + h)];
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

// A blurred tint field: one packed colour per cell, `0xRRGGBB`, or -1 where the
// blur saw no valid samples. Packing the three channels + validity into a single
// Int32Array (vs three Int16Arrays + a Uint8 flag) roughly halves the memory held
// for the four fields across the whole pixel loop.
type Field = Int32Array;

// Reusable per-axis blur accumulators, allocated once and shared by all four tint
// kinds (blur runs them sequentially). Row-window channel sums stay well under
// Int16 (<=255 * (2*rad+1), rad<=8 => <=4335); counts fit Uint8 (<=2*rad+1).
type Scratch = { hr: Int16Array; hg: Int16Array; hb: Int16Array; hc: Uint8Array };

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
  const f = new Int32Array(dim * dim).fill(-1);
  for (let i = 0; i < f.length; i++) {
    const bn = grid[i];
    if (!bn) continue;
    const bc = biomeColors.get(bn);
    if (!bc) continue;
    const rgb = pick(bc);
    if (rgb < 0) continue;
    f[i] = rgb & 0xffffff; // 0xRRGGBB, always >= 0 so it reads as "valid"
  }
  return f;
}

// Separable box blur over a dim x dim grid that averages only over valid cells
// (so no-biome holes and grid edges don't darken the result). `s` holds the
// horizontal-pass accumulators, reused across kinds to avoid re-allocating them.
function blur(src: Field, dim: number, rad: number, s: Scratch): Field {
  const { hr, hg, hb, hc } = s;
  for (let y = 0; y < dim; y++) {
    const row = y * dim;
    let sr = 0, sg = 0, sb = 0, sc = 0;
    for (let x = 0; x <= rad && x < dim; x++) {
      const p = src[row + x];
      if (p >= 0) { sr += (p >> 16) & 255; sg += (p >> 8) & 255; sb += p & 255; sc++; }
    }
    for (let x = 0; x < dim; x++) {
      hr[row + x] = sr; hg[row + x] = sg; hb[row + x] = sb; hc[row + x] = sc;
      const out = x - rad;
      if (out >= 0) { const p = src[row + out]; if (p >= 0) { sr -= (p >> 16) & 255; sg -= (p >> 8) & 255; sb -= p & 255; sc--; } }
      const inn = x + rad + 1;
      if (inn < dim) { const p = src[row + inn]; if (p >= 0) { sr += (p >> 16) & 255; sg += (p >> 8) & 255; sb += p & 255; sc++; } }
    }
  }

  const out = new Int32Array(dim * dim).fill(-1);
  for (let x = 0; x < dim; x++) {
    let sr = 0, sg = 0, sb = 0, sc = 0;
    for (let y = 0; y <= rad && y < dim; y++) {
      const i = y * dim + x; sr += hr[i]; sg += hg[i]; sb += hb[i]; sc += hc[i];
    }
    for (let y = 0; y < dim; y++) {
      const i = y * dim + x;
      if (sc > 0) out[i] = (Math.round(sr / sc) << 16) | (Math.round(sg / sc) << 8) | Math.round(sb / sc);
      const o = y - rad;
      if (o >= 0) { const j = o * dim + x; sr -= hr[j]; sg -= hg[j]; sb -= hb[j]; sc -= hc[j]; }
      const inn = y + rad + 1;
      if (inn < dim) { const j = inn * dim + x; sr += hr[j]; sg += hg[j]; sb += hb[j]; sc += hc[j]; }
    }
  }
  return out;
}

const NEIGHBOURS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];

// ---------------------------------------------------------------------------
// Render one region. All per-job state is local so the worker can process many
// jobs sequentially without leaking anything between regions. Returns the tile
// result (posted back by the message handler); never throws — a parse/render
// failure is turned into a "skipped" result so one bad region can't kill the
// worker or stall its job in the parent's pool.
// ---------------------------------------------------------------------------
async function processJob(job: Job): Promise<TileResult> {
  const { file, rx, rz, since, mtimeMs } = job;
  const baseX = rx * SIZE;
  const baseZ = rz * SIZE;

  // A valid region starts with an 8 KiB header (location + timestamp tables); a
  // shorter file is empty or truncated (common in worlds, or mid-write) and would
  // make mc-anvil's header parse read past the end. Treat any such failure as an
  // empty region (no chunks) instead of crashing the worker.
  let parser: AnvilParser | null = null;
  try {
    const ab = fileArrayBuffer(readFileSync(file));
    if (ab.byteLength >= 8192) parser = new AnvilParser(ab);
    else console.warn(`[worker] region ${file} is empty or truncated; skipping`);
  } catch (e) {
    console.warn(`[worker] could not read region ${file}; skipping: ${e instanceof Error ? e.message : e}`);
  }

  // Decode chunks one at a time instead of materialising all ~1024 at once
  // (mc-anvil's getAllChunks). A region's full decompressed NBT is by far the
  // worker's largest allocation — holding every chunk tree simultaneously can run
  // to hundreds of MB for a dense region — but each pass only ever needs the chunk
  // in hand, so a generator lets each tree be GC'd as the loop moves on. This
  // mirrors getAllChunks' own decode (locate -> inflate -> parse) per chunk, and
  // skips a corrupt chunk rather than aborting the whole region.
  function* iterChunks(): Generator<Chunk> {
    if (!parser) return;
    let entries;
    try { entries = parser.getLocationEntries(); } catch { return; }
    for (const e of entries) {
      if (e.sectorCount === 0) continue;
      let chunk: Chunk;
      try { chunk = new Chunk(new NBTParser(parser.getChunkData(e.offset)).getTag()); }
      catch { continue; }
      yield chunk;
    }
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
  for (const c of iterChunks()) {
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

  const skipResult = (): TileResult => ({ rx, rz, lastUpdate, mtimeMs, rendered: false, png: null, biome: null, dirtyEdges });

  // Re-render if we've never rendered this region, it advanced, or we couldn't
  // verify a chunk's timestamp.
  const rendered = since < 0 || missing > 0 || lastUpdate > since;
  if (!rendered) return skipResult();

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
    const np = openRegion(join(dirname(file), `r.${rx}.${rz - 1}.mca`));
    if (!np) return edge;
    const wz = rz * SIZE - 1; // world Z of the row immediately north of this region
    for (let cx = 0; cx < 32; cx++) {
      let cols;
      try {
        const chunk = np.getChunkContainingCoordinate([baseX + cx * 16, 0, wz]);
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

  // Fill the BLEND_R-wide halo around the region's biome grid `eb` from the 8
  // neighbouring regions, so the blur blends biome tints across region borders
  // instead of clipping at them. The region's own biomes are written into the
  // centre of `eb` during pass 1; this only fills the surrounding halo. Halo cells
  // stay null where a neighbour region/chunk is absent (the blur just averages
  // what's there). Each neighbour chunk is decompressed once (cached) via
  // getChunkContainingCoordinate.
  function fillBiomeHalo(eb: (string | null)[], h: number, ew: number): void {
    if (h === 0) return;
    for (const [dx, dz] of NEIGHBOURS) {
      const np = openRegion(join(dirname(file), `r.${rx + dx}.${rz + dz}.mca`));
      if (!np) continue;
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
              const ch = np.getChunkContainingCoordinate([wx, 0, wz]);
              cols = ch ? topColumns(ch, table) : null;
            } catch { cols = null; }
            cache.set(ck, cols);
          }
          if (cols) eb[ez * ew + ex] = cols.biomes[(wz - cols.oz) * 16 + (wx - cols.ox)];
        }
      }
    }
  }

  // Backstop: if rendering throws for any reason (corrupt data, an mc-anvil parser
  // overflow, etc.), skip this region instead of crashing the worker.
  try {
    // The biome grid is stored directly in the centre of the BLEND_R-haloed grid
    // `eb` (see fillBiomeHalo), so we don't keep a second region-sized biome array.
    // Block names are interned into `namePal` and referenced per pixel by a compact
    // Uint16 index (NO_NAME = empty), which is far cheaper than a 512x512 array of
    // string pointers. Water depth is 0..WATER_DEPTH_CAP so it fits in a Uint8.
    const H = BLEND_R;
    const EW = SIZE + 2 * H;
    const NO_NAME = 0xffff;
    const namePal: string[] = [];
    const nameId = new Map<string, number>();
    const nameIdx = new Uint16Array(SIZE * SIZE).fill(NO_NAME);
    const eb: (string | null)[] = new Array(EW * EW).fill(null);
    const depth = new Uint8Array(SIZE * SIZE);
    const height = new Int32Array(SIZE * SIZE).fill(EMPTY_HEIGHT);
    let any = false;

    // Pass 1: fill per-region name / biome / depth / height grids. Re-iterates the
    // chunks (the earlier LastUpdate scan already consumed one pass); only regions
    // that actually re-render pay this second decode.
    for (const chunk of iterChunks()) {
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
          let id = nameId.get(nm);
          if (id === undefined) { id = namePal.length; nameId.set(nm, id); namePal.push(nm); }
          nameIdx[idx] = id;
          eb[(lz + H) * EW + (lx + H)] = cols.biomes[cc]; // region biomes -> eb centre
          depth[idx] = cols.depths[cc];
          height[idx] = cols.heights[cc];
          any = true;
        }
      }
    }

    if (!any) {
      // Region has no renderable terrain (e.g. all chunks deleted): no tile.
      return { rx, rz, lastUpdate, mtimeMs, rendered: true, png: null, biome: null, dirtyEdges };
    }

    // Blur over the region extended by a BLEND_R halo of neighbouring biomes, so
    // tints blend across region borders. With BLEND_R = 0 the halo is empty and
    // the blur is a no-op (each cell keeps its own tint).
    fillBiomeHalo(eb, H, EW);
    // One set of horizontal-pass accumulators, reused across all four blur kinds.
    const scratch: Scratch = {
      hr: new Int16Array(EW * EW), hg: new Int16Array(EW * EW),
      hb: new Int16Array(EW * EW), hc: new Uint8Array(EW * EW),
    };
    // One blurred tint field per kind, keyed for direct lookup.
    const blends = {
      grass: blur(tintField(eb, EW, PICK.grass), EW, H, scratch),
      foliage: blur(tintField(eb, EW, PICK.foliage), EW, H, scratch),
      dry_foliage: blur(tintField(eb, EW, PICK.dry_foliage), EW, H, scratch),
      water: blur(tintField(eb, EW, PICK.water), EW, H, scratch),
    } as Record<TintKind, Field>;

    // `ei` is the index into the extended grid for region cell (lx, lz). Prefer the
    // blurred value; fall back to the cell's own biome colour where the blur saw no
    // valid samples.
    const tintBase = (kind: TintKind, ei: number): number => {
      const packed = blends[kind][ei];
      if (packed >= 0) return packed; // 0xRRGGBB, or -1 where the blur had no samples
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
        const id = nameIdx[idx];
        if (id === NO_NAME) continue;
        const nm = namePal[id];

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
          // grass_foliage shares the biome foliage colour, just a brighter factor.
          const kind = tint === 'grass_foliage' ? 'foliage' : tint;
          const base = typeof kind === 'number' ? kind : tintBase(kind, ei);
          [r, g, b] = base >= 0 ? shadeRGB(base, shadeIndex) : colorRGB(table, nm, shadeIndex);
        }

        const f = isLeaf
          ? BRIGHTNESS * FOLIAGE
          : tint === 'water'
            ? BRIGHTNESS * WATER_BRIGHT
            : tint === 'grass'
              ? BRIGHTNESS * GRASS
              : tint === 'grass_foliage'
                ? BRIGHTNESS * GRASS_FOLIAGE
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
    // Wrap rgba without copying it (Buffer.from(Uint8Array) would clone 1 MiB).
    const png = await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: SIZE, height: SIZE, channels: 4 } })
      .png()
      .toBuffer();
    return { rx, rz, lastUpdate, mtimeMs, rendered: true, png, biome: biomeCells(eb, EW, H), dirtyEdges };
  } catch (e) {
    console.warn(`[worker] failed to render region ${file}; skipping: ${e instanceof Error ? e.message : e}`);
    return skipResult();
  }
}

// Persistent worker: process one job per message and post the result back. (The
// PNG isn't transferred — sharp backs its Buffer with external libvips memory,
// whose ArrayBuffer isn't transferable; it's cloned instead, which is cheap for a
// tile-sized PNG.) processJob never throws, but the outer catch is a last-resort
// backstop so a job always settles (the parent's pool would otherwise wait forever).
parentPort!.on('message', (job: Job) => {
  processJob(job).then(
    (res) => parentPort!.postMessage(res),
    (e) => {
      console.warn(`[worker] unexpected failure for region ${job.rx},${job.rz}: ${e instanceof Error ? e.message : e}`);
      parentPort!.postMessage({ rx: job.rx, rz: job.rz, lastUpdate: -1, mtimeMs: job.mtimeMs, rendered: false, png: null, biome: null, dirtyEdges: [] } as TileResult);
    },
  );
});
