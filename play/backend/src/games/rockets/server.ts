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
import { ARENA } from '../../shared/rockets/map.js';
import { type Body, eyePosition, playerAABB, stepBody } from '../../shared/rockets/physics.js';
import type { PlayerSnap, RocketSnap, RocketsEvent, RocketsInput, RocketsServerMsg, ScoreRow } from '../../shared/rockets/protocol.js';
import type { GameClientMsg } from '../../shared/protocol.js';
import type { GameHost, GamePlayer, GameServer } from '../types.js';
import { BOT_PARAMS, RocketsBot, type BotEnemy } from './bots.js';
import { navGraphFor } from './nav.js';

interface RPlayer extends GamePlayer {
  body: Body;
  yaw: number;
  pitch: number;
  hp: number;
  dead: boolean;
  respawnAt: number;
  protectedUntil: number;
  lastSeq: number;
  nextFire: number;
  queue: RocketsInput[];
  lastInputAt: number;
  frags: number;
  deaths: number;
  brain?: RocketsBot;
  shots: number;
}

interface Rocket {
  id: string;
  owner: string;
  pos: Vec3;
  vel: Vec3;
  born: number;
}

const IDLE: Omit<RocketsInput, 'seq' | 'yaw' | 'pitch'> = { f: 0, s: 0, jump: false, fire: false };

class RocketsGame implements GameServer {
  private readonly map = ARENA;
  private readonly players = new Map<string, RPlayer>();
  private rockets: Rocket[] = [];
  private readonly packs = this.map.packs.map(() => ({ available: true, respawnAt: 0 }));
  private events: RocketsEvent[] = [];
  private now = 0;
  private tick = 0;
  private ended = false;
  private timer?: NodeJS.Timeout;
  private readonly rng = makeRng((Date.now() ^ 0x9e3779b9) >>> 0);
  private readonly graph = navGraphFor(ARENA);

  constructor(private readonly host: GameHost) {}

  // ---- lifecycle --------------------------------------------------------------------------------------------

