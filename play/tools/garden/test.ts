// Garden Sentinels rule tests: a self-contained runner (no test framework in this repo). Builds the pure simulation
// directly (as server.ts does) and pokes its internals to check every rule documented at the top of server.ts / sim.ts.
//
//   node24 backend/node_modules/tsx/dist/cli.mjs tools/garden/test.ts [filter]      (run from play/)
//
// Exits 1 when any test fails. Tests named "[CODE BUG]" fail because the code under test is wrong, not the test.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { G, coopBountyShare, coopCount } from '../../backend/src/shared/garden/constants.js';
import { ENEMIES, SENDS, SKITTER_PACK, sendCap, vsHpRamp, waveBounty, waveHp } from '../../backend/src/shared/garden/enemies.js';
import { GMAPS, type GMapDef, gmapById } from '../../backend/src/shared/garden/maps.js';
import { boardOrigin, routeGeom, routePos } from '../../backend/src/shared/garden/board.js';
import { TFlag } from '../../backend/src/shared/garden/protocol.js';
import { TOWERS, type TowerKind } from '../../backend/src/shared/garden/towers.js';
import { GardenSim, fallbackGardenBot } from '../../backend/src/games/garden/sim.js';
import { createGardenBot } from '../../backend/src/games/garden/bots.js';
import { createGardenGame } from '../../backend/src/games/garden/server.js';

// ---- tiny runner ----------------------------------------------------------------------------------------------------

type Fn = () => void;
const tests: { name: string; fn: Fn }[] = [];
let prefix: string[] = [];
function describe(name: string, fn: () => void) {
  prefix.push(name);
  fn();
  prefix.pop();
}
function it(name: string, fn: Fn) {
  tests.push({ name: [...prefix, name].join(' > '), fn });
}

// ---- helpers --------------------------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
const COOP_MAP = gmapById('greenhouse-commons')!;
const VS_MAP = gmapById('seedling-plot')!;
const DT = 1 / G.tickRate;
const FAR = 1000; // world spot far from any route where towers and enemies are placed by hand

function mkSim(mode: 'coop' | 'vs', ids: string[] = ['p1'], opts: { bots?: boolean; seed?: number; def?: GMapDef } = {}): any {
  return new GardenSim({
    def: opts.def ?? (mode === 'coop' ? COOP_MAP : VS_MAP),
    mode,
    players: ids.map((id) => ({ id, name: id, bot: !!opts.bots })),
    difficulty: 'normal',
    seed: opts.seed ?? 1,
    createBot: opts.bots ? createGardenBot : fallbackGardenBot,
  });
}

function cells(def: GMapDef, ch: string): [number, number][] {
  const out: [number, number][] = [];
  def.grid.forEach((row, r) => [...row].forEach((c, col) => c === ch && out.push([col, r])));
  return out;
}

/** Builds `kind` on the next free '.' cell for player `pid`, upgrades it to `lv`, and moves it to world (x, z). */
function tower(sim: any, pid: string, kind: TowerKind, x = FAR, z = FAR, lv = 1): any {
  const p = sim.players.get(pid);
  const g0 = p.gold;
  p.gold += 1e7;
  const bd = sim.boards[p.board];
  const free = sim.free(bd) as [number, number][];
  assert.ok(free.length, 'no free cell');
  const [c, r] = free[0];
  assert.equal(sim.handle(pid, { k: 'build', t: kind, x: c, y: r }), true, 'build failed');
  const id = bd.cells[r * sim.W + c];
  for (let l = 1; l < lv; l++) assert.equal(sim.handle(pid, { k: 'up', id }), true, 'upgrade failed');
  p.gold = g0; // the tower is free: the player's gold is exactly what it was
  const tw = sim.towers.get(id);
  tw.x = x;
  tw.z = z;
  return tw;
}

/** Adds an enemy on board b at world (x, z), `d` metres along route 0. */
function enemy(sim: any, kind: string, x = FAR, z = FAR, o: { b?: number; d?: number; hpMul?: number; from?: string | null } = {}): any {
  const bd = sim.boards[o.b ?? 0];
  const e = sim.addEnemy(bd, kind, 0, o.d ?? 5, 0, o.hpMul ?? 1, o.from ?? null);
  e.x = x;
  e.z = z;
  return e;
}

const near = (a: number, b: number, eps = 1e-9, msg?: string) => assert.ok(Math.abs(a - b) <= eps, msg ?? `expected ${b}, got ${a}`);

// ---- building -------------------------------------------------------------------------------------------------------

describe('building', () => {
  it("builds on '.' and charges the level-1 cost", () => {
    const sim = mkSim('coop');
    const p = sim.players.get('p1');
    const [c, r] = cells(COOP_MAP, '.')[0];
    assert.equal(sim.handle('p1', { k: 'build', t: 'laser', x: c, y: r }), true);
    assert.equal(p.gold, G.startGold.coop - TOWERS.laser.levels[0].cost);
    assert.equal(sim.towers.size, 1);
    assert.equal(p.score.built, TOWERS.laser.levels[0].cost);
  });
  it("refuses every non-'.' cell (path, water, rocks, portals, greenhouse)", () => {
    const sim = mkSim('coop');
    sim.players.get('p1').gold = 1e6;
    for (const ch of ['#', '=', '~', 'R', 'T', 'E', 'G', 'f', 'l', 's', 'o']) {
      for (const [c, r] of cells(COOP_MAP, ch).slice(0, 3)) assert.equal(sim.handle('p1', { k: 'build', t: 'laser', x: c, y: r }), false, `built on '${ch}'`);
    }
    assert.equal(sim.towers.size, 0);
  });
  it('refuses an occupied cell and cells off the grid', () => {
    const sim = mkSim('coop');
    sim.players.get('p1').gold = 1e6;
    const [c, r] = cells(COOP_MAP, '.')[0];
    assert.equal(sim.handle('p1', { k: 'build', t: 'laser', x: c, y: r }), true);
    assert.equal(sim.handle('p1', { k: 'build', t: 'slow', x: c, y: r }), false);
    for (const [x, y] of [[-1, 0], [0, -1], [sim.W, 0], [0, sim.H], [1e9, 1e9]]) assert.equal(sim.handle('p1', { k: 'build', t: 'laser', x, y }), false);
    assert.equal(sim.towers.size, 1);
    assert.ok(sim.denies.some((d: any) => d.why === "Can't build there"));
  });
  it('refuses without enough gold and charges nothing', () => {
    const sim = mkSim('coop');
    const p = sim.players.get('p1');
    p.gold = TOWERS.missile.levels[0].cost - 1;
    const [c, r] = cells(COOP_MAP, '.')[0];
    assert.equal(sim.handle('p1', { k: 'build', t: 'missile', x: c, y: r }), false);
    assert.equal(p.gold, TOWERS.missile.levels[0].cost - 1);
    assert.deepEqual(sim.denies.at(-1), { id: 'p1', why: 'Not enough gold' });
    p.gold = TOWERS.missile.levels[0].cost;
    assert.equal(sim.handle('p1', { k: 'build', t: 'missile', x: c, y: r }), true);
    assert.equal(p.gold, 0);
  });
  it('versus: each player builds on their own board only; others cannot touch their towers', () => {
    const sim = mkSim('vs', ['a', 'b']);
    assert.equal(sim.boards.length, 2);
    const [c, r] = cells(VS_MAP, '.')[0];
    assert.equal(sim.handle('a', { k: 'build', t: 'laser', x: c, y: r }), true);
    // Same cell is free on b's own copy of the map.
    assert.equal(sim.handle('b', { k: 'build', t: 'laser', x: c, y: r }), true);
    const ta = sim.boards[0].cells[r * sim.W + c];
    const tb = sim.boards[1].cells[r * sim.W + c];
    assert.ok(ta && tb && ta !== tb);
    assert.equal(sim.towers.get(ta).info.b, 0);
    assert.equal(sim.towers.get(tb).info.b, 1);
    sim.players.get('b').gold = 1e6;
    assert.equal(sim.handle('b', { k: 'up', id: ta }), false);
    assert.equal(sim.handle('b', { k: 'sell', id: ta }), false);
    assert.equal(sim.handle('b', { k: 'tm', id: ta, tm: 2 }), false);
    assert.equal(sim.towers.get(ta).info.lv, 1);
    assert.equal(sim.towers.get(ta).info.tm, 0);
  });
  it('versus: a spectator (mid-match joiner) cannot build', () => {
    const sim = mkSim('vs', ['a', 'b']);
    const s = sim.addPlayer({ id: 's', name: 's', bot: false });
    assert.equal(s.board, -1);
    const [c, r] = cells(VS_MAP, '.')[0];
    assert.equal(sim.handle('s', { k: 'build', t: 'laser', x: c, y: r }), false);
    assert.equal(sim.denies.at(-1).why, 'You are not defending a garden');
  });
  it('versus: an eliminated board cannot build any more', () => {
    const sim = mkSim('vs', ['a', 'b', 'c']);
    sim.eliminate(sim.boards[0]);
    const [c, r] = cells(VS_MAP, '.')[0];
    assert.equal(sim.handle('a', { k: 'build', t: 'laser', x: c, y: r }), false);
  });
});

// ---- upgrade / sell ---------------------------------------------------------------------------------------------------

