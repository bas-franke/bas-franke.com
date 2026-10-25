// Garden Sentinels bots. A bot is an ordinary player with its own gold: it reads the BotView a few times a second and
// answers with the same actions a human could send (build, upgrade, targeting, ready, versus sends).
//
// Placement works on samples taken every half metre along every route of the bot's board. A sample's weight grows
// towards the greenhouse, and shared trunks get one sample per route that walks them, so merge points count double.
// Each sample also knows how much tower damage already reaches it; well covered stretches count for less, which is
// what spreads several bots (and humans) across the entries in co-op instead of piling onto one corner.
//
// Every possible purchase (a new tower of each kind on each free cell, or an upgrade of one of the bot's own towers)
// gets a value in "damage per second x metres of path" and is ranked by value per gold. Normal and hard bots save up
// for a clearly better purchase (a level 3 missile pod beats three lasers); easy bots pick loosely among the top few.

import { rng } from '../../shared/math.js';
import type { BotDifficulty } from '../../shared/protocol.js';
import { G, coopHp } from '../../shared/garden/constants.js';
import { ENEMIES, SENDS, waveHp, waveSpawns, type EnemyKind } from '../../shared/garden/enemies.js';
import type { RouteGeom } from '../../shared/garden/board.js';
import type { TowerInfo } from '../../shared/garden/protocol.js';
import { TOWERS, TOWER_KINDS, type Level, type TargetMode, type TowerKind } from '../../shared/garden/towers.js';
import type { BotAction, BotView, CreateBot, GardenBotBrain } from './botapi.js';

interface Params {
  /** Seconds between thinks (min, max). */
  think: [number, number];
  /** Actions per think. */
  actions: number;
  /** Pick randomly among this many of the best affordable options. */
  topN: number;
  /** Multiplier on how attractive upgrades look. */
  upgrade: number;
  /** Save up for a better (unaffordable) option when the best affordable one is below this share of it (0 = never save). */
  save: number;
  /** Random noise on a cell's score (0..1). */
  noise: number;
  /** First wave missiles are considered. */
  missileFrom: number;
  /** Versus: share of new gold set aside for sends while the defence holds. */
  sendShare: number;
  /** Versus: chance a send goes at the weakest opponent instead of the default target. */
  finish: number;
  /** Seconds to wait after the last purchase before calling the wave. */
  readyDelay: number;
  /** Versus: first wave to send on, and how much defence (gold in towers, x the default curve) must stand first. */
  sendFrom: number;
  defNeed: number;
}

const PARAMS: Record<BotDifficulty, Params> = {
  easy: { think: [1.1, 1.5], actions: 1, topN: 6, upgrade: 0.45, save: 0, noise: 0.35, missileFrom: 6, sendShare: 0.15, finish: 0.1, readyDelay: 4, sendFrom: 6, defNeed: 1.3 },
  normal: { think: [0.6, 0.9], actions: 1, topN: 2, upgrade: 1, save: 0.7, noise: 0.08, missileFrom: 5, sendShare: 0.32, finish: 0.35, readyDelay: 1.5, sendFrom: 5, defNeed: 1.1 },
  hard: { think: [0.4, 0.55], actions: 2, topN: 1, upgrade: 1.1, save: 0.8, noise: 0, missileFrom: 3, sendShare: 0.5, finish: 0.6, readyDelay: 0.5, sendFrom: 4, defNeed: 1 },
};

const ATTACKERS: ReadonlySet<TowerKind> = new Set(['laser', 'missile']);
const STEP = 0.5;
const MAX_RANGE = 12.5;

interface Sample {
  x: number;
  z: number;
  /** Base weight (metres of path, scaled up towards the greenhouse). */
  w: number;
  /** 0 at the portal, 1 at the greenhouse. */
  prog: number;
}

