// Reading a chunk section's block palette + packed block indices, across the
// on-disk format changes: pre-1.18 `Palette`/`BlockStates` vs 1.18+ `block_states`,
// the 26.3 palette shapes (string list / renamed compound fields), and the signed
// section-Y index. Block ids are normalised through BLOCK_ALIASES so an older
// world's renamed ids still resolve to a colour.

import type { TagData, BlockStates, Palette } from 'mc-anvil';
import { BLOCK_ALIASES, SUBMERGED_PLANTS } from '../gamedata';
import type { ColorTable } from '../colors';

export const childTag = (section: TagData[], name: string): TagData | undefined =>
  section.find(x => x.name === name);

const isAir = (n: string) => n === '' || n.endsWith(':air') || n.endsWith('_air');

// mc-anvil reads TAG_Byte as unsigned (getUint8), but section Y is signed and
// negative below y=0 (e.g. Y=-4 is stored as 0xFC = 252). Sign-extend it.
const signedByte = (v: number): number => (v > 127 ? v - 256 : v);

export const sectionY = (section: TagData[]): number => {
  const y = childTag(section, 'Y');
  return y ? signedByte(Number(y.data)) : 0;
};

export function sectionData(section: TagData[]): { bs?: BlockStates; pal?: Palette } {
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

// A block-states palette entry. A stateful block is a compound (-> TagData[]):
// {Name, Properties} pre-26.3, {id, properties} since. A default-state block is
// stored "compact" as just its id string — a whole section of them becomes a
// plain string list; a single one inside an otherwise-compound section is a
// compound holding just the (empty-named) id string.
export type PaletteEntry = TagData[] | string;

export const paletteEntryName = (entry: PaletteEntry): string => {
  let nm = '';
  if (typeof entry === 'string') {
    nm = entry; // 26.3 string palette: the entry *is* the block name
  } else {
    // Compound entry. 26.3 renamed the block-state fields: `Name`->`id`,
    // `Properties`->`properties`. A stateful block is {id, properties}; a
    // default-state block kept in a compound section is stored in "compact" form,
    // which mc-anvil surfaces as a string tag with an *empty* tag name. So look
    // for id/Name, then fall back to the first string-valued child (the block id;
    // property values live nested inside the properties compound, not at the
    // entry's top level, so they can't be picked up here by mistake).
    const idName = (n: string): boolean => n === 'id' || n === 'name';
    const named = entry.find(x => idName(x.name.toLowerCase()) && typeof x.data === 'string');
    const idTag = named ?? entry.find(x => typeof x.data === 'string');
    if (idTag && typeof idTag.data === 'string') nm = idTag.data;
  }
  return BLOCK_ALIASES[nm] ?? nm; // normalise legacy ids to their current name
};

// A block is drawn unless it's air or its map color is NONE (id 0). Unknown /
// modded blocks are drawn with a hashed fallback colour.
export const drawable = (nm: string, table: ColorTable): boolean => {
  if (isAir(nm)) return false;
  const e = table.get(nm);
  if (e && e.mapColorId === 0) return false;
  return true;
};

// Big-endian long extractor shared by the block and biome readers. Reads value
// `i` from a paletted-container LONG_ARRAY: value j sits at bit j*bits from the
// LSB, top (64 % bits) bits are padding. Verified against mc-anvil's decoder.
export function packedExtractor(data: ArrayBuffer, bits: number): (i: number) => number {
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
export const paletteBits = (n: number): number => Math.floor(Math.log2((n - 1) || 1)) + 1;

// ---------------------------------------------------------------------------
// Single-section random-access reader
//
// Reads one block's palette index without unpacking the whole section. The bit
// layout (big-endian longs, value j at bit j*bits from the LSB, top bits as
// padding) was verified against mc-anvil's own decoder for every bit width.
// ---------------------------------------------------------------------------

export type SectionReader = {
  palNames: string[];
  palDrawable: boolean[];
  palSubmerged: boolean[]; // counts as water for depth shading (see submergedFlags)
  idxAt: (lx: number, ly: number, lz: number) => number; // palette index, or -1
};

const entryWaterlogged = (entry: PaletteEntry): boolean => {
  // A string palette entry is a default-state block, so it can't be waterlogged.
  if (typeof entry === 'string') return false;
  // Block-state properties: `Properties` pre-26.3, `properties` since. (waterlogged
  // itself is unchanged.)
  const props = entry.find(x => (x.name === 'Properties' || x.name === 'properties') && Array.isArray(x.data));
  const list = props ? (props.data as TagData[]) : null;
  return list?.find(x => x.name === 'waterlogged')?.data === 'true';
};

// Per palette entry: does this block carry water (so a depth scan keeps going)?
// Water itself, blocks with waterlogged=true (corals, sea pickles, waterlogged
// stairs/slabs in ruins), and the implicitly-submerged plants above.
const submergedFlags = (entries: PaletteEntry[], names: string[]): boolean[] =>
  entries.map((e, i) => names[i] === 'minecraft:water' || SUBMERGED_PLANTS.has(names[i]) || entryWaterlogged(e));

export function buildReader(section: TagData[], table: ColorTable): SectionReader | null {
  const { bs, pal } = sectionData(section);
  if (!pal) return null;
  const entries = pal.data.data as PaletteEntry[];
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
