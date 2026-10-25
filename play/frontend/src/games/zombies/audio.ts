// Last Light sound: everything synthesized, no files. Its own graph, like the racer's, with the site-wide volume:
//
//   voices -> [per voice: gain -> low-pass (distance, walls) -> pan] -> dry bus ------------------------------\
//                                                                     \-> early reflections (6 panned taps) --+
//                                                                     \-> reverb send -> convolver -----------+-> hurt low-pass
//                                                                     \-> outdoor slap (two late echoes) -----+       |
//   ambience bed (wind, window whistle, hum) + events (creaks, rats, drips, far moans, a bell, a siren) -------/       |
//                                                          compressor -> limiter -> master (volume) -> out <----------/
//
// Indoors a sound gets dense early reflections and the 1.8 s concrete-room tail; a shot fired or heard outside the
// room (when configureZAudio() told us where the room is) gets little room sound and a late slap off the yard
// instead, and one heard through a wall or window is muffled. Guns have a voice per weapon on top of the class
// defaults. Zombie voices come in four kinds (moan, gurgle, choke, breath), each zombie with its own pitch and
// mouth shape, and a crowd is staggered so it never moans in unison. Noise comes from three buffers made once and
// replayed from random offsets. Positional sounds share a voice budget; when it is full, new quiet ones are dropped.
// Nothing makes a sound before unlock() (after a user gesture); a browser without Web Audio gets a silent stand-in.
//
// Extras beyond the ZAudio interface (all optional):
//   configureZAudio(audio, { floor, interior })  floor material for footsteps and the room rectangle (indoor/outdoor)
//   opts.surface   'concrete' | 'wood' | 'tile' | 'mud' | 'metal' forces a footstep surface
//   opts.amount    size for 'impact' and 'crumble' (debris), loudness for 'step', damage for 'hurt'

import type { Vec3 } from '@shared/math';
import type { WeaponId, WeaponKind } from '@shared/zombies/weapons';
import { sfx } from '../../engine/audio';
import type { ZAudio, ZSound } from './api';

export type Surface = 'concrete' | 'wood' | 'tile' | 'mud' | 'metal';

type Opts = { kind?: WeaponKind; weapon?: WeaponId; amount?: number; id?: number; surface?: Surface; variant?: number };

/** What configureZAudio() takes: the floor of the map and the room's rectangle on the ground. */
export interface ZAudioRoom {
  floor: 'concrete' | 'wood' | 'tile';
  interior: { minX: number; maxX: number; minZ: number; maxZ: number };
}

const MAX_VOICES = 40;
/** Zombies moaning at once; more just wait their turn. */
const MAX_GROANS = 6;
/** Gain of the ambient events (creaks, rats, far moans...) before distance: they sit 25-35 dB under the guns. */
const AMB = 5;
const SILENT = 0.0001;

type Quad = [number, number, number, number];

interface Shot {
  /** Bandpassed noise layers: [freq, q, dur, gain]. */
  crack: Quad;
  body: Quad;
  /** Pitch-dropping sine: [from, to, dur, gain]. */
  thump: Quad;
  /** Low-passed brown noise: [cutoff, dur, gain]. */
  tail: [number, number, number];
  verb: number;
  /** Second, deeper sine for the big guns (the chest punch). */
  sub?: Quad;
  /** Mechanical clack of the action after the shot: [freq, gain]. */
  mech?: [number, number];
  /** Belt links rattling (LMG). */
  rattle?: number;
}

/** Class defaults: [freq, q, dur, gain] for the noise layers, [from, to, dur, gain] for the thump, [cutoff, dur, gain] for the tail. */
const SHOTS: Record<WeaponKind, Shot> = {
  pistol: { crack: [2600, 0.9, 0.11, 0.9], body: [950, 1.2, 0.09, 0.6], thump: [140, 55, 0.1, 0.5], tail: [700, 0.35, 0.12], verb: 0.55 },
  smg: { crack: [3100, 0.9, 0.07, 1], body: [1300, 1.1, 0.07, 0.7], thump: [120, 60, 0.07, 0.55], tail: [800, 0.22, 0.08], verb: 0.45 },
  rifle: { crack: [3600, 0.7, 0.14, 1], body: [720, 1, 0.2, 0.75], thump: [95, 40, 0.17, 0.7], tail: [450, 0.65, 0.22], verb: 0.65 },
  shotgun: { crack: [2100, 0.7, 0.1, 0.8], body: [1100, 0.6, 0.35, 0.95], thump: [75, 32, 0.3, 1], tail: [380, 0.8, 0.3], verb: 0.75 },
  sniper: { crack: [4200, 0.6, 0.2, 1.1], body: [520, 0.8, 0.4, 0.9], thump: [62, 28, 0.42, 1.1], tail: [300, 1.5, 0.35], verb: 0.95 },
  lmg: { crack: [2900, 0.8, 0.1, 0.85], body: [620, 1, 0.16, 0.7], thump: [85, 38, 0.14, 0.75], tail: [420, 0.45, 0.16], verb: 0.6 },
};

/** Per-gun character over the class defaults. */
const VOICES: Partial<Record<WeaponId, Partial<Shot>>> = {
  // .45 ACP: a slow, fat round. Low thump, darker crack.
  m1911: { crack: [2100, 0.8, 0.12, 0.8], body: [680, 1.1, 0.12, 0.75], thump: [118, 42, 0.15, 0.8], tail: [600, 0.4, 0.14], mech: [1700, 0.18] },
  // 9 mm polymer pistol: snappy and bright, short.
  glock: { crack: [3500, 1.1, 0.08, 1], body: [1350, 1.4, 0.06, 0.55], thump: [170, 75, 0.07, 0.38], tail: [800, 0.3, 0.1], mech: [2700, 0.15] },
  // Heavy wooden SMG firing .45: a chugging, mid-heavy pop.
  thompson: { crack: [2300, 0.8, 0.08, 0.85], body: [600, 0.9, 0.11, 0.95], thump: [105, 45, 0.12, 0.8], tail: [560, 0.26, 0.12], mech: [1500, 0.12] },
  // Old pump gun: long boom with a woody bark.
  trench: { crack: [1900, 0.6, 0.12, 0.8], body: [880, 0.5, 0.42, 1], thump: [66, 28, 0.36, 1.15], tail: [340, 0.95, 0.32], sub: [48, 30, 0.3, 0.5] },
  // Bolt action: a sharp supersonic crack with a long room tail.
  kar98k: { crack: [4000, 0.6, 0.18, 1.1], body: [600, 0.9, 0.3, 0.85], thump: [80, 34, 0.3, 0.9], tail: [330, 1.25, 0.3], verb: 0.9 },
  garand: { crack: [3300, 0.7, 0.15, 1], body: [680, 1, 0.22, 0.8], thump: [90, 38, 0.2, 0.8], tail: [400, 0.8, 0.24], mech: [2300, 0.1] },
  // 4.6 mm PDW: thin and fast.
  mp7: { crack: [3900, 1.2, 0.05, 0.95], body: [1600, 1.3, 0.05, 0.55], thump: [150, 80, 0.05, 0.4], tail: [900, 0.18, 0.07], mech: [3100, 0.08] },
  m4a1: { crack: [3500, 0.75, 0.12, 1], body: [800, 1, 0.16, 0.75], thump: [100, 42, 0.15, 0.7], tail: [460, 0.55, 0.2], mech: [2400, 0.07] },
  // 5.45 AK: heavier, more mid-range bark than the M4.
  ak12: { crack: [3000, 0.8, 0.13, 1], body: [650, 0.9, 0.2, 0.85], thump: [90, 36, 0.19, 0.85], tail: [420, 0.6, 0.22], mech: [1900, 0.1] },
  benelli: { crack: [2400, 0.7, 0.1, 0.9], body: [1200, 0.6, 0.3, 0.95], thump: [72, 30, 0.3, 1], tail: [380, 0.8, 0.3], sub: [52, 32, 0.25, 0.4] },
  // Belt-fed SAW: a rhythmic roar with link rattle.
  m249: { crack: [2800, 0.8, 0.1, 0.85], body: [560, 0.9, 0.17, 0.85], thump: [80, 34, 0.16, 0.85], tail: [400, 0.5, 0.18], rattle: 0.12 },
  // .50 BMG: concussive, a sub punch and a long, rolling tail.
  barrett: {
    crack: [4400, 0.5, 0.25, 1.2],
    body: [420, 0.7, 0.5, 1],
    thump: [52, 22, 0.6, 1.3],
    tail: [260, 2.2, 0.45],
    verb: 1.15,
    sub: [36, 24, 0.7, 0.9],
    mech: [1200, 0.12],
  },
};

