// The incremental render manifest: per-region state from the last pass, plus the
// render signature that decides when cached tiles are stale.

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { TINTS, BLOCK_ALIASES, BIOME_ALIASES, LEGACY_BIOME_IDS, SUBMERGED_PLANTS } from '../gamedata';
import { renderConfig } from '../renderconfig';
import type { RegionFile } from '../world/regions';
import { TILE } from './constants';

export const MANIFEST = 'render-manifest.json';
const MANIFEST_VERSION = 2; // bumped for the biome super-tile layout

// Bump only when the coloring *algorithm* changes — shading math, the blur, the
// water-depth formula, the fallback colour — i.e. logic that isn't already
// captured by the colour-table, render-config, or TINTS hashes below. (Changing
// a colour table, a MAP_* setting/default, or which blocks tint is detected
// automatically, so those don't need a bump.)
const RENDER_VERSION = 7;

// Colour tables whose contents feed the render signature (resolved like the worker).
const MAP_COLORS_PATH = process.env.MAP_COLORS_PATH ?? resolve(process.cwd(), 'assets/map_colors.json');
const BIOME_COLORS_PATH = process.env.BIOME_COLORS_PATH ?? resolve(process.cwd(), 'assets/biome_colors.json');

export type RegionEntry = { lastUpdate: number; mtimeMs: number };
export type Manifest = {
  version: number;
  dimension: string;
  tileSize: number;
  originRx: number;
  originRz: number;
  maxZoom: number;
  renderSig: string; // fingerprint of colour tables + pixel env (see renderSignature)
  regions: Record<string, RegionEntry>;
};

// A short hash of everything (besides the world) that affects rendered pixels:
// the colour tables, the resolved render config (MAP_* env-or-default), and the
// tint rules. When it changes, cached tiles are stale and the map is redrawn.
export function renderSignature(): string {
  const h = createHash('sha1').update(`render:${RENDER_VERSION}`);
  for (const p of [MAP_COLORS_PATH, BIOME_COLORS_PATH]) {
    try { h.update(readFileSync(p)); } catch { h.update('\0missing\0'); }
  }
  h.update('\0cfg=' + JSON.stringify(renderConfig()));
  h.update('\0tints=' + JSON.stringify(TINTS));
  h.update('\0aliases=' + JSON.stringify(BLOCK_ALIASES));
  h.update('\0biomealiases=' + JSON.stringify(BIOME_ALIASES));
  h.update('\0legacybiomes=' + JSON.stringify(LEGACY_BIOME_IDS));
  h.update('\0submerged=' + JSON.stringify([...SUBMERGED_PLANTS]));
  return h.digest('hex').slice(0, 16);
}

export function loadManifest(outDir: string): Manifest | null {
  const f = join(outDir, MANIFEST);
  if (!existsSync(f)) return null;
  try {
    const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
    if (m && m.version === MANIFEST_VERSION && m.regions) return m;
  } catch { /* fall through to full redraw */ }
  return null;
}

// Can we reuse the cached tile grid? Only if the render signature matches (else
// colours/tints changed and every tile is stale), the dimension/tileSize match,
// and every current region still maps into the cached origin + maxZoom envelope
// (else the tile coordinates would shift and the whole pyramid is invalid).
export function reusable(m: Manifest | null, dimension: string, regions: RegionFile[], renderSig: string): m is Manifest {
  if (!m || m.renderSig !== renderSig || m.dimension !== dimension || m.tileSize !== TILE) return false;
  const grid = 2 ** m.maxZoom;
  for (const r of regions) {
    const tx = r.rx - m.originRx;
    const ty = r.rz - m.originRz;
    if (tx < 0 || ty < 0 || tx >= grid || ty >= grid) return false;
  }
  return true;
}

// The manifest a completed pass writes back out.
export function buildManifest(fields: Omit<Manifest, 'version'>): Manifest {
  return { version: MANIFEST_VERSION, ...fields };
}
