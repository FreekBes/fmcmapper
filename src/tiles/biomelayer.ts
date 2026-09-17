// The biome vector layer. Biomes are fixed at world-gen, so a region's polygons
// only need (re)drawing when that region itself (re)renders. To keep the viewer's
// request count down, regions are grouped into BIOME_SUPER x BIOME_SUPER
// "super-tiles", one GeoJSON file each. Every feature is tagged with its region id,
// so when a single region re-renders we drop just that region's features from the
// super-tile and re-add the new ones — no separate cache, no global re-merge.

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { buildBiomeGeoJSON, BIOME_NONE, type GeoJSON } from './biomevector';
import type { BiomeCells } from './worker';
import { TILE, BIOME_SUPER, BIOME_TOL_CELLS } from './constants';

export type BiomeFeature = GeoJSON['features'][number];

export const superId = (tx: number, ty: number): string =>
  `${Math.floor(tx / BIOME_SUPER)}_${Math.floor(ty / BIOME_SUPER)}`;

// Polygonize one region's cells into features (global CRS.Simple coords), each
// tagged with its region id so it can be replaced independently later.
export function regionFeatures(
  cells: BiomeCells, rx: number, rz: number, rid: string,
  minX: number, minZ: number, maxZoom: number,
): BiomeFeature[] {
  const size = TILE / cells.res; // square grid side, e.g. 512/4 = 128
  const grid = new Uint16Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = cells.data[i] === 255 ? BIOME_NONE : cells.data[i];
  const gj = buildBiomeGeoJSON(
    { grid, width: size, height: size, res: cells.res, minBlockX: rx * TILE, minBlockZ: rz * TILE, palette: cells.palette },
    minX, minZ, maxZoom, BIOME_TOL_CELLS,
  );
  for (const f of gj.features) (f.properties as { r?: string }).r = rid;
  return gj.features;
}

// Apply this run's per-region changes to the affected super-tile files: drop the
// changed regions' old features, add their new ones (null = region went away).
export function updateSuperTiles(dir: string, changes: Map<string, Map<string, BiomeFeature[] | null>>): void {
  for (const [sid, regionMap] of changes) {
    const p = join(dir, `${sid}.geojson`);
    let features: BiomeFeature[] = [];
    if (existsSync(p)) {
      try { features = (JSON.parse(readFileSync(p, 'utf8')) as GeoJSON).features; } catch { /* redraw */ }
    }
    // Drop features of the regions being replaced/removed, keep the rest.
    features = features.filter(f => !regionMap.has((f.properties as { r?: string }).r ?? ''));
    for (const feats of regionMap.values()) if (feats) features.push(...feats);
    if (features.length) writeFileSync(p, JSON.stringify({ type: 'FeatureCollection', features }));
    else { try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ } }
  }
}

// List the super-tile GeoJSON files present so the viewer knows what to fetch.
export function writeBiomeIndex(dir: string): void {
  const ids: string[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^(-?\d+_-?\d+)\.geojson$/.exec(f);
    if (m) ids.push(m[1]);
  }
  writeFileSync(join(dir, 'index.json'), JSON.stringify(ids));
}