const shotVoice = (kind: WeaponKind, weapon?: WeaponId): Shot => ({ ...SHOTS[kind], ...(weapon ? VOICES[weapon] : undefined) });

/** Level trims per sound, set from the lab's offline peak readings (lab-zombies-audio.html) so the mix sits right. */
const TRIM: Partial<Record<ZSound, number>> = {
  shot: 3.6,
  empty: 4,
  impact: 3.2,
  flesh: 3,
  headshot: 2.4,
  groan: 5,
  scream: 2.2,
  step: 4,
  clink: 4,
  points: 5,
  hurt: 2,
  swipe: 1.1,
  throw: 1,
  hammer: 0.55,
  knife: 0.42,
  pump: 0.6,
  reloadIn: 0.7,
  bolt: 0.7,
  tear: 0.6,
  reloadOut: 1.4,
};

/** Mouth shapes for the zombie voices: [F1, F2, F3]. Each zombie glides between two of them. */
const VOWELS: [number, number, number][] = [
  [700, 1150, 2450], // ah
  [500, 850, 2400], // oh
  [420, 980, 2300], // uh
  [640, 1050, 2550], // aw
  [360, 760, 2250], // oo
  [480, 1350, 1690], // er
  [560, 1500, 2600], // ae, through a broken jaw
  [300, 870, 2240], // a closed throat
];

type VoiceKind = 'moan' | 'gurgle' | 'choke' | 'breath';
const VOICE_KINDS: VoiceKind[] = ['moan', 'gurgle', 'choke', 'breath'];

const STEP_LEVEL: Record<Surface, number> = { concrete: 1.4, wood: 0.75, tile: 1.8, mud: 0.8, metal: 1.5 };

/** Early reflections off the room's walls: [delay s, gain, pan]. */
const TAPS: [number, number, number][] = [
  [0.0087, 0.42, -0.7],
  [0.0131, 0.38, 0.6],
  [0.0193, 0.31, -0.25],
  [0.0272, 0.27, 0.8],
  [0.0368, 0.21, -0.85],
  [0.0517, 0.16, 0.3],
];

class Graph implements ZAudio {
  private ctx?: BaseAudioContext;
  private master?: GainNode;
  private bus?: GainNode;
  private verbIn?: GainNode;
  private earlyIn?: GainNode;
  private slapIn?: GainNode;
  private hurtLp?: BiquadFilterNode;
  private white?: AudioBuffer;
  private brown?: AudioBuffer;
  private crackle?: AudioBuffer;
  private shaper?: WaveShaperNode;
  private ambGain?: GainNode;
  private whistleGain?: GainNode;
  private windFilter?: BiquadFilterNode;
  private voices = new Float64Array(MAX_VOICES);
  /** Zombie id -> time its current vocalisation ends. */
  private talking = new Map<number, number>();
  /** Start times of recent groans, to stagger a crowd. */
  private groanStarts: number[] = [];
  private offVolume: () => void;
  private unlocked = false;
  /** Built on a caller's context (a lab's OfflineAudioContext): plays regardless of its state. */
  private offline = false;
  private disposed = false;
  private room: ZAudioRoom | null = null;
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private yaw = 0;
  private tension = 0;
  private hurt = 0;
  private downed = false;
  private nextBeat = 0;
  private nextAmbient = 0;
  private nextRare = 0;
  private belt = 0;

  constructor(ctx?: BaseAudioContext) {
    this.offVolume = sfx.subscribe(() => this.applyMaster());
    if (ctx) {
      this.unlocked = true;
      this.offline = true;
      this.build(ctx);
    }
  }

  // ---- setup ----------------------------------------------------------------------------------------------------

