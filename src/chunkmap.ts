import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Chunk, BlockDataParser, chunkCoordinateFromIndex } from 'mc-anvil';
import type { TagData, BlockStates, Palette } from 'mc-anvil';

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
  let packed: number;
  if (e) {
    packed = e.shades[shadeIndex] ?? e.shades[1];
  } else {
    const base = hashBase(name);
    const mul = FALLBACK_MUL[shadeIndex] ?? 220;
    const sh = (c: number) => Math.floor((c * mul) / 255) & 0xff;
    packed = (sh((base >> 16) & 0xff) << 16) | (sh((base >> 8) & 0xff) << 8) | sh(base & 0xff);
  }
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
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
  return typeof n?.data === 'string' ? n.data : '';
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

export type ChunkColumns = {
  ox: number;
  oz: number;
  names: (string | null)[]; // [z*16 + x], topmost drawable block name, or null
  heights: Int32Array; // [z*16 + x], world Y of that block, or EMPTY_HEIGHT
};

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
  idxAt: (lx: number, ly: number, lz: number) => number; // palette index, or -1
};

function buildReader(section: TagData[], table: ColorTable): SectionReader | null {
  const { bs, pal } = sectionData(section);
  if (!pal) return null;
  const entries = pal.data.data as TagData[][];
  const palNames = entries.map(paletteEntryName);
  const palDrawable = palNames.map(nm => drawable(nm, table));

  if (entries.length <= 1) {
    // Uniform section: one block fills it (or it's empty/air).
    if (entries.length === 0 || !palDrawable[0]) return null;
    return { palNames, palDrawable, idxAt: () => 0 };
  }
  if (!bs || !(bs.data instanceof ArrayBuffer) || bs.data.byteLength === 0) return null;

  const paletteSize = entries.length;
  const l = Math.floor(Math.log2((paletteSize - 1) || 1)) + 1;
  const bits = Math.max(4, l);
  const valuesPerLong = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  const n = Math.floor(bs.data.byteLength / 8);
  const view = new DataView(bs.data);
  const longs = new BigUint64Array(n);
  for (let k = 0; k < n; k++) longs[k] = view.getBigUint64(k * 8, false); // big-endian

  const idxAt = (lx: number, ly: number, lz: number): number => {
    const i = ly * 256 + lz * 16 + lx;
    const j = i % valuesPerLong;
    const k = (i - j) / valuesPerLong;
    if (k >= n) return -1;
    return Number((longs[k] >> BigInt(j * bits)) & mask);
  };
  return { palNames, palDrawable, idxAt };
}

// ---------------------------------------------------------------------------
// Fast path: WORLD_SURFACE heightmap + random-access block reads
// ---------------------------------------------------------------------------

const STEP_LIMIT = 32; // max blocks to step down past air/NONE before giving up

function fastColumns(chunk: Chunk, table: ColorTable): ChunkColumns | null {
  const coords = chunk.getCoordinates();
  if (!coords) return null;
  const [ox, oz] = coords;

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

  const minY = minSecY * 16;
  const maxY = maxSecY * 16 + 15;
  // mc-anvil's worldHeights() hardcodes 9-bit entries, valid only up to 512 tall.
  if (maxY - minY + 1 > 512) return null;

  const hm = chunk.worldHeights('WORLD_SURFACE');
  if (!hm) return null;

  const readers = new Map<number, SectionReader | null>();
  const getReader = (secY: number): SectionReader | null => {
    if (readers.has(secY)) return readers.get(secY) ?? null;
    const s = byY.get(secY);
    const r = s ? buildReader(s, table) : null;
    readers.set(secY, r);
    return r;
  };

  const names: (string | null)[] = new Array(256).fill(null);
  const heights = new Int32Array(256).fill(EMPTY_HEIGHT);

  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const v = hm[x][z];
      if (v <= 0) continue; // empty / void column
      let wy = minY + v - 1; // world Y of the topmost non-air block
      if (wy > maxY) wy = maxY;
      const c = z * 16 + x;

      let ok = false;
      for (let steps = 0; wy >= minY && steps <= STEP_LIMIT; wy--, steps++) {
        const secY = Math.floor(wy / 16);
        const rdr = getReader(secY);
        if (!rdr) continue; // air / NONE-only / absent section
        const ly = wy - secY * 16;
        const idx = rdr.idxAt(x, ly, z);
        if (idx < 0) continue;
        if (rdr.palDrawable[idx]) {
          names[c] = rdr.palNames[idx];
          heights[c] = wy;
          ok = true;
          break;
        }
        // not drawable (air or NONE) -> keep stepping down
      }
      if (!ok) return null; // heightmap path unreliable here -> fall back to scan
    }
  }
  return { ox, oz, names, heights };
}

// ---------------------------------------------------------------------------
// Fallback path: top-down section scan (always correct, no heightmap needed)
// ---------------------------------------------------------------------------

function scanColumns(chunk: Chunk, table: ColorTable): ChunkColumns | null {
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

// ---------------------------------------------------------------------------
// Dispatcher: prefer the fast path, validate it once end-to-end, fall back
// to the scan whenever the fast path is unavailable or disagrees.
// ---------------------------------------------------------------------------

let fastVerified: boolean | null = null; // null = not yet checked (per worker)

function columnsEqual(a: ChunkColumns, b: ChunkColumns): boolean {
  for (let i = 0; i < 256; i++) {
    if (a.names[i] !== b.names[i] || a.heights[i] !== b.heights[i]) return false;
  }
  return true;
}

export function topColumns(chunk: Chunk, table: ColorTable): ChunkColumns | null {
  if (fastVerified === false) return scanColumns(chunk, table);

  const fast = fastColumns(chunk, table);
  if (fast === null) return scanColumns(chunk, table); // no/short heightmap, etc.
  if (fastVerified === true) return fast;

  // First usable fast result: prove it matches the scan before trusting it.
  const scan = scanColumns(chunk, table);
  fastVerified = scan !== null && columnsEqual(fast, scan);
  if (!fastVerified) {
    console.error('[chunkmap] heightmap fast-path disagreed with block scan; using scan from here on.');
    return scan ?? fast;
  }
  return fast;
}
