// Pixel-affecting render settings, resolved from the MAP_* env vars with their
// defaults. Shared by the worker (which applies them) and buildtiles (which
// hashes them into the render signature), so changing a default here is picked
// up automatically — a changed signature forces a full redraw. Keep all the
// MAP_* defaults in this one place.

export type RenderConfig = {
  brightness: number;  // overall darkening (1 = none); per-type factors stack on top
  foliage: number;     // extra darkening for leaf blocks (dark texture x tint in-game)
  grass: number;       // extra darkening for grass
  grassFoliage: number; // ground plants (short/tall grass, fern): foliage colour, brighter than leaves
  dryFoliage: number;  // extra darkening for leaf litter (dry-foliage tint)
  water: number;       // extra darkening for water (on top of depth shading)
  blendR: number;      // biome tint blend radius (0 disables); box of (2r+1)^2 biomes
};

const num = (v: string | undefined, d: number): number => (v !== undefined ? Number(v) : d);

export function renderConfig(): RenderConfig {
  return {
    brightness: num(process.env.MAP_BRIGHTNESS, 1),
    foliage: num(process.env.MAP_FOLIAGE_BRIGHTNESS, 0.55),
    grass: num(process.env.MAP_GRASS_BRIGHTNESS, 0.8),
    grassFoliage: num(process.env.MAP_GRASS_FOLIAGE_BRIGHTNESS, 0.8),
    dryFoliage: num(process.env.MAP_DRY_FOLIAGE_BRIGHTNESS, 0.8),
    water: num(process.env.MAP_WATER_BRIGHTNESS, 0.7),
    blendR: Math.max(0, Math.min(8, Math.trunc(num(process.env.MAP_BIOME_BLEND, 2)))),
  };
}
