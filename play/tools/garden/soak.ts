// Garden Sentinels network soak test. Starts nothing itself: it connects to a running play backend, creates rooms
// (co-op and versus, various maps, bots), joins 1-6 fake human WebSocket clients per room, starts matches and lets
// the fakes play (build near paths, upgrade, sell, retarget, ready, sends, map pings, latency pings). One client per
// "chaos" room also sends garbage and malicious messages; probes check flood limits, oversized frames, full rooms
// and bad room codes. It measures traffic per client, snapshot sizes, snapshot timing (server tick from the
// snapshots' own `t`), dropped snapshots, errors, closes, backend memory/CPU, and whether matches end properly.
//
//   node24 backend/node_modules/tsx/dist/cli.mjs tools/garden/soak.ts --url http://127.0.0.1:3228
//        [--rooms 6] [--minutes 5] [--pid <backend pid>] [--log <backend log file>] [--no-drain] [--verbose] [--strict]
//
// (run from play/). Start the backend with CREATE_RATE_LIMIT=1000 or room creation hits the 10/min/IP limit.
// Exits 1 on failures: backend unreachable, room loop stall > 1 s, unexpected 'error' messages or closes, corrupt
// snapshot fields, ownership violations, matches that never return to the waiting state, exceptions in --log.
//
// A stall is only blamed on the server when this process kept running meanwhile: the soak measures its own event
// loop lag, and a stall during which it was frozen too is a host stall (CPU starvation of the whole machine),
// reported separately and a failure only with --strict. With --pid on Windows it also samples machine CPU load.
//
// Byte counts are WebSocket payload bytes (UTF-8), without frame headers (2-4 bytes per message) or TCP/IP.

import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { G } from '../../backend/src/shared/garden/constants.js';
import { gmapById, type GMapDef } from '../../backend/src/shared/garden/maps.js';
import { boardOrigin, cellToWorld } from '../../backend/src/shared/garden/board.js';
import { TOWERS, type TowerKind } from '../../backend/src/shared/garden/towers.js';
import { SENDS } from '../../backend/src/shared/garden/enemies.js';
import type { BoardInfo, GEvent, GSnapshot, GardenServerMsg, TowerInfo } from '../../backend/src/shared/garden/protocol.js';
import type { RoomView, ServerMsg } from '../../backend/src/shared/protocol.js';

// ---- options ----------------------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name: string) => args.includes(`--${name}`);

const BASE = opt('url', 'http://127.0.0.1:3004').replace(/\/$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
const ROOMS = Math.max(1, Number(opt('rooms', '6')));
const MINUTES = Number(opt('minutes', '5'));
const PID = opt('pid', '');
const LOG = opt('log', '');
const DRAIN = !flag('no-drain');
const VERBOSE = flag('verbose');
/** Count stalls that the soak process itself also suffered (host CPU starvation) as failures too. */
const STRICT = flag('strict');

const T0 = Date.now();
const elapsed = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
const log = (s: string) => console.log(`[${elapsed()}s] ${s}`);
const vlog = (s: string) => VERBOSE && log(s);

const failures: string[] = [];
const warnings: string[] = [];
const fail = (s: string) => {
  if (failures.length < 500) failures.push(s);
  log(`FAIL ${s}`);
};
const warn = (s: string) => {
  if (warnings.length < 500) warnings.push(s);
  vlog(`warn ${s}`);
};

const rand = Math.random;
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pct(a: number[], p: number) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sd = (a: number[]) => {
  const m = mean(a);
  return a.length ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) : NaN;
};
const f0 = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : '-');
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '-');

function table(head: string[], rows: (string | number)[][]) {
  const cells = [head, ...rows.map((r) => r.map(String))];
  const w = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of cells.slice(1)) console.log(line(r));
}

// ---- own event loop lag (to tell server stalls from machine-wide ones) ------------------------------------------

const lagEvents: { at: number; lag: number }[] = [];
let lagMax = 0;
{
  let expect = Date.now() + 50;
  setInterval(() => {
    const now = Date.now();
    const lag = now - expect;
    expect = now + 50;
    lagMax = Math.max(lagMax, lag);
    if (lag > 150) lagEvents.push({ at: now, lag });
  }, 50).unref();
}
/** Longest freeze of this process overlapping [t0, t1] (ms, wall clock). */
function harnessLagDuring(t0: number, t1: number) {
  let m = 0;
  for (const e of lagEvents) if (e.at >= t0 && e.at - e.lag <= t1) m = Math.max(m, Math.min(e.at, t1) - Math.max(e.at - e.lag, t0));
  return m;
}

// ---- HTTP -------------------------------------------------------------------------------------------------------

async function http(method: string, path: string, body?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body,
    signal: AbortSignal.timeout(5000),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, json };
}

// ---- room templates ---------------------------------------------------------------------------------------------

type Style = 'play' | 'rush';
interface Template {
  mode: 'coop' | 'vs';
  map: string;
  humans: number;
  bots: number;
  diff: 'easy' | 'normal' | 'hard';
  /** play: build/upgrade/sell like a person; rush: never build, always ready (the match ends fast). */
  style: Style;
  /** The last human also sends garbage and malicious messages. */
  chaos?: boolean;
  /** A non-host human leaves and rejoins mid-match every ~40 s. */
  churn?: boolean;
  /** The host stops the first match after this many seconds. */
  stopAfter?: number;
}

const TEMPLATES: Template[] = [
  { mode: 'coop', map: 'greenhouse-commons', humans: 1, bots: 2, diff: 'normal', style: 'play' },
  { mode: 'vs', map: 'seedling-plot', humans: 3, bots: 1, diff: 'hard', style: 'play', chaos: true, churn: true },
  { mode: 'coop', map: 'random', humans: 4, bots: 0, diff: 'normal', style: 'rush', chaos: true },
  { mode: 'vs', map: 'pebble-loop', humans: 6, bots: 0, diff: 'normal', style: 'play', chaos: true },
  { mode: 'coop', map: 'moonlit-orchard', humans: 2, bots: 3, diff: 'easy', style: 'play', stopAfter: 75 },
  { mode: 'vs', map: 'twin-beds', humans: 2, bots: 1, diff: 'hard', style: 'rush' },
  { mode: 'coop', map: 'koi-crossing', humans: 5, bots: 1, diff: 'hard', style: 'play', churn: true, chaos: true },
  { mode: 'vs', map: 'sprout-spiral', humans: 1, bots: 5, diff: 'normal', style: 'play' },
  { mode: 'coop', map: 'lily-moat', humans: 3, bots: 0, diff: 'normal', style: 'play' },
  { mode: 'vs', map: 'random', humans: 4, bots: 2, diff: 'easy', style: 'rush', chaos: true },
];

