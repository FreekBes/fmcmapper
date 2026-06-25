import { Worker } from 'worker_threads';
import {
	readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { cpus } from 'os';
import { PNG } from 'pngjs';
import type { TileResult } from './worker';

const TILE = 512; // Leaflet tileSize; one base tile == one region

// --- region folder resolution (modern layout + legacy fallback) -------------
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

// --- worker pool ------------------------------------------------------------
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

// --- tile IO ----------------------------------------------------------------
function tilePath(root: string, z: number, x: number, y: number): string {
	return join(root, String(z), String(x), `${y}.png`);
}

function writeTile(root: string, z: number, x: number, y: number, rgba: Buffer, size: number): void {
	const png = new PNG({ width: size, height: size });
	rgba.copy(png.data);
	const p = tilePath(root, z, x, y);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, PNG.sync.write(png));
}

function readTile(root: string, z: number, x: number, y: number): Buffer | null {
	const p = tilePath(root, z, x, y);
	if (!existsSync(p)) return null;
	return PNG.sync.read(readFileSync(p)).data; // RGBA, TILE x TILE
}

function isEmpty(rgba: Uint8Array): boolean {
	for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return false;
	return true;
}

// Alpha-weighted 2x downscale: 1024x1024 RGBA -> 512x512 RGBA.
function halve(src: Buffer): Buffer {
	const S = TILE * 2;
	const out = Buffer.alloc(TILE * TILE * 4);
	for (let y = 0; y < TILE; y++) {
		for (let x = 0; x < TILE; x++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let dy = 0; dy < 2; dy++) {
				for (let dx = 0; dx < 2; dx++) {
					const si = ((y * 2 + dy) * S + (x * 2 + dx)) * 4;
					const sa = src[si + 3];
					r += src[si] * sa;
					g += src[si + 1] * sa;
					b += src[si + 2] * sa;
					a += sa;
				}
			}
			const di = (y * TILE + x) * 4;
			if (a > 0) {
				out[di] = Math.round(r / a);
				out[di + 1] = Math.round(g / a);
				out[di + 2] = Math.round(b / a);
				out[di + 3] = Math.round(a / 4);
			}
		}
	}
	return out;
}

// Copy a TILE x TILE child into a 1024x1024 buffer at child slot (dx, dy).
function blitChild(big: Buffer, child: Buffer, dx: number, dy: number): void {
	const S = TILE * 2;
	for (let row = 0; row < TILE; row++) {
		const srcStart = row * TILE * 4;
		const dstStart = ((dy * TILE + row) * S + dx * TILE) * 4;
		child.copy(big, dstStart, srcStart, srcStart + TILE * 4);
	}
}

// --- Leaflet viewer ---------------------------------------------------------
function indexHtml(maxZoom: number): string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Dimension map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body,#map{height:100%;margin:0;background:#0b0b0b}</style>
</head>
<body>
<div id="map"></div>
<script>
	var MAXZOOM = ${maxZoom};
	var map = L.map('map', { crs: L.CRS.Simple, minZoom: 0, maxZoom: MAXZOOM + 2 });
	L.tileLayer('tiles/{z}/{x}/{y}.png', {
		tileSize: ${TILE},
		minZoom: 0,
		maxZoom: MAXZOOM + 2,     // allow a couple of over-zoom steps (upscaled)
		maxNativeZoom: MAXZOOM,   // native tiles only exist up to here
		minNativeZoom: 0,
		noWrap: true
	}).addTo(map);
	map.setView([0, 0], 0);
</script>
</body>
</html>
`;
}

// --- main -------------------------------------------------------------------
async function main(): Promise<void> {
	const [worldPath, dimension = 'minecraft:overworld', outDir = 'tiles_out'] =
		process.argv.slice(2);
	if (!worldPath) {
		console.error('usage: node buildtiles.js <worldPath> [dimension] [outDir]');
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
	const Tx = maxRx - minRx + 1;
	const Ty = maxRz - minRz + 1;
	const MAXZOOM = Math.ceil(Math.log2(Math.max(Tx, Ty, 1))); // z=0 == single root tile
	const tilesRoot = join(outDir, 'tiles');
	mkdirSync(tilesRoot, { recursive: true });

	console.error(`regions: ${regions.length}, base grid: ${Tx}x${Ty}, zooms: 0..${MAXZOOM}`);

	// Phase 1: native-zoom base tiles, one per (non-empty) region.
	let written = 0;
	await pool(regions, cpus().length, runWorker, ({ rx, rz, tile }) => {
		if (isEmpty(tile)) return;
		writeTile(tilesRoot, MAXZOOM, rx - minRx, rz - minRz, Buffer.from(tile.buffer), TILE);
		if (++written % 20 === 0) console.error(`base tiles: ${written}`);
	});
	console.error(`base tiles written: ${written}`);

	// Phase 2: build overviews by halving, zoom by zoom, from disk.
	for (let z = MAXZOOM - 1; z >= 0; z--) {
		const span = 2 ** (MAXZOOM - z);
		const nx = Math.ceil(Tx / span);
		const ny = Math.ceil(Ty / span);
		let made = 0;
		for (let x = 0; x < nx; x++) {
			for (let y = 0; y < ny; y++) {
				const big = Buffer.alloc(TILE * 2 * TILE * 2 * 4);
				let any = false;
				for (let dy = 0; dy < 2; dy++) {
					for (let dx = 0; dx < 2; dx++) {
						const child = readTile(tilesRoot, z + 1, x * 2 + dx, y * 2 + dy);
						if (child) {
							blitChild(big, child, dx, dy);
							any = true;
						}
					}
				}
				if (!any) continue;
				writeTile(tilesRoot, z, x, y, halve(big), TILE);
				made++;
			}
		}
		console.error(`zoom ${z}: ${made} tiles`);
	}

	writeFileSync(join(outDir, 'index.html'), indexHtml(MAXZOOM));
	console.error(`done. serve ${outDir}/ and open index.html`);
}


main().catch(e => {
	console.error(e);
	process.exit(1);
});