  start() {
    for (const p of this.host.players()) this.addPlayer(p);
    this.timer = setInterval(() => this.loop(), 1000 / RK.loopHz);
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
      dead: true,
      respawnAt: this.now + 0.3,
      protectedUntil: 0,
      lastSeq: 0,
      nextFire: 0,
      queue: [],
      lastInputAt: this.now,
      frags: 0,
      deaths: 0,
      shots: 0,
    };
    if (p.bot) player.brain = new RocketsBot(BOT_PARAMS[this.host.botDifficulty()], this.graph, makeRng(Math.floor(this.rng() * 1e9)));
    this.players.set(p.id, player);
    this.host.send(p.id, { k: 'init', map: this.map, scores: this.scores(), left: this.timeLeft() });
    this.host.broadcast({ k: 'score', scores: this.scores() });
  }

  removePlayer(id: string) {
    if (!this.players.delete(id)) return;
    this.host.broadcast({ k: 'score', scores: this.scores() });
  }

  onMessage(id: string, m: GameClientMsg) {
    const p = this.players.get(id);
    if (!p || p.bot || m.k !== 'in' || !Array.isArray(m.i)) return;
    for (const raw of m.i as Partial<RocketsInput>[]) {
      if (!raw || typeof raw !== 'object') continue;
      const input: RocketsInput = {
        seq: Number(raw.seq) || 0,
        f: clamp(Number(raw.f) || 0, -1, 1),
        s: clamp(Number(raw.s) || 0, -1, 1),
        jump: !!raw.jump,
        fire: !!raw.fire,
        yaw: typeof raw.yaw === 'number' && Number.isFinite(raw.yaw) ? raw.yaw : p.yaw,
        pitch: clamp(Number(raw.pitch) || 0, -RK.maxPitch, RK.maxPitch),
      };
      if (input.seq <= p.lastSeq) continue;
      p.queue.push(input);
    }
    // A client that falls far behind is not allowed to catch up all at once.
    if (p.queue.length > 30) p.queue.splice(0, p.queue.length - 30);
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
    while (this.acc >= RK.dt - 1e-9 && substeps < 10) {
      this.acc -= RK.dt;
      substeps++;
      this.now += RK.dt;
      this.tick++;
      for (const p of this.players.values()) {
        if (p.dead && this.now >= p.respawnAt) this.spawn(p);
        if (p.brain) this.applyInput(p, p.brain.think(this.botView(p)));
      }
      this.stepRockets(RK.dt);
      this.updatePacks();
    }
    if (substeps === 0) return;
    for (const p of this.players.values()) {
      if (p.brain) continue;
      let n = 0;
      const limit = Math.max(RK.maxCommandsPerLoop, substeps * 3);
      while (p.queue.length && n < limit) {
        this.applyInput(p, p.queue.shift()!);
        p.lastInputAt = this.now;
        n++;
      }
      // Nobody at the keyboard (or a stalled connection): keep gravity honest.
      if (n === 0 && this.now - p.lastInputAt > 0.15) {
        for (let i = 0; i < substeps; i++) this.applyInput(p, { ...IDLE, seq: p.lastSeq, yaw: p.yaw, pitch: p.pitch }, true);
      }
    }
    if (this.timeLeft() <= 0) this.endMatch();
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
    if (p.hp < RK.maxHealth) this.tryPickup(p);
    if (input.fire && this.now >= p.nextFire) this.fire(p, input.seq);
  }

  // ---- rockets ------------------------------------------------------------------------------------------------

  private fire(p: RPlayer, seq: number) {
    p.nextFire = this.now + RK.fireInterval;
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
      const falloff = 1 - d / RK.splashRadius;
      let dmg = p === direct ? RK.directDamage : RK.splashDamage * falloff;
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

  private damage(p: RPlayer, dmg: number, by: RPlayer | null) {
    if (dmg <= 0 || p.dead) return;
    if (this.now < p.protectedUntil && by !== p) return;
    p.hp -= dmg;
    this.events.push({ k: 'hurt', id: p.id, dmg, by: by?.id ?? '' });
    if (p.hp <= 0) this.kill(p, by);
  }

  private kill(victim: RPlayer, killer: RPlayer | null) {
    if (victim.dead) return;
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

  private spawn(p: RPlayer) {
    const alive = [...this.players.values()].filter((o) => o !== p && !o.dead);
    const ranked = this.map.spawns
      .map((s) => ({ s, d: alive.length ? Math.min(...alive.map((o) => hdist(o.body.pos, s.pos))) : 99 }))
      .sort((a, b) => b.d - a.d);
    const choice = ranked[Math.floor(this.rng() * Math.min(3, ranked.length))].s;
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
    for (let i = 0; i < this.packs.length; i++) {
      const pack = this.packs[i];
      if (!pack.available) continue;
      const pos = this.map.packs[i];
      if (hdist(p.body.pos, pos) <= RK.pickupRadius && Math.abs(p.body.pos.y - pos.y) < 1) {
        pack.available = false;
        pack.respawnAt = this.now + RK.healthPackRespawn;
        p.hp = Math.min(RK.maxHealth, p.hp + RK.healthPackAmount);
        this.events.push({ k: 'pack', i, by: p.id });
        return;
      }
    }
  }

  private updatePacks() {
    for (const pack of this.packs) if (!pack.available && this.now >= pack.respawnAt) pack.available = true;
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
      packs: this.map.packs.map((pos, i) => ({ pos, available: this.packs[i].available })),
      map: this.map,
      canSee: (from: Vec3, to: Vec3) => !segmentBoxes(from, to, this.map.boxes),
    };
  }

  // ---- output -----------------------------------------------------------------------------------------------

  private scores(): ScoreRow[] {
    return [...this.players.values()].map((p) => ({ id: p.id, frags: p.frags, deaths: p.deaths }));
  }

  private timeLeft() {
    return Math.max(0, RK.matchSeconds - this.now);
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
        d: p.dead ? 1 : 0,
        g: p.body.onGround ? 1 : 0,
      });
    }
    const rk: RocketSnap[] = this.rockets.map((r) => ({ id: r.id, o: r.owner, p: toTuple(r.pos), v: toTuple(r.vel) }));
    const pk: number[] = [];
    this.packs.forEach((pack, i) => pack.available && pk.push(i));
    const base = { tick: this.tick, t: Date.now(), left: Math.round(this.timeLeft() * 10) / 10, rk, pk };

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
    this.ended = true;
    this.stop();
    const scores = this.scores().sort((a, b) => b.frags - a.frags || a.deaths - b.deaths);
    const top = scores[0];
    const tie = scores.length > 1 && scores[1].frags === top?.frags && scores[1].deaths === top?.deaths;
    this.host.broadcast({ k: 'end', scores, winner: top && !tie ? top.id : null });
    this.host.matchEnded();
  }
}

export function createRocketsGame(host: GameHost): GameServer {
  return new RocketsGame(host);
}
