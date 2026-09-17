import { describe, test, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Chunk, TagData } from 'mc-anvil';
import { loadColorTable } from '../src/colors';
import { sectionData, sectionY, paletteEntryName, type PaletteEntry } from '../src/chunk/sections';
import { buildBiomeReader, buildLegacyBiomeReader } from '../src/chunk/biomes';
import { sampleExtras, EMPTY_HEIGHT } from '../src/chunk/columns';
import { regionDir } from '../src/world/regions';
import { readLevel } from '../src/world/level';

// Every branch below exists to read a *specific era* of Minecraft's on-disk format.
// These tests exercise each branch directly so a future version bump can't silently
// break reading an older world without also going red here.

// --- minimal NBT tag constructors (mc-anvil's parsed shape) -----------------
const t = (name: string, type: number, data: unknown): TagData => ({ name, type, data } as unknown as TagData);
const list = (name: string, subType: number, items: unknown[]): TagData => t(name, 9, { subType, data: items });
const compound = (name: string, children: TagData[]): TagData => t(name, 10, children);
const str = (name: string, s: string): TagData => t(name, 8, s);

const tmpDirs: string[] = [];
const stageWorld = (build: (dir: string) => void): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fmc-world-'));
  tmpDirs.push(dir);
  build(dir);
  return dir;
};
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// World folder layout: modern `dimensions/<ns>/<dim>/region` vs the pre-dimensions
// legacy layout (`region`, `DIM-1`, `DIM1`). (world/regions.regionDir)
// ---------------------------------------------------------------------------
describe('regionDir — world folder layout across versions', () => {
  test('modern layout: dimensions/<ns>/<dim>/region wins when present', () => {
    const w = stageWorld(dir => {
      mkdirSync(join(dir, 'dimensions', 'minecraft', 'overworld', 'region'), { recursive: true });
      mkdirSync(join(dir, 'region'), { recursive: true }); // legacy also present -> modern preferred
    });
    expect(regionDir(w, 'minecraft:overworld')).toBe(join(w, 'dimensions', 'minecraft', 'overworld', 'region'));
  });

  test('legacy overworld: <world>/region', () => {
    const w = stageWorld(dir => mkdirSync(join(dir, 'region'), { recursive: true }));
    expect(regionDir(w, 'minecraft:overworld')).toBe(join(w, 'region'));
  });

  test('legacy nether: <world>/DIM-1/region', () => {
    const w = stageWorld(dir => mkdirSync(join(dir, 'DIM-1', 'region'), { recursive: true }));
    expect(regionDir(w, 'minecraft:the_nether')).toBe(join(w, 'DIM-1', 'region'));
  });

  test('legacy end: <world>/DIM1/region', () => {
    const w = stageWorld(dir => mkdirSync(join(dir, 'DIM1', 'region'), { recursive: true }));
    expect(regionDir(w, 'minecraft:the_end')).toBe(join(w, 'DIM1', 'region'));
  });

  test('throws when no region folder exists in any layout', () => {
    const w = stageWorld(() => { /* empty world dir */ });
    expect(() => regionDir(w, 'minecraft:overworld')).toThrow(/No region folder/);
  });
});

// ---------------------------------------------------------------------------
// level.dat spawn + version: pre-1.21 stores SpawnX/SpawnY/SpawnZ scalars; since
// 1.21 an IntArray at Data/spawn/pos. (world/level.readLevel). Real level.dat files.
// ---------------------------------------------------------------------------
describe('readLevel — spawn + version across level.dat formats', () => {
  const LEVELS = [
    { version: '1.16', file: 'level_1_16.dat', name: '1.16.5', dataVersion: 2586, layout: 'SpawnX/Z' },
    { version: '1.18', file: 'level_1_18.dat', name: '1.18.1', dataVersion: 2865, layout: 'SpawnX/Z' },
    { version: '26.1', file: 'level_26_1.dat', name: '26.1.2', dataVersion: 4790, layout: 'spawn/pos' },
    { version: '26.3', file: 'level_26_3.dat', name: '26.3', dataVersion: 5023, layout: 'spawn/pos' },
  ];

  test.each(LEVELS)('$version ($layout) yields spawn + version', ({ file, name, dataVersion }) => {
    const bytes = readFileSync(new URL(`./fixtures/${file}`, import.meta.url));
    const w = stageWorld(dir => writeFileSync(join(dir, 'level.dat'), bytes));
    const { spawn, version } = readLevel(w);
    expect(spawn).not.toBeNull();
    expect(typeof spawn!.x).toBe('number');
    expect(typeof spawn!.z).toBe('number');
    expect(version?.name).toBe(name);
    expect(version?.dataVersion).toBe(dataVersion);
  });

  test('missing level.dat degrades to nulls, not a throw', () => {
    const w = stageWorld(() => { /* no level.dat */ });
    expect(readLevel(w)).toEqual({ spawn: null, version: null });
  });
});

