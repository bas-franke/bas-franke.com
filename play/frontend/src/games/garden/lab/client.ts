// Garden client lab: the real GardenClient + HUD fed by a scripted fake server running in the page, so the whole
// client pipeline (snapshots, interpolation, events, camera, placement) can be tested without the backend.
//   /lab-garden-client.html?map=<id>&mode=<coop|vs>&boards=<n>&wave=<n>&gold=<n>&q=<low|medium|high>&fast=1
// `fast=1` shortens build phases (fake server). `sim=real` runs the real backend game server (games/garden/server.ts)
// in the page instead (needs server.fs.allow to include backend/src/games). `window.__gardenLab` exposes both.

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { GameServerMsg, PlayerInfo, RoomView } from '@shared/protocol';
import { G, type GMode, coopBountyShare } from '@shared/garden/constants';
import { type RouteGeom, boardOrigin, cellAt, routeGeom, routePos } from '@shared/garden/board';
import { ENEMIES, type EnemyKind, SENDS, SKITTER_PACK, waveHp, waveSpawns } from '@shared/garden/enemies';
import { GMAPS, type GMapDef, type GRoute, gmapById, isBuildableChar } from '@shared/garden/maps';
import type { BoardInfo, EnemySnap, GEvent, GScore, GSnapshot, GardenClientMsg, GardenServerMsg, Phase, TowerInfo } from '@shared/garden/protocol';
import { EFlag, TFlag } from '@shared/garden/protocol';
import { type Level, TOWERS, type TargetMode, type TowerKind } from '@shared/garden/towers';
import type { RoomSocket } from '../../../net/socket';
import type { ClientContext } from '../../types';
import { GardenClient } from '../client';
import { GardenHud } from '../Hud';
import '../../../styles.css';

const params = new URLSearchParams(location.search);

// ---- a lab map (used when GMAPS has no maps yet) -------------------------------------------------------------------

function labMap(): GMapDef {
  const W = 26;
  const H = 16;
  const g: string[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => '.'));
  const set = (c: number, r: number, ch: string) => {
    if (r >= 0 && r < H && c >= 0 && c < W) g[r][c] = ch;
  };
  const routes: GRoute[] = [
    { entry: 0, half: 1, pts: [[2, 7], [9, 7], [9, 3], [17, 3], [17, 11], [21, 11]] },
    { entry: 1, half: 1, pts: [[13, 2], [13, 5], [17, 5], [17, 11], [21, 11]] },
  ];
  for (const r of routes)
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, ay] = r.pts[i];
      const [bx, by] = r.pts[i + 1];
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
      for (let k = 0; k <= n; k++) {
        const x = ax + ((bx - ax) * k) / n;
        const y = ay + ((by - ay) * k) / n;
        for (const dx of [-1, 0]) for (const dy of [-1, 0]) set(Math.floor(x) + dx, Math.floor(y) + dy, '#');
      }
    }
  // Portals (2x2) and the greenhouse (4x4).
  for (const [c, r] of [[0, 6], [1, 6], [0, 7], [1, 7], [12, 0], [13, 0], [12, 1], [13, 1]]) set(c, r, 'E');
  for (let r = 9; r < 13; r++) for (let c = 21; c < 25; c++) set(c, r, 'G');
  // A stream with a bridge, some decor.
  for (let r = 0; r < H; r++) if (g[r][5] === '.') set(5, r, '~');
  set(5, 6, '=');
  set(5, 7, '=');
  set(5, 12, 'o');
  for (const [c, r, ch] of [
    [3, 2, 'R'], [20, 2, 'T'], [21, 2, 'T'], [11, 12, 'f'], [12, 12, 'f'], [8, 10, 'l'], [19, 7, 'l'], [23, 4, 's'], [2, 13, 'T'], [15, 14, 'R'],
  ] as [number, number, string][])
    if (g[r][c] === '.') set(c, r, ch);
  return {
    id: 'lab',
    name: 'Lab Garden',
    blurb: 'Client lab map.',
    modes: ['coop', 'vs'],
    grid: g.map((row) => row.join('')),
    entries: [
      { x: 1, y: 7, facing: -Math.PI / 2 },
      { x: 13, y: 1, facing: 0 },
    ],
    goal: { x: 23, y: 11 },
    routes,
    mood: { warmth: 0.6, water: 0.5 },
  };
}

