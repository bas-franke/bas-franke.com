// Last Light: co-op zombie survival. Endless waves rise outside one closed room, one by one, tear the boards off the
// windows (or bash through the walls) and shamble at the survivors. Points from hits and kills buy guns, ammo,
// grenades and armor from the lockers. Walls and props are destructible chunks (shared/zombies/world.ts).
//
// Server-authoritative like Rockets: players send input commands that each advance their body by one fixed step;
// shots arrive as directions (the client decides the spread) plus the server time the shooter was looking at, and
// the server rewinds zombies to that moment before tracing. Zombies, waves, grenades and destruction run in the 30 Hz
// loop; one snapshot per loop goes to everyone, with a private part (`me`) for each player.

import { clamp, hdist, rng as makeRng, toTuple, type Vec3, type Vec3Tuple, vdist, yawForward, yawRight } from '../../shared/math.js';
import type { GameClientMsg } from '../../shared/protocol.js';
import { ZB, joggerShare, spawnInterval, waveCount, waveHealth } from '../../shared/zombies/constants.js';
import { type MapDef, zmapById, zonesFor } from '../../shared/zombies/maps.js';
import { type Body, type NadeBody, type ZInput, eyeHeight, stepNade, stepPlayer } from '../../shared/zombies/physics.js';
import {
  GIB,
  IMPACT_MATS,
  type ImpactMat,
  type LifeState,
  type MeSnap,
  type ZEvent,
  type ZPlayerSnap,
  type ZScore,
  ZState,
  type ZombieSnap,
  type ZombiesClientMsg,
  type ZombiesServerMsg,
} from '../../shared/zombies/protocol.js';
import { AMMO_CACHE_SHARE, AMMO_CRATE_PRICE, ARMOR_PRICE, NADE_PRICE, START_WEAPON, WEAPONS, type WeaponId, falloffAt, fireInterval, isWeaponId } from '../../shared/zombies/weapons.js';
import { type World, buildWorld, chunksInSphere, collapse, damageChunk, firstBlock, inside, raycast } from '../../shared/zombies/world.js';
import type { GameHost, GamePlayer, GameServer } from '../types.js';
import { SurvivorBot, type BotView } from './bots.js';
import { Kind, NavField } from './nav.js';

export interface Survivor extends GamePlayer {
  body: Body;
  yaw: number;
  pitch: number;
  life: LifeState;
  hp: number;
  armor: number;
  hurtAt: number;
  points: number;
  score: ZScore;
  slots: [WeaponId, WeaponId | null];
  cur: 0 | 1;
  mag: [number, number];
  res: [number, number];
  nades: number;
  reloadLeft: number;
  /** Time of the last shot, for the fire-rate check. */
  lastFire: number;
  knifeAt: number;
  lastSeq: number;
  lastQueued: number;
  credit: number;
  queue: ZInput[];
  lastInputAt: number;
  input: ZInput;
  useWas: boolean;
  /** Repair / revive in progress. */
  task: { kind: 'repair'; w: number } | { kind: 'revive'; id: string } | null;
  taskT: number;
  /** Board-repair points earned this wave (capped). */
  boardPts: number;
  bleed: number;
  brain?: SurvivorBot;
}

interface Zombie {
  id: number;
  pos: Vec3;
  yaw: number;
  hp: number;
  maxHp: number;
  state: ZState;
  t: number;
  speed: number;
  jogger: boolean;
  variant: number;
  gib: number;
  /** Window being torn at or vaulted through. */
  win: number;
  vaultFrom: Vec3;
  vaultTo: Vec3;
  bashCell: number;
  atkDone: boolean;
  atkCd: number;
  target: string | null;
  /** Recent positions with server time (seconds), for rewinding shots. */
  hist: { t: number; x: number; y: number; z: number; yaw: number }[];
  stuckT: number;
  stuckFrom: Vec3;
  groanAt: number;
}

interface Nade {
  id: number;
  by: string;
  body: NadeBody;
  fuse: number;
}

const IDLE: ZInput = { seq: 0, f: 0, s: 0, jump: false, sprint: false, ads: false, use: false, yaw: 0, pitch: 0 };
const IDLE_AFTER = 0.3;
const MAT_CODE = (m: ImpactMat) => IMPACT_MATS.indexOf(m);
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

class ZombiesGame implements GameServer {
  private readonly players = new Map<string, Survivor>();
  private readonly zombies: Zombie[] = [];
  private readonly nades: Nade[] = [];
  private readonly def: MapDef;
  private readonly world: World;
  private readonly nav: NavField;
  private readonly boards: number[];
  private boardsDirty = true;
  private wave = 0;
  private phase: 'break' | 'wave' = 'break';
  private phaseT: number = ZB.firstWaveDelay;
  private toSpawn = 0;
  private spawnT = 0;
  private now = 0;
  private tick = 0;
  private nextId = 1;
  private ended = false;
  private lostAt = -1;
  private events: ZEvent[] = [];
  private broken: number[] = [];
  private damaged = new Set<number>();
  private brokenAt: Vec3 = v(0, 0, 0);
  private brokenBlast = false;
  private navT = 0;
  private timer?: NodeJS.Timeout;
  private readonly rng = makeRng((Date.now() ^ 0x2bad5eed) >>> 0);
  private readonly scratch: number[] = [];

