import { describe, test, expect } from 'vitest';
import type { TagData } from 'mc-anvil';
import { paletteEntryName, packedExtractor, paletteBits, type PaletteEntry } from '../src/chunk/sections';

// Minimal NBT tag literal — paletteEntryName only reads .name and .data.
const tag = (name: string, data: unknown, type = 8): TagData => ({ name, data, type } as unknown as TagData);

describe('paletteEntryName — every block-palette shape across versions', () => {
  test('26.3 string-palette entry is the id itself', () => {
    expect(paletteEntryName('minecraft:stone')).toBe('minecraft:stone');
  });

  test('pre-26.3 compound {Name, Properties}', () => {
    const entry: PaletteEntry = [tag('Name', 'minecraft:oak_stairs'), tag('Properties', [], 10)];
    expect(paletteEntryName(entry)).toBe('minecraft:oak_stairs');
  });

  test('26.3 compound {id, properties} (fields renamed)', () => {
    const entry: PaletteEntry = [tag('id', 'minecraft:oak_stairs'), tag('properties', [], 10)];
    expect(paletteEntryName(entry)).toBe('minecraft:oak_stairs');
  });

  // The bug that made the whole map render as stone: a default-state block kept
  // inside a compound section is stored "compact", which mc-anvil surfaces as a
  // string tag with an empty tag name. A Name/id lookup misses it.
  test('26.3 compact compound: empty-named id string', () => {
    const entry: PaletteEntry = [tag('', 'minecraft:deepslate'), tag('', null, 0)];
    expect(paletteEntryName(entry)).toBe('minecraft:deepslate');
  });

  test('property values never masquerade as the id', () => {
    // Properties/properties is a compound (data is an array, not a string), so the
    // first *string-valued* child is always the id, never a property value.
    const entry: PaletteEntry = [tag('properties', [tag('half', 'top')], 10), tag('id', 'minecraft:oak_slab')];
    expect(paletteEntryName(entry)).toBe('minecraft:oak_slab');
  });

  // BLOCK_ALIASES lets an older world's now-defunct id still resolve to a colour
  // instead of a hashed fallback. Each rename should map through paletteEntryName.
  test.each([
    ['minecraft:grass', 'minecraft:short_grass'],      // renamed 1.20.3
    ['minecraft:grass_path', 'minecraft:dirt_path'],   // renamed 1.17
    ['minecraft:sign', 'minecraft:oak_sign'],          // wood types added 1.14
  ])('applies BLOCK_ALIASES: %s -> %s', (from, to) => {
    expect(paletteEntryName(from)).toBe(to);
    // aliases also apply when the id arrives as a compound palette entry
    expect(paletteEntryName([tag('id', from)])).toBe(to);
  });
});

describe('packedExtractor — padded LongArray bit unpacking', () => {
  test('decodes 4-bit values packed low-to-high within a big-endian long', () => {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setBigUint64(0, 5n | (10n << 4n) | (3n << 8n), false); // big-endian long
    const read = packedExtractor(dv.buffer, 4);
    expect(read(0)).toBe(5);
    expect(read(1)).toBe(10);
    expect(read(2)).toBe(3);
    expect(read(3)).toBe(0); // remaining slots are zero
  });

  test('values do not span longs — 16 per long at 4 bits', () => {
    // Two longs: value 15 lives at index 16 (first slot of the 2nd long).
    const dv = new DataView(new ArrayBuffer(16));
    dv.setBigUint64(8, 15n, false);
    const read = packedExtractor(dv.buffer, 4);
    expect(read(15)).toBe(0); // last slot of long 0
    expect(read(16)).toBe(15); // first slot of long 1
  });

  test('returns -1 past the end of the data', () => {
    const read = packedExtractor(new ArrayBuffer(8), 4); // one long => 16 values
    expect(read(16)).toBe(-1);
  });
});

describe('paletteBits — bits needed to index an n-entry palette', () => {
  test('is ceil(log2(n)), with exact powers of two handled', () => {
    expect(paletteBits(1)).toBe(1);
    expect(paletteBits(2)).toBe(1);
    expect(paletteBits(3)).toBe(2);
    expect(paletteBits(4)).toBe(2);
    expect(paletteBits(5)).toBe(3);
    expect(paletteBits(16)).toBe(4);
    expect(paletteBits(17)).toBe(5);
  });
});
