import { describe, test, expect } from 'vitest';
import type { BiomeColor, BiomeColors } from '../src/colors';
import { tintField, blur, biomeCells, readLong, PICK, type Field, type Scratch } from '../src/tiles/tint';

const pack = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b;
const scratch = (n: number): Scratch => ({
  hr: new Int16Array(n), hg: new Int16Array(n), hb: new Int16Array(n), hc: new Uint8Array(n),
});
const field = (vals: number[]): Field => Int32Array.from(vals);

describe('tintField — biome grid -> packed tint colours', () => {
  const colors: BiomeColors = new Map<string, BiomeColor>([
    ['minecraft:plains', { grass: 0x91bd59, foliage: 0x48b518, dryFoliage: 0x96a053, water: -1 }],
  ]);

  test('packs the picked colour for known biomes, -1 for holes/unknowns', () => {
    const grid = ['minecraft:plains', null, 'minecraft:unknown', 'minecraft:plains'];
    expect([...tintField(grid, 2, PICK.grass, colors)]).toEqual([0x91bd59, -1, -1, 0x91bd59]);
  });

  test('a picked colour of -1 (biome lacks that tint) yields no sample', () => {
    // plains has no water tint (-1) here, so every cell is a hole.
    expect([...tintField(['minecraft:plains', 'minecraft:plains'], 1, PICK.water, colors)]).toEqual([-1]);
  });
});

describe('blur — box blur that averages only valid cells', () => {
  test('rad 0 is an identity (valid cells unchanged, holes preserved)', () => {
    const f = field([pack(1, 2, 3), -1, pack(7, 8, 9), pack(10, 11, 12)]);
    expect([...blur(f, 2, 0, scratch(4))]).toEqual([...f]);
  });

  test('a uniform field stays uniform', () => {
    const f = field(new Array(9).fill(pack(128, 64, 32)));
    expect([...blur(f, 3, 1, scratch(9))].every(v => v === pack(128, 64, 32))).toBe(true);
  });

  test('averages across the window (one bright cell spread over 9)', () => {
    // 3x3: one cell (9,9,9), rest black; rad 2 -> every cell sees all 9 -> avg 1.
    const f = field([pack(9, 9, 9), 0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...blur(f, 3, 2, scratch(9))].every(v => v === pack(1, 1, 1))).toBe(true);
  });

  test('holes are excluded from the average, not counted as black', () => {
    // only two valid cells (10 and 20); rad 2 -> every cell averages just those -> 15.
    const f = field([pack(10, 10, 10), pack(20, 20, 20), -1, -1, -1, -1, -1, -1, -1]);
    expect([...blur(f, 3, 2, scratch(9))].every(v => v === pack(15, 15, 15))).toBe(true);
  });

  test('a fully empty window stays -1', () => {
    expect([...blur(field([-1, -1, -1, -1]), 2, 1, scratch(4))]).toEqual([-1, -1, -1, -1]);
  });
});

describe('biomeCells — downsample the haloed biome grid to palette-indexed cells', () => {
  test('builds a compact local palette, 255 for empty cells', () => {
    // 2x2 grid, res 1, no halo (h 0, ew 2).
    const eb = ['minecraft:plains', 'minecraft:desert', 'minecraft:plains', null];
    expect(biomeCells(eb, 2, 0, 1, 2)).toEqual({
      res: 1,
      palette: ['minecraft:plains', 'minecraft:desert'],
      data: [0, 1, 0, 255], // plains, desert, plains, (none)
    });
  });

  test('reads through the halo offset h with stride ew', () => {
    // 3x3 grid with a 1-cell halo; the single centre cell is at index (0+1)*3 + (0+1) = 4.
    const eb: (string | null)[] = new Array(9).fill(null);
    eb[4] = 'minecraft:forest';
    expect(biomeCells(eb, 3, 1, 1, 1)).toEqual({ res: 1, palette: ['minecraft:forest'], data: [0] });
  });
});

describe('readLong — undo mc-anvil reading a big-endian TAG_Long as little-endian', () => {
  const byteswap = (n: number): bigint => {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(n)); // how the value is really stored (BE)...
    return b.readBigInt64LE(0);   // ...but mc-anvil hands it back read as LE
  };

  test('leaves a plausible tick count untouched', () => {
    expect(readLong(12345)).toBe(12345);
    expect(readLong(12345n)).toBe(12345);
    expect(readLong(0)).toBe(0);
  });

  test('swaps back an implausible (byte-swapped) value', () => {
    expect(readLong(byteswap(12345))).toBe(12345);
    expect(readLong(byteswap(4903))).toBe(4903); // a real-world DataVersion-scale count
  });
});