// ---- map helpers ------------------------------------------------------------------------------------------------

const WALK = new Set(['#', '=']);
const nearCache = new Map<string, [number, number][]>();
/** Buildable cells within 2 cells of a path cell (where a person would build). */
function nearPathCells(def: GMapDef): [number, number][] {
  let out = nearCache.get(def.id);
  if (out) return out;
  out = [];
  const H = def.grid.length;
  const W = def.grid[0].length;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (def.grid[y][x] !== '.') continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) near = WALK.has(def.grid[y + dy]?.[x + dx] ?? '');
      if (near) out.push([x, y]);
    }
  nearCache.set(def.id, out);
  return out;
}

// ---- stats ------------------------------------------------------------------------------------------------------

interface TypeStat {
  n: number;
  bytes: number;
}
const typeStats = { coop: new Map<string, TypeStat>(), vs: new Map<string, TypeStat>() };
const snapSizes = { coop: [] as number[], vs: [] as number[] };
const errorTexts = new Map<string, number>();
const denyTexts = new Map<string, number>();

interface ClientStats {
  rxBytes: number;
  rxMsgs: number;
  txBytes: number;
  txMsgs: number;
  snaps: number;
  /** Client-side snapshot inter-arrival (ms). */
  gaps: number[];
  /** Date.now() - snapshot.t on arrival (same machine, so the clock is shared). */
  lat: number[];
  rtt: number[];
  dropped: number;
  denies: number;
  errors: number;
  connectedMs: number;
}
const newStats = (): ClientStats => ({ rxBytes: 0, rxMsgs: 0, txBytes: 0, txMsgs: 0, snaps: 0, gaps: [], lat: [], rtt: [], dropped: 0, denies: 0, errors: 0, connectedMs: 0 });

// ---- fake human -------------------------------------------------------------------------------------------------

const EXPECTED_CHAOS_ERRORS = [/only the host/i, /change the mode between matches/i, /already running/i];

class Fake {
  ws?: WebSocket;
  id = '';
  stats = newStats();
  open = false;
  openedAt = 0;
  /** Set when this client is closed on purpose (churn, end of soak, probe). */
  leaving = false;
  closeInfo?: { code: number; reason: string };
  welcome?: Promise<void>;
  private welcomeResolve?: () => void;
  // game view
  def?: GMapDef;
  boards: BoardInfo[] = [];
  myBoard = -1;
  towers = new Map<number, TowerInfo>();
  snap?: GSnapshot;
  lastSnapAt = 0;
  lastTick = -1;
  ended = false;
  private thinkTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private pingAt = new Map<number, number>();

  constructor(
    readonly room: RoomRun,
    readonly name: string,
    readonly chaos: boolean,
  ) {}

  get mode() {
    return this.room.t.mode;
  }
  get isHost() {
    return this.room.view?.hostId === this.id;
  }

