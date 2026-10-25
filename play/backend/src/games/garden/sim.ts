// Garden Sentinels simulation: waves, enemies, towers, economy, versus sends and eliminations. No networking: the
// game server (server.ts) and the headless balance tool (tools/garden/sim.ts) both drive a GardenSim by calling
// step(dt) and draining `events` / `denies`. Every player action, human or bot, goes through handle(), which
// validates it fully.

import { rng as makeRng } from '../../shared/math.js';
import type { BotDifficulty } from '../../shared/protocol.js';
import { G, type GMode, coopBountyShare, coopCount, coopEarly, coopHp } from '../../shared/garden/constants.js';
import { ENEMIES, type EnemyDef, type EnemyKind, SENDS, SENT_BOUNTY, SKITTER_PACK, isEnemyKind, sendCap, vsHpRamp, waveBounty, waveHp, waveSpawns } from '../../shared/garden/enemies.js';
import type { GMapDef } from '../../shared/garden/maps.js';
import { type BoardOrigin, type RouteGeom, type RoutePos, boardOrigin, cellToWorld, routeGeom, routePos } from '../../shared/garden/board.js';
import {
  type BoardInfo,
  type BoardSnap,
  EFlag,
  type EnemySnap,
  type GEvent,
  type GScore,
  type GSnapshot,
  type Phase,
  type PlayerSnap,
  TFlag,
  type TowerInfo,
  type TowerSnap,
} from '../../shared/garden/protocol.js';
import { TOWERS, TOWER_KINDS, type Level, type TargetMode, type TowerKind, type TowerLevel, isTowerKind } from '../../shared/garden/towers.js';
import type { BotAction, BotEnemyView, BotView, CreateBot, GardenBotBrain } from './botapi.js';

/** Missile flight speed (m/s); flight time = distance / speed. */
const MISSILE_SPEED = 12;
/** Laser level 3: chain hop distance (m) and share of the beam's damage each chained enemy takes. */
const CHAIN_HOP = 3;
const CHAIN_SHARE = 0.5;
/** Disruptors glow (EFlag.charging) this long before a bolt. */
const CHARGE_TIME = 0.6;
/** Shield pulse period (s). */
const ZAP_EVERY = 1;
/** Seconds between bot think() calls. */
const BOT_THINK = 0.25;
/** Spacing (s) of sent enemies when they enter, and when the first one enters (s into the wave). */
const SEND_GAP = 0.6;
const SEND_AT = 4;
const SHED_AT = [0.75, 0.5, 0.25];
/** Co-op: most purses (start gold + clear bonuses) one match hands out; later new names start with 0 gold. */
const MAX_COOP_PURSES = 12;
/** Versus: seconds a leaver's board, gold and score stay reserved for a rejoin under the same name. */
export const VS_RECLAIM = 60;
const CHEAPEST_TOWER = Math.min(...TOWER_KINDS.map((k) => TOWERS[k].levels[0].cost));

export interface SimPlayerInit {
  id: string;
  name: string;
  bot: boolean;
}

export interface SimPlayer {
  id: string;
  name: string;
  bot: boolean;
  /** Board this player builds on; -1 = spectator (versus mid-match joiner). */
  board: number;
  gold: number;
  /** Versus: income from sends (on top of G.baseIncome). */
  income: number;
  ready: boolean;
  score: GScore;
  brain?: GardenBotBrain;
  thinkT: number;
  sendRR: number;
  pingT: number;
  /** Sends made since the last wave start (capped by sendCap). */
  sends: number;
}

interface Enemy {
  id: number;
  kind: EnemyKind;
  def: EnemyDef;
  b: number;
  r: number;
  len: number;
  d: number;
  o: number;
  hp: number;
  maxHp: number;
  hpMul: number;
  speed: number;
  x: number;
  z: number;
  /** Strongest slow on it this tick. */
  slow: number;
  zapT: number;
  stun: number;
  disT: number;
  shed: number;
  /** Versus: sender id for sent units. */
  from: string | null;
  dead: boolean;
}

interface Tower {
  info: TowerInfo;
  /** Wave whose build phase it was built in (-1 = during a wave): selling it in that same build phase refunds everything. */
  builtIn: number;
  def: (typeof TOWERS)[TowerKind];
  x: number;
  z: number;
  tg: number;
  ch: number[];
  f: number;
  cd: number;
  disabled: number;
  zapT: number;
  /** Best covering shield's reflect stun (0 = none). */
  reflect: number;
  bDmg: number;
  bRate: number;
  bRange: number;
  /** Stats at the current level. */
  lv: TowerLevel;
}

interface Spawn {
  at: number;
  kind: EnemyKind;
  r: number;
  hpMul: number;
  o: number;
  from: string | null;
}

interface Board {
  b: number;
  owner: string | null;
  lives: number;
  out: boolean;
  place: number;
  origin: BoardOrigin;
  routes: RouteGeom[];
  /** Tower id per cell (row * W + col), 0 = free. */
  cells: Int32Array;
  buildable: Uint8Array;
  en: Enemy[];
  tw: Tower[];
  pending: Spawn[];
  /** Versus: sends queued for this board's next wave. */
  queued: { kind: EnemyKind; from: string }[];
  rr: number;
  /** This wave's clear bonus has been paid (versus: per board). */
  cleared: boolean;
  /** Lives at the start of the tick (tie-break when the last boards fall together). */
  livesAtTick: number;
  freeCache: [number, number][] | null;
}

interface Missile {
  mid: number;
  b: number;
  tw: number;
  owner: string;
  en: number;
  x: number;
  z: number;
  t: number;
  dmg: number;
  splash: number;
}

export interface SimEnd {
  win: boolean;
  winner: string | null;
  wave: number;
}

export interface GardenSimOptions {
  def: GMapDef;
  mode: GMode;
  players: SimPlayerInit[];
  difficulty: BotDifficulty;
  seed: number;
  createBot: CreateBot;
}

export class GardenSim {
  readonly def: GMapDef;
  readonly mode: GMode;
  readonly W: number;
  readonly H: number;
  readonly boards: Board[] = [];
  readonly players = new Map<string, SimPlayer>();
  /**
   * Players who left mid-match, by lower-case name: a join under that name reclaims everything (board, gold, income,
   * score, towers). Co-op keeps them for the whole match (so leaving never mints gold); versus for VS_RECLAIM s, while
   * their board keeps defending and earning for them.
   */
  private readonly parked = new Map<string, { sp: SimPlayer; at: number }>();
  /** Co-op: purses handed out so far (initial players + new joiners); capped by MAX_COOP_PURSES. */
  private purses = 0;
  /** Co-op: clear bonuses paid so far, per defender (the most a genuinely new joiner gets on top of start gold). */
  clearPaid = 0;
  /** Events since the last drain (the server batches them per tick). */
  events: GEvent[] = [];
  /** Rejected actions: sent privately to that player. */
  denies: { id: string; why: string }[] = [];
  wave = 0;
  phase: Phase = 'build';
  left: number = G.firstBuild;
  tick = 0;
  time = 0;
  end: SimEnd | null = null;
  /** The build countdown is paused (server: the first one waits until every human has loaded). */
  hold = false;
  /** Counters for the balance tool. */
  stats = { leaks: 0, kills: 0, spawned: 0 };
  /** Enemies spawned in the current wave so far (all boards). */
  waveSpawned = 0;
  /** Versus: time of the last scheduled base spawn of this wave (the overtime clock starts there). */
  private lastSpawnAt = 0;

