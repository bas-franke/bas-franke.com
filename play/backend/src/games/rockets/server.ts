// Rockets: authoritative arena simulation. Humans send input commands that each advance their body by one fixed
// step; bots think every step; rockets fly in sub-steps of the 30 Hz loop; one snapshot per loop goes to everyone.

import {
  clamp,
  expandAABB,
  hdist,
  lookDir,
  rng as makeRng,
  segmentAABB,
  segmentBoxes,
  toTuple,
  type Vec3,
  type Vec3Tuple,
  v3,
  vadd,
  vdist,
  vscale,
  vsub,
} from '../../shared/math.js';
import { RK } from '../../shared/rockets/constants.js';
import { ITEM, type ItemSpawn, itemRespawn, itemsFor } from '../../shared/rockets/items.js';
import type { MapData } from '../../shared/rockets/map.js';
import { MAPS, mapById } from '../../shared/rockets/maps.js';
import { CTF, ELIM, MODES, type ModeRules, TEAMS, sideOf, teamBases } from '../../shared/rockets/modes.js';
import { type Body, eyePosition, playerAABB, splashKnock, stepBody } from '../../shared/rockets/physics.js';
import type {
  FlagSnap,
  PlayerSnap,
  RocketSnap,
  RocketsEvent,
  RocketsInput,
  RocketsServerMsg,
  RoundSnap,
  ScoreRow,
} from '../../shared/rockets/protocol.js';
import type { GameClientMsg, GameMode, Team } from '../../shared/protocol.js';
import type { GameHost, GamePlayer, GameServer } from '../types.js';
import { BOT_PARAMS, RocketsBot, type BotEnemy } from './bots.js';
import { type NavGraph, navGraphFor } from './nav.js';

interface RPlayer extends GamePlayer {
  body: Body;
  yaw: number;
  pitch: number;
  hp: number;
  /** Soaks part of every hit; see absorb(). Cleared on death. */
  armor: number;
  dead: boolean;
  respawnAt: number;
  protectedUntil: number;
  lastSeq: number;
  /** Highest seq accepted into the queue: rejects replays, reordering and absurd jumps. */
  lastQueued: number;
  /** Commands this player may still apply, earned at one per simulation step (anti speed-hack). */
  credit: number;
  nextFire: number;
  /** First command seq a human may fire on again (reload counted in commands, as the client does). */
  fireSeq: number;
  queue: RocketsInput[];
  lastInputAt: number;
  frags: number;
  deaths: number;
  /** CTF captures. */
  caps: number;
  brain?: RocketsBot;
  shots: number;
  /** Who last hurt this player and when, so a knock into the void still credits the shooter. */
  lastHitBy?: string;
  lastHitAt?: number;
  /** The pack and item lists last sent to this player; snapshots only carry them when they change. */
  sentPk?: string;
  sentIt?: string;
}

/** Snapshot rounding: 1 cm positions, 0.1 m/s velocities, 0.01 rad angles. Plenty for interpolation. */
const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const cm = (a: Vec3): Vec3Tuple => [r2(a.x), r2(a.y), r2(a.z)];
const dm = (a: Vec3): Vec3Tuple => [r1(a.x), r1(a.y), r1(a.z)];

interface Rocket {
  id: string;
  owner: string;
  pos: Vec3;
  vel: Vec3;
  born: number;
}

/** A CTF flag. Index in `flags` = the team it belongs to. */
interface Flag {
  state: 0 | 1 | 2;
  pos: Vec3;
  carrier?: string;
  /** Dropped flags go home by themselves at this time. */
  returnAt: number;
}

/** Spawn score penalty for a point on the enemy half (team modes): far bigger than any distance bonus. */
const WRONG_SIDE = 60;
/** CTF spawn score lost per metre from your own base. */
const BASE_PULL = 0.25;

const IDLE: Omit<RocketsInput, 'seq' | 'yaw' | 'pitch'> = { f: 0, s: 0, jump: false, fire: false };
/** Seconds without commands before the server moves a player on its own (gravity, friction). */
const IDLE_AFTER = 0.3;
/** Reload and post-spawn delay in commands (one command = one RK.dt step); the client uses the same numbers. */
const FIRE_STEPS = Math.round(RK.fireInterval / RK.dt);
const SPAWN_FIRE_STEPS = Math.round(0.3 / RK.dt);

// Build every map's nav graph once at boot, so the first match on a map does not stall the event loop.
for (const m of MAPS) navGraphFor(m);

/** The last map each room played, so 'random' never repeats a map twice in a row. */
const lastMap = new WeakMap<GameHost, string>();

function pickMap(host: GameHost, rng: () => number): MapData {
  const chosen = mapById(host.settings.map);
  if (chosen) return chosen;
  const pool = MAPS.filter((m) => m.id !== lastMap.get(host));
  return pool[Math.floor(rng() * pool.length)];
}

class RocketsGame implements GameServer {
  private readonly rng = makeRng((Date.now() ^ 0x9e3779b9) >>> 0);
  private readonly map: MapData;
  private readonly players = new Map<string, RPlayer>();
  private rockets: Rocket[] = [];
  private readonly packs: { available: boolean; respawnAt: number }[];
  private readonly items: ItemSpawn[];
  private readonly itemState: { available: boolean; respawnAt: number }[];
  /** When overheal (health or armor above ITEM.overhealFloor) next ticks down a point. */
  private nextDecay = 1;
  private events: RocketsEvent[] = [];
  private now = 0;
  private tick = 0;
  private ended = false;
  private timer?: NodeJS.Timeout;
  private readonly graph: NavGraph;
  private readonly mode: GameMode;
  private readonly rules: ModeRules;
  /** Team modes: [red, blue] base positions (CTF flags stand here). */
  private readonly bases?: [Vec3, Vec3];
  /** Team modes: frags (tdm), captures (ctf) or round wins (elim) per team. */
  private readonly teamScore: [number, number] = [0, 0];
  /** CTF only. */
  private readonly flags?: [Flag, Flag];
  /** Elimination round state; round 1 starts when the countdown ends. */
  private readonly round: { n: number; state: 'play' | 'over'; endsAt: number; nextAt: number };

