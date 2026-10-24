// Rockets client: first-person view with client-side prediction for the local player, interpolation for everyone
// else, extrapolated rockets, and a few effects. The server is authoritative; this only predicts and shows.

import * as THREE from 'three';
import { clamp, fromTuple, hdist, lookDir, type Vec3, v3, vadd, vscale, vsub } from '@shared/math';
import type { GameServerMsg, RoomView } from '@shared/protocol';
import { RK } from '@shared/rockets/constants';
import type { MapData } from '@shared/rockets/map';
import { type Body, eyePosition, stepBody } from '@shared/rockets/physics';
import type { PlayerSnap, RocketsEvent, RocketsInput, RocketsServerMsg, RocketsSnapshot, ScoreRow } from '@shared/rockets/protocol';
import { sfx } from '../../engine/audio';
import { Effects } from '../../engine/effects';
import { Engine, colorHex, makeLabel } from '../../engine/engine';
import { Input } from '../../engine/input';
import { INTERP_DELAY, SnapshotBuffer, damp, lerpAngle } from '../../engine/interp';
import { boxFallback, capsuleFallback, instantiate, loadModel, sphereFallback } from '../../engine/models';
import { type ClientContext, type GameClient, createStore } from '../types';
import { type ArenaView, addArenaLights, buildArena } from './arena';

export interface FeedLine {
  id: number;
  text: string;
  at: number;
}

export interface RocketsHudState {
  ready: boolean;
  /** Name of the map this match is on. */
  mapName: string;
  hp: number;
  dead: boolean;
  respawnIn: number;
  left: number;
  scores: ScoreRow[];
  feed: FeedLine[];
  hitAt: number;
  hurtAt: number;
  locked: boolean;
  dragLook: boolean;
  paused: boolean;
  ended: { scores: ScoreRow[]; winner: string | null } | null;
  message: string;
}

interface Remote {
  group: THREE.Group;
  label: THREE.Sprite;
  color: number;
  name: string;
  bob: number;
}

interface RocketView {
  group: THREE.Group;
  pos: Vec3;
  vel: Vec3;
  /** performance.now()/1000 when pos/vel were last set. */
  at: number;
  confirmed: boolean;
  born: number;
  light: THREE.PointLight;
}

type Models = Awaited<ReturnType<RocketsClient['loadModels']>>;

const ROCKET_COLOR = 0xffa14a;

export class RocketsClient implements GameClient {
  readonly hud = createStore<RocketsHudState>({
    ready: false,
    mapName: '',
    hp: 100,
    dead: false,
    respawnIn: 0,
    left: RK.matchSeconds,
    scores: [],
    feed: [],
    hitAt: 0,
    hurtAt: 0,
    locked: false,
    dragLook: false,
    paused: false,
    ended: null,
    message: '',
  });

  private engine?: Engine;
  private input?: Input;
  private effects?: Effects;
  private arena?: ArenaView;
  private map?: MapData;
  private models: Models | null = null;
  private readonly snaps = new SnapshotBuffer<RocketsSnapshot>();
  private readonly remotes = new Map<string, Remote>();
  private readonly rockets = new Map<string, RocketView>();
  private readonly packs: THREE.Group[] = [];
  private viewmodel?: THREE.Group;
  private readonly me = {
    body: { pos: v3(0, 50, 0), vel: v3(), onGround: false } as Body,
    yaw: 0,
    pitch: 0,
    seq: 0,
    pending: [] as RocketsInput[],
    dead: true,
    nextFire: 0,
    smooth: v3(),
    deathPos: null as Vec3 | null,
    respawnAt: 0,
  };
  private acc = 0;
  private outbox: RocketsInput[] = [];
  private lastSend = 0;
  private recoil = 0;
  private bob = 0;
  private shake = 0;
  private feedId = 0;
  private paused = false;
  private lastHud = 0;
  private time = 0;
  private serverLeft: number = RK.matchSeconds;
  private serverLeftAt = 0;
  private disposed = false;

  constructor(private readonly ctx: ClientContext) {}

  // ---- lifecycle --------------------------------------------------------------------------------------------

  mount(container: HTMLElement) {
    const engine = new Engine(container, { fov: 82, near: 0.05, far: 200 });
    this.engine = engine;
    engine.camera.rotation.order = 'YXZ';
    this.input = new Input(engine.renderer.domElement);
    this.effects = new Effects(engine.scene);
    sfx.unlock();
    void this.loadModels().then((m) => {
      if (this.disposed) return;
      this.models = m;
      this.buildViewmodel();
      if (this.map) this.buildWorld();
      this.hud.set({ ready: true });
    });
    engine.start((dt, now) => this.frame(dt, now));
  }