describe('upgrade and sell', () => {
  it('upgrades cost the next level, add to spent, and stop at level 3', () => {
    const sim = mkSim('coop');
    const p = sim.players.get('p1');
    p.gold = 10000;
    const [c, r] = cells(COOP_MAP, '.')[0];
    sim.handle('p1', { k: 'build', t: 'missile', x: c, y: r });
    const id = sim.boards[0].cells[r * sim.W + c];
    const L = TOWERS.missile.levels;
    assert.equal(sim.handle('p1', { k: 'up', id }), true);
    assert.equal(sim.handle('p1', { k: 'up', id }), true);
    assert.equal(sim.handle('p1', { k: 'up', id }), false);
    assert.equal(sim.denies.at(-1).why, 'Already at max level');
    const tw = sim.towers.get(id);
    assert.equal(tw.info.lv, 3);
    assert.equal(tw.info.spent, L[0].cost + L[1].cost + L[2].cost);
    assert.equal(p.gold, 10000 - tw.info.spent);
    assert.equal(tw.lv, L[2]);
  });
  it('upgrade refused without gold', () => {
    const sim = mkSim('coop');
    const p = sim.players.get('p1');
    const [c, r] = cells(COOP_MAP, '.')[0];
    sim.handle('p1', { k: 'build', t: 'laser', x: c, y: r });
    const id = sim.boards[0].cells[r * sim.W + c];
    p.gold = TOWERS.laser.levels[1].cost - 1;
    assert.equal(sim.handle('p1', { k: 'up', id }), false);
    assert.equal(sim.towers.get(id).info.lv, 1);
  });
  it('selling in the same build phase refunds everything (incl. upgrades)', () => {
    const sim = mkSim('coop');
    const p = sim.players.get('p1');
    p.gold = 1000;
    const [c, r] = cells(COOP_MAP, '.')[0];
    sim.handle('p1', { k: 'build', t: 'laser', x: c, y: r });
    const id = sim.boards[0].cells[r * sim.W + c];
    sim.handle('p1', { k: 'up', id });
    assert.equal(sim.handle('p1', { k: 'sell', id }), true);
    assert.equal(p.gold, 1000);
    assert.equal(sim.towers.size, 0);
    assert.equal(sim.boards[0].cells[r * sim.W + c], 0);
    // The cell can be built on again.
    assert.equal(sim.handle('p1', { k: 'build', t: 'laser', x: c, y: r }), true);
  });
  it('selling during a wave refunds floor(spent * sellRefund)', () => {
    const sim = mkSim('coop');
    const p = sim.players.get('p1');
    p.gold = 1000;
    const [c, r] = cells(COOP_MAP, '.')[0];
    sim.handle('p1', { k: 'build', t: 'missile', x: c, y: r });
    const id = sim.boards[0].cells[r * sim.W + c];
    sim.handle('p1', { k: 'up', id });
    const spent = TOWERS.missile.levels[0].cost + TOWERS.missile.levels[1].cost;
    sim.phase = 'wave';
    sim.wave = 1;
    const before = p.gold;
    sim.handle('p1', { k: 'sell', id });
    assert.equal(p.gold - before, Math.floor(spent * G.sellRefund));
  });
  it('a tower built during a wave is not a free undo in the next build phase', () => {
    const sim = mkSim('coop');
    const p = sim.players.get('p1');
    p.gold = 1000;
    sim.phase = 'wave';
    sim.wave = 2;
    const [c, r] = cells(COOP_MAP, '.')[0];
    sim.handle('p1', { k: 'build', t: 'laser', x: c, y: r });
    const id = sim.boards[0].cells[r * sim.W + c];
    sim.phase = 'build';
    const before = p.gold;
    sim.handle('p1', { k: 'sell', id });
    assert.equal(p.gold - before, Math.floor(100 * G.sellRefund));
  });
  it('a tower from an earlier build phase refunds sellRefund', () => {
    const sim = mkSim('coop');
    const p = sim.players.get('p1');
    const [c, r] = cells(COOP_MAP, '.')[0];
    sim.handle('p1', { k: 'build', t: 'laser', x: c, y: r });
    const id = sim.boards[0].cells[r * sim.W + c];
    sim.wave = 1; // build phase after wave 1
    const before = p.gold;
    sim.handle('p1', { k: 'sell', id });
    assert.equal(p.gold - before, 70);
  });
  it('co-op: anyone upgrades or retargets, only the builder sells', () => {
    const sim = mkSim('coop', ['a', 'b']);
    const [c, r] = cells(COOP_MAP, '.')[0];
    sim.handle('a', { k: 'build', t: 'laser', x: c, y: r });
    const id = sim.boards[0].cells[r * sim.W + c];
    const gb = sim.players.get('b').gold;
    assert.equal(sim.handle('b', { k: 'up', id }), true);
    assert.equal(sim.players.get('b').gold, gb - TOWERS.laser.levels[1].cost, 'the upgrader pays');
    assert.equal(sim.handle('b', { k: 'tm', id, tm: 3 }), true);
    assert.equal(sim.towers.get(id).info.tm, 3);
    assert.equal(sim.handle('b', { k: 'sell', id }), false);
    assert.equal(sim.denies.at(-1).why, 'Only the builder can sell that');
    assert.equal(sim.handle('a', { k: 'sell', id }), true);
  });
  it("co-op leaver: towers stay (upgradeable, unsellable), gold parked (not split), returned on rejoin", () => {
    const sim = mkSim('coop', ['a', 'b', 'c']);
    const [c, r] = cells(COOP_MAP, '.')[0];
    sim.handle('c', { k: 'build', t: 'laser', x: c, y: r });
    const id = sim.boards[0].cells[r * sim.W + c];
    sim.players.get('c').gold = 301;
    const ga = sim.players.get('a').gold;
    sim.removePlayer('c');
    assert.equal(sim.players.get('a').gold, ga);
    assert.equal(sim.players.get('b').gold, ga);
    assert.equal(sim.addPlayer({ id: 'c2', name: 'C', bot: false }).gold, 301, 'rejoin (any case) gets the parked gold');
    sim.removePlayer('c2');
    assert.ok(sim.towers.has(id));
    assert.equal(sim.handle('a', { k: 'sell', id }), false);
    assert.equal(sim.handle('a', { k: 'up', id }), true);
  });
  it('co-op: leaving and rejoining (rooms.ts gives a new id) must not mint gold', () => {
    // removePlayer parks the leaver's gold; the rejoin (same name, new id) gets exactly that back.
    const sim = mkSim('coop', ['a', 'b']);
    sim.wave = 5;
    sim.players.get('a').gold = 1000;
    sim.players.get('b').gold = 1000;
    const total = () => [...sim.players.values()].reduce((s: number, p: any) => s + p.gold, 0);
    sim.removePlayer('a');
    sim.addPlayer({ id: 'a2', name: 'a', bot: false });
    assert.equal(total(), 2000, `team gold went from 2000 to ${total()} after one leave + rejoin`);
  });
  it('co-op: a leave/rejoin loop (same name, then renamed) gains at most one capped purse per new name', () => {
    const sim = mkSim('coop', ['a', 'b']);
    const start = G.startGold.coop;
    const total = () => [...sim.players.values()].reduce((s: number, p: any) => s + p.gold, 0);
    const t0 = total();
    let id = 'b';
    for (let i = 0; i < 5; i++) {
      sim.removePlayer(id);
      id = 'b' + (i + 1);
      sim.addPlayer({ id, name: 'b', bot: false });
    }
    assert.equal(total(), t0, 'same-name rejoins mint nothing');
    sim.wave = 3;
    sim.clearPaid = 90;
    sim.players.get('a').gold = 5000; // the richest player's gold must not leak to joiners
    const t1 = total();
    for (let i = 0; i < 5; i++) {
      sim.removePlayer(id);
      id = 'x' + i;
      const p = sim.addPlayer({ id, name: 'x' + i, bot: false });
      assert.ok(p.gold <= start + 90, `renamed joiner got ${p.gold}`);
    }
    // b's gold stays parked; the team in play gains at most (start + clear bonuses) per new name.
    assert.ok(t1 === 5000 + start && total() <= 5000 + start + 90, `team gold in play ${t1} -> ${total()}`);
    // Spending everything then rejoining under ever new names stops paying out after MAX_COOP_PURSES purses.
    let minted = 0;
    for (let i = 0; i < 40; i++) {
      sim.players.get(id).gold = 0;
      sim.removePlayer(id);
      id = 'y' + i;
      minted += sim.addPlayer({ id, name: 'y' + i, bot: false }).gold;
    }
    assert.ok(minted <= 12 * (start + 90), `40 renamed rejoins minted ${minted}`);
    assert.equal(sim.addPlayer({ id: 'late', name: 'late', bot: false }).gold, 0);
  });
});

// ---- targeting ------------------------------------------------------------------------------------------------------