interface Geo {
  key: string;
  samples: Sample[];
  /** Per buildable cell (row * W + col): samples within MAX_RANGE and their distances, nearest first. */
  near: Map<number, { idx: Int32Array; dist: Float32Array }>;
  W: number;
  /** World x/z of the board's north-west corner. */
  ox: number;
  oz: number;
}

interface Threat {
  /** HP-weighted armour of the next wave. */
  armor: number;
  /** How bunched up enemies are (raises splash value). */
  crowd: number;
  disruptors: number;
  heavy: boolean;
}

interface Cand {
  kind: 'build' | 'up';
  t: TowerKind;
  x: number;
  y: number;
  id: number;
  cost: number;
  ratio: number;
}

/** Sustained damage per second of one tower (single target, before armour). */
function rawDps(k: TowerKind, lv: Level): number {
  const L = TOWERS[k].levels[lv - 1];
  if (k === 'laser') return L.dmg * (1 + (L.count ?? 0) * 0.45);
  if (k === 'missile') return (L.dmg * (L.count ?? 1)) / (L.interval ?? 1);
  return L.dmg;
}

function effDps(k: TowerKind, lv: Level, th: Threat): number {
  const L = TOWERS[k].levels[lv - 1];
  let d = rawDps(k, lv) * (1 - th.armor * (1 - TOWERS[k].pierce));
  if (k === 'missile') d *= 1 + th.crowd * Math.min(1, (L.splash ?? 0) / 2);
  if (k === 'slow' || k === 'shield') d *= 1 + th.crowd;
  return d;
}

const range = (k: TowerKind, lv: Level) => TOWERS[k].levels[lv - 1].range;

function threatOf(wave: number, routes: number): Threat {
  const g = waveSpawns(Math.max(1, wave), routes);
  let hp = 0;
  let arm = 0;
  let sk = 0;
  let n = 0;
  let disruptors = 0;
  let heavy = false;
  for (const s of g) {
    const e = ENEMIES[s.kind];
    const count = s.kind === 'skitter' ? s.count * 5 : s.count;
    hp += e.hp * count;
    arm += e.hp * count * e.armor;
    n += count;
    if (s.kind === 'skitter') sk += count;
    if (s.kind === 'disruptor') disruptors += count;
    if (s.kind === 'brute' || s.kind === 'colossus') heavy = true;
  }
  return { armor: hp ? arm / hp : 0, crowd: 0.25 + (n ? (sk / n) * 1.2 : 0), disruptors, heavy };
}

function buildGeo(view: BotView, routes: RouteGeom[]): Geo {
  const def = view.def;
  const W = def.grid[0].length;
  let ox: number;
  let oz: number;
  if (routes.length && routes[0].route.pts.length) {
    // Route points are in cell units, so the board corner falls out of the first point.
    ox = routes[0].xs[0] - routes[0].route.pts[0][0] * G.cell;
    oz = routes[0].zs[0] - routes[0].route.pts[0][1] * G.cell;
  } else {
    // toWorld gives cell centres.
    const p = view.toWorld(0, 0);
    ox = p.x - G.cell / 2;
    oz = p.z - G.cell / 2;
  }
  const samples: Sample[] = [];
  for (const g of routes) {
    for (let d = STEP / 2; d < g.length; d += STEP) {
      let i = 0;
      while (i < g.cum.length - 2 && g.cum[i + 1] < d) i++;
      const seg = g.cum[i + 1] - g.cum[i] || 1;
      const t = (d - g.cum[i]) / seg;
      const prog = d / g.length;
      samples.push({
        x: g.xs[i] + (g.xs[i + 1] - g.xs[i]) * t,
        z: g.zs[i] + (g.zs[i + 1] - g.zs[i]) * t,
        // Enemies near the portal will still walk past later towers; the last stretch is the last chance.
        w: STEP * (0.8 + 0.5 * prog) * (d < 2 ? 0.5 : 1),
        prog,
      });
    }
  }
  const near = new Map<number, { idx: Int32Array; dist: Float32Array }>();
  def.grid.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== '.') continue;
      const cx = ox + (c + 0.5) * G.cell;
      const cz = oz + (r + 0.5) * G.cell;
      const list: [number, number][] = [];
      samples.forEach((s, i) => {
        const dd = Math.hypot(s.x - cx, s.z - cz);
        if (dd <= MAX_RANGE) list.push([i, dd]);
      });
      list.sort((a, b) => a[1] - b[1]);
      near.set(r * W + c, { idx: Int32Array.from(list.map((l) => l[0])), dist: Float32Array.from(list.map((l) => l[1])) });
    }
  });
  return { key: '', samples, near, W, ox, oz };
}

