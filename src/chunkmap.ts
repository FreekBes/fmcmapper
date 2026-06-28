import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Chunk, BlockDataParser, chunkCoordinateFromIndex, findChildTagAtPath } from 'mc-anvil';
import type { TagData, BlockStates, Palette } from 'mc-anvil';
import { BLOCK_ALIASES, BIOME_ALIASES, LEGACY_BIOME_IDS, SUBMERGED_PLANTS } from './gamedata';

// ---------------------------------------------------------------------------
// Vanilla map-color palette (from the Fabric map-color-dump mod)
// ---------------------------------------------------------------------------

export type ColorEntry = { mapColorId: number; shades: [number, number, number, number] };
export type ColorTable = Map<string, ColorEntry>;

type RawEntry = { mapColorId: number; baseRGB: number; baseHex: string; shades: number[] };

export function loadColorTable(
  file: string = resolve(process.cwd(), 'assets/map_colors.json'),
): ColorTable {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, RawEntry>;
  const table: ColorTable = new Map();
  for (const [name, v] of Object.entries(raw)) {
    const s = v.shades ?? [];
    table.set(name, {
      mapColorId: v.mapColorId ?? 0,
      shades: [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, s[3] ?? 0],
    });
  }
  return table;
}

// shadeIndex: 0 = column lower than block to its north (darker, x180),
//             1 = same height (x220), 2 = higher (brighter, x255).
const FALLBACK_MUL = [180, 220, 255];

function hashBase(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (((h >>> 16) & 0xff) << 16) | (((h >>> 8) & 0xff) << 8) | (h & 0xff);
}