describe('targeting', () => {
  // Four enemies in range: A furthest along, B least far, C most health, D nearest the tower.
  function setup() {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'laser');
    const A = enemy(sim, 'runner', FAR + 4, FAR, { d: 50 });
    const B = enemy(sim, 'runner', FAR, FAR + 4, { d: 2 });
    const C = enemy(sim, 'brute', FAR - 4, FAR, { d: 20 });
    const D = enemy(sim, 'runner', FAR + 1, FAR + 1, { d: 10 });
    enemy(sim, 'runner', FAR + 30, FAR, { d: 99 }); // out of range: never picked
    return { sim, t, A, B, C, D, bd: sim.boards[0] };
  }
  it('first = least distance left to the greenhouse', () => {
    const { sim, t, A, bd } = setup();
    t.info.tm = 0;
    assert.equal(sim.pick(bd, t, t.lv.range).id, A.id);
  });
  it('last = most distance left', () => {
    const { sim, t, B, bd } = setup();
    t.info.tm = 1;
    assert.equal(sim.pick(bd, t, t.lv.range).id, B.id);
  });
  it('strong = most health', () => {
    const { sim, t, C, bd } = setup();
    t.info.tm = 2;
    assert.equal(sim.pick(bd, t, t.lv.range).id, C.id);
  });
  it('close = nearest', () => {
    const { sim, t, D, bd } = setup();
    t.info.tm = 3;
    assert.equal(sim.pick(bd, t, t.lv.range).id, D.id);
  });
  it('nothing in range = no target', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'laser');
    enemy(sim, 'runner', FAR + t.lv.range + 0.01, FAR);
    assert.equal(sim.pick(sim.boards[0], t, t.lv.range), null);
    sim.fire(sim.boards[0], DT);
    assert.equal(t.tg, 0);
  });
  it('tm messages: only integer 0..3, only on towers that target', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'laser');
    const s = tower(sim, 'p1', 'slow');
    for (const tm of [-1, 4, 1.5, NaN, '2', null]) assert.equal(sim.handle('p1', { k: 'tm', id: t.info.id, tm }), false);
    assert.equal(sim.handle('p1', { k: 'tm', id: s.info.id, tm: 1 }), false);
    assert.equal(sim.handle('p1', { k: 'tm', id: t.info.id, tm: 2 }), true);
    assert.equal(t.info.tm, 2);
  });
});

// ---- damage ---------------------------------------------------------------------------------------------------------

describe('armour and pierce', () => {
  it('damage = raw * (1 - armour * (1 - pierce))', () => {
    const sim = mkSim('coop');
    const cases: [string, number][] = [
      ['brute', 1],
      ['brute', 0],
      ['disruptor', 0],
      ['colossus', 0.5],
      ['runner', 0],
    ];
    for (const [kind, pierce] of cases) {
      const e = enemy(sim, kind);
      const hp0 = e.hp;
      sim.hurt(e, 10, pierce, null);
      near(hp0 - e.hp, 10 * (1 - ENEMIES[kind as keyof typeof ENEMIES].armor * (1 - pierce)), 1e-9, `${kind} pierce ${pierce}`);
    }
  });
  it('laser ignores brute armour, missile splash is halved by it', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'laser');
    const e = enemy(sim, 'brute', FAR + 3, FAR);
    sim.fire(sim.boards[0], 0.1);
    near(e.maxHp - e.hp, TOWERS.laser.levels[0].dmg * 0.1, 1e-9);
    void t;
  });
});

describe('laser', () => {
  it('continuous DPS: dmg * dt on its target', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'laser', FAR, FAR, 2);
    const e = enemy(sim, 'runner', FAR + 5, FAR);
    sim.fire(sim.boards[0], 0.25);
    near(e.maxHp - e.hp, 48 * 0.25, 1e-9);
    assert.equal(t.tg, e.id);
  });
  it('level 3 chains to 2 more enemies, each nearest within 3 m of the previous link, for 50%', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'laser', FAR, FAR, 3);
    t.info.tm = 3; // close
    const A = enemy(sim, 'runner', FAR + 5, FAR);
    const B = enemy(sim, 'runner', FAR + 7.5, FAR); // 2.5 m from A
    const C = enemy(sim, 'runner', FAR + 10, FAR); // 2.5 m from B, 5 m from A, out of the tower's range
    const D = enemy(sim, 'runner', FAR + 12.9, FAR); // 2.9 m from C, but the chain only has 2 links
    const X = enemy(sim, 'runner', FAR + 5, FAR + 3.5); // 3.5 m from A: too far
    const dt = 0.1;
    sim.fire(sim.boards[0], dt);
    assert.equal(t.tg, A.id);
    assert.deepEqual(t.ch, [B.id, C.id]);
    near(A.maxHp - A.hp, 95 * dt, 1e-9);
    near(B.maxHp - B.hp, 95 * dt * 0.5, 1e-9);
    near(C.maxHp - C.hp, 95 * dt * 0.5, 1e-9);
    assert.equal(D.hp, D.maxHp);
    assert.equal(X.hp, X.maxHp);
  });
  it('level 1/2 never chain', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'laser', FAR, FAR, 2);
    enemy(sim, 'runner', FAR + 3, FAR);
    const B = enemy(sim, 'runner', FAR + 4, FAR);
    t.info.tm = 3;
    sim.fire(sim.boards[0], 0.1);
    assert.deepEqual(t.ch, []);
    assert.equal(B.hp, B.maxHp);
  });
});

describe('missile', () => {
  it('flight time = distance / 12 m/s (min 0.25 s), landing after that many ticks', () => {
    const sim = mkSim('coop');
    tower(sim, 'p1', 'missile');
    const e = enemy(sim, 'brute', FAR + 6, FAR);
    sim.events = [];
    sim.fire(sim.boards[0], DT);
    const msl = sim.events.filter((v: any) => v.k === 'msl');
    assert.equal(msl.length, 1);
    near(msl[0].ft, 0.5, 1e-9);
    sim.events = [];
    let ticks = 0;
    while (!sim.events.some((v: any) => v.k === 'boom') && ticks < 100) {
      sim.flyMissiles(DT);
      ticks++;
    }
    assert.ok(ticks >= 10 && ticks <= 11, `landed after ${ticks} ticks`);
    // Missile pierce 0 vs brute armour 0.5: a direct hit does 40 * 0.5.
    near(e.maxHp - e.hp, 40 * 0.5, 1e-9);
  });
  it('close shots still fly 0.25 s', () => {
    const sim = mkSim('coop');
    tower(sim, 'p1', 'missile');
    enemy(sim, 'runner', FAR + 1, FAR);
    sim.events = [];
    sim.fire(sim.boards[0], DT);
    near(sim.events.find((v: any) => v.k === 'msl').ft, 0.25, 1e-9);
  });
  it('fires again only after interval / (1 + rate)', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'missile');
    enemy(sim, 'brute', FAR + 6, FAR, { hpMul: 100 });
    let shots = 0;
    for (let i = 0; i < Math.round(1.8 * 3 * G.tickRate); i++) {
      sim.events = [];
      sim.fire(sim.boards[0], DT);
      shots += sim.events.filter((v: any) => v.k === 'msl').length;
    }
    assert.equal(shots, 3, `${shots} shots in 3 intervals`);
    void t;
  });
  it('splash falls from 100% at the centre to 50% at the edge, reaches enemy bodies at the edge, not beyond', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'missile');
    const r = ENEMIES.runner.radius;
    const at = [0, 0.8, 1.6, 1.6 + r - 0.01, 1.6 + r + 0.05];
    const want = [40, 30, 20, 20, 0];
    const es = at.map((dx) => enemy(sim, 'runner', FAR + dx, FAR + 50));
    sim.missiles.push({ mid: 99, b: 0, tw: t.info.id, owner: 'p1', en: 0, x: FAR, z: FAR + 50, t: 0, dmg: 40, splash: 1.6 });
    sim.flyMissiles(DT);
    es.forEach((e: any, i: number) => near(e.maxHp - e.hp, want[i], 1e-9, `enemy at ${at[i]} m took ${e.maxHp - e.hp}, want ${want[i]}`));
  });
  it("lands at the target's then-position, or its last one if it died", () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'missile');
    const e = enemy(sim, 'runner', FAR + 6, FAR);
    sim.fire(sim.boards[0], DT);
    e.x = FAR + 7;
    e.z = FAR + 2;
    sim.events = [];
    for (let i = 0; i < 20; i++) sim.flyMissiles(DT);
    const boom = sim.events.find((v: any) => v.k === 'boom');
    assert.deepEqual([boom.x, boom.z], [FAR + 7, FAR + 2]);
    // Now the target dies mid-flight after moving once.
    const e2 = enemy(sim, 'runner', FAR + 6, FAR - 3);
    t.cd = 0;
    t.info.tm = 3;
    e.dead = true;
    sim.sweep(sim.boards[0]);
    sim.fire(sim.boards[0], DT);
    sim.flyMissiles(DT);
    e2.x = FAR + 5;
    sim.flyMissiles(DT);
    e2.dead = true;
    e2.x = FAR + 99;
    sim.sweep(sim.boards[0]);
    sim.events = [];
    for (let i = 0; i < 20; i++) sim.flyMissiles(DT);
    const boom2 = sim.events.find((v: any) => v.k === 'boom');
    assert.deepEqual([boom2.x, boom2.z], [FAR + 5, FAR - 3]);
  });
  it('a level-3 volley spreads over distinct targets, repeating the main target when fewer', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'missile', FAR, FAR, 3);
    const es = [3, 5, 7, 9].map((dx) => enemy(sim, 'runner', FAR + dx, FAR, { d: dx }));
    sim.events = [];
    sim.fire(sim.boards[0], DT);
    const tg = sim.events.filter((v: any) => v.k === 'msl').map((v: any) => v.en);
    assert.equal(tg.length, 3);
    assert.equal(new Set(tg).size, 3);
    assert.equal(tg[0], es[3].id, 'first = furthest along');
    // One enemy only: all three at it.
    const sim2 = mkSim('coop');
    tower(sim2, 'p1', 'missile', FAR, FAR, 3);
    const only = enemy(sim2, 'runner', FAR + 4, FAR);
    sim2.events = [];
    sim2.fire(sim2.boards[0], DT);
    assert.deepEqual(sim2.events.filter((v: any) => v.k === 'msl').map((v: any) => v.en), [only.id, only.id, only.id]);
    void t;
  });
});

