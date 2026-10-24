// Engine voices. The player's pod is a snarling twin-turbine roar built from layers that all track one "rpm"
// (derived from speed and throttle):
//   - core: two detuned sawtooths + a pulse an octave down + a saw an octave up, soft-clipped for snarl, through a
//     resonant low-pass whose cutoff opens with speed; a fast tremolo (the turbines' flutter) on top,
//   - whine: two slightly detuned sines high above the core, the turbine scream; boost adds a third, higher one,
//   - roar: band-passed brown noise, the exhaust's body, and a jet layer (white noise, low-passed) for boost,
//   - hiss: high-passed noise for the air brakes,
//   - crackle: exhaust pops when the throttle is chopped, a low thump when it is slammed open.
// Rival pods get a cheaper voice (two saws + a whine + a little noise) in a PannerNode; RaceAudio moves it and bends
// its pitch for doppler.

import { driveCurve, glide, loopNoise, noise } from './context';

/** Time constant for panner and listener position glides. */
export const POS_TAU = 0.02;

const clamp01 =(v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface EngineDrive {
  /** Speed relative to the pod's top speed, can exceed 1 while boosting. */
  speed01: number;
  throttle: number;
  brake: number;
  boosting: boolean;
  /** Seconds left on a pad surge (> 0 = surging). */
  surge: number;
  /** 0..1 grid revving before the start. */
  rev: number;
}

export class PlayerEngine {
  readonly out: GainNode;
  private readonly oscs: OscillatorNode[] = [];
  private readonly srcs: AudioBufferSourceNode[] = [];
  private readonly sawA: OscillatorNode;
  private readonly sawB: OscillatorNode;
  private readonly sub: OscillatorNode;
  private readonly over: OscillatorNode;
  private readonly coreLp: BiquadFilterNode;
  private readonly coreGain: GainNode;
  private readonly flutter: OscillatorNode;
  private readonly flutterDepth: GainNode;
  private readonly whineA: OscillatorNode;
  private readonly whineB: OscillatorNode;
  private readonly whineBoost: OscillatorNode;
  private readonly whineGain: GainNode;
  private readonly whineBoostGain: GainNode;
  private readonly roarBp: BiquadFilterNode;
  private readonly roarGain: GainNode;
  private readonly jetLp: BiquadFilterNode;
  private readonly jetGain: GainNode;
  private readonly hissGain: GainNode;
  private readonly crackleGain: GainNode;
  private readonly crackleBp: BiquadFilterNode;
  private readonly thump: OscillatorNode;
  private readonly thumpGain: GainNode;
  private lastThrottle = 0;
  private rpm = 0;
  private boostAmt = 0;

  constructor(private readonly ctx: BaseAudioContext, dest: AudioNode, private readonly pitch = 1) {
    const bank = noise(ctx);
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);

    // Core: oscillators -> shaper -> low-pass -> flutter (tremolo) -> core gain.
    const mix = ctx.createGain();
    mix.gain.value = 0.32;
    this.sawA = this.osc('sawtooth', 40, mix, 1);
    this.sawB = this.osc('sawtooth', 40, mix, 0.85);
    this.sawB.detune.value = 14;
    this.sub = this.osc('square', 20, mix, 0.45);
    this.over = this.osc('sawtooth', 80, mix, 0.35);
    this.over.detune.value = -9;
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(2.6);
    shaper.oversample = '2x';
    this.coreLp = ctx.createBiquadFilter();
    this.coreLp.type = 'lowpass';
    this.coreLp.Q.value = 5;
    this.coreLp.frequency.value = 300;
    const trem = ctx.createGain();
    trem.gain.value = 0.8;
    this.flutter = ctx.createOscillator();
    this.flutter.type = 'triangle';
    this.flutter.frequency.value = 18;
    this.flutterDepth = ctx.createGain();
    this.flutterDepth.gain.value = 0.15;
    this.flutter.connect(this.flutterDepth).connect(trem.gain);
    this.flutter.start();
    this.oscs.push(this.flutter);
    this.coreGain = ctx.createGain();
    this.coreGain.gain.value = 0.5;
    mix.connect(shaper).connect(this.coreLp).connect(trem).connect(this.coreGain).connect(this.out);

    // Whine.
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whineA = this.osc('sine', 600, this.whineGain, 1);
    this.whineB = this.osc('triangle', 600, this.whineGain, 0.35);
    this.whineB.detune.value = 11;
    const whineHp = ctx.createBiquadFilter();
    whineHp.type = 'highpass';
    whineHp.frequency.value = 300;
    this.whineGain.connect(whineHp).connect(this.out);
    this.whineBoostGain = ctx.createGain();
    this.whineBoostGain.gain.value = 0;
    this.whineBoost = this.osc('sine', 1800, this.whineBoostGain, 1);
    this.whineBoostGain.connect(this.out);

    // Exhaust roar (brown noise band) and the boost jet (white noise, low-passed).
    this.roarBp = ctx.createBiquadFilter();
    this.roarBp.type = 'bandpass';
    this.roarBp.Q.value = 0.9;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    this.noiseInto(bank.brown, this.roarBp, 1).connect(this.roarGain).connect(this.out);
    this.jetLp = ctx.createBiquadFilter();
    this.jetLp.type = 'lowpass';
    this.jetLp.frequency.value = 1200;
    this.jetLp.Q.value = 0.7;
    this.jetGain = ctx.createGain();
    this.jetGain.gain.value = 0;
    this.noiseInto(bank.white, this.jetLp, 0.8).connect(this.jetGain).connect(this.out);

    // Air-brake hiss.
    const hissHp = ctx.createBiquadFilter();
    hissHp.type = 'highpass';
    hissHp.frequency.value = 2600;
    const hissPeak = ctx.createBiquadFilter();
    hissPeak.type = 'peaking';
    hissPeak.frequency.value = 5200;
    hissPeak.gain.value = 8;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.noiseInto(bank.white, hissHp, 1.1).connect(hissPeak).connect(this.hissGain).connect(this.out);

    // Crackle (pops on throttle-off) and thump (throttle slammed open).
    this.crackleBp = ctx.createBiquadFilter();
    this.crackleBp.type = 'bandpass';
    this.crackleBp.frequency.value = 900;
    this.crackleBp.Q.value = 0.8;
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    this.noiseInto(bank.crackle, this.crackleBp, 0.7).connect(this.crackleGain).connect(this.out);
    this.thumpGain = ctx.createGain();
    this.thumpGain.gain.value = 0;
    this.thump = this.osc('sine', 45, this.thumpGain, 1);
    this.thumpGain.connect(this.out);
  }

  private osc(type: OscillatorType, f: number, dest: AudioNode, level: number) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    if (level !== 1) {
      const g = this.ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(dest);
    } else o.connect(dest);
    o.start();
    this.oscs.push(o);
    return o;
  }

  private noiseInto(buf: AudioBuffer, filter: AudioNode, rate: number) {
    const src = loopNoise(this.ctx, buf, rate);
    src.connect(filter);
    this.srcs.push(src);
    return filter;
  }

  /** Fades the whole engine in/out (start of the race, dispose). */
  setLevel(v: number, tau = 0.3) {
    glide(this.out.gain, v, this.ctx.currentTime, tau);
  }

  update(dt: number, d: EngineDrive) {
    const t = this.ctx.currentTime;
    const sp = Math.max(0, d.speed01);
    // "rpm": mostly speed, plus throttle load so revving on the spot and accelerating sound strained.
    const target = clamp01(sp * 0.82 + d.throttle * 0.14 + d.rev * 0.35 + (d.boosting ? 0.1 : 0));
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt * (target > this.rpm ? 3.5 : 2.2)));
    const rpm = this.rpm;
    this.boostAmt += ((d.boosting ? 1 : d.surge > 0 ? 0.55 : 0) - this.boostAmt) * (1 - Math.exp(-dt * 6));
    const boost = this.boostAmt;
    const load = Math.max(d.throttle, d.rev);

    const f0 = (34 + 118 * rpm ** 0.9 + 14 * boost) * this.pitch;
    glide(this.sawA.frequency, f0, t, 0.04);
    glide(this.sawB.frequency, f0, t, 0.04);
    glide(this.sub.frequency, f0 * 0.5, t, 0.04);
    glide(this.over.frequency, f0 * 2.01, t, 0.04);
    glide(this.coreLp.frequency, 260 + 2600 * rpm ** 1.3 * (0.55 + 0.45 * load) + 1400 * boost, t, 0.05);
    glide(this.coreGain.gain, 0.32 + 0.28 * load + 0.15 * rpm, t, 0.08);
    // Flutter speeds up with the turbines and gets shallower at the top end (it blurs into a roar).
    glide(this.flutter.frequency, 9 + 34 * rpm, t, 0.1);
    glide(this.flutterDepth.gain, 0.24 - 0.14 * rpm, t, 0.1);

    const whine = (520 + 2300 * rpm ** 1.15 + 700 * boost) * this.pitch;
    glide(this.whineA.frequency, whine, t, 0.06);
    glide(this.whineB.frequency, whine * 1.5, t, 0.06);
    glide(this.whineGain.gain, 0.012 + 0.05 * rpm * (0.5 + 0.5 * load) + 0.03 * boost, t, 0.1);
    glide(this.whineBoost.frequency, whine * 2.02, t, 0.06);
    glide(this.whineBoostGain.gain, 0.035 * boost, t, 0.12);

    glide(this.roarBp.frequency, 140 + 900 * rpm + 500 * boost, t, 0.08);
    glide(this.roarGain.gain, 0.25 + 0.55 * rpm * (0.6 + 0.4 * load) + 0.4 * boost, t, 0.1);
    glide(this.jetLp.frequency, 900 + 2600 * boost, t, 0.1);
    glide(this.jetGain.gain, 0.32 * boost + (d.surge > 0 ? 0.08 : 0), t, boost > 0.5 ? 0.06 : 0.25);

    glide(this.hissGain.gain, d.brake * (0.05 + 0.2 * Math.min(1, sp)), t, 0.06);

    // Throttle chops crackle, stabs thump. Detected on the change since the last frame.
    const dThr = d.throttle - this.lastThrottle;
    this.lastThrottle = d.throttle;
    if (dThr < -0.4 && rpm > 0.25) this.pop(rpm);
    if (dThr > 0.5) this.stab(rpm);
    if (d.rev > 0 && Math.random() < dt * 0.6) this.pop(0.4);
  }

  private pop(rpm: number) {
    const t = this.ctx.currentTime;
    const g = this.crackleGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.5 + 0.6 * rpm, t + 0.02);
    g.setTargetAtTime(0, t + 0.05, 0.18);
    this.crackleBp.frequency.setValueAtTime(600 + 900 * Math.random(), t);
  }

  private stab(rpm: number) {
    const t = this.ctx.currentTime;
    const g = this.thumpGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.5, t + 0.015);
    g.setTargetAtTime(0, t + 0.03, 0.12);
    this.thump.frequency.cancelScheduledValues(t);
    this.thump.frequency.setValueAtTime(70 + 30 * rpm, t);
    this.thump.frequency.exponentialRampToValueAtTime(32, t + 0.25);
  }

  dispose() {
    for (const o of this.oscs) o.stop();
    for (const s of this.srcs) s.stop();
    this.out.disconnect();
  }
}