export function colorRGB(table: ColorTable, name: string, shadeIndex: number): [number, number, number] {
  const e = table.get(name);
  // Unknown / modded block: shade a stable hashed base colour the same way.
  if (!e) return shadeRGB(hashBase(name), shadeIndex);
  const packed = e.shades[shadeIndex] ?? e.shades[1];
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

// Apply the map shade multiplier (x180/220/255) to an arbitrary base color,
// e.g. a biome grass/foliage/water color. Matches the mod's integer math.
export function shadeRGB(rgb: number, shadeIndex: number): [number, number, number] {
  const mul = FALLBACK_MUL[shadeIndex] ?? 220;
  const sh = (c: number) => Math.floor((c * mul) / 255) & 0xff;
  return [sh((rgb >> 16) & 0xff), sh((rgb >> 8) & 0xff), sh(rgb & 0xff)];
}

// ---------------------------------------------------------------------------
// Per-biome colors (from the Fabric mod's biome_colors.json) + tint rules
// ---------------------------------------------------------------------------

export type BiomeColor = { grass: number; foliage: number; dryFoliage: number; water: number }; // RGB, -1 = none
export type BiomeColors = Map<string, BiomeColor>;

type RawBiome = {
  grass?: { RGB?: number }; foliage?: { RGB?: number };
  dryFoliage?: { RGB?: number }; water?: { RGB?: number };
};

export function loadBiomeColors(
  file: string = resolve(process.cwd(), 'assets/biome_colors.json'),
): BiomeColors {
  let raw: Record<string, RawBiome>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, RawBiome>;
  } catch {
    return new Map(); // no file -> tinting simply doesn't apply
  }
  const m: BiomeColors = new Map();
  for (const [name, v] of Object.entries(raw)) {
    m.set(name, {
      grass: v.grass?.RGB ?? -1,
      foliage: v.foliage?.RGB ?? -1,
      dryFoliage: v.dryFoliage?.RGB ?? -1,
      water: v.water?.RGB ?? -1,
    });
  }
  return m;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const isAir = (n: string) => n === '' || n.endsWith(':air') || n.endsWith('_air');

const childTag = (section: TagData[], name: string): TagData | undefined =>
  section.find(x => x.name === name);

// mc-anvil reads TAG_Byte as unsigned (getUint8), but section Y is signed and
// negative below y=0 (e.g. Y=-4 is stored as 0xFC = 252). Sign-extend it.
const signedByte = (v: number): number => (v > 127 ? v - 256 : v);

const sectionY = (section: TagData[]): number => {
  const y = childTag(section, 'Y');
  return y ? signedByte(Number(y.data)) : 0;
};

function sectionData(section: TagData[]): { bs?: BlockStates; pal?: Palette } {
  const directPal = childTag(section, 'Palette') ?? childTag(section, 'palette');
  if (directPal) {
    return {
      bs: childTag(section, 'BlockStates') as unknown as BlockStates | undefined,
      pal: directPal as unknown as Palette,
    };
  }
  const container = childTag(section, 'block_states');
  if (container && Array.isArray(container.data)) {
    const inner = container.data as TagData[];
    return {
      bs: inner.find(x => x.name === 'data') as unknown as BlockStates | undefined,
      pal: inner.find(x => x.name === 'palette') as unknown as Palette | undefined,
    };
  }
  return {};
}

const paletteEntryName = (entry: TagData[]): string => {
  const n = entry.find(x => x.name.toLowerCase() === 'name');
  const nm = typeof n?.data === 'string' ? n.data : '';
  return BLOCK_ALIASES[nm] ?? nm; // normalise legacy ids to their current name
};

// A block is drawn unless it's air or its map color is NONE (id 0). Unknown /
// modded blocks are drawn with a hashed fallback colour.
const drawable = (nm: string, table: ColorTable): boolean => {
  if (isAir(nm)) return false;
  const e = table.get(nm);
  if (e && e.mapColorId === 0) return false;
  return true;
};

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

// Big-endian long extractor shared by the block and biome readers. Reads value
// `i` from a paletted-container LONG_ARRAY: value j sits at bit j*bits from the
// LSB, top (64 % bits) bits are padding. Verified against mc-anvil's decoder.
function packedExtractor(data: ArrayBuffer, bits: number): (i: number) => number {
  const valuesPerLong = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  const n = Math.floor(data.byteLength / 8);
  const view = new DataView(data);
  const longs = new BigUint64Array(n);
  for (let k = 0; k < n; k++) longs[k] = view.getBigUint64(k * 8, false);
  return (i: number): number => {
    const j = i % valuesPerLong;
    const k = (i - j) / valuesPerLong;
    if (k >= n) return -1;
    return Number((longs[k] >> BigInt(j * bits)) & mask);
  };
}

// ceil(log2(n)) for a palette of n entries (== bits-per-value before any floor).
const paletteBits = (n: number): number => Math.floor(Math.log2((n - 1) || 1)) + 1;

// ---------------------------------------------------------------------------
// Single-section random-access reader
//
// Reads one block's palette index without unpacking the whole section. The bit
// layout (big-endian longs, value j at bit j*bits from the LSB, top bits as
// padding) was verified against mc-anvil's own decoder for every bit width.
// ---------------------------------------------------------------------------

type SectionReader = {
  palNames: string[];
  palDrawable: boolean[];
  palSubmerged: boolean[]; // counts as water for depth shading (see submergedFlags)
  idxAt: (lx: number, ly: number, lz: number) => number; // palette index, or -1
};

const entryWaterlogged = (entry: TagData[]): boolean => {
  const props = entry.find(x => x.name === 'Properties');
  const list = props && Array.isArray(props.data) ? (props.data as TagData[]) : null;
  return list?.find(x => x.name === 'waterlogged')?.data === 'true';
};

// Per palette entry: does this block carry water (so a depth scan keeps going)?
// Water itself, blocks with waterlogged=true (corals, sea pickles, waterlogged
// stairs/slabs in ruins), and the implicitly-submerged plants above.
const submergedFlags = (entries: TagData[][], names: string[]): boolean[] =>
  entries.map((e, i) => names[i] === 'minecraft:water' || SUBMERGED_PLANTS.has(names[i]) || entryWaterlogged(e));

function buildReader(section: TagData[], table: ColorTable): SectionReader | null {
  const { bs, pal } = sectionData(section);
  if (!pal) return null;
  const entries = pal.data.data as TagData[][];
  const palNames = entries.map(paletteEntryName);
  const palDrawable = palNames.map(nm => drawable(nm, table));
  const palSubmerged = submergedFlags(entries, palNames);

  if (entries.length <= 1) {
    // Uniform section: one block fills it (or it's empty/air).
    if (entries.length === 0 || !palDrawable[0]) return null;
    return { palNames, palDrawable, palSubmerged, idxAt: () => 0 };
  }
  if (!bs || !(bs.data instanceof ArrayBuffer) || bs.data.byteLength === 0) return null;

  const bits = Math.max(4, paletteBits(entries.length)); // blocks: min 4 bits
  const read = packedExtractor(bs.data, bits);
  const idxAt = (lx: number, ly: number, lz: number): number => read(ly * 256 + lz * 16 + lx);
  return { palNames, palDrawable, palSubmerged, idxAt };
}

// ---------------------------------------------------------------------------
// Biome reader (paletted container, 4x4x4 cells, string palette, no 4-bit min)
// ---------------------------------------------------------------------------

function biomeContainer(section: TagData[]): { bs?: BlockStates; pal?: TagData } {
  const c = childTag(section, 'biomes');
  if (c && Array.isArray(c.data)) {
    const inner = c.data as TagData[];
    return {
      bs: inner.find(x => x.name === 'data') as unknown as BlockStates | undefined,
      pal: inner.find(x => x.name === 'palette'),
    };
  }
  return {};
}

type BiomeReader = { biomeAt: (lx: number, ly: number, lz: number) => string | null };

function buildBiomeReader(section: TagData[]): BiomeReader | null {
  const { bs, pal } = biomeContainer(section);
  if (!pal) return null;
  // Biome palette is a LIST of STRING, so data.data is the id array directly.
  const raw = (((pal.data as unknown) as { data?: unknown } | null)?.data as string[]) ?? [];
  const names = raw.map(n => BIOME_ALIASES[n] ?? n); // normalise renamed biome ids
  if (names.length === 0) return null;
  if (names.length === 1 || !bs || !(bs.data instanceof ArrayBuffer) || bs.data.byteLength === 0) {
    const only = names[0];
    return { biomeAt: () => only };
  }
  const read = packedExtractor(bs.data, paletteBits(names.length)); // biomes: no min
  return {
    biomeAt: (lx, ly, lz) => {
      const idx = read((ly >> 2) * 16 + (lz >> 2) * 4 + (lx >> 2)); // 4x4x4 cells
      return idx < 0 || idx >= names.length ? null : names[idx];
    },
  };
}

// Pre-1.18 biomes: a chunk-level numeric `Biomes` array (no per-section palette).
// 1.15-1.17 store 1024 ids (4x4x4 cells, vertical too); 1.13-1.14 store 256 (2D,
// one per column). Numeric ids map through LEGACY_BIOME_IDS, then BIOME_ALIASES to
// today's names. NB: unlike the 1.18 reader, biomeAt's middle arg is the *world* Y
// (the legacy 3D grid is indexed by absolute height, not a within-section offset).
function buildLegacyBiomeReader(chunk: Chunk): BiomeReader | null {
  const tag = findChildTagAtPath('Level/Biomes', chunk.root) ?? findChildTagAtPath('Biomes', chunk.root);
  const ids = tag?.data;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const name = (id: unknown): string | null => {
    const n = typeof id === 'number' ? LEGACY_BIOME_IDS[id] : undefined;
    return n ? (BIOME_ALIASES[n] ?? n) : null;
  };
  if (ids.length >= 1024) {
    // 4x4x4 cells; vertical cell = world Y >> 2, clamped to the 0..63 (0..255) range.
    return {
      biomeAt: (lx, wy, lz) => {
        const yc = Math.min(63, Math.max(0, wy >> 2));
        return name(ids[(yc << 4) | ((lz >> 2) << 2) | (lx >> 2)]);
      },
    };
  }
  // 2D: one biome per column, ignoring height.
  return { biomeAt: (lx, _wy, lz) => name(ids[(lz & 15) * 16 + (lx & 15)]) };
}

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
function sampleExtras(
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
        const idx = rdr.idxAt(lx, y - sy * 16, lz);
        if (idx < 0 || !rdr.palSubmerged[idx]) break;
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
    const entries = pal.data.data as TagData[][];

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
    const raw = new BlockDataParser(bs, pal).getRawBlocks();
    for (let i = 4095; i >= 0; i--) {
      const pi = raw[i];
      if (pi === undefined || !palDrawable[pi]) continue;
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