/** Sum of per-sample values within `r` of cell (col, row). */
function sumIn(geo: Geo, col: number, row: number, r: number, vals: Float64Array): number {
  const n = geo.near.get(row * geo.W + col);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n.idx.length && n.dist[i] <= r; i++) s += vals[n.idx[i]];
  return s;
}

class GardenBot implements GardenBotBrain {
  private p: Params;
  private r: () => number;
  private geo: Geo | null = null;
  private timer: number;
  private readyWave = -1;
  private lastBuy = 0;
  private clock = 0;
  private lastPhase = '';
  private livesAtWave = 0;
  private lostLast = 0;
  private lostPrev = 0;
  private lastGold = -1;
  private bank = 0;
  private waitSince = -1;
  private jitter = new Map<number, number>();

  constructor(private id: string, difficulty: BotDifficulty, seed: number) {
    this.p = PARAMS[difficulty] ?? PARAMS.normal;
    this.r = rng(seed ^ 0x9e3779b9);
    this.timer = 0.3 + this.r() * 1.2;
  }

  think(view: BotView, dt: number): BotAction[] {
    this.clock += dt;
    this.track(view);
    this.timer -= dt;
    if (this.timer > 0 || view.phase === 'over') return [];
    const [a, b] = this.p.think;
    this.timer = a + this.r() * (b - a);

    const routes = view.routes[view.board] ?? [];
    const key = `${view.def.id}|${view.board}|${routes.map((g) => `${g.xs[0]},${g.zs[0]},${g.length}`).join(';')}`;
    if (!this.geo || this.geo.key !== key) {
      this.geo = buildGeo(view, routes);
      this.geo.key = key;
      this.jitter.clear();
    }

    const out: BotAction[] = [];
    const towers = view.towers.filter((t) => t.b === view.board).map((t) => ({ ...t }));
    const mine = towers.filter((t) => t.own === this.id);

    // Targeting first: it is free.
    const tm = this.targeting(view, mine);
    if (tm) out.push(tm);

    let gold = view.gold;
    const geo = this.geo;
    const free = new Set(view.free.map(([c, r]) => r * geo.W + c));
    let bought = false;
    let waiting = false;
    while (out.length < this.p.actions + (tm ? 1 : 0)) {
      const spendable = gold - (view.mode === 'vs' ? Math.min(this.bank, gold) : 0) - this.reserve(view);
      // Cheapest thing we could buy at all; below that there is nothing to think about.
      let cheapest = Math.min(...TOWER_KINDS.map((k) => TOWERS[k].levels[0].cost));
      for (const t of towers) if (t.own === this.id && t.lv < 3) cheapest = Math.min(cheapest, TOWERS[t.k].levels[t.lv as 1 | 2].cost);
      const pick = spendable < cheapest ? null : this.choose(view, towers, free, spendable);
      if (pick === 'wait') {
        waiting = true;
        if (this.waitSince < 0) this.waitSince = this.clock;
        break;
      }
      this.waitSince = -1;
      if (!pick) break;
      if (pick.kind === 'build') {
        out.push({ k: 'build', t: pick.t, x: pick.x, y: pick.y });
        free.delete(pick.y * geo.W + pick.x);
        towers.push({ id: -1 - out.length, k: pick.t, lv: 1, b: view.board, x: pick.x, y: pick.y, own: this.id, tm: 0, spent: pick.cost });
      } else {
        out.push({ k: 'up', id: pick.id });
        const t = towers.find((q) => q.id === pick.id);
        if (t) t.lv = (t.lv + 1) as Level;
      }
      gold -= pick.cost;
      bought = true;
      this.lastBuy = this.clock;
    }

    if (view.mode === 'vs' && out.length < this.p.actions + 1) {
      const s = this.send(view, gold);
      if (s) out.push(s);
    }

    // Call the wave early once there is nothing worth buying (or we are saving up).
    // A bot saving up still readies after a few seconds, so it never holds humans back for long.
    if (!waiting) this.waitSince = -1;
    const patient = !waiting || this.clock - this.waitSince > 4;
    if (view.phase === 'build' && !bought && patient && this.readyWave !== view.wave && this.clock - this.lastBuy >= this.p.readyDelay) {
      this.readyWave = view.wave;
      out.push({ k: 'ready' });
    }
    return out;
  }

