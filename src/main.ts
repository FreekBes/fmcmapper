// Entry point for the tiling service. Parses inputs, then either renders once and
// exits, or (in service mode) re-renders on an interval alongside live player
// tracking. The render pass itself lives in tiles/render.ts.

import { existsSync, statSync } from 'fs';
import { setFlagsFromString } from 'v8';
import { runInNewContext } from 'vm';
import { render } from './tiles/render';
import { startPlayerTracker } from './players';

// Expose global.gc without needing to launch node with --expose-gc, so the
// after-pass GC nudge (see the service loop) works out of the box. If the flag
// was already passed, global.gc is set; otherwise flip it on and grab the
// function. Best-effort — the caller uses `globalThis.gc?.()`, so a failure here
// just means the nudge is a no-op.
if (typeof globalThis.gc !== 'function') {
  try {
    setFlagsFromString('--expose-gc');
    globalThis.gc = runInNewContext('gc') as typeof globalThis.gc;
  } catch { /* couldn't enable GC; the after-pass nudge becomes a no-op */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // Inputs come from positional args, falling back to env vars. Args take
  // precedence so a CLI invocation can override the environment. The optional
  // --once flag forces a single render and exit, even if RENDER_INTERVAL is set.
  const rawArgs = process.argv.slice(2);
  const once = rawArgs.includes('--once');
  const [argWorld, argDimension, argOut] = rawArgs.filter(a => a !== '--once');
  const worldPath = argWorld ?? process.env.WORLD_PATH ?? './world';
  const dimension = argDimension ?? process.env.DIMENSION ?? 'minecraft:overworld';
  const outDir = argOut ?? process.env.OUTPUT_PATH ?? './output';

  // Check if the world path exists and is a directory.
  if (!existsSync(worldPath) || !statSync(worldPath).isDirectory()) {
    console.error(`world path does not exist or is not a directory: ${worldPath}`);
    process.exit(1);
  }

  // Service mode: when RENDER_INTERVAL (minutes) is set, keep re-rendering so a
  // live world's tiles stay fresh — each pass is incremental, so unchanged
  // regions are skipped. Unset or 0 -> render once and exit (one-shot).
  const intervalMin = once ? 0 : Math.max(0, Number(process.env.RENDER_INTERVAL) || 0);
  if (!intervalMin) {
    console.log('one-shot mode: rendering once and exiting');
    await render(worldPath, dimension, outDir);
    return;
  }

  console.log(`service mode: rendering now, then every ${intervalMin}min`);
  // Live player tracking runs alongside the render loop in this same process —
  // a no-op (returns null) unless RCON is configured. See players.ts.
  const stopPlayers = startPlayerTracker();
  // Stop immediately on signal, abandoning any in-progress render — we don't
  // need a complete tile set at all times; the next run picks up where it left
  // off (the manifest is only updated on a fully completed render).
  const onSignal = (sig: string) => {
    console.log(`${sig} received — stopping`);
    stopPlayers?.();
    process.exit(0);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  for (;;) {
    try {
      console.log(`render pass starting at ${new Date().toISOString()}`);
      await render(worldPath, dimension, outDir);
    } catch (e) {
      console.error(`render failed (will retry in ${intervalMin}min):`, e instanceof Error ? e.message : e);
    }
    // A full pass churns through a lot of transient buffers; nudge V8 to hand the
    // heap high-water mark back to the OS before the long idle sleep. gc is enabled
    // at startup (see the v8/vm shim above), so this normally runs.
    globalThis.gc?.();
    console.log(`render service sleeping for ${intervalMin}min`);
    await sleep(intervalMin * 60000);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
