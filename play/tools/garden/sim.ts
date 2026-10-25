// Garden Sentinels headless balance tool: plays whole matches with bots at full speed (no networking) and prints
// per-wave lives, gold, kills, leaks and tower counts, then the final wave reached.
//
//   node24 backend/node_modules/tsx/dist/cli.mjs tools/garden/sim.ts [--mode coop|vs] [--bots 3] [--diff normal]
//        [--map <id>] [--runs 3] [--seed 1] [--fallback] [--quiet] [--bytes] [--leaks] [--sweep [--only coop|vs]]
//
// --bytes measures snapshot and event sizes at the busiest moment of each run.
//
// --sweep runs co-op with 1, 3 and 6 bots plus versus with 2, 4 and 6 bots and prints one summary line per run.

import { G, type GMode } from '../../backend/src/shared/garden/constants.js';
import { GMAPS, type GMapDef, gmapById, gmapsFor } from '../../backend/src/shared/garden/maps.js';
import type { BotDifficulty } from '../../backend/src/shared/protocol.js';
import { createGardenBot } from '../../backend/src/games/garden/bots.js';
import { GardenSim, fallbackGardenBot } from '../../backend/src/games/garden/sim.js';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name: string) => args.includes(`--${name}`);
const measure = flag('bytes');

/** A stand-in map so the tool runs before the real maps exist: a path drawn from the route polylines. */
function testMap(mode: GMode): GMapDef {
  const W = mode === 'coop' ? 30 : 20;
  const H = mode === 'coop' ? 22 : 14;
  const routes: GMapDef['routes'] =
    mode === 'coop'
      ? [
          { entry: 0, half: 1, pts: [[3, 2], [3, 8], [12, 8], [12, 3], [20, 3], [20, 11], [15, 11]] },
          { entry: 1, half: 1, pts: [[27, 20], [22, 20], [22, 15], [15, 15], [15, 11]] },
        ]
      : [{ entry: 0, half: 1, pts: [[2, 2], [2, 7], [8, 7], [8, 3], [14, 3], [14, 10], [10, 10]] }];
  const g = Array.from({ length: H }, () => Array.from({ length: W }, () => '.'));
  for (const r of routes)
    for (let i = 1; i < r.pts.length; i++) {
      const [x0, y0] = r.pts[i - 1];
      const [x1, y1] = r.pts[i];
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 4;
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const y = y0 + ((y1 - y0) * k) / n;
        for (const dx of [-1, 0])
          for (const dy of [-1, 0]) {
            const c = Math.floor(x + dx + 0.001);
            const rr = Math.floor(y + dy + 0.001);
            if (g[rr]?.[c]) g[rr][c] = '#';
          }
      }
    }
  return {
    id: `test-${mode}`,
    name: `Test ${mode}`,
    blurb: '',
    modes: [mode],
    grid: g.map((r) => r.join('')),
    entries: routes.map((r) => ({ x: r.pts[0][0], y: r.pts[0][1], facing: 0 })),
    goal: { x: 15, y: 11 },
    routes,
  };
}

function mapsFor(mode: GMode, id: string): GMapDef[] {
  if (id !== 'all' && id !== 'random') {
    const m = gmapById(id);
    if (!m) throw new Error(`no map ${id}; have: ${GMAPS.map((x) => x.id).join(', ')}`);
    return [m];
  }
  const pool = gmapsFor(mode);
  if (!pool.length) {
    console.log(`(no ${mode} maps in GMAPS yet: using a generated test map)`);
    return [testMap(mode)];
  }
  return pool;
}

interface RunResult {
  map: string;
  wave: number;
  win: boolean;
  winner: string | null;
  lives: number;
  leaks: number;
  minutes: number;
  places: string;
}