  private readonly difficulty: BotDifficulty;
  private readonly createBot: CreateBot;
  private readonly rng: () => number;
  private readonly towers = new Map<number, Tower>();
  private readonly enemies = new Map<number, Enemy>();
  private readonly missiles: Missile[] = [];
  private nextId = 1;
  private nextMid = 1;
  private readonly pos: RoutePos = { x: 0, z: 0, yaw: 0 };

  constructor(o: GardenSimOptions) {
    this.def = o.def;
    this.mode = o.mode;
    this.difficulty = o.difficulty;
    this.createBot = o.createBot;
    this.rng = makeRng(o.seed >>> 0);
    this.W = o.def.grid[0].length;
    this.H = o.def.grid.length;
    const n = this.mode === 'vs' ? Math.max(1, o.players.length) : 1;
    for (let b = 0; b < n; b++) {
      const origin = boardOrigin(o.def, b, n);
      const buildable = new Uint8Array(this.W * this.H);
      for (let r = 0; r < this.H; r++) for (let c = 0; c < this.W; c++) buildable[r * this.W + c] = o.def.grid[r][c] === '.' ? 1 : 0;
      this.boards.push({
        b,
        owner: this.mode === 'vs' ? (o.players[b]?.id ?? null) : null,
        lives: G.lives,
        out: false,
        place: 0,
        origin,
        routes: o.def.routes.map((rt) => routeGeom(o.def, origin, rt)),
        cells: new Int32Array(this.W * this.H),
        buildable,
        en: [],
        tw: [],
        pending: [],
        queued: [],
        rr: 0,
        cleared: true,
        livesAtTick: G.lives,
        freeCache: null,
      });
    }
    o.players.forEach((p, i) => this.addPlayer(p, this.mode === 'vs' ? i : 0));
  }

  // ---- players ----------------------------------------------------------------------------------------------------

  /** Adds a player. `board` defaults to: co-op 0 (defender), versus -1 (spectator). */
  addPlayer(p: SimPlayerInit, board = this.mode === 'vs' ? -1 : 0): SimPlayer {
    const existing = this.players.get(p.id);
    if (existing) return existing;
    const back = this.reclaim(p);
    if (back) return back;
    let gold: number = G.startGold[this.mode];
    if (this.mode === 'coop' && board >= 0) gold = this.coopPurse();
    const sp: SimPlayer = {
      id: p.id,
      name: p.name,
      bot: p.bot,
      board,
      gold,
      income: 0,
      ready: false,
      score: { id: p.id, kills: 0, dmg: 0, built: 0, sent: 0, points: 0 },
      thinkT: this.rng() * BOT_THINK,
      sendRR: 0,
      pingT: 0,
      sends: 0,
    };
    if (p.bot && board >= 0) sp.brain = this.createBot(p.id, this.difficulty, Math.floor(this.rng() * 1e9));
    this.players.set(p.id, sp);
    return sp;
  }

  /**
   * A player left. Their towers keep working (co-op: anyone may still upgrade them, nobody can sell them) and the
   * player is parked under their lower-case name (see `parked`): co-op until the match ends, versus (humans only) for
   * VS_RECLAIM s while their board keeps defending and earning for them. After that a versus board plays on unbuilt.
   */
  removePlayer(id: string) {
    const p = this.players.get(id);
    this.players.delete(id);
    if (!p || p.board < 0 || this.end || (this.mode === 'vs' && p.bot)) return;
    const key = p.name.toLowerCase();
    const prev = this.parked.get(key);
    if (prev && this.mode === 'coop') p.gold += prev.sp.gold;
    this.parked.set(key, { sp: p, at: this.time });
  }

  /** A join under a parked name takes the parked player's place: board, gold, income, score and towers move to the new id. */
  private reclaim(p: SimPlayerInit): SimPlayer | null {
    const key = p.name.toLowerCase();
    const pk = this.parked.get(key);
    if (!pk || pk.sp.bot !== p.bot) return null;
    this.parked.delete(key);
    const old = pk.sp;
    const sp: SimPlayer = { ...old, id: p.id, name: p.name, ready: false, score: { ...old.score, id: p.id }, brain: undefined };
    if (p.bot) sp.brain = this.createBot(p.id, this.difficulty, Math.floor(this.rng() * 1e9));
    const from = old.id;
    for (const bd of this.boards) {
      if (bd.owner === from) bd.owner = p.id;
      for (const s of bd.pending) if (s.from === from) s.from = p.id;
      for (const q of bd.queued) if (q.from === from) q.from = p.id;
    }
    for (const t of this.towers.values()) if (t.info.own === from) t.info.own = p.id;
    for (const e of this.enemies.values()) if (e.from === from) e.from = p.id;
    for (const m of this.missiles) if (m.owner === from) m.owner = p.id;
    this.players.set(p.id, sp);
    return sp;
  }

  /** Versus: the player a board pays (its owner, or the owner parked while they reconnect). */
  private holder(id: string | null): SimPlayer | undefined {
    if (!id) return undefined;
    const p = this.players.get(id);
    if (p || this.mode !== 'vs') return p;
    for (const pk of this.parked.values()) if (pk.sp.id === id) return pk.sp;
    return undefined;
  }

  /** Everyone holding a board: players plus (versus) parked leavers. */
  private holders(): SimPlayer[] {
    const out = [...this.players.values()];
    if (this.mode === 'vs') for (const pk of this.parked.values()) out.push(pk.sp);
    return out;
  }

  /**
   * Co-op starting gold for a new name (a parked name reclaims instead, see reclaim). Leaving and rejoining (rooms.ts
   * gives a new id) or renaming must never mint gold: a new name gets start gold plus the clear bonuses paid so far
   * (never more than the true median defender's gold, never less than start gold), and only while the match has
   * purses left (MAX_COOP_PURSES); after that a new name starts with nothing.
   */
  private coopPurse(): number {
    if (this.purses >= MAX_COOP_PURSES) return 0;
    this.purses++;
    const start = G.startGold.coop;
    if (!this.clearPaid) return start;
    const golds = [...this.players.values()].filter((q) => q.board >= 0).map((q) => q.gold).sort((a, b) => a - b);
    let cap = start + this.clearPaid;
    if (golds.length) {
      const m = golds.length >> 1;
      const median = golds.length % 2 ? golds[m] : (golds[m - 1] + golds[m]) / 2;
      cap = Math.min(cap, Math.floor(median));
    }
    return Math.max(start, cap);
  }

  private avgDefenderGold(): number {
    let g = 0;
    let n = 0;
    for (const p of this.players.values())
      if (p.board >= 0) {
        g += p.gold;
        n++;
      }
    return n ? g / n : 0;
  }

