// Reading spawn + version out of a world's level.dat. Spawn moved from the
// SpawnX/SpawnY/SpawnZ scalars to an IntArray at Data/spawn/pos; we read either.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { NBTParser, findChildTagAtPath } from 'mc-anvil';
import type { TagData } from 'mc-anvil';

export type WorldVersion = { name: string | null; dataVersion: number | null };

export function readLevel(worldPath: string): {
  spawn: { x: number; z: number } | null;
  version: WorldVersion | null;
} {
  const f = join(worldPath, 'level.dat');
  if (!existsSync(f)) return { spawn: null, version: null };
  try {
    const buf = readFileSync(f);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const root = new NBTParser(ab).getTag() as TagData; // NBTParser auto-gunzips

    let spawn: { x: number; z: number } | null = null;
    const pos = findChildTagAtPath('Data/spawn/pos', root);
    if (pos && Array.isArray(pos.data) && pos.data.length >= 3) {
      spawn = { x: Number(pos.data[0]), z: Number(pos.data[2]) };
    } else {
      const sx = findChildTagAtPath('Data/SpawnX', root);
      const sz = findChildTagAtPath('Data/SpawnZ', root);
      if (sx && sz) spawn = { x: Number(sx.data), z: Number(sz.data) };
    }

    const nameT = findChildTagAtPath('Data/Version/Name', root);
    const dvT = findChildTagAtPath('Data/DataVersion', root);
    const name = nameT && typeof nameT.data === 'string' ? nameT.data : null;
    const dataVersion = dvT && (typeof dvT.data === 'number' || typeof dvT.data === 'bigint')
      ? Number(dvT.data)
      : null;
    const version = name !== null || dataVersion !== null ? { name, dataVersion } : null;

    return { spawn, version };
  } catch {
    return { spawn: null, version: null };
  }
}