  constructor(private readonly host: GameHost) {
    this.map = pickMap(host, this.rng);
    lastMap.set(host, this.map.id);
    this.mode = host.settings.mode in MODES ? host.settings.mode : 'ffa';
    this.round = { n: 1, state: 'play', endsAt: RocketsGame.COUNTDOWN + ELIM.roundSeconds, nextAt: 0 };
    this.rules = MODES[this.mode];
    // Elimination has no pickups at all: everyone starts each round with the same health and armor.
    const pickups = this.mode !== 'elim';
    this.packs = this.map.packs.map(() => ({ available: pickups, respawnAt: 0 }));
    this.items = itemsFor(this.map.id);
    // Quake rule: the big items are not there at the start, so nobody spawns next to a free mega health.
    this.itemState = this.items.map((it) => ({
      available: pickups && it.k === 'shard',
      respawnAt: !pickups ? Infinity : it.k === 'shard' ? 0 : itemRespawn(it.k) / 2,
    }));
    if (!pickups) for (const pack of this.packs) pack.respawnAt = Infinity;
    this.graph = navGraphFor(this.map);
    if (this.rules.teams) this.bases = teamBases(this.map);
    if (this.mode === 'ctf' && this.bases) {
      this.flags = [
        { state: 0, pos: { ...this.bases[0] }, returnAt: 0 },
        { state: 0, pos: { ...this.bases[1] }, returnAt: 0 },
      ];
    }
  }

  private get teams() {
    return this.rules.teams;
  }

  private isElim() {
    return this.mode === 'elim';
  }