  unmount() {
    this.disposed = true;
    this.input?.dispose();
    this.effects?.dispose();
    this.arena?.dispose();
    this.engine?.dispose();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (this.input) {
      this.input.enabled = !paused;
      if (paused) this.input.exitLock();
      this.input.clearOnce();
    }
    this.hud.set({ paused });
  }

  onRoom(room: RoomView) {
    for (const p of room.players) {
      const r = this.remotes.get(p.id);
      if (r && (r.name !== p.name || r.color !== p.color)) {
        this.engine?.scene.remove(r.group);
        this.remotes.delete(p.id);
      }
    }
  }

  private async loadModels() {
    const [droid, launcher, rocket, healthpack] = await Promise.all([loadModel('droid'), loadModel('launcher'), loadModel('rocket'), loadModel('healthpack')]);
    return { droid, launcher, rocket, healthpack };
  }

  // ---- messages -----------------------------------------------------------------------------------------------

  onMessage(m: GameServerMsg) {
    const msg = m as RocketsServerMsg;
    switch (msg.k) {
      case 'init':
        this.map = msg.map;
        this.serverLeft = msg.left;
        this.serverLeftAt = this.time;
        this.hud.set({ scores: msg.scores, left: msg.left, mapName: msg.map.name });
        if (this.engine && this.models) this.buildWorld();
        break;
      case 'snap':
        this.onSnapshot(msg.s);
        break;
      case 'ev':
        for (const e of msg.e) this.onEvent(e);
        break;
      case 'score':
        this.hud.set({ scores: msg.scores });
        break;
      case 'end':
        this.hud.set({ ended: { scores: msg.scores, winner: msg.winner }, scores: msg.scores });
        this.input?.exitLock();
        if (msg.winner === this.ctx.you) sfx.play('win');
        break;
    }
  }

  private onSnapshot(s: RocketsSnapshot) {
    this.snaps.push(s);
    this.snaps.trim(1);
    this.serverLeft = s.left;
    this.serverLeftAt = this.time;
    const own = s.pl.find((p) => p.id === this.ctx.you);
    if (own) this.reconcile(own);
    for (let i = 0; i < this.packs.length; i++) this.packs[i].visible = s.pk.includes(i);
    const now = performance.now() / 1000;
    const seen = new Set<string>();
    for (const r of s.rk) {
      seen.add(r.id);
      const view = this.rockets.get(r.id) ?? this.spawnRocket(r.id, fromTuple(r.p), fromTuple(r.v), true);
      view.pos = fromTuple(r.p);
      view.vel = fromTuple(r.v);
      view.at = now;
      view.confirmed = true;
    }
    for (const [id, view] of this.rockets) {
      if (view.confirmed && !seen.has(id)) this.removeRocket(id);
      else if (!view.confirmed && now - view.born > 0.6) this.removeRocket(id);
    }
  }

  private reconcile(own: PlayerSnap) {
    const me = this.me;
    const wasDead = me.dead;
    me.dead = own.d === 1;
    if (!this.map) return;
    if (me.dead) {
      me.deathPos ??= { ...me.body.pos };
      me.pending = [];
      return;
    }
    if (wasDead) {
      // Fresh spawn: take the server's view direction and position outright.
      me.yaw = own.y;
      me.pitch = own.pt;
      me.body.pos = fromTuple(own.p);
      me.body.vel = fromTuple(own.v);
      me.body.onGround = own.g === 1;
      me.smooth = v3();
      me.deathPos = null;
      me.pending = [];
      return;
    }
    const before = { ...me.body.pos };
    me.body.pos = fromTuple(own.p);
    me.body.vel = fromTuple(own.v);
    me.body.onGround = own.g === 1;
    if (own.seq !== undefined) me.pending = me.pending.filter((i) => i.seq > own.seq!);
    for (const i of me.pending) stepBody(me.body, i, this.map);
    const err = vsub(before, me.body.pos);
    const len = Math.hypot(err.x, err.y, err.z);
    // Small corrections are eased in visually; big ones (teleports, knockback) snap.
    if (len < 2.5) me.smooth = vadd(me.smooth, err);
    else me.smooth = v3();
  }