  connect(): Promise<void> {
    this.welcome = new Promise((res) => (this.welcomeResolve = res));
    const ws = new WebSocket(`${WS_BASE}/api/ws?room=${this.room.code}&name=${encodeURIComponent(this.name)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.openedAt = Date.now();
      this.pingTimer = setInterval(() => this.latencyPing(), 2000);
      this.thinkTimer = setTimeout(() => this.thinkLoop(), 500 + rand() * 1000);
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      this.onRaw(data);
    };
    ws.onclose = (ev) => {
      if (this.open) this.stats.connectedMs += Date.now() - this.openedAt;
      this.open = false;
      clearInterval(this.pingTimer);
      clearTimeout(this.thinkTimer);
      this.closeInfo = { code: ev.code, reason: ev.reason };
      this.room.onClientClosed(this, ev.code, ev.reason);
      this.welcomeResolve?.();
    };
    ws.onerror = () => {
      /* followed by close */
    };
    return this.welcome;
  }

  send(obj: unknown) {
    this.sendRaw(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  sendRaw(s: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(s);
    this.stats.txMsgs++;
    this.stats.txBytes += Buffer.byteLength(s);
  }

  close() {
    this.leaving = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.thinkTimer);
    try {
      this.ws?.close(1000, 'soak done');
    } catch {
      /* ignore */
    }
  }

  private latencyPing() {
    const at = Math.round(performance.now() * 1000) / 1000;
    this.pingAt.set(at, Date.now());
    this.send({ t: 'ping', at });
  }

  private onRaw(data: string) {
    const bytes = Buffer.byteLength(data);
    this.stats.rxBytes += bytes;
    this.stats.rxMsgs++;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(data);
    } catch {
      fail(`${this.room.code}/${this.name}: unparseable server message (${data.slice(0, 80)})`);
      return;
    }
    const type = msg.t === 'g' ? `g.${(msg.m as { k?: string }).k}` : msg.t;
    const ts = typeStats[this.mode];
    const st = ts.get(type) ?? { n: 0, bytes: 0 };
    st.n++;
    st.bytes += bytes;
    ts.set(type, st);

    switch (msg.t) {
      case 'welcome':
        this.id = msg.you;
        this.room.view = msg.room;
        this.welcomeResolve?.();
        return;
      case 'room':
        this.room.onRoomView(this, msg.room);
        return;
      case 'pong': {
        const sent = this.pingAt.get(msg.at);
        if (sent !== undefined) {
          this.stats.rtt.push(Date.now() - sent);
          this.pingAt.delete(msg.at);
        }
        return;
      }
      case 'error': {
        this.stats.errors++;
        errorTexts.set(msg.message, (errorTexts.get(msg.message) ?? 0) + 1);
        const expected = this.chaos && EXPECTED_CHAOS_ERRORS.some((r) => r.test(msg.message));
        if (!expected && !this.leaving && !this.room.expectingClose.has(this)) fail(`${this.room.code}/${this.name}: unexpected error message "${msg.message}"`);
        return;
      }
      case 'closed':
      case 'chat':
        return;
      case 'g':
        this.onGame(msg.m as unknown as GardenServerMsg, bytes);
        return;
    }
  }

  private onGame(m: GardenServerMsg, bytes: number) {
    switch (m.k) {
      case 'init': {
        this.def = gmapById(m.map.id);
        if (!this.def) fail(`${this.room.code}: init names unknown map ${m.map.id}`);
        this.boards = m.boards;
        this.myBoard = m.myBoard ?? -1;
        this.towers = new Map(m.towers.map((t) => [t.id, { ...t }]));
        this.ended = false;
        this.lastTick = -1;
        this.lastSnapAt = 0;
        this.snap = undefined;
        if (this === this.room.observer()) this.room.onInit(m.map.id);
        return;
      }
      case 'snap':
        this.onSnap(m.s, bytes);
        return;
      case 'ev':
        for (const e of m.e) this.onEvent(e);
        return;
      case 'end':
        if (this.ended) fail(`${this.room.code}/${this.name}: 'end' received twice`);
        this.ended = true;
        if (this === this.room.observer()) this.room.onEnd(m.win, m.winner, m.wave);
        return;
      case 'score':
        return;
    }
  }

  private onSnap(s: GSnapshot, bytes: number) {
    const now = Date.now();
    this.stats.snaps++;
    snapSizes[this.mode].push(bytes);
    if (this.ended) this.room.snapsAfterEnd++;
    if (this.lastSnapAt) this.stats.gaps.push(now - this.lastSnapAt);
    this.lastSnapAt = now;
    this.stats.lat.push(now - s.t);
    if (this.lastTick >= 0) {
      const dt = s.tick - this.lastTick;
      if (dt > G.snapEvery) this.stats.dropped += Math.round(dt / G.snapEvery) - 1;
      if (dt <= 0) fail(`${this.room.code}/${this.name}: snapshot tick went from ${this.lastTick} to ${s.tick}`);
    }
    this.lastTick = s.tick;
    if (this === this.room.observer()) this.room.onObserverSnap(s);
    this.snap = s;
    // Sanity: NaN turns into null on the wire.
    const bad = (v: unknown) => typeof v !== 'number' || !Number.isFinite(v);
    for (const p of s.pl) if (bad(p.gold) || p.gold < 0 || bad(p.inc) || bad(p.b)) this.room.corrupt(`player ${p.id} gold=${p.gold} inc=${p.inc} b=${p.b}`);
    for (const b of s.bd) if (bad(b.lives)) this.room.corrupt(`board ${b.b} lives=${b.lives}`);
    for (const e of s.en) if (bad(e.d) || bad(e.hp) || bad(e.o) || bad(e.r)) this.room.corrupt(`enemy ${e.id} d=${e.d} hp=${e.hp} o=${e.o}`);
    if (bad(s.left) || bad(s.wave) || bad(s.t)) this.room.corrupt(`left=${s.left} wave=${s.wave}`);
  }

  private onEvent(e: GEvent) {
    const isObs = this === this.room.observer();
    switch (e.k) {
      case 'build':
        if (isObs && this.towers.has(e.t.id)) fail(`${this.room.code}: tower id ${e.t.id} built twice`);
        this.towers.set(e.t.id, { ...e.t });
        return;
      case 'up': {
        const t = this.towers.get(e.id);
        if (t) {
          if (isObs && this.mode === 'vs' && this.boards[t.b]?.own !== e.by && t.own !== e.by) fail(`${this.room.code}: ${e.by} upgraded tower ${e.id} on someone else's board ${t.b}`);
          t.lv = e.lv;
          t.spent = e.spent;
        }
        return;
      }
      case 'sell': {
        const t = this.towers.get(e.id);
        if (t && isObs) {
          const ok = t.own === e.by || (this.mode === 'vs' && this.boards[t.b]?.own === e.by);
          if (!ok) fail(`${this.room.code}: ${e.by} sold tower ${e.id} owned by ${t.own}`);
        }
        this.towers.delete(e.id);
        return;
      }
      case 'tm': {
        const t = this.towers.get(e.id);
        if (t) t.tm = e.tm;
        return;
      }
      case 'deny':
        if (e.id !== this.id) fail(`${this.room.code}/${this.name}: received a deny meant for ${e.id}`);
        this.stats.denies++;
        denyTexts.set(e.why, (denyTexts.get(e.why) ?? 0) + 1);
        return;
      case 'gold':
        if (isObs && (!Number.isFinite(e.n) || e.n < 0)) this.room.corrupt(`gold event n=${e.n}`);
        return;
    }
  }

  // ---- behaviour ----

  private thinkLoop() {
    if (!this.open) return;
    try {
      this.think();
    } catch (err) {
      fail(`${this.room.code}/${this.name}: soak client bug ${(err as Error).stack}`);
    }
    this.thinkTimer = setTimeout(() => this.thinkLoop(), 600 + rand() * 1200);
  }

  private me() {
    return this.snap?.pl.find((p) => p.id === this.id);
  }

  private game(m: unknown) {
    this.send({ t: 'g', m });
  }

  private think() {
    if (this.chaos) for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n; i++) this.sendRaw(this.garbage());
    const s = this.snap;
    const me = this.me();
    if (!s || !this.def || this.ended || s.ph === 'over' || !me) return;
    const board = me.b;
    if (this.mode === 'vs' && rand() < 0.12) this.game({ k: 'view', b: Math.floor(rand() * this.boards.length) });
    if (board < 0) return;
    if (rand() < 0.08) this.mapPing(board);
    if (this.room.t.style === 'rush') {
      if (s.ph === 'build' && me.rd === 0) this.game({ k: 'ready' });
      return;
    }
    const gold = me.gold;
    const mine = [...this.towers.values()].filter((t) => t.b === board);
    const own = mine.filter((t) => t.own === this.id);
    const r = rand();
    if (r < 0.5) {
      const kind = pick<TowerKind>(['laser', 'laser', 'laser', 'missile', 'missile', 'slow', 'shield', 'beacon']);
      const cost = TOWERS[kind].levels[0].cost;
      if (gold >= cost) {
        const taken = new Set(mine.map((t) => t.y * 1000 + t.x));
        const free = nearPathCells(this.def).filter(([x, y]) => !taken.has(y * 1000 + x));
        // A plausible miss now and then: a cell somebody just took.
        const cell = free.length && rand() > 0.05 ? pick(free) : pick(nearPathCells(this.def));
        if (cell) this.game({ k: 'build', t: kind, x: cell[0], y: cell[1] });
      }
    } else if (r < 0.7) {
      const pool = (this.mode === 'coop' ? mine : own).filter((t) => t.lv < 3 && TOWERS[t.k].levels[t.lv].cost <= gold);
      if (pool.length) this.game({ k: 'up', id: pick(pool).id });
    } else if (r < 0.75) {
      if (own.length > 2) this.game({ k: 'sell', id: pick(own).id });
    } else if (r < 0.8) {
      const tg = own.filter((t) => TOWERS[t.k].targets);
      if (tg.length) this.game({ k: 'tm', id: pick(tg).id, tm: Math.floor(rand() * 4) });
    }
    if (this.mode === 'vs' && s.wave >= 1 && rand() < 0.3) {
      const opts = SENDS.filter((d) => d.from <= s.wave + 1 && d.cost <= gold * 0.6);
      if (opts.length) {
        const living = this.boards.filter((b) => b.b !== board && !s.bd.find((x) => x.b === b.b)?.out).map((b) => b.b);
        const to = living.length && rand() < 0.5 ? pick(living) : undefined;
        this.game(to === undefined ? { k: 'send', e: pick(opts).kind } : { k: 'send', e: pick(opts).kind, to });
      }
    }
    if (s.ph === 'build' && me.rd === 0 && rand() < 0.2) this.game({ k: 'ready' });
  }

  private mapPing(board: number) {
    if (!this.def) return;
    const o = boardOrigin(this.def, board, this.boards.length);
    const p = cellToWorld(this.def, o, rand() * this.def.grid[0].length, rand() * this.def.grid.length);
    this.game({ k: 'ping', x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 });
  }

  private garbage(): string {
    const others = [...this.towers.values()].filter((t) => t.own !== this.id);
    const other = others.length ? pick(others).id : 1;
    const any = this.towers.size ? pick([...this.towers.keys()]) : 1;
    const g = (m: unknown) => JSON.stringify({ t: 'g', m });
    const list: (() => string)[] = [
      () => '{"t":"g","m":{"k":"build","t":"laser","x":NaN,"y":3}}',
      () => g({ k: 'build', t: 'laser', x: 1e308, y: -1e308 }),
      () => '{"t":"g","m":{"k":"build","t":"missile","x":1e999,"y":2}}',
      () => g({ k: 'build', t: 'laser', x: 2.5, y: '3' }),
      () => g({ k: 'build', t: '__proto__', x: 3, y: 3 }),
      () => g({ k: 'build', t: 'toString', x: 3, y: 3 }),
      () => g({ k: 'build', t: 'laser', x: -1, y: 0 }),
      () => g({ k: 'build', t: 'laser', x: 9999, y: 9999 }),
      () => g({ k: 'build', t: ['laser'], x: 4, y: 4 }),
      () => g({ k: 'up', id: other }),
      () => g({ k: 'sell', id: other }),
      () => g({ k: 'tm', id: other, tm: 99 }),
      () => g({ k: 'tm', id: any, tm: -1 }),
      () => g({ k: 'tm', id: any, tm: 1.5 }),
      () => '{"t":"g","m":{"k":"tm","id":1,"tm":"__proto__"}}',
      () => g({ k: 'up', id: 1e20 }),
      () => g({ k: 'up', id: -1 }),
      () => g({ k: 'sell', id: String(any) }),
      () => g({ k: 'sell', id: { valueOf: 1 } }),
      () => g({ k: 'send', e: 'colossus', to: 99 }),
      () => g({ k: 'send', e: 'runner', to: -1 }),
      () => g({ k: 'send', e: 'runner', to: this.myBoard }),
      () => g({ k: 'send', e: 'runner', to: 0.5 }),
      () => g({ k: 'send', e: 'hydra' }),
      () => g({ k: 'send', e: 'constructor' }),
      () => g({ k: 'view', b: 1e9 }),
      () => g({ k: 'view', b: -3 }),
      () => g({ k: 'view', b: '0' }),
      () => '{"t":"g","m":{"k":"ping","x":1e999,"z":0}}',
      () => g({ k: 'ping', x: 'a', z: null }),
      () => g({ k: 'ping', x: 1e6, z: -1e6 }),
      () => g(null),
      () => g([1, 2]),
      () => g('build'),
      () => g({ k: {} }),
      () => g({ k: 'end', win: true }),
      () => g({ k: 'init' }),
      () => JSON.stringify({ t: 'g' }),
      () => JSON.stringify({ t: 5 }),
      () => 'null',
      () => '[]',
      () => '"hello"',
      () => '{',
      () => '',
      () => '{"t":"__proto__","m":{}}',
      () => '{"t":"constructor"}',
      () => '{"t":"g","m":{"k":"build","__proto__":{"t":"laser"},"x":3,"y":3}}',
      () => JSON.stringify({ t: 'setBots', count: 1e9, difficulty: 'insane' }),
      () => JSON.stringify({ t: 'setMode', mode: 'vs' }),
      () => JSON.stringify({ t: 'setMap', map: { evil: 1 } }),
      () => JSON.stringify({ t: 'start' }),
      () => JSON.stringify({ t: 'stop' }),
      () => JSON.stringify({ t: 'setTeam', team: 7 }),
      () => JSON.stringify({ t: 'setLook', look: { body: 'x'.repeat(4000), color: -1 } }),
      () => JSON.stringify({ t: 'setLook', look: null }),
      () => JSON.stringify({ t: 'chat', text: 'x'.repeat(3000) }),
      () => JSON.stringify({ t: 'chat', text: { a: 1 } }),
      () => JSON.stringify({ t: 'chat', text: '\u0000\u0007‮ evil \ud800' }),
      () => JSON.stringify({ t: 'ping', at: 'now' }),
      () => JSON.stringify({ t: 'ping', at: 1e308 }),
      () => JSON.stringify({ t: 'g', m: { k: 'ready', pad: 'x'.repeat(12000) } }),
    ];
    return pick(list)();
  }
}

