// Garden Sentinels game server: wraps the pure simulation (sim.ts) in the room's loop. Simulates at G.tickRate,
// sends a snapshot every G.snapEvery ticks (per client in versus), batches events per tick into one 'ev' message,
// sends deny messages privately, scores every few seconds, and 'end' + host.matchEnded() when the match is decided.
//
// Rules the shared contracts leave open, as implemented here (sim.ts):
// - Waves: a group's `count` is the total, dealt round-robin over the routes when `route` is -1; each route keeps
//   the group's `gap` divided by the co-op count multiplier. Co-op counts are Math.round(count * coopCount(p)) and
//   never apply to the colossus; coopHp / coopCount use the defender count (humans + bots with a board) read at
//   each wave start, never mid-wave. Bounty share uses the defender count at the time of the kill.
// - Skitter spawns (wave groups and sends) are packs of SKITTER_PACK side by side (laterals -0.8..0.8); other
//   enemies get a random lateral in -0.8..0.8 and +-5% speed.
// - Colossus sheds `shed` skitters at 75, 50 and 25% health (three times, not on death); a single hit that crosses
//   several thresholds sheds for each. Shed skitters keep the colossus's health multiplier and sender.
// - Laser: continuous DPS on its target; level 3 chains to `count` further enemies, each the nearest within 3 m of
//   the previous link, for 50% damage. Missile: a volley spreads over distinct targets by the tower's priority
//   (repeats the main target when there are fewer); flight time = distance / 12 m/s (min 0.25 s); lands at the
//   target's then-position (or its last one if it died) and splashes, damage falling to 50% at the edge.
// - Slow: strongest slow applies, nothing stacks; its sting is continuous DPS. Shield: 1 s pulses of `dmg` to
//   every enemy inside ('zap' event); towers whose centre is inside are shielded (a shield covers itself).
// - Beacon: only the strongest beacon covering a tower applies (its dmg, rate and range buffs together); beacons do
//   not buff beacons; buffRange widens the buffed tower's range, not the aura. For continuous towers (laser, slow,
//   shield) "fire rate" multiplies DPS too; missiles fire `interval / (1 + rate)`. Disabled shields and beacons
//   project nothing.
// - Targeting: first = least distance left to the greenhouse, last = most, strong = most health, close = nearest.
// - Disruptor: once its timer runs out it charges 0.6 s (EFlag.charging) while a non-disabled tower is in range,
//   then bolts the closest; stunned disruptors neither move nor fire.
// - Ready: only during the build phase; humans toggle, bots count as ready once they asked or can't afford any tower.
//   The early bonus is G.earlyBonusPerSec x whole seconds skipped, capped at G.betweenWaves seconds, to every defender.
// - Co-op permissions: anyone upgrades or retargets any tower, only the builder sells; the seller gets the refund
//   (G.sellRefund of everything spent on it, or all of it when sold in the same build phase it was built in).
// - Leavers: co-op towers stay (anyone upgrades, nobody sells) and the leaver's gold is split among the defenders;
//   a versus board plays on without a builder until it falls. Joiners: co-op joiners defend with
//   max(start gold, median defender gold), once per name (a rejoin gets start gold); versus joiners spectate.
// - Versus: everyone gets the same base waves at once. Sends queue into the target's next wave (BoardSnap.inc),
//   enter from 4 s in with that wave's waveHp, pay the defender 50% bounty, at most sendCap(n) per player per wave;
//   default target cycles through living opponents. Income (G.baseIncome + sends) is paid at each wave start. Each
//   board gets its clear bonus when it is empty; the next build phase starts when every board is clear or
//   G.vsOvertime s after the wave's last base spawn (leftovers keep walking). A board at 0 lives is out (towers stop,
//   its enemies vanish); if the last boards fall on the same tick, the one with more lives at the start of the tick
//   (then more damage dealt) wins. A versus room needs two players (rooms.ts).

import type { GameClientMsg, GameServerMsg } from '../../shared/protocol.js';
import { G, type GMode, isGMode } from '../../shared/garden/constants.js';
import { GMAPS, type GMapDef, RANDOM_GMAP, gmapById, gmapsFor } from '../../shared/garden/maps.js';
import type { GardenServerMsg } from '../../shared/garden/protocol.js';
import type { GameFactory, GameHost, GamePlayer, GameServer } from '../types.js';
import { createGardenBot } from './bots.js';
import { GardenSim } from './sim.js';

const SCORE_EVERY = 3;
/** Versus: boards a client neither owns nor views come in every Nth snapshot. */
const FAR_EVERY = 4;

/** Map for this match: the chosen one if it fits the mode, else a random map of that mode. */
export function pickGardenMap(mode: GMode, id: string | undefined, rnd: () => number = Math.random): GMapDef {
  const chosen = id && id !== RANDOM_GMAP ? gmapById(id) : undefined;
  if (chosen && chosen.modes.includes(mode)) return chosen;
  const pool = gmapsFor(mode).length ? gmapsFor(mode) : GMAPS;
  if (!pool.length) throw new Error('Garden Sentinels has no maps');
  return pool[Math.floor(rnd() * pool.length)];
}

class GardenGame implements GameServer {
  private sim!: GardenSim;
  private readonly mode: GMode;
  private readonly def: GMapDef;
  private timer?: NodeJS.Timeout;
  private scoreT = 0;
  private snaps = 0;
  private done = false;
  /** Board each human's camera is on (client 'view' message). */
  private readonly views = new Map<string, number>();