  private defenders(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.board >= 0) n++;
    return Math.max(1, n);
  }

  // ---- actions ----------------------------------------------------------------------------------------------------

  /** Applies one client or bot action after validating it. Returns false when it was rejected or ignored. */
  handle(id: string, m: unknown): boolean {
    const p = this.players.get(id);
    if (!p || !m || typeof m !== 'object' || this.end) return false;
    const msg = m as Record<string, unknown>;
    switch (msg.k) {
      case 'build':
        return this.build(p, msg.t, msg.x, msg.y);
      case 'up':
        return this.upgrade(p, msg.id);
      case 'sell':
        return this.sell(p, msg.id);
      case 'tm':
        return this.setTarget(p, msg.id, msg.tm);
      case 'ready':
        // Build phase: anyone. Co-op wave phase: humans may ready up to call the next wave over the last stragglers.
        if (p.board < 0 || (this.phase !== 'build' && !(this.mode === 'coop' && this.phase === 'wave' && !p.bot))) return false;
        p.ready = p.bot ? true : !p.ready;
        return true;
      case 'send':
        return this.send(p, msg.e, msg.to);
      case 'ping': {
        const x = msg.x;
        const z = msg.z;
        if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return false;
        if (Math.abs(x) > 2000 || Math.abs(z) > 2000 || this.time < p.pingT) return false;
        p.pingT = this.time + 0.4;
        this.events.push({ k: 'ping', id, b: Math.max(0, p.board), x: r2(x), z: r2(z) });
        return true;
      }
      default:
        return false;
    }
  }

  private deny(p: SimPlayer, why: string): false {
    if (!p.bot) this.denies.push({ id: p.id, why });
    return false;
  }

  private canAct(p: SimPlayer): Board | null {
    if (p.board < 0) return null;
    const bd = this.boards[p.board];
    return bd && !bd.out ? bd : null;
  }

  private build(p: SimPlayer, t: unknown, x: unknown, y: unknown): boolean {
    const bd = this.canAct(p);
    if (!bd) return this.deny(p, 'You are not defending a garden');
    if (!isTowerKind(t) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
    const col = x as number;
    const row = y as number;
    if (col < 0 || row < 0 || col >= this.W || row >= this.H) return this.deny(p, "Can't build there");
    const ci = row * this.W + col;
    if (!bd.buildable[ci] || bd.cells[ci]) return this.deny(p, "Can't build there");
    const cost = TOWERS[t].levels[0].cost;
    if (p.gold < cost) return this.deny(p, 'Not enough gold');
    p.gold -= cost;
    p.score.built += cost;
    const id = this.nextId++;
    const w = cellToWorld(this.def, bd.origin, col + 0.5, row + 0.5);
    const info: TowerInfo = { id, k: t, lv: 1, b: bd.b, x: col, y: row, own: p.id, tm: 0, spent: cost };
    const tw: Tower = {
      info,
      builtIn: this.phase === 'build' ? this.wave : -1,
      def: TOWERS[t],
      x: w.x,
      z: w.z,
      tg: 0,
      ch: [],
      f: 0,
      cd: 0,
      disabled: 0,
      zapT: 0,
      reflect: 0,
      bDmg: 0,
      bRate: 0,
      bRange: 0,
      lv: TOWERS[t].levels[0],
    };
    bd.cells[ci] = id;
    bd.tw.push(tw);
    bd.freeCache = null;
    this.towers.set(id, tw);
    this.events.push({ k: 'build', t: { ...info } });
    return true;
  }

  private towerFor(p: SimPlayer, id: unknown, ownerOnly: boolean): Tower | null {
    if (!Number.isInteger(id)) return null;
    const tw = this.towers.get(id as number);
    if (!tw) return null;
    const bd = this.boards[tw.info.b];
    if (bd.out) return null;
    if (ownerOnly || this.mode === 'vs') {
      if (tw.info.own !== p.id && !(this.mode === 'vs' && bd.owner === p.id)) return null;
    }
    if (this.mode === 'vs' && p.board !== tw.info.b) return null;
    if (p.board < 0) return null;
    return tw;
  }

  private upgrade(p: SimPlayer, id: unknown): boolean {
    const tw = this.towerFor(p, id, false);
    if (!tw) return this.deny(p, "You can't upgrade that");
    if (tw.info.lv >= 3) return this.deny(p, 'Already at max level');
    const next = (tw.info.lv + 1) as Level;
    const cost = tw.def.levels[next - 1].cost;
    if (p.gold < cost) return this.deny(p, 'Not enough gold');
    p.gold -= cost;
    p.score.built += cost;
    tw.info.lv = next;
    tw.info.spent += cost;
    tw.lv = tw.def.levels[next - 1];
    this.events.push({ k: 'up', id: tw.info.id, lv: next, by: p.id, spent: tw.info.spent });
    return true;
  }

  private sell(p: SimPlayer, id: unknown): boolean {
    const tw = this.towerFor(p, id, true);
    if (!tw) return this.deny(p, 'Only the builder can sell that');
    const undo = this.phase === 'build' && tw.builtIn === this.wave;
    const refund = undo ? tw.info.spent : Math.floor(tw.info.spent * G.sellRefund);
    p.gold += refund;
    this.events.push({ k: 'gold', id: p.id, n: refund, why: 'refund' });
    const bd = this.boards[tw.info.b];
    bd.cells[tw.info.y * this.W + tw.info.x] = 0;
    const i = bd.tw.indexOf(tw);
    if (i >= 0) bd.tw.splice(i, 1);
    bd.freeCache = null;
    this.towers.delete(tw.info.id);
    this.events.push({ k: 'sell', id: tw.info.id, by: p.id, refund });
    return true;
  }

  private setTarget(p: SimPlayer, id: unknown, tm: unknown): boolean {
    const tw = this.towerFor(p, id, false);
    if (!tw || !tw.def.targets) return false;
    if (!Number.isInteger(tm) || (tm as number) < 0 || (tm as number) > 3) return false;
    if (tw.info.tm === tm) return true;
    tw.info.tm = tm as TargetMode;
    this.events.push({ k: 'tm', id: tw.info.id, tm: tw.info.tm });
    return true;
  }

  /** The wave a send made now enters (sends always join the target's next wave). */
  private sendWave() {
    return this.wave + 1;
  }

  private send(p: SimPlayer, e: unknown, to: unknown): boolean {
    if (this.mode !== 'vs') return false;
    const own = this.canAct(p);
    if (!own) return this.deny(p, 'Your garden is gone');
    if (!isEnemyKind(e)) return false;
    const sd = SENDS.find((s) => s.kind === e);
    if (!sd) return false;
    const w = this.sendWave();
    if (w < sd.from) return this.deny(p, `Unlocks on wave ${sd.from}`);
    if (p.sends >= sendCap(w)) return this.deny(p, 'Send limit reached this wave');
    let target: Board | undefined;
    if (to !== undefined && to !== null) {
      if (!Number.isInteger(to)) return false;
      target = this.boards[to as number];
      if (!target || target.out || target.b === own.b) return this.deny(p, 'Pick a living opponent');
    } else {
      const n = this.boards.length;
      for (let i = 1; i <= n && !target; i++) {
        const c = this.boards[(own.b + p.sendRR + i) % n];
        if (!c.out && c.b !== own.b) target = c;
      }
      if (!target) return this.deny(p, 'No opponent left');
      p.sendRR = (target.b - own.b + n) % n;
    }
    if (p.gold < sd.cost) return this.deny(p, 'Not enough gold');
    p.gold -= sd.cost;
    p.income += sd.income;
    p.sends++;
    p.score.sent += sd.cost;
    for (let i = 0; i < sd.count; i++) target.queued.push({ kind: sd.kind, from: p.id });
    this.events.push({ k: 'send', from: p.id, to: target.b, kind: sd.kind, n: sd.count });
    return true;
  }

  private queueSent(bd: Board, kind: EnemyKind, hpMul: number, at: number, from: string) {
    const r = bd.rr++ % bd.routes.length;
    if (kind === 'skitter') this.queuePack(bd, r, at, hpMul, from);
    else bd.pending.push({ at, kind, r, hpMul, o: this.lat(), from });
  }

  private queuePack(bd: Board, r: number, at: number, hpMul: number, from: string | null) {
    for (let k = 0; k < SKITTER_PACK; k++) {
      const o = SKITTER_PACK > 1 ? -0.8 + (1.6 * k) / (SKITTER_PACK - 1) : 0;
      bd.pending.push({ at, kind: 'skitter', r, hpMul, o, from });
    }
  }

  private lat() {
    return -0.8 + this.rng() * 1.6;
  }

  // ---- phases -----------------------------------------------------------------------------------------------------

  private allReady(): boolean {
    let humans = 0;
    for (const p of this.players.values()) {
      if (p.board < 0 || this.boards[p.board].out) continue;
      if (p.bot) {
        if (!p.ready && p.gold >= CHEAPEST_TOWER) return false;
      } else {
        humans++;
        if (!p.ready) return false;
      }
    }
    // A bots-only match (the balance tool) still needs the bots to be done.
    return humans > 0 || this.players.size > 0;
  }

  private startWave() {
    const skipped = Math.min(G.betweenWaves, Math.max(0, Math.floor(this.left)));
    if (skipped > 0) {
      const bonus = skipped * G.earlyBonusPerSec;
      for (const p of this.players.values())
        if (p.board >= 0 && !this.boards[p.board].out) {
          p.gold += bonus;
          this.events.push({ k: 'gold', id: p.id, n: bonus, why: 'early' });
        }
    }
    this.wave++;
    this.phase = 'wave';
    this.left = 0;
    const n = this.wave;
    const players = this.defenders();
    const hpMul = waveHp(n) * (this.mode === 'coop' ? coopHp(players) * coopEarly(n, players, this.avgDefenderGold()) : vsHpRamp(n));
    const cMul = this.mode === 'coop' ? coopCount(players) : 1;
    this.waveSpawned = 0;
    this.lastSpawnAt = this.time;
    for (const p of this.holders()) {
      p.ready = false;
      p.sends = 0;
      if (this.mode === 'vs' && p.board >= 0 && !this.boards[p.board].out) {
        const inc = G.baseIncome + p.income;
        p.gold += inc;
        this.events.push({ k: 'gold', id: p.id, n: inc, why: 'income' });
      }
    }
    for (const bd of this.boards) {
      if (bd.out) continue;
      const routes = bd.routes.length;
      for (const g of waveSpawns(n, routes)) {
        const boss = g.kind === 'colossus';
        const count = boss ? g.count : Math.max(1, Math.round(g.count * cMul));
        const gap = boss ? g.gap : g.gap / cMul;
        for (let i = 0; i < count; i++) {
          const r = g.route < 0 ? bd.rr++ % routes : Math.min(g.route, routes - 1);
          const at = this.time + g.at + i * gap;
          if (at > this.lastSpawnAt) this.lastSpawnAt = at;
          if (g.kind === 'skitter') this.queuePack(bd, r, at, hpMul, null);
          else bd.pending.push({ at, kind: g.kind, r, hpMul, o: this.lat(), from: null });
        }
      }
      // Sent units: health of the wave they enter (versus only, so no co-op scaling).
      const sentHp = waveHp(n) * vsHpRamp(n);
      let k = 0;
      for (const q of bd.queued) this.queueSent(bd, q.kind, sentHp, this.time + SEND_AT + SEND_GAP * k++, q.from);
      bd.queued.length = 0;
      bd.cleared = false;
    }
    this.events.push({ k: 'wave', n, boss: n % 10 === 0 ? 1 : 0 });
  }

  private waveCleared(): boolean {
    for (const bd of this.boards) if (!bd.out && (bd.pending.length > 0 || bd.en.length > 0)) return false;
    return true;
  }

  /** Versus: pay each board its clear bonus as soon as it is empty; the build phase starts when all are, or on overtime. */
  private vsClears() {
    const bonus = G.clearBonus + G.clearBonusPerWave * this.wave;
    let all = true;
    for (const bd of this.boards) {
      if (bd.out || bd.cleared) continue;
      if (bd.pending.length > 0 || bd.en.length > 0) {
        all = false;
        continue;
      }
      bd.cleared = true;
      this.events.push({ k: 'clear', n: this.wave, bonus, b: bd.b });
      for (const p of this.holders())
        if (p.board === bd.b) {
          p.gold += bonus;
          this.events.push({ k: 'gold', id: p.id, n: bonus, why: 'clear' });
        }
    }
    if (this.phase !== 'wave') return;
    if (all || this.time > this.lastSpawnAt + G.vsOvertime) {
      this.phase = 'build';
      this.left = G.betweenWaves;
    }
  }

  /**
   * Co-op: every human defender is ready during a wave, its spawns are done and at most G.overlapLeft enemies are
   * still walking (not on the last wave): the next wave starts over the stragglers.
   */
  private overlapReady(): boolean {
    if (this.mode !== 'coop' || this.wave >= G.coopWaves) return false;
    const bd = this.boards[0];
    if (bd.pending.length > 0) return false;
    let alive = 0;
    for (const e of bd.en) if (!e.dead) alive++;
    if (alive > G.overlapLeft) return false;
    let humans = 0;
    for (const p of this.players.values()) {
      if (p.bot || p.board < 0) continue;
      humans++;
      if (!p.ready) return false;
    }
    return humans > 0;
  }

  /** Starts the next co-op wave early: this wave's clear bonus now, plus the small G.overlapBonus to every defender. */
  private overlapWave() {
    this.payClear();
    for (const p of this.players.values())
      if (p.board >= 0) {
        p.gold += G.overlapBonus;
        this.events.push({ k: 'gold', id: p.id, n: G.overlapBonus, why: 'early' });
      }
    this.left = 0;
    this.startWave();
  }

  private clearWave() {
    this.payClear();
    if (this.mode === 'coop' && this.wave >= G.coopWaves) {
      this.finish({ win: true, winner: null, wave: this.wave });
      return;
    }
    this.phase = 'build';
    this.left = G.betweenWaves;
  }

  private payClear() {
    const bonus = G.clearBonus + G.clearBonusPerWave * this.wave;
    this.clearPaid += bonus;
    this.events.push({ k: 'clear', n: this.wave, bonus });
    for (const p of this.players.values())
      if (p.board >= 0) {
        p.gold += bonus;
        this.events.push({ k: 'gold', id: p.id, n: bonus, why: 'clear' });
      }
  }

  private finish(e: SimEnd) {
    this.end = e;
    this.phase = 'over';
    for (const bd of this.boards) {
      bd.en.length = 0;
      bd.pending.length = 0;
    }
    this.enemies.clear();
    this.missiles.length = 0;
  }

  // ---- main step --------------------------------------------------------------------------------------------------

  step(dt: number) {
    if (this.end) return;
    this.tick++;
    this.time += dt;
    if (this.mode === 'vs') for (const [key, pk] of this.parked) if (this.time - pk.at > VS_RECLAIM) this.parked.delete(key);
    for (const bd of this.boards) bd.livesAtTick = bd.lives;
    this.runBots(dt);
    if (this.end) return;
    if (this.phase === 'build') {
      if (!this.hold) this.left -= dt;
      if (this.left <= 0 || this.allReady()) this.startWave();
    }
    for (const bd of this.boards) {
      if (bd.out) continue;
      this.spawn(bd);
      this.auras(bd, dt);
      this.fields(bd, dt);
      this.move(bd, dt);
      this.disruptors(bd, dt);
      this.fire(bd, dt);
    }
    this.flyMissiles(dt);
    for (const bd of this.boards) this.sweep(bd);
    this.checkBoards();
    if (this.end) return;
    if (this.mode === 'vs') this.vsClears();
    else if (this.phase === 'wave') {
      if (this.waveCleared()) this.clearWave();
      else if (this.overlapReady()) this.overlapWave();
    }
  }

  private spawn(bd: Board) {
    const pend = bd.pending;
    for (let i = pend.length - 1; i >= 0; i--) {
      const s = pend[i];
      if (s.at > this.time) continue;
      pend[i] = pend[pend.length - 1];
      pend.pop();
      this.addEnemy(bd, s.kind, s.r, 0, s.o, s.hpMul, s.from);
    }
  }

  private addEnemy(bd: Board, kind: EnemyKind, r: number, d: number, o: number, hpMul: number, from: string | null): Enemy {
    const def = ENEMIES[kind];
    const hp = def.hp * hpMul;
    const e: Enemy = {
      id: this.nextId++,
      kind,
      def,
      b: bd.b,
      r,
      len: bd.routes[r].length,
      d,
      o,
      hp,
      maxHp: hp,
      hpMul,
      speed: def.speed * (0.95 + this.rng() * 0.1),
      x: 0,
      z: 0,
      slow: 0,
      zapT: 0,
      stun: 0,
      disT: def.disrupt ? def.disrupt.every * (0.5 + this.rng() * 0.5) : 0,
      shed: 0,
      from,
      dead: false,
    };
    routePos(bd.routes[r], d, o, this.pos);
    e.x = this.pos.x;
    e.z = this.pos.z;
    bd.en.push(e);
    this.enemies.set(e.id, e);
    this.stats.spawned++;
    this.waveSpawned++;
    const ev: GEvent = { k: 'spawn', en: e.id, kind, b: bd.b, r, d: r1(d), o: r2(o), max: Math.round(hp) };
    if (from) ev.from = from;
    this.events.push(ev);
    return e;
  }

  /** Shield cover and beacon buffs, from towers that are not disabled. */
  private auras(bd: Board, dt: number) {
    const tw = bd.tw;
    for (let i = 0; i < tw.length; i++) {
      const t = tw[i];
      if (t.disabled > 0) t.disabled = Math.max(0, t.disabled - dt);
      t.reflect = -1;
      t.bDmg = 0;
      t.bRate = 0;
      t.bRange = 0;
    }
    for (let i = 0; i < tw.length; i++) {
      const s = tw[i];
      const k = s.info.k;
      if ((k !== 'shield' && k !== 'beacon') || s.disabled > 0) continue;
      const r2 = s.lv.range * s.lv.range;
      for (let j = 0; j < tw.length; j++) {
        const t = tw[j];
        const dx = t.x - s.x;
        const dz = t.z - s.z;
        if (dx * dx + dz * dz > r2) continue;
        if (k === 'shield') t.reflect = Math.max(t.reflect, s.lv.reflect ?? 0);
        else if (t !== s && t.info.k !== 'beacon' && (s.lv.buffDmg ?? 0) > t.bDmg) {
          // Strongest beacon only: its whole buff set applies, nothing stacks.
          t.bDmg = s.lv.buffDmg ?? 0;
          t.bRate = s.lv.buffRate ?? 0;
          t.bRange = s.lv.buffRange ?? 0;
        }
      }
    }
    for (let i = 0; i < tw.length; i++) {
      const t = tw[i];
      t.f = (t.disabled > 0 ? TFlag.disabled : 0) | (t.reflect >= 0 ? TFlag.shielded : 0) | (t.bDmg > 0 ? TFlag.buffed : 0);
    }
  }

  /** Slow fields and shield pulses. */
  private fields(bd: Board, dt: number) {
    const en = bd.en;
    for (let i = 0; i < en.length; i++) {
      en[i].slow = 0;
      if (en[i].zapT > 0) en[i].zapT -= dt;
    }
    const tw = bd.tw;
    for (let i = 0; i < tw.length; i++) {
      const t = tw[i];
      const k = t.info.k;
      if (k !== 'slow' && k !== 'shield') continue;
      if (t.disabled > 0) {
        t.tg = 0;
        continue;
      }
      const range = t.lv.range;
      const r2 = range * range;
      const mul = (1 + t.bDmg) * (1 + t.bRate);
      if (k === 'slow') {
        const slow = t.lv.slow ?? 0;
        const dmg = t.lv.dmg * mul * dt;
        // Skitters a colossus sheds during this pass join en but are not part of it.
        for (let j = 0, n = en.length; j < n; j++) {
          const e = en[j];
          if (e.dead) continue;
          const dx = e.x - t.x;
          const dz = e.z - t.z;
          if (dx * dx + dz * dz > r2) continue;
          if (slow > e.slow) e.slow = slow;
          if (dmg > 0) this.hurt(e, dmg, t.def.pierce, t);
        }
      } else {
        t.zapT -= dt;
        if (t.zapT > 0) continue;
        let hit = false;
        const dmg = t.lv.dmg * mul * ZAP_EVERY;
        for (let j = 0, n = en.length; j < n; j++) {
          const e = en[j];
          if (e.dead) continue;
          const dx = e.x - t.x;
          const dz = e.z - t.z;
          if (dx * dx + dz * dz > r2) continue;
          hit = true;
          e.zapT = 0.35;
          this.hurt(e, dmg, t.def.pierce, t);
        }
        if (hit) {
          t.zapT = ZAP_EVERY;
          this.events.push({ k: 'zap', tw: t.info.id });
        } else t.zapT = 0;
      }
    }
  }

  private move(bd: Board, dt: number) {
    const en = bd.en;
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      if (e.dead) continue;
      if (e.stun > 0) e.stun -= dt;
      else e.d += e.speed * (1 - e.slow) * dt;
      if (e.d >= e.len) {
        this.leak(bd, e);
        continue;
      }
      routePos(bd.routes[e.r], e.d, e.o, this.pos);
      e.x = this.pos.x;
      e.z = this.pos.z;
    }
  }

  private leak(bd: Board, e: Enemy) {
    e.dead = true;
    bd.lives = Math.max(0, bd.lives - e.def.lives);
    this.stats.leaks += e.def.lives;
    const ev: GEvent = { k: 'leak', en: e.id, b: bd.b, lives: bd.lives, x: r2(e.x), z: r2(e.z) };
    if (e.from) ev.from = e.from;
    this.events.push(ev);
  }

  private disruptors(bd: Board, dt: number) {
    const en = bd.en;
    const tw = bd.tw;
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      const dis = e.def.disrupt;
      if (!dis || e.dead || e.stun > 0) continue;
      e.disT -= dt;
      if (e.disT > 0) continue;
      let best: Tower | null = null;
      let bestD = dis.range * dis.range;
      for (let j = 0; j < tw.length; j++) {
        const t = tw[j];
        if (t.disabled > 0) continue;
        const dx = t.x - e.x;
        const dz = t.z - e.z;
        const d2 = dx * dx + dz * dz;
        if (d2 <= bestD) {
          bestD = d2;
          best = t;
        }
      }
      if (!best) {
        e.disT = CHARGE_TIME * 0.5;
        continue;
      }
      if (e.disT > -CHARGE_TIME) continue; // charging (EFlag.charging while disT is in (-CHARGE_TIME, 0])
      e.disT = dis.every;
      const blocked = best.reflect >= 0;
      this.events.push({ k: 'dis', en: e.id, tw: best.info.id, blocked: blocked ? 1 : 0 });
      if (blocked) {
        if (best.reflect > 0) e.stun = best.reflect;
      } else {
        best.disabled = dis.dur;
        best.tg = 0;
        best.ch.length = 0;
        best.f |= TFlag.disabled;
      }
    }
  }

  /** Best target for tower t in range (squared) by its targeting mode, skipping `skip` ids. */
  private pick(bd: Board, t: Tower, range: number, skipA = 0, skipB = 0): Enemy | null {
    const en = bd.en;
    const r2 = range * range;
    const mode = t.info.tm;
    let best: Enemy | null = null;
    let bestS = -Infinity;
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      if (e.dead || e.id === skipA || e.id === skipB) continue;
      const dx = e.x - t.x;
      const dz = e.z - t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const s = mode === 0 ? e.d - e.len : mode === 1 ? e.len - e.d : mode === 2 ? e.hp : -d2;
      if (s > bestS) {
        bestS = s;
        best = e;
      }
    }
    return best;
  }

  private fire(bd: Board, dt: number) {
    const tw = bd.tw;
    for (let i = 0; i < tw.length; i++) {
      const t = tw[i];
      const k = t.info.k;
      if (k !== 'laser' && k !== 'missile') continue;
      if (t.disabled > 0) {
        t.tg = 0;
        t.ch.length = 0;
        continue;
      }
      const range = t.lv.range * (1 + t.bRange);
      if (k === 'laser') {
        const e = this.pick(bd, t, range);
        t.ch.length = 0;
        if (!e) {
          t.tg = 0;
          continue;
        }
        t.tg = e.id;
        const dmg = t.lv.dmg * (1 + t.bDmg) * (1 + t.bRate) * dt;
        const cx = e.x;
        const cz = e.z;
        this.hurt(e, dmg, t.def.pierce, t);
        const chains = t.lv.count ?? 0;
        let px = cx;
        let pz = cz;
        for (let c = 0; c < chains; c++) {
          const n = this.nearest(bd, px, pz, CHAIN_HOP, e.id, t.ch);
          if (!n) break;
          t.ch.push(n.id);
          px = n.x;
          pz = n.z;
          this.hurt(n, dmg * CHAIN_SHARE, t.def.pierce, t);
        }
      } else {
        t.cd -= dt;
        const e = this.pick(bd, t, range);
        t.tg = e ? e.id : 0;
        if (t.cd > 0 || !e) {
          if (t.cd < 0) t.cd = 0;
          continue;
        }
        t.cd = (t.lv.interval ?? 1.5) / (1 + t.bRate);
        const count = t.lv.count ?? 1;
        const dmg = t.lv.dmg * (1 + t.bDmg);
        let a = 0;
        let b = 0;
        for (let m = 0; m < count; m++) {
          const target = m === 0 ? e : (this.pick(bd, t, range, a, b) ?? e);
          if (m === 0) a = target.id;
          else if (m === 1) b = target.id;
          const dist = Math.hypot(target.x - t.x, target.z - t.z);
          const ft = Math.max(0.25, dist / MISSILE_SPEED) + m * 0.08;
          const mid = this.nextMid++;
          this.missiles.push({ mid, b: bd.b, tw: t.info.id, owner: t.info.own, en: target.id, x: target.x, z: target.z, t: ft, dmg, splash: t.lv.splash ?? 1.5 });
          this.events.push({ k: 'msl', tw: t.info.id, en: target.id, mid, ft: r2(ft) });
        }
      }
    }
  }

  private nearest(bd: Board, x: number, z: number, maxD: number, skip: number, skipList: number[]): Enemy | null {
    const en = bd.en;
    let best: Enemy | null = null;
    let bestD = maxD * maxD;
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      if (e.dead || e.id === skip || skipList.includes(e.id)) continue;
      const dx = e.x - x;
      const dz = e.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bestD) {
        bestD = d2;
        best = e;
      }
    }
    return best;
  }

  private flyMissiles(dt: number) {
    const ms = this.missiles;
    for (let i = ms.length - 1; i >= 0; i--) {
      const m = ms[i];
      const e = this.enemies.get(m.en);
      if (e && !e.dead) {
        m.x = e.x;
        m.z = e.z;
      }
      m.t -= dt;
      if (m.t > 0) continue;
      ms[i] = ms[ms.length - 1];
      ms.pop();
      const bd = this.boards[m.b];
      if (bd.out) continue;
      this.events.push({ k: 'boom', b: m.b, x: r2(m.x), z: r2(m.z), r: m.splash, mid: m.mid });
      const t = this.towers.get(m.tw) ?? null;
      const en = bd.en;
      // Skitters shed by this blast are not hit by it.
      for (let j = 0, n = en.length; j < n; j++) {
        const v = en[j];
        if (v.dead) continue;
        const dist = Math.hypot(v.x - m.x, v.z - m.z);
        if (dist > m.splash + v.def.radius) continue;
        const f = 1 - 0.5 * Math.min(1, dist / m.splash);
        this.hurt(v, m.dmg * f, TOWERS.missile.pierce, t, m.owner);
      }
    }
  }

  private hurt(e: Enemy, raw: number, pierce: number, t: Tower | null, owner = t?.info.own) {
    if (e.dead) return;
    const amt = raw * (1 - e.def.armor * (1 - pierce));
    const dealt = Math.min(amt, e.hp);
    e.hp -= amt;
    const p = this.holder(owner ?? null);
    if (p) p.score.dmg += dealt;
    if (e.def.shed && e.shed < SHED_AT.length) {
      let n = 0;
      while (e.shed < SHED_AT.length && e.hp / e.maxHp < SHED_AT[e.shed]) {
        e.shed++;
        n += e.def.shed;
      }
      if (n > 0) this.shed(e, n);
    }
    if (e.hp <= 0) this.kill(e, t, p);
  }

  private shed(e: Enemy, n: number) {
    const bd = this.boards[e.b];
    const skHp = e.hpMul;
    for (let i = 0; i < n; i++) {
      const o = n > 1 ? -0.8 + (1.6 * (i % SKITTER_PACK)) / (SKITTER_PACK - 1) : 0;
      this.addEnemy(bd, 'skitter', e.r, Math.max(0, e.d - 0.4 * Math.floor(i / SKITTER_PACK)), o, skHp, e.from);
    }
    this.events.push({ k: 'shed', en: e.id, n });
  }

  private kill(e: Enemy, t: Tower | null, p: SimPlayer | undefined) {
    e.dead = true;
    this.stats.kills++;
    if (p) p.score.kills++;
    const bounty = e.def.bounty * waveBounty(this.wave);
    const ev: GEvent = { k: 'die', en: e.id, kind: e.kind, by: t ? t.info.id : 0, gold: 0, b: e.b, x: r2(e.x), z: r2(e.z) };
    if (this.mode === 'coop') {
      ev.gold = Math.ceil(bounty * coopBountyShare(this.defenders()));
      for (const q of this.players.values()) if (q.board >= 0) q.gold += ev.gold;
    } else {
      const q = this.holder(this.boards[e.b].owner);
      if (q) {
        ev.gold = Math.round(bounty * (e.from ? SENT_BOUNTY : 1));
        ev.to = q.id;
        q.gold += ev.gold;
      }
    }
    this.events.push(ev);
  }

  private sweep(bd: Board) {
    const en = bd.en;
    let w = 0;
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      if (e.dead) this.enemies.delete(e.id);
      else en[w++] = e;
    }
    en.length = w;
  }

  private checkBoards() {
    if (this.mode === 'coop') {
      if (this.boards[0].lives <= 0) this.finish({ win: false, winner: null, wave: this.wave });
      return;
    }
    const falling = this.boards.filter((b) => !b.out && b.lives <= 0);
    if (!falling.length) return;
    // Worst first: fewer lives at the start of the tick, then less damage dealt by the owner.
    const dmg = (b: Board) => (this.holder(b.owner)?.score.dmg ?? 0);
    falling.sort((a, b) => a.livesAtTick - b.livesAtTick || dmg(a) - dmg(b));
    const living = this.boards.filter((b) => !b.out).length;
    // When every remaining garden falls on the same tick, the best of them is the last one standing.
    const survivor = falling.length >= living ? falling.pop() : undefined;
    for (const bd of falling) this.eliminate(bd);
    const rest = this.boards.filter((b) => !b.out);
    if (rest.length <= 1) {
      const win = survivor ?? rest[0];
      if (win) {
        win.place = 1;
        for (const p of this.holders()) if (p.board === win.b) p.score.place = 1;
      }
      this.finish({ win: !!win, winner: win?.owner ?? null, wave: this.wave });
    }
  }

  private eliminate(bd: Board) {
    bd.out = true;
    bd.place = this.boards.filter((b) => !b.out).length + 1;
    bd.en.length = 0;
    bd.pending.length = 0;
    bd.queued.length = 0;
    for (const t of bd.tw) {
      t.tg = 0;
      t.ch.length = 0;
    }
    for (const [id, e] of this.enemies) if (e.b === bd.b) this.enemies.delete(id);
    for (const p of this.holders()) if (p.board === bd.b) p.score.place = bd.place;
    this.events.push({ k: 'out', b: bd.b, place: bd.place });
  }

  // ---- bots -------------------------------------------------------------------------------------------------------

  private runBots(dt: number) {
    for (const p of this.players.values()) {
      if (!p.brain || p.board < 0 || this.boards[p.board].out) continue;
      p.thinkT -= dt;
      if (p.thinkT > 0) continue;
      p.thinkT += BOT_THINK;
      let actions: BotAction[];
      try {
        actions = p.brain.think(this.botView(p), BOT_THINK);
      } catch (err) {
        console.error('garden bot error', err);
        continue;
      }
      if (!Array.isArray(actions)) continue;
      for (const a of actions.slice(0, 8)) {
        this.handle(p.id, a);
        if (this.end) return;
      }
    }
  }

  private free(bd: Board): [number, number][] {
    if (bd.freeCache) return bd.freeCache;
    const out: [number, number][] = [];
    for (let r = 0; r < this.H; r++)
      for (let c = 0; c < this.W; c++) {
        const i = r * this.W + c;
        if (bd.buildable[i] && !bd.cells[i]) out.push([c, r]);
      }
    bd.freeCache = out;
    return out;
  }

  private botView(p: SimPlayer): BotView {
    const bd = this.boards[p.board];
    const enemies: BotEnemyView[] = bd.en
      .filter((e) => !e.dead)
      .map((e) => ({ id: e.id, kind: e.kind, b: e.b, route: e.r, d: e.d, hp: e.hp, maxHp: e.maxHp, x: e.x, z: e.z }));
    const def = this.def;
    const origin = bd.origin;
    return {
      mode: this.mode,
      def,
      board: bd.b,
      routes: this.boards.map((b) => b.routes),
      free: this.free(bd).map(([c, r]) => [c, r] as [number, number]),
      toWorld: (col, row) => cellToWorld(def, origin, col + 0.5, row + 0.5),
      wave: this.wave,
      phase: this.phase,
      left: this.left,
      gold: p.gold,
      income: this.mode === 'vs' ? G.baseIncome + p.income : 0,
      lives: bd.lives,
      towers: bd.tw.map((t) => ({ ...t.info })),
      enemies,
      opponents:
        this.mode === 'vs' ? this.boards.filter((b) => !b.out && b.b !== bd.b).map((b) => ({ b: b.b, lives: b.lives, owner: b.owner ?? '' })) : [],
      players: this.defenders(),
      sendsLeft: this.mode === 'vs' ? Math.max(0, sendCap(this.sendWave()) - p.sends) : 0,
    };
  }

  // ---- wire views -------------------------------------------------------------------------------------------------

  boardInfo(): BoardInfo[] {
    return this.boards.map((b) => (b.place ? { b: b.b, own: b.owner, place: b.place } : { b: b.b, own: b.owner }));
  }

  towerInfos(): TowerInfo[] {
    return [...this.towers.values()].map((t) => ({ ...t.info }));
  }

  scores(): GScore[] {
    const n = this.boards.length;
    return [...this.players.values()]
      .filter((p) => p.board >= 0 || p.score.dmg > 0)
      .map((p) => {
        const s = p.score;
        const base = Math.round(s.dmg / 10 + s.kills);
        let points = base;
        if (this.mode === 'vs') {
          const bd = p.board >= 0 ? this.boards[p.board] : undefined;
          const place = bd ? (bd.out ? bd.place : 1) : n + 1;
          points = (n + 1 - place) * 1000 + base;
        }
        return { ...s, dmg: Math.round(s.dmg), points, ...(s.place ? { place: s.place } : {}) };
      });
  }

  private snapCache: { tick: number; en: EnemySnap[][]; tw: TowerSnap[][]; rest: Omit<GSnapshot, 'en' | 'tw' | 'eb'> } | null = null;

  /** Per-board enemy and tower lists plus the shared part, built once per tick however many clients ask. */
  private snapParts() {
    if (this.snapCache && this.snapCache.tick === this.tick) return this.snapCache;
    const en: EnemySnap[][] = [];
    const tw: TowerSnap[][] = [];
    const bd: BoardSnap[] = [];
    let left = 0;
    for (const b of this.boards) {
      const rem = b.pending.length + b.en.length;
      left += rem;
      const bs: BoardSnap = { b: b.b, lives: b.lives };
      if (b.out) bs.out = 1;
      if (rem) bs.rem = rem;
      if (b.queued.length) {
        const inc = new Map<EnemyKind, number>();
        for (const q of b.queued) inc.set(q.kind, (inc.get(q.kind) ?? 0) + (q.kind === 'skitter' ? SKITTER_PACK : 1));
        bs.inc = [...inc];
      }
      bd.push(bs);
      const be: EnemySnap[] = [];
      for (const e of b.en) {
        if (e.dead) continue;
        let f = e.from ? EFlag.sent : 0;
        if (e.slow > 0) f |= EFlag.slowed;
        if (e.zapT > 0) f |= EFlag.zapped;
        if (e.stun > 0) f |= EFlag.stunned;
        else if (e.def.disrupt && e.disT <= 0) f |= EFlag.charging;
        be.push({ id: e.id, k: e.kind, b: e.b, r: e.r, d: r1(e.d), o: r2(e.o), hp: r2(Math.max(0, e.hp / e.maxHp)), f });
      }
      en.push(be);
      const bt: TowerSnap[] = [];
      for (const t of b.tw) {
        const ts: TowerSnap = { id: t.info.id, tg: t.tg, f: t.f };
        if (t.ch.length) ts.ch = [...t.ch];
        bt.push(ts);
      }
      tw.push(bt);
    }
    const pl: PlayerSnap[] = [...this.players.values()].map((p) => ({
      id: p.id,
      gold: Math.floor(p.gold),
      inc: this.mode === 'vs' ? G.baseIncome + p.income : 0,
      rd: p.ready ? 1 : 0,
      b: p.board,
    }));
    let pendingAll = 0;
    for (const b of this.boards) pendingAll += b.pending.length;
    const rest: Omit<GSnapshot, 'en' | 'tw' | 'eb'> = {
      tick: this.tick,
      t: Date.now(),
      wave: this.wave,
      ph: this.phase,
      left: this.phase === 'build' ? Math.max(0, Math.round(this.left * 10) / 10) : left,
      tot: this.waveSpawned + pendingAll,
      bd,
      pl,
    };
    this.snapCache = { tick: this.tick, en, tw, rest };
    return this.snapCache;
  }

  /** Snapshot with every board, or only the boards in `include` (listed in `eb`). */
  snapshot(include?: ReadonlySet<number> | null): GSnapshot {
    const parts = this.snapParts();
    const en: EnemySnap[] = [];
    const tw: TowerSnap[] = [];
    const eb: number[] = [];
    for (let b = 0; b < this.boards.length; b++) {
      if (include && !include.has(b)) continue;
      eb.push(b);
      for (const e of parts.en[b]) en.push(e);
      for (const t of parts.tw[b]) tw.push(t);
    }
    const snap: GSnapshot = { ...parts.rest, en, tw };
    if (include) snap.eb = eb;
    return snap;
  }
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

