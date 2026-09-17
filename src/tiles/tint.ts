// Pure pixel/data helpers used by the render worker: biome tint fields + the box
// blur that fades tints across biome borders, the biome-cell downsample the viewer
// consumes, and the LastUpdate long reader. Extracted from worker.ts so they can be
// unit-tested without the worker's message-handler side effects.

import type { BiomeColor, BiomeColors } from '../colors';

// ---------------------------------------------------------------------------
// Biome tint blending: average each kind's per-pixel biome color over a box,
// so colors fade smoothly across biome borders instead of stepping in blocks.
// ---------------------------------------------------------------------------

// A blurred tint field: one packed colour per cell, `0xRRGGBB`, or -1 where the
// blur saw no valid samples. Packing the three channels + validity into a single
// Int32Array (vs three Int16Arrays + a Uint8 flag) roughly halves the memory held
// for the four fields across the whole pixel loop.
export type Field = Int32Array;

// Reusable per-axis blur accumulators, allocated once and shared by all four tint
// kinds (blur runs them sequentially). Row-window channel sums stay well under
// Int16 (<=255 * (2*rad+1), rad<=8 => <=4335); counts fit Uint8 (<=2*rad+1).
export type Scratch = { hr: Int16Array; hg: Int16Array; hb: Int16Array; hc: Uint8Array };

// The biome-driven tint kinds and how each reads its colour off a BiomeColor.
// (BiomeColor uses camelCase `dryFoliage`; the tint id is snake_case.)
export type TintKind = 'grass' | 'foliage' | 'dry_foliage' | 'water';
export const PICK: Record<TintKind, (bc: BiomeColor) => number> = {
  grass: bc => bc.grass,
  foliage: bc => bc.foliage,
  dry_foliage: bc => bc.dryFoliage,
  water: bc => bc.water,
};

// Fallback tint for biome-tinted blocks when no biome data is available (e.g. a
// pre-1.18 world, where biomes aren't parsed). Without it those blocks drop to
// their plain map colour — or, for an id missing from the colour table (1.16's
// `minecraft:grass` was renamed `short_grass` in 1.20), to a hashed colour that
// can come out purple. These are Minecraft's no-biome default grass/foliage/water
// colours; dry-foliage barely appears in such worlds.
export const DEFAULT_TINT: BiomeColor = { grass: 0x91bd59, foliage: 0x48b518, dryFoliage: 0x96a053, water: 0x3f76e4 };

export function tintField(
  grid: (string | null)[], dim: number, pick: (bc: BiomeColor) => number, biomeColors: BiomeColors,
): Field {
  const f = new Int32Array(dim * dim).fill(-1);
  for (let i = 0; i < f.length; i++) {
    const bn = grid[i];
    if (!bn) continue;
    const bc = biomeColors.get(bn);
    if (!bc) continue;
    const rgb = pick(bc);
    if (rgb < 0) continue;
    f[i] = rgb & 0xffffff; // 0xRRGGBB, always >= 0 so it reads as "valid"
  }
  return f;
}

// Separable box blur over a dim x dim grid that averages only over valid cells
// (so no-biome holes and grid edges don't darken the result). `s` holds the
// horizontal-pass accumulators, reused across kinds to avoid re-allocating them.
export function blur(src: Field, dim: number, rad: number, s: Scratch): Field {
  const { hr, hg, hb, hc } = s;
  for (let y = 0; y < dim; y++) {
    const row = y * dim;
    let sr = 0, sg = 0, sb = 0, sc = 0;
    for (let x = 0; x <= rad && x < dim; x++) {
      const p = src[row + x];
      if (p >= 0) { sr += (p >> 16) & 255; sg += (p >> 8) & 255; sb += p & 255; sc++; }
    }
    for (let x = 0; x < dim; x++) {
      hr[row + x] = sr; hg[row + x] = sg; hb[row + x] = sb; hc[row + x] = sc;
      const out = x - rad;
      if (out >= 0) { const p = src[row + out]; if (p >= 0) { sr -= (p >> 16) & 255; sg -= (p >> 8) & 255; sb -= p & 255; sc--; } }
      const inn = x + rad + 1;
      if (inn < dim) { const p = src[row + inn]; if (p >= 0) { sr += (p >> 16) & 255; sg += (p >> 8) & 255; sb += p & 255; sc++; } }
    }
  }

  const out = new Int32Array(dim * dim).fill(-1);
  for (let x = 0; x < dim; x++) {
    let sr = 0, sg = 0, sb = 0, sc = 0;
    for (let y = 0; y <= rad && y < dim; y++) {
      const i = y * dim + x; sr += hr[i]; sg += hg[i]; sb += hb[i]; sc += hc[i];
    }
    for (let y = 0; y < dim; y++) {
      const i = y * dim + x;
      if (sc > 0) out[i] = (Math.round(sr / sc) << 16) | (Math.round(sg / sc) << 8) | Math.round(sb / sc);
      const o = y - rad;
      if (o >= 0) { const j = o * dim + x; sr -= hr[j]; sg -= hg[j]; sb -= hb[j]; sc -= hc[j]; }
      const inn = y + rad + 1;
      if (inn < dim) { const j = inn * dim + x; sr += hr[j]; sg += hg[j]; sb += hb[j]; sc += hc[j]; }
    }
  }
  return out;
}

// Downsample the surface biome grid to one sample per `res`-block cell (a `cells` x
// `cells` grid), with a compact local palette (index 255 = no biome). Reads the
// region's biomes from the centre of the haloed grid `eb` (offset by `h` on each
// axis, stride `ew`), so we don't keep a second region-sized biome array alongside.
export function biomeCells(
  eb: (string | null)[], ew: number, h: number, res: number, cells: number,
): { res: number; palette: string[]; data: number[] } {
  const palette: string[] = [];
  const idOf = new Map<string, number>();
  const data = new Array<number>(cells * cells).fill(255);
  for (let cz = 0; cz < cells; cz++) {
    for (let cx = 0; cx < cells; cx++) {
      const nm = eb[(cz * res + h) * ew + (cx * res + h)];
      if (!nm) continue;
      let id = idOf.get(nm);
      if (id === undefined) { id = palette.length; idOf.set(nm, id); palette.push(nm); }
      data[cz * cells + cx] = id;
    }
  }
  return { res, palette, data };
}

// mc-anvil 2.x reads a scalar TAG_Long little-endian (NBT is big-endian), so
// LastUpdate comes back byte-swapped. A real tick count is a small non-negative
// number; if the value is implausible we swap the bytes back. The guard means a
// future mc-anvil fix won't get double-corrected.
export function readLong(raw: number | bigint): number {
  let v = typeof raw === 'bigint' ? raw : BigInt(Math.trunc(raw));
  if (v < 0n || v > 1n << 40n) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    v = b.readBigInt64BE(0);
  }
  return Number(v);
}
