import { readFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import { AnvilParser, Chunk } from 'mc-anvil';

const exists = async (p: string): Promise<boolean> => {
	try { await access(p); return true; } catch { return false; }
};

// New layout (current): <world>/dimensions/<ns>/<path>/region
// Legacy layout: <world>/region (overworld), DIM-1/region, DIM1/region
export const regionDir = async (worldPath: string, dimension: string): Promise<string> => {
	const [ns, path] = dimension.includes(':')
		? dimension.split(':') as [string, string]
		: ['minecraft', dimension];

	const modern = join(worldPath, 'dimensions', ns, path, 'region');
	if (await exists(modern)) return modern;

	const legacy: Record<string, string> = {
		'minecraft:overworld': join(worldPath, 'region'),
		'minecraft:the_nether': join(worldPath, 'DIM-1', 'region'),
		'minecraft:the_end': join(worldPath, 'DIM1', 'region'),
	};
	const fallback = legacy[`${ns}:${path}`];
	if (fallback && await exists(fallback)) return fallback;

	throw new Error(`No region folder for ${ns}:${path} (looked in ${modern})`);
};

export const readRegion = async (file: string): Promise<Chunk[]> => {
	const buf = await readFile(file);
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	return new AnvilParser(ab).getAllChunks();
};

export const loadDimension = async (
	worldPath: string,
	dimension = 'minecraft:overworld',
): Promise<Chunk[]> => {
	const dir = await regionDir(worldPath, dimension);
	const files = (await readdir(dir)).filter(f => f.endsWith('.mca'));
	const all: Chunk[] = [];
	for (const f of files) all.push(...await readRegion(join(dir, f)));
	return all;
};

export const forEachChunk = async (
	worldPath: string,
	dimension: string,
	fn: (chunk: Chunk, file: string) => void
): Promise<void> => {
	const dir = await regionDir(worldPath, dimension);
	const files = (await readdir(dir)).filter(f => f.endsWith('.mca'));
	for (const f of files) {
		for (const chunk of await readRegion(join(dir, f))) fn(chunk, f);
	}
};