describe('slow', () => {
  it('the strongest slow applies, nothing stacks; disabled slows project nothing', () => {
    const sim = mkSim('coop');
    const weak = tower(sim, 'p1', 'slow', FAR, FAR, 1);
    const strong = tower(sim, 'p1', 'slow', FAR, FAR + 1, 3);
    const e = enemy(sim, 'runner', FAR + 2, FAR);
    sim.fields(sim.boards[0], 0);
    assert.equal(e.slow, 0.5);
    strong.disabled = 2;
    sim.fields(sim.boards[0], 0);
    assert.equal(e.slow, 0.3);
    weak.disabled = 2;
    sim.fields(sim.boards[0], 0);
    assert.equal(e.slow, 0);
  });
  it('slowed enemies move speed * (1 - slow)', () => {
    const sim = mkSim('coop');
    tower(sim, 'p1', 'slow', FAR, FAR, 3);
    const e = enemy(sim, 'runner', FAR + 1, FAR, { d: 5 });
    sim.fields(sim.boards[0], 0);
    sim.move(sim.boards[0], 0.1);
    near(e.d - 5, e.speed * 0.5 * 0.1, 1e-9);
  });
  it('sting is continuous DPS', () => {
    const sim = mkSim('coop');
    tower(sim, 'p1', 'slow', FAR, FAR, 3);
    const e = enemy(sim, 'runner', FAR + 1, FAR);
    sim.fields(sim.boards[0], 0.5);
    near(e.maxHp - e.hp, 8 * 0.5, 1e-9);
  });
});

describe('beacon', () => {
  it('only the strongest covering beacon applies (dmg + rate together), in any build order', () => {
    for (const order of [['lv1', 'lv2'], ['lv2', 'lv1']]) {
      const sim = mkSim('coop');
      const laser = tower(sim, 'p1', 'laser');
      for (const o of order) tower(sim, 'p1', 'beacon', o === 'lv1' ? FAR + 2 : FAR, o === 'lv1' ? FAR : FAR + 3, o === 'lv1' ? 1 : 2);
      sim.auras(sim.boards[0], 0);
      assert.equal(laser.bDmg, 0.2, order.join(','));
      assert.equal(laser.bRate, 0.15);
      assert.equal(laser.bRange, 0);
      assert.ok(laser.f & TFlag.buffed);
      const e = enemy(sim, 'runner', FAR + 5, FAR);
      sim.fire(sim.boards[0], 0.1);
      near(e.maxHp - e.hp, 22 * 1.2 * 1.15 * 0.1, 1e-9);
    }
  });
  it('beacons never buff beacons (or themselves)', () => {
    const sim = mkSim('coop');
    const a = tower(sim, 'p1', 'beacon', FAR, FAR, 3);
    const b = tower(sim, 'p1', 'beacon', FAR + 1, FAR, 1);
    sim.auras(sim.boards[0], 0);
    assert.equal(a.bDmg, 0);
    assert.equal(b.bDmg, 0);
  });
  it('level 3 widens the buffed tower range by 10%', () => {
    const sim = mkSim('coop');
    const laser = tower(sim, 'p1', 'laser');
    const e = enemy(sim, 'runner', FAR + 7.5, FAR);
    sim.auras(sim.boards[0], 0);
    sim.fire(sim.boards[0], 0.1);
    assert.equal(laser.tg, 0, 'out of range without the beacon');
    tower(sim, 'p1', 'beacon', FAR - 2, FAR, 3);
    sim.auras(sim.boards[0], 0);
    sim.fire(sim.boards[0], 0.1);
    assert.equal(laser.tg, e.id);
  });
  it('a disabled beacon projects nothing', () => {
    const sim = mkSim('coop');
    const laser = tower(sim, 'p1', 'laser');
    const bc = tower(sim, 'p1', 'beacon', FAR + 1, FAR, 2);
    bc.disabled = 1;
    sim.auras(sim.boards[0], 0);
    assert.equal(laser.bDmg, 0);
  });
  it('the aura radius is the beacon range (not widened)', () => {
    const sim = mkSim('coop');
    const laser = tower(sim, 'p1', 'laser');
    tower(sim, 'p1', 'beacon', FAR + 4.6, FAR, 1); // lv1 range 4.5
    sim.auras(sim.boards[0], 0);
    assert.equal(laser.bDmg, 0);
  });
});

// ---- shield / disruptor -----------------------------------------------------------------------------------------------

describe('shield and disruptor', () => {
  function bolt(sim: any, e: any) {
    e.disT = -0.61; // fully charged
    sim.events = [];
    sim.disruptors(sim.boards[0], 0);
    return sim.events.find((v: any) => v.k === 'dis');
  }
  it('an unshielded tower in range is disabled for dur seconds and stops firing', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'laser');
    const d = enemy(sim, 'disruptor', FAR + 3, FAR);
    sim.auras(sim.boards[0], 0);
    const ev = bolt(sim, d);
    assert.ok(ev, 'no bolt');
    assert.equal(ev.blocked, 0);
    assert.equal(ev.tw, t.info.id);
    assert.equal(t.disabled, ENEMIES.disruptor.disrupt!.dur);
    assert.equal(d.disT, ENEMIES.disruptor.disrupt!.every);
    // Laser does nothing while disabled.
    const hp = d.hp;
    sim.fire(sim.boards[0], DT);
    assert.equal(d.hp, hp);
    assert.equal(t.tg, 0);
    let ticks = 0;
    while (t.disabled > 0 && ticks < 1000) {
      sim.auras(sim.boards[0], DT);
      ticks++;
    }
    near(ticks * DT, 3, DT + 1e-9, `disabled for ${ticks} ticks`);
    sim.fire(sim.boards[0], DT);
    assert.ok(d.hp < hp, 'fires again after');
  });
  it('disruptor charges 0.6 s before bolting the closest tower; none in range = no charge', () => {
    const sim = mkSim('coop');
    const far = tower(sim, 'p1', 'laser', FAR + 5, FAR);
    const close = tower(sim, 'p1', 'laser', FAR + 1, FAR);
    const d = enemy(sim, 'disruptor', FAR, FAR);
    d.disT = 0;
    let ticks = 0;
    sim.events = [];
    while (!sim.events.some((v: any) => v.k === 'dis') && ticks < 100) {
      sim.disruptors(sim.boards[0], DT);
      ticks++;
    }
    near(ticks * DT, 0.6 + DT, DT + 1e-9, `bolted after ${ticks} ticks`);
    assert.equal(sim.events.find((v: any) => v.k === 'dis').tw, close.info.id);
    assert.equal(far.disabled, 0);
    // Nothing in range: never bolts.
    const sim2 = mkSim('coop');
    tower(sim2, 'p1', 'laser', FAR + 7, FAR);
    const d2 = enemy(sim2, 'disruptor', FAR, FAR);
    d2.disT = 0;
    for (let i = 0; i < 200; i++) sim2.disruptors(sim2.boards[0], DT);
    assert.ok(!sim2.events.some((v: any) => v.k === 'dis'));
  });
  it('a shielded tower blocks the bolt (lv1: no stun); a shield covers itself', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'laser');
    const s = tower(sim, 'p1', 'shield', FAR, FAR + 2, 1);
    const d = enemy(sim, 'disruptor', FAR + 3, FAR);
    sim.auras(sim.boards[0], 0);
    assert.ok(t.f & TFlag.shielded);
    assert.ok(s.f & TFlag.shielded, 'shield covers itself');
    const ev = bolt(sim, d);
    assert.equal(ev.blocked, 1);
    assert.equal(t.disabled, 0);
    assert.equal(d.stun, 0);
  });
  it('a level-3 shield reflects: the disruptor is stunned for reflect seconds, cannot move or fire', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'laser');
    tower(sim, 'p1', 'shield', FAR, FAR + 2, 3);
    const d = enemy(sim, 'disruptor', FAR + 3, FAR, { d: 5 });
    sim.auras(sim.boards[0], 0);
    const ev = bolt(sim, d);
    assert.equal(ev.blocked, 1);
    assert.equal(d.stun, 1.5);
    assert.equal(t.disabled, 0);
    // Stunned: no charge, no movement.
    d.disT = -1;
    sim.events = [];
    sim.disruptors(sim.boards[0], DT);
    assert.ok(!sim.events.some((v: any) => v.k === 'dis'));
    const dd = d.d;
    sim.move(sim.boards[0], DT);
    assert.equal(d.d, dd);
  });
  it('a disabled shield projects nothing', () => {
    const sim = mkSim('coop');
    const t = tower(sim, 'p1', 'laser');
    const s = tower(sim, 'p1', 'shield', FAR, FAR + 2, 3);
    s.disabled = 2;
    sim.auras(sim.boards[0], 0);
    assert.equal(t.f & TFlag.shielded, 0);
    const d = enemy(sim, 'disruptor', FAR + 3, FAR);
    const ev = bolt(sim, d);
    assert.ok(ev, 'no bolt');
    assert.equal(ev.blocked, 0);
  });
  it('shield pulses dmg every 1 s to every enemy inside', () => {
    const sim = mkSim('coop');
    tower(sim, 'p1', 'shield', FAR, FAR, 1);
    const a = enemy(sim, 'runner', FAR + 1, FAR);
    const b = enemy(sim, 'runner', FAR - 4, FAR);
    const out = enemy(sim, 'runner', FAR + 6, FAR);
    let zaps = 0;
    for (let i = 0; i < G.tickRate * 3; i++) {
      sim.events = [];
      sim.fields(sim.boards[0], DT);
      zaps += sim.events.filter((v: any) => v.k === 'zap').length;
    }
    assert.equal(zaps, 3);
    near(a.maxHp - a.hp, 24, 1e-9);
    near(b.maxHp - b.hp, 24, 1e-9);
    assert.equal(out.hp, out.maxHp);
  });
});