/** A rival pod: cheaper engine, positioned by a PannerNode. */
export class RivalVoice {
  readonly panner: PannerNode;
  readonly out: GainNode;
  private readonly a: OscillatorNode;
  private readonly b: OscillatorNode;
  private readonly whine: OscillatorNode;
  private readonly lp: BiquadFilterNode;
  private readonly whineGain: GainNode;
  private readonly roarGain: GainNode;
  private readonly src: AudioBufferSourceNode;
  /** Index of the racer this voice follows, -1 when free. */
  owner = -1;
  /** Smoothed radial speed (m/s, + = moving apart), for doppler. */
  radial = 0;
  pitch = 1;

  constructor(private readonly ctx: BaseAudioContext, dest: AudioNode, hrtf: boolean) {
    this.panner = ctx.createPanner();
    this.panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 12;
    this.panner.rolloffFactor = 1.1;
    this.panner.maxDistance = 3000;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(this.panner).connect(dest);

    const mix = ctx.createGain();
    mix.gain.value = 0.3;
    this.a = ctx.createOscillator();
    this.a.type = 'sawtooth';
    this.b = ctx.createOscillator();
    this.b.type = 'square';
    this.b.detune.value = -1210;
    this.a.connect(mix);
    const bg = ctx.createGain();
    bg.gain.value = 0.5;
    this.b.connect(bg).connect(mix);
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 3;
    mix.connect(this.lp).connect(this.out);
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0.04;
    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whine.connect(this.whineGain).connect(this.out);
    const nb = ctx.createBiquadFilter();
    nb.type = 'bandpass';
    nb.frequency.value = 500;
    nb.Q.value = 0.8;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0.3;
    this.src = loopNoise(ctx, noise(ctx).brown, 1.3);
    this.src.connect(nb).connect(this.roarGain).connect(this.out);
    for (const o of [this.a, this.b, this.whine]) {
      o.frequency.value = 60;
      o.start();
    }
  }

