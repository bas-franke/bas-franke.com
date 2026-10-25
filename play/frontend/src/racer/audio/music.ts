// Race music, synthesized with Web Audio like the rest of the racer's sound (no sample files): a sci-fi track in A
// minor (i - VI - III - VII) built from stems that come in on the beat as the intensity (0..1, set by the director,
// director.ts) rises:
//   pad (always) -> bass pulse -> kick -> hats -> snare -> arpeggio -> lead.
// Every voice is a persistent oscillator or noise loop whose gain and filter envelopes are scheduled on the
// AudioContext clock a little ahead (pump(), from the frame loop and a timer), so a note allocates nothing. The
// one-shots (green-light drop, wreck hit, finish sting) use cues.ts. Graph:
//   stems -> mix -> duck -> mid dip (room for the engines) -> muffle (pause) -> glue compressor -> master -> out.

import { glide, loopNoise, noise } from './context';
import { burst, tone } from './cues';

/** How far ahead notes are scheduled (s). The frame loop and a 25 ms timer both pump. */
const LOOKAHEAD = 0.2;
/** Master level at full volume (the engines stay in front). */
const LEVEL = 0.22;

// One chord per bar, four bars a loop.
const BASS = [33, 29, 36, 31]; // A1 F1 C2 G1
const PAD = [[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]];
const ARP = [[69, 72, 76, 81], [69, 72, 77, 81], [67, 72, 76, 79], [67, 71, 74, 79]];
const ARP_ORDER = [0, 1, 2, 3, 1, 2, 3, 2, 0, 1, 2, 3, 3, 2, 1, 2];
/** The 16th bass pulse: root with octave jumps. */
const BASS_OCT = [0, 0, 12, 0, 0, 12, 0, 0, 0, 0, 12, 0, 0, 12, 0, 12];
/** Lead motif per bar: [step, midi, length in steps]. */
const LEAD = [
  [[0, 76, 4], [4, 79, 2], [6, 81, 6], [12, 79, 2], [14, 76, 2]],
  [[0, 77, 6], [6, 76, 2], [8, 72, 4], [12, 74, 4]],
  [[0, 76, 4], [4, 79, 4], [8, 84, 6], [14, 83, 2]],
  [[0, 83, 6], [6, 81, 2], [8, 79, 4], [12, 74, 4]],
];

const HZ = new Float32Array(128);
for (let i = 0; i < 128; i++) HZ[i] = 440 * 2 ** ((i - 69) / 12);

const ramp = (x: number, a: number, b: number) => Math.max(0, Math.min(1, (x - a) / (b - a)));

/** A percussive envelope on a persistent gain: a quick release just before t, attack to `peak`, decay to 0. */
function hit(p: AudioParam, t: number, peak: number, decay: number, attack = 0.002) {
  p.setTargetAtTime(0, t - 0.005, 0.0015);
  p.setTargetAtTime(peak, t, attack);
  p.setTargetAtTime(0, t + attack * 4, decay);
}

function hold(p: AudioParam, t: number) {
  const q = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (q.cancelAndHoldAtTime) q.cancelAndHoldAtTime(t);
  else p.cancelScheduledValues(t);
}

/** play: the stems follow the intensity; sparse: pad and a lone ping (after a wreck); outro: the pad holds the end chord. */
export type MusicMode = 'play' | 'sparse' | 'outro';

export class SynthMusic {
  /** 0..1, set by the director every frame (already smoothed). */
  intensity = 0;
  /** 0..1, heavy damage: the pad warbles and the filters darken. */
  tension = 0;
  /** Airborne: the low end lifts out and the kick drops away until the landing. */
  air = false;
  /** Knife edge (rolled Q/E): the hats double up. */
  edge = false;
  /** The last stretch: the lead comes in whatever the intensity. */
  finale = false;
  mode: MusicMode = 'play';

  readonly out: GainNode;
  private readonly mix: GainNode;
  private readonly duckG: GainNode;
  private readonly muffle: BiquadFilterNode;
  private readonly stingBus: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly timer: ReturnType<typeof setInterval> | 0 = 0;