  unlock() {
    if (this.disposed) return;
    this.unlocked = true;
    if (!this.ctx) {
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.build(new AC());
      } catch {
        return;
      }
    }
    const ctx = this.ctx as AudioContext;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') void ctx.resume().catch(() => undefined);
  }

  configure(room: ZAudioRoom) {
    this.room = room;
  }

  private build(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.white = makeWhite(ctx);
    this.brown = makeBrown(ctx);
    this.crackle = makeCrackle(ctx);
    this.master = ctx.createGain();
    this.master.gain.value = this.level();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -2;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.001;
    limit.release.value = 0.1;
    this.hurtLp = ctx.createBiquadFilter();
    this.hurtLp.type = 'lowpass';
    this.hurtLp.frequency.value = 20000;
    this.hurtLp.Q.value = 0.5;
    this.hurtLp.connect(comp).connect(limit).connect(this.master).connect(ctx.destination);
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.8;
    this.bus.connect(this.hurtLp);
    // Late reverb tail.
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(ctx, 1.8);
    this.verbIn = ctx.createGain();
    this.verbIn.gain.value = 0.55;
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.7;
    this.verbIn.connect(verb).connect(verbOut).connect(this.hurtLp);
    // Early reflections: a handful of panned, darkened taps (the walls answering first).
    this.earlyIn = ctx.createGain();
    const earlyLp = ctx.createBiquadFilter();
    earlyLp.type = 'lowpass';
    earlyLp.frequency.value = 3800;
    this.earlyIn.connect(earlyLp);
    for (const [d, g, p] of TAPS) {
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = d;
      const gain = ctx.createGain();
      gain.gain.value = g;
      const pan = ctx.createStereoPanner();
      pan.pan.value = p;
      earlyLp.connect(delay).connect(gain).connect(pan).connect(this.hurtLp);
    }
    // Outdoor slap: the yard and the building throwing the shot back late and dull.
    this.slapIn = ctx.createGain();
    const slapLp = ctx.createBiquadFilter();
    slapLp.type = 'lowpass';
    slapLp.frequency.value = 1300;
    this.slapIn.connect(slapLp);
    for (const [d, g, p] of [
      [0.24, 0.42, 0.35],
      [0.47, 0.22, -0.4],
    ] as const) {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = d;
      const gain = ctx.createGain();
      gain.gain.value = g;
      const pan = ctx.createStereoPanner();
      pan.pan.value = p;
      slapLp.connect(delay).connect(gain).connect(pan).connect(this.hurtLp);
    }
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = distortionCurve(28);
    // A lab's offline render measures single sounds: no bed under them.
    if (!this.offline) this.buildAmbience(ctx);
  }

  private buildAmbience(ctx: BaseAudioContext) {
    // Wind: brown noise through a wandering band-pass, gently swelling.
    this.ambGain = ctx.createGain();
    this.ambGain.gain.value = 0.06;
    const src = ctx.createBufferSource();
    src.buffer = this.brown!;
    src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 320;
    this.windFilter.Q.value = 0.9;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 140;
    lfo.connect(lfoAmt).connect(this.windFilter.frequency);
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.045;
    const swellAmt = ctx.createGain();
    swellAmt.gain.value = 0.35;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.65;
    swell.connect(swellAmt).connect(windGain.gain);
    src.connect(this.windFilter).connect(windGain).connect(this.ambGain);
    // Wind whistling through the broken windows: two narrow, drifting tones out of the noise, louder with tension.
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0.02;
    const air = ctx.createBufferSource();
    air.buffer = this.white!;
    air.loop = true;
    for (const [f, rate, depth] of [
      [860, 0.11, 120],
      [1270, 0.083, 170],
    ] as const) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = 28;
      const wob = ctx.createOscillator();
      wob.frequency.value = rate;
      const wobAmt = ctx.createGain();
      wobAmt.gain.value = depth;
      wob.connect(wobAmt).connect(bp.frequency);
      const g = ctx.createGain();
      g.gain.value = 1.4;
      const gust = ctx.createOscillator();
      gust.frequency.value = rate * 0.6;
      const gustAmt = ctx.createGain();
      gustAmt.gain.value = 0.9;
      gust.connect(gustAmt).connect(g.gain);
      air.connect(bp).connect(g).connect(this.whistleGain);
      wob.start();
      gust.start();
    }
    this.whistleGain.connect(this.ambGain);
    // A low hum under it all (a room that is never quite silent).
    const hum = ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 49;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.08;
    hum.connect(humGain).connect(this.ambGain);
    this.ambGain.connect(this.bus!);
    this.ambGain.connect(this.verbIn!);
    src.start();
    air.start();
    lfo.start();
    swell.start();
    hum.start();
  }

  private level() {
    return Math.min(1, sfx.level * 2) * 0.85;
  }

  private applyMaster() {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.05);
  }

  /** The context when it may make sound now. */
  private live(): BaseAudioContext | undefined {
    const ctx = this.ctx;
    if (!ctx || !this.unlocked || this.disposed) return undefined;
    if (!this.offline && ctx.state !== 'running') return undefined;
    return this.level() > 0 ? ctx : undefined;
  }

  dispose() {
    this.disposed = true;
    this.offVolume();
    const ctx = this.ctx as AudioContext | undefined;
    if (ctx && typeof ctx.close === 'function') void ctx.close().catch(() => undefined);
    this.ctx = undefined;
  }

  private isInside(x: number, z: number) {
    const r = this.room?.interior;
    if (!r) return true;
    return x > r.minX - 0.3 && x < r.maxX + 0.3 && z > r.minZ - 0.3 && z < r.maxZ + 0.3;
  }

  // ---- listener and moods ---------------------------------------------------------------------------------------

  listen(pos: Vec3, yaw: number) {
    this.lx = pos.x;
    this.ly = pos.y;
    this.lz = pos.z;
    this.yaw = yaw;
    const ctx = this.live();
    if (!ctx) return;
    const t = ctx.currentTime;
    // Heartbeat while hurt or downed.
    if ((this.hurt > 0.35 || this.downed) && t >= this.nextBeat) {
      const bpm = this.downed ? 54 : 66 + this.hurt * 60;
      const a = this.downed ? 0.9 : 0.35 + this.hurt * 0.6;
      this.thump(this.bus!, t + 0.01, 62, 38, 0.13, a);
      this.thump(this.bus!, t + 0.2, 55, 34, 0.15, a * 0.7);
      this.nextBeat = t + 60 / bpm;
    }
    // Occasional ambient events, more often with tension.
    if (this.nextAmbient === 0) {
      this.nextAmbient = t + 4;
      this.nextRare = t + 70 + Math.random() * 80;
    }
    if (t >= this.nextAmbient) {
      this.nextAmbient = t + (5 + Math.random() * 9) / (0.6 + this.tension);
      const r = Math.random();
      const moan = 0.15 + this.tension * 0.25;
      if (r < moan) this.ambient('moan', t);
      else if (r < moan + 0.18) this.ambient('creak', t);
      else if (r < moan + 0.32) this.ambient('metal', t);
      else if (r < moan + 0.46) this.ambient('rats', t);
      else if (r < moan + 0.62) this.ambient('drip', t);
      else this.ambient('knock', t);
    }
    // Very rarely, something far away: a church bell or a siren.
    if (t >= this.nextRare) {
      this.nextRare = t + 90 + Math.random() * 120;
      this.ambient(Math.random() < 0.6 ? 'bell' : 'siren', t);
    }
  }

  setTension(t: number) {
    this.tension = Math.max(0, Math.min(1, t));
    if (!this.ctx || !this.ambGain) return;
    const now = this.ctx.currentTime;
    this.ambGain.gain.setTargetAtTime(0.05 + this.tension * 0.07, now, 1.5);
    this.whistleGain?.gain.setTargetAtTime(0.015 + this.tension * 0.035, now, 2);
  }

  setHurt(hurt: number, downed: boolean) {
    this.hurt = Math.max(0, Math.min(1, hurt));
    this.downed = downed;
    if (!this.ctx || !this.hurtLp) return;
    const f = downed ? 650 : this.hurt > 0.3 ? 20000 * Math.pow(0.07, (this.hurt - 0.3) / 0.7) : 20000;
    this.hurtLp.frequency.setTargetAtTime(Math.max(600, f), this.ctx.currentTime, 0.15);
  }

  // ---- routing --------------------------------------------------------------------------------------------------

  /** Claims a voice for `len` seconds; false when the budget is full and this one is not loud enough to matter. */
  private claim(t: number, len: number, loud: number) {
    let free = -1;
    let earliest = 0;
    for (let i = 0; i < MAX_VOICES; i++) {
      if (this.voices[i] <= t) {
        free = i;
        break;
      }
      if (this.voices[i] < this.voices[earliest]) earliest = i;
    }
    if (free < 0) {
      if (loud < 0.5) return false;
      free = earliest;
    }
    this.voices[free] = t + len;
    return true;
  }

  /**
   * An input node for one sound: at the listener when `pos` is undefined, else attenuated, panned, muffled and
   * wetter with distance. Indoors it feeds the early reflections and the reverb; outdoors mostly the slap; through
   * a wall it is muffled. Returns undefined when it is too far or the voice budget is full.
   */
  private route(ctx: BaseAudioContext, pos: Vec3 | undefined, verb: number, len: number, gain = 1): GainNode | undefined {
    const input = ctx.createGain();
    const lisIn = this.isInside(this.lx, this.lz);
    if (!pos) {
      if (!this.claim(ctx.currentTime, len, 1)) return undefined;
      input.gain.value = gain;
      input.connect(this.bus!);
      if (verb > 0) {
        const send = ctx.createGain();
        send.gain.value = verb * 0.6 * (lisIn ? 1 : 0.25);
        input.connect(send).connect(this.verbIn!);
        const early = ctx.createGain();
        early.gain.value = verb * (lisIn ? 0.55 : 0.05);
        input.connect(early).connect(this.earlyIn!);
        if (!lisIn) {
          const slap = ctx.createGain();
          slap.gain.value = verb * 0.6;
          input.connect(slap).connect(this.slapIn!);
        }
      }
      return input;
    }
    const dx = pos.x - this.lx;
    const dy = pos.y - this.ly;
    const dz = pos.z - this.lz;
    const d = Math.hypot(dx, dy, dz);
    const srcIn = this.isInside(pos.x, pos.z);
    const through = srcIn !== lisIn;
    const a = (gain / (1 + Math.max(0, d - 1.5) / 4.5)) * (through ? 0.7 : 1);
    if (a < 0.02) return undefined;
    if (!this.claim(ctx.currentTime, len, a)) return undefined;
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const hd = Math.hypot(dx, dz) || 1;
    const pan = Math.max(-0.9, Math.min(0.9, ((dx * rx + dz * rz) / hd) * Math.min(1, d / 1.5)));
    const behind = (dx * fx + dz * fz) / hd < -0.3;
    input.gain.value = a * (behind ? 0.85 : 1);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(600, 18000 * Math.exp(-d / 16)) * (behind ? 0.6 : 1) * (through ? 0.35 : 1);
    lp.Q.value = 0.5;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    input.connect(lp).connect(panner).connect(this.bus!);
    const indoor = srcIn && lisIn;
    const send = ctx.createGain();
    send.gain.value = verb * Math.min(1.4, 0.4 + d / 14) * (indoor ? 1 : through ? 0.6 : 0.2);
    panner.connect(send).connect(this.verbIn!);
    if (indoor && d < 25) {
      const early = ctx.createGain();
      early.gain.value = verb * 0.45 * Math.min(1, 8 / (d + 4));
      panner.connect(early).connect(this.earlyIn!);
    } else if (!indoor && d > 5) {
      const slap = ctx.createGain();
      slap.gain.value = verb * (through ? 0.15 : 0.5);
      panner.connect(slap).connect(this.slapIn!);
    }
    return input;
  }

  // ---- primitives -----------------------------------------------------------------------------------------------

  /** Filtered noise burst with an attack/decay envelope; `f1` sweeps the filter. */
  private noise(out: AudioNode, t: number, o: { type?: BiquadFilterType; f: number; f1?: number; q?: number; dur: number; gain: number; attack?: number; buf?: AudioBuffer; rate?: number }) {
    const ctx = this.ctx!;
    const buf = o.buf ?? this.white!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (o.rate) src.playbackRate.value = o.rate;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type ?? 'bandpass';
    filter.frequency.setValueAtTime(o.f, t);
    if (o.f1) filter.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
    filter.Q.value = o.q ?? 1;
    // White noise loses most of its energy in a narrow band; make up for it so `gain` means roughly the same level
    // whatever the filter (the brown and crackle buffers are already concentrated).
    let gain = o.gain;
    if (buf === this.white) {
      const type = o.type ?? 'bandpass';
      const share = type === 'bandpass' ? o.f / ((o.q ?? 1) * 22050) : type === 'lowpass' ? o.f / 22050 : 1 - o.f / 22050;
      gain *= Math.min(6, Math.max(1, 0.45 / Math.sqrt(Math.max(share, 1e-4))));
    }
    const g = ctx.createGain();
    env(g.gain, t, o.attack ?? 0.002, gain, o.dur);
    src.connect(filter).connect(g).connect(out);
    src.start(t, Math.random() * (buf.duration - o.dur - 0.1 > 0 ? buf.duration - o.dur - 0.1 : 0));
    src.stop(t + (o.attack ?? 0.002) + o.dur + 0.05);
  }

  private tone(out: AudioNode, t: number, o: { type?: OscillatorType; f: number; f1?: number; dur: number; gain: number; attack?: number; detune?: number }) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    env(g.gain, t, o.attack ?? 0.003, o.gain, o.dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + (o.attack ?? 0.003) + o.dur + 0.05);
  }

  private thump(out: AudioNode, t: number, f0: number, f1: number, dur: number, gain: number) {
    this.tone(out, t, { f: f0, f1, dur, gain, attack: 0.004 });
  }

  /** Short metallic click (mags, bolts, triggers). */
  private click(out: AudioNode, t: number, f: number, gain: number) {
    this.noise(out, t, { f, q: 6, dur: 0.025, gain });
    this.tone(out, t, { type: 'square', f: f * 0.7, dur: 0.012, gain: gain * 0.25 });
  }

  /** Inharmonic struck metal: bells, knocks, clinks. */
  private bell(out: AudioNode, t: number, f: number, partials: number[], dur: number, gain: number) {
    partials.forEach((p, i) => this.tone(out, t, { f: f * p, dur: dur / (1 + i * 0.6), gain: gain / (1 + i * 0.8), attack: 0.002 }));
  }

  /** A nail being dragged out of wood: stick-slip squeal gliding up. */
  private squeal(out: AudioNode, t: number, f: number, dur: number, gain: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.linearRampToValueAtTime(f * (1.35 + Math.random() * 0.5), t + dur);
    // Stick-slip: a fast square wobble on the pitch.
    const slip = ctx.createOscillator();
    slip.type = 'square';
    slip.frequency.value = 28 + Math.random() * 30;
    const slipAmt = ctx.createGain();
    slipAmt.gain.value = f * 0.07;
    slip.connect(slipAmt).connect(osc.frequency);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * 2.3;
    bp.Q.value = 9;
    const g = ctx.createGain();
    env(g.gain, t, 0.03, gain, dur);
    osc.connect(bp).connect(g).connect(out);
    osc.start(t);
    slip.start(t);
    osc.stop(t + dur + 0.08);
    slip.stop(t + dur + 0.08);
  }

  /** One hammer blow on a nail: wood body, the steel ring of the nail, the strike. `solid` 0..1. */
  private blow(out: AudioNode, t: number, solid: number) {
    this.thump(out, t, 210 + Math.random() * 30, 100, 0.07 + solid * 0.04, 0.3 + solid * 0.35);
    this.noise(out, t, { f: 2700, q: 2, dur: 0.025, gain: 0.25 + solid * 0.3 });
    this.noise(out, t, { f: 430, q: 4, dur: 0.07, gain: 0.2 + solid * 0.25 });
    this.bell(out, t, 3100 + Math.random() * 400, [1, 2.76], 0.1 + solid * 0.1, 0.03 + solid * 0.04);
  }

  // ---- the sounds -----------------------------------------------------------------------------------------------

  play(name: ZSound, opts: Opts = {}) {
    this.emit(name, undefined, opts);
  }

  playAt(name: ZSound, pos: Vec3, opts: Opts = {}) {
    this.emit(name, pos, opts);
  }

  private emit(name: ZSound, pos: Vec3 | undefined, o: Opts) {
    const ctx = this.live();
    if (!ctx) return;
    const t = ctx.currentTime + 0.005;
    const amount = o.amount ?? 0.5;
    const local = !pos;
    const trim = TRIM[name] ?? 1;
    const r = (len: number, verb: number, gain = 1) => this.route(ctx, pos, verb, len, gain * trim);
    const jit = () => 0.92 + Math.random() * 0.16;
    switch (name) {
      case 'shot': {
        const s = shotVoice(o.kind ?? 'pistol', o.weapon);
        const out = r(Math.max(s.tail[1], s.sub ? s.sub[2] : 0) + 0.3, s.verb, 0.9);
        if (!out) return;
        const k = jit();
        this.noise(out, t, { type: 'bandpass', f: s.crack[0] * k, q: s.crack[1], dur: s.crack[2], gain: s.crack[3] });
        this.noise(out, t, { type: 'highpass', f: 5000 * k, q: 0.7, dur: 0.03, gain: s.crack[3] * 0.6 });
        this.noise(out, t + 0.002, { type: 'bandpass', f: s.body[0] * k, q: s.body[1], dur: s.body[2], gain: s.body[3] });
        this.thump(out, t, s.thump[0] * k, s.thump[1], s.thump[2] * (local ? 1.2 : 0.8), s.thump[3] * (local ? 1 : 0.5));
        if (s.sub) this.thump(out, t + 0.003, s.sub[0], s.sub[1], s.sub[2], s.sub[3] * (local ? 1 : 0.4));
        this.noise(out, t + 0.01, { type: 'lowpass', f: s.tail[0] * k, f1: s.tail[0] * 0.4, q: 0.6, dur: s.tail[1], gain: s.tail[2], attack: 0.01, buf: this.brown });
        // The shooter hears the action cycle; others are too far for it.
        if (local && s.mech) this.click(out, t + 0.03 + Math.random() * 0.01, s.mech[0] * jit(), s.mech[1]);
        if (s.rattle && (local || (pos && Math.hypot(pos.x - this.lx, pos.z - this.lz) < 10))) {
          this.belt = (this.belt + 1) % 3;
          this.noise(out, t + 0.025, { f: 3200 + this.belt * 400, q: 3, dur: 0.035, gain: s.rattle, buf: this.crackle });
        }
        return;
      }
      case 'empty': {
        const out = r(0.1, 0.1);
        if (out) this.click(out, t, 3600, 0.35);
        return;
      }
      case 'reloadOut': {
        const out = r(0.3, 0.2);
        if (!out) return;
        this.click(out, t, 2400, 0.4);
        this.noise(out, t + 0.06, { f: 900, q: 2, dur: 0.12, gain: 0.18, attack: 0.02 });
        return;
      }
      case 'reloadIn': {
        const out = r(0.3, 0.2);
        if (!out) return;
        this.noise(out, t, { f: 1500, q: 1.5, dur: 0.05, gain: 0.35 });
        this.click(out, t + 0.05, 2900, 0.55);
        return;
      }
      case 'pump': {
        const out = r(0.4, 0.3);
        if (!out) return;
        this.noise(out, t, { f: 1600, f1: 900, q: 3, dur: 0.08, gain: 0.5 });
        this.click(out, t + 0.02, 2100, 0.4);
        this.noise(out, t + 0.18, { f: 1100, f1: 1900, q: 3, dur: 0.08, gain: 0.5 });
        this.click(out, t + 0.25, 2600, 0.5);
        return;
      }
      case 'bolt': {
        const out = r(0.6, 0.3);
        if (!out) return;
        [0, 0.12, 0.3, 0.42].forEach((d, i) => this.click(out, t + d, 1800 + i * 350, 0.4));
        this.noise(out, t + 0.14, { f: 1300, q: 2, dur: 0.14, gain: 0.15 });
        return;
      }
      case 'impact': {
        // amount = size of what was hit off (0.5 a bullet chip, 1 a chunk).
        const size = Math.max(0.1, Math.min(1.5, amount));
        const out = r(0.35 + size * 0.4, 0.3, 0.45 + size * 0.4);
        if (!out) return;
        this.noise(out, t, { f: (2200 + Math.random() * 2400) / (0.6 + size * 0.6), q: 1.5, dur: 0.035, gain: 0.5 });
        this.noise(out, t, { type: 'lowpass', f: 1300 - size * 500, dur: 0.06 + size * 0.08, gain: 0.25 + size * 0.15, buf: this.crackle });
        if (size > 0.6) {
          // Pieces of it landing.
          const n = 1 + Math.round(size * 3);
          for (let i = 0; i < n; i++) {
            const d = 0.08 + Math.random() * 0.35 * size;
            this.thump(out, t + d, 170 + Math.random() * 120 - size * 40, 70, 0.05, 0.07 + Math.random() * 0.07);
            this.noise(out, t + d, { type: 'lowpass', f: 1100, dur: 0.04, gain: 0.12, buf: this.crackle });
          }
        }
        if (Math.random() < 0.22 && size < 0.8) {
          const f = 2600 + Math.random() * 1600;
          this.tone(out, t + 0.01, { type: 'triangle', f, f1: f * 0.55, dur: 0.28, gain: 0.08 });
        }
        return;
      }
      case 'flesh': {
        const out = r(0.25, 0.15, 0.8);
        if (!out) return;
        this.noise(out, t, { type: 'lowpass', f: 550 * jit(), q: 1.5, dur: 0.12, gain: 0.7 });
        this.thump(out, t, 95, 55, 0.1, 0.45);
        this.noise(out, t + 0.02, { f: 1700, q: 2, dur: 0.06, gain: 0.15 });
        return;
      }
      case 'headshot': {
        const out = r(0.35, 0.2);
        if (!out) return;
        this.noise(out, t, { f: 1400, q: 2.5, dur: 0.07, gain: 0.7, buf: this.crackle });
        this.noise(out, t, { type: 'lowpass', f: 700, q: 1, dur: 0.16, gain: 0.7 });
        this.noise(out, t + 0.05, { f: 2400, f1: 900, q: 1.5, dur: 0.18, gain: 0.25 });
        this.thump(out, t, 120, 60, 0.09, 0.5);
        return;
      }
      case 'knife': {
        const out = r(0.4, 0.15);
        if (!out) return;
        this.noise(out, t, { f: 600, f1: 2600, q: 2.5, dur: 0.16, gain: 0.35, attack: 0.04 });
        if (amount > 0.5) {
          this.noise(out, t + 0.15, { type: 'lowpass', f: 600, dur: 0.1, gain: 0.6 });
          this.thump(out, t + 0.15, 110, 60, 0.08, 0.4);
        }
        return;
      }
      case 'throw': {
        const out = r(0.4, 0.1);
        if (out) this.noise(out, t, { f: 500, f1: 1500, q: 2, dur: 0.22, gain: 0.3, attack: 0.05 });
        return;
      }
      case 'clink': {
        const out = r(0.3, 0.3, 0.5 + amount * 0.5);
        if (out) this.bell(out, t, 2900 * jit(), [1, 1.48, 2.11], 0.18, 0.18);
        return;
      }
      case 'boom': {
        const out = r(3, 1.1, 1.4);
        if (!out) return;
        this.thump(out, t, 62, 22, 1.1, 1.3);
        this.thump(out, t, 120, 40, 0.3, 0.6);
        this.noise(out, t, { type: 'lowpass', f: 2600, f1: 160, q: 0.7, dur: 1.9, gain: 1.1, attack: 0.004 });
        this.noise(out, t, { type: 'highpass', f: 3500, q: 0.7, dur: 0.08, gain: 0.8 });
        this.noise(out, t + 0.12, { type: 'highpass', f: 2200, q: 0.5, dur: 1.4, gain: 0.35, buf: this.crackle, attack: 0.1 });
        return;
      }
      case 'crumble': {
        // amount = how much came down (0.1 a chunk, 1 a wall section).
        const out = r(2.2, 0.6, 0.6 + amount * 0.6);
        if (!out) return;
        const dur = 0.6 + amount * 0.9;
        this.noise(out, t, { type: 'lowpass', f: 1900, f1: 380, q: 0.8, dur, gain: 0.45, attack: 0.03, buf: this.crackle });
        this.noise(out, t, { type: 'lowpass', f: 700, f1: 200, q: 0.7, dur, gain: 0.35, attack: 0.05, buf: this.brown });
        const n = 3 + Math.round(amount * 7);
        for (let i = 0; i < n; i++) {
          const d = 0.05 + Math.random() * dur;
          const big = Math.random() < amount * 0.5;
          this.thump(out, t + d, (big ? 90 : 150) + Math.random() * 110, big ? 40 : 60, big ? 0.12 : 0.07, 0.3 + Math.random() * 0.3);
          this.noise(out, t + d, { type: 'lowpass', f: 900 + Math.random() * 900, dur: 0.06, gain: 0.25 });
        }
        // Grit trickling down after.
        this.noise(out, t + dur * 0.6, { f: 3000, q: 0.8, dur: 0.6 + amount * 0.6, gain: 0.08, attack: 0.1, buf: this.crackle });
        return;
      }
      case 'groan': {
        const id = o.id;
        if (id !== undefined && (this.talking.get(id) ?? 0) > t) return;
        if (this.talking.size > 200) for (const [k, end] of this.talking) if (end < t) this.talking.delete(k);
        // A crowd, not a choir: at most a few at once, and starts staggered.
        let busy = 0;
        for (const end of this.talking.values()) if (end > t) busy++;
        if (busy >= MAX_GROANS) return;
        this.groanStarts = this.groanStarts.filter((s) => s > t - 0.8);
        const start = this.groanStarts.length >= 2 ? t + 0.25 + Math.random() * 1.1 : t + Math.random() * 0.08;
        this.groanStarts.push(start);
        const seed = id !== undefined ? ((id * 2654435761) >>> 0) / 4294967296 : Math.random();
        const kind = o.variant !== undefined ? VOICE_KINDS[o.variant % VOICE_KINDS.length] : pickVoice(seed);
        const len = kind === 'breath' ? 1.4 + Math.random() * 0.8 : 0.9 + Math.random() * 1.5;
        const out = r(start - t + len + 0.4, 0.5, 0.45 + amount * 0.6);
        if (!out) return;
        const end = this.groanVoice(ctx, out, start, seed, len, false, kind);
        if (id !== undefined) this.talking.set(id, end + 0.5 + Math.random() * 1.8);
        return;
      }
      case 'scream': {
        const out = r(1.3, 0.6, 0.9);
        if (!out) return;
        const f0 = 230 + Math.random() * 90;
        const src = ctx.createOscillator();
        src.type = 'sawtooth';
        src.frequency.setValueAtTime(f0 * 0.8, t);
        src.frequency.exponentialRampToValueAtTime(f0 * 1.5, t + 0.25);
        src.frequency.exponentialRampToValueAtTime(f0 * 0.6, t + 0.95);
        const vib = ctx.createOscillator();
        vib.frequency.value = 11 + Math.random() * 6;
        const vibAmt = ctx.createGain();
        vibAmt.gain.value = f0 * 0.06;
        vib.connect(vibAmt).connect(src.frequency);
        const drive = ctx.createGain();
        drive.gain.value = 2.5;
        const g = ctx.createGain();
        env(g.gain, t, 0.05, 0.25, 0.95);
        const sh = ctx.createWaveShaper();
        sh.curve = this.shaper!.curve;
        src.connect(drive).connect(sh);
        this.formants(sh, g, [850, 1450, 2900], 6);
        g.connect(out);
        this.noise(out, t, { f: 1800, q: 1, dur: 0.9, gain: 0.15, attack: 0.05 });
        src.start(t);
        vib.start(t);
        src.stop(t + 1.1);
        vib.stop(t + 1.1);
        return;
      }
      case 'swipe': {
        // A hissing intake through the teeth, then the arm coming through the air (lands with the hit at ~0.55 s).
        const out = r(0.75, 0.25);
        if (!out) return;
        this.noise(out, t, { type: 'highpass', f: 2600, f1: 4200, q: 1.2, dur: 0.3, gain: 0.1, attack: 0.18 });
        this.noise(out, t + 0.02, { f: 900, q: 3, dur: 0.28, gain: 0.08, attack: 0.15 });
        this.noise(out, t + 0.32, { f: 1100, f1: 280, q: 1.8, dur: 0.24, gain: 0.45, attack: 0.03 });
        return;
      }
      case 'tear': {
        // Two or three nails screeching out of the wood under strain, the board cracking away, then landing.
        const out = r(1.3, 0.5);
        if (!out) return;
        this.noise(out, t, { f: 320, f1: 720, q: 3, dur: 0.45, gain: 0.25, attack: 0.08, buf: this.crackle });
        const nails = 2 + Math.floor(Math.random() * 2);
        for (let i = 0; i < nails; i++) this.squeal(out, t + 0.04 + i * (0.09 + Math.random() * 0.06), 620 + Math.random() * 520, 0.18 + Math.random() * 0.16, 0.1);
        const c = t + 0.42 + Math.random() * 0.06;
        this.noise(out, c, { f: 1300, q: 1.5, dur: 0.07, gain: 0.85, buf: this.crackle });
        this.noise(out, c, { type: 'highpass', f: 3000, q: 0.7, dur: 0.12, gain: 0.25, buf: this.crackle });
        this.noise(out, c, { type: 'lowpass', f: 600, q: 1, dur: 0.12, gain: 0.5 });
        this.thump(out, c + 0.01, 160, 80, 0.1, 0.35);
        // The board hitting the ground outside.
        const land = c + 0.28 + Math.random() * 0.12;
        this.thump(out, land, 230, 120, 0.06, 0.2);
        this.noise(out, land, { f: 520, q: 3, dur: 0.08, gain: 0.18 });
        this.thump(out, land + 0.11, 260, 140, 0.05, 0.1);
        return;
      }
      case 'hammer': {
        // A nail set with a light tap, then driven home; sometimes a third blow.
        const out = r(0.9, 0.45);
        if (!out) return;
        this.blow(out, t, 0.25);
        this.blow(out, t + 0.2 + Math.random() * 0.04, 1);
        if (Math.random() < 0.35) this.blow(out, t + 0.42 + Math.random() * 0.05, 0.7);
        return;
      }
      case 'buy': {
        const out = r(1.6, 0.4);
        if (!out) return;
        this.click(out, t, 2000, 0.4);
        [392, 466, 587, 698].forEach((f, i) => this.tone(out, t + 0.04 + i * 0.07, { type: 'triangle', f, dur: 1 - i * 0.12, gain: 0.16 }));
        this.bell(out, t + 0.04, 1568, [1, 2.4, 3.9], 0.9, 0.05);
        return;
      }
      case 'deny': {
        const out = r(0.4, 0.1);
        if (!out) return;
        this.tone(out, t, { type: 'square', f: 150, dur: 0.1, gain: 0.12 });
        this.tone(out, t + 0.13, { type: 'square', f: 120, dur: 0.14, gain: 0.12 });
        return;
      }
      case 'points': {
        const out = r(0.1, 0.05);
        if (out) this.tone(out, t, { f: 1700 + amount * 600, dur: 0.035, gain: 0.07 });
        return;
      }
      case 'hurt': {
        const out = r(0.5, 0.1);
        if (!out) return;
        this.noise(out, t, { type: 'lowpass', f: 380, q: 1, dur: 0.2, gain: 0.5 + amount * 0.5 });
        this.thump(out, t, 85, 45, 0.18, 0.6);
        this.noise(out, t, { f: 1600, q: 1.5, dur: 0.06, gain: 0.25, buf: this.crackle });
        return;
      }
      case 'down': {
        const out = r(3, 0.4);
        if (!out) return;
        this.thump(out, t, 70, 30, 0.5, 1);
        this.noise(out, t, { type: 'lowpass', f: 400, q: 0.8, dur: 0.6, gain: 0.6, buf: this.brown });
        this.tone(out, t + 0.05, { f: 3900, dur: 2.6, gain: 0.05, attack: 0.3 });
        return;
      }
      case 'revive': {
        const out = r(1.2, 0.3);
        if (!out) return;
        this.tone(out, t, { f: 330, f1: 660, dur: 0.8, gain: 0.12, attack: 0.2 });
        this.tone(out, t + 0.1, { f: 495, f1: 990, dur: 0.7, gain: 0.08, attack: 0.2 });
        this.noise(out, t, { f: 900, q: 1, dur: 0.5, gain: 0.1, attack: 0.15 });
        return;
      }
      case 'step': {
        const out = r(0.2, 0.05, 0.4 + amount * 0.5);
        if (!out) return;
        const at = pos ?? { x: this.lx, z: this.lz };
        const surface: Surface = o.surface ?? (!this.isInside(at.x, at.z) ? 'mud' : (this.room?.floor ?? 'concrete'));
        // Level the surfaces against each other (measured in the lab).
        out.gain.value *= STEP_LEVEL[surface];
        this.step(out, t, surface, amount);
        return;
      }
      case 'waveStart': {
        const out = r(7, 1);
        if (!out) return;
        this.bell(out, t, 65, [1, 2, 2.76, 5.4, 8.93], 6, 0.6);
        this.bell(out, t, 69.3, [1, 2.01, 3.03], 5, 0.25);
        for (const f of [55, 58.3, 82.4]) this.drone(out, t, f, 4.5, 0.12);
        return;
      }
      case 'waveEnd': {
        const out = r(4, 1);
        if (!out) return;
        [880, 1244.5, 1661].forEach((f, i) => this.bell(out, t + i * 0.32, f, [1, 2.7], 2.6, 0.12));
        return;
      }
      case 'gameOver': {
        const out = r(8, 1);
        if (!out) return;
        this.bell(out, t, 49, [1, 2, 2.76, 5.4], 7, 0.7);
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(110, t);
        osc.frequency.exponentialRampToValueAtTime(41, t + 5);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 420;
        const g = ctx.createGain();
        env(g.gain, t, 1.2, 0.2, 4.5);
        osc.connect(lp).connect(g).connect(out);
        osc.start(t);
        osc.stop(t + 6);
        return;
      }
    }
  }

  /** One footstep on a surface; `amount` is how hard (walk ~0.45, sprint ~0.8, landing 1). */
  private step(out: AudioNode, t: number, surface: Surface, amount: number) {
    const jit = 0.9 + Math.random() * 0.2;
    switch (surface) {
      case 'wood':
        // Hollow boards: a low knock with body, now and then a creak.
        this.thump(out, t, 135 * jit, 85, 0.07, 0.3 + amount * 0.2);
        this.noise(out, t, { f: 360 * jit, q: 2, dur: 0.08, gain: 0.32 });
        this.noise(out, t + 0.005, { f: 2400, q: 2, dur: 0.02, gain: 0.06, buf: this.crackle });
        if (Math.random() < 0.08) this.squeal(out, t + 0.04, 180 + Math.random() * 120, 0.25, 0.025);
        return;
      case 'tile':
        // Hard and clicky, a little gritty.
        this.noise(out, t, { f: 3000 * jit, q: 3, dur: 0.018, gain: 0.22 });
        this.noise(out, t, { type: 'lowpass', f: 520, q: 1.2, dur: 0.05, gain: 0.25 });
        this.noise(out, t + 0.03, { f: 4200, q: 1, dur: 0.03, gain: 0.05, buf: this.crackle });
        return;
      case 'mud':
        // A soft squelch: slow-attack low noise and a wet suck.
        this.noise(out, t, { type: 'lowpass', f: 420 * jit, q: 1.5, dur: 0.12, gain: 0.35, attack: 0.025, buf: this.brown });
        this.tone(out, t + 0.05, { f: 240 * jit, f1: 120, dur: 0.07, gain: 0.04 });
        this.noise(out, t + 0.04, { f: 1500, q: 2, dur: 0.06, gain: 0.04, buf: this.crackle });
        return;
      case 'metal':
        this.noise(out, t, { f: 1800, q: 4, dur: 0.04, gain: 0.25 });
        this.bell(out, t, 620 * jit, [1, 2.4, 3.9], 0.25, 0.04);
        return;
      default:
        // Concrete: a dull heel, gritty scuff.
        this.noise(out, t, { type: 'lowpass', f: 650 * jit, q: 1.2, dur: 0.06, gain: 0.35 });
        this.noise(out, t + 0.01, { f: 2800, q: 2, dur: 0.02, gain: 0.08, buf: this.crackle });
        this.noise(out, t + 0.03, { f: 1700, q: 0.8, dur: 0.05, gain: 0.04, attack: 0.02 });
    }
  }

  /** Swelling filtered saw (wave start, game over). */
  private drone(out: AudioNode, t: number, f: number, dur: number, gain: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(120, t);
    lp.frequency.linearRampToValueAtTime(700, t + dur * 0.6);
    lp.frequency.linearRampToValueAtTime(150, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(SILENT, t);
    g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(SILENT, t + dur);
    osc.connect(lp).connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** Three parallel band-passes (a mouth) from `src` into `out`, optionally gliding to a second shape over `glide` s. */
  private formants(src: AudioNode, out: AudioNode, f: [number, number, number], q: number, to?: [number, number, number], t = 0, glide = 0) {
    const ctx = this.ctx!;
    f.forEach((freq, i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      if (to && glide > 0) {
        bp.frequency.setValueAtTime(freq, t);
        bp.frequency.linearRampToValueAtTime(to[i], t + glide);
      }
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = [1, 0.6, 0.25][i];
      src.connect(bp).connect(g).connect(out);
    });
  }

  /**
   * A zombie vocalisation. `seed` fixes the voice (pitch, mouth shapes); `kind` the delivery:
   * moan (buzzing, wobbling, gliding vowel), gurgle (lower, with wet bubbling), choke (stuttering, pitch breaks),
   * breath (ragged, voiceless in-and-out). Returns its end time.
   */
  private groanVoice(ctx: BaseAudioContext, out: AudioNode | undefined, t: number, seed: number, len: number, far: boolean, kind: VoiceKind = 'moan'): number {
    if (!out) return t;
    const v1 = VOWELS[Math.floor(seed * VOWELS.length) % VOWELS.length];
    const v2 = VOWELS[Math.floor(seed * 97 + Math.random() * 3) % VOWELS.length];
    const shift = 0.88 + ((seed * 7.31) % 1) * 0.26;
    const mouth = (v: [number, number, number]): [number, number, number] => [v[0] * shift, v[1] * shift, v[2]];
    const g = ctx.createGain();
    const peak = (far ? 0.06 : 0.16) * (kind === 'breath' ? 0.55 : 1);
    g.gain.setValueAtTime(SILENT, t);
    g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.35, len * 0.3));
    g.gain.setValueAtTime(peak, t + len * 0.6);
    g.gain.exponentialRampToValueAtTime(SILENT, t + len);
    if (far) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 600;
      g.connect(lp).connect(out);
    } else g.connect(out);

    if (kind === 'breath') {
      // In, out, in: noise through the mouth shape, no pitch.
      const air = ctx.createGain();
      this.formants(air, g, mouth(v1), 4);
      const pulses = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < pulses; i++) {
        const s = t + (i * len) / pulses;
        this.noise(air, s, { type: 'highpass', f: 500, dur: len / pulses - 0.05, gain: i % 2 ? 0.9 : 0.6, attack: 0.15 });
      }
      this.noise(g, t, { f: 2600, q: 1, dur: len, gain: 0.12, attack: 0.2, buf: this.crackle });
      return t + len;
    }

    const f0 = (kind === 'gurgle' ? 45 : 58) + seed * 75 + (Math.random() - 0.5) * 14;
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(f0 * (1.05 + Math.random() * 0.15), t);
    src.frequency.linearRampToValueAtTime(f0 * (1.2 + Math.random() * 0.3), t + len * 0.3);
    src.frequency.exponentialRampToValueAtTime(f0 * 0.7, t + len);
    if (kind === 'choke') {
      // Pitch breaks: the voice cracks up and drops back.
      for (let i = 1; i < 4; i++) {
        const at = t + len * (0.15 + i * 0.2 + Math.random() * 0.05);
        src.frequency.setValueAtTime(f0 * (1.6 + Math.random() * 0.6), at);
        src.frequency.exponentialRampToValueAtTime(f0 * 0.9, at + 0.12);
      }
    }
    // Irregular wobble: slow oscillators at odd rates.
    const wob = ctx.createOscillator();
    wob.frequency.value = 3 + Math.random() * 4;
    const wobAmt = ctx.createGain();
    wobAmt.gain.value = f0 * (0.04 + Math.random() * 0.06);
    wob.connect(wobAmt).connect(src.frequency);
    const rasp = ctx.createOscillator();
    rasp.type = 'square';
    rasp.frequency.value = f0 * 0.5;
    const raspAmt = ctx.createGain();
    raspAmt.gain.value = 0.35;
    const sum = ctx.createGain();
    src.connect(sum);
    rasp.connect(raspAmt).connect(sum);
    const drive = ctx.createGain();
    drive.gain.value = kind === 'gurgle' ? 2.2 : 1.6;
    const sh = ctx.createWaveShaper();
    sh.curve = this.shaper!.curve;
    sum.connect(drive).connect(sh);
    let voiced: AudioNode = sh;
    const extra: OscillatorNode[] = [];
    if (kind === 'choke') {
      // Stutter: the throat closing and opening.
      const gate = ctx.createGain();
      gate.gain.value = 0.55;
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 5 + Math.random() * 4;
      const lfoAmt = ctx.createGain();
      lfoAmt.gain.value = 0.45;
      lfo.connect(lfoAmt).connect(gate.gain);
      sh.connect(gate);
      voiced = gate;
      extra.push(lfo);
    }
    this.formants(voiced, g, mouth(v1), 7, mouth(v2), t, len * 0.8);
    // Wet breath over it.
    this.noise(g, t, { f: 1300, q: 1.2, dur: len, gain: 0.35, attack: 0.2 });
    if (kind === 'gurgle') {
      // Bubbling: low noise chopped by a fast, uneven tremolo.
      const bub = ctx.createGain();
      bub.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.type = 'triangle';
      lfo.frequency.value = 9 + Math.random() * 7;
      const lfoAmt = ctx.createGain();
      lfoAmt.gain.value = 0.5;
      lfo.connect(lfoAmt).connect(bub.gain);
      bub.connect(g);
      this.noise(bub, t, { type: 'lowpass', f: 480, q: 4, dur: len, gain: 0.55, attack: 0.1, buf: this.brown });
      extra.push(lfo);
    }
    for (const o of [src, wob, rasp, ...extra]) {
      o.start(t);
      o.stop(t + len + 0.05);
    }
    return t + len;
  }

  // ---- ambience -------------------------------------------------------------------------------------------------

  /** A point somewhere around the listener at `near`..`far` metres, inside or outside the room when asked (best effort). */
  private around(near: number, far: number, y = 1.5, where: 'in' | 'out' | 'any' = 'any'): Vec3 {
    let p: Vec3 = { x: this.lx, y, z: this.lz };
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * Math.PI * 2;
      const d = near + Math.random() * (far - near) * (where === 'in' ? 1 - i / 14 : 1);
      p = { x: this.lx + Math.cos(ang) * d, y, z: this.lz + Math.sin(ang) * d };
      if (where === 'any' || this.isInside(p.x, p.z) === (where === 'in')) return p;
    }
    return p;
  }

  /** One ambient event. Public for the lab. */
  ambient(kind: 'moan' | 'creak' | 'metal' | 'knock' | 'rats' | 'drip' | 'bell' | 'siren', t = this.ctx?.currentTime ?? 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    switch (kind) {
      case 'moan':
        this.groanVoice(ctx, this.route(ctx, this.around(14, 26, 1.5, 'out'), 0.6, 3, AMB * 3), t, Math.random(), 0.9 + Math.random() * 1.2, true, pickVoice(Math.random()));
        return;
      case 'creak':
        this.creak(t, this.around(8, 18, 3, 'in'));
        return;
      case 'metal': {
        // Sheet metal or a roof beam moving in the wind: slow, inharmonic, ringing.
        const out = this.route(ctx, this.around(8, 18, 4, 'in'), 0.9, 3, AMB * 2.4);
        if (!out) return;
        const f = 38 + Math.random() * 25;
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f, t);
        osc.frequency.linearRampToValueAtTime(f * (1.15 + Math.random() * 0.3), t + 1.8);
        const g = ctx.createGain();
        env(g.gain, t, 0.5, 0.05, 1.8);
        for (const [bf, q, gain] of [
          [430 + Math.random() * 80, 18, 1],
          [1270 + Math.random() * 150, 22, 0.5],
          [2310, 30, 0.25],
        ] as const) {
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = bf;
          bp.Q.value = q;
          const pg = ctx.createGain();
          pg.gain.value = gain;
          osc.connect(bp).connect(pg).connect(g);
        }
        g.connect(out);
        osc.start(t);
        osc.stop(t + 2.4);
        return;
      }
      case 'knock':
        this.knock(t, this.around(12, 24, 1.5, 'out'));
        return;
      case 'rats': {
        // Claws skittering along a wall, a squeak or two.
        const out = this.route(ctx, this.around(5, 12, 0.1, 'in'), 0.35, 2.5, AMB * 0.4);
        if (!out) return;
        let s = t;
        const n = 8 + Math.floor(Math.random() * 14);
        for (let i = 0; i < n; i++) {
          s += 0.03 + Math.random() * 0.06;
          this.noise(out, s, { f: 2800 + Math.random() * 2400, q: 2.5, dur: 0.01, gain: 0.12 + Math.random() * 0.1, buf: this.crackle });
        }
        const squeaks = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < squeaks; i++) {
          const f = 4200 + Math.random() * 1500;
          this.tone(out, t + Math.random() * (s - t), { f, f1: f * 1.15, dur: 0.05 + Math.random() * 0.04, gain: 0.025, attack: 0.008 });
        }
        return;
      }
      case 'drip': {
        // Water dripping into a puddle: a tiny bubble pop, sometimes twice.
        const out = this.route(ctx, this.around(4, 10, 0.1, 'in'), 0.9, 1.2, AMB);
        if (!out) return;
        const n = Math.random() < 0.4 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const f = 900 + Math.random() * 700;
          this.tone(out, t + i * (0.5 + Math.random() * 0.6), { f, f1: f * 2.2, dur: 0.045, gain: 0.1, attack: 0.002 });
        }
        return;
      }
      case 'bell': {
        // A church bell far off: three slow strikes with a minor-third tierce.
        const out = this.route(ctx, this.around(70, 90, 20, 'out'), 1.2, 14, 0.9);
        if (!out) return;
        const f = 196 + Math.random() * 40;
        for (let i = 0; i < 3; i++) this.bell(out, t + i * 2.6, f, [0.5, 1, 1.19, 1.5, 2, 2.52, 3], 6, 0.35);
        return;
      }
      case 'siren': {
        // An air-raid siren somewhere in the dead city: two detuned voices winding up and down.
        const out = this.route(ctx, this.around(80, 100, 15, 'out'), 1, 11, AMB * 4);
        if (!out) return;
        const g = ctx.createGain();
        g.gain.setValueAtTime(SILENT, t);
        g.gain.exponentialRampToValueAtTime(0.08, t + 2.5);
        g.gain.setValueAtTime(0.08, t + 6);
        g.gain.exponentialRampToValueAtTime(SILENT, t + 10);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        g.connect(lp).connect(out);
        for (const det of [0, 7]) {
          const osc = ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(330, t);
          osc.frequency.exponentialRampToValueAtTime(620 + det, t + 3);
          osc.frequency.setValueAtTime(620 + det, t + 5.5);
          osc.frequency.exponentialRampToValueAtTime(300, t + 10);
          osc.connect(g);
          osc.start(t);
          osc.stop(t + 10.1);
        }
        return;
      }
    }
  }

  private creak(t: number, p: Vec3) {
    const ctx = this.ctx!;
    const out = this.route(ctx, p, 0.8, 2, AMB * 1.5);
    if (!out) return;
    const f = 70 + Math.random() * 60;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.linearRampToValueAtTime(f * (1.3 + Math.random() * 0.5), t + 1.2);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.linearRampToValueAtTime(1100, t + 1.2);
    bp.Q.value = 9;
    const g = ctx.createGain();
    env(g.gain, t, 0.3, 0.06, 1.1);
    osc.connect(bp).connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 1.5);
  }

  private knock(t: number, p: Vec3) {
    const out = this.route(this.ctx!, p, 1, 2, AMB * 0.35);
    if (!out) return;
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) this.bell(out, t + i * (0.18 + Math.random() * 0.1), 180 + Math.random() * 60, [1, 2.4, 3.7], 0.6, 0.18);
  }
}

