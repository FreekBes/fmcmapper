// Reading/writing PNG tiles and building the overview pyramid (each zoom level
// composites four children of the level below and halves them).

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import sharp from 'sharp';
import { TILE } from './constants';
import { pool } from './pool';

sharp.concurrency(1); // keep libvips from fanning out across all cores
// Disable libvips' operation/pixel cache. buildParent runs a composite+resize per
// overview tile across every zoom level, and the default cache holds decoded
// tiles in native memory that never returns to the OS — the main reason the
// service process sits at a high RSS long after a render finishes.
sharp.cache(false);

export const tilePath = (root: string, z: number, x: number, y: number): string =>
  join(root, String(z), String(x), `${y}.png`);

export function writePng(p: string, buf: Buffer): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
}

export function rmTile(root: string, z: number, x: number, y: number): void {
  const p = tilePath(root, z, x, y);
  try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
}

// Draw one overview tile by compositing up to 4 children (z+1) and halving.
async function buildParent(root: string, z: number, x: number, y: number): Promise<boolean> {
  const composites: sharp.OverlayOptions[] = [];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const cp = tilePath(root, z + 1, x * 2 + dx, y * 2 + dy);
      if (existsSync(cp)) composites.push({ input: cp, top: dy * TILE, left: dx * TILE });
    }
  }
  if (composites.length === 0) return false;
  // Two stages: sharp applies resize BEFORE composite within one pipeline, so
  // composite into a full-size raw buffer first, then resize that separately.
  const composited = await sharp({
    create: { width: TILE * 2, height: TILE * 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .raw()
    .toBuffer();
  const out = await sharp(composited, { raw: { width: TILE * 2, height: TILE * 2, channels: 4 } })
    .resize(TILE, TILE) // lanczos downscale, alpha-aware
    .png()
    .toBuffer();
  writePng(tilePath(root, z, x, y), out);
  return true;
}

// Rebuild the overview levels above everything that changed at the base zoom.
// `baseDirty` holds "tx,ty" keys at maxZoom; each level up halves the coordinates.
export async function buildOverviews(
  tilesRoot: string, baseDirty: Set<string>, maxZoom: number, jobs: number,
): Promise<void> {
  let dirty = baseDirty;
  for (let z = maxZoom - 1; z >= 0; z--) {
    const parents = new Set<string>();
    for (const k of dirty) {
      const [x, y] = k.split(',').map(Number);
      parents.add(`${x >> 1},${y >> 1}`);
    }
    const arr = [...parents].map(k => k.split(',').map(Number) as [number, number]);
    let made = 0;
    await pool(arr, jobs, async ([x, y]) => {
      const ok = await buildParent(tilesRoot, z, x, y);
      if (!ok) rmTile(tilesRoot, z, x, y); // all children gone
      return ok;
    }, ok => { if (ok) made++; });
    if (arr.length) console.log(`zoom ${z}: ${made}/${arr.length} tiles`);
    dirty = parents;
  }
}