  private onEvent(e: RocketsEvent) {
    const you = this.ctx.you;
    const eye = eyePosition(this.me.body.pos);
    const dist = (p: Vec3) => hdist(eye, p);
    switch (e.k) {
      case 'fire': {
        if (e.o === you) break;
        const pos = fromTuple(e.p);
        if (!this.rockets.has(e.id)) this.spawnRocket(e.id, pos, fromTuple(e.v), true);
        sfx.play('fire', dist(pos));
        break;
      }
      case 'boom': {
        const pos = fromTuple(e.p);
        this.removeRocket(e.id);
        this.effects?.burst(pos, ROCKET_COLOR, 50, 8, 0.7, 0.5);
        this.effects?.burst(pos, 0xfff2cc, 16, 4, 0.35, 0.2);
        this.effects?.flash(pos, 0xffb070, 1.3, 0.3, 30);
        const d = dist(pos);
        sfx.play('boom', d);
        if (d < 8) this.shake = Math.max(this.shake, (1 - d / 8) * 0.6);
        break;
      }
      case 'hurt':
        if (e.id === you) {
          this.hud.set({ hurtAt: this.time, hp: Math.max(0, this.hud.get().hp - e.dmg) });
          sfx.play('hurt');
        } else if (e.by === you) {
          this.hud.set({ hitAt: this.time });
          sfx.play('hit');
        }
        break;
      case 'kill': {
        const victim = this.name(e.v);
        const text = e.self ? `${victim} blew ${e.v === you ? 'yourself' : 'themselves'} up` : `${this.name(e.by)} rocketed ${victim}`;
        this.feed(text);
        const r = this.remotes.get(e.v);
        if (r) this.effects?.burst(vadd(r.group.position, v3(0, 1, 0)), r.color, 40, 6, 1, 0.6);
        if (e.v === you) {
          sfx.play('die');
          this.me.respawnAt = this.time + RK.respawnDelay;
          this.hud.set({ dead: true, hp: 0 });
        }
        break;
      }
      case 'spawn': {
        const pos = fromTuple(e.p);
        this.effects?.burst(vadd(pos, v3(0, 1, 0)), 0xffffff, 25, 3, 0.6, 0.8);
        if (e.id === you) {
          sfx.play('spawn');
          this.hud.set({ dead: false, hp: RK.maxHealth });
        } else sfx.play('spawn', dist(pos));
        break;
      }
      case 'pack': {
        const pos = this.map?.packs[e.i];
        if (pos) this.effects?.burst(vadd(pos, v3(0, 0.6, 0)), 0x7cf4c9, 20, 3, 0.5, 1);
        if (e.by === you) {
          sfx.play('pickup');
          this.hud.set({ hp: Math.min(RK.maxHealth, this.hud.get().hp + RK.healthPackAmount) });
        } else if (pos) sfx.play('pickup', dist(pos));
        break;
      }
      case 'pad': {
        if (e.id === you) break;
        const r = this.remotes.get(e.id);
        if (r) sfx.play('pad', dist(r.group.position));
        break;
      }
    }
  }

  private name(id: string) {
    return this.ctx.room().players.find((p) => p.id === id)?.name ?? 'someone';
  }

  private feed(text: string) {
    const line = { id: ++this.feedId, text, at: this.time };
    this.hud.set((s) => ({ feed: [...s.feed.slice(-5), line] }));
  }

  // ---- world ---------------------------------------------------------------------------------------------------

  private buildWorld() {
    const { engine, map, models } = this;
    if (!engine || !map || !models || this.arena) return;
    addArenaLights(engine.scene, map);
    this.arena = buildArena(map);
    engine.scene.add(this.arena.group);
    for (const pos of map.packs) {
      const pack = instantiate(models.healthpack, undefined, () => boxFallback(0x7cf4c9, 0.5));
      pack.position.set(pos.x, pos.y + 0.3, pos.z);
      engine.scene.add(pack);
      this.packs.push(pack);
    }
  }