// ---------------------------------------------------------------------------
// Section block palette location: pre-1.18 `Palette` + `BlockStates` directly on
// the section; 1.18+ a `block_states` compound holding `palette` + `data`.
// (chunk/sections.sectionData)
// ---------------------------------------------------------------------------
describe('sectionData — block-section layout across versions', () => {
  const firstName = (section: TagData[]): string | undefined => {
    const { pal } = sectionData(section);
    if (!pal) return undefined;
    const entries = (pal.data as { data: PaletteEntry[] }).data;
    return paletteEntryName(entries[0]);
  };

  test('pre-1.18: Palette (list of compound) + BlockStates', () => {
    const section = [
      list('Palette', 10, [[str('Name', 'minecraft:stone')]]),
      t('BlockStates', 12, new ArrayBuffer(8)),
    ];
    expect(firstName(section)).toBe('minecraft:stone');
  });

  test('1.18+: block_states { palette, data }', () => {
    const section = [
      compound('block_states', [
        list('palette', 8, ['minecraft:stone']),
        t('data', 12, new ArrayBuffer(8)),
      ]),
    ];
    expect(firstName(section)).toBe('minecraft:stone');
  });

  test('a section with neither yields no palette', () => {
    expect(sectionData([t('SkyLight', 7, new ArrayBuffer(0))])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 1.18+ biomes: a per-section paletted `biomes` container (4x4x4 cells).
// (chunk/biomes.buildBiomeReader)
// ---------------------------------------------------------------------------
describe('buildBiomeReader — 1.18+ paletted section biomes', () => {
  test('uniform (single-entry) palette returns that biome everywhere, aliased', () => {
    const section = [compound('biomes', [list('palette', 8, ['minecraft:giant_tree_taiga'])])];
    const r = buildBiomeReader(section as unknown as TagData[]);
    // BIOME_ALIASES normalises the pre-1.18 name to today's id.
    expect(r?.biomeAt(0, 0, 0)).toBe('minecraft:old_growth_pine_taiga');
  });

  test('packed palette decodes per 4x4x4 cell', () => {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setBigUint64(0, 1n, false); // cell index 0 -> palette[1]; all others -> palette[0]
    const section = [compound('biomes', [
      list('palette', 8, ['minecraft:plains', 'minecraft:desert']),
      t('data', 12, dv.buffer),
    ])];
    const r = buildBiomeReader(section as unknown as TagData[]);
    expect(r?.biomeAt(0, 0, 0)).toBe('minecraft:desert'); // cell 0
    expect(r?.biomeAt(0, 0, 4)).toBe('minecraft:plains'); // cell (z>>2)=1
  });
});

// ---------------------------------------------------------------------------
// Pre-1.18 biomes: a chunk-level numeric `Biomes` array (no per-section palette),
// mapped through LEGACY_BIOME_IDS then BIOME_ALIASES. 1.15-1.17 store 1024 ids
// (3D); 1.13-1.14 store 256 (2D). (chunk/biomes.buildLegacyBiomeReader)
// ---------------------------------------------------------------------------
describe('buildLegacyBiomeReader — pre-1.18 numeric biome arrays', () => {
  const legacyChunk = (ids: number[], atLevel = true): Chunk => {
    const biomes = t('Biomes', 11, ids);
    const rootData = atLevel ? [compound('Level', [biomes])] : [biomes];
    return { root: { name: '', type: 10, data: rootData } } as unknown as Chunk;
  };

  test('3D (1024) array: numeric id -> name -> alias, indexed by world Y', () => {
    const ids = new Array(1024).fill(1); // 1 = plains
    ids[0] = 3;                          // 3 = mountains (aliased to windswept_hills)
    const r = buildLegacyBiomeReader(legacyChunk(ids));
    expect(r?.biomeAt(0, 0, 0)).toBe('minecraft:windswept_hills'); // id 3 -> mountains -> alias
    expect(r?.biomeAt(4, 0, 0)).toBe('minecraft:plains');          // cell (x>>2)=1 -> id 1
  });

  test('2D (256) array: one biome per column, height ignored', () => {
    const ids = new Array(256).fill(1);
    ids[0] = 2; // 2 = desert
    const r = buildLegacyBiomeReader(legacyChunk(ids));
    expect(r?.biomeAt(0, 999, 0)).toBe('minecraft:desert');
    expect(r?.biomeAt(1, 0, 0)).toBe('minecraft:plains');
  });

  test('reads Biomes at the chunk root too (not only under Level)', () => {
    const ids = new Array(256).fill(0); // 0 = ocean
    const r = buildLegacyBiomeReader(legacyChunk(ids, /* atLevel */ false));
    expect(r?.biomeAt(0, 0, 0)).toBe('minecraft:ocean');
  });

  test('an unknown numeric id resolves to null rather than crashing', () => {
    const ids = new Array(256).fill(9999);
    const r = buildLegacyBiomeReader(legacyChunk(ids));
    expect(r?.biomeAt(0, 0, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-column biome source selection: use the 1.18+ per-section paletted biomes
// when a section has them, else fall back to the pre-1.18 chunk-level numeric
// array. (chunk/columns.sampleExtras)
// ---------------------------------------------------------------------------
describe('sampleExtras — chooses section vs legacy biomes by what the chunk carries', () => {
  const TABLE = loadColorTable();
  const chunkWith = (sections: TagData[][], rootData: TagData[]): Chunk => ({
    sections: () => ({ data: { data: sections } }),
    root: { name: '', type: 10, data: rootData },
  } as unknown as Chunk);
  // One resolved surface column at (0,0), world Y 70 (section index 4).
  const oneColumn = () => {
    const names: (string | null)[] = new Array(256).fill(null);
    names[0] = 'minecraft:stone';
    const heights = new Int32Array(256).fill(EMPTY_HEIGHT);
    heights[0] = 70;
    return { names, heights };
  };

  test('1.18+: reads the section-level paletted biomes container', () => {
    const section = [t('Y', 1, 4), compound('biomes', [list('palette', 8, ['minecraft:plains'])])];
    const { names, heights } = oneColumn();
    expect(sampleExtras(chunkWith([section], []), TABLE, names, heights).biomes[0]).toBe('minecraft:plains');
  });

  test('pre-1.18: falls back to the chunk-level numeric Biomes array', () => {
    const section = [t('Y', 1, 4)]; // section exists (so it's indexed) but has no biomes container
    const ids = new Array(256).fill(1);
    ids[0] = 2; // 2 = desert (2D legacy array)
    const root = [compound('Level', [t('Biomes', 11, ids)])];
    const { names, heights } = oneColumn();
    expect(sampleExtras(chunkWith([section], root), TABLE, names, heights).biomes[0]).toBe('minecraft:desert');
  });
});

// ---------------------------------------------------------------------------
// Section Y is a signed index (1.18+ added sub-zero sections for deepslate), but
// mc-anvil reads TAG_Byte unsigned — so it must be sign-extended. (chunk/sections.sectionY)
// ---------------------------------------------------------------------------
describe('sectionY — signed section index across the y<0 boundary', () => {
  test('sign-extends the unsigned byte mc-anvil hands back', () => {
    expect(sectionY([t('Y', 1, 4)])).toBe(4);      // ordinary positive section
    expect(sectionY([t('Y', 1, 252)])).toBe(-4);   // 0xFC -> -4 (deepslate floor, 1.18+)
    expect(sectionY([t('Y', 1, 255)])).toBe(-1);
    expect(sectionY([t('Y', 1, 128)])).toBe(-128);
  });

  test('defaults to 0 when a section has no Y tag', () => {
    expect(sectionY([])).toBe(0);
  });
});