// ---- fallback bot ---------------------------------------------------------------------------------------------------

/**
 * A plain bot used until (or if) bots.ts is unavailable: lasers on the cells that see the most path, a missile pod and
 * a slow flower now and then, upgrades when nothing new fits, and runner sends in versus.
 */
export const fallbackGardenBot: CreateBot = (_id, difficulty) => {
  let ranked: [number, number][] | null = null;
  let thinkT = 0;
  const pace = difficulty === 'easy' ? 1.5 : difficulty === 'hard' ? 0.25 : 0.6;
  return {
    think(v: BotView): BotAction[] {
      if (v.phase === 'over') return [];
      thinkT -= BOT_THINK;
      if (thinkT > 0) return [];
      thinkT = pace;
      if (!ranked) {
        const pts: { x: number; z: number }[] = [];
        for (const g of v.routes[v.board]) {
          for (let d = 0; d < g.length; d += 1) {
            const p = routePos(g, d);
            pts.push({ x: p.x, z: p.z });
          }
        }
        const score = new Map<string, number>();
        for (const [c, r] of v.free) {
          const w = v.toWorld(c, r);
          let s = 0;
          for (const p of pts) if (Math.hypot(p.x - w.x, p.z - w.z) < 7) s++;
          score.set(`${c},${r}`, s);
        }
        ranked = [...v.free].sort((a, b) => (score.get(`${b[0]},${b[1]}`) ?? 0) - (score.get(`${a[0]},${a[1]}`) ?? 0));
      }
      const acts: BotAction[] = [];
      const freeSet = new Set(v.free.map(([c, r]) => `${c},${r}`));
      const n = v.towers.length;
      const kind: TowerKind = n % 5 === 3 ? 'missile' : n % 7 === 5 ? 'slow' : n % 9 === 8 ? 'beacon' : 'laser';
      const cost = TOWERS[kind].levels[0].cost;
      let gold = v.gold;
      if (v.mode === 'vs' && v.wave >= 3 && gold > 260 && n >= 5) {
        acts.push({ k: 'send', e: v.wave >= 8 ? 'brute' : 'runner' });
        gold -= 160;
      }
      const spot = ranked.find(([c, r]) => freeSet.has(`${c},${r}`));
      const upg = v.towers
        .filter((t) => t.lv < 3 && t.k !== 'beacon')
        .map((t) => ({ t, c: (TOWERS[t.k].levels as TowerLevel[])[t.lv].cost }))
        .sort((a, b) => a.c - b.c)[0];
      if (spot && gold >= cost && (n < 6 + v.wave / 2 || !upg)) acts.push({ k: 'build', t: kind, x: spot[0], y: spot[1] });
      else if (upg && gold >= upg.c) acts.push({ k: 'up', id: upg.t.id });
      else if (v.phase === 'build') acts.push({ k: 'ready' });
      return acts;
    },
  };
};
