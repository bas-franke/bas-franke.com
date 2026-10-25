// Garden Sentinels sound: everything synthesized in Web Audio, no files. Cozy and bright: plucks, kalimba and marimba,
// warm pads, chimes, birdsong and trickling water. Combat stays clear when forty towers fire at once.
//
//   one-shot voices -> [gain -> low-pass (distance) -> pan] -> sfx bus ------------------------------------\
//                                                          \-> reverb send -> garden reverb -------------------+
//   laser hum (setBeams) -> sfx bus                                                                            |
//   music layers (pad, melody, arp, bass, perc, boss) -> music bus -> stinger duck -\                          |
//   ambience (breeze, water, birds) -> amb bus --------------------------------------+-> busy duck -------------+
//                                                                                                              |
//                         mix -> glue compressor -> limiter -> soft clip (ceiling -1 dBFS) -> master (volume) -> out
//
// The master follows the site-wide volume (engine/audio.ts `sfx.level` and its subscribe()). Busy combat ducks the
// music and ambience a few dB; fanfares duck the music harder for a moment.
//
// Crowd control: every sound kind has a rate limit (at most N per window; repeats inside the window come out
// quieter), combat sounds share a voice budget, every voice gets a little random pitch, and the bus runs through a
// compressor, a limiter and a soft clipper so nothing can reach 0 dBFS.
//
// Positional: sounds with `at` pan by x relative to the listen() target and fade with distance and camera zoom, so
// other boards in versus are far quieter. Leak and ping keep a floor so you always hear them.
//
// play() options:
//   amount   boom: size 0..1 (values above 1.5 are read as a blast radius in metres); upgrade: the new level (1..3);
//            coin / sell: how much (more coins for bigger amounts)
//   kind     die / dieBig: enemy kind (shard pitch and colour); build / upgrade: tower kind (a little timbre)
//
// Music: generative, D major pentatonic at 96 BPM, an 8-bar AABA' tune on kalimba over pads, regenerated every 16
// bars. setIntensity(0) is sparse and calm, 1 adds marimba arpeggios, bass and soft percussion, 2 is the boss
// variation (the same tune in D minor with toms and low bells). Notes are scheduled ahead on the audio clock.
//
// Labs: createGAudio(ctx) builds straight onto a given context (an OfflineAudioContext) with no bed, and
// primeGAudio(audio, seconds, { music, ambience }) schedules the bed ahead so it can be rendered offline.

import type { EnemyKind } from '@shared/garden/enemies';
import type { TowerKind } from '@shared/garden/towers';
import { sfx } from '../../engine/audio';
import type { GAudio, GSound, P3 } from './api';

type Opts = { at?: P3; amount?: number; kind?: EnemyKind | TowerKind };

const SILENT = 0.0001;
/** Overlapping combat voices; new ones are dropped when the budget is full. */
const MAX_VOICES = 30;
const TICK_MS = 40;
const BPM = 96;
const STEP = 60 / BPM / 4;

/** Rate limit per kind: [window s, max in the window]. */
const RATE: Record<GSound, [number, number]> = {
  laser: [0.1, 3],
  missile: [0.1, 3],
  boom: [0.1, 3],
  zap: [0.1, 2],
  disrupt: [0.12, 2],
  blocked: [0.1, 2],
  die: [0.1, 4],
  dieBig: [0.2, 2],
  leak: [0.3, 2],
  build: [0.08, 2],
  upgrade: [0.1, 2],
  sell: [0.1, 2],
  deny: [0.12, 1],
  click: [0.03, 1],
  hover: [0.04, 1],
  coin: [0.06, 2],
  waveStart: [1, 1],
  bossWave: [1, 1],
  waveClear: [1, 1],
  send: [0.1, 2],
  incoming: [0.4, 1],
  out: [1, 1],
  ping: [0.2, 2],
  victory: [3, 1],
  defeat: [3, 1],
};

/** Combat sounds hold a voice for this long (others always play). */
const COMBAT: Partial<Record<GSound, number>> = {
  laser: 0.2,
  missile: 0.4,
  boom: 0.7,
  zap: 0.15,
  disrupt: 0.5,
  blocked: 0.7,
  die: 0.4,
  dieBig: 1.2,
};

/** Reverb send per sound. */
const VERB: Partial<Record<GSound, number>> = {
  blocked: 0.35,
  die: 0.22,
  dieBig: 0.3,
  leak: 0.45,
  upgrade: 0.3,
  waveStart: 0.25,
  bossWave: 0.3,
  waveClear: 0.35,
  incoming: 0.3,
  ping: 0.45,
  victory: 0.35,
  defeat: 0.4,
  coin: 0.15,
  sell: 0.15,
  disrupt: 0.2,
};

/** Positional sounds that never fade below this (you must hear a leak on your board). */
const FLOOR: Partial<Record<GSound, number>> = { leak: 0.45, ping: 0.4, incoming: 1, send: 0.5 };

/** Level trims per sound, set from the lab's offline readings (lab-garden-audio.html?measure=1). */
const TRIM: Partial<Record<GSound, number>> = {
  laser: 1.5,
  missile: 1.8,
  zap: 3.5,
  build: 2,
  deny: 1.4,
  click: 4,
  hover: 5,
  coin: 2.6,
  send: 1.7,
  ping: 1.6,
  bossWave: 0.85,
  victory: 0.85,
};

const DIE_PITCH: Record<EnemyKind, number> = { runner: 2300, skitter: 3100, disruptor: 1900, brute: 1500, colossus: 1100 };
const TOWER_PITCH: Record<TowerKind, number> = { laser: 1.08, shield: 0.92, slow: 1, missile: 0.84, beacon: 1.18 };

const mf = (m: number) => 440 * 2 ** ((m - 69) / 12);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const db = (d: number) => 10 ** (d / 20);

// ---- music material -------------------------------------------------------------------------------------------------

interface Chord {
  bass: number;
  pad: number[];
  /** Pitch classes melody notes snap to on strong beats. */
  tones: number[];
}