  constructor(private readonly host: GameHost) {
    // One map; the party size at the start decides how much of it is open (the wings stay shut for small groups).
    this.def = zmapById(host.settings.map);
    this.world = buildWorld(this.def, zonesFor(host.players().length, this.def));
    this.nav = new NavField(this.world);
    this.boards = this.world.windows.map(() => ZB.boardsPerWindow);
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------------

  start() {
    for (const p of this.host.players()) this.addPlayer(p);
    this.timer = setInterval(() => this.loop(), 1000 / ZB.loopHz);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  addPlayer(gp: GamePlayer) {
    if (this.players.has(gp.id)) return;
    const spawn = this.spawnPoint();
    const p: Survivor = {
      ...gp,
      body: { pos: spawn, vel: v(0, 0, 0), onGround: true },
      yaw: Math.atan2(spawn.x, spawn.z),
      pitch: 0,
      life: 0,
      hp: ZB.maxHealth,
      armor: 0,
      hurtAt: -99,
      points: ZB.startPoints,
      score: { id: gp.id, points: 0, kills: 0, heads: 0, downs: 0, revives: 0 },
      slots: [START_WEAPON, null],
      cur: 0,
      mag: [WEAPONS[START_WEAPON].mag, 0],
      res: [WEAPONS[START_WEAPON].reserve, 0],
      nades: 2,
      reloadLeft: 0,
      lastFire: -99,
      knifeAt: -99,
      lastSeq: 0,
      lastQueued: 0,
      credit: 0,
      queue: [],
      lastInputAt: 0,
      input: { ...IDLE },
      useWas: false,
      task: null,
      taskT: 0,
      boardPts: 0,
      bleed: 0,
    };
    if (gp.bot) p.brain = new SurvivorBot(this.host.botDifficulty(), makeRng(Math.floor(this.rng() * 1e9)));
    this.players.set(p.id, p);
    this.host.send(p.id, this.initMsg());
    this.host.broadcast({ k: 'score', scores: this.scores() });
  }

  removePlayer(id: string) {
    this.players.delete(id);
    for (const z of this.zombies) if (z.target === id) z.target = null;
    this.host.broadcast({ k: 'score', scores: this.scores() });
  }

  private initMsg(): ZombiesServerMsg {
    const down: number[] = [];
    const dmg: number[] = [];
    const w = this.world;
    for (let i = 0; i < w.chunks.length; i++) {
      if (!w.alive[i]) down.push(i);
      else if (!w.chunks[i].hard && w.hp[i] < w.chunks[i].maxHp) dmg.push(i, Math.round(w.hp[i]));
    }
    return { k: 'init', map: { id: this.def.id, name: this.def.name }, down, dmg, boards: [...this.boards], zones: [...this.world.open], wave: this.wave, scores: this.scores() };
  }

  private scores(): ZScore[] {
    return [...this.players.values()].map((p) => ({ ...p.score }));
  }

  private spawnPoint(): Vec3 {
    const taken = [...this.players.values()].filter((p) => p.life !== 2).map((p) => p.body.pos);
    const spots = this.world.spawns;
    let best = spots[0];
    let bestD = -1;
    for (const s of spots) {
      const d = taken.length ? Math.min(...taken.map((t) => hdist(t, s))) : 99;
      if (d > bestD) {
        bestD = d;
        best = s;
      }
    }
    return v(best.x, 0, best.z);
  }

  // ---- messages -------------------------------------------------------------------------------------------------

  onMessage(id: string, raw: GameClientMsg) {
    const p = this.players.get(id);
    if (!p || p.bot) return;
    const m = raw as ZombiesClientMsg;
    if (!m || typeof m !== 'object') return;
    switch (m.k) {
      case 'in':
        if (Array.isArray(m.i)) this.queueInputs(p, m.i);
        return;
      case 'fire': {
        if (!isWeaponId(m.w) || !Array.isArray(m.d) || !isTuple(m.o)) return;
        const dirs = m.d.filter(isTuple).slice(0, WEAPONS[m.w].pellets).map(unit);
        this.fire(p, m.w, fromT(m.o), dirs, Number(m.rt) || Date.now());
        return;
      }
      case 'reload':
        this.reload(p);
        return;
      case 'slot':
        this.switchSlot(p, m.s === 1 ? 1 : 0);
        return;
      case 'throw':
        if (isTuple(m.o) && isTuple(m.v)) this.throwNade(p, fromT(m.o), fromT(m.v));
        return;
      case 'knife':
        if (isTuple(m.o) && isTuple(m.d)) this.knife(p, fromT(m.o), unit(m.d), Number(m.rt) || Date.now());
        return;
    }
  }

  private queueInputs(p: Survivor, list: Partial<ZInput>[]) {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const seq = Math.floor(Number(raw.seq));
      if (!Number.isSafeInteger(seq) || seq <= p.lastQueued || seq > p.lastQueued + 120) continue;
      if (p.queue.length >= 30) break;
      p.lastQueued = seq;
      p.queue.push({
        seq,
        f: clamp(Number(raw.f) || 0, -1, 1),
        s: clamp(Number(raw.s) || 0, -1, 1),
        jump: !!raw.jump,
        sprint: !!raw.sprint,
        ads: !!raw.ads,
        use: !!raw.use,
        yaw: typeof raw.yaw === 'number' && Number.isFinite(raw.yaw) ? raw.yaw : p.yaw,
        pitch: clamp(Number(raw.pitch) || 0, -ZB.maxPitch, ZB.maxPitch),
      });
    }
  }

  // ---- main loop ------------------------------------------------------------------------------------------------

  private lastLoop = performance.now();
  private acc = 0;

  private loop() {
    if (this.ended) return;
    const nowMs = performance.now();
    this.acc += Math.min(0.25, (nowMs - this.lastLoop) / 1000);
    this.lastLoop = nowMs;
    let steps = 0;
    while (this.acc >= ZB.dt - 1e-9 && steps < 10) {
      this.acc -= ZB.dt;
      steps++;
      this.now += ZB.dt;
      for (const p of this.players.values()) if (p.brain) this.applyInput(p, p.brain.think(this.botView(p), p));
      for (const n of this.nades) stepNade(n.body, this.world);
    }
    if (steps === 0) return;
    const dt = steps * ZB.dt;
    this.tick++;
    for (const p of this.players.values()) {
      if (p.brain) continue;
      let n = 0;
      const cap = p.queue.length ? ZB.maxCommandsPerLoop + 2 : IDLE_AFTER / ZB.dt;
      p.credit = Math.min(p.credit + steps * 1.15, Math.max(cap, p.credit));
      while (p.queue.length && p.credit >= 1) {
        p.credit--;
        this.applyInput(p, p.queue.shift()!);
        p.lastInputAt = this.now;
        n++;
      }
      if (n === 0 && this.now - p.lastInputAt > IDLE_AFTER) for (let i = 0; i < steps; i++) this.applyInput(p, { ...IDLE, seq: p.lastSeq, yaw: p.yaw, pitch: p.pitch }, true);
    }
    for (const p of this.players.values()) this.updatePlayer(p, dt);
    this.updateNades(dt);
    this.updateDirector(dt);
    this.updateZombies(dt);
    this.flushDestruction();
    this.checkLoss();
    this.flush();
  }

  private applyInput(p: Survivor, inp: ZInput, idle = false) {
    p.yaw = inp.yaw;
    p.pitch = inp.pitch;
    if (!idle) {
      p.lastSeq = inp.seq;
      p.input = inp;
    }
    if (p.life === 2) return;
    stepPlayer(p.body, inp, this.world, p.life === 1);
  }

  // ---- players --------------------------------------------------------------------------------------------------

  private updatePlayer(p: Survivor, dt: number) {
    if (p.life === 2) return;
    if (p.life === 1) {
      p.bleed -= dt;
      if (p.bleed <= 0) {
        p.life = 2;
        this.events.push({ k: 'pdead', id: p.id });
      }
      p.task = null;
      return;
    }
    if (p.reloadLeft > 0) {
      p.reloadLeft -= dt;
      if (p.reloadLeft <= 0) this.finishReload(p);
    }
    if (this.now - p.hurtAt > ZB.regenDelay && p.hp < ZB.maxHealth) p.hp = Math.min(ZB.maxHealth, p.hp + ZB.regenRate * dt);
    // Use key: revive, repair (held), or buy (on press).
    const use = p.input.use;
    const pressed = use && !p.useWas;
    p.useWas = use;
    if (!use) {
      p.task = null;
      p.taskT = 0;
      return;
    }
    const pos = p.body.pos;
    const downed = [...this.players.values()].find((o) => o !== p && o.life === 1 && vdist(o.body.pos, pos) < ZB.useRange);
    if (downed) {
      if (p.task?.kind !== 'revive' || p.task.id !== downed.id) {
        p.task = { kind: 'revive', id: downed.id };
        p.taskT = 0;
      }
      p.taskT += dt / ZB.reviveTime;
      if (p.taskT >= 1) {
        downed.life = 0;
        downed.hp = ZB.maxHealth * 0.5;
        downed.hurtAt = this.now;
        p.score.revives++;
        this.award(p, ZB.pointsRevive, 'revive');
        this.events.push({ k: 'previve', id: downed.id, by: p.id });
        p.task = null;
        p.taskT = 0;
      }
      return;
    }
    const win = this.repairableWindow(pos);
    if (win >= 0) {
      if (p.task?.kind !== 'repair' || p.task.w !== win) {
        p.task = { kind: 'repair', w: win };
        p.taskT = 0;
      }
      p.taskT += dt / ZB.repairTime;
      if (p.taskT >= 1) {
        p.taskT = 0;
        this.boards[win]++;
        this.boardsDirty = true;
        this.events.push({ k: 'board', w: win, n: this.boards[win], a: 'fix' });
        if (p.boardPts < ZB.boardPointsCap) {
          p.boardPts += ZB.pointsBoard;
          this.award(p, ZB.pointsBoard, 'fix');
        }
        if (this.boards[win] >= ZB.boardsPerWindow) p.task = null;
      }
      return;
    }
    p.task = null;
    if (pressed) {
      const st = this.world.stations.find((s) => hdist(s.pos, pos) < ZB.useRange);
      if (st) this.buy(p, st.i);
    }
  }

  repairableWindow(pos: Vec3) {
    let best = -1;
    let bestD: number = ZB.useRange;
    for (const w of this.world.windows) {
      const d = hdist(w.inside, pos);
      if (d < bestD && w.active && this.boards[w.i] < ZB.boardsPerWindow && inside(this.world, pos.x, pos.z)) {
        bestD = d;
        best = w.i;
      }
    }
    return best;
  }

  private award(p: Survivor, n: number, why: 'hit' | 'kill' | 'head' | 'knife' | 'fix' | 'revive') {
    p.points += n;
    p.score.points += n;
    this.events.push({ k: 'pts', id: p.id, n, why });
  }

  private deny(p: Survivor, why: string) {
    this.events.push({ k: 'deny', id: p.id, why });
  }

  private buy(p: Survivor, si: number) {
    const st = this.world.stations[si];
    const pay = (cost: number, what: string) => {
      if (p.points < cost) {
        this.deny(p, `Need ${cost} points`);
        return false;
      }
      p.points -= cost;
      this.events.push({ k: 'buy', id: p.id, what, cost });
      return true;
    };
    switch (st.kind) {
      case 'weapon': {
        const w = WEAPONS[st.item!];
        const slot = p.slots.indexOf(w.id);
        if (slot >= 0) {
          if (p.res[slot] >= w.reserve && p.mag[slot] >= w.mag) return this.deny(p, 'Ammo is full');
          if (pay(w.ammoPrice, `${w.name} ammo`)) p.res[slot] = w.reserve;
          return;
        }
        if (!pay(w.price, w.name)) return;
        // A free slot first, else replace what is in hand.
        const into: 0 | 1 = p.slots[1] === null ? 1 : p.cur;
        p.slots[into] = w.id;
        p.mag[into] = w.mag;
        p.res[into] = w.reserve;
        p.cur = into;
        p.reloadLeft = 0;
        return;
      }
      case 'ammo': {
        let cost = 0;
        for (let s = 0; s < 2; s++) {
          const id = p.slots[s];
          if (id && p.res[s] < WEAPONS[id].reserve) cost += WEAPONS[id].ammoPrice;
        }
        cost = Math.round((cost * AMMO_CACHE_SHARE) / 10) * 10;
        if (cost === 0) return this.deny(p, 'Ammo is full');
        if (!pay(cost, 'Ammo')) return;
        for (let s = 0; s < 2; s++) {
          const id = p.slots[s];
          if (id) p.res[s] = WEAPONS[id].reserve;
        }
        return;
      }
      case 'crate': {
        const full = p.slots.every((id, s) => !id || p.res[s] >= WEAPONS[id].reserve);
        if (full) return this.deny(p, 'Ammo is full');
        if (!pay(AMMO_CRATE_PRICE, 'Ammo pack')) return;
        for (let s = 0; s < 2; s++) {
          const id = p.slots[s];
          if (id) p.res[s] = WEAPONS[id].reserve;
        }
        return;
      }
      case 'nades':
        if (p.nades >= ZB.nadeMax) return this.deny(p, 'Grenades are full');
        if (pay(NADE_PRICE, 'Frag grenades')) p.nades = ZB.nadeMax;
        return;
      case 'armor':
        if (p.armor >= ZB.armorMax) return this.deny(p, 'Armor is full');
        if (pay(ARMOR_PRICE, 'Body armor')) p.armor = ZB.armorMax;
        return;
    }
  }

  private reload(p: Survivor) {
    if (p.life === 2 || p.reloadLeft > 0) return;
    const id = p.slots[p.cur];
    if (!id) return;
    const w = WEAPONS[id];
    if (p.mag[p.cur] >= w.mag || p.res[p.cur] <= 0) return;
    const missing = w.mag - p.mag[p.cur];
    p.reloadLeft = w.perShell ? (w.reload / w.mag) * Math.min(missing, p.res[p.cur]) + 0.3 : w.reload;
  }

  private finishReload(p: Survivor) {
    p.reloadLeft = 0;
    const id = p.slots[p.cur];
    if (!id) return;
    const w = WEAPONS[id];
    const take = Math.min(w.mag - p.mag[p.cur], p.res[p.cur]);
    p.mag[p.cur] += take;
    p.res[p.cur] -= take;
  }

  private switchSlot(p: Survivor, s: 0 | 1) {
    if (s === p.cur || !p.slots[s]) return;
    p.cur = s;
    p.reloadLeft = 0;
    p.lastFire = this.now - 0.2;
  }

  // ---- shooting -------------------------------------------------------------------------------------------------

  /** Zombie position at server time `rt` (ms), from its history. */
  private rewound(z: Zombie, rt: number): { x: number; y: number; z: number; yaw: number } {
    const t = Math.max(this.now - ZB.maxRewind, Math.min(this.now, this.now - (Date.now() - rt) / 1000));
    const h = z.hist;
    if (!h.length || t >= h[h.length - 1].t) return { x: z.pos.x, y: z.pos.y, z: z.pos.z, yaw: z.yaw };
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1];
      const b = h[i];
      if (a.t <= t) {
        const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, yaw: b.yaw };
      }
    }
    return h[0];
  }

  /** Ray against a zombie at `at`: hit distance, head or not, and which side of the body (for limbs). */
  private rayZombie(o: Vec3, d: Vec3, z: Zombie, at: { x: number; y: number; z: number; yaw: number }, maxT: number) {
    // Head: a sphere, leaning forward with the zombie's hunch.
    const f = yawForward(at.yaw);
    const hx = at.x + f.x * 0.14;
    const hy = at.y + ZB.zombieHeadY;
    const hz = at.z + f.z * 0.14;
    let best = maxT;
    let head = false;
    if (!(z.gib & GIB.head)) {
      const t = raySphere(o, d, hx, hy, hz, ZB.zombieHeadR);
      if (t >= 0 && t < best) {
        best = t;
        head = true;
      }
    }
    // Body: a vertical capsule-ish cylinder.
    const t = rayCylinder(o, d, at.x, at.z, at.y, at.y + ZB.zombieBodyH, ZB.zombieBodyR, best);
    if (t >= 0 && t < best) {
      best = t;
      head = false;
    }
    if (best >= maxT) return null;
    const p = v(o.x + d.x * best, o.y + d.y * best, o.z + d.z * best);
    const r = yawRight(at.yaw);
    const side = (p.x - at.x) * r.x + (p.z - at.z) * r.z;
    return { t: best, head, p, side, h: p.y - at.y };
  }

  fire(p: Survivor, wid: WeaponId, origin: Vec3, dirs: Vec3[], rt: number) {
    if (p.life === 2 || this.ended) return;
    const slot = p.slots.indexOf(wid);
    if (slot !== p.cur || p.reloadLeft > 0 || p.mag[slot] <= 0 || !dirs.length) return;
    const w = WEAPONS[wid];
    // Fire rate, with slack for network jitter bunching shots up.
    if (this.now - p.lastFire < fireInterval(w) * 0.6) return;
    p.lastFire = this.now;
    p.mag[slot]--;
    const eye = v(p.body.pos.x, p.body.pos.y + eyeHeight(p.life === 1), p.body.pos.z);
    const o = vdist(origin, eye) < 1.2 ? origin : eye;
    const ends: [number, number, number, number][] = [];
    const dealt = new Map<Zombie, { dmg: number; head: boolean; p: Vec3; side: number; h: number }>();
    const range = 140;
    for (const d of dirs) {
      const wall = raycast(this.world, o, d, range);
      const wallT = wall ? wall.t : range;
      const hits: { z: Zombie; t: number; head: boolean; p: Vec3; side: number; h: number }[] = [];
      for (const z of this.zombies) {
        if (z.state === ZState.Rise && z.t < 0.5) continue;
        const at = this.rewound(z, rt);
        if (Math.abs(at.x - o.x) > wallT + 1 && Math.abs(at.z - o.z) > wallT + 1) continue;
        const h = this.rayZombie(o, d, z, at, wallT);
        if (h) hits.push({ z, ...h });
      }
      hits.sort((a, b) => a.t - b.t);
      let mult = 1;
      let endT = wallT;
      let endMat: ImpactMat = wall ? wall.mat : 'none';
      for (let k = 0; k < hits.length && k < w.pen; k++) {
        const h = hits[k];
        const dmg = w.damage * falloffAt(w, h.t) * mult * (h.head ? w.headMult : 1);
        const prev = dealt.get(h.z);
        if (prev) {
          prev.dmg += dmg;
          prev.head ||= h.head;
        } else dealt.set(h.z, { dmg, head: h.head, p: h.p, side: h.side, h: h.h });
        mult *= 0.72;
        if (k === w.pen - 1) {
          endT = h.t;
          endMat = 'flesh';
        }
      }
      if (endMat !== 'flesh' && wall && wall.chunk >= 0) this.hurtChunk(wall.chunk, w.world, o);
      ends.push([round2(o.x + d.x * endT), round2(o.y + d.y * endT), round2(o.z + d.z * endT), MAT_CODE(endMat)]);
    }
    this.events.push({ k: 'shot', id: p.id, w: wid, o: toTuple(o), e: ends });
    for (const [z, hit] of dealt) {
      const dir = unit([hit.p.x - o.x, 0, hit.p.z - o.z]);
      this.events.push({ k: 'zhit', z: z.id, p: toTuple(hit.p), head: hit.head ? 1 : 0, by: p.id });
      // A heavy hit to an arm takes it off; the zombie keeps coming.
      if (!hit.head && hit.dmg >= 90 && hit.h > 0.95 && hit.h < 1.45 && Math.abs(hit.side) > 0.17) z.gib |= hit.side > 0 ? GIB.armR : GIB.armL;
      const close = vdist(o, hit.p) < 4 && w.kind === 'shotgun';
      this.damageZombie(z, hit.dmg, p, hit.head, 'gun', dir, close ? (this.rng() < 0.5 ? GIB.armL : GIB.armR) : 0);
    }
  }

  private knife(p: Survivor, o: Vec3, d: Vec3, rt: number) {
    if (p.life !== 0 || this.now - p.knifeAt < ZB.knifeCooldown) return;
    p.knifeAt = this.now;
    this.events.push({ k: 'melee', id: p.id });
    let best: Zombie | null = null;
    let bestD: number = ZB.knifeRange;
    for (const z of this.zombies) {
      const at = this.rewound(z, rt);
      const dx = at.x - p.body.pos.x;
      const dz = at.z - p.body.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > bestD + 0.3) continue;
      if ((dx * d.x + dz * d.z) / Math.max(dist, 1e-3) < 0.55 && dist > 0.6) continue;
      best = z;
      bestD = dist;
    }
    if (best) {
      this.events.push({ k: 'zhit', z: best.id, p: toTuple(v(best.pos.x, 1.2, best.pos.z)), head: 0, by: p.id });
      this.damageZombie(best, ZB.knifeDamage, p, false, 'knife', d, 0);
      return;
    }
    const wall = raycast(this.world, o, d, ZB.knifeRange);
    if (wall && wall.chunk >= 0) this.hurtChunk(wall.chunk, 30, o);
  }

  private damageZombie(z: Zombie, dmg: number, by: Survivor | null, head: boolean, how: 'gun' | 'nade' | 'knife', dir: Vec3, gib: number) {
    if (z.hp <= 0) return;
    z.hp -= dmg;
    if (z.hp > 0) {
      if (by && how !== 'nade') this.award(by, ZB.pointsHit, 'hit');
      return;
    }
    const i = this.zombies.indexOf(z);
    if (i >= 0) this.zombies.splice(i, 1);
    let mask = z.gib | gib | (head ? GIB.head : 0);
    if (how === 'nade') for (const b of [GIB.armL, GIB.armR, GIB.legL, GIB.legR]) if (this.rng() < 0.45) mask |= b;
    this.events.push({ k: 'zdie', z: z.id, by: by?.id ?? '', head: head ? 1 : 0, gib: mask, how, dir: toTuple(dir) });
    if (by) {
      by.score.kills++;
      if (head) by.score.heads++;
      this.award(by, how === 'knife' ? ZB.pointsKnife : head ? ZB.pointsHead : ZB.pointsKill, how === 'knife' ? 'knife' : head ? 'head' : 'kill');
    }
  }

  // ---- grenades -------------------------------------------------------------------------------------------------

  private throwNade(p: Survivor, o: Vec3, vel: Vec3) {
    if (p.life !== 0 || p.nades <= 0) return;
    const eye = v(p.body.pos.x, p.body.pos.y + ZB.eyeHeight, p.body.pos.z);
    const from = vdist(o, eye) < 1.2 ? o : eye;
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    const k = speed > ZB.nadeSpeed * 1.3 ? (ZB.nadeSpeed * 1.3) / speed : 1;
    p.nades--;
    const n: Nade = { id: this.nextId++, by: p.id, body: { pos: from, vel: v(vel.x * k, vel.y * k, vel.z * k) }, fuse: ZB.nadeFuse };
    this.nades.push(n);
    this.events.push({ k: 'nade', id: n.id, by: p.id, o: toTuple(n.body.pos), v: toTuple(n.body.vel) });
  }

  private updateNades(dt: number) {
    for (let i = this.nades.length - 1; i >= 0; i--) {
      const n = this.nades[i];
      n.fuse -= dt;
      if (n.fuse > 0) continue;
      this.nades.splice(i, 1);
      this.explode(n);
    }
  }

  private explode(n: Nade) {
    const c = n.body.pos;
    const r = ZB.nadeRadius;
    this.events.push({ k: 'boom', id: n.id, p: toTuple(c) });
    const by = this.players.get(n.by) ?? null;
    // Grenades keep up with zombie health until the mid waves, then fall behind like everything else.
    const nadeBase = Math.max(ZB.nadeDamage, waveHealth(Math.min(this.wave, 12)) * 1.2);
    for (const z of [...this.zombies]) {
      const zc = v(z.pos.x, z.pos.y + 0.9, z.pos.z);
      const d = vdist(zc, c);
      if (d > r) continue;
      if (this.occluded(c, zc)) continue;
      const fall = 1 - d / r;
      this.damageZombie(z, nadeBase * (0.25 + 0.75 * fall), by, false, 'nade', unit([zc.x - c.x, 0.4, zc.z - c.z]), 0);
    }
    for (const p of this.players.values()) {
      if (p.life !== 0) continue;
      const pc = v(p.body.pos.x, p.body.pos.y + 0.9, p.body.pos.z);
      const d = vdist(pc, c);
      if (d > r || this.occluded(c, pc)) continue;
      this.hurtPlayer(p, ZB.nadeSelfDamage * (1 - d / r), c);
    }
    chunksInSphere(this.world, c, r * 0.8, (i, d) => this.hurtChunk(i, ZB.nadeWorldDamage * Math.pow(1 - d / (r * 0.8), 1.3), c, true));
    for (const w of this.world.windows) {
      const d = vdist(c, v(w.center.x, w.center.y + 0.7, w.center.z));
      if (d < 2.6 && this.boards[w.i] > 0) {
        this.boards[w.i] = Math.max(0, this.boards[w.i] - Math.ceil((1 - d / 2.6) * 5));
        this.boardsDirty = true;
        this.events.push({ k: 'board', w: w.i, n: this.boards[w.i], a: 'tear' });
      }
    }
  }

  private occluded(a: Vec3, b: Vec3) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.3) return false;
    const hit = raycast(this.world, a, v(dx / len, dy / len, dz / len), len - 0.25);
    return !!hit;
  }

  // ---- destruction ----------------------------------------------------------------------------------------------

  private hurtChunk(i: number, dmg: number, from: Vec3, blast = false) {
    if (damageChunk(this.world, i, dmg)) {
      this.broken.push(i);
      this.damaged.delete(i);
      this.brokenAt = from;
      if (blast) this.brokenBlast = true;
    } else if (!this.world.chunks[i].hard) this.damaged.add(i);
  }

  private flushDestruction() {
    if (this.damaged.size) {
      const c: number[] = [];
      for (const i of this.damaged) if (this.world.alive[i]) c.push(i, Math.round(this.world.hp[i]));
      if (c.length) this.events.push({ k: 'chp', c });
      this.damaged.clear();
    }
    if (!this.broken.length) return;
    const fallen = collapse(this.world);
    let navDirty = false;
    for (const i of this.broken) navDirty = this.nav.chunkChanged(i) || navDirty;
    for (const i of fallen) navDirty = this.nav.chunkChanged(i) || navDirty;
    this.events.push({ k: 'chunks', d: this.broken, f: fallen, at: toTuple(this.brokenAt), ...(this.brokenBlast ? { x: 1 as const } : {}) });
    this.broken = [];
    this.brokenBlast = false;
    // A new hole at body height is worth an early re-solve, but not one per shot while the glass is being shredded.
    if (navDirty) this.navT = Math.min(this.navT, 0.25);
  }

  // ---- waves ----------------------------------------------------------------------------------------------------

  private standing() {
    return [...this.players.values()].filter((p) => p.life === 0);
  }

  private updateDirector(dt: number) {
    if (this.lostAt >= 0) return;
    if (this.phase === 'break') {
      this.phaseT -= dt;
      if (this.phaseT > 0) return;
      this.wave++;
      this.phase = 'wave';
      this.toSpawn = waveCount(this.wave, this.players.size);
      this.spawnT = 1;
      for (const p of this.players.values()) {
        p.boardPts = 0;
        if (p.life === 2) this.respawn(p);
      }
      this.events.push({ k: 'wave', n: this.wave, count: this.toSpawn });
      return;
    }
    if (this.toSpawn > 0) {
      this.spawnT -= dt;
      if (this.spawnT <= 0 && this.zombies.length < ZB.maxZombiesAlive) {
        this.spawnZombie();
        this.toSpawn--;
        this.spawnT = spawnInterval(this.wave, this.players.size) * (0.6 + this.rng() * 0.8);
      }
    } else if (this.zombies.length === 0) {
      this.phase = 'break';
      this.phaseT = ZB.waveBreak;
      this.events.push({ k: 'clear', n: this.wave });
      this.host.broadcast({ k: 'score', scores: this.scores() });
    }
  }

  private respawn(p: Survivor) {
    p.life = 0;
    p.hp = ZB.maxHealth;
    p.body.pos = this.spawnPoint();
    p.body.vel = v(0, 0, 0);
    this.events.push({ k: 'pspawn', id: p.id, p: toTuple(p.body.pos) });
  }

  private spawnZombie() {
    // Rise outside one of the windows nearest the survivors (a random one of the closest few).
    const alive = this.standing();
    const ws = this.world.windows
      .filter((w) => w.active)
      .map((w) => ({ w, d: alive.length ? Math.min(...alive.map((p) => hdist(p.body.pos, w.outside))) : 0 }))
      .sort((a, b) => a.d - b.d);
    const pool = ws.slice(0, Math.max(3, Math.ceil(ws.length / 2)));
    const w = pool[Math.floor(this.rng() * pool.length)].w;
    const s = w.spawns[Math.floor(this.rng() * w.spawns.length)];
    const pos = v(s.x + (this.rng() - 0.5) * 1.6, 0, s.z + (this.rng() - 0.5) * 1.6);
    const jogger = this.rng() < joggerShare(this.wave);
    const hp = waveHealth(this.wave);
    const z: Zombie = {
      id: this.nextId++,
      pos,
      yaw: Math.atan2(w.out.x, w.out.z),
      hp,
      maxHp: hp,
      state: ZState.Rise,
      t: 0,
      speed: jogger ? 1.9 + this.rng() * 0.6 : 0.75 + this.rng() * 0.5 + Math.min(0.25, this.wave * 0.02),
      jogger,
      variant: Math.floor(this.rng() * 1024),
      gib: 0,
      win: -1,
      vaultFrom: v(0, 0, 0),
      vaultTo: v(0, 0, 0),
      bashCell: -1,
      atkDone: false,
      atkCd: 0,
      target: null,
      hist: [],
      stuckT: 0,
      stuckFrom: { ...pos },
      groanAt: 0,
    };
    this.zombies.push(z);
  }

  private checkLoss() {
    if (this.ended || this.wave === 0 || this.players.size === 0) return;
    const anyStanding = this.standing().length > 0;
    if (anyStanding) {
      this.lostAt = -1;
      return;
    }
    if (this.lostAt < 0) this.lostAt = this.now;
    if (this.now - this.lostAt < 2.5) return;
    this.ended = true;
    const scores = this.scores();
    let winner: string | null = null;
    let best = -1;
    for (const s of scores)
      if (s.points > best) {
        best = s.points;
        winner = s.id;
      }
    this.flush();
    this.host.broadcast({ k: 'end', scores, winner, wave: this.wave });
    this.host.systemChat(`Overrun on wave ${this.wave} in ${this.def.name}.`);
    this.stop();
    this.host.matchEnded();
  }

  // ---- zombies --------------------------------------------------------------------------------------------------

  private hurtPlayer(p: Survivor, dmg: number, from: Vec3) {
    if (p.life !== 0) return;
    if (p.armor > 0) {
      const soak = Math.min(p.armor, dmg * ZB.armorShare);
      p.armor -= soak;
      dmg -= soak;
    }
    p.hp -= dmg;
    p.hurtAt = this.now;
    this.events.push({ k: 'phurt', id: p.id, dmg: Math.round(dmg), from: toTuple(from) });
    if (p.hp <= 0) {
      p.hp = 0;
      p.life = 1;
      p.bleed = ZB.bleedOut;
      p.reloadLeft = 0;
      p.score.downs++;
      p.task = null;
      // Downed players keep a pistol; CoD's last stand.
      this.events.push({ k: 'pdown', id: p.id });
    }
  }

  private updateZombies(dt: number) {
    const standing = this.standing();
    this.navT -= dt;
    if (this.navT <= 0) {
      // A solve over the whole hotel takes ~3 ms; twice a second is plenty for zombies this slow.
      this.navT = 0.5;
      this.nav.solve(
        standing.map((p) => p.body.pos),
        this.boards,
      );
    }
    for (const z of this.zombies) {
      z.t += dt;
      z.atkCd -= dt;
      this.thinkZombie(z, standing, dt);
      z.hist.push({ t: this.now, x: z.pos.x, y: z.pos.y, z: z.pos.z, yaw: z.yaw });
      if (z.hist.length > 12) z.hist.shift();
    }
    // Keep zombies apart and off the players.
    const zs = this.zombies;
    for (let i = 0; i < zs.length; i++) {
      const a = zs[i];
      if (a.state === ZState.Vault || a.state === ZState.Rise) continue;
      for (let j = i + 1; j < zs.length; j++) {
        const b = zs[j];
        if (b.state === ZState.Vault || b.state === ZState.Rise) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        const min = ZB.zombieRadius * 2;
        if (d < min && d > 1e-4) {
          const push = ((min - d) / d) * 0.5;
          this.moveZombie(a, -dx * push, -dz * push);
          this.moveZombie(b, dx * push, dz * push);
        }
      }
      for (const p of standing) {
        const dx = a.pos.x - p.body.pos.x;
        const dz = a.pos.z - p.body.pos.z;
        const d = Math.hypot(dx, dz);
        const min = ZB.zombieRadius + ZB.halfWidth + 0.15;
        if (d < min && d > 1e-4) this.moveZombie(a, (dx / d) * (min - d), (dz / d) * (min - d));
      }
    }
  }

  /** Moves a zombie with collision against walls and props (separate axes, so it slides). */
  private moveZombie(z: Zombie, dx: number, dz: number) {
    // Slimmer against the world than against each other, so a zombie fits the 0.5 m nav cells it walks along.
    const r = ZB.zombieRadius * 0.8;
    const box = (x: number, zz: number) => ({ min: v(x - r, 0.05, zz - r), max: v(x + r, 1.7, zz + r) });
    if (dx && !firstBlock(this.world, box(z.pos.x + dx, z.pos.z), 'zombie')) z.pos.x += dx;
    if (dz && !firstBlock(this.world, box(z.pos.x, z.pos.z + dz), 'zombie')) z.pos.z += dz;
  }

  private turnTo(z: Zombie, yaw: number, dt: number, rate = 3.5) {
    let d = yaw - z.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    z.yaw += clamp(d, -rate * dt, rate * dt);
  }

  private setState(z: Zombie, s: ZState) {
    z.state = s;
    z.t = 0;
  }

  private nearest(z: Zombie, standing: Survivor[]) {
    let best: Survivor | null = null;
    let bestD = Infinity;
    for (const p of standing) {
      const d = hdist(p.body.pos, z.pos) + Math.abs(p.body.pos.y - z.pos.y) * 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return { p: best, d: bestD };
  }

  private thinkZombie(z: Zombie, standing: Survivor[], dt: number) {
    const crawl = (z.gib & (GIB.legL | GIB.legR)) !== 0;
    const speed = z.speed * (crawl ? 0.45 : 1);
    const { p: target, d: targetD } = this.nearest(z, standing);
    z.target = target?.id ?? null;
    const canSwing = (reach: number = ZB.zombieReach) => target && targetD < reach && Math.abs(target.body.pos.y - z.pos.y) < 1.2 && z.atkCd <= 0;
    switch (z.state) {
      case ZState.Rise:
        if (z.t >= ZB.riseTime) this.setState(z, ZState.Walk);
        return;
      case ZState.Vault: {
        const k = Math.min(1, z.t / ZB.vaultTime);
        z.pos.x = z.vaultFrom.x + (z.vaultTo.x - z.vaultFrom.x) * k;
        z.pos.z = z.vaultFrom.z + (z.vaultTo.z - z.vaultFrom.z) * k;
        // Over a window sill in an arc; through a doorway on the level.
        z.pos.y = this.world.windows[z.win]?.door ? 0 : Math.sin(k * Math.PI) * 1.05;
        if (k >= 1) {
          z.pos.y = 0;
          this.setState(z, ZState.Walk);
        }
        return;
      }
      case ZState.Attack: {
        if (target) this.turnTo(z, Math.atan2(-(target.body.pos.x - z.pos.x), -(target.body.pos.z - z.pos.z)), dt, 5);
        if (!z.atkDone && z.t >= ZB.zombieWindup) {
          z.atkDone = true;
          if (target && targetD < (z.win >= 0 && !inside(this.world, z.pos.x, z.pos.z) ? 2.2 : ZB.zombieReach + 0.45)) this.hurtPlayer(target, ZB.zombieDamage * (z.jogger ? 1.1 : 1), v(z.pos.x, 1.2, z.pos.z));
        }
        if (z.t >= ZB.zombieWindup + 0.45) {
          z.atkCd = ZB.zombieAttackCd - 0.45;
          this.setState(z, z.win >= 0 && this.boards[z.win] > 0 && !inside(this.world, z.pos.x, z.pos.z) ? ZState.Tear : ZState.Walk);
        }
        return;
      }
      case ZState.Tear: {
        const w = this.world.windows[z.win];
        if (!w) return this.setState(z, ZState.Walk);
        // Face the window: inwards from outside, outwards from inside.
        const zin = inside(this.world, z.pos.x, z.pos.z);
        this.turnTo(z, zin ? Math.atan2(-w.out.x, -w.out.z) : Math.atan2(w.out.x, w.out.z), dt);
        // Reaching through the window at whoever stands behind the boards.
        if (canSwing(1.95)) return this.startAttack(z);
        if (this.boards[z.win] <= 0) return this.setState(z, ZState.Walk);
        if (z.t >= ZB.tearTime * (crawl ? 1.5 : 1)) {
          z.t = 0;
          this.boards[z.win]--;
          this.boardsDirty = true;
          this.events.push({ k: 'board', w: z.win, n: this.boards[z.win], a: 'tear' });
        }
        return;
      }
      case ZState.Bash: {
        const cell = z.bashCell;
        const c = this.nav.center(cell);
        this.turnTo(z, Math.atan2(-(c.x - z.pos.x), -(c.z - z.pos.z)), dt);
        if (canSwing()) return this.startAttack(z);
        const chunks = this.nav.bashChunks(cell, this.scratch);
        if (!chunks.length || z.t > 3) return this.setState(z, ZState.Walk);
        // The lowest chunk takes the beating; once it breaks, the rest above it follow or hang.
        let low = chunks[0];
        for (const j of chunks) if (this.world.chunks[j].min.y < this.world.chunks[low].min.y) low = j;
        this.hurtChunk(low, ZB.bashDps * dt, v(z.pos.x, 1, z.pos.z));
        if (!this.world.alive[low]) z.t = 0;
        return;
      }
      case ZState.Walk: {
        if (canSwing()) return this.startAttack(z);
        let tx = 0;
        let tz = 0;
        const zin = inside(this.world, z.pos.x, z.pos.z);
        const tin = target ? inside(this.world, target.body.pos.x, target.body.pos.z) : false;
        if (target && targetD < 2.2 && zin === tin && !this.occluded(v(z.pos.x, 1, z.pos.z), v(target.body.pos.x, 1, target.body.pos.z))) {
          tx = target.body.pos.x - z.pos.x;
          tz = target.body.pos.z - z.pos.z;
        } else {
          const c = this.nav.cellOf(z.pos.x, z.pos.z);
          const n = this.nav.next(c);
          if (n < 0) {
            // Nobody to chase (everyone down) or boxed in: drift towards the room.
            tx = -z.pos.x;
            tz = -z.pos.z;
          } else {
            const kind = this.nav.kind[n];
            if (kind === Kind.Window) {
              const w = this.world.windows[this.nav.win[n]];
              const from = zin ? w.inside : w.outside;
              const to = zin ? w.outside : w.inside;
              const dd = hdist(z.pos, from);
              const boarded = this.boards[w.i] > 0;
              // A crowd at a boarded window all reach in and pull (CoD style), so nobody queues behind the first one.
              if (boarded && dd < 0.95) {
                z.win = w.i;
                return this.setState(z, ZState.Tear);
              }
              if (!boarded && dd < 0.85) {
                z.win = w.i;
                z.vaultFrom = { ...z.pos };
                // Keep the sideways offset (within the frame), so a crowd climbs through side by side.
                const px = w.out.z;
                const pz = -w.out.x;
                const lat = clamp((z.pos.x - from.x) * px + (z.pos.z - from.z) * pz, -0.4, 0.4);
                z.vaultTo = v(to.x + px * lat, 0, to.z + pz * lat);
                z.yaw = Math.atan2(-(to.x - from.x), -(to.z - from.z));
                return this.setState(z, ZState.Vault);
              }
              tx = from.x - z.pos.x;
              tz = from.z - z.pos.z;
            } else if (kind === Kind.Bash) {
              const cc = this.nav.center(n);
              if (hdist(z.pos, cc) < 0.62) {
                z.bashCell = n;
                return this.setState(z, ZState.Bash);
              }
              tx = cc.x - z.pos.x;
              tz = cc.z - z.pos.z;
            } else {
              // Aim two cells ahead when the path continues straight, so the walk is not a staircase.
              const n2 = this.nav.next(n);
              const cc = this.nav.center(n2 >= 0 && this.nav.kind[n2] === Kind.Free ? n2 : n);
              tx = cc.x - z.pos.x;
              tz = cc.z - z.pos.z;
            }
          }
        }
        const len = Math.hypot(tx, tz);
        if (len > 1e-3) {
          const yaw = Math.atan2(-tx, -tz);
          this.turnTo(z, yaw, dt, z.jogger ? 5 : 3);
          // Walk where we face (zombies cannot strafe); turning on the spot when the goal is behind.
          const f = yawForward(z.yaw);
          const facing = Math.max(0, (f.x * tx + f.z * tz) / len);
          const step = speed * dt * (0.25 + 0.75 * facing);
          this.moveZombie(z, f.x * step, f.z * step);
        }
        // Stuck on a corner: a sideways shove now and then.
        z.stuckT += dt;
        if (z.stuckT > 2) {
          if (hdist(z.stuckFrom, z.pos) < 0.15) {
            // Pressed in the crowd beside a boarded window: claw at it with the others instead of walking in place.
            if (!zin) {
              const w = this.world.windows.find((win) => win.active && this.boards[win.i] > 0 && hdist(win.outside, z.pos) < 2.4);
              if (w) {
                z.win = w.i;
                z.stuckT = 0;
                return this.setState(z, ZState.Tear);
              }
            }
            const r = yawRight(z.yaw);
            const s = this.rng() < 0.5 ? -0.3 : 0.3;
            this.moveZombie(z, r.x * s, r.z * s);
          }
          z.stuckT = 0;
          z.stuckFrom = { ...z.pos };
        }
        return;
      }
    }
  }

  private startAttack(z: Zombie) {
    z.atkDone = false;
    this.setState(z, ZState.Attack);
    this.events.push({ k: 'zatk', z: z.id });
  }

  // ---- bots -----------------------------------------------------------------------------------------------------

  private botView(p: Survivor): BotView {
    return {
      now: this.now,
      wave: this.wave,
      world: this.world,
      zombies: this.zombies,
      players: this.players,
      boards: this.boards,
      fire: (dirs) => this.fire(p, p.slots[p.cur]!, v(p.body.pos.x, p.body.pos.y + eyeHeight(p.life === 1), p.body.pos.z), dirs, Date.now()),
      reload: () => this.reload(p),
      switchSlot: (s) => this.switchSlot(p, s),
      knife: (d) => this.knife(p, v(p.body.pos.x, p.body.pos.y + ZB.eyeHeight, p.body.pos.z), d, Date.now()),
      repairable: (pos) => this.repairableWindow(pos),
    };
  }

  // ---- snapshots ------------------------------------------------------------------------------------------------

  private flush() {
    if (this.events.length) {
      this.host.broadcast({ k: 'ev', e: this.events });
      this.events = [];
    }
    const pl: ZPlayerSnap[] = [];
    for (const p of this.players.values()) {
      const id = p.slots[p.cur];
      const s: ZPlayerSnap = {
        id: p.id,
        p: toTuple(p.body.pos),
        v: toTuple(p.body.vel),
        y: round3(p.yaw),
        pt: round3(p.pitch),
        st: p.life,
        w: id!,
      };
      if (p.input.ads) s.a = 1;
      if (p.reloadLeft > 0) s.r = 1;
      if (p.input.sprint && p.input.f > 0) s.sp = 1;
      if (p.task) s.u = 1;
      pl.push(s);
    }
    const zb: ZombieSnap[] = this.zombies.map((z) => ({
      id: z.id,
      p: [round2(z.pos.x), round2(z.pos.y), round2(z.pos.z)],
      y: round2(z.yaw),
      s: z.state,
      a: round2(stateProgress(z)),
      v: z.variant,
      j: z.jogger ? 1 : 0,
      g: z.gib,
    }));
    const bd = this.boardsDirty || this.tick % 30 === 0 ? [...this.boards] : undefined;
    this.boardsDirty = false;
    const left = this.phase === 'break' ? Math.max(0, Math.ceil(this.phaseT)) : this.toSpawn + this.zombies.length;
    for (const p of this.players.values()) {
      if (p.bot) continue;
      const me: MeSnap = {
        seq: p.lastSeq,
        hp: Math.round(p.hp),
        ar: Math.round(p.armor),
        pts: p.points,
        sl: [p.slots[0], p.slots[1]],
        cur: p.cur,
        mag: [p.mag[0], p.mag[1]],
        res: [p.res[0], p.res[1]],
        nd: p.nades,
        rl: round2(Math.max(0, p.reloadLeft)),
      };
      if (p.life === 1) me.bo = round2(p.bleed);
      if (p.task) me.pr = round2(Math.min(1, p.taskT));
      this.host.send(p.id, { k: 'snap', s: { tick: this.tick, t: Date.now(), wave: this.wave, ph: this.phase, left, pl, zb, ...(bd ? { bd } : {}), me } });
    }
  }
}

