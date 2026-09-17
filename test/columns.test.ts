import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { AnvilParser } from 'mc-anvil';
import { loadColorTable } from '../src/colors';
import { topColumns, iterChunks, type ChunkColumns } from '../src/chunk/columns';

// Golden per-column expectations, hand-picked from the real fixtures and verified
// against an independent block-column decoder (a fresh reader that agreed with
// topColumns on every one of ~19k columns across all fixtures). They pin the two
// derived-per-column outputs — the topmost drawable block (name + world height)
// and the water depth — plus the sampled biome, across the format eras and across
// the cases the depth/surface logic implies: shallow vs deep water, submerged
// plants counted *through* the water column, a submerged plant that is itself the
// surface, leaves, ice, and ordinary land.
type Golden = {
  chunk: [number, number]; // chunk origin as mc-anvil getCoordinates() reports it
  col: [number, number];   // local (lx, lz) within the chunk
  name: string;            // topmost drawable block
  height: number;          // its world Y
  biome: string;
  depth: number;           // water depth (0 = not water)
  note: string;
};

const FIXTURES: Record<string, Golden[]> = {
  'overworld_1_16.mca': [
    { chunk: [528, -2048], col: [14, 0], name: 'minecraft:grass_block', height: 176, biome: 'minecraft:taiga', depth: 0, note: 'grass surface' },
    { chunk: [528, -2048], col: [14, 2], name: 'minecraft:stone', height: 174, biome: 'minecraft:taiga', depth: 0, note: 'exposed stone' },
    { chunk: [528, -2048], col: [12, 4], name: 'minecraft:water', height: 173, biome: 'minecraft:taiga', depth: 1, note: 'shallow water (depth 1)' },
    { chunk: [576, -2048], col: [8, 2], name: 'minecraft:spruce_leaves', height: 190, biome: 'minecraft:taiga', depth: 0, note: 'tree leaves (fixed-tint foliage)' },
    { chunk: [832, -2048], col: [8, 2], name: 'minecraft:snow', height: 104, biome: 'minecraft:taiga', depth: 0, note: 'snow layer' },
    { chunk: [832, -2048], col: [12, 2], name: 'minecraft:packed_ice', height: 104, biome: 'minecraft:taiga', depth: 0, note: 'packed ice' },
    { chunk: [832, -2048], col: [14, 3], name: 'minecraft:ice', height: 107, biome: 'minecraft:taiga', depth: 0, note: 'ice (translucent)' },
  ],
  'overworld_1_18.mca': [
    { chunk: [1520, 0], col: [12, 12], name: 'minecraft:water', height: 62, biome: 'minecraft:ocean', depth: 12, note: 'deep ocean (depth 12)' },
    { chunk: [1392, 0], col: [0, 2], name: 'minecraft:grass_block', height: 68, biome: 'minecraft:forest', depth: 0, note: 'grass surface' },
    { chunk: [1440, 0], col: [7, 14], name: 'minecraft:sand', height: 62, biome: 'minecraft:forest', depth: 0, note: 'beach sand' },
  ],
  'overworld_26_1.mca': [
    { chunk: [-224, 4208], col: [12, 14], name: 'minecraft:water', height: 62, biome: 'minecraft:cold_ocean', depth: 9, note: 'depth counts through waterlogged ruins (stone_brick_stairs)' },
    { chunk: [-224, 4208], col: [15, 14], name: 'minecraft:water', height: 62, biome: 'minecraft:cold_ocean', depth: 10, note: 'water over a waterlogged ruin block' },
    { chunk: [-192, 4272], col: [3, 15], name: 'minecraft:water', height: 62, biome: 'minecraft:cold_ocean', depth: 28, note: 'deep water + waterlogged glow_lichen' },
    { chunk: [-512, 4096], col: [5, 0], name: 'minecraft:water', height: 62, biome: 'minecraft:cold_ocean', depth: 11, note: 'depth sees through seagrass' },
    { chunk: [-496, 4096], col: [8, 0], name: 'minecraft:water', height: 62, biome: 'minecraft:cold_ocean', depth: 18, note: 'deep water' },
    { chunk: [-352, 4096], col: [10, 4], name: 'minecraft:kelp', height: 62, biome: 'minecraft:cold_ocean', depth: 11, note: 'kelp AS the surface — renders as water, depth 11' },
    { chunk: [-400, 4144], col: [12, 11], name: 'minecraft:sand', height: 62, biome: 'minecraft:beach', depth: 0, note: 'beach sand' },
    { chunk: [-448, 4192], col: [14, 13], name: 'minecraft:grass_block', height: 62, biome: 'minecraft:plains', depth: 0, note: 'grass surface' },
    { chunk: [-512, 4240], col: [0, 5], name: 'minecraft:oak_leaves', height: 69, biome: 'minecraft:forest', depth: 0, note: 'tree leaves (foliage)' },
    { chunk: [-512, 4288], col: [0, 8], name: 'minecraft:snow', height: 75, biome: 'minecraft:snowy_plains', depth: 0, note: 'snow layer' },
    { chunk: [-464, 4336], col: [8, 15], name: 'minecraft:ice', height: 62, biome: 'minecraft:windswept_hills', depth: 0, note: 'ice (translucent, frozen ocean)' },
    { chunk: [-496, 4352], col: [11, 14], name: 'minecraft:packed_ice', height: 63, biome: 'minecraft:snowy_plains', depth: 0, note: 'packed ice' },
  ],
  'overworld_26_3.mca': [
    { chunk: [-464, 0], col: [6, 12], name: 'minecraft:water', height: 62, biome: 'minecraft:river', depth: 7, note: 'water over tall_seagrass (5 water + 2 plant)' },
    { chunk: [-464, 0], col: [0, 13], name: 'minecraft:water', height: 62, biome: 'minecraft:river', depth: 6, note: 'water over seagrass (5 water + 1 plant)' },
    { chunk: [-512, 0], col: [0, 0], name: 'minecraft:grass_block', height: 63, biome: 'minecraft:plains', depth: 0, note: 'grass surface' },
    { chunk: [-512, 0], col: [4, 0], name: 'minecraft:sand', height: 62, biome: 'minecraft:plains', depth: 0, note: 'sand' },
    { chunk: [-384, 0], col: [14, 0], name: 'minecraft:snow', height: 63, biome: 'minecraft:snowy_beach', depth: 0, note: 'snow layer' },
    { chunk: [-384, 0], col: [6, 0], name: 'minecraft:ice', height: 62, biome: 'minecraft:beach', depth: 0, note: 'ice' },
  ],
};

