// ---------------------------------------------------------------------------
// Per-Minecraft-version vanilla data: how blocks are tinted, and the block/biome
// id renames needed to read older worlds. These are the tables a version bump
// most often touches (see CONTRIBUTING.md). They feed the render signature, so
// editing one here forces a redraw automatically — no version bump required.
// ---------------------------------------------------------------------------

// Always-submerged plants (no `waterlogged` property — they're implicitly in
// water). The water-depth scan treats these, plus any waterlogged block, as part
// of the water column — matching vanilla, which measures depth by fluid state.
// Without it the scan stops at e.g. a kelp stalk and reports deep ocean as
// shallow (speckled bright pixels).
export const SUBMERGED_PLANTS = new Set([
  'minecraft:kelp', 'minecraft:kelp_plant',
  'minecraft:seagrass', 'minecraft:tall_seagrass',
  'minecraft:bubble_column',
]);


// How a block is colored: by biome grass/foliage/dry-foliage/water tint, a fixed
// RGB (leaves with a constant color), or — if absent here — its plain map color.
export type Tint = 'grass' | 'foliage' | 'dry_foliage' | 'water' | number;

export const TINTS: Record<string, Tint> = {
  'minecraft:grass_block': 'grass',
  'minecraft:short_grass': 'grass',
  'minecraft:grass': 'grass', // legacy id (<1.20)
  'minecraft:tall_grass': 'grass',
  'minecraft:bush': 'grass',
  'minecraft:fern': 'grass',
  'minecraft:large_fern': 'grass',
  'minecraft:potted_fern': 'grass',
  'minecraft:sugar_cane': 'grass',
  'minecraft:oak_leaves': 'foliage',
  'minecraft:jungle_leaves': 'foliage',
  'minecraft:acacia_leaves': 'foliage',
  'minecraft:dark_oak_leaves': 'foliage',
  'minecraft:mangrove_leaves': 'foliage',
  'minecraft:vine': 'foliage',
  'minecraft:leaf_litter': 'dry_foliage',
  'minecraft:water': 'water',
  // Leaves with a fixed (non-biome) color:
  'minecraft:birch_leaves': 0x80a755,
  'minecraft:spruce_leaves': 0x619961,
  // Other leaves, such as azalea, cherry and pale oak don't get tinted at all
  // and feature the same color regardless of the biome.

  // Submerged plants are always tinted as water.
  ...Array.from(SUBMERGED_PLANTS).reduce((acc, id) => {
    acc[id] = 'water';
    return acc;
  }, {} as Record<string, Tint>),
};

// Blocks Mojang renamed *after* the 1.13 flattening. A world keeps whatever id it
// was saved with, so an older world can carry a now-defunct id that's missing
// from the (current-version) colour table — which would fall back to a hashed
// colour. Mapping them to today's id makes the colour table, TINTS, and water
// checks all resolve. (Pre-1.13 flattening renames don't matter: 1.13+ worlds
// already use the new ids.)
export const BLOCK_ALIASES: Record<string, string> = {
  'minecraft:grass': 'minecraft:short_grass',    // renamed in 1.20.3
  'minecraft:grass_path': 'minecraft:dirt_path', // renamed in 1.17
  'minecraft:sign': 'minecraft:oak_sign',        // wood types added in 1.14
  'minecraft:wall_sign': 'minecraft:oak_wall_sign',
};

