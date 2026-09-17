import { describe, test, expect, afterEach } from 'vitest';
import { renderConfig } from '../src/renderconfig';

// Every MAP_* env var renderConfig reads, so the "clear all" between tests is total.
const MAP_VARS = [
  'MAP_BRIGHTNESS', 'MAP_FOLIAGE_BRIGHTNESS', 'MAP_GRASS_BRIGHTNESS',
  'MAP_GRASS_FOLIAGE_BRIGHTNESS', 'MAP_DRY_FOLIAGE_BRIGHTNESS', 'MAP_WATER_BRIGHTNESS',
  'MAP_BIOME_BLEND',
];

describe('renderConfig — MAP_* env resolution', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  const clear = () => { for (const v of MAP_VARS) delete process.env[v]; };

  test('falls back to the documented defaults when nothing is set', () => {
    clear();
    expect(renderConfig()).toEqual({
      brightness: 1,
      foliage: 0.55,
      grass: 0.8,
      grassFoliage: 0.8,
      dryFoliage: 0.8,
      water: 0.7,
      blendR: 2,
    });
  });

  test('reads overrides from the environment', () => {
    clear();
    process.env.MAP_BRIGHTNESS = '0.9';
    process.env.MAP_WATER_BRIGHTNESS = '0.5';
    const cfg = renderConfig();
    expect(cfg.brightness).toBe(0.9);
    expect(cfg.water).toBe(0.5);
    expect(cfg.grass).toBe(0.8); // untouched -> default
  });

  test('blendR is truncated to an int and clamped to 0..8', () => {
    clear();
    process.env.MAP_BIOME_BLEND = '3.9';
    expect(renderConfig().blendR).toBe(3);   // truncated
    process.env.MAP_BIOME_BLEND = '100';
    expect(renderConfig().blendR).toBe(8);   // clamped high
    process.env.MAP_BIOME_BLEND = '-5';
    expect(renderConfig().blendR).toBe(0);   // clamped low
    process.env.MAP_BIOME_BLEND = '0';
    expect(renderConfig().blendR).toBe(0);   // disables the blur
  });
});