/** Each zombie leans towards one delivery but varies: mostly moans, then gurgles, chokes and ragged breathing. */
function pickVoice(seed: number): VoiceKind {
  const bias = Math.floor(seed * 4);
  const r = Math.random();
  if (r < 0.4) return VOICE_KINDS[bias];
  if (r < 0.75) return 'moan';
  return VOICE_KINDS[Math.floor(Math.random() * 4)];
}

// ---- buffers and curves ---------------------------------------------------------------------------------------------

function env(p: AudioParam, t: number, attack: number, peak: number, decay: number) {
  p.setValueAtTime(SILENT, t);
  p.exponentialRampToValueAtTime(Math.max(peak, SILENT * 2), t + attack);
  p.exponentialRampToValueAtTime(SILENT, t + attack + decay);
}

function makeWhite(ctx: BaseAudioContext) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Brown (integrated) noise: rumble and wind. */
function makeBrown(ctx: BaseAudioContext) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = last * 3.5;
  }
  return buf;
}

/** Sparse random clicks of random size: grit, debris, bone. */
function makeCrackle(ctx: BaseAudioContext) {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    if (Math.random() < 0.006) {
      const amp = (Math.random() * 2 - 1) * (0.4 + Math.random() * 0.6);
      const len = 6 + Math.floor(Math.random() * 50);
      for (let j = 0; j < len && i + j < d.length; j++) d[i + j] += amp * (1 - j / len) * (Math.random() * 2 - 1);
      i += len;
    }
  }
  return buf;
}