// ---- room -------------------------------------------------------------------------------------------------------

class RoomRun {
  code = '';
  view?: RoomView;
  clients: Fake[] = [];
  /** Clients whose close (and error) is expected, with the expected close code (0 = any). */
  expectingClose = new Map<Fake, number>();
  matchesStarted = 0;
  matchesEnded = 0;
  matchesStopped = 0;
  endsProper = 0;
  endResults: string[] = [];
  maps = new Set<string>();
  maxWave = 0;
  snapsAfterEnd = 0;
  /** Server-side gaps between consecutive snapshots (from the snapshots' `t`), observer client only. */
  serverGaps: number[] = [];
  ticks = 0;
  tickMs = 0;
  stalls = 0;
  hostStalls = 0;
  maxServerGap = 0;
  corruptions = 0;
  private lastS?: GSnapshot;
  private endAt = 0;
  private stopTimer?: NodeJS.Timeout;
  private startTimer?: NodeJS.Timeout;
  private churnTimer?: NodeJS.Timeout;
  private stoppedOnce = false;
  active = true;
  private churnN = 0;

  constructor(
    readonly idx: number,
    readonly t: Template,
  ) {}

  label() {
    return `${this.code} ${this.t.mode}/${this.t.style}${this.t.chaos ? '+chaos' : ''}${this.t.churn ? '+churn' : ''}`;
  }

