// Ruckus client: a chase camera over the arena, predicted movement for the local pawn, interpolation for the rest.

import * as THREE from 'three';
import { fromTuple, hdist, type Vec3, v3, vadd, vsub } from '@shared/math';
import type { GameServerMsg, RoomView } from '@shared/protocol';
import { RU } from '@shared/ruckus/constants';
import type { PawnSnap, Phase, RuckusEvent, RuckusScore, RuckusServerMsg, RuckusSnapshot } from '@shared/ruckus/protocol';
import { type Layout, MINIGAMES, type MinigameId, type Pawn, type RuckusInput, type WorldState, newPawn, stepPawn } from '@shared/ruckus/world';
import { sfx } from '../../engine/audio';
import { Effects } from '../../engine/effects';
import { Engine, colorHex, makeLabel } from '../../engine/engine';
import { Input } from '../../engine/input';
import { INTERP_DELAY, SnapshotBuffer, damp, lerpAngle } from '../../engine/interp';
import { capsuleFallback, instantiate, loadModel, sphereFallback } from '../../engine/models';
import { type ClientContext, type GameClient, createStore } from '../types';
import { RuckusArena, addRuckusLights } from './arena';

export interface RuckusHudState {
  ready: boolean;
  phase: Phase | 'waiting';
  round: number;
  rounds: number;
  mg: MinigameId | null;
  left: number;
  scores: RuckusScore[];
  placements: string[] | null;
  myCoins: number;
  out: boolean;
  spectating: boolean;
  dashCd: number;
  holder: string | null;
  fuse: number;
  paused: boolean;
  ended: { scores: RuckusScore[]; winner: string | null } | null;
}

interface PawnView {
  group: THREE.Group;
  label: THREE.Sprite;
  color: number;
  name: string;
  squash: number;
}

export class RuckusClient implements GameClient {
  readonly hud = createStore<RuckusHudState>({
    ready: false,
    phase: 'waiting',
    round: 0,
    rounds: RU.roundsDefault,
    mg: null,
    left: 0,
    scores: [],
    placements: null,
    myCoins: 0,
    out: false,
    spectating: false,
    dashCd: 0,
    holder: null,
    fuse: 0,
    paused: false,
    ended: null,
  });

  private engine?: Engine;
  private input?: Input;
  private effects?: Effects;
  private arena?: RuckusArena;
  private models: { pawn: THREE.Group | null; bomb: THREE.Group | null; coin: THREE.Group | null; crown: THREE.Group | null } | null = null;
  private readonly snaps = new SnapshotBuffer<RuckusSnapshot>();
  private readonly pawns = new Map<string, PawnView>();
  private bomb?: THREE.Group;
  private crown?: THREE.Group;
  private layout?: Layout;
  private world: WorldState = {};
  private phase: Phase | 'waiting' = 'waiting';
  private readonly me = { body: newPawn(0, 0) as Pawn, seq: 0, pending: [] as RuckusInput[], out: true, smooth: v3(), participating: false };
  private acc = 0;
  private outbox: RuckusInput[] = [];
  private lastSend = 0;
  private paused = false;
  private time = 0;
  private lastHud = 0;
  private phaseLeft = 0;
  private phaseLeftAt = 0;
  private camTarget = new THREE.Vector3();
  private disposed = false;
  private lastTickSound = 0;

  constructor(private readonly ctx: ClientContext) {}

  // ---- lifecycle --------------------------------------------------------------------------------------------

