// Reading a chunk's biomes, across the 1.18 format change: 1.18+ store a paletted
// `biomes` container per section (4x4x4 cells); pre-1.18 worlds store a chunk-level
// numeric `Biomes` array (1024 ids for 1.15-1.17, 256 for 1.13-1.14). Both routes
// normalise ids through BIOME_ALIASES so a renamed biome resolves to today's tint.

import type { TagData, BlockStates, Chunk } from 'mc-anvil';
import { findChildTagAtPath } from 'mc-anvil';
import { BIOME_ALIASES, LEGACY_BIOME_IDS } from '../gamedata';
import { childTag, packedExtractor, paletteBits } from './sections';

function biomeContainer(section: TagData[]): { bs?: BlockStates; pal?: TagData } {
  const c = childTag(section, 'biomes');
  if (c && Array.isArray(c.data)) {
    const inner = c.data as TagData[];
    return {
      bs: inner.find(x => x.name === 'data') as unknown as BlockStates | undefined,
      pal: inner.find(x => x.name === 'palette'),
    };
  }
  return {};
}

export type BiomeReader = { biomeAt: (lx: number, ly: number, lz: number) => string | null };

export function buildBiomeReader(section: TagData[]): BiomeReader | null {
  const { bs, pal } = biomeContainer(section);
  if (!pal) return null;
  // Biome palette is a LIST of STRING, so data.data is the id array directly.
  const raw = (((pal.data as unknown) as { data?: unknown } | null)?.data as string[]) ?? [];
  const names = raw.map(n => BIOME_ALIASES[n] ?? n); // normalise renamed biome ids
  if (names.length === 0) return null;
  if (names.length === 1 || !bs || !(bs.data instanceof ArrayBuffer) || bs.data.byteLength === 0) {
    const only = names[0];
    return { biomeAt: () => only };
  }
  const read = packedExtractor(bs.data, paletteBits(names.length)); // biomes: no min
  return {
    biomeAt: (lx, ly, lz) => {
      const idx = read((ly >> 2) * 16 + (lz >> 2) * 4 + (lx >> 2)); // 4x4x4 cells
      return idx < 0 || idx >= names.length ? null : names[idx];
    },
  };
}

// Pre-1.18 biomes: a chunk-level numeric `Biomes` array (no per-section palette).
// 1.15-1.17 store 1024 ids (4x4x4 cells, vertical too); 1.13-1.14 store 256 (2D,
// one per column). Numeric ids map through LEGACY_BIOME_IDS, then BIOME_ALIASES to
// today's names. NB: unlike the 1.18 reader, biomeAt's middle arg is the *world* Y
// (the legacy 3D grid is indexed by absolute height, not a within-section offset).
export function buildLegacyBiomeReader(chunk: Chunk): BiomeReader | null {
  const tag = findChildTagAtPath('Level/Biomes', chunk.root) ?? findChildTagAtPath('Biomes', chunk.root);
  const ids = tag?.data;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const name = (id: unknown): string | null => {
    const n = typeof id === 'number' ? LEGACY_BIOME_IDS[id] : undefined;
    return n ? (BIOME_ALIASES[n] ?? n) : null;
  };
  if (ids.length >= 1024) {
    // 4x4x4 cells; vertical cell = world Y >> 2, clamped to the 0..63 (0..255) range.
    return {
      biomeAt: (lx, wy, lz) => {
        const yc = Math.min(63, Math.max(0, wy >> 2));
        return name(ids[(yc << 4) | ((lz >> 2) << 2) | (lx >> 2)]);
      },
    };
  }
  // 2D: one biome per column, ignoring height.
  return { biomeAt: (lx, _wy, lz) => name(ids[(lz & 15) * 16 + (lx & 15)]) };
}
