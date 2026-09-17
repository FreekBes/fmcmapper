// Shared tiling constants.

export const TILE = 512; // Leaflet tileSize; one base tile == one region (512 blocks)

// Per-region biome sampling: the worker records one biome per BIOME_RES-block cell
// (Minecraft's native 4-block biome cell), giving a BIOME_CELLS x BIOME_CELLS grid.
export const BIOME_RES = 4;
export const BIOME_CELLS = TILE / BIOME_RES; // 128 biome cells per region side

// Biome vector layer: regions are grouped into BIOME_SUPER x BIOME_SUPER
// "super-tiles" (one GeoJSON file each) to cut the viewer's request count.
export const BIOMES_DIR = 'biomes'; // super-tile biome GeoJSON, served to the viewer
export const BIOME_SUPER = 5; // regions per super-tile side (5x5 = 25 regions/file)
export const BIOME_TOL_CELLS = 2; // "medium" simplification (tolerance in cells, ~8 blocks)