// ---- colossus / leaks / end -------------------------------------------------------------------------------------------

describe('colossus', () => {
  it('sheds `shed` skitters at 75, 50 and 25% health, once each, keeping hpMul and sender', () => {
    const sim = mkSim('vs', ['a', 'b']);
    const c = enemy(sim, 'colossus', FAR, FAR, { hpMul: 2, from: 'b' });
    const max = c.maxHp;
    const skitters = () => sim.boards[0].en.filter((e: any) => e.kind === 'skitter');
    sim.hurt(c, max * 0.24, 1, null);
    assert.equal(skitters().length, 0);
    sim.hurt(c, max * 0.02, 1, null); // 74%
    assert.equal(skitters().length, 6);
    sim.hurt(c, max * 0.5, 1, null); // 24%: crosses 50 and 25 in one hit
    assert.equal(skitters().length, 18);
    for (const s of skitters()) {
      assert.equal(s.hpMul, 2);
      assert.equal(s.from, 'b');
      assert.equal(s.maxHp, ENEMIES.skitter.hp * 2);
    }
    sim.hurt(c, max, 1, null); // death: no extra shed
    assert.ok(c.dead);
    assert.equal(skitters().length, 18);
  });
  it('skitters shed by a blow are not hit by that same blow (missile splash, slow field, shield pulse)', () => {
    for (const how of ['missile', 'slow', 'shield'] as const) {
      const sim = mkSim('coop', ['a']);
      const c = enemy(sim, 'colossus', FAR, FAR);
      c.hp = c.maxHp * 0.76;
      if (how === 'missile') {
        sim.missiles.push({ mid: 1, b: 0, tw: 0, owner: 'a', en: c.id, x: c.x, z: c.z, t: 0, dmg: c.maxHp * 0.05, splash: 2.6 });
        sim.flyMissiles(0.05);
      } else {
        const t = tower(sim, 'a', how, FAR, FAR, 3);
        t.zapT = 0;
        t.lv = { ...t.lv, dmg: c.maxHp * 0.05 * (how === 'slow' ? 1 / DT : 1) };
        sim.fields(sim.boards[0], DT);
      }
      const sk = sim.boards[0].en.filter((e: any) => e.kind === 'skitter');
      assert.ok(sk.length > 0, `${how}: no shed`);
      for (const s of sk) assert.equal(s.hp, s.maxHp, `${how}: a shed skitter was hit by the blow that shed it`);
    }
  });
});

describe('leaks and lives', () => {
  it('a leak costs enemy.lives, clamped at 0', () => {
    const sim = mkSim('coop');
    const bd = sim.boards[0];
    for (const kind of ['runner', 'disruptor', 'brute', 'colossus'] as const) {
      bd.lives = 20;
      const e = sim.addEnemy(bd, kind, 0, bd.routes[0].length - 0.001, 0, 1, null);
      sim.move(bd, DT);
      assert.ok(e.dead);
      assert.equal(bd.lives, 20 - ENEMIES[kind].lives, kind);
    }
    bd.lives = 4;
    sim.addEnemy(bd, 'colossus', 0, bd.routes[0].length - 0.001, 0, 1, null);
    sim.move(bd, DT);
    assert.equal(bd.lives, 0);
  });
  it('co-op: the match is lost at 0 lives', () => {
    const sim = mkSim('coop');
    const bd = sim.boards[0];
    sim.phase = 'wave';
    sim.wave = 4;
    bd.lives = 1;
    sim.addEnemy(bd, 'runner', 0, bd.routes[0].length - 0.001, 0, 1, null);
    sim.step(DT);
    assert.deepEqual(sim.end, { win: false, winner: null, wave: 4 });
    assert.equal(sim.phase, 'over');
    assert.equal(sim.handle('p1', { k: 'build', t: 'laser', x: 0, y: 0 }), false);
  });
  it('co-op: victory after clearing wave G.coopWaves, not before', () => {
    const sim = mkSim('coop');
    sim.phase = 'wave';
    sim.wave = G.coopWaves - 1;
    sim.step(DT);
    assert.equal(sim.end, null);
    assert.equal(sim.phase, 'build');
    assert.equal(sim.left, G.betweenWaves);
    sim.phase = 'wave';
    sim.wave = G.coopWaves;
    const g0 = sim.players.get('p1').gold;
    sim.step(DT);
    assert.deepEqual(sim.end, { win: true, winner: null, wave: G.coopWaves });
    assert.equal(sim.players.get('p1').gold, g0 + G.clearBonus + G.clearBonusPerWave * G.coopWaves);
  });
});

describe('versus elimination', () => {
  it('boards fall one by one with places, the last one wins', () => {
    const sim = mkSim('vs', ['a', 'b', 'c']);
    sim.phase = 'wave';
    sim.wave = 5;
    sim.boards[1].lives = 0;
    sim.step(DT);
    assert.equal(sim.boards[1].out, true);
    assert.equal(sim.boards[1].place, 3);
    assert.equal(sim.end, null);
    assert.equal(sim.scores().find((s: any) => s.id === 'b').place, 3);
    sim.boards[0].lives = 0;
    sim.step(DT);
    assert.equal(sim.boards[0].place, 2);
    assert.deepEqual(sim.end, { win: true, winner: 'c', wave: 5 });
    assert.equal(sim.boards[2].place, 1);
    const sc = Object.fromEntries(sim.scores().map((s: any) => [s.id, s]));
    assert.equal(sc.c.place, 1);
    assert.ok(sc.c.points > sc.a.points && sc.a.points > sc.b.points);
  });
  it('eliminated boards lose their enemies and queued sends, and towers stop', () => {
    const sim = mkSim('vs', ['a', 'b', 'c']);
    const t = tower(sim, 'a', 'laser');
    enemy(sim, 'runner', FAR + 3, FAR, { b: 0 });
    sim.boards[0].queued.push({ kind: 'runner', from: 'b' });
    sim.boards[0].lives = 0;
    sim.phase = 'wave';
    sim.step(DT);
    assert.equal(sim.boards[0].en.length, 0);
    assert.equal(sim.boards[0].queued.length, 0);
    assert.equal(t.tg, 0);
    assert.ok(![...sim.enemies.values()].some((e: any) => e.b === 0));
  });
  it('when the last boards fall on the same tick, more lives at the start of the tick wins', () => {
    const sim = mkSim('vs', ['a', 'b']);
    sim.phase = 'wave';
    sim.wave = 9;
    const [b0, b1] = sim.boards;
    b0.lives = 3;
    b1.lives = 1;
    sim.addEnemy(b0, 'brute', 0, b0.routes[0].length - 0.001, 0, 1, null);
    sim.addEnemy(b1, 'runner', 0, b1.routes[0].length - 0.001, 0, 1, null);
    sim.step(DT);
    assert.equal(b0.lives, 0);
    assert.equal(b1.lives, 0);
    assert.deepEqual(sim.end, { win: true, winner: 'a', wave: 9 });
    assert.equal(b1.place, 2);
    assert.equal(b0.place, 1);
  });
  it('same lives at the start of the tick: more damage dealt wins', () => {
    const sim = mkSim('vs', ['a', 'b']);
    sim.phase = 'wave';
    const [b0, b1] = sim.boards;
    b0.lives = 1;
    b1.lives = 1;
    sim.players.get('a').score.dmg = 10;
    sim.players.get('b').score.dmg = 20;
    sim.addEnemy(b0, 'runner', 0, b0.routes[0].length - 0.001, 0, 1, null);
    sim.addEnemy(b1, 'runner', 0, b1.routes[0].length - 0.001, 0, 1, null);
    sim.step(DT);
    assert.equal(sim.end.winner, 'b');
  });
});

// ---- economy --------------------------------------------------------------------------------------------------------

