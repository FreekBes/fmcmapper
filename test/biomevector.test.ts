import { describe, test, expect } from 'vitest';
import { buildBiomeGeoJSON, BIOME_NONE, type BiomeField, type GeoJSON } from '../src/tiles/biomevector';

// Build a BiomeField from a row-major id grid (BIOME_NONE marks an empty cell).
const field = (rows: number[][], palette: string[], over: Partial<BiomeField> = {}): BiomeField => {
  const height = rows.length;
  const width = rows[0].length;
  const grid = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) grid[y * width + x] = rows[y][x];
  return { grid, width, height, res: 4, minBlockX: 0, minBlockZ: 0, palette, ...over };
};

const coordBBox = (gj: GeoJSON) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of gj.features)
    for (const poly of f.geometry.coordinates)
      for (const ring of poly)
        for (const [x, y] of ring) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
  // + 0 normalises -0 (from negating the z=origin edge) to +0 so toEqual matches.
  return { x0: x0 + 0, y0: y0 + 0, x1: x1 + 0, y1: y1 + 0 };
};

const N = BIOME_NONE;

describe('buildBiomeGeoJSON — biome cells -> CRS.Simple polygons', () => {
  test('a uniform region becomes one MultiPolygon feature tagged with its biome', () => {
    // 2x2 cells of id 0 = plains, 4 blocks/cell -> covers world blocks 0..8.
    const gj = buildBiomeGeoJSON(field([[0, 0], [0, 0]], ['minecraft:plains']), 0, 0, 0, 0);
    expect(gj.type).toBe('FeatureCollection');
    expect(gj.features).toHaveLength(1);
    expect(gj.features[0].properties.biome).toBe('minecraft:plains');
    expect(gj.features[0].geometry.type).toBe('MultiPolygon');
    // maxZoom 0 -> scale 1; z axis is negated. Extent = blocks 0..8.
    expect(coordBBox(gj)).toEqual({ x0: 0, y0: -8, x1: 8, y1: 0 });
  });

  test('distinct biomes become distinct features, each with the right id', () => {
    // left column plains (0), right column desert (1).
    const gj = buildBiomeGeoJSON(field([[0, 1], [0, 1]], ['minecraft:plains', 'minecraft:desert']), 0, 0, 0, 0);
    expect(gj.features).toHaveLength(2);
    expect(new Set(gj.features.map(f => f.properties.biome)))
      .toEqual(new Set(['minecraft:plains', 'minecraft:desert']));
  });

  test('empty (BIOME_NONE) cells produce no geometry', () => {
    expect(buildBiomeGeoJSON(field([[N, N], [N, N]], ['minecraft:plains']), 0, 0, 0, 0).features).toHaveLength(0);
  });

  test('all coordinates are finite numbers', () => {
    const gj = buildBiomeGeoJSON(field([[0, 1], [1, 0]], ['minecraft:plains', 'minecraft:desert']), 0, 0, 0, 0);
    for (const f of gj.features)
      for (const poly of f.geometry.coordinates)
        for (const ring of poly)
          for (const c of ring) {
            expect(c).toHaveLength(2);
            expect(Number.isFinite(c[0]) && Number.isFinite(c[1])).toBe(true);
          }
  });

  test('applies res, world offset, viewer origin and zoom scale to coordinates', () => {
    // 1 cell, 4 blocks wide, placed at world (16,32); viewer origin (0,0), zoom 1 (scale 2).
    // x: (16..20 - 0) / 2 = 8..10 ; z: -(32..36 - 0) / 2 = -16..-18.
    const gj = buildBiomeGeoJSON(
      field([[0]], ['minecraft:plains'], { minBlockX: 16, minBlockZ: 32 }),
      0, 0, /* maxZoom */ 1, 0,
    );
    expect(coordBBox(gj)).toEqual({ x0: 8, y0: -18, x1: 10, y1: -16 });
  });
});