  private readonly padL: GainNode;
  private readonly padF: BiquadFilterNode;
  private readonly padOsc: OscillatorNode[] = [];
  private readonly warble: GainNode;
  private readonly bassL: GainNode;
  private readonly bassA: OscillatorNode;
  private readonly bassB: OscillatorNode;
  private readonly bassF: BiquadFilterNode;
  private readonly bassEnv: GainNode;
  private readonly kickL: GainNode;
  private readonly kick: OscillatorNode;
  private readonly kickEnv: GainNode;
  private readonly hatL: GainNode;
  private readonly hatEnv: GainNode;
  private readonly snareL: GainNode;
  private readonly snEnv: GainNode;
  private readonly snTone: OscillatorNode;
  private readonly snToneEnv: GainNode;
  private readonly arpL: GainNode;
  private readonly arpA: OscillatorNode;
  private readonly arpB: OscillatorNode;
  private readonly arpF: BiquadFilterNode;
  private readonly arpEnv: GainNode;
  private readonly leadL: GainNode;
  private readonly leadA: OscillatorNode;
  private readonly leadB: OscillatorNode;
  private readonly leadF: BiquadFilterNode;
  private readonly leadEnv: GainNode;
  private readonly delay: DelayNode;
  private readonly riserG: GainNode;
  private readonly riserF: BiquadFilterNode;

  private step = 0;
  private bar = 0;
  private next = 0;
  private bpm = 120;
  private chord: number[] | null = null;
  private on = { bass: false, kick: false, hat: false, snare: false, arp: false, lead: false };
  private volume = 1;
  private paused = false;
  private disposed = false;

  constructor(private readonly ctx: BaseAudioContext, dest: AudioNode = ctx.destination) {
    const bank = noise(ctx);
    const gain = (v: number, to: AudioNode | AudioParam) => {
      const g = ctx.createGain();
      g.gain.value = v;
      if (to instanceof AudioParam) g.connect(to);
      else g.connect(to);
      return g;
    };
    const filter = (type: BiquadFilterType, f: number, q: number, to: AudioNode) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      b.connect(to);
      return b;
    };
    const osc = (type: OscillatorType, to: AudioNode, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      o.connect(to);
      o.start();
      this.sources.push(o);
      return o;
    };
    const loop = (to: AudioNode) => {
      const s = loopNoise(ctx, bank.white);
      s.connect(to);
      this.sources.push(s);
      return s;
    };

    this.out = gain(0, dest);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.2;
    comp.connect(this.out);
    this.muffle = filter('lowpass', 20000, 0.7, comp);
    // A gentle dip where the turbines sing, so the engines stay readable over the music.
    const dip = filter('peaking', 1100, 0.8, this.muffle);
    dip.gain.value = -4;
    this.duckG = gain(1, dip);
    this.mix = gain(1, this.duckG);
    this.stingBus = gain(0.8, comp);

    // Pad: three voices of two detuned saws, a slow warble for damage.
    this.padL = gain(0.55, this.mix);
    this.padF = filter('lowpass', 500, 0.7, this.padL);
    this.warble = ctx.createGain();
    this.warble.gain.value = 0;
    const lfo = osc('sine', this.warble);
    lfo.frequency.value = 0.4;
    for (let v = 0; v < 3; v++) {
      const vg = gain(0.09, this.padF);
      for (const d of [-8, 8]) {
        const o = osc('sawtooth', vg, d);
        o.frequency.value = HZ[PAD[0][v]];
        this.warble.connect(o.detune);
        this.padOsc.push(o);
      }
    }

    // Bass: saw plus a square an octave down, a resonant low-pass plucked per note.
    this.bassL = gain(0, this.mix);
    this.bassEnv = gain(0, this.bassL);
    this.bassF = filter('lowpass', 300, 7, this.bassEnv);
    this.bassA = osc('sawtooth', this.bassF);
    const sub = gain(0.6, this.bassF);
    this.bassB = osc('square', sub);

    // Drums.
    this.kickL = gain(0, this.mix);
    this.kickEnv = gain(0, this.kickL);
    this.kick = osc('sine', this.kickEnv);
    this.kick.frequency.value = 50;
    this.hatL = gain(0, this.mix);
    const hatPan = ctx.createStereoPanner();
    hatPan.pan.value = 0.25;
    hatPan.connect(this.hatL);
    this.hatEnv = gain(0, hatPan);
    loop(filter('highpass', 7500, 0.7, this.hatEnv));
    this.snareL = gain(0, this.mix);
    this.snEnv = gain(0, this.snareL);
    loop(filter('bandpass', 1900, 0.7, this.snEnv));
    this.snToneEnv = gain(0, this.snareL);
    this.snTone = osc('triangle', this.snToneEnv);
    this.snTone.frequency.value = 190;