function run(mode: GMode, bots: number, diff: BotDifficulty, def: GMapDef, seed: number, quiet: boolean): RunResult {
  const players = Array.from({ length: bots }, (_, i) => ({ id: `bot${i + 1}`, name: `Bot ${i + 1}`, bot: true }));
  const sim = new GardenSim({ def, mode, players, difficulty: diff, seed, createBot: flag('fallback') ? fallbackGardenBot : createGardenBot });
  const dt = 1 / G.tickRate;
  let waveKills = 0;
  let waveLeaks = 0;
  const waveLeaksByBoard = new Map<number, number>();
  /** Kind per live enemy id (from 'spawn' events), for --leaks. */
  const leakKinds = new Map<number, string>();
  let sends = 0;
  let totalLeaks = 0;
  const t0 = performance.now();
  const snapStat = { maxAlive: 0, full: 0, own: 0, maxEv: 0 };
  if (!quiet)
    console.log(`\n== ${mode} ${bots} x ${diff} on ${def.name} (seed ${seed}) ==\nwave  time  lives            gold(avg)  kills  leaks  towers(lv)       sends`);
  const maxTicks = G.tickRate * 60 * 120;
  while (!sim.end && sim.tick < maxTicks) {
    sim.step(dt);
    if (measure && sim.tick % G.snapEvery === 0) {
      // Bytes per snapshot as the server sends them: the full one (co-op, and every 4th in versus) and a versus
      // client's own board only. Measured at the busiest moment (most enemies alive).
      const alive = sim.boards.reduce((n, b) => n + b.en.length, 0);
      if (alive >= snapStat.maxAlive) {
        snapStat.maxAlive = alive;
        snapStat.full = JSON.stringify({ t: 'g', m: { k: 'snap', s: sim.snapshot() } }).length;
        snapStat.own = sim.boards.length > 1 ? JSON.stringify({ t: 'g', m: { k: 'snap', s: sim.snapshot(new Set([0])) } }).length : snapStat.full;
      }
      const evBytes = JSON.stringify({ t: 'g', m: { k: 'ev', e: sim.events } }).length;
      if (evBytes > snapStat.maxEv) snapStat.maxEv = evBytes;
    }
    for (const e of sim.events) {
      if (e.k === 'spawn') leakKinds.set(e.en, e.kind);
      if (e.k === 'die') {
        waveKills++;
        leakKinds.delete(e.en);
      }
      else if (e.k === 'leak') {
        waveLeaks++;
        totalLeaks++;
        waveLeaksByBoard.set(e.b, (waveLeaksByBoard.get(e.b) ?? 0) + 1);
        if (flag('leaks')) {
          const en = (e as { en: number }).en;
          console.log(`      leak on board ${e.b}: ${leakKinds.get(en) ?? '?'}${e.from ? ` (sent by ${e.from})` : ''}, lives ${e.lives}`);
        }
      } else if (e.k === 'send') sends += e.n;
      else if (e.k === 'out' && !quiet) console.log(`      board ${e.b} out (place ${e.place}) on wave ${sim.wave}`);
      else if ((e.k === 'clear' && e.b === undefined) || (e.k === 'wave' && mode === 'vs' && e.n > 1)) {
        // Co-op: one row per cleared wave. Versus: one row per wave start (boards clear one by one).
        if (!quiet) {
          const ps = [...sim.players.values()];
          const gold = Math.round(ps.reduce((s, p) => s + p.gold, 0) / Math.max(1, ps.length));
          const tw = sim.towerInfos();
          const lv = [0, 0, 0];
          for (const t of tw) lv[t.lv - 1]++;
          const lives = sim.boards.map((b) => (b.out ? 'x' : String(b.lives))).join('/');
          console.log(
            `${String(e.k === 'wave' ? e.n - 1 : sim.wave).padStart(4)}  ${(sim.time / 60).toFixed(1).padStart(4)}m  ${lives.padEnd(16)} ${String(gold).padStart(6)}  ${String(waveKills).padStart(6)}  ${String(waveLeaks).padStart(5)}  ${`${tw.length} (${lv.join('/')})`.padEnd(16)} ${sends}`,
          );
          waveKills = 0;
          waveLeaks = 0;
          sends = 0;
          waveLeaksByBoard.clear();
        }
      }
    }
    sim.events = [];
    sim.denies = [];
  }
  const ms = performance.now() - t0;
  const end = sim.end ?? { win: false, winner: null, wave: sim.wave };
  const places = sim
    .scores()
    .sort((a, b) => (a.place ?? 99) - (b.place ?? 99))
    .map((s) => `${s.id}:${s.place ?? '-'}`)
    .join(' ');
  if (!quiet) {
    console.log(
      `-> ${mode === 'coop' ? (end.win ? 'VICTORY' : 'DEFEAT') : `winner ${end.winner}`} on wave ${end.wave}, ${(sim.time / 60).toFixed(1)} game min, ${totalLeaks} leaks, ${sim.stats.spawned} spawned (${(ms / 1000).toFixed(1)} s real, ${((sim.time * 1000) / ms).toFixed(0)}x)`,
    );
    if (mode === 'vs') console.log(`   places: ${places}`);
  }
  if (measure) {
    const perSec = mode === 'vs' ? ((snapStat.own * 3 + snapStat.full) / 4) * (G.tickRate / G.snapEvery) : snapStat.full * (G.tickRate / G.snapEvery);
    console.log(
      `   snapshot at peak (${snapStat.maxAlive} enemies alive): full ${(snapStat.full / 1024).toFixed(1)} KB, own board ${(snapStat.own / 1024).toFixed(1)} KB, ~${(perSec / 1024).toFixed(0)} KB/s per client; biggest event batch ${(snapStat.maxEv / 1024).toFixed(1)} KB`,
    );
  }
  return { map: def.id, wave: end.wave, win: end.win, winner: end.winner, lives: sim.boards[0].lives, leaks: totalLeaks, minutes: sim.time / 60, places };
}

function summary(mode: GMode, bots: number, def: GMapDef, seed: number, res: RunResult) {
  console.log(
    `${mode.padEnd(4)} ${bots} bots ${def.id.padEnd(18)} seed ${seed}: ${mode === 'coop' ? (res.win ? 'WIN ' : 'LOSS') : 'END '} wave ${String(res.wave).padStart(2)}  lives ${String(res.lives).padStart(2)}  leaks ${String(res.leaks).padStart(3)}  ${res.minutes.toFixed(1)} min${mode === 'vs' ? `  ${res.places}` : ''}`,
  );
}

const diff = opt('diff', 'normal') as BotDifficulty;
const runs = Number(opt('runs', '1'));
const seed0 = Number(opt('seed', '1'));
const mapId = opt('map', 'all');

if (flag('sweep')) {
  const only = opt('only', '');
  const cases = (
    [
      ['coop', 1],
      ['coop', 3],
      ['coop', 6],
      ['vs', 2],
      ['vs', 4],
      ['vs', 6],
    ] as [GMode, number][]
  ).filter(([m]) => !only || m === only);
  for (const [mode, bots] of cases)
    for (const def of mapsFor(mode, mapId))
      for (let r = 0; r < runs; r++) {
        summary(mode, bots, def, seed0 + r, run(mode, bots, diff, def, seed0 + r, true));
      }
} else {
  const mode = (opt('mode', 'coop') === 'vs' ? 'vs' : 'coop') as GMode;
  const bots = Number(opt('bots', mode === 'vs' ? '4' : '3'));
  for (const def of mapsFor(mode, mapId))
    for (let r = 0; r < runs; r++) {
      const res = run(mode, bots, diff, def, seed0 + r, flag('quiet'));
      if (flag('quiet')) summary(mode, bots, def, seed0 + r, res);
    }
}