const MAJOR: Chord[][] = [
  [
    { bass: 50, pad: [62, 66, 69, 73], tones: [2, 6, 9, 1] }, // Dmaj7
    { bass: 47, pad: [62, 66, 69, 71], tones: [11, 2, 6, 9] }, // Bm7
    { bass: 43, pad: [62, 66, 67, 71], tones: [7, 11, 2, 6] }, // Gmaj7
    { bass: 45, pad: [61, 64, 66, 69], tones: [9, 1, 4, 6] }, // A6
  ],
  [
    { bass: 43, pad: [59, 62, 66, 69], tones: [7, 11, 2, 6] }, // Gmaj7
    { bass: 45, pad: [61, 64, 69, 71], tones: [9, 1, 4, 11] }, // Aadd9
    { bass: 42, pad: [61, 64, 66, 69], tones: [6, 9, 1, 4] }, // F#m7
    { bass: 47, pad: [62, 66, 69, 71], tones: [11, 2, 6, 9] }, // Bm7
  ],
];
const MINOR: Chord[][] = [
  [
    { bass: 50, pad: [60, 62, 65, 69], tones: [2, 5, 9, 0] }, // Dm7
    { bass: 46, pad: [58, 62, 65, 69], tones: [10, 2, 5, 9] }, // Bbmaj7
    { bass: 43, pad: [58, 62, 65, 67], tones: [7, 10, 2, 5] }, // Gm7
    { bass: 45, pad: [57, 61, 64, 67], tones: [9, 1, 4, 7] }, // A7
  ],
  [
    { bass: 46, pad: [58, 62, 65, 69], tones: [10, 2, 5, 9] }, // Bbmaj7
    { bass: 48, pad: [60, 64, 67, 70], tones: [0, 4, 7, 10] }, // C7
    { bass: 50, pad: [60, 62, 65, 69], tones: [2, 5, 9, 0] }, // Dm7
    { bass: 45, pad: [57, 61, 64, 67], tones: [9, 1, 4, 7] }, // A7
  ],
];

const scaleNotes = (pcs: number[]) => {
  const out: number[] = [];
  for (let m = 62; m <= 93; m++) if (pcs.includes(m % 12)) out.push(m);
  return out;
};
const SCALE_MAJOR = scaleNotes([2, 4, 6, 9, 11]);
const SCALE_MINOR = scaleNotes([2, 5, 7, 9, 0]);
/** Index of D5 in both scales: the melody's home. */
const HOME = SCALE_MAJOR.indexOf(74);

const RHYTHMS = [
  [1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0],
  [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 0, 0],
  [1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 0, 0, 0],
  [0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0],
  [1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0],
];

type Slot = { deg: number; core: boolean } | null;

function genMotif(start: number): Slot[] {
  const rhythm = pick(RHYTHMS);
  let deg = start;
  let first = true;
  return rhythm.map((on, i) => {
    if (!on) return null;
    if (!first) deg = clamp(deg + pick([-2, -1, -1, 0, 1, 1, 2, 3, -3]), -4, 7);
    const core = first || i % 4 === 0 || Math.random() < 0.3;
    first = false;
    return { deg, core };
  });
}

function varyMotif(m: Slot[]): Slot[] {
  return m.map((s, i) => (s && i >= 10 ? { deg: clamp(s.deg + pick([-2, -1, 1, 2]), -4, 7), core: s.core } : s));
}

// ---- layers of the music, their gains by intensity -------------------------------------------------------------------

type Layer = 'pad' | 'mel' | 'arp' | 'bass' | 'perc' | 'boss';
const LAYERS: Layer[] = ['pad', 'mel', 'arp', 'bass', 'perc', 'boss'];

function layerTarget(l: Layer, x: number): number {
  const up = clamp(x, 0, 1);
  const boss = clamp(x - 1, 0, 1);
  switch (l) {
    case 'pad':
      return 1 - 0.15 * boss;
    case 'mel':
      return 0.85 + 0.15 * up - 0.1 * boss;
    case 'arp':
      return up * (1 - 0.25 * boss);
    case 'bass':
      return up;
    case 'perc':
      return up;
    case 'boss':
      return boss;
  }
}

/** A setTargetAtTime fade we can evaluate ourselves (to skip scheduling notes for silent layers). */
class Fade {
  from = 0;
  to = 0;
  t0 = 0;
  constructor(
    v: number,
    readonly tc: number,
  ) {
    this.from = this.to = v;
  }
  at(t: number) {
    return this.to + (this.from - this.to) * Math.exp(-Math.max(0, t - this.t0) / this.tc);
  }
  set(v: number, t: number) {
    this.from = this.at(t);
    this.to = v;
    this.t0 = t;
  }
}

// ---- the graph ------------------------------------------------------------------------------------------------------

class Graph implements GAudio {
  private ctx?: BaseAudioContext;
  private master?: GainNode;
  private sfxBus?: GainNode;
  private verbIn?: GainNode;
  private musicBus?: GainNode;
  private stingDuck?: GainNode;
  private busyDuck?: GainNode;
  private ambBus?: GainNode;
  private humGain?: GainNode;
  private humOsc: OscillatorNode[] = [];
  private white?: AudioBuffer;
  private pink?: AudioBuffer;
  private crackle?: AudioBuffer;
  private layer = {} as Record<Layer, GainNode>;
  private fade = {} as Record<Layer, Fade>;
  private melEcho?: GainNode;

  private offVolume: () => void;
  private offline = false;
  private unlocked = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastTick = 0;

  private lx = 0;
  private lz = 0;
  private zoom = 0;
  private hist = new Map<GSound, number[]>();
  private voices = new Float64Array(MAX_VOICES);
  private busy = 0;
  private beams = 0;
  private intensity = 0;

  // Sequencer.
  private musicOn = false;
  private ambOn = false;
  private nextStep = 0;
  private stepIdx = 0;
  private minor = false;
  private chord: Chord = MAJOR[0][0];
  private motifs: Slot[][] = [];
  private nextBird = 0;

  constructor(ctx?: BaseAudioContext) {
    this.offVolume = sfx.subscribe(() => this.applyMaster());
    if (ctx) {
      this.offline = true;
      this.unlocked = true;
      this.build(ctx);
    }
  }