describe('economy', () => {
  it('early call: earlyBonusPerSec x whole seconds skipped, capped at betweenWaves', () => {
    const sim = mkSim('coop', ['a', 'b']);
    sim.handle('a', { k: 'ready' });
    sim.step(DT);
    assert.equal(sim.wave, 0, 'waits for every human');
    sim.handle('b', { k: 'ready' });
    const g = sim.players.get('a').gold;
    sim.events = [];
    sim.step(DT);
    assert.equal(sim.wave, 1);
    const bonus = G.betweenWaves * G.earlyBonusPerSec; // 25 s left, capped
    assert.equal(sim.players.get('a').gold, g + bonus);
    assert.ok(sim.events.some((v: any) => v.k === 'gold' && v.why === 'early' && v.n === bonus && v.id === 'b'));
    // A short skip: 3.5 s left -> 3 whole seconds.
    const sim2 = mkSim('coop');
    sim2.left = 3.5 + DT;
    sim2.handle('p1', { k: 'ready' });
    const g2 = sim2.players.get('p1').gold;
    sim2.step(DT);
    assert.equal(sim2.players.get('p1').gold, g2 + 3 * G.earlyBonusPerSec);
    // Timer ran out: no bonus.
    const sim3 = mkSim('coop');
    sim3.left = DT / 2;
    const g3 = sim3.players.get('p1').gold;
    sim3.step(DT);
    assert.equal(sim3.wave, 1);
    assert.equal(sim3.players.get('p1').gold, g3);
  });
  it('ready toggles for humans and only in the build phase; spectators cannot ready', () => {
    const sim = mkSim('coop');
    assert.equal(sim.handle('p1', { k: 'ready' }), true);
    assert.equal(sim.players.get('p1').ready, true);
    sim.handle('p1', { k: 'ready' });
    assert.equal(sim.players.get('p1').ready, false);
    sim.phase = 'wave';
    assert.equal(sim.handle('p1', { k: 'ready' }), false);
    const vs = mkSim('vs', ['a', 'b']);
    vs.addPlayer({ id: 's', name: 's', bot: false });
    assert.equal(vs.handle('s', { k: 'ready' }), false);
  });
  it('co-op: a kill pays every defender ceil(bounty * waveBounty * coopBountyShare)', () => {
    const sim = mkSim('coop', ['a', 'b', 'c']);
    sim.wave = 6;
    const g = [...sim.players.values()].map((p: any) => p.gold);
    const e = enemy(sim, 'brute');
    sim.hurt(e, 1e9, 1, null);
    const want = Math.ceil(ENEMIES.brute.bounty * waveBounty(6) * coopBountyShare(3));
    [...sim.players.values()].forEach((p: any, i: number) => assert.equal(p.gold - g[i], want));
  });
  it('co-op: wave counts scale by round(count * coopCount), colossus excepted', () => {
    for (const n of [1, 3, 6]) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      const sim = mkSim('coop', ids);
      sim.wave = 9;
      sim.startWave();
      const pend = sim.boards[0].pending;
      const runners = pend.filter((s: any) => s.kind === 'runner').length;
      const base = Math.ceil((6 + Math.floor(10 * 1.2)) * 0.5);
      assert.equal(runners, Math.max(1, Math.round(base * coopCount(n))), `${n} players`);
      assert.equal(pend.filter((s: any) => s.kind === 'colossus').length, 1);
    }
  });
  it('versus: kills pay the board owner, sent units 50%', () => {
    const sim = mkSim('vs', ['a', 'b']);
    sim.wave = 3;
    const ga = sim.players.get('a').gold;
    const gb = sim.players.get('b').gold;
    sim.hurt(enemy(sim, 'runner', FAR, FAR, { b: 0 }), 1e9, 1, null);
    assert.equal(sim.players.get('a').gold - ga, Math.round(6 * waveBounty(3)));
    sim.hurt(enemy(sim, 'brute', FAR, FAR, { b: 0, from: 'b' }), 1e9, 1, null);
    assert.equal(sim.players.get('a').gold - ga, Math.round(6 * waveBounty(3)) + Math.round(30 * waveBounty(3) * 0.5));
    assert.equal(sim.players.get('b').gold, gb);
  });
});

describe('versus sends', () => {
  it('cost gold, raise income, queue into the target next wave', () => {
    const sim = mkSim('vs', ['a', 'b', 'c']);
    sim.wave = 1; // build phase before wave 2
    const a = sim.players.get('a');
    const rn = SENDS.find((s) => s.kind === 'runner')!;
    assert.equal(sim.handle('a', { k: 'send', e: 'runner' }), true);
    assert.equal(a.gold, G.startGold.vs - rn.cost);
    assert.equal(a.income, rn.income);
    assert.equal(sim.boards[1].queued.length, rn.count, 'default target: next living opponent');
    assert.ok(sim.boards[1].queued.every((q: any) => q.from === 'a' && q.kind === 'runner'));
    assert.equal(sim.handle('a', { k: 'send', e: 'runner' }), true);
    assert.equal(sim.boards[2].queued.length, rn.count, 'default target cycles');
    assert.equal(a.sends, 2);
  });
  it('unlock wave and per-wave cap are checked against the wave the send enters', () => {
    const sim = mkSim('vs', ['a', 'b']);
    sim.wave = 1;
    sim.players.get('a').gold = 1e6;
    assert.equal(sim.handle('a', { k: 'send', e: 'skitter' }), false);
    assert.equal(sim.denies.at(-1).why, 'Unlocks on wave 3');
    for (let i = 0; i < sendCap(2); i++) assert.equal(sim.handle('a', { k: 'send', e: 'runner' }), true);
    assert.equal(sim.handle('a', { k: 'send', e: 'runner' }), false);
    assert.equal(sim.denies.at(-1).why, 'Send limit reached this wave');
    sim.startWave(); // wave 2: counter resets
    assert.equal(sim.handle('a', { k: 'send', e: 'skitter' }), true);
    sim.wave = 15;
    sim.players.get('a').sends = 0;
    assert.equal(sim.handle('a', { k: 'send', e: 'colossus' }), true, 'colossus from 15 (enters 16)');
  });
  it('not enough gold is refused and charges nothing', () => {
    const sim = mkSim('vs', ['a', 'b']);
    sim.wave = 5;
    sim.players.get('a').gold = 149;
    assert.equal(sim.handle('a', { k: 'send', e: 'brute' }), false);
    assert.equal(sim.players.get('a').gold, 149);
    assert.equal(sim.players.get('a').sends, 0);
    assert.equal(sim.boards[1].queued.length, 0);
  });
  it('explicit target: a living opponent only', () => {
    const sim = mkSim('vs', ['a', 'b', 'c']);
    sim.wave = 2;
    sim.players.get('a').gold = 1e6;
    for (const to of [0, 9, -1, 1.5, NaN, '1']) assert.equal(sim.handle('a', { k: 'send', e: 'runner', to }), false, `to ${String(to)}`);
    sim.eliminate(sim.boards[2]);
    assert.equal(sim.handle('a', { k: 'send', e: 'runner', to: 2 }), false);
    assert.equal(sim.handle('a', { k: 'send', e: 'runner', to: 1 }), true);
    // Default target skips the eliminated board.
    assert.equal(sim.handle('a', { k: 'send', e: 'runner' }), true);
    assert.equal(sim.boards[1].queued.length, 6);
  });
  it('BotView.sendsLeft tells bots how many sends the cap still allows', () => {
    const sim = mkSim('vs', ['a', 'b']);
    const p = sim.players.get('a');
    const cap = sendCap(sim.wave + 1);
    assert.equal(sim.botView(p).sendsLeft, cap);
    p.sends = cap;
    assert.equal(sim.botView(p).sendsLeft, 0);
    assert.equal(mkSim('coop', ['a']).botView(mkSim('coop', ['a']).players.get('a')).sendsLeft, 0);
  });
  it('co-op has no sends', () => {
    const sim = mkSim('coop');
    sim.wave = 5;
    assert.equal(sim.handle('p1', { k: 'send', e: 'runner' }), false);
  });
  it('at wave start: income paid, sends enter from 4 s with that wave health, skitters as packs', () => {
    const sim = mkSim('vs', ['a', 'b']);
    sim.wave = 2;
    sim.players.get('a').gold = 1000;
    sim.handle('a', { k: 'send', e: 'runner', to: 1 });
    sim.handle('a', { k: 'send', e: 'skitter', to: 1 });
    const inc = G.baseIncome + 5 + 6;
    const g = sim.players.get('a').gold;
    const gb = sim.players.get('b').gold;
    const t0 = sim.time;
    sim.left = 0; // no early-call bonus in this check
    sim.startWave();
    assert.equal(sim.players.get('a').gold, g + inc);
    assert.equal(sim.players.get('b').gold, gb + G.baseIncome);
    const sent = sim.boards[1].pending.filter((s: any) => s.from === 'a');
    assert.equal(sent.length, 3 + SKITTER_PACK);
    const hp = waveHp(3) * vsHpRamp(3);
    assert.ok(sent.every((s: any) => Math.abs(s.hpMul - hp) < 1e-12));
    const ats = [...new Set(sent.map((s: any) => +(s.at - t0).toFixed(6)))].sort((x: any, y: any) => x - y);
    assert.deepEqual(ats, [4, 4.6, 5.2, 5.8]);
    assert.equal(sim.boards[1].queued.length, 0);
    assert.equal(sim.boards[0].pending.filter((s: any) => s.from).length, 0);
  });
});

// ---- server wrapper -----------------------------------------------------------------------------------------------------

function fakeHost(mode: 'coop' | 'vs', ids: string[], map: string) {
  const players = ids.map((id, i) => ({ id, name: id, bot: id.startsWith('bot'), color: i }));
  const host = {
    code: 'TEST',
    settings: { name: 't', game: 'garden', maxPlayers: 8, bots: 0, botDifficulty: 'normal', map, mode } as any,
    sent: [] as { id: string; m: any }[],
    bcast: [] as any[],
    chat: [] as string[],
    ended: 0,
    botDifficulty: () => 'normal' as const,
    players: () => players,
    send(id: string, m: any) {
      host.sent.push({ id, m });
    },
    broadcast(m: any) {
      host.bcast.push(m);
    },
    systemChat(t: string) {
      host.chat.push(t);
    },
    matchEnded() {
      host.ended++;
    },
  };
  return { host, players };
}