const mapId = params.get('map') ?? GMAPS[0]?.id ?? 'lab';
if (!gmapById(mapId)) GMAPS.push(labMap());
const def = gmapById(mapId) ?? gmapById('lab')!;

// ---- fake room -----------------------------------------------------------------------------------------------------

const mode: GMode = params.get('mode') === 'vs' ? 'vs' : 'coop';
const nBoards = mode === 'vs' ? Math.max(2, Math.min(6, Number(params.get('boards') ?? 3))) : 1;
const fast = params.has('fast');
const COLORS = [0x4fc3f7, 0xffb74d, 0xba68c8, 0x81c784, 0xf06292, 0xfff176];
const NAMES = ['You', 'Fern', 'Moss', 'Clover', 'Basil', 'Sage'];
const players: PlayerInfo[] = Array.from({ length: mode === 'vs' ? nBoards : 3 }, (_, i) => ({
  id: i === 0 ? 'me' : `bot${i}`,
  name: NAMES[i],
  bot: i > 0,
  color: COLORS[i],
  connected: true,
  ping: 0,
}));
const room: RoomView = {
  code: 'LABG',
  name: 'Lab',
  game: 'garden',
  state: 'playing',
  maxPlayers: 6,
  botDifficulty: 'normal',
  map: def.id,
  mode,
  hostId: 'me',
  players,
} as RoomView;

// ---- fake server ---------------------------------------------------------------------------------------------------

interface SEnemy {
  id: number;
  k: EnemyKind;
  b: number;
  r: number;
  d: number;
  o: number;
  hp: number;
  max: number;
  slow: number;
  stun: number;
  disT: number;
  sent: boolean;
  shedAt: number;
}
interface SPlayer {
  id: string;
  gold: number;
  inc: number;
  rd: 0 | 1;
  b: number;
  kills: number;
  dmg: number;
  built: number;
  sent: number;
}
interface SMissile {
  mid: number;
  tw: number;
  en: number;
  t: number;
  dmg: number;
  splash: number;
  b: number;
  x: number;
  z: number;
}

class FakeServer {
  tick = 0;
  wave = Number(params.get('wave') ?? 0);
  ph: Phase = 'build';
  left = fast ? 4 : G.firstBuild;
  nextId = 1;
  nextMid = 1;
  enemies: SEnemy[] = [];
  towers: (TowerInfo & { cd: number; tg: number; ch: number[]; dis: number; zapT: number })[] = [];
  missiles: SMissile[] = [];
  queue: { at: number; k: EnemyKind; b: number; r: number; o: number; sent: boolean }[] = [];
  waveT = 0;
  lives: number[] = Array.from({ length: nBoards }, () => G.lives);
  out: (0 | 1)[] = Array.from({ length: nBoards }, () => 0 as const);
  pl: SPlayer[];
  geoms: RouteGeom[][];
  boards: BoardInfo[];
  ev: GEvent[] = [];
  paused = false;
  timer = 0;

  constructor(private readonly deliver: (m: GameServerMsg) => void) {
    const gold = Number(params.get('gold') ?? G.startGold[mode]);
    this.pl = players.map((p, i) => ({ id: p.id, gold, inc: G.baseIncome, rd: 0, b: mode === 'vs' ? i : 0, kills: 0, dmg: 0, built: 0, sent: 0 }));
    this.boards = Array.from({ length: nBoards }, (_, i) => ({ b: i, own: mode === 'vs' ? players[i].id : null }));
    this.geoms = this.boards.map((_, i) => def.routes.map((r) => routeGeom(def, boardOrigin(def, i, nBoards), r)));
    // A starting defence on every board so there is something to look at.
    for (let b = 0; b < nBoards; b++) {
      const own = mode === 'vs' ? players[b].id : players[b % players.length].id;
      const kinds: TowerKind[] = ['laser', 'missile', 'slow', 'shield', 'beacon', 'laser'];
      let placed = 0;
      for (const [cx, cy] of this.nearPath(b)) {
        if (placed >= kinds.length) break;
        this.addTower(kinds[placed], b, cx, cy, mode === 'coop' ? players[placed % players.length].id : own, placed === 0 ? 3 : placed === 1 ? 2 : 1, false);
        placed++;
      }
    }
  }