  /** Lives and gold bookkeeping, every tick. */
  private track(view: BotView) {
    if (view.phase !== this.lastPhase) {
      if (view.phase === 'wave') this.livesAtWave = view.lives;
      else if (view.phase === 'build' && this.lastPhase === 'wave') {
        this.lostPrev = this.lostLast;
        this.lostLast = Math.max(0, this.livesAtWave - view.lives);
        if (this.lostLast > 0) this.bank = 0;
      }
      this.lastPhase = view.phase;
    }
    if (this.lastGold >= 0 && view.gold > this.lastGold && view.mode === 'vs') {
      // Send only once the garden has a real defence and nothing got through for two waves.
      const built = view.towers.reduce((s, t) => s + (t.b === view.board && t.own === this.id ? t.spent : 0), 0);
      const holding =
        this.lostLast === 0 &&
        this.lostPrev === 0 &&
        view.wave >= this.p.sendFrom - 1 &&
        built >= (150 + 75 * view.wave) * this.p.defNeed &&
        !this.leakingNow(view);
      this.bank += (view.gold - this.lastGold) * (holding ? this.p.sendShare : 0);
    }
    if (this.leakingNow(view)) this.bank = 0;
    this.bank = Math.min(this.bank, view.gold);
    this.lastGold = view.gold;
  }

  private leakingNow(view: BotView) {
    return view.phase === 'wave' && this.livesAtWave > 0 && view.lives < this.livesAtWave;
  }

  private reserve(view: BotView) {
    // A small cushion late in the game, released as soon as anything leaks.
    if (view.wave < 12 || this.leakingNow(view) || this.lostLast > 0) return 0;
    return view.phase === 'wave' ? 25 + view.wave : 0;
  }

  private nextWave(view: BotView) {
    return view.phase === 'build' ? view.wave + 1 : Math.max(1, view.wave);
  }