  mount(container: HTMLElement) {
    const engine = new Engine(container, { fov: 48, near: 0.1, far: 200 });
    this.engine = engine;
    this.input = new Input(engine.renderer.domElement);
    this.input.dragLook = true; // no pointer lock needed; clicks are dashes
    this.effects = new Effects(engine.scene);
    this.arena = new RuckusArena(engine.scene);
    addRuckusLights(engine.scene);
    engine.camera.position.set(0, 18, 14);
    engine.camera.lookAt(0, 0, 0);
    sfx.unlock();
    void Promise.all([loadModel('pawn'), loadModel('bomb'), loadModel('coin'), loadModel('crown')]).then(([pawn, bomb, coin, crown]) => {
      if (this.disposed) return;
      this.models = { pawn, bomb, coin, crown };
      this.arena?.setCoinModel(coin);
      // Rebuild pawns with the real model.
      for (const [id, view] of this.pawns) {
        engine.scene.remove(view.group);
        this.pawns.delete(id);
      }
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
      this.input.clearOnce();
    }
    this.hud.set({ paused });
  }

  onRoom(room: RoomView) {
    for (const p of room.players) {
      const v = this.pawns.get(p.id);
      if (v && (v.name !== p.name || v.color !== p.color)) {
        this.engine?.scene.remove(v.group);
        this.pawns.delete(p.id);
      }
    }
  }

  // ---- messages -----------------------------------------------------------------------------------------------

  onMessage(m: GameServerMsg) {
    const msg = m as RuckusServerMsg;
    switch (msg.k) {
      case 'init':
        this.hud.set({ rounds: msg.rounds, scores: msg.scores });
        break;
      case 'round': {
        this.layout = msg.layout;
        this.world = msg.world;
        this.arena?.build(msg.mg, msg.layout, msg.world);
        this.me.participating = true;
        this.me.out = false;
        this.me.pending = [];
        this.setPhase('intro', msg.left);
        this.hud.set({ round: msg.round, rounds: msg.rounds, mg: msg.mg, placements: null, myCoins: 0, out: false, spectating: false });
        break;
      }
      case 'phase':
        this.setPhase(msg.phase, msg.left);
        if (msg.phase === 'play') sfx.play('go');
        if (msg.phase === 'results') {
          this.hud.set({ placements: msg.placements ?? null, scores: msg.scores ?? this.hud.get().scores });
          if (msg.placements?.[0] === this.ctx.you) sfx.play('win');
        }
        if (msg.scores) this.hud.set({ scores: msg.scores });
        break;
      case 'snap':
        this.onSnapshot(msg.s);
        break;
      case 'ev':
        for (const e of msg.e) this.onEvent(e);
        break;
      case 'end':
        this.hud.set({ ended: { scores: msg.scores, winner: msg.winner }, scores: msg.scores });
        if (msg.winner === this.ctx.you) sfx.play('win');
        break;
    }
  }

  private setPhase(phase: Phase, left: number) {
    this.phase = phase;
    this.phaseLeft = left;
    this.phaseLeftAt = this.time;
    this.hud.set({ phase, left });
  }

  private onSnapshot(s: RuckusSnapshot) {
    this.snaps.push(s);
    this.snaps.trim(1);
    this.world = s.world;
    this.phaseLeft = s.left;
    this.phaseLeftAt = this.time;
    if (s.phase !== this.phase) this.setPhase(s.phase, s.left);
    const own = s.pawns.find((p) => p.id === this.ctx.you);
    if (own) this.reconcile(own);
    else if (this.me.participating) {
      this.me.participating = false;
      this.hud.set({ spectating: true });
    }
    const bomb = s.world.bomb;
    const hud = this.hud.get();
    if ((bomb?.holder ?? null) !== hud.holder || Math.abs((bomb?.fuse ?? 0) - hud.fuse) > 0.5) this.hud.set({ holder: bomb?.holder ?? null, fuse: bomb?.fuse ?? 0 });
  }

  private reconcile(own: PawnSnap) {
    const me = this.me;
    const wasOut = me.out;
    me.out = own.out === 1;
    if (!wasOut && me.out) this.hud.set({ out: true });
    if (own.sc !== undefined && own.sc !== this.hud.get().myCoins) this.hud.set({ myCoins: own.sc });
    if (!this.layout) return;
    const before = { ...me.body.pos };
    me.body.pos = fromTuple(own.p);
    me.body.vel = fromTuple(own.v);
    me.body.onGround = own.g === 1;
    me.body.dashT = own.dt;
    me.body.dashCd = own.cd;
    me.body.stun = own.st;
    if (this.phase !== 'play') me.body.yaw = own.y;
    if (own.seq !== undefined) me.pending = me.pending.filter((i) => i.seq > own.seq!);
    if (this.phase === 'play' && !me.out) for (const i of me.pending) stepPawn(me.body, i, this.layout, this.world);
    const err = vsub(before, me.body.pos);
    const len = Math.hypot(err.x, err.y, err.z);
    if (len < 2) me.smooth = vadd(me.smooth, err);
    else me.smooth = v3();
  }

  private onEvent(e: RuckusEvent) {
    const you = this.ctx.you;
    const at = (id: string): Vec3 => {
      if (id === you) return this.me.body.pos;
      const v = this.pawns.get(id);
      return v ? { x: v.group.position.x, y: v.group.position.y, z: v.group.position.z } : v3();
    };
    const dist = (p: Vec3) => hdist(this.me.body.pos, p) * 0.5;
    switch (e.k) {
      case 'out': {
        const p = at(e.id);
        const color = this.pawns.get(e.id)?.color ?? 0xffffff;
        this.effects?.burst(vadd(p, v3(0, 0.6, 0)), color, 40, 5, 0.9, 0.8);
        sfx.play('out', e.id === you ? 0 : dist(p));
        break;
      }
      case 'coin':
        this.effects?.burst(fromTuple(e.at), 0xffd166, 12, 2.5, 0.5, 1);
        sfx.play('coin', e.id === you ? 0 : dist(fromTuple(e.at)));
        break;
      case 'boom': {
        const p = fromTuple(e.at);
        this.effects?.burst(vadd(p, v3(0, 0.8, 0)), 0xff7a59, 80, 8, 0.9, 0.5);
        this.effects?.flash(vadd(p, v3(0, 1, 0)), 0xffb070, 1.5, 0.4, 30);
        sfx.play('boom', dist(p));
        break;
      }
      case 'pass':
        sfx.play('pass', dist(at(e.to)));
        if (e.to === you) this.effects?.burst(vadd(this.me.body.pos, v3(0, 1.2, 0)), 0xff7a59, 20, 3, 0.5, 0.8);
        break;
      case 'dash': {
        const v = this.pawns.get(e.id);
        if (v) v.squash = 1;
        sfx.play('dash', e.id === you ? 0 : dist(at(e.id)));
        break;
      }
      case 'shove': {
        const p = at(e.id);
        this.effects?.burst(vadd(p, v3(0, 0.7, 0)), 0xffffff, 15, 3, 0.4, 0.6);
        sfx.play('hit', e.id === you || e.by === you ? 0 : dist(p));
        break;
      }
      case 'tile':
        if (e.state === 2) sfx.play('crack', 10);
        break;
    }
  }

  // ---- per frame ----------------------------------------------------------------------------------------------

  private frame(dt: number, now: number) {
    this.time = now;
    const { engine, input, arena } = this;
    if (!engine || !input) return;

    if (this.layout && this.phase === 'play' && !this.me.out && this.me.participating) {
      this.acc = Math.min(this.acc + dt, RU.dt * 6);
      while (this.acc >= RU.dt) {
        this.tick();
        this.acc -= RU.dt;
      }
      if (this.outbox.length && (this.outbox.length >= 2 || now - this.lastSend > 0.05)) {
        this.ctx.socket.sendGame({ k: 'in', i: this.outbox });
        this.outbox = [];
        this.lastSend = now;
      }
    } else {
      input.clearOnce();
      this.acc = 0;
    }

    arena?.update(this.world, dt);
    this.updatePawns(dt, now);
    this.updateCamera(dt);
    this.effects?.update(dt);

    if (now - this.lastHud > 0.1) {
      this.lastHud = now;
      const left = Math.max(0, this.phaseLeft - (now - this.phaseLeftAt));
      const s = this.hud.get();
      if (Math.abs(s.left - left) > 0.05 || Math.abs(s.dashCd - this.me.body.dashCd) > 0.05) this.hud.set({ left, dashCd: this.me.body.dashCd });
      if (this.phase === 'intro' && left < 3.2 && Math.ceil(left) !== this.lastTickSound) {
        this.lastTickSound = Math.ceil(left);
        if (left > 0.2) sfx.play('tick');
      }
    }
  }

  private tick() {
    const { input, me, layout } = this;
    if (!input || !layout) return;
    // Camera looks down -z from +z, so screen-up is -z and screen-right is +x.
    const mz = this.paused ? 0 : input.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const mx = this.paused ? 0 : input.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
    const dash = !this.paused && (input.once('Space') || input.once('ShiftLeft') || input.clicked());
    const inp: RuckusInput = { seq: ++me.seq, mx, mz, dash };
    const res = stepPawn(me.body, inp, layout, this.world);
    if (res.dashed) {
      sfx.play('dash');
      const v = this.pawns.get(this.ctx.you);
      if (v) v.squash = 1;
    }
    me.pending.push(inp);
    if (me.pending.length > 180) me.pending.splice(0, me.pending.length - 180);
    this.outbox.push(inp);
  }

  private pawnView(id: string): PawnView | null {
    let v = this.pawns.get(id);
    if (v) return v;
    const info = this.ctx.room().players.find((p) => p.id === id);
    if (!info || !this.engine) return null;
    const group = instantiate(this.models?.pawn ?? null, info.color, () => capsuleFallback(info.color, RU.radius, RU.height));
    const label = makeLabel(info.name, colorHex(info.color));
    label.position.y = RU.height + 0.6;
    label.scale.multiplyScalar(1.3);
    group.add(label);
    this.engine.scene.add(group);
    v = { group, label, color: info.color, name: info.name, squash: 0 };
    this.pawns.set(id, v);
    return v;
  }

  private updatePawns(dt: number, now: number) {
    const you = this.ctx.you;
    const me = this.me;
    const seen = new Set<string>();
    const sample = this.snaps.sample(now - INTERP_DELAY);
    let holderPos: THREE.Vector3 | null = null;
    const holder = this.world.bomb?.holder ?? null;

    if (sample) {
      const { a, b, alpha } = sample;
      for (const pb of b.pawns) {
        const v = this.pawnView(pb.id);
        if (!v) continue;
        seen.add(pb.id);
        v.group.visible = pb.out !== 1;
        if (pb.out === 1) continue;
        if (pb.id === you && me.participating) {
          me.smooth.x = damp(me.smooth.x, 0, 14, dt);
          me.smooth.y = damp(me.smooth.y, 0, 14, dt);
          me.smooth.z = damp(me.smooth.z, 0, 14, dt);
          v.group.position.set(me.body.pos.x + me.smooth.x, me.body.pos.y + me.smooth.y, me.body.pos.z + me.smooth.z);
          v.group.rotation.y = me.body.yaw;
        } else {
          const pa = a.pawns.find((p) => p.id === pb.id) ?? pb;
          v.group.position.set(pa.p[0] + (pb.p[0] - pa.p[0]) * alpha, pa.p[1] + (pb.p[1] - pa.p[1]) * alpha, pa.p[2] + (pb.p[2] - pa.p[2]) * alpha);
          v.group.rotation.y = lerpAngle(pa.y, pb.y, alpha);
        }
        v.squash = Math.max(0, v.squash - dt * 4);
        const s = 1 + v.squash * 0.25;
        v.group.scale.set(s, 1 / s, s);
        if (pb.id === holder) holderPos = v.group.position;
      }
    }
    for (const [id, v] of this.pawns) if (!seen.has(id)) v.group.visible = false;

    // Bomb over the holder's head.
    if (holder && holderPos && this.engine) {
      if (!this.bomb) {
        this.bomb = instantiate(this.models?.bomb ?? null, undefined, () => sphereFallback(0x222222, 0.3));
        this.engine.scene.add(this.bomb);
      }
      this.bomb.visible = true;
      const fuse = this.world.bomb?.fuse ?? 10;
      const pulse = 1 + Math.sin(now * (fuse < 3 ? 30 : 8)) * 0.1;
      this.bomb.position.set(holderPos.x, holderPos.y + RU.height + 1.1 + Math.sin(now * 4) * 0.08, holderPos.z);
      this.bomb.scale.setScalar(pulse);
      this.bomb.rotation.y += dt * 2;
    } else if (this.bomb) this.bomb.visible = false;

    // Crown on the current points leader.
    const scores = this.hud.get().scores;
    const leader = scores.length ? [...scores].sort((x, y) => y.points - x.points)[0] : null;
    const leaderView = leader && leader.points > 0 && scores.filter((s) => s.points === leader.points).length === 1 ? this.pawns.get(leader.id) : null;
    if (leaderView?.group.visible && this.engine) {
      if (!this.crown) {
        this.crown = instantiate(this.models?.crown ?? null, undefined, () => sphereFallback(0xffd166, 0.15));
        this.engine.scene.add(this.crown);
      }
      this.crown.visible = true;
      this.crown.position.copy(leaderView.group.position).add(new THREE.Vector3(0, RU.height + 0.15, 0));
      this.crown.rotation.y = leaderView.group.rotation.y;
    } else if (this.crown) this.crown.visible = false;
  }

  private updateCamera(dt: number) {
    const { engine, me } = this;
    if (!engine) return;
    let target: THREE.Vector3;
    if (me.participating && !me.out && this.phase !== 'results' && this.phase !== 'final') {
      target = new THREE.Vector3(me.body.pos.x + me.smooth.x, Math.max(0, me.body.pos.y), me.body.pos.z + me.smooth.z);
    } else target = new THREE.Vector3(0, 0, 0);
    const k = 1 - Math.exp(-5 * dt);
    this.camTarget.lerp(target, k);
    const span = this.layout ? (this.layout.kind === 'disc' ? this.layout.radius : this.layout.kind === 'square' ? this.layout.half : (this.layout.cols * this.layout.size) / 2) : 9;
    const height = 12 + span * 0.8;
    const back = 9 + span * 0.55;
    const desired = new THREE.Vector3(this.camTarget.x * 0.35, height, this.camTarget.z * 0.35 + back);
    engine.camera.position.lerp(desired, k);
    engine.camera.lookAt(this.camTarget.x * 0.6, 0, this.camTarget.z * 0.6);
  }
}

export const minigameName = (mg: MinigameId | null) => (mg ? MINIGAMES[mg].name : '');
export const minigameRules = (mg: MinigameId | null) => (mg ? MINIGAMES[mg].rules : '');
