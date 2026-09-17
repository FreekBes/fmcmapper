import { describe, test, expect } from 'vitest';
import { loadColorTable, colorRGB, shadeRGB } from '../src/colors';

describe('shadeRGB — vanilla map shade multipliers', () => {
  test('shadeIndex 0/1/2 apply x180 / x220 / x255', () => {
    expect(shadeRGB(0xffffff, 0)).toEqual([180, 180, 180]);
    expect(shadeRGB(0xffffff, 1)).toEqual([220, 220, 220]);
    expect(shadeRGB(0xffffff, 2)).toEqual([255, 255, 255]);
  });

  test('an out-of-range shadeIndex falls back to the x220 mid shade', () => {
    expect(shadeRGB(0xffffff, 9)).toEqual([220, 220, 220]);
  });

  test('channels are extracted independently', () => {
    expect(shadeRGB(0x102030, 2)).toEqual([0x10, 0x20, 0x30]);
  });
});

describe('colorRGB — bundled map-colour table', () => {
  const table = loadColorTable();

  test('the table loads a non-trivial number of blocks', () => {
    expect(table.size).toBeGreaterThan(100);
  });

  test('a known block resolves to an in-range RGB triple', () => {
    const rgb = colorRGB(table, 'minecraft:stone', 1);
    expect(rgb).toHaveLength(3);
    for (const c of rgb) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
    }
  });

  test('an unknown / modded block gets a deterministic hashed fallback', () => {
    const a = colorRGB(table, 'modded:whatchamacallit', 1);
    const b = colorRGB(table, 'modded:whatchamacallit', 1);
    expect(a).toEqual(b);
    const c = colorRGB(table, 'modded:something_else', 1);
    expect(c).not.toEqual(a); // different id -> different colour (almost surely)
  });
});