  observer(): Fake | undefined {
    return this.clients.find((c) => c.open && c.id === this.view?.hostId) ?? this.clients.find((c) => c.open);
  }

  async create() {
    const body = JSON.stringify({ name: `Soak ${this.idx}`, game: 'garden', maxPlayers: 6, bots: this.t.bots, botDifficulty: this.t.diff, map: this.t.map, mode: this.t.mode });
    const r = await http('POST', '/api/rooms', body);
    if (r.status !== 201) throw new Error(`create room failed: ${r.status} ${JSON.stringify(r.json)}`);
    this.code = r.json.room.code;
  }

  async join() {
    for (let i = 0; i < this.t.humans; i++) {
      const chaos = !!this.t.chaos && i === this.t.humans - 1 && this.t.humans > 1;
      const c = new Fake(this, `${chaos ? 'Chaos' : 'Soak'}${this.idx}-${i}`, chaos);
      this.clients.push(c);
      await c.connect();
      if (!c.id) fail(`${this.code}: ${c.name} got no welcome (close ${c.closeInfo?.code} ${c.closeInfo?.reason})`);
    }
  }

  start() {
    const host = this.observer();
    if (!host || !this.active) return;
    host.send({ t: 'start' });
  }

  onRoomView(from: Fake, v: RoomView) {
    if (from !== this.observer()) return;
    const prev = this.view?.state;
    this.view = v;
    if (prev === 'playing' && v.state === 'waiting') {
      if (this.endAt) {
        const dt = Date.now() - this.endAt;
        this.endsProper++;
        vlog(`${this.label()}: back to waiting ${dt} ms after 'end'`);
      } else this.matchesStopped++;
      this.endAt = 0;
      clearTimeout(this.startTimer);
      if (this.active) this.startTimer = setTimeout(() => this.view?.state === 'waiting' && this.start(), 1500 + rand() * 2000);
    }
    if (prev !== 'playing' && v.state === 'playing') {
      this.matchesStarted++;
      if (this.t.stopAfter && !this.stoppedOnce) {
        this.stoppedOnce = true;
        this.stopTimer = setTimeout(() => this.observer()?.send({ t: 'stop' }), this.t.stopAfter * 1000);
      }
    }
  }

  onInit(map: string) {
    this.maps.add(map);
    this.lastS = undefined;
  }

  onObserverSnap(s: GSnapshot) {
    this.maxWave = Math.max(this.maxWave, s.wave);
    const p = this.lastS;
    if (p && s.tick > p.tick) {
      const gap = s.t - p.t;
      this.serverGaps.push(gap);
      this.ticks += s.tick - p.tick;
      this.tickMs += gap;
      this.maxServerGap = Math.max(this.maxServerGap, gap);
      if (gap > 1000) {
        // Decide a moment later: this process may still be catching up on the same freeze.
        const t0 = p.t;
        const t1 = s.t;
        const ticks = `${p.tick} -> ${s.tick}`;
        setTimeout(() => {
          const own = harnessLagDuring(t0, t1);
          const what = `${this.label()}: room loop stall ${gap} ms at ${new Date(t0).toISOString().slice(11, 23)} (tick ${ticks}); soak process frozen ${own} ms of it`;
          if (own >= gap * 0.4) {
            this.hostStalls++;
            if (STRICT) fail(what);
            else warn(`host stall: ${what}`);
          } else {
            this.stalls++;
            fail(what);
          }
        }, 300);
      }
    }
    this.lastS = s;
  }

  onEnd(win: boolean, winner: string | null, wave: number) {
    this.matchesEnded++;
    this.endAt = Date.now();
    this.endResults.push(this.t.mode === 'coop' ? `${win ? 'win' : 'loss'}@${wave}` : `${winner ? (winner.startsWith('b') ? 'bot' : 'human') : 'none'}@${wave}`);
    log(`${this.label()}: match ended (${this.endResults[this.endResults.length - 1]})`);
  }

  corrupt(what: string) {
    this.corruptions++;
    if (this.corruptions <= 5) fail(`${this.label()}: corrupt snapshot field: ${what}`);
  }

  onClientClosed(c: Fake, code: number, reason: string) {
    const exp = this.expectingClose.get(c);
    if (exp !== undefined) {
      this.expectingClose.delete(c);
      if (exp && exp !== code) fail(`${this.label()}: ${c.name} closed with ${code} (${reason}), expected ${exp}`);
      return;
    }
    if (c.leaving && (code === 1000 || code === 1005)) return;
    fail(`${this.label()}: ${c.name} closed unexpectedly: ${code} ${reason}`);
  }

  /** Checks a match that ended but never went back to waiting. */
  watchdog() {
    if (this.endAt && Date.now() - this.endAt > 20_000) {
      fail(`${this.label()}: match ended ${((Date.now() - this.endAt) / 1000).toFixed(0)} s ago but the room never went back to waiting`);
      this.endAt = 0;
    }
    if (this.view?.state === 'playing' && this.lastS && Date.now() - this.lastS.t > 3000 && !this.endAt && this.observer()?.ended === false) {
      fail(`${this.label()}: no snapshot for ${Date.now() - this.lastS.t} ms while playing`);
      this.lastS = undefined;
    }
  }

  startChurn() {
    if (!this.t.churn || this.t.humans < 2) return;
    const loop = async () => {
      if (!this.active) return;
      const victims = this.clients.filter((c) => c.open && c.id !== this.view?.hostId && !c.chaos);
      if (victims.length) {
        const v = victims[0];
        v.leaving = true;
        this.expectingClose.set(v, 0);
        v.close();
        await sleep(1500 + rand() * 3000);
        if (!this.active) return;
        const c = new Fake(this, `Churn${this.idx}-${++this.churnN}`, false);
        this.clients.push(c);
        await c.connect();
        if (!c.id) fail(`${this.label()}: churn rejoin got no welcome (${c.closeInfo?.code} ${c.closeInfo?.reason})`);
        else vlog(`${this.label()}: ${c.name} rejoined`);
      }
      this.churnTimer = setTimeout(loop, 30_000 + rand() * 20_000);
    };
    this.churnTimer = setTimeout(loop, 30_000 + rand() * 20_000);
  }