    // Arpeggio and lead share a tempo-synced echo (dotted eighth).
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = 0.375;
    // delay -> low-pass -> feedback -> delay, and the wet return into the mix.
    const fb = gain(0.38, this.delay);
    const fbLp = filter('lowpass', 2600, 0.7, fb);
    this.delay.connect(fbLp);
    fbLp.connect(gain(0.32, this.mix));

    this.arpL = gain(0, this.mix);
    this.arpL.connect(this.delay);
    const arpPan = ctx.createStereoPanner();
    arpPan.connect(this.arpL);
    const panLfo = osc('sine', gain(0.35, arpPan.pan));
    panLfo.frequency.value = 0.13;
    this.arpEnv = gain(0, arpPan);
    this.arpF = filter('lowpass', 1200, 5, this.arpEnv);
    this.arpA = osc('square', gain(0.5, this.arpF));
    this.arpB = osc('sawtooth', gain(0.5, this.arpF), 9);

    this.leadL = gain(0, this.mix);
    this.leadL.connect(this.delay);
    this.leadEnv = gain(0, this.leadL);
    this.leadF = filter('lowpass', 2600, 2, this.leadEnv);
    this.leadA = osc('sawtooth', gain(0.5, this.leadF), -10);
    this.leadB = osc('sawtooth', gain(0.5, this.leadF), 10);
    const vib = gain(9, this.leadA.detune);
    vib.connect(this.leadB.detune);
    osc('sine', vib).frequency.value = 5.5;

    // Riser: noise through a band-pass that climbs (countdown, final stretch).
    this.riserG = gain(0, this.mix);
    this.riserF = filter('bandpass', 400, 2.5, this.riserG);
    loop(this.riserF);

