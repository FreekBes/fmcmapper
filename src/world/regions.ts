// Locating a world's region files. The folder layout changed with the multi-
// dimension rework: modern worlds use `dimensions/<ns>/<dim>/region`, older ones
// a flat `region` (overworld) / `DIM-1` (nether) / `DIM1` (end).

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';

export type RegionFile = { file: string; rx: number; rz: number };

// --- region folder resolution (modern layout + legacy fallback) -------------
export function regionDir(worldPath: string, dimension: string): string {
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

export function listRegions(dir: string): RegionFile[] {
  const out: RegionFile[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
    if (m) out.push({ file: join(dir, f), rx: +m[1], rz: +m[2] });
  }
  return out;
}
