import { describe, test, expect } from 'vitest';
import { TINTS, BLOCK_ALIASES, BIOME_ALIASES, SUBMERGED_PLANTS, TARGET_VERSION, TARGET_DATA_VERSION, LEGACY_BIOME_IDS } from '../src/gamedata';

describe('gamedata constants', () => {
  test('TINTS is a non-empty object', () => {
    expect(typeof TINTS).toBe('object');
    expect(Object.keys(TINTS).length).toBeGreaterThan(0);
  });

  test('BLOCK_ALIASES is a non-empty object', () => {
    expect(typeof BLOCK_ALIASES).toBe('object');
    expect(Object.keys(BLOCK_ALIASES).length).toBeGreaterThan(0);
  });

  test('BIOME_ALIASES is a non-empty object', () => {
    expect(typeof BIOME_ALIASES).toBe('object');
    expect(Object.keys(BIOME_ALIASES).length).toBeGreaterThan(0);
  });

  test('SUBMERGED_PLANTS is a non-empty Set', () => {
    expect(SUBMERGED_PLANTS instanceof Set).toBe(true);
    expect(SUBMERGED_PLANTS.size).toBeGreaterThan(0);
  });

  test('TARGET_VERSION is a non-empty string', () => {
    expect(typeof TARGET_VERSION).toBe('string');
    expect(TARGET_VERSION.length).toBeGreaterThan(0);
  });

  test('TARGET_DATA_VERSION is a positive number', () => {
    expect(typeof TARGET_DATA_VERSION).toBe('number');
    expect(TARGET_DATA_VERSION).toBeGreaterThan(0);
  });

  test('LEGACY_BIOME_IDS is a non-empty object', () => {
    expect(typeof LEGACY_BIOME_IDS).toBe('object');
    expect(Object.keys(LEGACY_BIOME_IDS).length).toBeGreaterThan(0);
  });
});

describe('gamedata lookup tables', () => {
  test('TINTS maps a known biome-tinted block to its tint kind', () => {
    expect(TINTS['minecraft:grass_block']).toBe('grass');
  });

  test('block aliases resolve in a single step (no chains)', () => {
    // paletteEntryName applies aliases exactly once, so an alias
    // target must not itself be an alias key — otherwise the mapping is incomplete.
    for (const to of Object.values(BLOCK_ALIASES)) {
      expect(BLOCK_ALIASES[to] ?? to).toBe(to);
    }
  });

  test('biome aliases resolve in a single step (no chains)', () => {
    // tthe biome reader applies aliases exactly once, so an alias
    // target must not itself be an alias key — otherwise the mapping is incomplete.
    for (const to of Object.values(BIOME_ALIASES)) {
      expect(BIOME_ALIASES[to] ?? to).toBe(to);
    }
  });

  test('LEGACY_BIOME_IDS maps a known legacy biome id to its current name', () => {
    expect(LEGACY_BIOME_IDS[22]).toBe('minecraft:jungle_hills');
  });

  test('SUBMERGED_PLANTS is a set of namespaced ids', () => {
    expect(SUBMERGED_PLANTS).toBeInstanceOf(Set);
    for (const id of SUBMERGED_PLANTS) expect(id).toMatch(/^[a-z0-9_]+:[a-z0-9_]+$/);
  });
});