describe('server', () => {
  it('start sends init to every human (not bots) with their board', () => {
    const { host } = fakeHost('vs', ['a', 'b', 'bot1'], 'seedling-plot');
    const game: any = createGardenGame(host as any);
    game.start();
    game.stop();
    const inits = host.sent.filter((s) => s.m.k === 'init');
    assert.deepEqual(inits.map((s) => s.id).sort(), ['a', 'b']);
    assert.equal(inits.find((s) => s.id === 'b')!.m.myBoard, 1);
    assert.equal(inits[0].m.map.id, 'seedling-plot');
    assert.equal(inits[0].m.boards.length, 3);
  });
  it('mid-match co-op joiner gets init, defends, gets start gold + clear bonuses, capped at the median', () => {
    const { host, players } = fakeHost('coop', ['a', 'b', 'c'], 'greenhouse-commons');
    const game: any = createGardenGame(host as any);
    game.start();
    game.stop();
    const sim = game.sim;
    sim.wave = 4;
    sim.clearPaid = 400;
    sim.players.get('a').gold = 100;
    sim.players.get('b').gold = 500;
    sim.players.get('c').gold = 900;
    const p = { id: 'd', name: 'd', bot: false, color: 9 };
    players.push(p);
    host.sent = [];
    game.addPlayer(p);
    const init = host.sent.find((s) => s.id === 'd' && s.m.k === 'init');
    assert.ok(init, 'no init for the joiner');
    assert.equal(init!.m.myBoard, 0);
    assert.equal(init!.m.wave, 4);
    assert.equal(sim.players.get('d').gold, 500);
    assert.ok(host.bcast.some((m) => m.k === 'score'));
  });
  it('mid-match versus joiner spectates (myBoard -1, PlayerSnap.b -1)', () => {
    const { host, players } = fakeHost('vs', ['a', 'b'], 'seedling-plot');
    const game: any = createGardenGame(host as any);
    game.start();
    game.stop();
    const p = { id: 's', name: 's', bot: false, color: 9 };
    players.push(p);
    game.addPlayer(p);
    const init = host.sent.find((s) => s.id === 's' && s.m.k === 'init');
    assert.equal(init!.m.myBoard, -1);
    assert.equal(game.sim.snapshot().pl.find((q: any) => q.id === 's').b, -1);
    assert.equal(game.sim.boards.length, 2);
  });
  it('garbage messages are rejected without throwing or changing state', () => {
    const { host } = fakeHost('coop', ['a', 'b'], 'greenhouse-commons');
    const game: any = createGardenGame(host as any);
    game.start();
    game.stop();
    const sim = game.sim;
    const [c, r] = cells(COOP_MAP, '.')[0];
    sim.handle('b', { k: 'build', t: 'laser', x: c, y: r });
    const bt = sim.boards[0].cells[r * sim.W + c];
    const before = JSON.stringify({ g: [...sim.players.values()].map((p: any) => p.gold), t: sim.towerInfos() });
    const junk: unknown[] = [
      null,
      undefined,
      42,
      'build',
      [],
      [1, 2],
      {},
      { k: 42 },
      { k: '__proto__' },
      { k: 'constructor' },
      { k: 'build' },
      { k: 'build', t: 'laser', x: NaN, y: 1 },
      { k: 'build', t: 'laser', x: '1', y: '1' },
      { k: 'build', t: 'laser', x: 1.5, y: 2 },
      { k: 'build', t: 'laser', x: Infinity, y: 2 },
      { k: 'build', t: 'toString', x: c + 1, y: r },
      { k: 'build', t: ['laser'], x: c + 1, y: r },
      { k: 'build', t: 'laser', x: c, y: r },
      { k: 'up', id: String(bt) },
      { k: 'up', id: bt + 0.5 },
      { k: 'up', id: 99999 },
      { k: 'up', id: { valueOf: () => bt } },
      { k: 'sell', id: bt }, // b's tower: a may not sell it
      { k: 'sell', id: NaN },
      { k: 'tm', id: bt, tm: 9 },
      { k: 'tm', id: bt, tm: '1' },
      { k: 'tm', id: bt, tm: NaN },
      { k: 'send', e: 'runner' },
      { k: 'send', e: 'dragon', to: 1 },
      { k: 'ping', x: NaN, z: 1 },
      { k: 'ping', x: Infinity, z: 1 },
      { k: 'ping', x: 1e9, z: 1 },
      { k: 'ping', x: '1', z: '2' },
      { k: 'view', b: 99 },
      { k: 'view', b: -1 },
      { k: 'view', b: 0.5 },
    ];
    let clock = 0;
    game.now = () => (clock += 1000); // keep the action token bucket full
    for (const m of junk) assert.doesNotThrow(() => game.onMessage('a', m as any), `threw on ${JSON.stringify(m)}`);
    // Unknown senders and bots are ignored.
    assert.doesNotThrow(() => game.onMessage('nobody', { k: 'build', t: 'laser', x: c + 1, y: r }));
    const after = JSON.stringify({ g: [...sim.players.values()].map((p: any) => p.gold), t: sim.towerInfos() });
    assert.equal(after, before);
    assert.equal(game.views.size, 0);
    assert.ok(sim.denies.some((d: any) => d.id === 'a' && d.why === 'Only the builder can sell that'));
  });
  it('the loop flushes events, sends denies privately, and ends the match once', () => {
    const { host } = fakeHost('coop', ['a'], 'greenhouse-commons');
    const game: any = createGardenGame(host as any);
    game.start();
    game.stop();
    game.onMessage('a', { k: 'build', t: 'laser', x: 0, y: 2 }); // portal cell
    game.loop();
    const deny = host.sent.find((s) => s.m.k === 'ev' && s.m.e[0].k === 'deny');
    assert.ok(deny && deny.id === 'a');
    game.sim.boards[0].lives = 0;
    game.loop();
    game.loop();
    assert.equal(host.ended, 1);
    assert.equal(host.bcast.filter((m) => m.k === 'end').length, 1);
    assert.equal(host.bcast.find((m) => m.k === 'end').win, false);
  });
  it("'sync' is answered at most once per 2 s per player", () => {
    const { host } = fakeHost('coop', ['a', 'b'], 'greenhouse-commons');
    const game: any = createGardenGame(host as any);
    game.start();
    game.stop();
    let now = 10_000;
    game.now = () => now;
    host.sent = [];
    for (let i = 0; i < 50; i++) game.onMessage('a', { k: 'sync' });
    game.onMessage('b', { k: 'sync' });
    const inits = (id: string) => host.sent.filter((s) => s.id === id && s.m.k === 'init').length;
    assert.equal(inits('a'), 1);
    assert.equal(inits('b'), 1);
    now += 1999;
    game.onMessage('a', { k: 'sync' });
    assert.equal(inits('a'), 1);
    now += 1;
    game.onMessage('a', { k: 'sync' });
    assert.equal(inits('a'), 2);
  });
  it('actions go through a per-player token bucket (burst 20, ~12/s), excess dropped silently', () => {
    const { host } = fakeHost('coop', ['a', 'b'], 'greenhouse-commons');
    const game: any = createGardenGame(host as any);
    game.start();
    game.stop();
    const sim = game.sim;
    let now = 0;
    game.now = () => now;
    let pings = 0;
    const orig = sim.handle.bind(sim);
    sim.handle = (id: string, m: any) => {
      if (id === 'a') pings++;
      return orig(id, m);
    };
    for (let i = 0; i < 200; i++) game.onMessage('a', { k: 'ping', x: 1, z: 1 });
    assert.equal(pings, 20, 'burst');
    game.onMessage('b', { k: 'ping', x: 1, z: 1 }); // b has its own bucket
    now += 1000;
    for (let i = 0; i < 200; i++) game.onMessage('a', { k: 'ping', x: 1, z: 1 });
    assert.equal(pings, 32, 'refill per second');
    for (let i = 0; i < 50; i++) game.onMessage('a', { k: 'view', b: 0 }); // 'view' is not rate-limited this way
    assert.equal(game.views.get('a'), 0);
  });
  it('snapshots go per client through host.send (backpressure applies), every board every 4th', () => {
    const { host } = fakeHost('vs', ['a', 'b', 'c'], 'seedling-plot');
    const game: any = createGardenGame(host as any);
    game.start();
    game.stop();
    host.bcast = [];
    host.sent = [];
    for (let i = 0; i < 4; i++) game.sendSnapshots();
    assert.equal(host.bcast.filter((m) => m.k === 'snap').length, 0);
    const snaps = host.sent.filter((s) => s.m.k === 'snap');
    assert.equal(snaps.length, 12);
    assert.equal(snaps.filter((s) => s.m.s.eb === undefined).length, 3, 'one all-boards snapshot per client');
  });
  it('versus: the end message names a winner who has left', () => {
    const { host, players } = fakeHost('vs', ['a', 'b'], 'seedling-plot');
    const game: any = createGardenGame(host as any);
    game.start();
    game.stop();
    players.splice(0, 1); // 'a' left the room
    game.removePlayer('a');
    game.sim.end = { win: true, winner: 'a', wave: 7 };
    game.finish();
    assert.ok(host.chat.some((t) => t.startsWith("a's garden is the last one standing")), host.chat.join(' | '));
  });
  it('bot players cannot send messages through the server', () => {
    const { host } = fakeHost('coop', ['a', 'bot1'], 'greenhouse-commons');
    const game: any = createGardenGame(host as any);
    game.start();
    game.stop();
    const [c, r] = cells(COOP_MAP, '.')[0];
    game.onMessage('bot1', { k: 'build', t: 'laser', x: c, y: r });
    assert.equal(game.sim.towers.size, 0);
  });
});

