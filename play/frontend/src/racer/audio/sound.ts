// Race audio, all synthesized with Web Audio (no sample files):
//   - the player's twin-turbine engine (engine.ts) driven by speed, throttle, brake, boost and pad surges,
//   - up to 3 rival engines (the nearest pods) in HRTF panners, with exaggerated doppler for the pass-by "neeyow",
//   - wind rush rising with speed, rock-wall reflections per side (closer wall = louder, a whoosh when one appears),
//   - a crowd bed near the start line and the grandstands, swelling at the finish,
//   - cues (cues.ts): countdown beeps, pad zap, wall scrape and crunches, lap chime, best-lap flourish, fanfare.
// Graph: voices -> buses -> compressor -> limiter -> master (volume x mute) -> speakers. The AudioContext is the
// racer's shared one (context.ts), created after the first user gesture; dispose() stops this race's nodes only.

import * as THREE from 'three';
import { sfx } from '../../engine/audio';
import type { Race } from '../core/race';
import { zonesFor, type Zones } from '../world/zones';
import { currentAudioContext, glide, loopNoise, noise, withAudioContext } from './context';
import { bestFlourish, burst, countdownBeep, crunch, fanfare, lapChime, padZap } from './cues';
import { POS_TAU, PlayerEngine, RivalVoice } from './engine';

/** Exaggerated speed of sound for doppler (real air, 343 m/s, is too subtle between pods doing similar speeds). */
const SOUND_SPEED = 170;
const POD_HEIGHT = 1.5;

export interface RaceAudioOptions {
  /** Render into this context instead of the shared one (the lab's OfflineAudioContext). */
  context?: BaseAudioContext;
  /** Rival voices (default 3, 2 on touch devices). */
  voices?: number;
  /** Bus level multipliers, for the lab's solo/mute checks. */
  mix?: Partial<Record<'engine' | 'rivals' | 'ambience' | 'cues', number>>;
}

interface Bed {
  gain: GainNode;
  filter: BiquadFilterNode;
}

