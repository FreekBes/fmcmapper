// Concurrency helpers: a fixed pool of persistent render workers, and a small
// bounded-parallelism runner for any async task.

import { Worker } from 'worker_threads';
import type { Job, TileResult } from './worker';

// A fixed set of persistent workers, fed one region job at a time. Reusing the
// threads (instead of spawning + terminating a Worker per region) avoids the
// per-region isolate spin-up and re-parsing the colour tables in every worker for
// every region — the worker loads those once at startup and handles many jobs.
export class WorkerPool {
  private readonly all = new Set<Worker>();
  private readonly idle: Worker[] = [];
  private readonly waiters: ((w: Worker) => void)[] = [];

  // `script` is the path to the built worker (worker.js); the caller resolves it
  // relative to its own location so this module doesn't assume the build layout.
  constructor(size: number, private readonly script: string) {
    for (let i = 0; i < size; i++) this.idle.push(this.spawn());
  }

  private spawn(): Worker {
    const w = new Worker(this.script);
    this.all.add(w);
    return w;
  }

  // Hand an idle worker to the next waiter, or park it until one asks.
  private release(w: Worker): void {
    const next = this.waiters.shift();
    if (next) next(w);
    else this.idle.push(w);
  }

  // A worker died mid-job: drop it and spin up a replacement so the pool keeps
  // its size (and its concurrency) for the rest of the run.
  private retire(w: Worker): void {
    this.all.delete(w);
    void w.terminate();
    this.release(this.spawn());
  }

  private acquire(): Promise<Worker> {
    const w = this.idle.pop();
    return w ? Promise.resolve(w) : new Promise<Worker>(res => this.waiters.push(res));
  }

  // Render one region on the next free worker. Resolves with its tile result;
  // rejects only if the worker itself crashes (processJob turns render failures
  // into a "skipped" result rather than throwing).
  run(job: Job): Promise<TileResult> {
    return this.acquire().then(w => new Promise<TileResult>((resolve, reject) => {
      const done = (): void => { w.off('message', onMsg); w.off('error', onErr); w.off('exit', onExit); };
      const onMsg = (msg: TileResult): void => { done(); this.release(w); resolve(msg); };
      const onErr = (err: Error): void => { done(); this.retire(w); reject(err); };
      const onExit = (code: number): void => { done(); this.retire(w); reject(new Error(`worker exited unexpectedly (code ${code})`)); };
      w.on('message', onMsg);
      w.on('error', onErr);
      w.on('exit', onExit);
      w.postMessage(job);
    }));
  }

  async destroy(): Promise<void> {
    const workers = [...this.all];
    this.all.clear();
    this.idle.length = 0;
    this.waiters.length = 0;
    await Promise.all(workers.map(w => w.terminate()));
  }
}

// Run `fn` over `items` with at most `limit` in flight, calling `onResult` for each.
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
  onResult: (r: R) => void,
): Promise<void> {
  let i = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length || 1)) },
    async () => {
      while (i < items.length) onResult(await fn(items[i++]));
    },
  );
  await Promise.all(runners);
}