  private choose(view: BotView, towers: TowerInfo[], free: Set<number>, gold: number): Cand | 'wait' | null {
    const geo = this.geo!;
    const S = geo.samples.length;
    if (!S) return null;
    const wave = this.nextWave(view);
    const routes = (view.routes[view.board] ?? []).length || 1;
    const th = threatOf(wave, routes);
    // Share of a tower's output disruptors are expected to take away (0 while none are coming).
    const seenDis = view.enemies.filter((e) => e.kind === 'disruptor' && e.b === view.board).length;
    const disrupt = th.disruptors || seenDis ? Math.min(0.6, 0.15 + 0.08 * Math.max(th.disruptors, seenDis)) : 0;
    const emergency = this.leakingNow(view) || this.lostLast > 0;

    // Sample weights, with the greenhouse end weighted up when things are leaking.
    const w = new Float64Array(S);
    geo.samples.forEach((s, i) => (w[i] = s.w * (emergency ? 1 + s.prog : 1)));

    // How much damage already reaches each sample.
    const cov = new Float64Array(S);
    const tval = new Map<number, number>();
    for (const t of towers) {
      if (!ATTACKERS.has(t.k)) continue;
      const e = effDps(t.k, t.lv, th);
      const n = geo.near.get(t.y * geo.W + t.x);
      if (!n) continue;
      const R = range(t.k, t.lv);
      let v = 0;
      for (let i = 0; i < n.idx.length && n.dist[i] <= R; i++) {
        cov[n.idx[i]] += e;
        v += e * w[n.idx[i]];
      }
      tval.set(t.id, v);
    }
    // Coverage beyond this much damage per second counts for less (scaled with how tough the next wave is).
    const D0 = 22 * waveHp(wave) * Math.sqrt(view.mode === 'coop' ? coopHp(view.players) : 1);
    const wNew = new Float64Array(S);
    const covCap = new Float64Array(S);
    for (let i = 0; i < S; i++) {
      wNew[i] = w[i] / (1 + cov[i] / D0);
      covCap[i] = w[i] * Math.min(cov[i], D0 * 2.5);
    }
    /** Strongest slow already on each sample (fields do not stack), optionally leaving one tower out. */
    const slowField = (except?: TowerInfo) => {
      const f = new Float64Array(S);
      for (const t of towers) {
        if (t.k !== 'slow' || t === except) continue;
        const n = geo.near.get(t.y * geo.W + t.x);
        const L = TOWERS.slow.levels[t.lv - 1];
        if (n) for (let i = 0; i < n.idx.length && n.dist[i] <= L.range; i++) f[n.idx[i]] = Math.max(f[n.idx[i]], L.slow ?? 0);
      }
      return f;
    };
    const slowNow = slowField();

    const cands: Cand[] = [];
    const nTowers = towers.filter((t) => ATTACKERS.has(t.k)).length;
    const kinds: TowerKind[] = ['laser'];
    if (wave >= this.p.missileFrom || th.heavy) kinds.push('missile');
    if (nTowers >= 2 && wave >= 2 && towers.filter((t) => t.k === 'slow').length * 2 < nTowers) kinds.push('slow');
    if (disrupt && nTowers >= 4 && towers.filter((t) => t.k === 'shield').length * 4 < nTowers) kinds.push('shield');
    if (nTowers >= 3) kinds.push('beacon');

    const attackers = towers.filter((t) => ATTACKERS.has(t.k));
    /** Distance in metres between two cells. */
    const cd = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by) * G.cell;
    // Attackers near each cell, for the aura towers (shield, beacon: radius at most ~7.2 m incl. upgrades).
    const nearAtt = new Map<number, TowerInfo[]>();
    const reach = Math.ceil(Math.max(range('shield', 3), range('beacon', 3)) / G.cell);
    for (const t of attackers)
      for (let dy = -reach; dy <= reach; dy++)
        for (let dx = -reach; dx <= reach; dx++) {
          const k = (t.y + dy) * geo.W + t.x + dx;
          let l = nearAtt.get(k);
          if (!l) nearAtt.set(k, (l = []));
          l.push(t);
        }
    const attackIn = (col: number, row: number, R: number) => (nearAtt.get(row * geo.W + col) ?? []).filter((t) => cd(t.x, t.y, col, row) <= R);
    const coveredExact = (k: TowerKind, t: TowerInfo, except?: TowerInfo) =>
      towers.some((s) => s.k === k && s !== t && s !== except && cd(s.x, s.y, t.x, t.y) <= range(k, s.lv));
    const coverCache = new Map<TowerInfo, [boolean, boolean]>();
    for (const t of towers) if (ATTACKERS.has(t.k)) coverCache.set(t, [coveredExact('shield', t), coveredExact('beacon', t)]);
    const covered = (k: TowerKind, t: TowerInfo, except?: TowerInfo) =>
      except || !coverCache.has(t) ? coveredExact(k, t, except) : coverCache.get(t)![k === 'shield' ? 0 : 1];