  /** speed01 = speed / top speed; doppler = frequency factor; level = gain before distance attenuation. */
  update(speed01: number, boosting: boolean, doppler: number, level: number, snap: boolean) {
    const t = this.ctx.currentTime;
    const tau = snap ? 0.001 : 0.05;
    const rpm = clamp01(speed01 * 0.9 + (boosting ? 0.12 : 0));
    const f0 = (38 + 120 * rpm) * this.pitch * doppler;
    glide(this.a.frequency, f0, t, tau);
    glide(this.b.frequency, f0, t, tau);
    glide(this.whine.frequency, (560 + 2200 * rpm) * this.pitch * doppler, t, tau);
    glide(this.lp.frequency, (500 + 2600 * rpm) * Math.min(1.6, doppler), t, 0.06);
    glide(this.whineGain.gain, 0.02 + 0.06 * rpm + (boosting ? 0.03 : 0), t, 0.1);
    glide(this.roarGain.gain, 0.2 + 0.5 * rpm, t, 0.1);
    glide(this.out.gain, level, t, snap ? 0.03 : 0.08);
  }

  setPosition(x: number, y: number, z: number) {
    // Glide to the new spot: per-frame jumps make HRTF panners click. The listener uses the same time constant, so
    // the lag cancels out in the relative position.
    const t = this.ctx.currentTime;
    glide(this.panner.positionX, x, t, POS_TAU);
    glide(this.panner.positionY, y, t, POS_TAU);
    glide(this.panner.positionZ, z, t, POS_TAU);
  }

  jumpTo(x: number, y: number, z: number) {
    const t = this.ctx.currentTime;
    for (const [p, v] of [[this.panner.positionX, x], [this.panner.positionY, y], [this.panner.positionZ, z]] as const) {
      p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
    }
  }

  dispose() {
    this.a.stop();
    this.b.stop();
    this.whine.stop();
    this.src.stop();
    this.panner.disconnect();
  }
}
