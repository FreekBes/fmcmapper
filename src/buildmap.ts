import { Worker } from 'worker_threads';
import { readdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cpus } from 'os';
import { PNG } from 'pngjs';
import type { TileResult } from './worker';

const SIZE = 512;

// New layout: <world>/dimensions/<ns>/<path>/region ; legacy fallbacks below.
function regionDir(worldPath: string, dimension: string): string {
	const [ns, p] = (dimension.includes(':')
		? dimension.split(':')
		: ['minecraft', dimension]) as [string, string];
	const modern = join(worldPath, 'dimensions', ns, p, 'region');
	if (existsSync(modern)) return modern;
	const legacy: Record<string, string> = {
		'minecraft:overworld': join(worldPath, 'region'),
		'minecraft:the_nether': join(worldPath, 'DIM-1', 'region'),
		'minecraft:the_end': join(worldPath, 'DIM1', 'region'),
	};
	const fb = legacy[`${ns}:${p}`];
	if (fb && existsSync(fb)) return fb;
	throw new Error(`No region folder for ${ns}:${p} (looked in ${modern})`);
}

type RegionFile = { file: string; rx: number; rz: number };

function listRegions(dir: string): RegionFile[] {
	const out: RegionFile[] = [];
	for (const f of readdirSync(dir)) {
		const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
		if (m) out.push({ file: join(dir, f), rx: +m[1], rz: +m[2] });
	}
	return out;
}

function runWorker(job: RegionFile): Promise<TileResult> {
	return new Promise((resolve, reject) => {
		const w = new Worker(join(__dirname, 'worker.js'), { workerData: job });
		w.once('message', (msg: TileResult) => {
			resolve(msg);
			void w.terminate();
		});
		w.once('error', reject);
	});
}

async function pool<T, R>(
	items: T[],
	limit: number,
	fn: (t: T) => Promise<R>,
	onResult: (r: R) => void,
): Promise<void> {
	let i = 0;
	const runners = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			while (i < items.length) onResult(await fn(items[i++]));
		},
	);
	await Promise.all(runners);
}

async function main(): Promise<void> {
	const [worldPath, dimension = 'minecraft:overworld', outPath = 'map.png'] =
		process.argv.slice(2);
	if (!worldPath) {
		console.error('usage: node buildmap.js <worldPath> [dimension] [out.png]');
		process.exit(1);
	}

	const regions = listRegions(regionDir(worldPath, dimension));
	if (regions.length === 0) {
		console.error('no region files found');
		process.exit(1);
	}

	const minRx = Math.min(...regions.map(r => r.rx));
	const maxRx = Math.max(...regions.map(r => r.rx));
	const minRz = Math.min(...regions.map(r => r.rz));
	const maxRz = Math.max(...regions.map(r => r.rz));
	const W = (maxRx - minRx + 1) * SIZE;
	const H = (maxRz - minRz + 1) * SIZE;
	console.error(`regions: ${regions.length}, image: ${W}x${H} (${((W * H * 4) / 1e6).toFixed(0)} MB)`);

	const png = new PNG({ width: W, height: H }); // png.data is zero-filled (transparent)
	let done = 0;

	await pool(regions, cpus().length, runWorker, ({ rx, rz, tile }) => {
		const offX = (rx - minRx) * SIZE;
		const offZ = (rz - minRz) * SIZE;
		for (let lz = 0; lz < SIZE; lz++) {
			for (let lx = 0; lx < SIZE; lx++) {
				const src = (lz * SIZE + lx) * 3;
				const dst = ((offZ + lz) * W + (offX + lx)) * 4;
				png.data[dst] = tile[src];
				png.data[dst + 1] = tile[src + 1];
				png.data[dst + 2] = tile[src + 2];
				png.data[dst + 3] = 255;
			}
		}
		if (++done % 10 === 0) console.error(`${done}/${regions.length}`);
	});

	writeFileSync(outPath, PNG.sync.write(png));
	console.error(`wrote ${outPath}`);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