  shutdown() {
    this.active = false;
    clearTimeout(this.stopTimer);
    clearTimeout(this.startTimer);
    clearTimeout(this.churnTimer);
    for (const c of this.clients) c.close();
  }
}

// ---- probes -----------------------------------------------------------------------------------------------------

const probes: { name: string; ok: boolean; detail: string }[] = [];
const probe = (name: string, ok: boolean, detail: string) => {
  probes.push({ name, ok, detail });
  if (!ok) fail(`probe "${name}": ${detail}`);
  else log(`probe "${name}": ok (${detail})`);
};

/** A raw socket for probes: resolves on close or after `ms`. */
function rawSocket(code: string, name: string) {
  const ws = new WebSocket(`${WS_BASE}/api/ws?room=${code}&name=${encodeURIComponent(name)}`);
  const msgs: any[] = [];
  let closed: { code: number; reason: string } | null = null;
  let welcomed = false;
  const opened = new Promise<void>((res) => {
    ws.onopen = () => res();
    ws.onclose = (ev) => {
      closed = { code: ev.code, reason: ev.reason };
      res();
    };
  });
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      if (m.t === 'welcome') welcomed = true;
      msgs.push(m);
    } catch {
      /* ignore */
    }
  };
  ws.onerror = () => {};
  const until = async (pred: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await sleep(25);
    return pred();
  };
  return {
    ws,
    msgs,
    opened,
    until,
    get closed() {
      return closed;
    },
    get welcomed() {
      return welcomed;
    },
  };
}

async function httpProbes() {
  try {
    let r = await http('POST', '/api/rooms', JSON.stringify({ game: 'garden', maxPlayers: 1e9, bots: -5, map: '../../etc', mode: 'zz', name: '<b>x</b>'.repeat(20) }));
    probe('POST garbage settings', r.status === 201 && r.json?.room?.maxPlayers === 6 && r.json?.room?.bots === 0 && r.json?.room?.name.length <= 24, `${r.status} ${JSON.stringify(r.json?.room ?? r.json)}`);
    r = await http('POST', '/api/rooms', '{"game":');
    probe('POST invalid JSON', r.status === 400, `${r.status} ${JSON.stringify(r.json)}`);
    r = await http('POST', '/api/rooms', JSON.stringify({ game: 'nope' }));
    probe('POST unknown game', r.status === 400, `${r.status}`);
    r = await http('POST', '/api/rooms', JSON.stringify({ game: 'garden', maxPlayers: 'NaN', bots: 'lots', mode: 'vs', map: 'greenhouse-commons' }));
    probe('POST NaN numbers, coop map in vs', r.status === 201 && r.json?.room?.maxPlayers === 6, `${r.status} ${JSON.stringify(r.json?.room)}`);
    r = await http('GET', '/api/rooms/ZZZZZ');
    probe('GET missing room', r.status === 404, `${r.status}`);
  } catch (err) {
    probe('HTTP probes', false, String(err));
  }
}

async function wsProbes(rooms: RoomRun[]) {
  // Bad room code.
  {
    const s = rawSocket('QQQQ9', 'Nobody');
    await s.until(() => !!s.closed, 3000);
    probe('join missing room', s.closed?.code === 4004, `close ${s.closed?.code} ${s.closed?.reason}`);
  }
  // Full room (6 humans).
  const full = rooms.find((r) => r.t.humans === 6);
  if (full) {
    const s = rawSocket(full.code, 'Seventh');
    await s.until(() => !!s.closed, 3000);
    probe('join full room', s.closed?.code === 4009, `close ${s.closed?.code} ${s.closed?.reason}`);
  }
  const target = rooms.find((r) => r.t.humans + r.t.bots < 6 && r.t.humans <= 4) ?? rooms[0];
  // Nasty name.
  {
    const s = rawSocket(target.code, '\u0000\u001b[31m' + 'N'.repeat(1000));
    await s.until(() => s.welcomed || !!s.closed, 3000);
    const w = s.msgs.find((m) => m.t === 'welcome');
    const me = w?.room.players.find((p: { id: string }) => p.id === w.you);
    probe('control chars + 1000-char name', !!me && me.name.length <= 16 && !/[\u0000-\u001f]/.test(me.name), `name ${JSON.stringify(me?.name)}`);
    // Binary frame is ignored; socket stays usable.
    s.ws.send(new Uint8Array([0x7b, 0x22, 0x74, 0x22]));
    s.ws.send(JSON.stringify({ t: 'ping', at: 42 }));
    const ok = await s.until(() => s.msgs.some((m) => m.t === 'pong' && m.at === 42), 3000);
    probe('binary frame ignored', ok && !s.closed, ok ? 'pong after binary' : `closed=${s.closed?.code}`);
    // Oversized frame (> maxPayload 16 KiB) closes the socket.
    s.ws.send(JSON.stringify({ t: 'chat', text: 'x'.repeat(20_000) }));
    await s.until(() => !!s.closed, 3000);
    probe('20 KB frame closes socket', s.closed?.code === 1009 || s.closed?.code === 1006, `close ${s.closed?.code} ${s.closed?.reason}`);
  }
  await floodProbe(target, 180, 6, false);
  await floodProbe(target, 400, 3, true);
}

/** Sends `rate` messages per second (pings, views, garbage) for `secs`; expect a 4008 kick above 200/s. */
async function floodProbe(room: RoomRun, rate: number, secs: number, expectKick: boolean) {
  const s = rawSocket(room.code, `Flood${rate}`);
  await s.until(() => s.welcomed || !!s.closed, 3000);
  if (!s.welcomed) return probe(`flood ${rate}/s`, false, `no welcome (${s.closed?.code})`);
  const per = Math.round(rate / 20);
  let sent = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000 && !s.closed) {
    for (let i = 0; i < per && s.ws.readyState === WebSocket.OPEN; i++) {
      const k = sent % 3;
      s.ws.send(k === 0 ? JSON.stringify({ t: 'ping', at: sent }) : k === 1 ? JSON.stringify({ t: 'g', m: { k: 'view', b: 0 } }) : '{"t":"g","m":{"k":"zzz"}}');
      sent++;
    }
    await sleep(50);
  }
  await sleep(300);
  const kicked = s.closed?.code === 4008;
  const pongs = s.msgs.filter((m) => m.t === 'pong').length;
  probe(`flood ${rate}/s for ${secs}s`, expectKick ? kicked : !s.closed, `sent ${sent}, pongs ${pongs}, close ${s.closed?.code ?? 'none'} ${s.closed?.reason ?? ''}`);
  if (!s.closed) s.ws.close(1000);
}

