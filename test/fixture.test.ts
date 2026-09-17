import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { AnvilParser, findChildTagAtPath } from 'mc-anvil';
import type { TagData } from 'mc-anvil';
import { loadColorTable } from '../src/colors';
import { topColumns, iterChunks, type ChunkColumns } from '../src/chunk/columns';

// Small real regions (~18 full chunks each) carved from worlds across the versions
// fmcmapper supports, so the block/biome decode is exercised end-to-end against the
// format changes between them: 1.16 (Level-wrapped chunks, legacy 3D biomes), 1.18
// (Caves & Cliffs section format), 26.1 (modern), 26.3 (string/renamed palettes).
const FIXTURES = [
  { version: '1.16', file: 'overworld_1_16.mca', dataVersion: 1976 },
  { version: '1.18', file: 'overworld_1_18.mca', dataVersion: 2730 },
  { version: '26.1', file: 'overworld_26_1.mca', dataVersion: 4556 },
  { version: '26.3', file: 'overworld_26_3.mca', dataVersion: 5023 },
] as const;

const ID_RE = /^[a-z0-9_.-]+:[a-z0-9_/.-]+$/;

// Run the production decode — iterChunks + topColumns, both from src — over every
// chunk in a fixture and return their per-chunk surface columns *unmodified*. The
// tests assert directly on this src output; the only thing added here is gathering
// (and a first-chunk DataVersion read, purely to check the fixture's identity).
function decodeRegion(file: string): { columns: ChunkColumns[]; dataVersion: number | null } {
  const buf = readFileSync(new URL(`./fixtures/${file}`, import.meta.url));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const parser = new AnvilParser(ab);
  const table = loadColorTable();

  const columns: ChunkColumns[] = [];
  let dataVersion: number | null = null;
  for (const chunk of iterChunks(parser)) {
    if (dataVersion === null) {
      const dv = (findChildTagAtPath('DataVersion', chunk.root) ?? findChildTagAtPath('Level/DataVersion', chunk.root)) as TagData | undefined;
      if (dv && (typeof dv.data === 'number' || typeof dv.data === 'bigint')) dataVersion = Number(dv.data);
    }
    const cols = topColumns(chunk, table);
    if (cols) columns.push(cols);
  }
  return { columns, dataVersion };
}

const surfaceNames = (columns: ChunkColumns[]): string[] =>
  columns.flatMap(c => c.names.filter((n): n is string => n !== null));

describe.each(FIXTURES)('topColumns on a real $version region', ({ file, dataVersion }) => {
  const { columns, dataVersion: parsed } = decodeRegion(file);

  test('the fixture is the expected Minecraft version and parses', () => {
    expect(parsed).toBe(dataVersion);
    expect(columns.length).toBeGreaterThan(10);
  });

  test('every full chunk yields a decoded surface', () => {
    expect(surfaceNames(columns).length).toBeGreaterThan(1000);
  });

  test('topColumns emits only valid namespaced block ids (no garbage decode)', () => {
    const bad = [...new Set(surfaceNames(columns))].filter(n => !ID_RE.test(n));
    expect(bad).toEqual([]);
  });

  // The 26.3 palette breakage made surface sections resolve to null, so the scan
  // fell through to deep stone/deepslate and the map came out ~64% stone. This is
  // the cross-version guard against that whole class of decode failure.
  test('surface is NOT dominated by underground stone', () => {
    const names = surfaceNames(columns);
    const underground = names.filter(n => n === 'minecraft:stone' || n === 'minecraft:deepslate').length;
    expect(underground / names.length).toBeLessThan(0.2);
  });

  test('topColumns resolves biomes and water depth', () => {
    expect(columns.some(c => c.biomes.some(b => b !== null))).toBe(true);
    expect(columns.some(c => c.depths.some(d => d > 0))).toBe(true);
  });
});
