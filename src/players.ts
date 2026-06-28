// Live player tracking. Polls the Minecraft server over RCON for the online
// players and their positions, and broadcasts them to the viewer over a
// WebSocket so the map can show where everyone is.
//
// Entirely opt-in: it does nothing unless an RCON host + port are configured
// (RCON_HOST / RCON_PORT, with RCON_PASSWORD). Runs inside the renderer's
// service process (started from buildtiles) and can also run standalone:
//   node build/players.js
import { WebSocketServer, WebSocket } from 'ws';
import Rcon from 'ts-rcon';

// Poll cadence (seconds -> ms). Defaults to 2s, roughly matching how often the
// server moves players; floored at 1s so a typo can't hammer the server.
const POLL_MS = Math.max(1000, (Number(process.env.PLAYERS_POLL_INTERVAL) || 2) * 1000);

// Fixed WebSocket port. The viewer reaches it through its web server's /players
// reverse proxy (which hardcodes this), so it isn't meant to be reconfigured.
const WS_PORT = 8082;

export function playersEnabled(): boolean {
  return !!(process.env.RCON_HOST && process.env.RCON_PORT);
}

type Player = { name: string; x: number; y: number; z: number };
type Snapshot = { type: 'players'; t: number; players: Player[] };

// --- response parsing -------------------------------------------------------

// `list` -> "There are 2 of a max of 20 players online: Alice, Bob"
function parseList(resp: string): string[] {
  const m = /online:?\s*(.*)$/is.exec(resp);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

// `data get entity <name> Pos` -> "<name> has the following entity data:
// [123.5d, 64.0d, -42.3d]". parseFloat stops at the `d`/`f` NBT suffixes.
function parsePos(resp: string): [number, number, number] | null {
  const m = /\[([^\]]*)\]/.exec(resp);
  if (!m) return null;
  const n = m[1].split(',').map(s => parseFloat(s.trim()));
  if (n.length < 3 || n.some(v => Number.isNaN(v))) return null;
  return [n[0], n[1], n[2]];
}

// --- RCON client with a FIFO command queue ----------------------------------
// node-rcon multiplexes every command's reply through one 'response' event;
// because RCON runs over a single ordered TCP socket, replies come back in send
// order, so a queue of resolvers paired 1:1 with sends correlates them. (Replies
// larger than one packet would break this, but `list` / `Pos` are tiny.)
class RconClient {
  private client: Rcon | null = null;
  private authed = false;
  private connecting = false;
  private queue: { resolve: (s: string) => void; reject: (e: Error) => void }[] = [];

  get ready(): boolean {
    return this.authed && this.client !== null;
  }

  // Tear down the current connection and fail any in-flight commands. Listeners
  // are removed first so a disconnect can't re-enter this through 'end'.
  private reset(err: Error): void {
    const old = this.client;
    this.client = null;
    this.authed = false;
    this.connecting = false;
    if (old) {
      old.removeAllListeners();
      try { old.disconnect(); } catch { /* already gone */ }
    }
    const pending = this.queue;
    this.queue = [];
    for (const p of pending) p.reject(err);
  }

  ensureConnected(): void {
    if (this.client || this.connecting) return;
    this.connecting = true;
    const host = process.env.RCON_HOST as string;
    const port = Number(process.env.RCON_PORT);
    const password = process.env.RCON_PASSWORD ?? '';
    const c = new Rcon(host, port, password, { tcp: true });
    c.on('auth', () => {
      this.authed = true;
      this.connecting = false;
      console.log(`[players] RCON authenticated to ${host}:${port}`);
    });
    c.on('response', (str: string) => {
      const p = this.queue.shift();
      if (p) p.resolve(str);
    });
    c.on('error', (err: Error) => {
      console.error(`[players] RCON error: ${err.message}`);
      this.reset(err);
    });
    c.on('end', () => this.reset(new Error('RCON connection closed')));
    this.client = c;
    try { c.connect(); } catch (e) { this.reset(e instanceof Error ? e : new Error(String(e))); }
  }

  cmd(s: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.ready || !this.client) { reject(new Error('RCON not connected')); return; }
      this.queue.push({ resolve, reject });
      try { this.client.send(s); } catch (e) {
        this.queue.pop();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  close(): void {
    this.reset(new Error('shutting down'));
  }
}

// One poll tick: list players, then fetch each position. Reconnects lazily if
// the socket is down; a player leaving mid-poll just drops out of this tick.
async function poll(rcon: RconClient, emit: (s: Snapshot) => void): Promise<void> {
  if (!rcon.ready) { rcon.ensureConnected(); return; }
  let names: string[];
  try {
    names = parseList(await rcon.cmd('list'));
  } catch {
    return; // dropped between the ready check and the send; next tick retries
  }
  const players: Player[] = [];
  for (const name of names) {
    try {
      const pos = parsePos(await rcon.cmd(`data get entity ${name} Pos`));
      if (pos) players.push({ name, x: pos[0], y: pos[1], z: pos[2] });
    } catch { /* player left, or transient error — skip them this tick */ }
  }
  emit({ type: 'players', t: Date.now(), players });
}

// Start the WebSocket server + RCON polling loop. Returns a stop function, or
// null if tracking isn't configured (so a standalone run can exit cleanly).
export function startPlayerTracker(): (() => void) | null {
  if (!playersEnabled()) {
    console.log('[players] RCON not configured (set RCON_HOST + RCON_PORT) — player tracking disabled');
    return null;
  }
  if (!process.env.RCON_PASSWORD) {
    console.warn('[players] RCON_PASSWORD is not set; the server will likely reject authentication');
  }

  const wss = new WebSocketServer({ port: WS_PORT });
  let last: Snapshot = { type: 'players', t: 0, players: [] };

  wss.on('listening', () => console.log(`[players] WebSocket server listening on :${WS_PORT}`));
  wss.on('error', e => console.error(`[players] WebSocket server error: ${e.message}`));
  // Send the latest snapshot immediately so a new client isn't blank for one tick.
  wss.on('connection', ws => { try { ws.send(JSON.stringify(last)); } catch { /* ignore */ } });

  const emit = (snap: Snapshot): void => {
    last = snap;
    const msg = JSON.stringify(snap);
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch { /* client went away mid-send */ }
      }
    }
  };

  const rcon = new RconClient();
  rcon.ensureConnected();
  // Skip a tick if the previous poll is still running (slow/large server), so
  // commands can't pile up and overlap — each cycle is N+1 RCON commands.
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void poll(rcon, emit).finally(() => { polling = false; });
  }, POLL_MS);
  console.log(`[players] polling ${process.env.RCON_HOST}:${process.env.RCON_PORT} every ${POLL_MS / 1000}s`);

  return () => {
    clearInterval(timer);
    rcon.close();
    try { wss.close(); } catch { /* ignore */ }
  };
}

// Standalone entry point: run the tracker as its own process/container.
if (require.main === module) {
  const stop = startPlayerTracker();
  if (!stop) process.exit(0);
  const onSignal = (sig: string): void => {
    console.log(`[players] ${sig} received — stopping`);
    stop();
    process.exit(0);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}
