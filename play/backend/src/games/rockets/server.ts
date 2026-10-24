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
  v3,
  vadd,
  vdist,
  vnormalize,
  vscale,
  vsub,
} from '../../shared/math.js';
import { RK } from '../../shared/rockets/constants.js';
import { ITEM, type ItemSpawn, itemRespawn, itemsFor } from '../../shared/rockets/items.js';
import type { MapData } from '../../shared/rockets/map.js';
import { MAPS, mapById } from '../../shared/rockets/maps.js';
import { type Body, eyePosition, playerAABB, stepBody } from '../../shared/rockets/physics.js';
import type { PlayerSnap, RocketSnap, RocketsEvent, RocketsInput, RocketsServerMsg, ScoreRow } from '../../shared/rockets/protocol.js';
import type { GameClientMsg } from '../../shared/protocol.js';
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
  queue: RocketsInput[];
  lastInputAt: number;
  frags: number;
  deaths: number;
  brain?: RocketsBot;
  shots: number;
  /** Who last hurt this player and when, so a knock into the void still credits the shooter. */
  lastHitBy?: string;
  lastHitAt?: number;
}

interface Rocket {
  id: string;
  owner: string;
  pos: Vec3;
  vel: Vec3;
  born: number;
}

const IDLE: Omit<RocketsInput, 'seq' | 'yaw' | 'pitch'> = { f: 0, s: 0, jump: false, fire: false };

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

  constructor(private readonly host: GameHost) {
    this.map = pickMap(host, this.rng);
    lastMap.set(host, this.map.id);
    this.packs = this.map.packs.map(() => ({ available: true, respawnAt: 0 }));
    this.items = itemsFor(this.map.id);
    // Quake rule: the big items are not there at the start, so nobody spawns next to a free mega health.
    this.itemState = this.items.map((it) => ({ available: it.k === 'shard', respawnAt: it.k === 'shard' ? 0 : itemRespawn(it.k) / 2 }));
    this.graph = navGraphFor(this.map);
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------

  start() {
    this.host.systemChat(`Map: ${this.map.name} · fight in ${RocketsGame.COUNTDOWN} seconds`);
    for (const p of this.host.players()) this.addPlayer(p);
    // Everyone appears straight away, one after the other so each spawn sees the ones already placed, and stands
    // frozen through the countdown: the match starts with nobody spawning on top of or in front of anybody else.
    for (const p of this.players.values()) this.spawn(p);
    this.timer = setInterval(() => {
      try {
        this.loop();
      } catch (err) {
        // One bad room must never take down every other room on the server.
        console.error('rockets loop failed', err);
      }
    }, 1000 / RK.loopHz);
  }

  stop() {
    clearInterval(this.timer);
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
      queue: [],
      lastInputAt: this.now,
      frags: 0,
      deaths: 0,
      shots: 0,
    };
    if (p.bot) player.brain = new RocketsBot(BOT_PARAMS[this.host.botDifficulty()], this.graph, makeRng(Math.floor(this.rng() * 1e9)));
    this.players.set(p.id, player);
    this.host.send(p.id, { k: 'init', map: this.map, items: this.items, scores: this.scores(), left: this.timeLeft() });
    this.host.broadcast({ k: 'score', scores: this.scores() });
  }

  removePlayer(id: string) {
    if (!this.players.delete(id)) return;
    // A departed player's rockets would otherwise kill with no owner, which counts as a suicide for the victim.
    this.rockets = this.rockets.filter((r) => r.owner !== id);
    this.host.broadcast({ k: 'score', scores: this.scores() });
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
      this.stepRockets(RK.dt);
      this.updatePacks();
    }
    if (substeps === 0 || this.ended) return;
    const frozen = this.frozen();
    for (const p of this.players.values()) {
      if (p.brain) continue;
      let n = 0;
      // One command per simulated step plus a little slack for network jitter, capped so nobody banks speed.
      p.credit = Math.min(p.credit + substeps * 1.15, RK.maxCommandsPerLoop + 2);
      while (p.queue.length && p.credit >= 1) {
        p.credit--;
        const cmd = p.queue.shift()!;
        // During the countdown the command still counts (look around, seq acknowledged) but nobody moves or fires.
        this.applyInput(p, frozen ? this.holdStill(cmd) : cmd);
        p.lastInputAt = this.now;
        n++;
      }
      // Nobody at the keyboard (or a stalled connection): keep gravity honest.
      if (n === 0 && this.now - p.lastInputAt > 0.15) {
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
    if (p.dead) return;

    const result = stepBody(p.body, input, this.map);
    if (result.pad >= 0) this.events.push({ k: 'pad', id: p.id });
    if (p.body.pos.y < this.map.killY) {
      this.kill(p, null);
      return;
    }
    this.tryPickup(p);
    if (input.fire && this.now >= p.nextFire) this.fire(p, input.seq);
  }

  // ---- rockets ------------------------------------------------------------------------------------------------

  private fire(p: RPlayer, seq: number) {
    p.nextFire = this.now + RK.fireInterval;
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

  private stepRockets(dt: number) {
    const keep: Rocket[] = [];
    for (const r of this.rockets) {
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
      const box = playerAABB(p.body.pos);
      const nearest = v3(clamp(at.x, box.min.x, box.max.x), clamp(at.y, box.min.y, box.max.y), clamp(at.z, box.min.z, box.max.z));
      const d = vdist(at, nearest);
      if (d > RK.splashRadius) continue;
      const centre = v3(p.body.pos.x, p.body.pos.y + RK.height * 0.5, p.body.pos.z);
      if (p !== direct && segmentBoxes(at, centre, this.map.boxes)) continue; // behind cover
      const self = owner === p;
      if (!self && this.now < p.protectedUntil) continue; // spawn protection: no damage and no knockback
      const falloff = 1 - d / RK.splashRadius;
      let dmg = p === direct ? (this.isAirshot(p) ? RK.airshotDamage : RK.directDamage) : RK.splashDamage * falloff;
      if (self) dmg *= RK.selfDamageScale;

      // Knockback: away from the blast, with a guaranteed bit of lift so floor hits launch players.
      const dir = vnormalize(vsub(centre, at));
      if (dir.y < RK.knockbackLift) dir.y = RK.knockbackLift;
      const kick = RK.knockback * (p === direct ? 1 : falloff) * (self ? RK.selfKnockbackScale : 1);
      const n = vnormalize(dir);
      p.body.vel.x += n.x * kick;
      p.body.vel.y += n.y * kick;
      p.body.vel.z += n.z * kick;
      if (n.y > 0) p.body.onGround = false;

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
    const killer = killedBy ?? this.recentAttacker(victim);
    victim.lastHitBy = undefined;
    victim.dead = true;
    victim.hp = 0;
    victim.deaths++;
    victim.respawnAt = this.now + RK.respawnDelay;
    const self = !killer || killer === victim;
    if (self) victim.frags--;
    else killer.frags++;
    this.events.push({ k: 'kill', v: victim.id, by: killer?.id ?? '', self });
    this.host.broadcast({ k: 'score', scores: this.scores() });
    if (killer && !self && killer.frags >= RK.fragLimit) this.endMatch();
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
      const score = this.spawnScore(s.pos, alive, diedAt, i === last);
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
    p.hp = RK.maxHealth;
    p.dead = false;
    p.protectedUntil = this.now + RK.spawnProtection;
    p.nextFire = this.now + 0.3;
    this.events.push({ k: 'spawn', id: p.id, p: toTuple(p.body.pos) });
  }

  // ---- pickups --------------------------------------------------------------------------------------------

  private tryPickup(p: RPlayer) {
    if (p.dead) return;
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
    const decay = this.now >= this.nextDecay;
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

  // ---- bots -------------------------------------------------------------------------------------------------

  private botView(p: RPlayer) {
    const enemies: BotEnemy[] = [];
    for (const o of this.players.values()) {
      if (o === p || o.dead) continue;
      enemies.push({ id: o.id, pos: o.body.pos, vel: o.body.vel, onGround: o.body.onGround });
    }
    return {
      now: this.now,
      self: { id: p.id, body: p.body, hp: p.hp, dead: p.dead, nextFire: p.nextFire },
      enemies,
      // Items count as packs for the bots' pickup routing, so they contest armor and mega health too.
      packs: [
        ...this.map.packs.map((pos, i) => ({ pos, available: this.packs[i].available })),
        ...this.items.map((it, i) => ({ pos: it.p, available: this.itemState[i].available })),
      ],
      map: this.map,
      canSee: (from: Vec3, to: Vec3) => !segmentBoxes(from, to, this.map.boxes),
      // Rockets in flight, so bots can dodge them.
      rockets: this.rockets,
    };
  }

  // ---- output -----------------------------------------------------------------------------------------------

  private scores(): ScoreRow[] {
    return [...this.players.values()].map((p) => ({ id: p.id, frags: p.frags, deaths: p.deaths }));
  }

  /** Match clock: full during the countdown, then counts down; sits at 0 through overtime. */
  private timeLeft() {
    return clamp(RK.matchSeconds - (this.now - RocketsGame.COUNTDOWN), 0, RK.matchSeconds);
  }

  private flush() {
    const pl: PlayerSnap[] = [];
    for (const p of this.players.values()) {
      pl.push({
        id: p.id,
        p: toTuple(p.body.pos),
        v: toTuple(p.body.vel),
        y: Math.round(p.yaw * 1000) / 1000,
        pt: Math.round(p.pitch * 1000) / 1000,
        hp: p.hp,
        ...(p.armor > 0 ? { ar: p.armor } : {}),
        d: p.dead ? 1 : 0,
        g: p.body.onGround ? 1 : 0,
      });
    }
    const rk: RocketSnap[] = this.rockets.map((r) => ({ id: r.id, o: r.owner, p: toTuple(r.pos), v: toTuple(r.vel) }));
    const pk: number[] = [];
    this.packs.forEach((pack, i) => pack.available && pk.push(i));
    const it: number[] = [];
    this.itemState.forEach((state, i) => state.available && it.push(i));
    const base = {
      tick: this.tick,
      t: Date.now(),
      left: Math.round(this.timeLeft() * 10) / 10,
      rk,
      pk,
      it,
      ...(this.frozen() ? { cd: Math.round((RocketsGame.COUNTDOWN - this.now) * 10) / 10 } : {}),
      ...(this.overtime ? { ot: 1 as const } : {}),
    };

    if (this.events.length) {
      this.host.broadcast({ k: 'ev', e: this.events });
      this.events = [];
    }
    for (const p of this.players.values()) {
      if (p.bot) continue;
      const mine = pl.map((s) => (s.id === p.id ? { ...s, seq: p.lastSeq } : s));
      const msg: RocketsServerMsg = { k: 'snap', s: { ...base, pl: mine } };
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
    const name = winner ? this.players.get(winner)?.name : undefined;
    this.host.systemChat(name ? `${name} wins with ${top.frags} frags` : 'The match ends in a draw');
    this.host.broadcast({ k: 'end', scores, winner });
    this.host.matchEnded();
  }

  // ---- match flow -------------------------------------------------------------------------------------------

  /** Seconds of 3-2-1 freeze at the start of a match: players can look around but not move or fire. */
  private static readonly COUNTDOWN = 3;
  /** Longest overtime before a still-level match is settled on deaths (or declared a draw). */
  private static readonly OVERTIME_MAX = 90;
  /** Spawn points scoring within this much of the best one are picked from at random. */
  private static readonly SPAWN_SLACK = 4;

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

  /** Countdown call, time limit, and overtime: tied leaders at the buzzer play on until one of them pulls ahead. */
  private updateMatchFlow() {
    if (!this.countdownCalled && !this.frozen()) {
      this.countdownCalled = true;
      this.host.systemChat('Fight!');
    }
    if (this.timeLeft() > 0) return;
    const leaders = this.leaders();
    if (!this.overtime) {
      if (leaders === 1) return this.endMatch();
      this.overtime = true;
      this.overtimeAt = this.now;
      this.host.systemChat('Overtime! Next frag wins');
      return;
    }
    if (leaders === 1 || this.now - this.overtimeAt >= RocketsGame.OVERTIME_MAX) this.endMatch();
  }

  /** How many players share the top frag count (1 with fewer than two players, so a lone player is never stuck). */
  private leaders() {
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
  private spawnScore(pos: Vec3, alive: RPlayer[], diedAt: Vec3, sameAsLast: boolean) {
    const eye = v3(pos.x, pos.y + RK.eyeHeight, pos.z);
    const centre = v3(pos.x, pos.y + RK.height * 0.5, pos.z);
    let nearest = 40;
    let seen = 0;
    for (const o of alive) {
      if (hdist(o.body.pos, pos) < RK.halfWidth * 2 + 0.3 && Math.abs(o.body.pos.y - pos.y) < RK.height) return -Infinity;
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
    return score;
  }
}

export function createRocketsGame(host: GameHost): GameServer {
  return new RocketsGame(host);
}