  /** Buildable cells next to the path, spread out. */
  nearPath(b: number): [number, number][] {
    const out: [number, number][] = [];
    const H = def.grid.length;
    const W = def.grid[0].length;
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        if (!isBuildableChar(cellAt(def, c, r))) continue;
        const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => cellAt(def, c + dx, r + dy) === '#');
        if (!near) continue;
        if (out.some(([x, y]) => Math.abs(x - c) + Math.abs(y - r) < 5)) continue;
        if (this.towers.some((t) => t.b === b && t.x === c && t.y === r)) continue;
        out.push([c, r]);
      }
    void b;
    return out.sort((a, z) => (a[0] * 7 + a[1] * 13) % 11 - ((z[0] * 7 + z[1] * 13) % 11));
  }

  start() {
    const msg: GardenServerMsg = { k: 'init', map: { id: def.id, name: def.name }, mode, boards: this.boards, towers: this.towers.map(strip), wave: this.wave, scores: this.scores() };
    this.deliver(msg as GameServerMsg);
    this.timer = window.setInterval(() => this.step(), 1000 / G.tickRate);
  }

  stop() {
    window.clearInterval(this.timer);
  }

  addTower(k: TowerKind, b: number, x: number, y: number, own: string, lv: Level, emit = true) {
    const spent = TOWERS[k].levels.slice(0, lv).reduce((s, l) => s + l.cost, 0);
    const t = { id: this.nextId++, k, lv, b, x, y, own, tm: 0 as TargetMode, spent, cd: 0, tg: 0, ch: [] as number[], dis: 0, zapT: 0 };
    this.towers.push(t);
    if (emit) this.ev.push({ k: 'build', t: strip(t) });
    return t;
  }

  pos(t: TowerInfo) {
    const o = boardOrigin(def, t.b, nBoards);
    const W = def.grid[0].length;
    const H = def.grid.length;
    return { x: o.x + (t.x + 0.5 - W / 2) * G.cell, z: o.z + (t.y + 0.5 - H / 2) * G.cell };
  }

  epos(e: SEnemy) {
    return routePos(this.geoms[e.b][e.r], e.d, e.o);
  }

  handle(id: string, m: GardenClientMsg) {
    const p = this.pl.find((q) => q.id === id)!;
    const deny = (why: string) => this.ev.push({ k: 'deny', id, why });
    switch (m.k) {
      case 'build': {
        const cost = TOWERS[m.t].levels[0].cost;
        if (!isBuildableChar(cellAt(def, m.x, m.y)) || this.towers.some((t) => t.b === p.b && t.x === m.x && t.y === m.y)) return deny('Cannot build there');
        if (p.gold < cost) return deny('Not enough gold');
        p.gold -= cost;
        p.built += cost;
        this.addTower(m.t, p.b, m.x, m.y, id, 1);
        return;
      }
      case 'up': {
        const t = this.towers.find((q) => q.id === m.id);
        if (!t || t.lv >= 3) return;
        const cost = TOWERS[t.k].levels[t.lv as 1 | 2].cost;
        if (p.gold < cost) return deny('Not enough gold');
        p.gold -= cost;
        p.built += cost;
        t.lv = (t.lv + 1) as Level;
        t.spent += cost;
        this.ev.push({ k: 'up', id: t.id, lv: t.lv, by: id, spent: t.spent });
        return;
      }
      case 'sell': {
        const i = this.towers.findIndex((q) => q.id === m.id);
        if (i < 0) return;
        const refund = Math.floor(this.towers[i].spent * G.sellRefund);
        p.gold += refund;
        this.towers.splice(i, 1);
        this.ev.push({ k: 'sell', id: m.id, by: id, refund });
        return;
      }
      case 'tm': {
        const t = this.towers.find((q) => q.id === m.id);
        if (!t) return;
        t.tm = m.tm;
        this.ev.push({ k: 'tm', id: t.id, tm: m.tm });
        return;
      }
      case 'ready':
        p.rd = p.rd ? 0 : 1;
        return;
      case 'send': {
        const s = SENDS.find((q) => q.kind === m.e);
        if (!s || mode !== 'vs') return deny('Sending is a versus thing');
        if (p.gold < s.cost) return deny('Not enough gold');
        const to = m.to ?? this.boards.find((b) => b.b !== p.b && !this.out[b.b])?.b;
        if (to === undefined || to === p.b) return;
        p.gold -= s.cost;
        p.inc += s.income;
        p.sent += s.cost;
        const n = s.kind === 'skitter' ? s.count * SKITTER_PACK : s.count;
        for (let i = 0; i < n; i++) this.queue.push({ at: this.waveT + 0.5 + i * 0.4, k: s.kind, b: to, r: i % def.routes.length, o: (i % 3) - 1, sent: true });
        this.ev.push({ k: 'send', from: id, to, kind: s.kind, n });
        return;
      }
      case 'ping':
        this.ev.push({ k: 'ping', id, b: p.b, x: m.x, z: m.z });
        return;
    }
  }

  startWave() {
    this.wave++;
    this.ph = 'wave';
    this.waveT = 0;
    const boss = this.wave % 10 === 0;
    this.ev.push({ k: 'wave', n: this.wave, boss: boss ? 1 : 0 });
    for (const p of this.pl) p.rd = 0;
    if (mode === 'vs') for (const p of this.pl) p.gold += p.inc;
    for (let b = 0; b < nBoards; b++) {
      if (this.out[b]) continue;
      for (const g of waveSpawns(this.wave, def.routes.length)) {
        for (let i = 0; i < g.count; i++) {
          const pack = g.kind === 'skitter' ? SKITTER_PACK : 1;
          for (let j = 0; j < pack; j++) {
            const r = g.route >= 0 ? g.route : i % def.routes.length;
            this.queue.push({ at: g.at + i * g.gap + j * 0.05, k: g.kind, b, r, o: pack > 1 ? (j - 2) / 2 : Math.sin(i * 2.3) * 0.6, sent: false });
          }
        }
      }
    }
  }

  spawn(q: { k: EnemyKind; b: number; r: number; o: number; sent: boolean }, d = 0) {
    const max = ENEMIES[q.k].hp * waveHp(Math.max(1, this.wave));
    this.enemies.push({ id: this.nextId++, k: q.k, b: q.b, r: q.r, d, o: q.o, hp: max, max, slow: 1, stun: 0, disT: 2, sent: q.sent, shedAt: 0.75 });
  }

  damage(e: SEnemy, amount: number, tw: { own: string; id: number } | null, pierce: number) {
    if (e.hp <= 0) return;
    const dmg = amount * (1 - ENEMIES[e.k].armor * (1 - pierce));
    e.hp -= dmg;
    const owner = tw ? this.pl.find((p) => p.id === tw.own) : undefined;
    if (owner) owner.dmg += dmg;
    // Colossus sheds skitters at every quarter.
    const def0 = ENEMIES[e.k];
    if (def0.shed && e.hp > 0 && e.hp / e.max < e.shedAt) {
      e.shedAt -= 0.25;
      this.ev.push({ k: 'shed', en: e.id, n: def0.shed });
      for (let i = 0; i < def0.shed; i++) this.spawn({ k: 'skitter', b: e.b, r: e.r, o: (i % 5 - 2) / 2, sent: false }, Math.max(0, e.d - 0.3 * i));
    }
    if (e.hp <= 0) {
      const bounty = def0.bounty;
      if (mode === 'coop') {
        const share = Math.round(bounty * coopBountyShare(this.pl.length));
        for (const p of this.pl) p.gold += share;
        this.ev.push({ k: 'die', en: e.id, kind: e.k, by: tw?.id ?? 0, gold: share });
      } else {
        const own = this.pl.find((p) => p.b === e.b);
        if (own) own.gold += bounty;
        this.ev.push({ k: 'die', en: e.id, kind: e.k, by: tw?.id ?? 0, gold: bounty });
      }
      if (owner) owner.kills++;
    }
  }

  step() {
    if (this.paused) return;
    const dt = 1 / G.tickRate;
    this.tick++;
    if (this.ph === 'build') {
      this.left -= dt;
      const humansReady = this.pl.filter((p) => !players.find((q) => q.id === p.id)?.bot).every((p) => p.rd);
      // Bots are always ready in the lab.
      if (this.left <= 0 || humansReady) this.startWave();
    } else if (this.ph === 'wave') {
      this.waveT += dt;
      this.queue.sort((a, b) => a.at - b.at);
      while (this.queue.length && this.queue[0].at <= this.waveT) this.spawn(this.queue.shift()!);
    }

    // Field effects.
    for (const e of this.enemies) {
      e.slow = 1;
      e.stun = Math.max(0, e.stun - dt);
    }
    const buffs = new Map<number, number>();
    for (const t of this.towers) {
      if (t.k !== 'beacon') continue;
      const L = TOWERS.beacon.levels[t.lv - 1];
      const p = this.pos(t);
      for (const u of this.towers) if (u !== t && u.b === t.b && Math.hypot(this.pos(u).x - p.x, this.pos(u).z - p.z) <= L.range) buffs.set(u.id, Math.max(buffs.get(u.id) ?? 0, L.buffDmg ?? 0));
    }
    for (const t of this.towers) {
      t.dis = Math.max(0, t.dis - dt);
      const L = TOWERS[t.k].levels[t.lv - 1];
      const p = this.pos(t);
      const buff = 1 + (buffs.get(t.id) ?? 0);
      const inRange = this.enemies.filter((e) => e.b === t.b && e.hp > 0 && (() => {
        const q = this.epos(e);
        return Math.hypot(q.x - p.x, q.z - p.z) <= L.range;
      })());
      t.tg = 0;
      t.ch = [];
      if (t.dis > 0) continue;
      if (t.k === 'slow') for (const e of inRange) {
        e.slow = Math.min(e.slow, 1 - (L.slow ?? 0));
        this.damage(e, L.dmg * dt * buff, t, 1);
      }
      if (t.k === 'shield') {
        t.zapT -= dt;
        if (t.zapT <= 0 && inRange.length) {
          t.zapT = 1.5;
          this.ev.push({ k: 'zap', tw: t.id });
          for (const e of inRange) this.damage(e, L.dmg * 1.5 * buff, t, 1);
        }
      }
      if (!TOWERS[t.k].targets || !inRange.length) continue;
      const order = [...inRange].sort((a, b) => {
        switch (t.tm) {
          case 1: return a.d - b.d;
          case 2: return b.hp - a.hp;
          case 3: {
            const qa = this.epos(a), qb = this.epos(b);
            return Math.hypot(qa.x - p.x, qa.z - p.z) - Math.hypot(qb.x - p.x, qb.z - p.z);
          }
          default: return b.d - a.d;
        }
      });
      const target = order[0];
      t.tg = target.id;
      if (t.k === 'laser') {
        this.damage(target, L.dmg * dt * buff, t, TOWERS.laser.pierce);
        if (L.count) {
          t.ch = order.slice(1, 1 + L.count).map((e) => e.id);
          for (const id of t.ch) {
            const e = this.enemies.find((q) => q.id === id);
            if (e) this.damage(e, L.dmg * 0.5 * dt * buff, t, TOWERS.laser.pierce);
          }
        }
      } else if (t.k === 'missile') {
        t.cd -= dt;
        if (t.cd <= 0) {
          t.cd = L.interval ?? 1.5;
          for (let i = 0; i < (L.count ?? 1); i++) {
            const e = order[i % order.length];
            const q = this.epos(e);
            const ft = 0.5 + Math.hypot(q.x - p.x, q.z - p.z) / 14;
            const mid = this.nextMid++;
            this.missiles.push({ mid, tw: t.id, en: e.id, t: ft, dmg: L.dmg * buff, splash: L.splash ?? 1.5, b: t.b, x: q.x, z: q.z });
            this.ev.push({ k: 'msl', tw: t.id, en: e.id, mid, ft });
          }
        }
      }
    }
    // Missiles land.
    for (const m of this.missiles) {
      m.t -= dt;
      const e = this.enemies.find((q) => q.id === m.en && q.hp > 0);
      if (e) {
        const q = this.epos(e);
        m.x = q.x;
        m.z = q.z;
      }
      if (m.t <= 0) {
        this.ev.push({ k: 'boom', b: m.b, x: Math.round(m.x * 100) / 100, z: Math.round(m.z * 100) / 100, r: m.splash, mid: m.mid });
        const tw = this.towers.find((t) => t.id === m.tw) ?? null;
        for (const e2 of this.enemies) {
          if (e2.b !== m.b || e2.hp <= 0) continue;
          const q = this.epos(e2);
          if (Math.hypot(q.x - m.x, q.z - m.z) <= m.splash) this.damage(e2, m.dmg, tw, 1);
        }
      }
    }
    this.missiles = this.missiles.filter((m) => m.t > 0);

    // Movement, disruptors, leaks.
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      const E = ENEMIES[e.k];
      if (E.disrupt) {
        e.disT -= dt;
        if (e.disT <= 0) {
          e.disT = E.disrupt.every;
          const q = this.epos(e);
          const t = this.towers.find((u) => u.b === e.b && Math.hypot(this.pos(u).x - q.x, this.pos(u).z - q.z) <= E.disrupt!.range);
          if (t) {
            const shielded = this.towers.some((s) => s.k === 'shield' && s.b === t.b && Math.hypot(this.pos(s).x - this.pos(t).x, this.pos(s).z - this.pos(t).z) <= TOWERS.shield.levels[s.lv - 1].range);
            if (!shielded) t.dis = E.disrupt.dur;
            this.ev.push({ k: 'dis', en: e.id, tw: t.id, blocked: shielded ? 1 : 0 });
          }
        }
      }
      if (e.stun <= 0) e.d += E.speed * e.slow * dt;
      const g = this.geoms[e.b][e.r];
      if (e.d >= g.length) {
        e.hp = 0;
        this.lives[e.b] = Math.max(0, this.lives[e.b] - E.lives);
        this.ev.push({ k: 'leak', en: e.id, b: e.b, lives: this.lives[e.b] });
        if (this.lives[e.b] <= 0 && !this.out[e.b]) {
          if (mode === 'vs') {
            this.out[e.b] = 1;
            const place = this.out.filter((x) => !x).length + 1;
            this.ev.push({ k: 'out', b: e.b, place });
          } else this.lives[e.b] = G.lives; // the lab never ends co-op
        }
      }
    }
    this.enemies = this.enemies.filter((e) => e.hp > 0 && !this.out[e.b]);
    if (this.ph === 'wave' && !this.queue.length && !this.enemies.length) {
      const bonus = G.clearBonus + G.clearBonusPerWave * this.wave;
      for (const p of this.pl) p.gold += bonus;
      this.ev.push({ k: 'clear', n: this.wave, bonus });
      this.ph = 'build';
      this.left = fast ? 4 : G.betweenWaves;
    }
    // Bots build now and then (so build events from others show up).
    if (this.tick % 60 === 0) {
      const bot = this.pl.find((p) => p.id !== 'me' && p.gold > 150);
      if (bot) {
        const spot = this.nearPath(bot.b)[0];
        if (spot) this.handle(bot.id, { k: 'build', t: (['laser', 'missile', 'slow'] as TowerKind[])[this.tick % 3], x: spot[0], y: spot[1] });
      }
    }

    if (this.ev.length) {
      this.deliver({ k: 'ev', e: this.ev.splice(0) } as GameServerMsg);
    }
    if (this.tick % G.snapEvery === 0) this.deliver({ k: 'snap', s: this.snapshot() } as GameServerMsg);
    if (this.tick % 40 === 0) this.deliver({ k: 'score', scores: this.scores() } as GameServerMsg);
  }

  snapshot(): GSnapshot {
    return {
      tick: this.tick,
      t: (this.tick * 1000) / G.tickRate,
      wave: this.wave,
      ph: this.ph,
      left: this.ph === 'build' ? Math.max(0, Math.round(this.left * 10) / 10) : this.queue.length + this.enemies.length,
      bd: this.lives.map((lives, b) => (this.out[b] ? { b, lives, out: 1 as const } : { b, lives })),
      en: this.enemies.map(
        (e): EnemySnap => ({
          id: e.id,
          k: e.k,
          b: e.b,
          r: e.r,
          d: Math.round(e.d * 100) / 100,
          o: e.o,
          hp: Math.max(0, Math.round((e.hp / e.max) * 100) / 100),
          f: (e.slow < 1 ? EFlag.slowed : 0) | (e.stun > 0 ? EFlag.stunned : 0) | (e.sent ? EFlag.sent : 0),
        }),
      ),
      tw: this.towers.map((t) => ({ id: t.id, tg: t.tg, ...(t.ch.length ? { ch: t.ch } : {}), f: t.dis > 0 ? TFlag.disabled : 0 })),
      pl: this.pl.map((p) => ({ id: p.id, gold: Math.floor(p.gold), inc: p.inc, rd: p.rd, b: p.b })),
    };
  }

  scores(): GScore[] {
    return this.pl.map((p) => ({ id: p.id, kills: p.kills, dmg: Math.round(p.dmg), built: p.built, sent: p.sent, points: p.kills * 10 + Math.round(p.dmg / 100) }));
  }
}