  // ---- setup ------------------------------------------------------------------------------------------------------

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
      this.startBed(true, true);
      this.timer = setTimeout(this.tick, TICK_MS);
    }
    const ctx = this.ctx as AudioContext;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') void ctx.resume().catch(() => undefined);
  }

  private build(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.white = makeWhite(ctx);
    this.pink = makePink(ctx);
    this.crackle = makeCrackle(ctx);
    this.master = ctx.createGain();
    this.master.gain.value = this.level();
    // Glue, then a fast limiter, then a soft clipper whose ceiling is -1 dBFS: the master (<= 1) only lowers it.
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -20;
    glue.knee.value = 12;
    glue.ratio.value = 3;
    glue.attack.value = 0.006;
    glue.release.value = 0.25;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -5;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.001;
    limit.release.value = 0.12;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve(0.7, db(-1.1));
    const mix = ctx.createGain();
    mix.connect(glue).connect(limit).connect(clip).connect(this.master).connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(mix);

    // A small, bright garden reverb (a greenhouse more than a hall).
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(ctx, 1.6);
    this.verbIn = ctx.createGain();
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.55;
    this.verbIn.connect(verb).connect(verbOut).connect(mix);

    this.busyDuck = ctx.createGain();
    this.busyDuck.connect(mix);
    this.stingDuck = ctx.createGain();
    this.stingDuck.connect(this.busyDuck);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.045; // ~4 dB under the first mix: music sits ~18 dB below combat effects
    this.musicBus.connect(this.stingDuck);
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 0.13;
    this.ambBus.connect(this.busyDuck);

    // Shared laser hum: two soft detuned tones with a slow shimmer, faded in by setBeams().
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    const humLp = ctx.createBiquadFilter();
    humLp.type = 'lowpass';
    humLp.frequency.value = 1400;
    const trem = ctx.createGain();
    trem.gain.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.3;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.2;
    lfo.connect(lfoAmt).connect(trem.gain);
    for (const [f, type, g] of [
      [392, 'triangle', 0.5],
      [588.5, 'sine', 0.35],
      [1176, 'sine', 0.08],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(humLp);
      o.start();
      this.humOsc.push(o);
    }
    humLp.connect(trem).connect(this.humGain).connect(this.sfxBus);
    lfo.start();
    this.humOsc.push(lfo);

    // Music layers.
    const padLp = ctx.createBiquadFilter();
    padLp.type = 'lowpass';
    padLp.frequency.value = 1100;
    padLp.Q.value = 0.4;
    const padLfo = ctx.createOscillator();
    padLfo.frequency.value = 0.09;
    const padLfoAmt = ctx.createGain();
    padLfoAmt.gain.value = 350;
    padLfo.connect(padLfoAmt).connect(padLp.frequency);
    padLfo.start();
    this.humOsc.push(padLfo);
    for (const l of LAYERS) {
      const g = ctx.createGain();
      const v = layerTarget(l, 0);
      g.gain.value = v;
      this.fade[l] = new Fade(v, 1.2);
      this.layer[l] = g;
      if (l === 'pad') g.connect(padLp).connect(this.musicBus);
      else g.connect(this.musicBus);
    }
    const musicVerb = ctx.createGain();
    musicVerb.gain.value = 0.5;
    this.musicBus.connect(musicVerb).connect(this.verbIn);
    // A soft dotted-eighth echo on the melody.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = STEP * 3;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 2600;
    this.melEcho = ctx.createGain();
    this.melEcho.gain.value = 0.28;
    this.layer.mel.connect(this.melEcho).connect(delay).connect(dlp).connect(fb).connect(delay);
    const pan = ctx.createStereoPanner();
    pan.pan.value = 0.35;
    dlp.connect(pan).connect(this.musicBus);
  }

  /** Starts the ambient bed and / or the music (live at unlock, or a lab before an offline render). */
  startBed(music: boolean, ambience: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.05;
    if (music && !this.musicOn) {
      this.musicOn = true;
      this.nextStep = t;
      this.stepIdx = 0;
    }
    if (ambience && !this.ambOn) {
      this.ambOn = true;
      this.nextBird = t + 1.5;
      this.buildAmbience(ctx);
    }
  }

  private buildAmbience(ctx: BaseAudioContext) {
    const amb = this.ambBus!;
    // Breeze: pink noise through a wandering low band, swelling slowly.
    const src = ctx.createBufferSource();
    src.buffer = this.pink!;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.6;
    const wander = ctx.createOscillator();
    wander.frequency.value = 0.06;
    const wanderAmt = ctx.createGain();
    wanderAmt.gain.value = 180;
    wander.connect(wanderAmt).connect(bp.frequency);
    const breeze = ctx.createGain();
    breeze.gain.value = 0.1;
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.037;
    const swellAmt = ctx.createGain();
    swellAmt.gain.value = 0.06;
    swell.connect(swellAmt).connect(breeze.gain);
    src.connect(bp).connect(breeze).connect(amb);
    // Leaves: a whisper of high noise riding the same swell.
    const leaves = ctx.createBiquadFilter();
    leaves.type = 'highpass';
    leaves.frequency.value = 4500;
    const leafGain = ctx.createGain();
    leafGain.gain.value = 0.012;
    src.connect(leaves).connect(leafGain).connect(amb);
    // Water trickling somewhere off to the side: two decorrelated loops of a procedural droplet buffer.
    const water = makeWater(ctx);
    for (const [rate, p, g] of [
      [1, -0.55, 0.16],
      [0.93, 0.4, 0.11],
    ] as const) {
      const w = ctx.createBufferSource();
      w.buffer = water;
      w.loop = true;
      w.playbackRate.value = rate;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 500;
      const wp = ctx.createStereoPanner();
      wp.pan.value = p;
      const wg = ctx.createGain();
      wg.gain.value = g;
      w.connect(hp).connect(wg).connect(wp).connect(amb);
      w.start(ctx.currentTime, Math.random() * 3);
    }
    src.start(ctx.currentTime, Math.random() * 3);
    wander.start();
    swell.start();
  }

  private level() {
    if (this.offline) return 1;
    return Math.min(1, sfx.level * 2);
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

  private tick = () => {
    this.timer = undefined;
    if (this.disposed) return;
    const ctx = this.live();
    if (ctx) {
      const now = ctx.currentTime;
      const dt = Math.min(1, now - this.lastTick);
      this.lastTick = now;
      // Busy combat ducks the bed: a few dB at most.
      this.busy *= Math.exp(-dt / 0.7);
      this.busyDuck!.gain.setTargetAtTime(db(-Math.min(5, this.busy * 0.35)), now, 0.15);
      // Hidden tabs get ~1 Hz timers: schedule further ahead then.
      const hidden = typeof document !== 'undefined' && document.hidden;
      this.pump(now + (hidden ? 1.6 : 0.2));
    }
    this.timer = setTimeout(this.tick, TICK_MS);
  };

  /** Schedules music steps and ambient events up to `until` (audio clock). */
  pump(until: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.musicOn) {
      // Fell behind (suspended, muted, throttled): skip ahead rather than burst.
      if (this.nextStep < ctx.currentTime - 0.05) this.nextStep = ctx.currentTime + 0.05;
      while (this.nextStep < until) {
        this.step(this.nextStep, this.stepIdx);
        this.nextStep += STEP;
        this.stepIdx++;
      }
    }
    if (this.ambOn) {
      if (this.nextBird < ctx.currentTime - 0.05) this.nextBird = ctx.currentTime + rnd(1, 4);
      while (this.nextBird < until) {
        this.bird(this.nextBird);
        // Fewer birds when the boss is in.
        this.nextBird += rnd(1.8, 6) * (1 + clamp(this.intensity - 1, 0, 1));
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.offVolume();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const ctx = this.ctx as AudioContext | undefined;
    if (ctx && !this.offline && typeof ctx.close === 'function') void ctx.close().catch(() => undefined);
    this.ctx = undefined;
  }

  // ---- control ----------------------------------------------------------------------------------------------------

  listen(target: P3, zoom: number) {
    this.lx = target.x;
    this.lz = target.z;
    this.zoom = clamp(zoom, 0, 1);
  }

  setBeams(n: number) {
    const ctx = this.ctx;
    this.beams = Math.max(0, n | 0);
    if (!ctx || !this.humGain) return;
    const t = ctx.currentTime;
    const g = this.beams ? 0.018 * Math.min(2, Math.sqrt(this.beams)) * (1 - 0.3 * this.zoom) : 0;
    this.humGain.gain.setTargetAtTime(g, t, this.beams ? 0.08 : 0.25);
    const p = 1 + 0.015 * Math.min(12, this.beams);
    this.humOsc[0].frequency.setTargetAtTime(392 * p, t, 0.3);
    this.humOsc[1].frequency.setTargetAtTime(588.5 * p, t, 0.3);
    this.humOsc[2].frequency.setTargetAtTime(1176 * p, t, 0.3);
  }

  setIntensity(x: number) {
    this.intensity = clamp(Number.isFinite(x) ? x : 0, 0, 2);
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const l of LAYERS) {
      const v = layerTarget(l, this.intensity);
      if (Math.abs(v - this.fade[l].to) < 1e-3) continue;
      this.fade[l].set(v, t);
      this.layer[l].gain.setTargetAtTime(v, t, this.fade[l].tc);
    }
  }

  private duck(dB: number, hold: number) {
    const ctx = this.ctx!;
    const g = this.stingDuck!.gain;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(db(-dB), t, 0.06);
    g.setTargetAtTime(1, t + hold, 0.7);
  }

  // ---- one-shots --------------------------------------------------------------------------------------------------

  play(name: GSound, opts: Opts = {}) {
    const ctx = this.live();
    if (!ctx) return;
    const now = ctx.currentTime;
    // Rate limit: at most N of a kind per window, repeats inside it quieter.
    const [win, max] = RATE[name];
    let h = this.hist.get(name);
    if (!h) this.hist.set(name, (h = []));
    while (h.length && h[0] < now - win) h.shift();
    if (h.length >= max) return;
    h.push(now);
    let a = (TRIM[name] ?? 1) / (1 + 0.4 * (h.length - 1));
    let pan = 0;
    let cut = 20000;
    if (opts.at) {
      const dx = opts.at.x - this.lx;
      const dz = opts.at.z - this.lz;
      const d = Math.hypot(dx, dz);
      const ref = 14 + 26 * this.zoom;
      let g = (d <= ref ? 1 : (ref / d) ** 1.5) * (1 - 0.3 * this.zoom);
      g = Math.max(g, FLOOR[name] ?? 0);
      if (g < 0.03) return;
      a *= g;
      pan = clamp(dx / (12 + 22 * this.zoom), -1, 1) * 0.75;
      if (d > ref) cut = 20000 / (1 + (d - ref) / 6);
    }
    const hold = COMBAT[name];
    if (hold !== undefined) {
      if (!this.claim(now, hold)) return;
      this.busy += 1;
    }
    const out = this.route(ctx, pan, cut, VERB[name] ?? 0);
    this.emit(ctx, name, out, now + 0.005, a, opts);
  }

  private claim(now: number, dur: number) {
    const v = this.voices;
    for (let i = 0; i < v.length; i++)
      if (v[i] <= now) {
        v[i] = now + dur;
        return true;
      }
    return false;
  }

  /** Input node of a voice: [low-pass] -> [pan] -> sfx bus, plus a reverb send. */
  private route(ctx: BaseAudioContext, pan: number, cut: number, verb: number): AudioNode {
    let head: AudioNode = this.sfxBus!;
    if (cut < 16000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cut;
      lp.connect(head);
      head = lp;
    }
    if (Math.abs(pan) > 0.02) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(head);
      head = p;
    }
    if (verb > 0) {
      const v = ctx.createGain();
      v.gain.value = 1;
      const s = ctx.createGain();
      s.gain.value = verb;
      v.connect(head);
      v.connect(s).connect(this.verbIn!);
      head = v;
    }
    return head;
  }

  // ---- synth layers -----------------------------------------------------------------------------------------------

  private tone(out: AudioNode, t: number, f: number, dur: number, type: OscillatorType, gain: number, slide = 1, attack = 0.004) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (slide !== 1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f * slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(SILENT, t + Math.max(dur, attack + 0.01));
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  private noise(out: AudioNode, t: number, dur: number, gain: number, type: BiquadFilterType, f0: number, f1 = f0, q = 0.7, buf = this.white!, attack = 0.003) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(SILENT, t + Math.max(dur, attack + 0.01));
    src.connect(filter).connect(g).connect(out);
    src.start(t, Math.random() * (buf.duration - 0.1));
    src.stop(t + dur + 0.03);
  }

  /** Struck bell / chime: inharmonic partials decaying at different rates. */
  private bell(out: AudioNode, t: number, f: number, dur: number, gain: number) {
    this.tone(out, t, f, dur, 'sine', gain, 1, 0.002);
    this.tone(out, t, f * 2.76, dur * 0.4, 'sine', gain * 0.3, 1, 0.002);
    this.tone(out, t, f * 5.4, dur * 0.15, 'sine', gain * 0.1, 1, 0.001);
  }

  /** Kalimba tine: a sine with a quick metallic overtone and a tiny pluck click. */
  private kalimba(out: AudioNode, t: number, f: number, dur: number, gain: number) {
    this.tone(out, t, f, dur, 'sine', gain, 1, 0.002);
    this.tone(out, t, f * 5.95, 0.09, 'sine', gain * 0.16, 1, 0.001);
    this.noise(out, t, 0.012, gain * 0.25, 'bandpass', Math.min(9000, f * 4), f * 4, 1.5, this.white, 0.001);
  }

  /** Marimba bar: fundamental plus the tuned fourth harmonic and a woody tick. */
  private marimba(out: AudioNode, t: number, f: number, dur: number, gain: number) {
    this.tone(out, t, f, dur, 'sine', gain, 1, 0.002);
    this.tone(out, t, f * 4, dur * 0.2, 'sine', gain * 0.22, 1, 0.001);
    this.tone(out, t, f * 10, 0.03, 'sine', gain * 0.05, 1, 0.001);
  }

  /** Soft friendly horn: two detuned saws through a low-pass that opens on the attack. */
  private horn(out: AudioNode, t: number, f: number, dur: number, gain: number) {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(f * 1.5, t);
    lp.frequency.linearRampToValueAtTime(Math.min(6000, f * 5), t + 0.07);
    lp.frequency.exponentialRampToValueAtTime(Math.min(4000, f * 2.4), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.04);
    g.gain.linearRampToValueAtTime(gain * 0.75, t + dur * 0.8);
    g.gain.exponentialRampToValueAtTime(SILENT, t + dur + 0.18);
    for (const d of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = d;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.22);
    }
    lp.connect(g).connect(out);
  }

  /** Tone with vibrato: used for warbles, deflates and dove coos. */
  private warble(out: AudioNode, t: number, f: number, dur: number, gain: number, slide: number, rate: number, depth: number, type: OscillatorType = 'sine', attack = 0.02) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f * slide), t + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate;
    const amt = ctx.createGain();
    amt.gain.value = depth;
    lfo.connect(amt).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(SILENT, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.03);
    lfo.stop(t + dur + 0.03);
  }

  private emit(ctx: BaseAudioContext, name: GSound, out: AudioNode, t: number, a: number, opts: Opts) {
    const r = rnd(0.94, 1.06);
    const amount = opts.amount ?? 0.5;
    switch (name) {
      case 'laser': {
        // A quick bright "zing" down, with a glassy partial.
        const f = 2300 * r;
        this.tone(out, t, f, 0.16, 'sine', 0.3 * a, 0.5, 0.002);
        this.tone(out, t, f * 1.5, 0.08, 'triangle', 0.08 * a, 0.6, 0.002);
        this.noise(out, t, 0.04, 0.05 * a, 'bandpass', 6000, 6000, 2, this.white, 0.001);
        break;
      }
      case 'missile':
        // A puff and a rising whoosh.
        this.tone(out, t, 170 * r, 0.14, 'sine', 0.35 * a, 0.5, 0.003);
        this.noise(out, t, 0.02, 0.12 * a, 'bandpass', 1500, 1500, 1.5, this.white, 0.001);
        this.noise(out, t + 0.01, 0.42, 0.35 * a, 'bandpass', 350 * r, 2200 * r, 1.4, this.white, 0.05);
        break;
      case 'boom': {
        // A soft round thump with a crackle of seeds, sized by the blast.
        const s = clamp(amount > 1.5 ? amount / 4 : amount, 0.2, 1.5);
        const k = 0.6 + 0.4 * Math.min(1, s);
        this.tone(out, t, 125 * r * (1.15 - 0.3 * Math.min(1, s)), 0.28 + 0.25 * s, 'sine', 0.7 * a * k, 0.35, 0.006);
        this.noise(out, t, 0.3 + 0.3 * s, 0.4 * a * k, 'lowpass', 1600 * r, 120, 0.7, this.pink, 0.006);
        this.noise(out, t + 0.02, 0.22 + 0.2 * s, 0.25 * a * k, 'highpass', 2600, 2600, 0.7, this.crackle, 0.01);
        break;
      }
      case 'zap':
        // Electric pop: a snap of noise and a falling blip.
        this.noise(out, t, 0.06, 0.4 * a, 'bandpass', 2600 * r, 900, 3, this.white, 0.001);
        this.tone(out, t, 1300 * r, 0.09, 'triangle', 0.22 * a, 0.35, 0.001);
        this.tone(out, t, 2700 * r, 0.04, 'sine', 0.08 * a, 1, 0.001);
        break;
      case 'disrupt':
        // Violet warble: a wobbling, sinking tone with a fifth above.
        this.warble(out, t, 660 * r, 0.42, 0.28 * a, 0.62, 12, 45, 'sine', 0.03);
        this.warble(out, t, 990 * r, 0.32, 0.07 * a, 0.62, 12, 60, 'triangle', 0.03);
        this.noise(out, t, 0.3, 0.05 * a, 'bandpass', 1800, 900, 4, this.white, 0.04);
        break;
      case 'blocked':
        // Shield ding.
        this.bell(out, t, 1568 * r, 0.7, 0.28 * a);
        this.tone(out, t + 0.01, 2349 * r, 0.25, 'sine', 0.08 * a, 1, 0.002);
        break;
      case 'die':
      case 'dieBig': {
        const kind = (opts.kind as EnemyKind) in DIE_PITCH ? (opts.kind as EnemyKind) : name === 'dieBig' ? 'brute' : 'runner';
        const big = name === 'dieBig';
        const base = DIE_PITCH[kind] * r * (big ? 0.75 : 1);
        const ratios = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
        const n = big ? 9 : 4 + Math.floor(Math.random() * 3);
        const spread = big ? 0.28 : 0.09;
        for (let i = 0; i < n; i++) {
          const tt = t + Math.random() * spread;
          const f = base * pick(ratios) * rnd(0.98, 1.02);
          const d = rnd(0.12, 0.32) * (big ? 1.4 : 1);
          this.tone(out, tt, f, d, 'sine', 0.1 * a, 1, 0.001);
          this.tone(out, tt, f * 2.76, d * 0.35, 'sine', 0.025 * a, 1, 0.001);
        }
        // The crunch and a little hollow pop of the body.
        this.noise(out, t, big ? 0.14 : 0.06, (big ? 0.18 : 0.12) * a, 'highpass', 4200, 4200, 0.7, this.white, 0.001);
        this.tone(out, t, (big ? 300 : 620) * r, big ? 0.12 : 0.06, 'sine', 0.16 * a, 0.5, 0.002);
        if (kind === 'disruptor') this.warble(out, t, 880 * r, 0.25, 0.06 * a, 0.7, 14, 50);
        if (big) {
          const deep = kind === 'colossus' ? 0.75 : 1;
          this.tone(out, t, 140 * r * deep, 0.45, 'sine', 0.55 * a, 0.36, 0.005);
          this.noise(out, t, 0.4, 0.28 * a, 'lowpass', 900, 100, 0.7, this.pink, 0.005);
          this.bell(out, t + 0.05, 392 * deep, 1.3, 0.1 * a);
          this.bell(out, t + 0.05, 587 * deep, 1.1, 0.07 * a);
        }
        break;
      }
      case 'leak':
        // A sad descending chime (A minor arpeggio) and a soft low thud.
        [659, 523, 440].forEach((f, i) => this.bell(out, t + i * 0.17, f, 0.9, 0.22 * a));
        this.tone(out, t, 110, 0.3, 'sine', 0.3 * a, 0.6, 0.006);
        break;
      case 'build': {
        // Wooden / ceramic clunk, then a rustle of leaves settling.
        const k = TOWER_PITCH[opts.kind as TowerKind] ?? 1;
        this.tone(out, t, 200 * r * k, 0.14, 'sine', 0.5 * a, 0.62, 0.003);
        this.noise(out, t, 0.07, 0.35 * a, 'bandpass', 900 * r * k, 700, 2.5, this.white, 0.001);
        this.tone(out, t + 0.01, 2300 * r * k, 0.05, 'sine', 0.08 * a, 1, 0.001);
        this.tone(out, t + 0.01, 3450 * r * k, 0.035, 'sine', 0.04 * a, 1, 0.001);
        for (let i = 0; i < 5; i++) this.noise(out, t + 0.06 + i * rnd(0.03, 0.06), rnd(0.04, 0.08), rnd(0.05, 0.09) * a, 'bandpass', rnd(4500, 7000), rnd(3500, 5000), 0.9, this.white, 0.008);
        break;
      }
      case 'upgrade': {
        // Rising sparkle arpeggio; level 3 climbs higher.
        const lv = clamp(Math.round(opts.amount ?? 2), 1, 3);
        const notes = [74, 76, 78, 81, 83, 86, 88, 90].slice(0, 5 + lv);
        notes.forEach((m, i) => {
          const f = mf(m) * r;
          this.tone(out, t + i * 0.05, f, 0.32, 'triangle', 0.13 * a, 1, 0.003);
          this.tone(out, t + i * 0.05, f * 2, 0.18, 'sine', 0.04 * a, 1, 0.002);
        });
        this.noise(out, t, 0.5, 0.035 * a, 'highpass', 7000, 9000, 0.7, this.white, 0.12);
        break;
      }
      case 'sell': {
        // Coins tumbling into a pouch.
        const n = 3 + Math.min(3, Math.floor((opts.amount ?? 0) / 50));
        for (let i = 0; i < n; i++) {
          const tt = t + i * 0.055 + rnd(0, 0.02);
          const f = 2500 * rnd(0.95, 1.18);
          this.tone(out, tt, f, 0.16, 'sine', 0.09 * a, 1, 0.001);
          this.tone(out, tt, f * 1.48, 0.1, 'sine', 0.05 * a, 1, 0.001);
          this.tone(out, tt, f * 2.1, 0.06, 'sine', 0.03 * a, 1, 0.001);
        }
        this.noise(out, t, 0.15, 0.08 * a, 'lowpass', 1400, 300, 0.7, this.pink, 0.01);
        break;
      }
      case 'deny':
        this.tone(out, t, 300 * r, 0.16, 'sine', 0.35 * a, 0.62, 0.005);
        this.tone(out, t, 150 * r, 0.12, 'triangle', 0.1 * a, 0.8, 0.005);
        break;
      case 'click':
        this.tone(out, t, 1900 * r, 0.035, 'sine', 0.13 * a, 1, 0.001);
        this.noise(out, t, 0.012, 0.05 * a, 'bandpass', 4200, 4200, 2, this.white, 0.001);
        break;
      case 'hover':
        this.tone(out, t, 2800 * r, 0.025, 'sine', 0.05 * a, 1, 0.001);
        break;
      case 'coin':
        this.tone(out, t, 2093 * r, 0.07, 'sine', 0.1 * a, 1, 0.001);
        this.tone(out, t + 0.04, 3136 * r, 0.12, 'sine', 0.09 * a, 1, 0.001);
        break;
      case 'waveStart':
        // Friendly horn call: D - A - D, with a mallet chord under the last note.
        this.duck(5, 1.1);
        this.horn(out, t, mf(62), 0.12, 0.13 * a);
        this.horn(out, t + 0.14, mf(69), 0.12, 0.13 * a);
        this.horn(out, t + 0.28, mf(74), 0.6, 0.15 * a);
        this.horn(out, t + 0.28, mf(66), 0.6, 0.08 * a);
        for (const m of [62, 66, 69, 74]) this.marimba(out, t + 0.28, mf(m), 0.8, 0.08 * a);
        break;
      case 'bossWave':
        // Something big is coming: two soft timpani thumps and a low "uh-oh" horn, minor but rounded.
        this.duck(8, 2.2);
        this.tone(out, t, 82, 0.6, 'sine', 0.55 * a, 0.85, 0.005);
        this.tone(out, t + 0.36, 82, 0.7, 'sine', 0.6 * a, 0.85, 0.005);
        this.noise(out, t, 0.2, 0.12 * a, 'lowpass', 500, 120, 0.7, this.pink, 0.004);
        this.noise(out, t + 0.36, 0.2, 0.12 * a, 'lowpass', 500, 120, 0.7, this.pink, 0.004);
        this.horn(out, t + 0.7, mf(57), 0.35, 0.13 * a);
        this.horn(out, t + 1.05, mf(53), 0.35, 0.13 * a);
        this.horn(out, t + 1.4, mf(50), 1.0, 0.15 * a);
        this.horn(out, t + 1.4, mf(45), 1.0, 0.08 * a);
        this.bell(out, t + 1.4, mf(74), 1.6, 0.06 * a);
        this.bell(out, t + 1.4, mf(77), 1.6, 0.04 * a);
        break;
      case 'waveClear':
        // Happy kalimba jingle up the D major chord with a chime on top.
        this.duck(4, 1.2);
        [74, 78, 81, 86, 85, 86].forEach((m, i) => this.kalimba(out, t + i * 0.09 + (i > 3 ? 0.06 : 0), mf(m), 0.7, 0.16 * a));
        this.bell(out, t + 0.55, mf(90), 1.0, 0.06 * a);
        this.bell(out, t + 0.55, mf(93), 0.8, 0.04 * a);
        break;
      case 'send':
        this.noise(out, t, 0.4, 0.28 * a, 'bandpass', 500 * r, 3200 * r, 1.6, this.white, 0.12);
        this.tone(out, t + 0.05, 880 * r, 0.12, 'triangle', 0.07 * a, 1.5, 0.003);
        break;
      case 'incoming':
        // Alert ping-ping.
        this.duck(3, 0.5);
        this.bell(out, t, 1568, 0.35, 0.2 * a);
        this.bell(out, t + 0.17, 2093, 0.5, 0.2 * a);
        break;
      case 'out':
        // A balloon deflating: a wobbling slide down with a little hiss.
        this.warble(out, t, 540 * r, 0.95, 0.24 * a, 0.17, 7, 18, 'triangle', 0.02);
        this.noise(out, t, 0.7, 0.05 * a, 'highpass', 2200, 900, 0.7, this.white, 0.02);
        break;
      case 'ping':
        this.bell(out, t, 1320 * r, 0.5, 0.2 * a);
        this.bell(out, t + 0.18, 1320 * r, 0.4, 0.07 * a);
        break;
      case 'victory': {
        this.duck(10, 3.2);
        [62, 66, 69, 74].forEach((m, i) => this.horn(out, t + i * 0.12, mf(m), i === 3 ? 1.4 : 0.11, 0.12 * a));
        for (const m of [66, 69, 62]) this.horn(out, t + 0.36, mf(m), 1.4, 0.06 * a);
        [74, 78, 81, 86, 90, 93].forEach((m, i) => this.kalimba(out, t + 0.5 + i * 0.07, mf(m), 1.0, 0.11 * a));
        this.bell(out, t + 0.95, mf(98), 1.6, 0.05 * a);
        this.tone(out, t + 0.36, mf(38), 1.6, 'sine', 0.25 * a, 1, 0.02);
        break;
      }
      case 'defeat': {
        this.duck(10, 3.2);
        [81, 77, 74, 69].forEach((m, i) => this.kalimba(out, t + i * 0.3, mf(m), 1.2, 0.15 * a));
        for (const m of [50, 57, 62, 65]) this.horn(out, t + 1.2, mf(m), 1.5, 0.05 * a);
        this.bell(out, t + 1.2, mf(62), 2.0, 0.08 * a);
        break;
      }
    }
  }

  // ---- music ------------------------------------------------------------------------------------------------------

  private on(l: Layer, t: number) {
    return this.fade[l].at(t) > 0.01 || this.fade[l].to > 0.01;
  }

  private step(t: number, i: number) {
    const s = i % 16;
    const bar = Math.floor(i / 16);
    const L = this.layer;
    if (s === 0) {
      if (bar % 8 === 0) this.minor = this.intensity >= 1.5;
      else if (bar % 4 === 0 && this.intensity >= 1.5 !== this.minor) this.minor = this.intensity >= 1.5;
      const prog = (this.minor ? MINOR : MAJOR)[Math.floor(bar / 4) % 2];
      this.chord = prog[bar % 4];
      if (bar % 16 === 0 || !this.motifs.length) {
        const a = genMotif(rnd(-1, 2) | 0);
        this.motifs = [a, a, genMotif((rnd(1, 4) | 0) as number), varyMotif(a)];
      }
      if (this.on('pad', t)) this.pad(t, this.chord, 16 * STEP);
      if (this.on('boss', t) && bar % 2 === 0) {
        this.bell(L.boss, t, mf(this.chord.bass + 12), 2.2, 0.09);
        this.tone(L.boss, t, mf(this.chord.bass - 12), 1.1, 'sine', 0.22, 1, 0.02);
      }
    }
    // A little swing on the off-eighths.
    const swing = s % 4 === 2 ? STEP * 0.12 : 0;
    const tt = t + swing;
    const c = this.chord;

    // Melody: the 2-bar motif for this part of the 8-bar AABA' phrase.
    if (s % 2 === 0 && this.on('mel', t)) {
      const motif = this.motifs[Math.floor((bar % 8) / 2)];
      const slot = motif[(bar % 2) * 8 + s / 2];
      const sparse = this.intensity < 0.5;
      if (slot && (!sparse || slot.core || Math.random() < 0.35)) {
        const scale = this.minor ? SCALE_MINOR : SCALE_MAJOR;
        let m = scale[clamp(HOME + slot.deg, 0, scale.length - 1)];
        if (s % 4 === 0) m = snap(m, c.tones);
        const v = (sparse ? 0.17 : 0.2) * rnd(0.85, 1.1);
        this.kalimba(L.mel, tt + rnd(-0.006, 0.006), mf(m), 1.3, v);
      }
    }
    // Gentle wind chimes now and then in calm phases.
    if (s === 8 && bar % 4 === 3 && this.intensity < 1.5 && this.on('mel', t)) {
      const scale = SCALE_MAJOR;
      for (let k = 0; k < 3; k++) this.bell(L.mel, t + k * rnd(0.06, 0.12), mf(scale[scale.length - 1 - Math.floor(Math.random() * 6)]), 1.2, 0.03);
    }
    // Marimba arpeggio in eighths.
    if (s % 2 === 0 && this.on('arp', t)) {
      const p = c.pad;
      const pat = [p[0], p[1], p[2], p[3], p[0] + 12, p[3], p[2], p[1]];
      const m = pat[(s / 2) % 8];
      this.marimba(L.arp, tt, mf(m), 0.45, (s % 4 === 0 ? 0.11 : 0.08) * rnd(0.9, 1.1));
    }
    // Bass: root, fifth, root, a pickup.
    if (this.on('bass', t)) {
      const b = c.bass;
      if (s === 0 || s === 8) this.pluckBass(L.bass, t, mf(b), 0.5, 0.32);
      else if (s === 6) this.pluckBass(L.bass, tt, mf(b + 7), 0.22, 0.22);
      else if (s === 14 && bar % 2 === 1) this.pluckBass(L.bass, t, mf(b + 12), 0.15, 0.16);
    }
    // Soft percussion: kick, shaker, woodblock.
    if (this.on('perc', t)) {
      const P = L.perc;
      if (s === 0 || s === 8 || (this.minor && s === 10)) {
        this.tone(P, t, 115, 0.2, 'sine', s === 10 ? 0.3 : 0.5, 0.4, 0.003);
      }
      if (s % 2 === 1) this.noise(P, t, 0.035, 0.035 * rnd(0.7, 1.2), 'highpass', 7500, 7500, 0.7, this.white, 0.002);
      else if (s % 4 === 2) this.noise(P, tt, 0.05, 0.08, 'highpass', 6500, 6500, 0.7, this.white, 0.003);
      if (s === 4 || s === 12) {
        this.tone(P, tt, 1000, 0.05, 'sine', 0.12, 0.92, 0.001);
        this.noise(P, tt, 0.025, 0.08, 'bandpass', 1900, 1900, 6, this.white, 0.001);
      }
      if (bar % 4 === 3 && (s === 14 || s === 15)) this.tone(P, t, 1300, 0.04, 'sine', 0.08, 0.92, 0.001);
    }
    // Boss: low toms on odd bars.
    if (this.on('boss', t) && bar % 2 === 1 && (s === 12 || s === 14)) {
      this.tone(L.boss, t, s === 12 ? 150 : 115, 0.32, 'sine', 0.4, 0.62, 0.004);
      this.noise(L.boss, t, 0.08, 0.06, 'lowpass', 900, 300, 0.7, this.pink, 0.002);
    }
  }

  private pad(t: number, c: Chord, len: number) {
    const ctx = this.ctx!;
    const out = this.layer.pad;
    const end = t + len;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.6);
    g.gain.setValueAtTime(1, end);
    g.gain.setTargetAtTime(0, end, 0.35);
    g.connect(out);
    for (const m of c.pad)
      for (const d of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = mf(m);
        o.detune.value = d;
        const og = ctx.createGain();
        og.gain.value = 0.045;
        o.connect(og).connect(g);
        o.start(t);
        o.stop(end + 1.8);
      }
  }

  private pluckBass(out: AudioNode, t: number, f: number, dur: number, gain: number) {
    this.tone(out, t, f, dur, 'triangle', gain, 1, 0.004);
    this.tone(out, t, f, dur * 1.3, 'sine', gain * 0.8, 1, 0.006);
  }

  // ---- ambience events --------------------------------------------------------------------------------------------

  private bird(t: number) {
    const ctx = this.ctx!;
    const p = ctx.createStereoPanner();
    p.pan.value = rnd(-0.85, 0.85);
    const g = ctx.createGain();
    g.gain.value = rnd(0.35, 1);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    g.connect(p).connect(this.ambBus!);
    p.connect(send).connect(this.verbIn!);
    const kind = Math.random();
    const f = rnd(2600, 4200);
    if (kind < 0.35) {
      // A run of quick upward chirps.
      const n = 2 + Math.floor(Math.random() * 4);
      const gap = rnd(0.08, 0.13);
      for (let i = 0; i < n; i++) this.tone(g, t + i * gap, f * rnd(0.97, 1.03), 0.06, 'sine', 0.05, 1.35, 0.008);
    } else if (kind < 0.6) {
      // "Tee-oo" whistle.
      this.warble(g, t, f * 0.8, 0.2, 0.045, 1.08, 30, 40, 'sine', 0.02);
      this.warble(g, t + 0.24, f * 0.62, 0.28, 0.04, 0.92, 30, 30, 'sine', 0.02);
    } else if (kind < 0.8) {
      // Trill.
      this.warble(g, t, f, rnd(0.35, 0.6), 0.03, 0.85, rnd(22, 30), f * 0.06, 'sine', 0.03);
    } else {
      // A wood pigeon cooing low and far off.
      g.gain.value *= 0.8;
      const c = rnd(520, 640);
      this.warble(g, t, c, 0.35, 0.06, 0.9, 5, 6, 'sine', 0.08);
      this.warble(g, t + 0.45, c * 1.05, 0.5, 0.07, 0.86, 5, 6, 'sine', 0.08);
      this.warble(g, t + 1.05, c * 0.95, 0.3, 0.05, 0.9, 5, 6, 'sine', 0.06);
    }
  }
}