  constructor(private readonly host: GameHost) {
    const s = host.settings as unknown as { mode?: unknown; map?: string };
    this.mode = isGMode(s.mode) ? s.mode : 'coop';
    this.def = pickGardenMap(this.mode, s.map);
  }

  private out(m: GardenServerMsg): GameServerMsg {
    return m as unknown as GameServerMsg;
  }

  start() {
    const players = this.host.players().map((p) => ({ id: p.id, name: p.name, bot: p.bot }));
    this.sim = new GardenSim({
      def: this.def,
      mode: this.mode,
      players,
      difficulty: this.host.botDifficulty(),
      seed: (Date.now() ^ 0x6a4d3e11) >>> 0,
      createBot: createGardenBot,
    });
    for (const p of this.host.players()) if (!p.bot) this.host.send(p.id, this.out(this.initMsg(p.id)));
    this.timer = setInterval(() => this.loop(), 1000 / G.tickRate);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  addPlayer(p: GamePlayer) {
    if (!this.sim) return;
    if (!this.sim.players.has(p.id)) this.sim.addPlayer({ id: p.id, name: p.name, bot: p.bot });
    if (!p.bot) this.host.send(p.id, this.out(this.initMsg(p.id)));
    this.host.broadcast(this.out({ k: 'score', scores: this.sim.scores() }));
  }

  removePlayer(id: string) {
    this.views.delete(id);
    if (!this.sim) return;
    this.sim.removePlayer(id);
    this.host.broadcast(this.out({ k: 'score', scores: this.sim.scores() }));
  }

  onMessage(id: string, m: GameClientMsg) {
    if (!this.sim || this.done) return;
    const p = this.sim.players.get(id);
    if (!p || p.bot || !m || typeof m !== 'object') return;
    const msg = m as unknown as { k?: unknown; b?: unknown };
    if (msg.k === 'sync') {
      this.host.send(id, this.out(this.initMsg(id)));
      return;
    }
    if (msg.k === 'view') {
      if (Number.isInteger(msg.b) && (msg.b as number) >= 0 && (msg.b as number) < this.sim.boards.length) this.views.set(id, msg.b as number);
      return;
    }
    this.sim.handle(id, m);
  }

  private initMsg(id: string): GardenServerMsg {
    return {
      k: 'init',
      map: { id: this.def.id, name: this.def.name },
      mode: this.mode,
      boards: this.sim.boardInfo(),
      towers: this.sim.towerInfos(),
      wave: this.sim.wave,
      scores: this.sim.scores(),
      you: id,
      myBoard: this.sim.players.get(id)?.board ?? -1,
      ph: this.sim.phase,
    };
  }

  private loop() {
    if (this.done) return;
    const sim = this.sim;
    try {
      sim.step(1 / G.tickRate);
    } catch (err) {
      console.error('garden sim error', err);
    }
    this.flush();
    if (sim.tick % G.snapEvery === 0 || sim.end) this.sendSnapshots();
    this.scoreT += 1 / G.tickRate;
    if (this.scoreT >= SCORE_EVERY) {
      this.scoreT = 0;
      this.host.broadcast(this.out({ k: 'score', scores: sim.scores() }));
    }
    if (sim.end) this.finish();
  }

  private sendSnapshots() {
    const sim = this.sim;
    const far = this.snaps++ % FAR_EVERY === 0;
    if (sim.boards.length <= 1 || far) {
      this.host.broadcast(this.out({ k: 'snap', s: sim.snapshot() }));
      return;
    }
    for (const gp of this.host.players()) {
      if (gp.bot) continue;
      const include = new Set<number>();
      const own = sim.players.get(gp.id)?.board ?? -1;
      if (own >= 0) include.add(own);
      const view = this.views.get(gp.id);
      if (view !== undefined) include.add(view);
      if (!include.size) include.add(0);
      this.host.send(gp.id, this.out({ k: 'snap', s: sim.snapshot(include) }));
    }
  }

  private flush() {
    const sim = this.sim;
    if (sim.events.length) {
      const e = sim.events;
      sim.events = [];
      this.host.broadcast(this.out({ k: 'ev', e }));
    }
    if (sim.denies.length) {
      for (const d of sim.denies) this.host.send(d.id, this.out({ k: 'ev', e: [{ k: 'deny', id: d.id, why: d.why }] }));
      sim.denies = [];
    }
  }

  private finish() {
    const end = this.sim.end;
    if (!end || this.done) return;
    this.done = true;
    const scores = this.sim.scores();
    this.host.broadcast(this.out({ k: 'end', win: end.win, winner: end.winner, wave: end.wave, scores }));
    if (this.mode === 'coop') {
      this.host.systemChat(end.win ? `The garden held! All ${end.wave} waves defended on ${this.def.name}.` : `The garden fell on wave ${end.wave} in ${this.def.name}.`);
    } else {
      const name = end.winner ? this.host.players().find((p) => p.id === end.winner)?.name : undefined;
      this.host.systemChat(name ? `${name}'s garden is the last one standing (wave ${end.wave}).` : `Every garden fell on wave ${end.wave}.`);
    }
    this.stop();
    this.host.matchEnded();
  }
}

export const createGardenGame: GameFactory = (host: GameHost) => new GardenGame(host);