export class RaceAudio {
  private ctx: BaseAudioContext | null = null;
  private cancelWait: (() => void) | null = null;
  private master!: GainNode;
  private engineBus!: GainNode;
  private cueBus!: GainNode;
  private ambBus!: GainNode;
  private rivalBus!: GainNode;
  private engine!: PlayerEngine;
  private rivals: RivalVoice[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private wind!: Bed;
  private windHigh!: Bed;
  private walls: { bed: Bed; pan: StereoPannerNode; near: number; slow: number; next: number }[] = [];
  private crowd!: GainNode;
  private crowdPan!: StereoPannerNode;
  private crowdSwell!: GainNode;
  private scrape!: Bed;
  private scrapePan!: StereoPannerNode;

  private readonly zones: Zones;
  private readonly pos: THREE.Vector3[];
  private readonly vel: THREE.Vector3[];
  private readonly lis = new THREE.Vector3();
  private readonly lisVel = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly pitches: number[];
  private readonly crunchAt: number[];
  private readonly order: number[] = [];
  private first = true;
  private muted = false;
  private started = false;
  private scrapeK = 0;
  private scrapeSide = 0;
  private lastCrunch = -1;
  private lastCrunchK = 0;
  private rev = 0;
  private revTarget = 0;
  private revAt = 0;
  private cheer = 0;
  private time = 0;
  private offVolume: () => void;

  constructor(private readonly race: Race, private readonly opts: RaceAudioOptions = {}) {
    this.zones = zonesFor(race.track);
    this.pos = race.racers.map(() => new THREE.Vector3());
    this.vel = race.racers.map(() => new THREE.Vector3());
    this.crunchAt = race.racers.map(() => -1);
    // A stable engine character per pod: pitch from a hash of its id.
    this.pitches = race.racers.map((r) => {
      let h = 0;
      for (let i = 0; i < r.id.length; i++) h = (h * 31 + r.id.charCodeAt(i)) | 0;
      return 0.86 + ((h >>> 0) % 1000) / 1000 * 0.3;
    });
    if (opts.context) this.build(opts.context);
    this.offVolume = sfx.subscribe(() => this.applyMaster(0.05));
  }

  /** Call after a user gesture (also works before one: the sound then starts on the first gesture). */
  start() {
    this.started = true;
    if (this.ctx || this.cancelWait) return;
    this.cancelWait = withAudioContext((ctx) => {
      this.cancelWait = null;
      this.build(ctx);
    });
  }

  private build(ctx: BaseAudioContext) {
    this.ctx = ctx;
    const bank = noise(ctx);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -3;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.001;
    limit.release.value = 0.1;
    const bus = ctx.createGain();
    bus.gain.value = 0.5;
    bus.connect(comp).connect(limit).connect(this.master).connect(ctx.destination);

    const sub = (level: number) => {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(bus);
      return g;
    };
    const mix = this.opts.mix ?? {};
    this.engineBus = sub(0.33 * (mix.engine ?? 1));
    this.rivalBus = sub(0.7 * (mix.rivals ?? 1));
    this.ambBus = sub(0.6 * (mix.ambience ?? 1));
    this.cueBus = sub(1.1 * (mix.cues ?? 1));

    this.engine = new PlayerEngine(ctx, this.engineBus, 1);
    this.engine.setLevel(1, 0.6);
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const n = this.opts.voices ?? (touch ? 2 : 3);
    for (let i = 0; i < Math.min(n, this.race.racers.length - 1); i++) this.rivals.push(new RivalVoice(ctx, this.rivalBus, !touch));

    // Wind: a broad band that brightens with speed, and a high tearing layer at the top end.
    this.wind = this.bed(bank.white, 'bandpass', 400, 0.6, this.ambBus);
    this.windHigh = this.bed(bank.white, 'highpass', 3500, 0.7, this.ambBus);
    // Rock walls: a band of noise per side, the roar reflecting back off the cliff.
    for (const side of [-1, 1]) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = side * 0.85;
      pan.connect(this.ambBus);
      const b = this.bed(bank.white, 'bandpass', 900, 1.2, pan);
      this.walls.push({ bed: b, pan, near: 0, slow: 0, next: 0 });
    }
    // Crowd: brown + white noise through vowel-ish formants with a slow swell.
    this.crowdPan = ctx.createStereoPanner();
    this.crowd = ctx.createGain();
    this.crowd.gain.value = 0;
    this.crowdSwell = ctx.createGain();
    this.crowdSwell.gain.value = 0.8;
    this.crowd.connect(this.crowdSwell).connect(this.crowdPan).connect(this.ambBus);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.37;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.2;
    lfo.connect(lfoDepth).connect(this.crowdSwell.gain);
    lfo.start();
    this.sources.push(lfo);
    for (const [f, q, a] of [[450, 2.5, 1], [1100, 3, 0.7], [2500, 3.5, 0.35]] as const) {
      const src = loopNoise(ctx, bank.white, 0.9 + Math.random() * 0.2);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = a;
      src.connect(bp).connect(g).connect(this.crowd);
      this.sources.push(src);
    }
    // Wall scrape: metallic grind, panned to the side that hit.
    this.scrapePan = ctx.createStereoPanner();
    this.scrapePan.connect(this.cueBus);
    this.scrape = this.bed(bank.crackle, 'bandpass', 2800, 2.5, this.scrapePan, 1.6);
    const grind = this.bed(bank.white, 'bandpass', 1300, 4, this.scrape.gain);
    grind.gain.gain.value = 0.5;

    this.applyMaster(0.8);
  }

  /** A looping noise bed: source -> filter -> gain (starts silent) -> dest. */
  private bed(buf: AudioBuffer, type: BiquadFilterType, f: number, q: number, dest: AudioNode, rate = 1): Bed {
    const ctx = this.ctx!;
    const src = loopNoise(ctx, buf, rate);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = f;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(dest);
    this.sources.push(src);
    return { gain, filter };
  }

  private volume() {
    return Math.min(1, sfx.level * 2);
  }

  private applyMaster(tau = 0.05) {
    if (!this.ctx) return;
    glide(this.master.gain, this.muted ? 0 : this.volume(), this.ctx.currentTime, tau);
  }