  private buildViewmodel() {
    const { engine, models } = this;
    if (!engine || !models) return;
    const vm = instantiate(models.launcher, undefined, () => {
      const m = boxFallback(0x444c5c, 0.2);
      m.scale.set(1, 1, 4);
      return m;
    });
    vm.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = false;
        mesh.frustumCulled = false;
      }
    });
    vm.scale.setScalar(0.55);
    vm.position.set(0.3, -0.28, -0.5);
    engine.camera.add(vm);
    engine.scene.add(engine.camera);
    const glow = new THREE.PointLight(0xffb070, 0, 3, 2);
    glow.position.set(0, 0, -1.2);
    glow.name = 'muzzle';
    vm.add(glow);
    this.viewmodel = vm;
  }

  private remote(id: string): Remote | null {
    let r = this.remotes.get(id);
    if (r) return r;
    const info = this.ctx.room().players.find((p) => p.id === id);
    if (!info || !this.engine) return null;
    const group = instantiate(this.models?.droid ?? null, info.color, () => capsuleFallback(info.color));
    const label = makeLabel(info.name, colorHex(info.color));
    label.position.y = RK.height + 0.45;
    group.add(label);
    this.engine.scene.add(group);
    r = { group, label, color: info.color, name: info.name, bob: Math.random() * 6 };
    this.remotes.set(id, r);
    return r;
  }

  private spawnRocket(id: string, pos: Vec3, vel: Vec3, confirmed: boolean): RocketView {
    const group = instantiate(this.models?.rocket ?? null, undefined, () => sphereFallback(ROCKET_COLOR, 0.18));
    const light = new THREE.PointLight(ROCKET_COLOR, 8, 6, 2);
    group.add(light);
    this.engine?.scene.add(group);
    const view: RocketView = { group, pos, vel, at: performance.now() / 1000, confirmed, born: performance.now() / 1000, light };
    this.rockets.set(id, view);
    return view;
  }

  private removeRocket(id: string) {
    const view = this.rockets.get(id);
    if (!view) return;
    this.engine?.scene.remove(view.group);
    this.rockets.delete(id);
  }

  // ---- per frame -----------------------------------------------------------------------------------------------

  private frame(dt: number, now: number) {
    this.time = now;
    const { engine, input, map, effects } = this;
    if (!engine || !input) return;

    if (map) {
      this.acc = Math.min(this.acc + dt, RK.dt * 6);
      while (this.acc >= RK.dt) {
        this.tick(now);
        this.acc -= RK.dt;
      }
      if (this.outbox.length && (this.outbox.length >= 2 || now - this.lastSend > 0.05)) {
        this.ctx.socket.sendGame({ k: 'in', i: this.outbox });
        this.outbox = [];
        this.lastSend = now;
      }
    }

    this.updateCamera(dt, now);
    this.updateRemotes(now);
    this.updateRockets(dt, now);
    if (this.arena) for (const ring of this.arena.padRings) ring.rotation.z += dt * 1.5;
    for (const pack of this.packs) {
      pack.rotation.y += dt;
      pack.position.y += Math.sin(now * 3) * 0.002;
    }
    effects?.update(dt);

    if (now - this.lastHud > 0.1) {
      this.lastHud = now;
      const s = this.hud.get();
      const left = Math.max(0, this.serverLeft - (now - this.serverLeftAt));
      const respawnIn = this.me.dead ? Math.max(0, this.me.respawnAt - now) : 0;
      if (Math.abs(s.left - left) > 0.05 || s.locked !== input.locked || s.dragLook !== input.dragLook || s.dead !== this.me.dead || Math.abs(s.respawnIn - respawnIn) > 0.05) {
        this.hud.set({ left, locked: input.locked, dragLook: input.dragLook, dead: this.me.dead, respawnIn });
      }
    }
  }

  private tick(now: number) {
    const { input, map, me } = this;
    if (!input || !map) return;
    const look = input.look();
    if (!this.paused) {
      me.yaw -= look.dx;
      me.pitch = clamp(me.pitch - look.dy, -RK.maxPitch, RK.maxPitch);
    }
    const inp: RocketsInput = {
      seq: ++me.seq,
      f: this.paused ? 0 : input.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']),
      s: this.paused ? 0 : input.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
      jump: !this.paused && input.down('Space'),
      fire: !this.paused && input.fire() && !this.hud.get().ended,
      yaw: me.yaw,
      pitch: me.pitch,
    };
    if (!me.dead) {
      const wasGround = me.body.onGround;
      const res = stepBody(me.body, inp, map);
      if (res.pad >= 0) sfx.play('pad');
      else if (inp.jump && wasGround && !me.body.onGround) sfx.play('jump');
      if (inp.fire && now >= me.nextFire) {
        me.nextFire = now + RK.fireInterval;
        const dir = lookDir(me.yaw, me.pitch);
        const origin = vadd(eyePosition(me.body.pos), vscale(dir, RK.muzzleOffset));
        this.spawnRocket(`${this.ctx.you}:${inp.seq}`, origin, vscale(dir, RK.rocketSpeed), false);
        this.recoil = 1;
        sfx.play('fire');
      }
    }
    me.pending.push(inp);
    if (me.pending.length > 180) me.pending.splice(0, me.pending.length - 180);
    this.outbox.push(inp);
  }

  private updateCamera(dt: number, now: number) {
    const { engine, me } = this;
    if (!engine) return;
    me.smooth.x = damp(me.smooth.x, 0, 14, dt);
    me.smooth.y = damp(me.smooth.y, 0, 14, dt);
    me.smooth.z = damp(me.smooth.z, 0, 14, dt);
    const base = me.dead && me.deathPos ? me.deathPos : me.body.pos;
    const eye = eyePosition(base);
    this.shake = Math.max(0, this.shake - dt * 2);
    const shakeX = (Math.random() - 0.5) * this.shake * 0.08;
    const shakeY = (Math.random() - 0.5) * this.shake * 0.08;
    const speed = Math.hypot(me.body.vel.x, me.body.vel.z);
    if (me.body.onGround && speed > 1 && !me.dead) this.bob += dt * speed * 1.4;
    const bobY = Math.sin(this.bob) * 0.025 * Math.min(1, speed / 6);
    engine.camera.position.set(eye.x + me.smooth.x + shakeX, eye.y + me.smooth.y + bobY + (me.dead ? -0.6 : 0) + shakeY, eye.z + me.smooth.z);
    engine.camera.rotation.set(me.pitch + (me.dead ? -0.2 : 0), me.yaw, 0);

    if (this.viewmodel) {
      this.recoil = Math.max(0, this.recoil - dt * 5);
      const vm = this.viewmodel;
      vm.position.set(0.3 + Math.sin(this.bob * 0.5) * 0.01, -0.28 + Math.abs(Math.sin(this.bob)) * 0.012 + this.recoil * 0.04, -0.5 + this.recoil * 0.1);
      vm.rotation.x = -this.recoil * 0.25;
      vm.visible = !me.dead;
      const glow = vm.getObjectByName('muzzle') as THREE.PointLight | undefined;
      if (glow) glow.intensity = this.recoil * 12;
    }
    void now;
  }

  private updateRemotes(now: number) {
    const sample = this.snaps.sample(now - INTERP_DELAY);
    const seen = new Set<string>();
    if (sample) {
      const { a, b, alpha } = sample;
      for (const pb of b.pl) {
        if (pb.id === this.ctx.you) continue;
        const r = this.remote(pb.id);
        if (!r) continue;
        seen.add(pb.id);
        const pa = a.pl.find((p) => p.id === pb.id) ?? pb;
        const dead = pb.d === 1;
        r.group.visible = !dead;
        if (dead) continue;
        const sameLife = pa.d === pb.d;
        const x = sameLife ? pa.p[0] + (pb.p[0] - pa.p[0]) * alpha : pb.p[0];
        const y = sameLife ? pa.p[1] + (pb.p[1] - pa.p[1]) * alpha : pb.p[1];
        const z = sameLife ? pa.p[2] + (pb.p[2] - pa.p[2]) * alpha : pb.p[2];
        const yaw = sameLife ? lerpAngle(pa.y, pb.y, alpha) : pb.y;
        r.bob += 0.05;
        r.group.position.set(x, y + (pb.g ? 0 : 0.05) + Math.sin(r.bob) * 0.02, z);
        r.group.rotation.y = yaw;
        // Lean into the movement direction a little.
        const vx = pb.v[0];
        const vz = pb.v[2];
        const fwd = -Math.sin(yaw) * vx - Math.cos(yaw) * vz;
        const side = Math.cos(yaw) * vx - Math.sin(yaw) * vz;
        r.group.rotation.x = clamp(fwd * 0.02, -0.25, 0.25);
        r.group.rotation.z = clamp(-side * 0.02, -0.25, 0.25);
      }
    }
    for (const [id, r] of this.remotes) if (!seen.has(id)) r.group.visible = false;
  }

  private updateRockets(dt: number, now: number) {
    for (const view of this.rockets.values()) {
      let pos: Vec3;
      if (view.confirmed) pos = vadd(view.pos, vscale(view.vel, now - view.at));
      else {
        view.pos = vadd(view.pos, vscale(view.vel, dt));
        pos = view.pos;
      }
      view.group.position.set(pos.x, pos.y, pos.z);
      const v = view.vel;
      const len = Math.hypot(v.x, v.y, v.z) || 1;
      view.group.lookAt(pos.x + v.x / len, pos.y + v.y / len, pos.z + v.z / len);
      view.light.intensity = 6 + Math.sin(now * 40) * 2;
      if (Math.random() < 0.6) this.effects?.burst(vsub(pos, vscale(v, 0.012)), 0xff9a3c, 1, 0.4, 0.25, 0);
    }
  }
}
