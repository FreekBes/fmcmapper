// Colour lookup: the vanilla map-colour palette (per block) and the per-biome
// grass/foliage/water tints, both loaded from the map-color-dump mod's JSON, plus
// the shading maths that turns a base colour into one of the map's three shades.

import { readFileSync } from 'fs';
import { resolve } from 'path';

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