    /** Value of a tower of kind k at level lv standing on (col, row), given the current field. */
    const valueAt = (k: TowerKind, lv: Level, col: number, row: number, self?: TowerInfo): number => {
      const R = range(k, lv);
      const L = TOWERS[k].levels[lv - 1];
      if (k === 'laser' || k === 'missile') {
        let v = effDps(k, lv, th) * sumIn(geo, col, row, R, wNew);
        if (disrupt && !(self && covered('shield', self))) v *= 1 - disrupt * 0.5;
        return v;
      }
      if (k === 'slow') {
        const s = L.slow ?? 0;
        const have = self ? slowField(self) : slowNow;
        const n = geo.near.get(row * geo.W + col);
        let gain = 0;
        // Longer in range = more damage from every tower reaching the spot: 1/(1-s) instead of 1/(1-existing).
        if (n) for (let i = 0; i < n.idx.length && n.dist[i] <= R; i++) {
          const j = n.idx[i];
          if (have[j] < s) gain += covCap[j] * (1 / (1 - s) - 1 / (1 - have[j]));
        }
        return 0.5 * gain + effDps(k, lv, th) * sumIn(geo, col, row, R, wNew);
      }
      if (k === 'shield') {
        let prot = 0;
        for (const t of attackIn(col, row, R)) if (!covered('shield', t, self)) prot += tval.get(t.id) ?? 0;
        return disrupt * 0.6 * prot + effDps(k, lv, th) * sumIn(geo, col, row, R, wNew) + (L.reflect ? disrupt * 0.1 * prot : 0);
      }
      // Beacon
      const near = attackIn(col, row, R).filter((t) => !covered('beacon', t, self));
      if (near.length < 3) return 0;
      const bonus = (1 + (L.buffDmg ?? 0)) * (1 + (L.buffRate ?? 0)) * (1 + (L.buffRange ?? 0) * 0.5) - 1;
      return bonus * near.reduce((s, t) => s + (tval.get(t.id) ?? 0), 0);
    };

    // New towers: best few cells per kind.
    for (const k of kinds) {
      const cost = TOWERS[k].levels[0].cost;
      const best: Cand[] = [];
      for (const key of free) {
        const col = key % geo.W;
        const row = Math.floor(key / geo.W);
        let v = valueAt(k, 1, col, row);
        if (v <= 0) continue;
        if (this.p.noise) {
          let j = this.jitter.get(key);
          if (j === undefined) this.jitter.set(key, (j = 1 + (this.r() * 2 - 1) * this.p.noise));
          v *= j;
        }
        best.push({ kind: 'build', t: k, x: col, y: row, id: 0, cost, ratio: v / cost });
      }
      best.sort((a, b) => b.ratio - a.ratio);
      cands.push(...best.slice(0, Math.max(3, this.p.topN)));
    }

    // Upgrades of our own towers (the tower's own coverage is left out of its diminishing-returns field).
    for (const t of towers) {
      if (t.own !== this.id || t.id < 0 || t.lv >= 3) continue;
      const nl = (t.lv + 1) as Level;
      const cost = TOWERS[t.k].levels[nl - 1].cost;
      let gain: number;
      if (ATTACKERS.has(t.k)) {
        const e = effDps(t.k, t.lv, th);
        const n = geo.near.get(t.y * geo.W + t.x);
        if (!n) continue;
        const R1 = range(t.k, t.lv);
        const R2 = range(t.k, nl);
        const e2 = effDps(t.k, nl, th);
        gain = 0;
        for (let i = 0; i < n.idx.length && n.dist[i] <= R2; i++) {
          const s = n.idx[i];
          const inOld = n.dist[i] <= R1;
          const base = w[s] / (1 + Math.max(0, cov[s] - (inOld ? e : 0)) / D0);
          gain += (e2 - (inOld ? e : 0)) * base;
        }
      } else {
        gain = valueAt(t.k, nl, t.x, t.y, t) - valueAt(t.k, t.lv, t.x, t.y, t);
      }
      if (gain <= 0) continue;
      cands.push({ kind: 'up', t: t.k, x: t.x, y: t.y, id: t.id, cost, ratio: (gain / cost) * this.p.upgrade });
    }

