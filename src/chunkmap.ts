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
    // Unknown / modded block: deterministic colour, shaded by the same factors.
    const base = hashBase(name);
    const mul = FALLBACK_MUL[shadeIndex] ?? 220;
    const sh = (c: number) => Math.floor((c * mul) / 255) & 0xff;
    packed = (sh((base >> 16) & 0xff) << 16) | (sh((base >> 8) & 0xff) << 8) | sh(base & 0xff);
  }
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

// ---------------------------------------------------------------------------
// Top-block extraction
// ---------------------------------------------------------------------------

const isAir = (n: string) => n === '' || n.endsWith(':air') || n.endsWith('_air');

const childTag = (section: TagData[], name: string): TagData | undefined =>
  section.find(x => x.name === name);

// mc-anvil reads TAG_Byte as unsigned (getUint8), but section Y is signed and
// is negative for sections below y=0 (e.g. Y=-4 is stored as 0xFC = 252).
// Sign-extend so negative sections sort/position correctly.
const signedByte = (v: number): number => (v > 127 ? v - 256 : v);

const sectionY = (section: TagData[]): number => {
  const y = childTag(section, 'Y');
  return y ? signedByte(Number(y.data)) : 0;
};

// Handles legacy (BlockStates/Palette on the section) and modern
// (block_states.data / block_states.palette) chunk layouts.
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

export const EMPTY_HEIGHT = -2147483648;

export type ChunkColumns = {
  ox: number;
  oz: number;
  names: (string | null)[];   // [lz*16 + lx], topmost *drawable* block, or null
  heights: Int32Array;        // [lz*16 + lx], world Y of that block, or EMPTY_HEIGHT
};

/**
 * For each 16x16 column, the topmost block that vanilla would draw on a map
 * (skips air and mapColorId-0 blocks like glass), plus that block's Y.
 */
export function topColumns(chunk: Chunk, table: ColorTable): ChunkColumns | null {
  const coords = chunk.getCoordinates();
  if (!coords) return null;
  const [ox, oz] = coords;

  // Do NOT use chunk.sortedSections(): it sorts by the unsigned Y byte, which
  // mis-orders sub-zero sections. Order by the sign-corrected Y, top-down.
  const sectionTag = chunk.sections();
  if (!sectionTag) return null;
  const ordered = (sectionTag.data.data as TagData[][])
    .filter(s => childTag(s, 'Y') !== undefined)
    .map(s => ({ section: s, y: sectionY(s) }))
    .sort((a, b) => b.y - a.y); // highest section first

  const names: (string | null)[] = new Array(256).fill(null);
  const heights = new Int32Array(256).fill(EMPTY_HEIGHT);
  let resolved = 0;

  // A block is drawn unless it's air or its map color is NONE (id 0).
  const drawable = (nm: string): boolean => {
    if (isAir(nm)) return false;
    const e = table.get(nm);
    if (e && e.mapColorId === 0) return false;
    return true;
  };

  for (let si = 0; si < ordered.length && resolved < 256; si++) {
    const { section, y } = ordered[si];
    const { bs, pal } = sectionData(section);
    if (!pal) continue;
    const entries = pal.data.data as TagData[][];

    if (entries.length <= 1) {
      const nm = entries.length === 1 ? paletteEntryName(entries[0]) : '';
      if (drawable(nm)) {
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
    const blockNames = new BlockDataParser(bs, pal).getBlockTypeNames();
    for (let i = 0; i < 4096; i++) {
      const raw = blockNames[i];
      if (!raw) continue;
      const nm = raw.split('(')[0];
      if (!drawable(nm)) continue;
      const [lx, ly, lz] = chunkCoordinateFromIndex(i);
      const c = lz * 16 + lx;
      const absY = sy + ly;
      if (heights[c] === EMPTY_HEIGHT || absY > heights[c]) {
        if (names[c] === null) resolved++;
        names[c] = nm;
        heights[c] = absY;
      }
    }
  }
  return { ox, oz, names, heights };
};