    this.next = ctx.currentTime + 0.05;
    this.applyLevel(0.6);
    if (typeof window !== 'undefined' && 'state' in ctx && !(ctx instanceof OfflineAudioContext)) this.timer = setInterval(() => this.pump(), 25);
  }

  /** Overall level (the site's volume, 0..1). */
  setVolume(v: number) {
    this.volume = v;
    this.applyLevel(0.05);
  }

  /** Paused: muffled and quieter, still playing. */
  setPaused(p: boolean) {
    this.paused = p;
    glide(this.muffle.frequency, p ? 420 : 20000, this.ctx.currentTime, 0.08);
    this.applyLevel(0.15);
  }

  private applyLevel(tau: number) {
    glide(this.out.gain, LEVEL * this.volume * (this.paused ? 0.6 : 1), this.ctx.currentTime, tau);
  }

  /** Ducks the music by `amount` (0..1) for `secs`, under a big cue. */
  duck(amount: number, secs: number) {
    const t = this.ctx.currentTime;
    const p = this.duckG.gain;
    hold(p, t);
    p.setTargetAtTime(1 - amount, t, 0.015);
    p.setTargetAtTime(1, t + secs, 0.45);
  }

  /** Countdown and final-stretch riser, 0 (off) .. 1. Call often (it glides). */
  setRiser(k: number) {
    const t = this.ctx.currentTime;
    glide(this.riserG.gain, 0.16 * k, t, 0.1);
    glide(this.riserF.frequency, 300 + 5200 * k * k, t, 0.1);
  }

  /** The green light: the bar restarts on the downbeat with a crash. */
  drop() {
    const t = this.ctx.currentTime + 0.03;
    this.step = 0;
    this.bar = 0;
    this.next = t;
    this.mode = 'play';
    // Clear a finish sting's pad fade (the lab goes back to play after one).
    hold(this.padL.gain, t);
    this.crash(t, 0.5);
  }

  /** A wreck: a hit, the stems cut out and only the pad is left (mode 'sparse') until resume(). */
  wreckHit() {
    const t = this.ctx.currentTime + 0.005;
    this.mode = 'sparse';
    this.cut(t, 0.03);
    this.crash(t, 0.9);
    tone(this.ctx, this.stingBus, 110, t, 1.4, 0.6, { type: 'sawtooth', to: 28, lp: 700 });
  }

  /** Back on the course after a wreck. */
  resume() {
    this.mode = 'play';
  }

  /** The finish: a resolve by position (1st: A major, podium: a lift to F, else a dark A minor), then the pad holds. */
  sting(position: number) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    this.mode = 'outro';
    this.cut(t, 0.08);
    this.crash(t, 0.8);
    const stab = position === 1 ? [45, 57, 61, 64, 69] : position <= 3 ? [41, 53, 57, 60, 65] : [33, 45, 52, 57, 60];
    const arp = position === 1 ? [69, 73, 76, 81, 85, 88] : position <= 3 ? [65, 69, 72, 77, 81] : [69, 67, 64, 60];
    for (const m of stab) {
      tone(ctx, this.stingBus, HZ[m], t, 3.2, 0.07, { type: 'sawtooth', detune: -7, lp: position === 1 ? 4200 : 2000, attack: 0.01 });
      tone(ctx, this.stingBus, HZ[m], t, 3.2, 0.07, { type: 'sawtooth', detune: 7, lp: position === 1 ? 4200 : 2000, attack: 0.01 });
    }
    for (let i = 0; i < arp.length; i++) tone(ctx, this.stingBus, HZ[arp[i]], t + 0.1 + i * 0.09, 0.9, 0.09, { type: 'square', lp: 3500 });
    this.chord = position === 1 ? [57, 61, 64] : position <= 3 ? [57, 60, 65] : [57, 60, 64];
    for (let v = 0; v < 3; v++) for (let k = 0; k < 2; k++) this.padOsc[v * 2 + k].frequency.setTargetAtTime(HZ[this.chord[v]], t, 0.05);
    glide(this.padF.frequency, position === 1 ? 2600 : 1200, t, 0.3);
    glide(this.padL.gain, 0.7, t, 0.05);
    this.padL.gain.setTargetAtTime(0.28, t + 3, 3);
  }

  /** Every stem but the pad out now (cancelling fades already scheduled). */
  private cut(t: number, tau: number) {
    for (const g of [this.bassL, this.kickL, this.hatL, this.snareL, this.arpL, this.leadL]) {
      hold(g.gain, t);
      g.gain.setTargetAtTime(0, t, tau);
    }
    this.setRiser(0);
  }

  private crash(t: number, k: number) {
    const ctx = this.ctx;
    burst(ctx, this.stingBus, t, 2.2, 0.35 * k, 'highpass', 5000, 0.7);
    burst(ctx, this.stingBus, t, 0.5, 0.4 * k, 'lowpass', 900, 0.8, 120);
    tone(ctx, this.stingBus, 140, t, 0.6, 0.8 * k, { to: 38 });
  }

  /** Schedules every step that falls inside the look-ahead. Cheap; call as often as you like. */
  pump() {
    const ctx = this.ctx;
    if (this.disposed) return;
    const now = ctx.currentTime;
    // Fell behind (hidden tab, a long frame): pick up from now rather than firing a burst of late notes.
    if (this.next < now - 0.05) this.next = now + 0.02;
    while (this.next < now + LOOKAHEAD) {
      this.tick(this.next);
      this.next += 15 / this.bpm;
    }
  }

  /** Stem levels, filters and tempo from the intensity; on every beat, so stems enter and leave in time. */
  private levels(t: number) {
    const I = this.intensity;
    const play = this.mode === 'play';
    const dark = 1 - 0.45 * this.tension;
    if (this.mode !== 'outro') glide(this.padL.gain, play ? 0.55 - 0.15 * I : 0.6, t, 0.3);
    this.on.bass = this.stem(t, this.bassL, play ? ramp(I, 0.12, 0.3) * (this.air ? 0.45 : 1) * 0.55 : 0);
    this.on.kick = this.stem(t, this.kickL, play ? ramp(I, 0.22, 0.36) * 0.9 : 0);
    this.on.hat = this.stem(t, this.hatL, play ? Math.max(ramp(I, 0.28, 0.45), this.edge ? 0.8 : 0) * 0.22 : 0);
    this.on.snare = this.stem(t, this.snareL, play ? ramp(I, 0.45, 0.6) * 0.5 : 0);
    this.on.arp = this.stem(t, this.arpL, play ? ramp(I, 0.5, 0.68) * 0.3 : this.mode === 'sparse' ? 0.2 : 0);
    this.on.lead = this.stem(t, this.leadL, play ? Math.max(ramp(I, 0.8, 0.92), this.finale ? 1 : 0) * 0.16 : 0);
    if (this.mode !== 'outro') glide(this.padF.frequency, (350 + 3000 * I ** 1.3 + (this.air ? 900 : 0)) * dark, t, 0.4);
    glide(this.arpF.frequency, (700 + 4200 * I) * dark, t, 0.3);
    glide(this.arpF.Q, this.edge ? 11 : 5, t, 0.2);
    glide(this.leadF.frequency, 1800 + 2400 * I, t, 0.3);
    glide(this.warble.gain, 22 * this.tension, t, 0.5);
    this.bpm = 118 + 10 * I + (this.finale ? 4 : 0);
    glide(this.delay.delayTime, 45 / this.bpm, t, 0.3);
  }

  /** Glides a stem to its level on the beat; whether it plays at all. */
  private stem(t: number, g: GainNode, v: number) {
    glide(g.gain, v, t, 0.12);
    return v > 0.02;
  }

  private tick(t: number) {
    const s = this.step;
    const I = this.intensity;
    const sd = 15 / this.bpm;
    const ci = this.bar & 3;
    if (s % 4 === 0) this.levels(t);
    if (s === 0 && this.mode !== 'outro') {
      const pad = PAD[ci];
      for (let v = 0; v < 3; v++) for (let k = 0; k < 2; k++) this.padOsc[v * 2 + k].frequency.setTargetAtTime(HZ[pad[v]], t, 0.06);
    }
    const on = this.on;
    if (on.bass) {
      const busy = I >= 0.45;
      if (busy || s % 2 === 0) {
        const m = BASS[ci] + (busy ? BASS_OCT[s] : s % 8 === 6 ? 12 : 0);
        this.bassA.frequency.setValueAtTime(HZ[m], t);
        this.bassB.frequency.setValueAtTime(HZ[m] / 2, t);
        hit(this.bassEnv.gain, t, s % 4 === 0 ? 1 : 0.7, sd * (busy ? 0.8 : 1.6));
        const cut = (160 + 1700 * I ** 1.2) * (1 - 0.4 * this.tension);
        const f = this.bassF.frequency;
        f.setTargetAtTime(cut * 3.5, t, 0.002);
        f.setTargetAtTime(cut, t + 0.01, sd * 0.7);
      }
    }
    if (on.kick && !(this.air && s !== 0)) {
      const four = I >= 0.4;
      if (four ? s % 4 === 0 : s === 0 || s === 8 || (s === 14 && I > 0.85 && (this.bar & 1) === 1)) {
        const f = this.kick.frequency;
        f.setValueAtTime(170, t);
        f.setTargetAtTime(44, t, 0.03);
        hit(this.kickEnv.gain, t, 1, 0.12);
      }
    }
    if (on.snare && (s === 4 || s === 12 || (I > 0.75 && ci === 3 && s >= 13))) {
      const k = s === 4 || s === 12 ? 1 : 0.6;
      hit(this.snEnv.gain, t, 0.9 * k, 0.07);
      this.snTone.frequency.setValueAtTime(200, t);
      this.snTone.frequency.setTargetAtTime(150, t, 0.04);
      hit(this.snToneEnv.gain, t, 0.5 * k, 0.04);
    }
    if (on.hat) {
      if (I >= 0.6 || this.edge) hit(this.hatEnv.gain, t, s % 4 === 2 ? 1 : 0.45, 0.025);
      else if (s % 4 === 2) hit(this.hatEnv.gain, t, 0.9, 0.035);
    }
    if (on.arp) {
      const sparse = this.mode === 'sparse';
      if (sparse ? s === 0 || s === 10 : I >= 0.7 || s % 2 === 0) {
        const m = ARP[ci][ARP_ORDER[s]] + ((this.bar & 1) === 1 && I > 0.85 ? 12 : 0);
        this.arpA.frequency.setValueAtTime(HZ[m], t);
        this.arpB.frequency.setValueAtTime(HZ[m], t);
        hit(this.arpEnv.gain, t, s % 4 === 0 ? 1 : 0.7, sparse ? 0.25 : sd * 0.6);
      }
    }
    if (on.lead) {
      const notes = LEAD[ci];
      for (let n = 0; n < notes.length; n++) {
        const note = notes[n];
        if (note[0] !== s) continue;
        const m = note[1];
        const len = note[2];
        this.leadA.frequency.setTargetAtTime(HZ[m], t, 0.015);
        this.leadB.frequency.setTargetAtTime(HZ[m], t, 0.015);
        const e = this.leadEnv.gain;
        e.setTargetAtTime(0.25, t - 0.005, 0.004);
        e.setTargetAtTime(1, t, 0.01);
        e.setTargetAtTime(0, t + len * sd - 0.03, 0.05);
      }
    }
    this.step = (s + 1) & 15;
    if (this.step === 0) this.bar++;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    const ctx = this.ctx;
    glide(this.out.gain, 0, ctx.currentTime, 0.08);
    const stop = () => {
      for (const s of this.sources) {
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
      }
      this.out.disconnect();
    };
    if ((ctx as AudioContext).state === 'running') setTimeout(stop, 400);
    else stop();
  }
}