  /** listener = camera position; called every frame. */
  update(dt: number, listener: { x: number; y: number; z: number }) {
    const ctx = this.ctx;
    if (!ctx || dt <= 0) return;
    this.time += dt;
    const t = ctx.currentTime;
    const race = this.race;
    const track = race.track;
    const player = race.player;
    const ps = player.state;
    const pi = race.racers.indexOf(player);
    const k = 1 - Math.exp(-dt * 8);

    // World positions and velocities of every pod.
    for (let i = 0; i < race.racers.length; i++) {
      const st = race.racers[i].state;
      const p = track.toWorld(st.s, st.x, POD_HEIGHT, this.tmp);
      if (!this.first) {
        // Smoothed finite difference; ignore the jump of a teleport (lab, ?at=).
        const dx = (p.x - this.pos[i].x) / dt;
        const dy = (p.y - this.pos[i].y) / dt;
        const dz = (p.z - this.pos[i].z) / dt;
        if (dx * dx + dy * dy + dz * dz < 400 * 400) this.vel[i].set(this.vel[i].x + (dx - this.vel[i].x) * k, this.vel[i].y + (dy - this.vel[i].y) * k, this.vel[i].z + (dz - this.vel[i].z) * k);
      }
      this.pos[i].copy(p);
    }
    // Listener: the camera, looking at the player's pod.
    if (!this.first) {
      const vx = (listener.x - this.lis.x) / dt;
      const vy = (listener.y - this.lis.y) / dt;
      const vz = (listener.z - this.lis.z) / dt;
      if (vx * vx + vy * vy + vz * vz < 400 * 400) this.lisVel.set(this.lisVel.x + (vx - this.lisVel.x) * k, this.lisVel.y + (vy - this.lisVel.y) * k, this.lisVel.z + (vz - this.lisVel.z) * k);
    }
    this.lis.set(listener.x, listener.y, listener.z);
    this.fwd.subVectors(this.pos[pi], this.lis);
    this.fwd.y = 0;
    if (this.fwd.lengthSq() < 1) this.fwd.copy(track.frameAt(ps.s).tangent);
    this.fwd.normalize();
    const L = ctx.listener;
    if (L.positionX) {
      glide(L.positionX, this.lis.x, t, POS_TAU);
      glide(L.positionY, this.lis.y, t, POS_TAU);
      glide(L.positionZ, this.lis.z, t, POS_TAU);
      glide(L.forwardX, this.fwd.x, t, 0.05);
      glide(L.forwardY, 0, t, 0.05);
      glide(L.forwardZ, this.fwd.z, t, 0.05);
      glide(L.upX, 0, t, 0.05);
      glide(L.upY, 1, t, 0.05);
      glide(L.upZ, 0, t, 0.05);
    } else {
      // Firefox before 2023 / old Safari: the deprecated setters.
      L.setPosition(this.lis.x, this.lis.y, this.lis.z);
      L.setOrientation(this.fwd.x, 0, this.fwd.z, 0, 1, 0);
    }

    // Grid: the pilots rev their engines during the countdown.
    const onGrid = race.phase === 'intro' || race.phase === 'countdown';
    if (onGrid && this.time >= this.revAt) {
      this.revAt = this.time + 0.35 + Math.random() * 0.7;
      this.revTarget = race.phase === 'countdown' ? 0.25 + Math.random() * 0.55 : Math.random() < 0.4 ? 0.3 : 0.05;
    }
    if (!onGrid) this.revTarget = 0;
    this.rev += (this.revTarget - this.rev) * (1 - Math.exp(-dt * (this.revTarget > this.rev ? 7 : 3)));

    const top = player.stats.topSpeed;
    const speed01 = ps.v / top;
    this.engine.update(dt, { speed01, throttle: player.input.throttle, brake: player.input.brake, boosting: ps.boosting, surge: ps.surge, rev: this.rev });

    // Wind.
    const w = Math.min(1.4, ps.v / 125);
    glide(this.wind.gain.gain, 0.04 + 0.55 * w * w, t, 0.15);
    glide(this.wind.filter.frequency, 300 + 1500 * w, t, 0.15);
    glide(this.windHigh.gain.gain, 0.12 * Math.max(0, w - 0.45) ** 1.5 + (ps.boosting ? 0.04 : 0), t, 0.2);

    // Rock walls on each side: louder the closer and taller; a whoosh when one sweeps in.
    for (let si = 0; si < 2; si++) {
      const side = si === 0 ? -1 : 1;
      const wall = this.walls[si];
      const off = this.zones.wallOffset(ps.s + 20, side);
      const h = this.zones.wallHeight(ps.s + 20, side);
      const gap = Number.isFinite(off) ? off - side * ps.x : Infinity;
      const near = h > 3 && Number.isFinite(gap) ? Math.max(0, Math.min(1, (70 - gap) / 50)) * Math.min(1, h / 25) : 0;
      wall.near += (near - wall.near) * (1 - Math.exp(-dt * 6));
      wall.slow += (near - wall.slow) * (1 - Math.exp(-dt * 1.2));
      glide(wall.bed.gain.gain, 0.3 * wall.near * w, t, 0.08);
      glide(wall.bed.filter.frequency, 500 + 900 * w + 600 * wall.near, t, 0.1);
      if (wall.near - wall.slow > 0.22 && w > 0.4 && this.time > wall.next) {
        wall.next = this.time + 0.8;
        const pan = ctx.createStereoPanner();
        pan.pan.value = side * 0.8;
        pan.connect(this.ambBus);
        burst(ctx, pan, t + 0.005, 0.7, 0.35 * w, 'bandpass', 2600, 1.3, 500);
        // The panner goes once the burst is done.
        setTimeout(() => pan.disconnect(), 1200);
      }
    }

    // Crowd near the start and finish lines and the stands.
    let crowdW = 0;
    let crowdSide = 0;
    const dLine = Math.min(Math.abs(ps.s - track.startS), Math.abs(ps.s - track.finishS));
    if (dLine < 350) crowdW = 1 - dLine / 350;
    for (const st of this.zones.stands) {
      const d = Math.abs(ps.s - (st.s0 + st.s1) / 2);
      const half = (st.s1 - st.s0) / 2;
      const wgt = d < half ? 1 : Math.max(0, 1 - (d - half) / 200);
      if (wgt > crowdW) {
        crowdW = wgt;
        crowdSide = st.side;
      }
    }
    this.cheer = Math.max(0, this.cheer - dt * 0.25);
    glide(this.crowd.gain, 0.16 * crowdW + 0.32 * this.cheer + (onGrid ? 0.1 : 0), t, 0.3);
    glide(this.crowdPan.pan, crowdSide * 0.6, t, 0.3);

    // Wall scrape follows the impact level reported this frame, decaying fast.
    this.scrapeK *= Math.exp(-dt * 10);
    glide(this.scrape.gain.gain, Math.min(1.2, this.scrapeK * 2.5) * Math.min(1, ps.v / 40), t, 0.03);
    glide(this.scrapePan.pan, this.scrapeSide * 0.7, t, 0.05);

    this.updateRivals(dt, t, pi, onGrid);
    this.first = false;
  }

