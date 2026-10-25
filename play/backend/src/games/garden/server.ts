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
// - Sprinkler: fires like a missile pod (volley over distinct targets, flight = distance / 12 m/s, splash falling to
//   50% at the edge; same 'msl' / 'boom' events, the client picks visuals by tower kind) with its own pierce; every
//   walker its splash reaches is soaked: slowed by `soak` for `soakTime` s (EFlag.soaked). Strongest slow applies:
//   max(slow field, soak), nothing stacks; an equal or stronger soak refreshes the timer, a weaker one is ignored.
//   Soak is not EFlag.slowed (that stays the slow-field flag). Water bombs never touch flyers.
// - Flyers (Glow Moth): spawn on the air route of their ground route (wire route = ground routes + r, round-robin as
//   usual, sends too) and cross it in at least AIR_MIN_TIME (20) s (slower on short air lines). Slow fields, soak,
//   the slow sting, sprinklers and beacons (n/a) ignore them; only TowerDef.air towers target or zap them, over the
//   3D distance from a 1.2 m muzzle up to FLY_HEIGHT (ground enemies keep 2D ranges). Laser chains hop in 3D.
//   Missile blasts burst at the target's height (FLY_HEIGHT when aimed at a flyer) and splash in 3D, so a ground
//   blast only reaches a flyer above it with a big enough splash.
// - Bloomkin: every heal.every s (first pulse heal.every s after it spawns) every living enemy within heal.range m
//   (2D, itself and flyers included) below max health gets pct of its max health (capped at max) and EFlag.healed for
//   1 s; one 'heal' event { en, n, r } per pulse that healed anyone. A heal never undoes colossus shedding.
// - Sunburst ('sun' { x, z }, through the action token bucket): needs a charge, finite numbers and a point inside
//   the player's own board (co-op: the shared board; spectators and eliminated boards cannot). Deals G.sun.base +
//   perWave x max(1, wave) ignoring armour to every enemy whose body is within G.sun.radius (2D, flyers too) on that
//   board, credited to the player (kills pay bounty as usual), 'sun' event first. Charges: G.sun.start each (new
//   joiners too, a rejoin keeps its count); +1 (max G.sun.max) every G.sun.every-th wave cleared: co-op at the clear
//   bonus for every defender, versus when the build phase after that wave starts for each living board's holder.
//   PlayerSnap.sun carries the count. Any phase but 'over'.
// - Targeting: first = least distance left to the greenhouse, last = most, strong = most health, close = nearest.
// - Disruptor: once its timer runs out it charges 0.6 s (EFlag.charging) while a non-disabled tower is in range,
//   then bolts the closest; stunned disruptors neither move nor fire.
// - Ready: during the build phase; humans toggle, bots count as ready once they asked or can't afford any tower.
//   The early bonus is G.earlyBonusPerSec x whole seconds skipped, capped at G.betweenWaves seconds, to every defender.
//   Co-op humans may also ready during a wave: once every human defender is ready, the wave's spawns are done and at
//   most G.overlapLeft enemies are left, the next wave starts over them (not after the last wave); every defender
//   gets that wave's clear bonus now plus G.overlapBonus. Bots never ready during a wave.
// - The first build countdown is paused until every human in the room at the start has sent 'sync' (their client
//   mounted) or left, at most LOAD_CAP s; bots build meanwhile; mid-match joiners don't count. Easy bots wait 8 s
//   before their first build.
// - Co-op waves 3-8 get up to +35% (solo) / +20% (duo) health when the defenders sit on lots of unspent gold
//   at the wave start (coopEarly), tapering off over waves 9-11. Brutes lead
//   their wave (from 2 s in) so a slow straggler doesn't hold a wave open.
// - Co-op permissions: anyone upgrades or retargets any tower, only the builder sells; the seller gets the refund
//   (G.sellRefund of everything spent on it, or all of it when sold in the same build phase it was built in).
// - Leavers: co-op towers stay (anyone upgrades, nobody sells) and the leaver's gold is parked under their
//   lower-case name (not shared out). A versus leaver (human) is parked for VS_RECLAIM (60) s: their board keeps
//   defending and earning (bounties, income, clear bonus) for them; after that it plays on unbuilt until it falls.
//   Joiners: a rejoin under a parked name reclaims everything (board, gold, income, score, towers move to the new
//   id; in versus every human gets a fresh init with the new owner); a new co-op name defends with start gold plus the clear
//   bonuses paid so far (capped at the true median defender gold, never below start gold), at most
//   MAX_COOP_PURSES purses per match (later new names start with 0). New joiners wait in the room for the next match
//   (rooms.ts); only a reconnect from this match comes in mid-match, and in versus rooms.ts seats it over the limit
//   instead of evicting a bot (bots are trimmed after the match). A versus newcomer the sim sees anyway spectates.
// - Flood limits per player: 'sync' at most once per SYNC_EVERY s, 'view' unlimited (cheap), every other action
//   through a token bucket (ACTION_RATE/s, burst ACTION_BURST); excess is dropped silently.
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
/** Seconds between honoured 'sync' requests per player (each answer is a full init). */
const SYNC_EVERY = 2;
/** Action token bucket per player: refill per second and capacity. */
const ACTION_RATE = 12;
const ACTION_BURST = 20;
/** Seconds the first build countdown waits at most for clients to load. */
const LOAD_CAP = 20;

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
  /** Last honoured 'sync' per player (ms). */
  private readonly syncAt = new Map<string, number>();
  /** Action token buckets per player. */
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  /** Versus: owner name per board, so the end message names a winner who has since left. */
  private boardNames: string[] = [];
  /** Humans whose client has not sent its first 'sync' yet (the first build countdown waits for them). */
  private readonly loading = new Set<string>();
  private holdT = 0;
  /** Clock (ms); tests may replace it. */
  now: () => number = () => Date.now();

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
    this.boardNames = this.sim.boards.map((b) => (b.owner ? (players.find((p) => p.id === b.owner)?.name ?? '') : ''));
    for (const p of this.host.players()) if (!p.bot) this.host.send(p.id, this.out(this.initMsg(p.id)));
    // The first build countdown waits until every human's client has mounted (its 'sync'), at most LOAD_CAP s.
    for (const p of this.host.players()) if (!p.bot) this.loading.add(p.id);
    this.sim.hold = this.loading.size > 0;
    this.timer = setInterval(() => this.loop(), 1000 / G.tickRate);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  addPlayer(p: GamePlayer) {
    if (!this.sim) return;
    const known = this.sim.players.has(p.id);
    const sp = this.sim.addPlayer({ id: p.id, name: p.name, bot: p.bot });
    if (!known && this.mode === 'vs' && sp.board >= 0) {
      // A versus rejoin reclaimed its board (new id): everyone needs the new owner, so every human gets a fresh init.
      this.boardNames[sp.board] = p.name;
      for (const gp of this.host.players()) if (!gp.bot) this.host.send(gp.id, this.out(this.initMsg(gp.id)));
    } else if (!p.bot) this.host.send(p.id, this.out(this.initMsg(p.id)));
    this.host.broadcast(this.out({ k: 'score', scores: this.sim.scores() }));
  }

  removePlayer(id: string) {
    this.views.delete(id);
    this.syncAt.delete(id);
    this.buckets.delete(id);
    this.loaded(id);
    if (!this.sim) return;
    this.sim.removePlayer(id);
    this.host.broadcast(this.out({ k: 'score', scores: this.sim.scores() }));
  }

  onMessage(id: string, m: GameClientMsg) {
    if (!this.sim || this.done) return;
    const p = this.sim.players.get(id);
    if (!p || p.bot || !m || typeof m !== 'object') return;
    const msg = m as unknown as { k?: unknown; b?: unknown };
    const now = this.now();
    if (msg.k === 'sync') {
      this.loaded(id);
      const last = this.syncAt.get(id);
      if (last !== undefined && now - last < SYNC_EVERY * 1000) return;
      this.syncAt.set(id, now);
      this.host.send(id, this.out(this.initMsg(id)));
      return;
    }
    if (msg.k === 'view') {
      if (Number.isInteger(msg.b) && (msg.b as number) >= 0 && (msg.b as number) < this.sim.boards.length) this.views.set(id, msg.b as number);
      return;
    }
    let bk = this.buckets.get(id);
    if (!bk) this.buckets.set(id, (bk = { tokens: ACTION_BURST, at: now }));
    bk.tokens = Math.min(ACTION_BURST, bk.tokens + ((now - bk.at) / 1000) * ACTION_RATE);
    bk.at = now;
    if (bk.tokens < 1) return;
    bk.tokens -= 1;
    this.sim.handle(id, m);
  }

  /** A human finished loading (or left): release the first countdown once nobody is loading. */
  private loaded(id: string) {
    if (!this.loading.delete(id) || !this.sim) return;
    if (!this.loading.size) this.sim.hold = false;
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
    if (sim.hold && (this.holdT += 1 / G.tickRate) >= LOAD_CAP) {
      sim.hold = false;
      this.loading.clear();
    }
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
      // Per client (not broadcast) so the room's backpressure drop for slow sockets applies.
      const msg = this.out({ k: 'snap', s: sim.snapshot() });
      for (const gp of this.host.players()) if (!gp.bot) this.host.send(gp.id, msg);
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
      const b = end.winner ? this.sim.boards.findIndex((bd) => bd.owner === end.winner) : -1;
      const name = end.winner ? this.host.players().find((p) => p.id === end.winner)?.name || this.boardNames[b] || 'The winner' : undefined;
      this.host.systemChat(name ? `${name}'s garden is the last one standing (wave ${end.wave}).` : `Every garden fell on wave ${end.wave}.`);
    }
    this.stop();
    this.host.matchEnded();
  }
}

export const createGardenGame: GameFactory = (host: GameHost) => new GardenGame(host);