// Biome ids Mojang renamed (or merged) after 1.13 — overwhelmingly the 1.18
// "Caves & Cliffs" overhaul. Like BLOCK_ALIASES, this maps a world's saved id to the
// current one so the biome's grass/foliage/water tint resolves from
// biome_colors.json instead of falling back to the no-biome DEFAULT_TINT.
// Merged sub-biomes (the old `_hills` / `_plateau` / `modified_` variants) point
// at the parent biome they were folded into — its tint is the right one to use.
export const BIOME_ALIASES: Record<string, string> = {
  // straight renames
  'minecraft:snowy_tundra': 'minecraft:snowy_plains',
  'minecraft:mountains': 'minecraft:windswept_hills',
  'minecraft:wooded_mountains': 'minecraft:windswept_forest',
  'minecraft:gravelly_mountains': 'minecraft:windswept_gravelly_hills',
  'minecraft:shattered_savanna': 'minecraft:windswept_savanna',
  'minecraft:jungle_edge': 'minecraft:sparse_jungle',
  'minecraft:giant_tree_taiga': 'minecraft:old_growth_pine_taiga',
  'minecraft:giant_spruce_taiga': 'minecraft:old_growth_spruce_taiga',
  'minecraft:tall_birch_forest': 'minecraft:old_growth_birch_forest',
  'minecraft:wooded_badlands_plateau': 'minecraft:wooded_badlands',
  'minecraft:stone_shore': 'minecraft:stony_shore',
  // merged sub-biomes -> parent (share the parent's tint)
  'minecraft:mountain_edge': 'minecraft:windswept_hills',
  'minecraft:snowy_mountains': 'minecraft:snowy_plains',
  'minecraft:modified_gravelly_mountains': 'minecraft:windswept_gravelly_hills',
  'minecraft:shattered_savanna_plateau': 'minecraft:windswept_savanna',
  'minecraft:modified_jungle': 'minecraft:jungle',
  'minecraft:modified_jungle_edge': 'minecraft:sparse_jungle',
  'minecraft:tall_birch_hills': 'minecraft:old_growth_birch_forest',
  'minecraft:giant_tree_taiga_hills': 'minecraft:old_growth_pine_taiga',
  'minecraft:giant_spruce_taiga_hills': 'minecraft:old_growth_spruce_taiga',
  'minecraft:badlands_plateau': 'minecraft:badlands',
  'minecraft:modified_badlands_plateau': 'minecraft:badlands',
  'minecraft:modified_wooded_badlands_plateau': 'minecraft:wooded_badlands',
  'minecraft:desert_hills': 'minecraft:desert',
  'minecraft:desert_lakes': 'minecraft:desert',
  'minecraft:wooded_hills': 'minecraft:forest',
  'minecraft:taiga_hills': 'minecraft:taiga',
  'minecraft:taiga_mountains': 'minecraft:taiga',
  'minecraft:snowy_taiga_hills': 'minecraft:snowy_taiga',
  'minecraft:snowy_taiga_mountains': 'minecraft:snowy_taiga',
  'minecraft:birch_forest_hills': 'minecraft:birch_forest',
  'minecraft:jungle_hills': 'minecraft:jungle',
  'minecraft:bamboo_jungle_hills': 'minecraft:bamboo_jungle',
  'minecraft:dark_forest_hills': 'minecraft:dark_forest',
  'minecraft:swamp_hills': 'minecraft:swamp',
  'minecraft:mushroom_field_shore': 'minecraft:mushroom_fields',
};
// Numeric biome ids -> namespaced name, for pre-1.18 worlds. Before the 1.18
// paletted per-section `biomes` container, biomes were a chunk-level numeric
// `Biomes` array keyed by these registry ids. Only 1.16-1.17 worlds actually
// reach this (older block packing doesn't decode), and their registry matches
// the table below. The names are the period-correct (1.16) ids; BIOME_ALIASES
// then normalises the renamed ones to today's names for the colour lookup.
export const LEGACY_BIOME_IDS: Record<number, string> = {
  0: 'minecraft:ocean',
  1: 'minecraft:plains',
  2: 'minecraft:desert',
  3: 'minecraft:mountains',
  4: 'minecraft:forest',
  5: 'minecraft:taiga',
  6: 'minecraft:swamp',
  7: 'minecraft:river',
  8: 'minecraft:nether_wastes',
  9: 'minecraft:the_end',
  10: 'minecraft:frozen_ocean',
  11: 'minecraft:frozen_river',
  12: 'minecraft:snowy_tundra',
  13: 'minecraft:snowy_mountains',
  14: 'minecraft:mushroom_fields',
  15: 'minecraft:mushroom_field_shore',
  16: 'minecraft:beach',
  17: 'minecraft:desert_hills',
  18: 'minecraft:wooded_hills',
  19: 'minecraft:taiga_hills',
  20: 'minecraft:mountain_edge',
  21: 'minecraft:jungle',
  22: 'minecraft:jungle_hills',
  23: 'minecraft:jungle_edge',
  24: 'minecraft:deep_ocean',
  25: 'minecraft:stone_shore',
  26: 'minecraft:snowy_beach',
  27: 'minecraft:birch_forest',
  28: 'minecraft:birch_forest_hills',
  29: 'minecraft:dark_forest',
  30: 'minecraft:snowy_taiga',
  31: 'minecraft:snowy_taiga_hills',
  32: 'minecraft:giant_tree_taiga',
  33: 'minecraft:giant_tree_taiga_hills',
  34: 'minecraft:wooded_mountains',
  35: 'minecraft:savanna',
  36: 'minecraft:savanna_plateau',
  37: 'minecraft:badlands',
  38: 'minecraft:wooded_badlands_plateau',
  39: 'minecraft:badlands_plateau',
  40: 'minecraft:small_end_islands',
  41: 'minecraft:end_midlands',
  42: 'minecraft:end_highlands',
  43: 'minecraft:end_barrens',
  44: 'minecraft:warm_ocean',
  45: 'minecraft:lukewarm_ocean',
  46: 'minecraft:cold_ocean',
  47: 'minecraft:deep_warm_ocean',
  48: 'minecraft:deep_lukewarm_ocean',
  49: 'minecraft:deep_cold_ocean',
  50: 'minecraft:deep_frozen_ocean',
  127: 'minecraft:the_void',
  129: 'minecraft:sunflower_plains',
  130: 'minecraft:desert_lakes',
  131: 'minecraft:gravelly_mountains',
  132: 'minecraft:flower_forest',
  133: 'minecraft:taiga_mountains',
  134: 'minecraft:swamp_hills',
  140: 'minecraft:ice_spikes',
  149: 'minecraft:modified_jungle',
  151: 'minecraft:modified_jungle_edge',
  155: 'minecraft:tall_birch_forest',
  156: 'minecraft:tall_birch_hills',
  157: 'minecraft:dark_forest_hills',
  158: 'minecraft:snowy_taiga_mountains',
  160: 'minecraft:giant_spruce_taiga',
  161: 'minecraft:giant_spruce_taiga_hills',
  162: 'minecraft:modified_gravelly_mountains',
  163: 'minecraft:shattered_savanna',
  164: 'minecraft:shattered_savanna_plateau',
  165: 'minecraft:eroded_badlands',
  166: 'minecraft:modified_wooded_badlands_plateau',
  167: 'minecraft:modified_badlands_plateau',
  168: 'minecraft:bamboo_jungle',
  169: 'minecraft:bamboo_jungle_hills',
  170: 'minecraft:soul_sand_valley',
  171: 'minecraft:crimson_forest',
  172: 'minecraft:warped_forest',
  173: 'minecraft:basalt_deltas',
};
