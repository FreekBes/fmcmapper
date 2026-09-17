import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { loadColorTable, loadBiomeColors } from '../src/colors';

// Structural validation of the bundled colour tables (regenerated per Minecraft
// version by the map-color-dump mod). A malformed or wrong-shaped file would
// otherwise only surface as garbled tiles at render time — these fail loudly, and
// also confirm the loaders in src/colors.ts accept the real assets.

const assetPath = (name: string): string => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
const readAsset = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(assetPath(name), 'utf8')) as Record<string, unknown>;

const ID_RE = /^[a-z0-9_.-]+:[a-z0-9_/.-]+$/; // namespaced id, e.g. minecraft:stone
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const RGB_MAX = 0xffffff;
const isRGB = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= RGB_MAX;
const hexToInt = (hex: string): number => parseInt(hex.slice(1), 16);

describe('assets/map_colors.json', () => {
  const raw = readAsset('map_colors.json');
  const entries = Object.entries(raw) as [string, {
    mapColorId: number; baseRGB: number; baseHex: string; shades: number[];
  }][];

  test('is a non-empty object keyed by namespaced block ids', () => {
    expect(entries.length).toBeGreaterThan(500);
    expect(Object.keys(raw).filter(id => !ID_RE.test(id))).toEqual([]);
  });

  test('every entry is a valid { mapColorId, baseRGB, baseHex, shades[4] }', () => {
    const bad: string[] = [];
    for (const [id, v] of entries) {
      if (!(Number.isInteger(v.mapColorId) && v.mapColorId >= 0)) bad.push(`${id}: mapColorId`);
      if (!isRGB(v.baseRGB)) bad.push(`${id}: baseRGB`);
      if (typeof v.baseHex !== 'string' || !HEX_RE.test(v.baseHex)) bad.push(`${id}: baseHex`);
      if (!Array.isArray(v.shades) || v.shades.length !== 4) bad.push(`${id}: shades length`);
      else if (!v.shades.every(isRGB)) bad.push(`${id}: shades value`);
    }
    expect(bad).toEqual([]);
  });

  test('baseHex is the hex form of baseRGB', () => {
    expect(entries.filter(([, v]) => hexToInt(v.baseHex) !== v.baseRGB).map(([id]) => id)).toEqual([]);
  });

  test('includes core blocks', () => {
    for (const id of ['minecraft:stone', 'minecraft:water', 'minecraft:grass_block']) expect(raw[id]).toBeDefined();
  });

  test('loadColorTable parses it into shaded entries', () => {
    const table = loadColorTable(assetPath('map_colors.json'));
    expect(table.size).toBe(entries.length);
    const stone = table.get('minecraft:stone');
    expect(stone?.shades).toHaveLength(4);
    expect(Number.isInteger(stone?.mapColorId)).toBe(true);
  });
});

describe('assets/biome_colors.json', () => {
  const raw = readAsset('biome_colors.json');
  const KINDS = ['grass', 'foliage', 'dryFoliage', 'water'] as const;
  const entries = Object.entries(raw) as [string, Record<typeof KINDS[number], { RGB: number; hex: string }>][];

  test('is a non-empty object keyed by namespaced biome ids', () => {
    expect(entries.length).toBeGreaterThan(20);
    expect(Object.keys(raw).filter(id => !ID_RE.test(id))).toEqual([]);
  });

  test('every entry has grass/foliage/dryFoliage/water = { RGB, hex } with hex == RGB', () => {
    const bad: string[] = [];
    for (const [id, v] of entries) {
      for (const k of KINDS) {
        const c = v[k];
        if (!c || typeof c !== 'object') { bad.push(`${id}.${k}: missing`); continue; }
        if (!isRGB(c.RGB)) bad.push(`${id}.${k}.RGB`);
        if (typeof c.hex !== 'string' || !HEX_RE.test(c.hex)) bad.push(`${id}.${k}.hex`);
        else if (hexToInt(c.hex) !== c.RGB) bad.push(`${id}.${k}: hex != RGB`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('includes core biomes', () => {
    for (const id of ['minecraft:plains', 'minecraft:forest', 'minecraft:ocean']) expect(raw[id]).toBeDefined();
  });

  test('loadBiomeColors parses it into per-kind RGB numbers', () => {
    const colors = loadBiomeColors(assetPath('biome_colors.json'));
    expect(colors.size).toBe(entries.length);
    const plains = colors.get('minecraft:plains');
    expect(plains).toBeDefined();
    for (const k of KINDS) expect(typeof plains?.[k]).toBe('number');
  });
});
