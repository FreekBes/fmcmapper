import { describe, test, expect, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RegionFile } from '../src/world/regions';
import {
  MANIFEST, renderSignature, reusable, loadManifest, buildManifest, type Manifest,
} from '../src/tiles/manifest';

const region = (rx: number, rz: number): RegionFile => ({ file: `r.${rx}.${rz}.mca`, rx, rz });

// A manifest with sensible defaults; maxZoom 3 -> an 8x8 tile envelope from origin.
const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  version: 2,
  dimension: 'minecraft:overworld',
  tileSize: 512,
  originRx: 0,
  originRz: 0,
  maxZoom: 3,
  renderSig: 'sig123',
  regions: {},
  ...over,
});

describe('reusable — can the cached tile grid be reused incrementally?', () => {
  const dim = 'minecraft:overworld';
  const sig = 'sig123';

  test('true when signature, dimension, tileSize match and regions fit the envelope', () => {
    expect(reusable(manifest(), dim, [region(0, 0), region(7, 7)], sig)).toBe(true);
  });

  test('false for a null manifest (no prior run)', () => {
    expect(reusable(null, dim, [region(0, 0)], sig)).toBe(false);
  });

  test('false when the render signature changed (colours/tints stale)', () => {
    expect(reusable(manifest(), dim, [region(0, 0)], 'different')).toBe(false);
  });

  test('false when the dimension differs', () => {
    expect(reusable(manifest(), 'minecraft:the_nether', [region(0, 0)], sig)).toBe(false);
  });

  test('false when the tile size differs', () => {
    expect(reusable(manifest({ tileSize: 256 }), dim, [region(0, 0)], sig)).toBe(false);
  });

  test('false when a region falls outside the cached origin+maxZoom envelope', () => {
    expect(reusable(manifest(), dim, [region(8, 0)], sig)).toBe(false);  // tx == grid (8) -> out
    expect(reusable(manifest(), dim, [region(-1, 0)], sig)).toBe(false); // tx < 0 -> out
    expect(reusable(manifest({ originRx: 2 }), dim, [region(1, 0)], sig)).toBe(false); // left of origin
  });
});

describe('renderSignature — fingerprint of everything that affects pixels', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  test('is a stable 16-char hex digest, deterministic for identical inputs', () => {
    const a = renderSignature();
    const b = renderSignature();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toBe(a);
  });

  test('changes when a render-config setting changes', () => {
    const before = renderSignature();
    process.env.MAP_BRIGHTNESS = '0.5'; // renderConfig() re-reads env on each call
    expect(renderSignature()).not.toBe(before);
  });
});

describe('loadManifest / buildManifest', () => {
  const dirs: string[] = [];
  const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'fmc-mani-')); dirs.push(d); return d; };
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  test('buildManifest stamps the current manifest version', () => {
    const m = buildManifest({
      dimension: 'minecraft:overworld', tileSize: 512, originRx: 0, originRz: 0,
      maxZoom: 3, renderSig: 'x', regions: {},
    });
    expect(m.version).toBe(2);
  });

  test('round-trips a written manifest', () => {
    const d = tmp();
    const m = manifest({ regions: { '0,0': { lastUpdate: 42, mtimeMs: 100 } } });
    writeFileSync(join(d, MANIFEST), JSON.stringify(m));
    expect(loadManifest(d)).toEqual(m);
  });

  test('returns null for missing, wrong-version, or corrupt manifests', () => {
    expect(loadManifest(tmp())).toBeNull(); // missing
    const dv = tmp();
    writeFileSync(join(dv, MANIFEST), JSON.stringify(manifest({ version: 1 })));
    expect(loadManifest(dv)).toBeNull(); // stale schema version
    const dc = tmp();
    writeFileSync(join(dc, MANIFEST), '{ not json');
    expect(loadManifest(dc)).toBeNull(); // corrupt
  });
});