/** A dark concrete room's late tail: exponential decay, highs dying faster than lows (early reflections are separate taps). */
function makeImpulse(ctx: BaseAudioContext, seconds: number) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const x = i / ctx.sampleRate;
      const decay = Math.exp(-x * 3.6);
      // The low-pass closes over time: k from 0.6 (bright) to 0.05 (dull).
      const k = 0.05 + 0.55 * Math.exp(-x * 5);
      lp += (Math.random() * 2 - 1 - lp) * k;
      const early = x < 0.08 && Math.random() < 0.01 ? (Math.random() * 2 - 1) * 2 : 0;
      // Fade in over 20 ms: the first reflections come from the tap network.
      d[i] = (lp * 1.6 + early) * decay * (x < 0.02 ? x / 0.02 : 1);
    }
  }
  return buf;
}

function distortionCurve(k: number) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)) / (1 + k / 6);
  }
  return curve;
}

/** Last Light's sound. Pass a context (e.g. an OfflineAudioContext in a lab) to build straight away. */
export function createZAudio(ctx?: BaseAudioContext): ZAudio {
  try {
    return new Graph(ctx);
  } catch {
    const noop = () => undefined;
    return { unlock: noop, listen: noop, play: noop, playAt: noop, setTension: noop, setHurt: noop, dispose: noop };
  }
}

/**
 * Tells the sound where the room is (indoor vs outdoor acoustics, shots heard through the walls) and what the floor
 * is made of (footsteps). Safe on the silent stand-in. Call once the map is known.
 */
export function configureZAudio(audio: ZAudio, room: ZAudioRoom) {
  (audio as Partial<Graph>).configure?.(room);
}