  private updateRivals(dt: number, t: number, pi: number, onGrid: boolean) {
    const race = this.race;
    const ctx = this.ctx!;
    if (!this.rivals.length) return;
    // The nearest pods to the listener get the voices; a voice keeps its pod while it stays among the nearest.
    const order = this.order;
    order.length = 0;
    for (let i = 0; i < race.racers.length; i++) if (i !== pi) order.push(i);
    order.sort((a, b) => this.pos[a].distanceToSquared(this.lis) - this.pos[b].distanceToSquared(this.lis));
    const n = Math.min(order.length, this.rivals.length);
    for (const v of this.rivals) {
      if (v.owner < 0) continue;
      let keep = false;
      for (let j = 0; j < n; j++) if (order[j] === v.owner) keep = true;
      if (!keep) v.owner = -1;
    }
    for (let j = 0; j < n; j++) {
      const i = order[j];
      let free: RivalVoice | null = null;
      let has = false;
      for (const v of this.rivals) {
        if (v.owner === i) has = true;
        else if (v.owner < 0 && !free) free = v;
      }
      if (has || !free) continue;
      free.owner = i;
      free.pitch = this.pitches[i];
      free.radial = 0;
      const p = this.pos[i];
      free.jumpTo(p.x, p.y, p.z);
      // Start silent, the level glides up from there (no click on reassignment).
      free.out.gain.cancelScheduledValues(t);
      free.out.gain.setValueAtTime(0, t);
    }
    for (const v of this.rivals) {
      if (v.owner < 0) {
        glide(v.out.gain, 0, t, 0.05);
        continue;
      }
      const i = v.owner;
      const r = race.racers[i];
      const p = this.pos[i];
      v.setPosition(p.x, p.y, p.z);
      // Doppler from the radial velocity (+ = separating): f' = f * c / (c + v_radial).
      this.tmp.subVectors(p, this.lis);
      const dist = this.tmp.length();
      let radial = 0;
      if (dist > 0.5) {
        this.tmp.multiplyScalar(1 / dist);
        radial = (this.vel[i].x - this.lisVel.x) * this.tmp.x + (this.vel[i].y - this.lisVel.y) * this.tmp.y + (this.vel[i].z - this.lisVel.z) * this.tmp.z;
      }
      v.radial += (radial - v.radial) * (1 - Math.exp(-dt * 10));
      const doppler = Math.max(0.6, Math.min(1.7, SOUND_SPEED / Math.max(40, SOUND_SPEED + v.radial)));
      const rev = onGrid ? 0.15 + 0.15 * Math.sin(this.time * (2 + i) + i) : 0;
      v.update(r.state.v / r.stats.topSpeed + rev, r.state.boosting || r.state.surge > 0, doppler, 1, false);
      // Their bumps and scrapes, from where they are.
      if (r.state.impact > 0.15 && this.time - this.crunchAt[i] > 0.4) {
        this.crunchAt[i] = this.time;
        crunch(ctx, v.panner, r.state.impact * 0.7);
      }
    }
  }

