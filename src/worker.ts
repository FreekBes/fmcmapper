import { parentPort, workerData } from 'worker_threads';
import { readFileSync } from 'fs';
import sharp from 'sharp';
import { AnvilParser } from 'mc-anvil';
import { topColumns, colorFor } from './chunkmap';

const SIZE = 512; // one region = 512x512 blocks

type Job = { file: string; rx: number; rz: number };
export type TileResult = { rx: number; rz: number; png: Buffer | null };

const { file, rx, rz } = workerData as Job;

const rgba = new Uint8Array(SIZE * SIZE * 4); // default transparent
const baseX = rx * SIZE;
const baseZ = rz * SIZE;
let any = false;

const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const chunks = new AnvilParser(ab).getAllChunks();

for (const chunk of chunks) {
  const cols = topColumns(chunk);
  if (!cols) continue;
  for (let clz = 0; clz < 16; clz++) {
    for (let clx = 0; clx < 16; clx++) {
      const name = cols.names[clz * 16 + clx];
      if (name === null) continue;
      const lx = cols.ox + clx - baseX;
      const lz = cols.oz + clz - baseZ;
      if (lx < 0 || lx >= SIZE || lz < 0 || lz >= SIZE) continue;
      const [r, g, b] = colorFor(name);
      const p = (lz * SIZE + lx) * 4;
      rgba[p] = r;
      rgba[p + 1] = g;
      rgba[p + 2] = b;
      rgba[p + 3] = 255;
      any = true;
    }
  }
}

async function run(): Promise<void> {
  let png: Buffer | null = null;
  if (any) {
    png = await sharp(Buffer.from(rgba), {
      raw: { width: SIZE, height: SIZE, channels: 4 },
    }).png().toBuffer();
  }
  const result: TileResult = { rx, rz, png };
  parentPort!.postMessage(result);
}

void run();