function strip(t: TowerInfo): TowerInfo {
  return { id: t.id, k: t.k, lv: t.lv, b: t.b, x: t.x, y: t.y, own: t.own, tm: t.tm, spent: t.spent };
}

// ---- wire it up ----------------------------------------------------------------------------------------------------

const q = params.get('q');
if (q === 'low' || q === 'medium' || q === 'high') {
  try {
    localStorage.setItem('garden.quality.v1', q);
  } catch {
    /* ignore */
  }
}

let client: GardenClient;
// A real socket delivers asynchronously and as JSON; keep both.
const deliver = (m: GameServerMsg) => queueMicrotask(() => client.onMessage(JSON.parse(JSON.stringify(m)) as GameServerMsg));

/** Where the client's messages go: the scripted fake server, or (sim=real) the actual game server running in the page. */
let handle: (m: GardenClientMsg) => void;
let server: FakeServer | null = null;
if (params.get('sim') === 'real') {
  // The main vite.config only allows backend/src/shared; run Vite with a config whose server.fs.allow adds backend/src/games.
  const loaders = import.meta.glob('../../../../../backend/src/games/garden/server.ts');
  const load = Object.values(loaders)[0];
  if (!load) throw new Error('backend garden server not found');
  const mod = (await load()) as {
    createGardenGame: (host: unknown) => { start(): void; onMessage(id: string, m: unknown): void; stop(): void };
  };
  const game = mod.createGardenGame({
    code: 'LABG',
    settings: { mode, map: params.get('map') ?? 'random' },
    botDifficulty: () => 'normal',
    players: () => players.map(({ id, name, bot, color }) => ({ id, name, bot, color })),
    send: (id: string, m: GameServerMsg) => {
      if (id === 'me') deliver(m);
    },
    broadcast: deliver,
    systemChat: (text: string) => console.log('[chat]', text),
    matchEnded: () => console.log('[lab] match ended'),
  });
  handle = (m) => game.onMessage('me', m);
  queueMicrotask(() => game.start());
  (window as unknown as { __gardenGame: unknown }).__gardenGame = game;
} else {
  server = new FakeServer(deliver);
  handle = (m) => server!.handle('me', m);
}
const socket = {
  rtt: 0,
  serverNow: () => Date.now(),
  sendGame: (m: GardenClientMsg) => handle(m),
  send: (m: { t: string; m?: GardenClientMsg }) => {
    if (m.t === 'g' && m.m) handle(m.m);
  },
} as unknown as RoomSocket;
const ctx: ClientContext = {
  you: 'me',
  socket,
  room: () => room,
  leave: () => console.log('[lab] leave'),
};

client = new GardenClient(ctx);
const stage = document.getElementById('game')!;
stage.className = 'stage';
const host = document.createElement('div');
host.style.cssText = 'position:absolute;inset:0';
stage.appendChild(host);
client.mount(host);
const hudRoot = document.createElement('div');
stage.appendChild(hudRoot);
createRoot(hudRoot).render(createElement(GardenHud, { client, ctx }));
server?.start();
(window as unknown as { __gardenLab: unknown }).__gardenLab = { server, client, ctx };