  /** Two different players on the same team (team modes): no damage and no knockback between them. */
  private friendly(a: RPlayer | null, b: RPlayer) {
    return !!a && a !== b && this.teams && a.team !== undefined && a.team === b.team;
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------

  start() {
    this.host.systemChat(`Map: ${this.map.name} · fight in ${RocketsGame.COUNTDOWN} seconds`);
    for (const p of this.host.players()) this.addPlayer(p);
    // Everyone appears straight away, one after the other so each spawn sees the ones already placed, and stands
    // frozen through the countdown: the match starts with nobody spawning on top of or in front of anybody else.
    for (const p of this.players.values()) this.spawn(p);
    this.nextLoopAt = performance.now();
    this.schedule();
  }

  private nextLoopAt = 0;

  /**
   * Self-correcting timer: each loop is aimed at its slot on a fixed 30 Hz grid, so late timers (Windows rounds them
   * to its 15.6 ms tick, giving 31/47 ms with setInterval) are made up on the next one instead of piling up.
   */
  private schedule() {
    const period = 1000 / RK.loopHz;
    this.nextLoopAt += period;
    const now = performance.now();
    // Far behind (a long GC or a suspended laptop): start the grid again rather than firing a burst of loops.
    if (this.nextLoopAt < now - period) this.nextLoopAt = now;
    this.timer = setTimeout(() => {
      try {
        this.loop();
      } catch (err) {
        // One bad room must never take down every other room on the server.
        console.error('rockets loop failed', err);
      }
      if (this.timer) this.schedule();
    }, Math.max(0, this.nextLoopAt - now));
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  addPlayer(p: GamePlayer) {
    if (this.players.has(p.id)) return;
    const player: RPlayer = {
      ...p,
      body: { pos: v3(0, 50, 0), vel: v3(), onGround: false },
      yaw: 0,
      pitch: 0,
      hp: 0,
      armor: 0,
      dead: true,
      respawnAt: this.now + 0.3,
      protectedUntil: 0,
      lastSeq: 0,
      lastQueued: 0,
      credit: 2,
      nextFire: 0,
      fireSeq: 0,
      queue: [],
      lastInputAt: this.now,
      frags: 0,
      deaths: 0,
      caps: 0,
      shots: 0,
    };
    if (this.teams) {
      // The room always assigns a team; this only guards against a player arriving without one.
      if (player.team !== 0 && player.team !== 1) player.team = this.teamSize(0) <= this.teamSize(1) ? 0 : 1;
    } else delete player.team;
    // Elimination: whoever joins after the countdown spectates until the next round.
    if (this.isElim() && !this.frozen()) player.respawnAt = Infinity;
    if (p.bot) player.brain = new RocketsBot(BOT_PARAMS[this.host.botDifficulty()], this.graph, makeRng(Math.floor(this.rng() * 1e9)));
    this.players.set(p.id, player);
    this.host.send(p.id, {
      k: 'init',
      map: this.map,
      mode: this.mode,
      items: this.items,
      scores: this.scores(),
      left: this.timeLeft(),
      ...(this.bases ? { bases: [toTuple(this.bases[0]), toTuple(this.bases[1])] as [Vec3Tuple, Vec3Tuple] } : {}),
    });
    this.host.broadcast({ k: 'score', scores: this.scores() });
  }

  removePlayer(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    this.dropFlag(p);
    this.players.delete(id);
    // A departed player's rockets would otherwise kill with no owner, which counts as a suicide for the victim.
    this.rockets = this.rockets.filter((r) => r.owner !== id);
    this.host.broadcast({ k: 'score', scores: this.scores() });
  }

  /**
   * A player changed team mid-match: they die on the spot without penalty (no frag lost, no death counted), drop a
   * carried flag, lose their rockets in flight, and respawn for the new team (elimination: at the next round).
   */
  setTeam(id: string, team: Team) {
    const p = this.players.get(id);
    if (!p || !this.teams || (team !== 0 && team !== 1) || p.team === team) return;
    this.dropFlag(p);
    this.rockets = this.rockets.filter((r) => r.owner !== id);
    p.team = team;
    p.lastHitBy = undefined;
    if (!p.dead) {
      p.dead = true;
      p.hp = 0;
      p.armor = 0;
    }
    p.respawnAt = this.isElim() && !this.frozen() ? Infinity : this.now + 1;
    this.events.push({ k: 'team', id, team });
    this.host.broadcast({ k: 'score', scores: this.scores() });
  }

  private teamSize(team: Team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  onMessage(id: string, m: GameClientMsg) {
    const p = this.players.get(id);
    if (!p || p.bot || m.k !== 'in' || !Array.isArray(m.i)) return;
    for (const raw of m.i as Partial<RocketsInput>[]) {
      if (!raw || typeof raw !== 'object') continue;
      const seq = Math.floor(Number(raw.seq));
      if (!Number.isSafeInteger(seq) || seq <= p.lastQueued || seq > p.lastQueued + 120) continue;
      if (p.queue.length >= 30) break;
      p.lastQueued = seq;
      const input: RocketsInput = {
        seq,
        f: clamp(Number(raw.f) || 0, -1, 1),
        s: clamp(Number(raw.s) || 0, -1, 1),
        jump: !!raw.jump,
        fire: !!raw.fire,
        yaw: typeof raw.yaw === 'number' && Number.isFinite(raw.yaw) ? raw.yaw : p.yaw,
        pitch: clamp(Number(raw.pitch) || 0, -RK.maxPitch, RK.maxPitch),
      };
      p.queue.push(input);
    }
  }

  // ---- main loop ----------------------------------------------------------------------------------------------

  private lastLoop = performance.now();
  private acc = 0;

  /** Advances the simulation by however much wall-clock time passed (timers are not exact), in fixed sub-steps. */
  private loop() {
    if (this.ended) return;
    const nowMs = performance.now();
    this.acc += Math.min(0.25, (nowMs - this.lastLoop) / 1000);
    this.lastLoop = nowMs;
    let substeps = 0;
    while (this.acc >= RK.dt - 1e-9 && substeps < 10 && !this.ended) {
      this.acc -= RK.dt;
      substeps++;
      this.now += RK.dt;
      this.tick++;
      const frozen = this.frozen();
      for (const p of this.players.values()) {
        if (p.dead && this.now >= p.respawnAt) this.spawn(p);
        if (p.brain) {
          const cmd = p.brain.think(this.botView(p));
          this.applyInput(p, frozen ? this.holdStill(cmd) : cmd);
        }
      }
      this.stepRockets(RK.dt, null);
      this.updatePacks();
      this.updateFlags();
    }
    if (substeps === 0 || this.ended) return;
    const frozen = this.frozen();
    for (const p of this.players.values()) {
      if (p.brain) continue;
      let n = 0;
      // One command per simulated step plus a little slack for network jitter, capped so nobody banks speed. While the
      // queue is empty (a stalled uplink) credit keeps building up to the idle limit, so the commands stuck behind the
      // stall catch up at once instead of adding latency for seconds.
      const cap = p.queue.length ? RK.maxCommandsPerLoop + 2 : IDLE_AFTER / RK.dt;
      p.credit = Math.min(p.credit + substeps * 1.15, Math.max(cap, p.credit));
      while (p.queue.length && p.credit >= 1) {
        p.credit--;
        const cmd = p.queue.shift()!;
        // During the countdown the command still counts (look around, seq acknowledged) but nobody moves or fires.
        this.applyInput(p, frozen ? this.holdStill(cmd) : cmd);
        p.lastInputAt = this.now;
        n++;
      }
      // Nobody at the keyboard (or a stalled connection): keep gravity honest.
      // Not sooner: every fabricated step is one the client never predicted, so a jittery uplink would mispredict.
      if (n === 0 && this.now - p.lastInputAt > IDLE_AFTER) {
        for (let i = 0; i < substeps; i++) this.applyInput(p, { ...IDLE, seq: p.lastSeq, yaw: p.yaw, pitch: p.pitch }, true);
      }
    }
    this.updateMatchFlow();
    if (this.ended) return;
    this.flush();
  }

  private applyInput(p: RPlayer, input: RocketsInput, idle = false) {
    p.yaw = input.yaw;
    p.pitch = input.pitch;
    if (!idle) p.lastSeq = input.seq;
    // A human's own rockets fly in that player's command time, one step per command like their body, so the client
    // predicts exactly when they hit and its rocket jumps (the self knockback) land on the same command.
    if (!p.bot) this.stepRockets(RK.dt, p);
    if (p.dead) return;

    const result = stepBody(p.body, input, this.map);
    if (result.pad >= 0) this.events.push({ k: 'pad', id: p.id });
    if (p.body.pos.y < this.map.killY) {
      this.kill(p, null);
      return;
    }
    this.tryPickup(p);
    // Humans reload in commands (the client counts the same), so a burst of queued commands fires on the same one.
    if (input.fire && (p.bot ? this.now >= p.nextFire : input.seq >= p.fireSeq)) this.fire(p, input.seq);
  }

  // ---- rockets ------------------------------------------------------------------------------------------------

  private fire(p: RPlayer, seq: number) {
    p.nextFire = this.now + RK.fireInterval;
    p.fireSeq = seq + FIRE_STEPS;
    // Shooting ends spawn protection: nobody gets to attack while invulnerable.
    p.protectedUntil = Math.min(p.protectedUntil, this.now);
    p.shots++;
    const dir = lookDir(p.yaw, p.pitch);
    const eye = eyePosition(p.body.pos);
    let origin = vadd(eye, vscale(dir, RK.muzzleOffset));
    if (segmentBoxes(eye, origin, this.map.boxes)) origin = vadd(eye, vscale(dir, 0.05));
    const rocket: Rocket = { id: `${p.id}:${p.bot ? p.shots : seq}`, owner: p.id, pos: origin, vel: vscale(dir, RK.rocketSpeed), born: this.now };
    this.rockets.push(rocket);
    this.events.push({ k: 'fire', id: rocket.id, o: p.id, p: toTuple(rocket.pos), v: toTuple(rocket.vel) });
  }

  /** Steps the rockets of `owner` (a human, from applyInput), or with null every rocket not owned by a human. */
  private stepRockets(dt: number, owner: RPlayer | null) {
    const keep: Rocket[] = [];
    for (const r of this.rockets) {
      const by = this.players.get(r.owner);
      const step = owner ? by === owner : !by || !!by.bot;
      if (!step) {
        keep.push(r);
        continue;
      }
      const from = r.pos;
      const to = vadd(r.pos, vscale(r.vel, dt));
      const mapHit = segmentBoxes(from, to, this.map.boxes);
      let t = mapHit ? mapHit.t : 1;
      let victim: RPlayer | null = null;
      for (const p of this.players.values()) {
        if (p.dead || p.id === r.owner) continue;
        const hit = segmentAABB(from, to, expandAABB(playerAABB(p.body.pos), RK.rocketRadius));
        if (hit && hit.t < t) {
          t = hit.t;
          victim = p;
        }
      }
      if (victim || mapHit) {
        let at = vadd(from, vscale(vsub(to, from), t));
        if (!victim && mapHit) at = vadd(at, vscale(mapHit.normal, 0.05));
        this.explode(r, at, victim);
        continue;
      }
      if (this.now - r.born > RK.rocketLife) {
        this.explode(r, to, null);
        continue;
      }
      r.pos = to;
      keep.push(r);
    }
    this.rockets = keep;
  }

  private explode(r: Rocket, at: Vec3, direct: RPlayer | null) {
    this.events.push({ k: 'boom', id: r.id, p: toTuple(at) });
    const owner = this.players.get(r.owner) ?? null;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      // Shared with the client, which predicts its own rocket jumps with the same numbers.
      const knock = splashKnock(at, p.body.pos, this.map.boxes, p === direct);
      if (!knock) continue;
      const self = owner === p;
      if (!self && this.now < p.protectedUntil) continue; // spawn protection: no damage and no knockback
      if (this.friendly(owner, p)) continue; // no friendly fire: teammates feel nothing, not even the push
      let dmg = p === direct ? (this.isAirshot(p) ? RK.airshotDamage : RK.directDamage) : RK.splashDamage * knock.falloff;
      if (self) dmg *= RK.selfDamageScale;

      const scale = self ? RK.selfKnockbackScale : 1;
      p.body.vel.x += knock.x * scale;
      p.body.vel.y += knock.y * scale;
      p.body.vel.z += knock.z * scale;
      if (knock.y > 0) p.body.onGround = false;

      this.damage(p, Math.round(dmg), owner);
    }
  }

  /** A direct hit on a player clearly off the ground (not just mid-hop) is an airshot. */
  private isAirshot(p: RPlayer) {
    if (p.body.onGround) return false;
    const feet = p.body.pos;
    return !segmentBoxes(feet, v3(feet.x, feet.y - RK.airshotHeight, feet.z), this.map.boxes);
  }

  private damage(p: RPlayer, dmg: number, by: RPlayer | null) {
    if (dmg <= 0 || p.dead) return;
    if (this.now < p.protectedUntil && by !== p) return;
    if (this.friendly(by, p)) return;
    // Elimination intermission: the round is decided, so nobody can die until the next one.
    if (this.isElim() && this.round.state === 'over') return;
    p.hp -= this.absorb(p, dmg);
    if (by && by !== p) {
      p.lastHitBy = by.id;
      p.lastHitAt = this.now;
    }
    this.events.push({ k: 'hurt', id: p.id, dmg, by: by?.id ?? '' });
    if (p.hp <= 0) this.kill(p, by);
  }

  private kill(victim: RPlayer, killedBy: RPlayer | null) {
    // After the deciding frag nothing else counts (two kills in one tick would otherwise score after the end).
    if (victim.dead || this.ended) return;
    // Falling into the void soon after someone's rocket is their frag, not a suicide.
    let killer = killedBy ?? this.recentAttacker(victim);
    // A teammate (who could only have pushed you before switching sides) never scores off you.
    if (killer && this.friendly(killer, victim)) killer = null;
    const intermission = this.isElim() && this.round.state === 'over';
    victim.lastHitBy = undefined;
    victim.dead = true;
    victim.hp = 0;
    victim.respawnAt = this.isElim() ? Infinity : this.now + RK.respawnDelay;
    this.dropFlag(victim);
    const self = !killer || killer === victim;
    if (intermission) {
      // A fall during the pause between rounds: out until the next round, but nothing scores.
      this.events.push({ k: 'kill', v: victim.id, by: '', self: true });
      return;
    }
    victim.deaths++;
    if (self) victim.frags--;
    else killer!.frags++;
    // Team deathmatch keeps a team tally: a frag for the killer's team, a suicide costs the victim's team one.
    if (this.mode === 'tdm') {
      if (!self && killer!.team !== undefined) this.teamScore[killer!.team]++;
      else if (self && victim.team !== undefined) this.teamScore[victim.team]--;
    }
    this.events.push({ k: 'kill', v: victim.id, by: killer?.id ?? '', self });
    this.host.broadcast({ k: 'score', scores: this.scores() });
    if (self || !killer) return;
    if (this.mode === 'ffa' && killer.frags >= this.rules.limit) this.endMatch();
    if (this.mode === 'tdm' && killer.team !== undefined && this.teamScore[killer.team] >= this.rules.limit) this.endMatch();
  }

  /** The player who hurt `p` within the last few seconds, if they are still in the game. */
  private recentAttacker(p: RPlayer): RPlayer | null {
    if (!p.lastHitBy || this.now - (p.lastHitAt ?? 0) > RK.fallCreditSeconds) return null;
    return this.players.get(p.lastHitBy) ?? null;
  }

  /**
   * Picks the fairest spawn point: never inside another player, preferably out of every enemy's sight and away from
   * rockets about to land, far from the nearest enemy, and not where this player just died or last spawned. Ties
   * are broken at random so spawns stay hard to camp. When every point is occupied the spawn waits a moment.
   */
  private spawn(p: RPlayer) {
    const alive = [...this.players.values()].filter((o) => o !== p && !o.dead);
    const diedAt = p.body.pos; // a dead body does not move, so this is where the player died
    const last = this.lastSpawn.get(p.id) ?? -1;
    let best = -Infinity;
    const scored: { i: number; score: number }[] = [];
    this.map.spawns.forEach((s, i) => {
      const score = this.spawnScore(p, s.pos, alive, diedAt, i === last);
      if (score === -Infinity) return;
      scored.push({ i, score });
      if (score > best) best = score;
    });
    if (!scored.length) {
      p.respawnAt = this.now + 0.25;
      return;
    }
    const good = scored.filter((c) => c.score >= best - RocketsGame.SPAWN_SLACK);
    const index = good[Math.floor(this.rng() * good.length)].i;
    this.lastSpawn.set(p.id, index);
    const choice = this.map.spawns[index];
    p.body.pos = v3(choice.pos.x, choice.pos.y + 0.05, choice.pos.z);
    p.body.vel = v3();
    p.body.onGround = false;
    p.yaw = choice.yaw;
    p.pitch = 0;
    p.hp = this.isElim() ? ELIM.health : RK.maxHealth;
    p.armor = this.isElim() ? ELIM.armor : 0;
    p.dead = false;
    p.protectedUntil = this.now + RK.spawnProtection;
    p.nextFire = this.now + 0.3;
    p.fireSeq = p.lastSeq + SPAWN_FIRE_STEPS;
    this.events.push({ k: 'spawn', id: p.id, p: toTuple(p.body.pos) });
  }

  // ---- pickups --------------------------------------------------------------------------------------------

  private tryPickup(p: RPlayer) {
    if (p.dead || this.isElim()) return;
    for (let i = 0; i < this.packs.length; i++) {
      const pack = this.packs[i];
      if (!pack.available || p.hp >= RK.maxHealth) continue;
      const pos = this.map.packs[i];
      if (hdist(p.body.pos, pos) <= RK.pickupRadius && Math.abs(p.body.pos.y - pos.y) < 1) {
        pack.available = false;
        pack.respawnAt = this.now + RK.healthPackRespawn;
        p.hp = Math.min(RK.maxHealth, p.hp + RK.healthPackAmount);
        this.events.push({ k: 'pack', i, by: p.id });
        return;
      }
    }
    for (let i = 0; i < this.items.length; i++) {
      const state = this.itemState[i];
      if (!state.available) continue;
      const item = this.items[i];
      if (hdist(p.body.pos, item.p) > RK.pickupRadius || Math.abs(p.body.pos.y - item.p.y) >= 1) continue;
      // Shards are always taken (Quake 3); armor only when it adds something; mega health stacks up to the cap.
      if (item.k === 'mega') {
        if (p.hp >= ITEM.maxOverheal) continue;
        p.hp = Math.min(ITEM.maxOverheal, p.hp + ITEM.mega.health);
      } else {
        if (item.k === 'armor' && p.armor >= ITEM.maxArmor) continue;
        p.armor = Math.min(ITEM.maxArmor, p.armor + ITEM[item.k].armor);
      }
      state.available = false;
      state.respawnAt = this.now + itemRespawn(item.k);
      this.events.push({ k: 'item', i, t: item.k, by: p.id });
      return;
    }
  }

  /**
   * Splits a hit between armor and health: armor soaks ITEM.armorProtection of it while it lasts, and the rest
   * (plus whatever the armor could not cover) comes off health. Returns the health damage; `damage()` subtracts it.
   */
  private absorb(p: RPlayer, dmg: number): number {
    const soaked = Math.min(p.armor, Math.ceil(dmg * ITEM.armorProtection));
    p.armor -= soaked;
    return dmg - soaked;
  }

  private updatePacks() {
    for (const pack of this.packs) if (!pack.available && this.now >= pack.respawnAt) pack.available = true;
    for (const state of this.itemState) if (!state.available && this.now >= state.respawnAt) state.available = true;
    // Elimination's round health is not overheal: it stays until the enemy takes it.
    const decay = this.now >= this.nextDecay && !this.isElim();
    if (decay) this.nextDecay += 1;
    for (const p of this.players.values()) {
      if (p.dead) {
        p.armor = 0;
        continue;
      }
      if (decay) {
        if (p.hp > ITEM.overhealFloor) p.hp--;
        if (p.armor > ITEM.overhealFloor) p.armor--;
      }
      // Swept every step as well as on each command, so standing still on an item that just respawned picks it up.
      this.tryPickup(p);
    }
  }

  // ---- capture the flag -------------------------------------------------------------------------------------

  /** Touching a flag (or a base, for a capture): close horizontally and within a body height. */
  private touches(p: RPlayer, at: Vec3) {
    return hdist(p.body.pos, at) <= CTF.touchRadius && Math.abs(p.body.pos.y - at.y) < RK.height;
  }

  /** Runs every step: carried flags follow their carrier; touches take, return and capture; dropped flags time out. */
  private updateFlags() {
    const flags = this.flags;
    if (!flags || !this.bases || this.frozen() || this.ended) return;
    for (let t = 0 as Team; t < 2; t = (t + 1) as Team) {
      const f = flags[t];
      if (f.state === 1) {
        const carrier = f.carrier ? this.players.get(f.carrier) : undefined;
        if (carrier && !carrier.dead) f.pos = { ...carrier.body.pos };
        else this.returnFlag(t, '');
      } else if (f.state === 2 && this.now >= f.returnAt) this.returnFlag(t, '');
    }
    for (const p of this.players.values()) {
      if (p.dead || p.team === undefined) continue;
      const own = flags[p.team];
      const enemyTeam: Team = p.team === 0 ? 1 : 0;
      const enemy = flags[enemyTeam];
      // Your own dropped flag goes home the moment you touch it.
      if (own.state === 2 && this.touches(p, own.pos)) this.returnFlag(p.team, p.id);
      // The enemy flag (at their base or lying around) is yours to take.
      if (enemy.state !== 1 && this.touches(p, enemy.pos)) {
        enemy.state = 1;
        enemy.carrier = p.id;
        enemy.pos = { ...p.body.pos };
        this.events.push({ k: 'flag', team: enemyTeam, a: 'take', by: p.id });
        this.host.systemChat(`${p.name} has the ${TEAMS[enemyTeam].name} flag`);
      }
      // Home with the enemy flag while your own is safe at base: a capture.
      if (enemy.state === 1 && enemy.carrier === p.id && own.state === 0 && this.touches(p, this.bases[p.team])) {
        this.resetFlag(enemyTeam);
        p.caps++;
        this.teamScore[p.team]++;
        this.events.push({ k: 'flag', team: enemyTeam, a: 'capture', by: p.id });
        this.host.systemChat(`${p.name} captured the ${TEAMS[enemyTeam].name} flag`);
        this.host.broadcast({ k: 'score', scores: this.scores() });
        if (this.teamScore[p.team] >= this.rules.limit) return this.endMatch();
      }
    }
  }

  private resetFlag(t: Team) {
    const f = this.flags![t];
    f.state = 0;
    f.carrier = undefined;
    f.pos = { ...this.bases![t] };
  }

  private returnFlag(t: Team, by: string) {
    this.resetFlag(t);
    this.events.push({ k: 'flag', team: t, a: 'return', by });
  }

  /**
   * The carrier died, left or switched team: the flag falls to the floor below where they were, or goes straight
   * home when there is no floor below (the void).
   */
  private dropFlag(p: RPlayer) {
    if (!this.flags) return;
    for (let t = 0 as Team; t < 2; t = (t + 1) as Team) {
      const f = this.flags[t];
      if (f.state !== 1 || f.carrier !== p.id) continue;
      const from = p.body.pos;
      const floor = from.y > this.map.killY ? segmentBoxes(v3(from.x, from.y + 0.1, from.z), v3(from.x, this.map.killY, from.z), this.map.boxes) : null;
      if (!floor || floor.normal.y < 0.5) {
        this.returnFlag(t, '');
        continue;
      }
      f.state = 2;
      f.carrier = undefined;
      f.pos = v3(from.x, from.y + 0.1 + (this.map.killY - from.y - 0.1) * floor.t, from.z);
      f.returnAt = this.now + CTF.returnSeconds;
      this.events.push({ k: 'flag', team: t, a: 'drop', by: p.id });
    }
  }

  // ---- elimination rounds -----------------------------------------------------------------------------------

  /** Elimination: players still in the round per team (counting anyone whose round-start spawn is still pending). */
  private aliveCount(): [number, number] {
    const alive: [number, number] = [0, 0];
    for (const p of this.players.values()) {
      if (p.team === undefined) continue;
      if (!p.dead || p.respawnAt !== Infinity) alive[p.team]++;
    }
    return alive;
  }

  /** Runs once per loop: ends a round on a wipe-out or its clock, then starts the next one after the pause. */
  private updateRound() {
    if (!this.isElim() || this.frozen() || this.ended) return;
    const r = this.round;
    if (r.state === 'over') {
      if (this.now >= r.nextAt) this.startRound();
      return;
    }
    const [red, blue] = this.aliveCount();
    // Sudden death never outlasts its cap: the round in progress is cut short and judged on health.
    const deadline = this.overtime ? Math.min(r.endsAt, this.overtimeAt + this.overtimeMax()) : r.endsAt;
    if (red > 0 && blue > 0 && this.now < deadline) return;
    let winner: Team | null;
    if (red === 0 || blue === 0) winner = red > 0 ? 0 : blue > 0 ? 1 : null;
    else {
      // Time: the team with more health and armor left takes it.
      const left: [number, number] = [0, 0];
      for (const p of this.players.values()) if (!p.dead && p.team !== undefined) left[p.team] += p.hp + p.armor;
      winner = left[0] === left[1] ? null : left[0] > left[1] ? 0 : 1;
    }
    r.state = 'over';
    r.nextAt = this.now + ELIM.intermission;
    this.rockets = [];
    if (winner !== null) this.teamScore[winner]++;
    this.events.push({ k: 'round', n: r.n, winner });
    this.host.systemChat(winner === null ? `Round ${r.n} is a draw` : `${TEAMS[winner].name} takes round ${r.n}`);
    this.host.broadcast({ k: 'score', scores: this.scores() });
    if (winner !== null && this.teamScore[winner] >= this.rules.limit) this.endMatch();
  }

  /** Everyone back in: fresh bodies with the round loadout, each team on its own half. */
  private startRound() {
    const r = this.round;
    r.n++;
    r.state = 'play';
    r.endsAt = this.now + ELIM.roundSeconds;
    this.rockets = [];
    for (const p of this.players.values()) {
      p.dead = true;
      p.hp = 0;
      p.armor = 0;
      p.lastHitBy = undefined;
    }
    for (const p of this.players.values()) this.spawn(p);
  }

  // ---- bots -------------------------------------------------------------------------------------------------

  private botView(p: RPlayer) {
    const enemies: BotEnemy[] = [];
    const allies: { id: string; pos: Vec3 }[] = [];
    for (const o of this.players.values()) {
      if (o === p || o.dead) continue;
      // Team modes: teammates are never targets.
      if (this.friendly(o, p)) allies.push({ id: o.id, pos: o.body.pos });
      else enemies.push({ id: o.id, pos: o.body.pos, vel: o.body.vel, onGround: o.body.onGround });
    }
    return {
      now: this.now,
      self: { id: p.id, body: p.body, hp: p.hp, dead: p.dead, nextFire: p.nextFire },
      enemies,
      // Items count as packs for the bots' pickup routing, so they contest armor and mega health too. None in elim.
      packs: this.isElim()
        ? []
        : [
            ...this.map.packs.map((pos, i) => ({ pos, available: this.packs[i].available, item: false })),
            ...this.items.map((it, i) => ({ pos: it.p, available: this.itemState[i].available, item: true })),
          ],
      map: this.map,
      canSee: (from: Vec3, to: Vec3) => !segmentBoxes(from, to, this.map.boxes),
      // Rockets in flight, so bots can dodge them.
      rockets: this.rockets,
      frozen: this.frozen(),
      mode: this.mode,
      ...(this.teams
        ? {
            team: p.team,
            allies,
            bases: this.bases,
            // A carried flag is wherever its carrier is right now (updateFlags only catches up at the end of the step).
            ...(this.flags
              ? {
                  flags: this.flags.map((f) => ({
                    state: f.state,
                    pos: (f.carrier && this.players.get(f.carrier)?.body.pos) || f.pos,
                    ...(f.carrier ? { carrier: f.carrier } : {}),
                  })),
                }
              : {}),
            ...(this.isElim() ? { roundOver: this.round.state === 'over' } : {}),
          }
        : {}),
    };
  }

  // ---- output -----------------------------------------------------------------------------------------------

  private scores(): ScoreRow[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      frags: p.frags,
      deaths: p.deaths,
      ...(this.teams && p.team !== undefined ? { team: p.team } : {}),
      ...(this.mode === 'ctf' ? { caps: p.caps } : {}),
    }));
  }

  /** Match clock: full during the countdown, then counts down; sits at 0 through overtime. */
  private timeLeft() {
    const total = this.rules.seconds;
    return clamp(total - (this.now - RocketsGame.COUNTDOWN), 0, total);
  }

  private flagSnaps(): [FlagSnap, FlagSnap] | undefined {
    if (!this.flags) return undefined;
    const snap = (f: Flag): FlagSnap => ({ s: f.state, p: cm(f.pos), ...(f.carrier ? { by: f.carrier } : {}) });
    return [snap(this.flags[0]), snap(this.flags[1])];
  }

  private roundSnap(): RoundSnap | undefined {
    if (!this.isElim()) return undefined;
    const r = this.round;
    const left = r.state === 'over' ? r.nextAt - this.now : (this.frozen() ? ELIM.roundSeconds : r.endsAt - this.now);
    return { n: r.n, alive: this.aliveCount(), left: Math.max(0, Math.round(left * 10) / 10), state: r.state };
  }

  private flush() {
    const pl: PlayerSnap[] = [];
    for (const p of this.players.values()) {
      pl.push({
        id: p.id,
        p: cm(p.body.pos),
        v: dm(p.body.vel),
        y: r2(p.yaw),
        pt: r2(p.pitch),
        hp: p.hp,
        ...(p.armor > 0 ? { ar: p.armor } : {}),
        d: p.dead ? 1 : 0,
        g: p.body.onGround ? 1 : 0,
      });
    }
    const rk: RocketSnap[] = this.rockets.map((r) => ({ id: r.id, o: r.owner, p: cm(r.pos), v: dm(r.vel) }));
    const pk: number[] = [];
    this.packs.forEach((pack, i) => pack.available && pk.push(i));
    const it: number[] = [];
    this.itemState.forEach((state, i) => state.available && it.push(i));
    const base = {
      tick: this.tick,
      t: Date.now(),
      left: Math.round(this.timeLeft() * 10) / 10,
      rk,
      ...(this.frozen() ? { cd: Math.round((RocketsGame.COUNTDOWN - this.now) * 10) / 10 } : {}),
      ...(this.overtime ? { ot: 1 as const } : {}),
      ...(this.teams ? { ts: [this.teamScore[0], this.teamScore[1]] as [number, number] } : {}),
      ...(this.flags ? { fl: this.flagSnaps() } : {}),
      ...(this.isElim() ? { rd: this.roundSnap() } : {}),
    };

    if (this.events.length) {
      this.host.broadcast({ k: 'ev', e: this.events });
      this.events = [];
    }
    for (const p of this.players.values()) {
      if (p.bot) continue;
      // Our own entry stays at full precision: prediction replays from it.
      const mine = pl.map((s) => (s.id === p.id ? { ...s, p: toTuple(p.body.pos), v: toTuple(p.body.vel), seq: p.lastSeq } : s));
      const pkKey = pk.join();
      const itKey = it.join();
      const changes = { ...(pkKey !== p.sentPk ? { pk } : {}), ...(itKey !== p.sentIt ? { it } : {}) };
      p.sentPk = pkKey;
      p.sentIt = itKey;
      const msg: RocketsServerMsg = { k: 'snap', s: { ...base, ...changes, pl: mine } };
      this.host.send(p.id, msg);
    }
  }

  private endMatch() {
    if (this.ended) return;
    // Deliver the deciding frag (kill event, final positions) before the results screen goes up.
    this.flush();
    this.ended = true;
    this.stop();
    this.rockets = [];
    const scores = this.scores().sort((a, b) => b.frags - a.frags || a.deaths - b.deaths);
    const top = scores[0];
    const tie = scores.length > 1 && scores[1].frags === top?.frags && scores[1].deaths === top?.deaths;
    const winner = top && !tie ? top.id : null;
    if (this.teams) {
      const [red, blue] = this.teamScore;
      const winnerTeam: Team | null = red === blue ? null : red > blue ? 0 : 1;
      const tally = `${Math.max(red, blue)}-${Math.min(red, blue)}`;
      this.host.systemChat(winnerTeam === null ? `The match ends in a draw, ${red}-${blue}` : `${TEAMS[winnerTeam].name} wins ${tally}`);
      this.host.broadcast({ k: 'end', scores, winner, winnerTeam });
    } else {
      const name = winner ? this.players.get(winner)?.name : undefined;
      this.host.systemChat(name ? `${name} wins with ${top.frags} frags` : 'The match ends in a draw');
      this.host.broadcast({ k: 'end', scores, winner });
    }
    this.host.matchEnded();
  }

  // ---- match flow -------------------------------------------------------------------------------------------

  /** Seconds of 3-2-1 freeze at the start of a match: players can look around but not move or fire. */
  private static readonly COUNTDOWN = 3;
  /** Spawn points scoring within this much of the best one are picked from at random. */
  private static readonly SPAWN_SLACK = 4;
  /** Hard cap on a whole match, countdown and sudden death included, so a session never drags past 8.5 minutes. */
  private static readonly MATCH_MAX = 510;

  /** Sudden death length: the mode's overtime, cut short if the match would otherwise run past MATCH_MAX. */
  private overtimeMax() {
    return clamp(RocketsGame.MATCH_MAX - RocketsGame.COUNTDOWN - this.rules.seconds, 0, this.rules.overtime);
  }

  private overtime = false;
  private overtimeAt = 0;
  private countdownCalled = false;
  private readonly lastSpawn = new Map<string, number>();

  private frozen() {
    return this.now < RocketsGame.COUNTDOWN;
  }

  private holdStill(cmd: RocketsInput): RocketsInput {
    return { ...cmd, f: 0, s: 0, jump: false, fire: false };
  }

  /**
   * Countdown call, elimination rounds, time limit, and overtime: a level match at the buzzer plays on (sudden death)
   * until someone pulls ahead, for at most MODES[mode].overtime seconds, then it is a draw.
   */
  private updateMatchFlow() {
    if (!this.countdownCalled && !this.frozen()) {
      this.countdownCalled = true;
      this.host.systemChat('Fight!');
    }
    this.updateRound();
    if (this.ended || this.timeLeft() > 0) return;
    const leaders = this.leaders();
    if (!this.overtime) {
      if (leaders === 1) return this.endMatch();
      this.overtime = true;
      this.overtimeAt = this.now;
      const next = { ffa: 'Next frag wins', tdm: 'Next team frag wins', ctf: 'Next capture wins', elim: 'Next round win takes it' }[this.mode];
      this.host.systemChat(`Overtime! ${next}`);
      return;
    }
    if (leaders === 1 || this.now - this.overtimeAt >= this.overtimeMax()) this.endMatch();
  }

  /**
   * How many sides share the lead: players by frags in free for all (1 with fewer than two players, so a lone player
   * is never stuck), teams by team score otherwise.
   */
  private leaders() {
    if (this.teams) return this.teamScore[0] === this.teamScore[1] ? 2 : 1;
    let top = -Infinity;
    let count = 0;
    for (const p of this.players.values()) {
      if (p.frags > top) {
        top = p.frags;
        count = 1;
      } else if (p.frags === top) count++;
    }
    return Math.max(1, count);
  }

  /** Higher is better; -Infinity means the point is occupied (spawning there would telefrag). */
  private spawnScore(p: RPlayer, pos: Vec3, alive: RPlayer[], diedAt: Vec3, sameAsLast: boolean) {
    const eye = v3(pos.x, pos.y + RK.eyeHeight, pos.z);
    const centre = v3(pos.x, pos.y + RK.height * 0.5, pos.z);
    let nearest = 40;
    let seen = 0;
    for (const o of alive) {
      if (hdist(o.body.pos, pos) < RK.halfWidth * 2 + 0.3 && Math.abs(o.body.pos.y - pos.y) < RK.height) return -Infinity;
      // Teammates only block the point; being near or seen by them is fine.
      if (this.friendly(o, p)) continue;
      nearest = Math.min(nearest, vdist(o.body.pos, pos));
      if (!segmentBoxes(eyePosition(o.body.pos), eye, this.map.boxes)) seen++;
    }
    // Rockets in flight that will pass (or burst) within splash range over the next half second.
    let danger = 0;
    for (const r of this.rockets) {
      const end = vadd(r.pos, vscale(r.vel, 0.5));
      const seg = vsub(end, r.pos);
      const t = clamp(((centre.x - r.pos.x) * seg.x + (centre.y - r.pos.y) * seg.y + (centre.z - r.pos.z) * seg.z) / (seg.x ** 2 + seg.y ** 2 + seg.z ** 2 || 1), 0, 1);
      if (vdist(vadd(r.pos, vscale(seg, t)), centre) < RK.splashRadius + 1) danger++;
    }
    let score = nearest;
    score -= seen ? 25 + 5 * seen : 0;
    score -= danger * 30;
    if (vdist(diedAt, pos) < 10) score -= 12;
    if (sameAsLast) score -= 8;
    // Team modes: your own half of the map, and in CTF close to your own base.
    if (this.teams && p.team !== undefined) {
      if (sideOf(this.map, pos) !== p.team) score -= WRONG_SIDE;
      if (this.mode === 'ctf' && this.bases) score -= vdist(pos, this.bases[p.team]) * BASE_PULL;
    }
    return score;
  }
}

export function createRocketsGame(host: GameHost): GameServer {
  return new RocketsGame(host);
}