/** Nearest note to `m` whose pitch class is in `tones`. */
function snap(m: number, tones: number[]) {
  for (let d = 0; d <= 3; d++) {
    if (tones.includes((m + d) % 12)) return m + d;
    if (tones.includes((m - d + 120) % 12)) return m - d;
  }
  return m;
}

/** Linear up to `knee`, then a smooth tanh shoulder to `ceil`. The input range is [-1, 1]. */
function softClipCurve(knee: number, ceil: number) {
  const n = 4096;
  const curve = new Float32Array(n);
  const room = ceil - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + room * Math.tanh((ax - knee) / room);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

function makeWhite(ctx: BaseAudioContext) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Pink-ish noise (Paul Kellet's economy filter), normalised. */
function makePink(ctx: BaseAudioContext) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  return buf;
}

function makeCrackle(ctx: BaseAudioContext) {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    if (Math.random() < 0.004) {
      const amp = (Math.random() * 2 - 1) * (0.4 + Math.random() * 0.6);
      const len = 8 + Math.floor(Math.random() * 40);
      for (let j = 0; j < len && i + j < d.length; j++) d[i + j] += amp * (1 - j / len) * (Math.random() * 2 - 1);
      i += len;
    }
  }
  return buf;
}

/** Six seconds of a small stream: hundreds of rising droplet blips over a faint wash. */
function makeWater(ctx: BaseAudioContext) {
  const sr = ctx.sampleRate;
  const len = sr * 6;
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    lp += (Math.random() * 2 - 1 - lp) * 0.25;
    d[i] = lp * 0.05;
  }
  const drops = 480;
  for (let k = 0; k < drops; k++) {
    const start = Math.floor(Math.random() * len);
    const f0 = 900 + Math.random() * 2600;
    const rise = 1.4 + Math.random() * 1.4;
    const dur = Math.floor(sr * (0.012 + Math.random() * 0.03));
    const amp = 0.08 + Math.random() * 0.22;
    let ph = 0;
    for (let j = 0; j < dur; j++) {
      const x = j / dur;
      const f = f0 * (1 + (rise - 1) * x);
      ph += (2 * Math.PI * f) / sr;
      const env = Math.sin(Math.PI * Math.min(1, x * 6)) * (1 - x) ** 2;
      d[(start + j) % len] += Math.sin(ph) * env * amp;
    }
  }
  return buf;
}

/** Stereo garden reverb tail: decaying noise, darker as it fades. */
function makeImpulse(ctx: BaseAudioContext, secs: number) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * secs);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      const k = 0.6 - 0.45 * x;
      lp += (Math.random() * 2 - 1 - lp) * k;
      d[i] = lp * (1 - x) ** 2.4 * (i < sr * 0.01 ? i / (sr * 0.01) : 1) * 0.6;
    }
  }
  return buf;
}

/** Garden Sentinels' sound. Pass a context (an OfflineAudioContext in a lab) to build on it straight away, with no bed. */
export function createGAudio(ctx?: BaseAudioContext): GAudio {
  try {
    return new Graph(ctx);
  } catch {
    const noop = () => undefined;
    return { unlock: noop, listen: noop, play: noop, setBeams: noop, setIntensity: noop, dispose: noop };
  }
}

/** Lab helper: start the music and / or ambience on an offline-built audio and schedule `seconds` of it. */
export function primeGAudio(audio: GAudio, seconds: number, bed: { music?: boolean; ambience?: boolean }) {
  const g = audio as Partial<Graph>;
  g.startBed?.(!!bed.music, !!bed.ambience);
  g.pump?.(seconds);
}