function stateProgress(z: Zombie) {
  switch (z.state) {
    case ZState.Rise:
      return Math.min(1, z.t / ZB.riseTime);
    case ZState.Vault:
      return Math.min(1, z.t / ZB.vaultTime);
    case ZState.Attack:
      return Math.min(1, z.t / (ZB.zombieWindup + 0.45));
    case ZState.Tear:
      return Math.min(1, z.t / ZB.tearTime);
    default:
      return 0;
  }
}

// ---- small helpers --------------------------------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const isTuple = (t: unknown): t is Vec3Tuple => Array.isArray(t) && t.length === 3 && t.every((n) => typeof n === 'number' && Number.isFinite(n));
const fromT = (t: Vec3Tuple): Vec3 => v(t[0], t[1], t[2]);
function unit(t: Vec3Tuple | Vec3): Vec3 {
  const x = Array.isArray(t) ? t[0] : t.x;
  const y = Array.isArray(t) ? t[1] : t.y;
  const z = Array.isArray(t) ? t[2] : t.z;
  const l = Math.hypot(x, y, z) || 1;
  return v(x / l, y / l, z / l);
}

function raySphere(o: Vec3, d: Vec3, cx: number, cy: number, cz: number, r: number) {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}

/** Ray against a vertical cylinder (open ends are fine: bullets come from the side). */
function rayCylinder(o: Vec3, d: Vec3, cx: number, cz: number, y0: number, y1: number, r: number, maxT: number) {
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return -1;
  const b = ox * d.x + oz * d.z;
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  if (t < 0 || t > maxT) return -1;
  const y = o.y + d.y * t;
  return y >= y0 && y <= y1 ? t : -1;
}

export function createZombiesGame(host: GameHost): GameServer {
  return new ZombiesGame(host);
}
