import { parentPort, workerData } from 'worker_threads';
import { readFileSync } from 'fs';
import sharp from 'sharp';
sharp.concurrency(1);
import { AnvilParser } from 'mc-anvil';
import { topColumns, colorRGB, loadColorTable, EMPTY_HEIGHT } from './chunkmap';

const SIZE = 512; // one region = 512x512 blocks

type Job = { file: string; rx: number; rz: number };
export type TileResult = { rx: number; rz: number; png: Buffer | null };

const { file, rx, rz } = workerData as Job;

// Loaded once per worker. Override path with MAP_COLORS_PATH if needed.
const table = loadColorTable(process.env.MAP_COLORS_PATH);

const baseX = rx * SIZE;
const baseZ = rz * SIZE;
const name: (string | null)[] = new Array(SIZE * SIZE).fill(null);
const height = new Int32Array(SIZE * SIZE).fill(EMPTY_HEIGHT);
let any = false;

const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const chunks = new AnvilParser(ab).getAllChunks();

// Pass 1: fill per-region name + height grids.
for (const chunk of chunks) {
  const cols = topColumns(chunk, table);
  if (!cols) continue;
  for (let clz = 0; clz < 16; clz++) {
    for (let clx = 0; clx < 16; clx++) {
      const cc = clz * 16 + clx;
      const nm = cols.names[cc];
      if (nm === null) continue;
      const lx = cols.ox + clx - baseX;
      const lz = cols.oz + clz - baseZ;
      if (lx < 0 || lx >= SIZE || lz < 0 || lz >= SIZE) continue;
      const idx = lz * SIZE + lx;
      name[idx] = nm;
      height[idx] = cols.heights[cc];
      any = true;
    }
  }
}

async function run(): Promise<void> {
  let png: Buffer | null = null;
  if (any) {
    const rgba = new Uint8Array(SIZE * SIZE * 4);
    for (let lz = 0; lz < SIZE; lz++) {
      for (let lx = 0; lx < SIZE; lx++) {
        const idx = lz * SIZE + lx;
        const nm = name[idx];
        if (nm === null) continue;

        // Vanilla shading: compare against the block to the NORTH (-Z = up on
        // the tile). At the region's north edge the neighbour is in another
        // region (not available here) -> use the flat shade (1).
        let shadeIndex = 1;
        if (lz > 0) {
          const hN = height[(lz - 1) * SIZE + lx];
          if (hN !== EMPTY_HEIGHT) {
            const h = height[idx];
            shadeIndex = h > hN ? 2 : h < hN ? 0 : 1;
          }
        }

        const [r, g, b] = colorRGB(table, nm, shadeIndex);
        const p = idx * 4;
        rgba[p] = r;
        rgba[p + 1] = g;
        rgba[p + 2] = b;
        rgba[p + 3] = 255;
      }
    }
    png = await sharp(Buffer.from(rgba), { raw: { width: SIZE, height: SIZE, channels: 4 } })
      .png()
      .toBuffer();
  }
  parentPort!.postMessage({ rx, rz, png } as TileResult);
}

void run();