    if (!cands.length) return null;
    cands.sort((a, b) => b.ratio - a.ratio);
    const top = cands[0];
    const affordable = cands.filter((c) => c.cost <= gold);
    // Nothing affordable: the gold is spent (as far as this bot is concerned).
    if (!affordable.length) return null;
    // Save up for a clearly better purchase, but not in the opening waves or while leaking.
    if (top.cost > gold && this.p.save > 0 && view.wave >= 3 && !emergency && affordable[0].ratio < top.ratio * this.p.save) return 'wait';
    const n = Math.min(this.p.topN, affordable.length);
    return affordable[Math.floor(this.r() * n)];
  }

  /** Missiles on 'strong' when heavies are about (or by temperament), lasers on 'first'. */
  private targeting(view: BotView, mine: TowerInfo[]): BotAction | null {
    const th = threatOf(this.nextWave(view), 1);
    const heavyNow = view.enemies.some((e) => e.b === view.board && (e.kind === 'brute' || e.kind === 'colossus'));
    for (const t of mine) {
      if (!TOWERS[t.k].targets) continue;
      let want: TargetMode = 0;
      if (t.k === 'missile') {
        const temperament = ((t.id * 2654435761) >>> 0) % 3 === 0;
        want = heavyNow || th.heavy || temperament ? 2 : 0;
      }
      if (t.tm !== want) return { k: 'tm', id: t.id, tm: want };
    }
    return null;
  }

  /** Versus: spend the send bank. */
  private send(view: BotView, gold: number): BotAction | null {
    if (!view.opponents.length || this.bank <= 0) return null;
    const wave = this.nextWave(view);
    const budget = Math.min(this.bank, gold);
    const ok = SENDS.filter((s) => s.from <= wave && s.cost <= budget);
    if (!ok.length) return null;
    // Opponents' towers, when visible: lots of splash makes swarms pointless, few towers make runners deadly.
    const target = this.pickTarget(view);
    const theirs = view.towers.filter((t) => (target === undefined ? t.b !== view.board : t.b === target));
    const missiles = theirs.filter((t) => t.k === 'missile').length;
    const score = (k: EnemyKind) => {
      const e = ENEMIES[k];
      const d = SENDS.find((s) => s.kind === k)!;
      const n = k === 'skitter' ? d.count * 5 : d.count;
      let v = (n * e.hp * (1 + e.armor) * e.lives + d.income * 12) / d.cost;
      if ((k === 'skitter' || k === 'runner') && missiles >= 2) v *= 0.6;
      if (k === 'brute' || k === 'disruptor') v *= 1.1;
      return v * (0.85 + this.r() * 0.3);
    };
    // Bigger sends hit harder; wait for one when the bank is close to it.
    const bestAll = SENDS.filter((s) => s.from <= wave).sort((a, b) => score(b.kind) - score(a.kind))[0];
    if (bestAll && bestAll.cost > budget && budget > bestAll.cost * 0.6 && this.p.save > 0) return null;
    const pick = ok.sort((a, b) => score(b.kind) - score(a.kind))[0];
    this.bank -= pick.cost;
    return target === undefined ? { k: 'send', e: pick.kind } : { k: 'send', e: pick.kind, to: target };
  }

  private pickTarget(view: BotView): number | undefined {
    const weakest = view.opponents.reduce((a, b) => (b.lives < a.lives ? b : a));
    if (weakest.lives <= 12 && this.r() < this.p.finish) return weakest.b;
    return undefined;
  }
}

export const createGardenBot: CreateBot = (id, difficulty, seed) => new GardenBot(id, difficulty, seed);