// ---- backend process sampling -----------------------------------------------------------------------------------

interface ProcSample {
  at: number;
  rssMB: number;
  cpuS: number;
  /** Machine-wide CPU load % (Windows only). */
  load?: number;
}
const procSamples: ProcSample[] = [];

function sampleProc(): Promise<ProcSample | null> {
  if (!PID) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${Number(PID)} -ErrorAction Stop; $l = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; "$($p.WorkingSet64) $($p.CPU) $l"`], { timeout: 8000 }, (err, out) => {
        if (err) return resolve(null);
        const [ws, cpu, load] = out.trim().split(/\s+/).map((v) => Number(v.replace(',', '.')));
        resolve({ at: Date.now(), rssMB: ws / 2 ** 20, cpuS: cpu, load: Number.isFinite(load) ? load : undefined });
      });
    } else {
      execFile('ps', ['-o', 'rss=,time=', '-p', String(Number(PID))], { timeout: 5000 }, (err, out) => {
        if (err) return resolve(null);
        const [rss, time] = out.trim().split(/\s+/);
        const parts = time.split(/[-:]/).map(Number).reverse();
        const cpu = (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600 + (parts[3] ?? 0) * 86400;
        resolve({ at: Date.now(), rssMB: Number(rss) / 1024, cpuS: cpu });
      });
    }
  });
}

// ---- backend log scanning ---------------------------------------------------------------------------------------

let logPos = 0;
const logHits: string[] = [];
function scanLog(initial = false) {
  if (!LOG || !existsSync(LOG)) return;
  const size = statSync(LOG).size;
  if (initial) {
    logPos = size;
    return;
  }
  if (size <= logPos) return;
  const fd = openSync(LOG, 'r');
  const buf = Buffer.alloc(size - logPos);
  readSync(fd, buf, 0, buf.length, logPos);
  closeSync(fd);
  logPos = size;
  for (const line of buf.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/socket error/i.test(line)) {
      warn(`backend: ${line.trim()}`);
      continue;
    }
    if (/error|exception|failed|uncaught|unhandled|TypeError|RangeError|ReferenceError|    at /i.test(line)) {
      logHits.push(line.trim());
      if (logHits.length <= 20) fail(`backend log: ${line.trim().slice(0, 240)}`);
    }
  }
}

// ---- main -------------------------------------------------------------------------------------------------------

async function health(): Promise<{ rooms: number; players: number } | null> {
  try {
    const r = await http('GET', '/api/health');
    return r.status === 200 ? r.json : null;
  } catch {
    return null;
  }
}

async function main() {
  const h0 = await health();
  if (!h0) {
    console.error(`No backend at ${BASE} (GET /api/health failed).`);
    process.exit(2);
  }
  log(`backend up: ${JSON.stringify(h0)}; ${ROOMS} rooms, ${MINUTES} min${PID ? `, pid ${PID}` : ''}${LOG ? `, log ${LOG}` : ''}`);
  scanLog(true);
  const s0 = await sampleProc();
  if (s0) procSamples.push(s0);
  else if (PID) warn(`could not sample pid ${PID}`);

  await httpProbes();

  const rooms: RoomRun[] = [];
  for (let i = 0; i < ROOMS; i++) {
    const r = new RoomRun(i, TEMPLATES[i % TEMPLATES.length]);
    try {
      await r.create();
    } catch (err) {
      fail(`room ${i}: ${(err as Error).message}`);
      continue;
    }
    rooms.push(r);
  }
  await Promise.all(rooms.map((r) => r.join()));
  const humans = rooms.reduce((n, r) => n + r.clients.length, 0);
  log(`${rooms.length} rooms, ${humans} fake humans connected: ${rooms.map((r) => r.label()).join(', ')}`);
  for (const r of rooms) r.start();
  for (const r of rooms) r.startChurn();

  await sleep(3000);
  await wsProbes(rooms);

  const endAt = T0 + MINUTES * 60_000;
  let lastReport = Date.now();
  let healthFails = 0;
  let lastProc = 0;
  while (Date.now() < endAt) {
    await sleep(1000);
    for (const r of rooms) r.watchdog();
    scanLog();
    if (Date.now() - lastProc > 10_000) {
      lastProc = Date.now();
      const [h, p] = await Promise.all([health(), sampleProc()]);
      if (!h) {
        healthFails++;
        fail(`backend health check failed (${healthFails}x)`);
        if (healthFails >= 3) break;
      } else healthFails = 0;
      if (p) procSamples.push(p);
    }
    if (Date.now() - lastReport > 30_000) {
      lastReport = Date.now();
      const p = procSamples[procSamples.length - 1];
      log(
        `status: ${rooms.map((r) => `${r.code}:${r.view?.state === 'playing' ? 'w' + r.maxWave : r.view?.state ?? '?'} m${r.matchesStarted}/${r.matchesEnded}`).join(' ')}` +
          (p ? ` | backend ${p.rssMB.toFixed(0)} MB` : '') +
          ` | failures ${failures.length}`,
      );
    }
  }

  // Wind down.
  const playSecs = (Date.now() - T0) / 1000;
  const live = rooms.flatMap((r) => r.clients.filter((c) => c.open));
  for (const c of live) c.stats.connectedMs += Date.now() - c.openedAt;
  for (const c of live) c.openedAt = Date.now();
  const snapshotStats = rooms.map((r) => r.clients.map((c) => ({ ...c.stats })));
  for (const r of rooms) r.shutdown();
  await sleep(1500);
  scanLog();
  const pEnd = await sampleProc();
  if (pEnd) procSamples.push(pEnd);
  let drained: { rooms: number; players: number } | null = null;
  if (DRAIN) {
    log('waiting 20 s for empty rooms to close...');
    await sleep(20_000);
    drained = await health();
    const pDrain = await sampleProc();
    if (pDrain) procSamples.push(pDrain);
    if (!drained) fail('backend not reachable after the soak');
    else if (drained.players !== 0) fail(`backend still counts ${drained.players} players after every client left`);
    else {
      const left = drained.rooms;
      // The HTTP probe rooms are never joined and close after UNCLAIMED_ROOM_MS (60 s by default).
      if (left > 2) warn(`${left} rooms still open 20 s after the soak (2 unjoined probe rooms are expected if the soak was shorter than ~1 min)`);
    }
    scanLog();
  }

  report(rooms, snapshotStats, playSecs, drained);
  process.exit(failures.length ? 1 : 0);
}

function report(rooms: RoomRun[], stats: ClientStats[][], playSecs: number, drained: { rooms: number; players: number } | null) {
  console.log('\n================ Garden Sentinels soak summary ================');
  console.log(`duration ${playSecs.toFixed(0)} s, ${rooms.length} rooms, target ${BASE}\n`);

  console.log('Rooms (server timing from snapshot.t of the host client; expected snapshot gap', (1000 / G.tickRate) * G.snapEvery, 'ms):');
  table(
    ['room', 'humans', 'bots', 'maps', 'started', 'ended', 'proper', 'stopped', 'max wave', 'tick Hz', 'gap p50', 'p99', 'max', 'jitter sd', 'stalls', 'host stalls', 'dropped', 'results'],
    rooms.map((r, i) => {
      const dropped = stats[i].reduce((n, s) => n + s.dropped, 0);
      return [
        r.label(),
        r.clients.length,
        r.t.bots,
        [...r.maps].join(','),
        r.matchesStarted,
        r.matchesEnded,
        r.endsProper,
        r.matchesStopped,
        r.maxWave,
        f1(r.tickMs ? (r.ticks / r.tickMs) * 1000 : NaN),
        f0(pct(r.serverGaps, 50)),
        f0(pct(r.serverGaps, 99)),
        f0(r.maxServerGap),
        f1(sd(r.serverGaps)),
        r.stalls,
        dropped,
        r.endResults.join(' ') || '-',
      ];
    }),
  );

  console.log('\nPer client, by mode (payload bytes; rx = server -> client):');
  const rows: (string | number)[][] = [];
  for (const mode of ['coop', 'vs'] as const) {
    const cs = rooms.flatMap((r, i) => (r.t.mode === mode ? stats[i] : [])).filter((s) => s.connectedMs > 5000);
    if (!cs.length) continue;
    const per = (f: (s: ClientStats) => number) => cs.map((s) => f(s) / (s.connectedMs / 1000));
    const rxB = per((s) => s.rxBytes);
    const rxM = per((s) => s.rxMsgs);
    const txB = per((s) => s.txBytes);
    const txM = per((s) => s.txMsgs);
    const gaps = cs.flatMap((s) => s.gaps);
    const lat = cs.flatMap((s) => s.lat);
    const rtt = cs.flatMap((s) => s.rtt);
    rows.push([
      mode,
      cs.length,
      f2(mean(rxB) / 1024),
      f2(Math.max(...rxB) / 1024),
      f1(mean(rxM)),
      f0(mean(txB)),
      f2(mean(txM)),
      f0(pct(gaps, 50)),
      f0(pct(gaps, 99)),
      f0(Math.max(0, ...gaps)),
      f0(pct(lat, 50)),
      f0(pct(lat, 99)),
      f0(pct(rtt, 50)),
      f0(pct(rtt, 99)),
      cs.reduce((n, s) => n + s.denies, 0),
    ]);
  }
  table(['mode', 'clients', 'rx KB/s avg', 'rx KB/s max', 'rx msg/s', 'tx B/s', 'tx msg/s', 'snap gap p50', 'p99', 'max', 'snap age p50', 'p99', 'rtt p50', 'p99', 'denies'], rows);

  console.log('\nSnapshot size (bytes):');
  table(
    ['mode', 'count', 'mean', 'p50', 'p90', 'p99', 'max'],
    (['coop', 'vs'] as const).filter((m) => snapSizes[m].length).map((m) => {
      const a = snapSizes[m];
      return [m, a.length, f0(mean(a)), f0(pct(a, 50)), f0(pct(a, 90)), f0(pct(a, 99)), f0(Math.max(...a))];
    }),
  );

  console.log('\nServer -> client traffic by message type:');
  for (const mode of ['coop', 'vs'] as const) {
    const ts = typeStats[mode];
    const total = [...ts.values()].reduce((n, s) => n + s.bytes, 0);
    if (!total) continue;
    const r = [...ts.entries()].sort((a, b) => b[1].bytes - a[1].bytes).map(([k, s]) => [k, s.n, f0(s.bytes / s.n), f1((s.bytes / total) * 100) + '%']);
    console.log(`  ${mode}:`);
    table(['  type', 'msgs', 'avg B', 'share'], r.map((x) => ['  ' + x[0], ...x.slice(1)]));
  }

  if (procSamples.length) {
    console.log('\nBackend process:');
    const first = procSamples[0];
    const last = procSamples[procSamples.length - 1];
    const peak = Math.max(...procSamples.map((s) => s.rssMB));
    const cpuPct = ((last.cpuS - first.cpuS) / ((last.at - first.at) / 1000)) * 100;
    console.log(`  memory start ${first.rssMB.toFixed(1)} MB, peak ${peak.toFixed(1)} MB, end ${last.rssMB.toFixed(1)} MB; avg CPU ${f1(cpuPct)}% of one core over ${((last.at - first.at) / 1000).toFixed(0)} s (${procSamples.length} samples)`);
    console.log(`  samples (MB): ${procSamples.map((s) => s.rssMB.toFixed(0)).join(' ')}`);
  }
  if (drained) console.log(`\nAfter drain: ${drained.rooms} rooms, ${drained.players} players on the backend.`);

  console.log('\nProbes:');
  for (const p of probes) console.log(`  ${p.ok ? 'PASS' : 'FAIL'}  ${p.name}: ${p.detail}`);

  if (errorTexts.size) {
    console.log('\nError messages received (chaos clients expect some):');
    for (const [k, n] of [...errorTexts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
  }
  if (denyTexts.size) {
    console.log('\nDenies received:');
    for (const [k, n] of [...denyTexts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
  }
  const snapsAfterEnd = rooms.reduce((n, r) => n + r.snapsAfterEnd, 0);
  if (snapsAfterEnd) warnings.push(`${snapsAfterEnd} snapshots arrived after 'end'`);
  if (warnings.length) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 30)) console.log(`  - ${w}`);
  }
  console.log(`\nFailures (${failures.length}):`);
  for (const f of failures.slice(0, 60)) console.log(`  - ${f}`);
  console.log(failures.length ? '\nRESULT: FAIL' : '\nRESULT: PASS');
}

process.on('unhandledRejection', (err) => {
  fail(`soak unhandled rejection: ${(err as Error)?.stack ?? err}`);
});

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