// ---- board geometry -------------------------------------------------------------------------------------------------

describe('board.ts', () => {
  it('routePos is continuous (no jumps, no yaw snaps) on every map, route and lateral', () => {
    const step = 0.01;
    const bad: string[] = [];
    for (const def of GMAPS) {
      def.routes.forEach((rt, ri) => {
        const g = routeGeom(def, { x: 0, z: 0 }, rt);
        for (const lat of [-1, -0.5, 0, 0.5, 1]) {
          let prev = routePos(g, 0, lat);
          let px = prev.x;
          let pz = prev.z;
          let pyaw = prev.yaw;
          let worst = 0;
          let worstD = 0;
          let worstYaw = 0;
          for (let d = step; d <= g.length + step; d += step) {
            const p = routePos(g, d, lat);
            const jump = Math.hypot(p.x - px, p.z - pz);
            let dy = Math.abs(p.yaw - pyaw);
            if (dy > Math.PI) dy = 2 * Math.PI - dy;
            if (jump > worst) {
              worst = jump;
              worstD = d;
            }
            if (dy > worstYaw) worstYaw = dy;
            px = p.x;
            pz = p.z;
            pyaw = p.yaw;
          }
          // A 1 cm step may stretch on the outside of a tight bend, never to a jump.
          if (worst > 0.1) bad.push(`${def.id} route ${ri} lateral ${lat}: ${worst.toFixed(3)} m jump at d=${worstD.toFixed(2)}`);
          if (worstYaw > 0.15) bad.push(`${def.id} route ${ri} lateral ${lat}: yaw snaps ${worstYaw.toFixed(3)} rad`);
          void prev;
          prev = routePos(g, 0, lat);
        }
        // Ends: the centreline starts at the portal and ends at the door; d is clamped.
        const a = routePos(g, -5);
        const b = routePos(g, g.length + 5);
        near(a.x, g.xs[0], 1e-9);
        near(a.z, g.zs[0], 1e-9);
        near(b.x, g.xs.at(-1)!, 1e-9);
        near(b.z, g.zs.at(-1)!, 1e-9);
      });
    }
    assert.deepEqual(bad, []);
  });
  it('lateral offset stays within 80% of the half-width', () => {
    for (const def of GMAPS)
      for (const rt of def.routes) {
        const g = routeGeom(def, { x: 0, z: 0 }, rt);
        for (let d = 0; d <= g.length; d += 0.37) {
          const c = routePos(g, d, 0);
          for (const lat of [-1, 1]) {
            const p = routePos(g, d, lat);
            near(Math.hypot(p.x - c.x, p.z - c.z), g.half * 0.8, 1e-6);
          }
        }
      }
  });
  it('boardOrigin: 1 board at the origin; 2..6 boards distinct, non-overlapping, centred', () => {
    for (const def of GMAPS) {
      assert.deepEqual(boardOrigin(def, 0, 1), { x: 0, z: 0 });
      const w = def.grid[0].length * G.cell;
      const h = def.grid.length * G.cell;
      for (let n = 2; n <= 6; n++) {
        const os = Array.from({ length: n }, (_, b) => boardOrigin(def, b, n));
        for (let i = 0; i < n; i++)
          for (let j = i + 1; j < n; j++) {
            const dx = Math.abs(os[i].x - os[j].x);
            const dz = Math.abs(os[i].z - os[j].z);
            assert.ok(dx >= w + G.boardGap - 1e-9 || dz >= h + G.boardGap - 1e-9, `${def.id} n=${n}: boards ${i} and ${j} overlap`);
          }
        const rows = new Map<number, number[]>();
        for (const o of os) rows.set(o.z, [...(rows.get(o.z) ?? []), o.x]);
        const sizes = [...rows.keys()].sort((a, b) => a - b).map((z) => rows.get(z)!.length);
        const want = { 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 6: [3, 3] }[n as 2 | 3 | 4 | 5 | 6];
        assert.deepEqual(sizes, want, `${def.id} n=${n} rows`);
        for (const xs of rows.values()) near(xs.reduce((s, x) => s + x, 0), 0, 1e-9, `${def.id} n=${n}: row not centred`);
        near([...rows.keys()].reduce((s, z) => s + z, 0), 0, 1e-9, `${def.id} n=${n}: rows not centred`);
      }
    }
  });
  it('versus sims put each board at its boardOrigin and towers on their own board', () => {
    const sim = mkSim('vs', ['a', 'b', 'c', 'd', 'e']);
    sim.boards.forEach((bd: any, b: number) => assert.deepEqual(bd.origin, boardOrigin(VS_MAP, b, 5)));
  });
});

describe('maps', () => {
  it('every map passes tools/garden/checkmaps.ts', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const play = resolve(here, '../..');
    const res = spawnSync(process.execPath, [resolve(play, 'backend/node_modules/tsx/dist/cli.mjs'), 'tools/garden/checkmaps.ts', '-q'], {
      cwd: play,
      encoding: 'utf8',
    });
    const errs = (res.stdout ?? '').split('\n').filter((l) => /ERROR|FAIL|DUPLICATE/.test(l));
    assert.equal(res.status, 0, `checkmaps exited ${res.status}:\n${errs.join('\n')}\n${res.stderr ?? ''}`);
  });
  it('every map has at least one mode, and both modes have maps', () => {
    assert.ok(GMAPS.every((m) => m.modes.length > 0));
    assert.ok(GMAPS.some((m) => m.modes.includes('coop')));
    assert.ok(GMAPS.some((m) => m.modes.includes('vs')));
  });
});

// ---- determinism and full matches -------------------------------------------------------------------------------------

function trace(mode: 'coop' | 'vs', seed: number, ticks: number): string[] {
  const sim = mkSim(mode, ['bot1', 'bot2', 'bot3'], { bots: true, seed });
  const out: string[] = [];
  for (let i = 0; i < ticks && !sim.end; i++) {
    sim.step(DT);
    if (i % 20 === 0) {
      const { t: _t, ...snap } = sim.snapshot();
      out.push(JSON.stringify(snap));
    }
    out.push(JSON.stringify(sim.events));
    sim.events = [];
  }
  return out;
}

describe('determinism', () => {
  for (const mode of ['coop', 'vs'] as const) {
    it(`${mode}: same seed = identical match (bots included); another seed differs`, () => {
      const a = trace(mode, 1234, 6000);
      const b = trace(mode, 1234, 6000);
      assert.equal(a.length, b.length);
      const i = a.findIndex((x, k) => x !== b[k]);
      assert.equal(i, -1, `diverged at trace line ${i}`);
      const c = trace(mode, 999, 6000);
      assert.notDeepEqual(a, c);
    });
  }
});

describe('full matches', () => {
  for (const [mode, def, n] of [
    ['coop', COOP_MAP, 3],
    ['vs', VS_MAP, 4],
  ] as const) {
    it(`${mode} with ${n} bots plays to an end with sane invariants`, () => {
      const sim = mkSim(mode, Array.from({ length: n }, (_, i) => `bot${i}`), { bots: true, seed: 77, def });
      let ticks = 0;
      while (!sim.end && ticks < 200000) {
        sim.step(DT);
        sim.events = [];
        sim.denies = [];
        ticks++;
        if (ticks % 200 === 0) {
          for (const p of sim.players.values()) assert.ok(Number.isFinite(p.gold) && p.gold >= 0, `gold ${p.gold}`);
          for (const bd of sim.boards) {
            assert.ok(bd.lives >= 0 && bd.lives <= G.lives);
            for (const e of bd.en) assert.ok(Number.isFinite(e.x) && Number.isFinite(e.z) && Number.isFinite(e.hp), 'NaN enemy');
            // Board bookkeeping matches the global maps.
            for (const t of bd.tw) assert.equal(sim.towers.get(t.info.id), t);
          }
          for (const e of sim.enemies.values()) assert.ok(sim.boards[e.b].en.includes(e), 'stale enemy in the id map');
        }
      }
      assert.ok(sim.end, `no end after ${ticks} ticks (wave ${sim.wave})`);
      if (mode === 'vs') {
        assert.ok(sim.end.winner);
        const places = sim.boards.map((b: any) => b.place).sort();
        assert.deepEqual(places, Array.from({ length: n }, (_, i) => i + 1));
      }
    });
  }
});

// ---- run ------------------------------------------------------------------------------------------------------------

const filter = process.argv[2];
let pass = 0;
let fail = 0;
const t0 = Date.now();
for (const t of tests) {
  if (filter && !t.name.toLowerCase().includes(filter.toLowerCase())) continue;
  const s = Date.now();
  try {
    t.fn();
    pass++;
    console.log(`  ok    ${t.name} (${Date.now() - s} ms)`);
  } catch (err) {
    fail++;
    console.log(`  FAIL  ${t.name}`);
    console.log('        ' + String((err as Error)?.stack ?? err).split('\n').slice(0, 6).join('\n        '));
  }
}
console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
