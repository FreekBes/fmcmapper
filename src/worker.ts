import { parentPort, workerData } from 'worker_threads';
import { readFileSync } from 'fs';
import { AnvilParser } from 'mc-anvil';
import { topColumns, colorFor } from './chunkmap';

const SIZE = 512; // one region = 512x512 blocks

type Job = { file: string; rx: number; rz: number };
export type TileResult = { rx: number; rz: number; tile: Uint8Array }; // RGBA

const { file, rx, rz } = workerData as Job;

const tile = new Uint8Array(SIZE * SIZE * 4); // fresh, transferable; default transparent
const baseX = rx * SIZE;
const baseZ = rz * SIZE;

const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const chunks = new AnvilParser(ab).getAllChunks();

for (const chunk of chunks) {
	const cols = topColumns(chunk);
	if (!cols) continue;
	for (let clz = 0; clz < 16; clz++) {
		for (let clx = 0; clx < 16; clx++) {
			const name = cols.names[clz * 16 + clx];
			if (name === null) continue; // leave transparent
			const lx = cols.ox + clx - baseX;
			const lz = cols.oz + clz - baseZ;
			if (lx < 0 || lx >= SIZE || lz < 0 || lz >= SIZE) continue;
			const [r, g, b] = colorFor(name);
			const p = (lz * SIZE + lx) * 4;
			tile[p] = r;
			tile[p + 1] = g;
			tile[p + 2] = b;
			tile[p + 3] = 255;
		}
	}
}

const result: TileResult = { rx, rz, tile };
parentPort!.postMessage(result, [tile.buffer]);