  countdown(n: number) {
    if (!this.ctx) return;
    countdownBeep(this.ctx, this.cueBus, n);
    if (n === 0) this.cheer = Math.max(this.cheer, 0.8);
  }

  impact(strength: number, player: boolean) {
    if (!this.ctx || !player) return; // rivals' hits are played from update(), positioned
    // Fires every physics substep while grinding a wall: a continuous scrape plus a crunch on real hits.
    this.scrapeK = Math.max(this.scrapeK, strength);
    this.scrapeSide = this.race.player.state.impactSide;
    const now = this.time;
    if (strength > 0.1 && (now - this.lastCrunch > 0.35 || strength > this.lastCrunchK * 2)) {
      this.lastCrunch = now;
      this.lastCrunchK = strength;
      crunch(this.ctx, this.scrapePan, strength);
    }
  }

  pad(player: boolean) {
    if (!this.ctx || !player) return;
    padZap(this.ctx, this.cueBus);
  }

  lap(best: boolean) {
    if (!this.ctx) return;
    if (best && this.race.player.lap > 1) bestFlourish(this.ctx, this.cueBus);
    else lapChime(this.ctx, this.cueBus);
    this.cheer = Math.max(this.cheer, 0.5);
  }

  finish(position: number) {
    if (!this.ctx) return;
    fanfare(this.ctx, this.cueBus, position);
    this.cheer = position <= 3 ? 1.2 : 0.7;
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.applyMaster(0.05);
  }

  dispose() {
    this.offVolume();
    this.cancelWait?.();
    this.cancelWait = null;
    const ctx = this.ctx;
    if (!ctx) return;
    this.ctx = null;
    // Fade out, then stop and disconnect everything this race made. The shared context stays open for the menus.
    glide(this.master.gain, 0, ctx.currentTime, 0.04);
    const stop = () => {
      this.engine.dispose();
      for (const v of this.rivals) v.dispose();
      for (const s of this.sources) {
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
      }
      this.master.disconnect();
    };
    if (ctx === currentAudioContext() && ctx.state === 'running') setTimeout(stop, 150);
    else stop();
  }

  /** Whether the audio graph exists yet (it waits for a user gesture). */
  get running() {
    return this.started && this.ctx !== null;
  }
}