const table = loadColorTable();

// topColumns for every chunk in a fixture, keyed by "ox,oz" (getCoordinates()).
function columnsByChunk(file: string): Map<string, ChunkColumns> {
  const buf = readFileSync(new URL(`./fixtures/${file}`, import.meta.url));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const parser = new AnvilParser(ab);
  const out = new Map<string, ChunkColumns>();
  for (const chunk of iterChunks(parser)) {
    const co = chunk.getCoordinates();
    const cols = topColumns(chunk, table);
    if (co && cols) out.set(`${co[0]},${co[1]}`, cols);
  }
  return out;
}

describe.each(Object.entries(FIXTURES))('topColumns golden surface/depth — %s', (file, goldens) => {
  const byChunk = columnsByChunk(file);

  test.each(goldens)('$note @ chunk $chunk col $col', (g) => {
    const cols = byChunk.get(`${g.chunk[0]},${g.chunk[1]}`);
    expect(cols, `chunk ${g.chunk} present in fixture`).toBeDefined();
    const i = g.col[1] * 16 + g.col[0];
    expect({
      name: cols!.names[i], height: cols!.heights[i], biome: cols!.biomes[i], depth: cols!.depths[i],
    }).toEqual({ name: g.name, height: g.height, biome: g.biome, depth: g.depth });
  });
});
