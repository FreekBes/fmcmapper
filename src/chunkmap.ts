import { Chunk, BlockDataParser, chunkCoordinateFromIndex } from 'mc-anvil';
import type { TagData, BlockStates, Palette } from 'mc-anvil';

// ---------------------------------------------------------------------------
// Top-block extraction
// ---------------------------------------------------------------------------

const isAir = (n: string) => n === '' || n.endsWith(':air') || n.endsWith('_air');

const childTag = (section: TagData[], name: string): TagData | undefined =>
	section.find(x => x.name === name);

const sectionY = (section: TagData[]): number => {
	const y = childTag(section, 'Y');
	return y ? Number(y.data) : 0;
};

// Handles legacy (BlockStates/Palette directly on the section) and modern
// (block_states.data / block_states.palette) chunk layouts.
function sectionData(section: TagData[]): { bs?: BlockStates; pal?: Palette } {
	const directPal = childTag(section, 'Palette') ?? childTag(section, 'palette');
	if (directPal) {
		return {
			bs: childTag(section, 'BlockStates') as unknown as BlockStates | undefined,
			pal: directPal as unknown as Palette,
		};
	}
	const container = childTag(section, 'block_states');
	if (container && Array.isArray(container.data)) {
		const inner = container.data as TagData[];
		return {
			bs: inner.find(x => x.name === 'data') as unknown as BlockStates | undefined,
			pal: inner.find(x => x.name === 'palette') as unknown as Palette | undefined,
		};
	}
	return {};
}

const paletteEntryName = (entry: TagData[]): string => {
	const n = entry.find(x => x.name.toLowerCase() === 'name');
	return typeof n?.data === 'string' ? n.data : '';
};

export type ChunkColumns = { ox: number; oz: number; names: (string | null)[] };

/**
 * For each of the 16x16 columns in the chunk, the name of the topmost
 * non-air block. names[lz * 16 + lx]. ox/oz are the chunk's world-block origin.
 * Returns null for chunks with no sections (ungenerated / partial).
 */
export function topColumns(chunk: Chunk): ChunkColumns | null {
	const coords = chunk.getCoordinates(); // [chunkX*16, chunkZ*16]
	if (!coords) return null;
	const [ox, oz] = coords;
	const sections = chunk.sortedSections(); // ascending by section Y
	if (!sections) return null;

	const names: (string | null)[] = new Array(256).fill(null);
	const topY: number[] = new Array(256).fill(-Infinity);
	let resolved = 0;

	// Walk sections top-down; stop as soon as every column is resolved.
	for (let si = sections.length - 1; si >= 0 && resolved < 256; si--) {
		const section = sections[si];
		const { bs, pal } = sectionData(section);
		if (!pal) continue;
		const entries = pal.data.data as TagData[][];

		// Single-entry palette => uniform section, block-state data is omitted.
		if (entries.length <= 1) {
			const nm = entries.length === 1 ? paletteEntryName(entries[0]) : '';
			if (!isAir(nm)) {
				const absY = sectionY(section) * 16 + 15;
				for (let c = 0; c < 256; c++) {
					if (names[c] === null) {
						names[c] = nm;
						topY[c] = absY;
						resolved++;
					}
				}
			}
			continue;
		}
		if (!bs || !(bs.data instanceof ArrayBuffer) || bs.data.byteLength === 0) continue;

		const sy = sectionY(section) * 16;
		// NOTE: getBlockTypeNames() with no arg uses the 1.16+ packing layout.
		// For pre-1.16 worlds pass `true` (the "original" spanning layout).
		const blockNames = new BlockDataParser(bs, pal).getBlockTypeNames();
		for (let i = 0; i < 4096; i++) {
			const raw = blockNames[i];
			if (!raw) continue;
			const nm = raw.split('(')[0]; // strip "(prop:val,...)" suffix
			if (isAir(nm)) continue;
			const [lx, ly, lz] = chunkCoordinateFromIndex(i);
			const c = lz * 16 + lx;
			const absY = sy + ly;
			if (absY > topY[c]) {
				if (names[c] === null) resolved++;
				names[c] = nm;
				topY[c] = absY;
			}
		}
	}
	return { ox, oz, names };
}

// ---------------------------------------------------------------------------
// Colour mapping
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

// A small starter palette. Extend with whatever blocks matter to you.
const COLORS: Record<string, RGB> = {
	'minecraft:water': [54, 80, 168],
	'minecraft:grass_block': [85, 130, 60],
	'minecraft:stone': [122, 122, 122],
	'minecraft:sand': [218, 205, 153],
	'minecraft:dirt': [120, 85, 58],
	'minecraft:oak_leaves': [55, 95, 40],
	'minecraft:spruce_leaves': [45, 80, 55],
	'minecraft:snow': [240, 240, 245],
	'minecraft:snow_block': [240, 240, 245],
	'minecraft:gravel': [130, 125, 120],
	'minecraft:deepslate': [70, 70, 75],
	'minecraft:netherrack': [110, 45, 45],
	'minecraft:end_stone': [220, 220, 160],
};

// Deterministic fallback colour so unmapped blocks are still distinguishable.
function hashColor(name: string): RGB {
	let h = 2166136261;
	for (let i = 0; i < name.length; i++) {
		h ^= name.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return [(h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff];
}

const BACKGROUND: RGB = [0, 0, 0];

export function colorFor(name: string | null): RGB {
	if (!name) return BACKGROUND;
	return COLORS[name] ?? hashColor(name);
}
