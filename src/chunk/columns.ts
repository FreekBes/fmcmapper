// Assembling a chunk's surface: iterate a region's chunks, scan each top-down for
// the highest drawable block per column, then sample that column's biome and (for
// water) its depth. This ties together the section block reader (./sections) and
// the biome readers (./biomes) and is what the render worker consumes.

import { AnvilParser, Chunk, NBTParser, chunkCoordinateFromIndex } from 'mc-anvil';
import type { TagData } from 'mc-anvil';
import { SUBMERGED_PLANTS } from '../gamedata';
import type { ColorTable } from '../colors';
import {
  childTag, sectionY, sectionData, paletteEntryName, drawable, packedExtractor, paletteBits,
  buildReader, type PaletteEntry,
} from './sections';
import { buildBiomeReader, buildLegacyBiomeReader, type BiomeReader } from './biomes';

// Decode a region's chunks one at a time. Holding a whole region's decompressed
// NBT at once (mc-anvil's getAllChunks) is the single biggest allocation in a
// render — hundreds of MB for a dense region — but each pass only ever needs the
// chunk in hand, so a generator lets each tree be GC'd as the loop advances. This
// mirrors getAllChunks' own decode (locate -> inflate -> parse) per chunk, and
// skips a corrupt chunk rather than aborting the whole region. `parser` may be
// null (empty/truncated region), in which case it yields nothing.
export function* iterChunks(parser: AnvilParser | null): Generator<Chunk> {
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

export const EMPTY_HEIGHT = -2147483648;

type Columns = {
  ox: number;
  oz: number;
  names: (string | null)[]; // [z*16 + x], topmost drawable block name, or null
  heights: Int32Array; // [z*16 + x], world Y of that block, or EMPTY_HEIGHT
};

export type ChunkColumns = Columns & {
  biomes: (string | null)[]; // [z*16 + x], biome id at that surface block, or null
  depths: Int32Array; // [z*16 + x], water depth in blocks at the surface (0 = not water)
};

// Index a chunk's sections by their (signed) section Y, tracking the min/max
// present. Returns null when the chunk has no sections at all.
function indexSections(chunk: Chunk): { byY: Map<number, TagData[]>; minSecY: number; maxSecY: number } | null {
  const sectionTag = chunk.sections();
  if (!sectionTag) return null;
  const byY = new Map<number, TagData[]>();
  let minSecY = Infinity;
  let maxSecY = -Infinity;
  for (const s of sectionTag.data.data as TagData[][]) {
    if (childTag(s, 'Y') === undefined) continue;
    const y = sectionY(s);
    byY.set(y, s);
    if (y < minSecY) minSecY = y;
    if (y > maxSecY) maxSecY = y;
  }
  if (!isFinite(minSecY)) return null;
  return { byY, minSecY, maxSecY };
}

// Lazily build + cache a per-section reader keyed by section Y.
function memoSection<T>(
  byY: Map<number, TagData[]>,
  build: (section: TagData[]) => T | null,
): (secY: number) => T | null {
  const cache = new Map<number, T | null>();
  return (secY: number): T | null => {
    if (cache.has(secY)) return cache.get(secY) ?? null;
    const s = byY.get(secY);
    const r = s ? build(s) : null;
    cache.set(secY, r);
    return r;
  };
}

const WATER = 'minecraft:water';
const WATER_DEPTH_CAP = 48; // bound the downward scan for very deep oceans

// Sample, per resolved column: the surface biome, and (for water) the water
// depth used for shading. Independent of fast/scan, so it runs once after.
export function sampleExtras(
  chunk: Chunk,
  table: ColorTable,
  names: (string | null)[],
  heights: Int32Array,
): { biomes: (string | null)[]; depths: Int32Array } {
  const biomes: (string | null)[] = new Array(256).fill(null);
  const depths = new Int32Array(256);
  const idx = indexSections(chunk);
  if (!idx) return { biomes, depths };
  const { byY, minSecY } = idx;
  const minY = minSecY * 16;

  const getBiome = memoSection(byY, buildBiomeReader);
  const getBlock = memoSection(byY, s => buildReader(s, table));
  // Pre-1.18 worlds have no per-section biome palette; fall back to the chunk's
  // numeric Biomes array (built once, null for 1.18+).
  let legacyBiome: BiomeReader | null | undefined;

  for (let c = 0; c < 256; c++) {
    const nm = names[c];
    if (nm === null) continue;
    const wy = heights[c];
    if (wy === EMPTY_HEIGHT) continue;
    const lx = c % 16;
    const lz = Math.floor(c / 16);

    const secY = Math.floor(wy / 16);
    const br = getBiome(secY);
    if (br) {
      biomes[c] = br.biomeAt(lx, wy - secY * 16, lz);
    } else {
      if (legacyBiome === undefined) legacyBiome = buildLegacyBiomeReader(chunk);
      if (legacyBiome) biomes[c] = legacyBiome.biomeAt(lx, wy, lz); // legacy: world Y
    }

    // Water depth: blocks of water column downward from the surface. Like vanilla
    // (which counts by fluid state), this sees through waterlogged blocks and
    // submerged plants — otherwise kelp/seagrass would stop it short and report
    // deep ocean as shallow (speckled bright pixels). Submerged plants that are
    // themselves the surface (e.g. kelp at sea level) render as water too, so they
    // need a depth as well.
    if (nm === WATER || SUBMERGED_PLANTS.has(nm)) {
      let depth = 0;
      for (let y = wy; y >= minY && depth < WATER_DEPTH_CAP; y--) {
        const sy = Math.floor(y / 16);
        const rdr = getBlock(sy);
        if (!rdr) break;
        const bi = rdr.idxAt(lx, y - sy * 16, lz);
        if (bi < 0 || !rdr.palSubmerged[bi]) break;
        depth++;
      }
      depths[c] = depth;
    }
  }
  return { biomes, depths };
}

// ---------------------------------------------------------------------------
// Surface columns: top-down section scan for the topmost drawable block.
// ---------------------------------------------------------------------------

function scanColumns(chunk: Chunk, table: ColorTable): Columns | null {
  const coords = chunk.getCoordinates();
  if (!coords) return null;
  const [ox, oz] = coords;

  const sectionTag = chunk.sections();
  if (!sectionTag) return null;
  const ordered = (sectionTag.data.data as TagData[][])
    .filter(s => childTag(s, 'Y') !== undefined)
    .map(s => ({ section: s, y: sectionY(s) }))
    .sort((a, b) => b.y - a.y); // highest section first

  const names: (string | null)[] = new Array(256).fill(null);
  const heights = new Int32Array(256).fill(EMPTY_HEIGHT);
  let resolved = 0;

  for (let si = 0; si < ordered.length && resolved < 256; si++) {
    const { section, y } = ordered[si];
    const { bs, pal } = sectionData(section);
    if (!pal) continue;
    const entries = pal.data.data as PaletteEntry[];

    if (entries.length <= 1) {
      const nm = entries.length === 1 ? paletteEntryName(entries[0]) : '';
      if (drawable(nm, table)) {
        const absY = y * 16 + 15;
        for (let c = 0; c < 256; c++) {
          if (names[c] === null) {
            names[c] = nm;
            heights[c] = absY;
            resolved++;
          }
        }
      }
      continue;
    }
    if (!bs || !(bs.data instanceof ArrayBuffer) || bs.data.byteLength === 0) continue;

    const sy = y * 16;
    const palNames = entries.map(paletteEntryName);
    const palDrawable = palNames.map(nm => drawable(nm, table));
    // Decode the packed block indices ourselves rather than via mc-anvil's
    // BlockDataParser: since 26.3 a default-state section stores its palette as a
    // list of name strings, and BlockDataParser assumes the older compound palette
    // (it calls .find on each entry) and throws. packedExtractor only reads the
    // LongArray, so it's palette-shape-agnostic — same decoder buildReader uses.
    const bits = Math.max(4, paletteBits(entries.length)); // blocks: min 4 bits
    const read = packedExtractor(bs.data, bits);
    for (let i = 4095; i >= 0; i--) {
      const pi = read(i);
      if (pi < 0 || pi >= palNames.length || !palDrawable[pi]) continue;
      const [lx, ly, lz] = chunkCoordinateFromIndex(i);
      const c = lz * 16 + lx;
      if (names[c] !== null) continue;
      names[c] = palNames[pi];
      heights[c] = sy + ly;
      if (++resolved === 256) break;
    }
  }
  return { ox, oz, names, heights };
}

// Public entry: resolve surface columns, then sample biomes + water depth.
export function topColumns(chunk: Chunk, table: ColorTable): ChunkColumns | null {
  const cols = scanColumns(chunk, table);
  if (!cols) return null;
  const { biomes, depths } = sampleExtras(chunk, table, cols.names, cols.heights);
  return { ...cols, biomes, depths };
}
