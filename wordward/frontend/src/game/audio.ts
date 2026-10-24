// Synthesized sound for the enchanted library: soft, warm and a little magical. No files to load, and it stays
// quiet until the first user gesture.
//
// Signal flow (built once per AudioContext):
//   voices ─┬─────────────────────────────┐
//           └─ send ─ convolver (hall) ───┤
//   ambient bed ─ ambient gain ───────────┴─ master (volume/mute) ─ compressor ─ soft limiter (≤ -1 dBFS) ─ out
//
// Every sound builds a handful of short-lived nodes; the noise buffer and the impulse response are made once and
// shared, so typing fast never allocates anything big.

export type Sfx = 'zap' | 'tink' | 'pop' | 'miss' | 'poof' | 'bigpoof' | 'bonk' | 'wave' | 'lose' | 'heal' | 'appear';
export const SFX_NAMES: readonly Sfx[] = ['zap', 'tink', 'pop', 'miss', 'poof', 'bigpoof', 'bonk', 'wave', 'lose', 'heal', 'appear'];

/** Largest sample the output can ever reach: -1 dBFS. */
const CEILING = 0.891;

interface Bus {
  ctx: BaseAudioContext;
  dry: GainNode; // voices land here
  rev: GainNode; // reverb send input
  master: GainNode; // volume / mute
  ambient: GainNode; // ambient bed level
  noise: AudioBuffer; // 2 s of white noise, shared
}

const buses = new WeakMap<BaseAudioContext, Bus>();

function softClipCurve(): Float32Array<ArrayBuffer> {
  // The shaper sees signal / 2, so the curve covers input levels up to ±2. Linear below 0.6, then a tanh knee
  // that never passes the ceiling.
  const n = 4096;
  const curve = new Float32Array(n);
  const knee = 0.6;
  const room = CEILING - knee;
  for (let i = 0; i < n; i++) {
    const s = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(s);
    const y = a < knee ? a : knee + room * Math.tanh((a - knee) / room);
    curve[i] = Math.sign(s) * y;
  }
  return curve;
}

function impulse(ctx: BaseAudioContext, seconds = 1.8): AudioBuffer {
  // A soft, dark little hall: stereo exponentially decaying noise, one-pole low-passed so the tail is warm.
  const rate = ctx.sampleRate;
  const len = Math.ceil(rate * seconds);
  const pre = Math.floor(rate * 0.012);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / rate;
      const k = 0.18 + 0.5 * Math.exp(-t * 3); // brighter at the start, darker in the tail
      lp += k * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-t * 3.6);
    }
  }
  return buf;
}

function makeBus(ctx: BaseAudioContext, volume: number): Bus {
  const master = ctx.createGain();
  master.gain.value = volume;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 10;
  comp.ratio.value = 5;
  comp.attack.value = 0.003;
  comp.release.value = 0.18;

  const makeup = ctx.createGain();
  makeup.gain.value = 2 * 0.5; // makeup, then halve for the shaper's ±2 input range
  const limiter = ctx.createWaveShaper();
  limiter.curve = softClipCurve();
  limiter.oversample = '2x';

  master.connect(comp).connect(makeup).connect(limiter).connect(ctx.destination);

  const dry = ctx.createGain();
  dry.connect(master);

  const rev = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = impulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  rev.connect(conv).connect(wet).connect(master);

  const ambient = ctx.createGain();
  ambient.gain.value = 0;
  ambient.connect(master);

  const rate = ctx.sampleRate;
  const noise = ctx.createBuffer(1, rate * 2, rate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const bus = { ctx, dry, rev, master, ambient, noise };
  buses.set(ctx, bus);
  return bus;
}

// ---------------------------------------------------------------------------------------------------------------
// Voice helpers. `out` defaults to the dry bus; the ambient bed passes its own gain node.

interface Out {
  bus: Bus;
  out: AudioNode;
}

function route(o: Out, node: AudioNode, send: number, pan: number) {
  const { ctx } = o.bus;
  let n = node;
  if (pan) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    n.connect(p);
    n = p;
  }
  n.connect(o.out);
  if (send > 0) {
    const s = ctx.createGain();
    s.gain.value = send;
    n.connect(s).connect(o.bus.rev);
  }
}

/** Attack, then an exponential fall to silence at t + a + d. */
function env(p: AudioParam, t: number, peak: number, a: number, d: number) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.exponentialRampToValueAtTime(0.0001, t + a + d);
  p.setValueAtTime(0, t + a + d + 0.001);
}

interface ToneOpts {
  f: number;
  to?: number; // glide target
  glide?: number; // glide time (defaults to the whole note)
  type?: OscillatorType;
  a?: number;
  d: number;
  peak: number;
  send?: number;
  pan?: number;
  lp?: number; // low-pass cutoff to soften bright waves
  vib?: number; // vibrato depth in Hz (6.5 Hz rate)
}

function tone(o: Out, t: number, op: ToneOpts) {
  const { ctx } = o.bus;
  const a = op.a ?? 0.004;
  const osc = ctx.createOscillator();
  osc.type = op.type ?? 'sine';
  osc.frequency.setValueAtTime(op.f, t);
  if (op.to) osc.frequency.exponentialRampToValueAtTime(op.to, t + (op.glide ?? a + op.d));
  const g = ctx.createGain();
  env(g.gain, t, op.peak, a, op.d);
  let head: AudioNode = osc;
  if (op.lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = op.lp;
    f.Q.value = 0.4;
    head = head.connect(f);
  }
  head.connect(g);
  const end = t + a + op.d + 0.03;
  if (op.vib) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6.5;
    const lg = ctx.createGain();
    lg.gain.value = op.vib;
    lfo.connect(lg).connect(osc.frequency);
    lfo.start(t);
    lfo.stop(end);
  }
  route(o, g, op.send ?? 0, op.pan ?? 0);
  osc.start(t);
  osc.stop(end);
}

interface BellOpts {
  ratio?: number; // modulator : carrier
  index?: number; // FM depth at the strike, as a multiple of the carrier frequency
  bright?: number; // how fast the FM index falls (s)
  a?: number;
  d: number;
  peak: number;
  send?: number;
  pan?: number;
}

/** Two-operator FM bell. Inharmonic ratios ring like glass; ratio 4 sounds like a music-box tine. */
function bell(o: Out, t: number, f: number, op: BellOpts) {
  const { ctx } = o.bus;
  const a = op.a ?? 0.002;
  const car = ctx.createOscillator();
  car.frequency.value = f;
  const mod = ctx.createOscillator();
  mod.frequency.value = f * (op.ratio ?? 3.5);
  const mg = ctx.createGain();
  const depth = f * (op.index ?? 1.2);
  mg.gain.setValueAtTime(depth, t);
  mg.gain.exponentialRampToValueAtTime(depth * 0.02 + 0.01, t + (op.bright ?? 0.12));
  mod.connect(mg).connect(car.frequency);
  const g = ctx.createGain();
  env(g.gain, t, op.peak, a, op.d);
  car.connect(g);
  route(o, g, op.send ?? 0, op.pan ?? 0);
  const end = t + a + op.d + 0.03;
  car.start(t);
  mod.start(t);
  car.stop(end);
  mod.stop(end);
}

/** Music-box tine: harmonic FM pluck with a quick metallic tick. */
function tine(o: Out, t: number, f: number, peak: number, d = 0.9, send = 0.35, pan = 0) {
  bell(o, t, f, { ratio: 4, index: 1.6, bright: 0.05, d, peak, send, pan });
}

interface NoiseOpts {
  type?: BiquadFilterType;
  f: number;
  to?: number;
  glide?: number;
  q?: number;
  a?: number;
  d: number;
  peak: number;
  send?: number;
  pan?: number;
}

function noise(o: Out, t: number, op: NoiseOpts) {
  const { ctx, noise: buf } = o.bus;
  const a = op.a ?? 0.003;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = op.type ?? 'bandpass';
  f.frequency.setValueAtTime(op.f, t);
  if (op.to) f.frequency.exponentialRampToValueAtTime(op.to, t + (op.glide ?? a + op.d));
  f.Q.value = op.q ?? 1;
  const g = ctx.createGain();
  env(g.gain, t, op.peak, a, op.d);
  src.connect(f).connect(g);
  route(o, g, op.send ?? 0, op.pan ?? 0);
  const len = a + op.d + 0.03;
  src.start(t, Math.random() * (buf.duration - Math.min(len, 1.5)), len);
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
// A major pentatonic sparkle notes, up high.
const SPARKLE = [1760, 1976, 2217, 2637, 2960, 3520];

// ---------------------------------------------------------------------------------------------------------------
// The sounds.

function voice(o: Out, name: Sfx, pitch: number, t: number) {
  const p = Math.max(0.5, Math.min(2.5, pitch));
  const dt = rand(0.985, 1.015); // tiny humanising detune so repeats don't sound stamped out
  switch (name) {
    case 'zap': {
      // Soft "pew": a falling sine through a gentle low-pass, plus a shimmering glass partial that rises with
      // the combo. The pew itself climbs a little too.
      const f = 1250 * Math.pow(p, 0.6) * dt;
      tone(o, t, { f, to: f * 0.36, glide: 0.11, d: 0.12, a: 0.003, peak: 0.32, lp: 3200, send: 0.08 });
      tone(o, t, { f: f * 0.5, to: f * 0.25, glide: 0.08, type: 'triangle', d: 0.07, peak: 0.12, lp: 1600 });
      bell(o, t + 0.012, 1568 * p * dt, { ratio: 2.76, index: 0.5, bright: 0.06, d: 0.16, peak: 0.07, send: 0.3, pan: rand(-0.3, 0.3) });
      break;
    }
    case 'tink': {
      // Crystalline chime off a rune shield letter.
      const f = 2093 * Math.pow(p, 0.7) * dt;
      const pan = rand(-0.25, 0.25);
      bell(o, t, f, { ratio: 2.76, index: 0.9, bright: 0.04, d: 0.32, peak: 0.26, send: 0.35, pan });
      bell(o, t + 0.018, f * 1.5, { ratio: 3.1, index: 0.4, bright: 0.03, d: 0.22, peak: 0.11, send: 0.4, pan: -pan });
      break;
    }
    case 'pop': {
      // Bubbly rune burst: two quick rising bubbles, an airy puff, then a little sparkling arpeggio.
      tone(o, t, { f: 260, to: 900, glide: 0.05, d: 0.07, a: 0.002, peak: 0.34, lp: 2400 });
      tone(o, t + 0.035, { f: 380, to: 1300, glide: 0.045, d: 0.06, a: 0.002, peak: 0.2, lp: 3000, pan: 0.2 });
      noise(o, t, { type: 'bandpass', f: 2200, to: 6000, q: 0.8, d: 0.12, peak: 0.12, send: 0.2 });
      [1319, 1568, 1976, 2637].forEach((f, i) =>
        bell(o, t + 0.05 + i * 0.045, f * dt, { ratio: 3.5, index: 0.7, bright: 0.05, d: 0.3, peak: 0.1, send: 0.45, pan: -0.3 + i * 0.2 }),
      );
      break;
    }
    case 'miss': {
      // Soft muffled wooden "thup": a quick low knock and a short woody body resonance.
      tone(o, t, { f: 190 * dt, to: 95, glide: 0.07, d: 0.09, a: 0.002, peak: 0.42 });
      noise(o, t, { type: 'bandpass', f: 420, q: 3, d: 0.06, a: 0.001, peak: 0.28 });
      noise(o, t, { type: 'lowpass', f: 1400, to: 300, d: 0.03, a: 0.0008, peak: 0.12 });
      break;
    }
    case 'poof': {
      // Inky squelch (a resonant swept band of noise and a gurgling bloop), a few bubbles, then a sparkle.
      noise(o, t, { type: 'bandpass', f: 260, to: 1500, glide: 0.09, q: 5, d: 0.2, a: 0.008, peak: 0.42 });
      tone(o, t, { f: 150 * dt, to: 340, glide: 0.06, d: 0.14, a: 0.006, peak: 0.3, vib: 25 });
      for (let i = 0; i < 3; i++) {
        const b = rand(500, 900);
        tone(o, t + 0.05 + i * rand(0.03, 0.05), { f: b, to: b * 1.8, d: 0.04, a: 0.002, peak: 0.08, pan: rand(-0.4, 0.4) });
      }
      for (let i = 0; i < 3; i++) {
        bell(o, t + 0.11 + i * 0.05, pick(SPARKLE), { ratio: 3.5, index: 0.6, bright: 0.04, d: 0.25, peak: 0.07, send: 0.55, pan: rand(-0.5, 0.5) });
      }
      break;
    }
    case 'bigpoof': {
      // Bigger, deeper splash with a swelling magical chord (C maj9) and a spray of sparkles.
      noise(o, t, { type: 'bandpass', f: 180, to: 1200, glide: 0.14, q: 4, d: 0.38, a: 0.01, peak: 0.5 });
      noise(o, t, { type: 'lowpass', f: 600, to: 120, d: 0.4, a: 0.01, peak: 0.2 });
      tone(o, t, { f: 95, to: 230, glide: 0.09, d: 0.26, a: 0.008, peak: 0.36, vib: 18 });
      [262, 330, 392, 494, 587].forEach((f, i) =>
        tone(o, t + 0.04 + i * 0.012, { f: f * dt, type: 'triangle', a: 0.12, d: 0.9, peak: 0.07, lp: 1800, send: 0.6, pan: -0.4 + i * 0.2 }),
      );
      [1047, 1319, 1568, 2093, 2637, 3136].forEach((f, i) =>
        bell(o, t + 0.1 + i * 0.05, f, { ratio: 3.5, index: 0.8, bright: 0.05, d: 0.45, peak: 0.08, send: 0.55, pan: rand(-0.6, 0.6) }),
      );
      break;
    }
    case 'bonk': {
      // A soft tumble of books: three padded thuds, each a bit quieter, and a papery flutter.
      [0, 0.075, 0.16].forEach((at, i) => {
        const k = 1 - i * 0.28;
        const f = rand(95, 125);
        tone(o, t + at, { f, to: f * 0.55, glide: 0.1, d: 0.16, a: 0.003, peak: 0.36 * k, pan: (i - 1) * 0.25 });
        noise(o, t + at, { type: 'lowpass', f: 700, to: 200, q: 0.7, d: 0.1, a: 0.002, peak: 0.22 * k, pan: (i - 1) * 0.25 });
      });
      noise(o, t + 0.04, { type: 'bandpass', f: 3200, to: 2200, q: 0.7, a: 0.05, d: 0.22, peak: 0.07, send: 0.25 });
      break;
    }
    case 'wave': {
      // Music-box flourish: a quick climb that lands on a sustained tonic with its fifth.
      [784, 1047, 1319, 1568, 2093].forEach((f, i) => tine(o, t + i * 0.07, f, 0.13, 0.6, 0.35, -0.3 + i * 0.15));
      tine(o, t + 0.38, 1047, 0.12, 1.2, 0.45, -0.15);
      tine(o, t + 0.38, 1568, 0.09, 1.2, 0.45, 0.15);
      break;
    }
    case 'lose': {
      // Gentle, sad music-box phrase in A minor over a soft low pad.
      const notes: [number, number][] = [[1319, 0], [1175, 0.32], [1047, 0.64], [988, 0.96], [880, 1.36]];
      notes.forEach(([f, at], i) => tine(o, t + at, f, 0.14, i === notes.length - 1 ? 1.8 : 0.9, 0.45));
      [220, 262, 330].forEach((f, i) =>
        tone(o, t + 0.1 + i * 0.02, { f, type: 'triangle', a: 0.6, d: 2.2, peak: 0.05, lp: 900, send: 0.5, pan: (i - 1) * 0.3 }),
      );
      break;
    }
    case 'heal': {
      // Warm bell: soft FM bell on G5 answered by D6, a sine octave underneath.
      bell(o, t, 784, { ratio: 2, index: 1.0, bright: 0.2, d: 0.7, peak: 0.16, send: 0.45, pan: -0.15 });
      tone(o, t, { f: 392, a: 0.01, d: 0.5, peak: 0.12, send: 0.3 });
      bell(o, t + 0.11, 1175, { ratio: 2, index: 0.8, bright: 0.15, d: 0.8, peak: 0.13, send: 0.5, pan: 0.15 });
      break;
    }
    case 'appear': {
      // A curious twinkle: a little rising "hm?" with vibrato, then a high glint.
      tone(o, t, { f: 700 * dt, to: 1050, glide: 0.12, type: 'triangle', a: 0.02, d: 0.14, peak: 0.22, lp: 2600, vib: 12, send: 0.3 });
      bell(o, t + 0.1, 2349 * dt, { ratio: 3.5, index: 0.6, bright: 0.04, d: 0.3, peak: 0.13, send: 0.5, pan: rand(-0.4, 0.4) });
      bell(o, t + 0.16, 3136 * dt, { ratio: 3.5, index: 0.4, bright: 0.03, d: 0.25, peak: 0.08, send: 0.55, pan: rand(-0.4, 0.4) });
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Ambient bed: a very quiet slowly-morphing pad, with an occasional distant chime, page rustle or candle crackle.

const PAD_GAIN = 0.006;

const CHORDS: readonly number[][] = [
  [174.61, 261.63, 329.63, 440], // Fmaj7
  [146.83, 220, 349.23, 440], // Dm7
  [110, 196, 261.63, 329.63], // Am7
  [130.81, 196, 293.66, 329.63], // Cadd9
];

interface Bed {
  oscs: OscillatorNode[];
  nodes: AudioNode[];
  chord: number;
  timer?: ReturnType<typeof setTimeout>;
  chordTimer?: ReturnType<typeof setInterval>;
}

class Audio {
  private ctx?: AudioContext;
  private bus?: Bus;
  private bed?: Bed;
  private wantAmbient = false;
  private _volume = 0.45;
  private _muted = false;
  /** Ambient bed level relative to the effects (0..1). */
  ambientLevel = 1;

  get volume() {
    return this._volume;
  }
  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    this.applyMaster();
  }
  get muted() {
    return this._muted;
  }
  set muted(m: boolean) {
    this._muted = m;
    this.applyMaster();
  }

  private applyMaster() {
    if (!this.ctx || !this.bus) return;
    const g = this.bus.master.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(this._muted ? 0 : this._volume, this.ctx.currentTime, 0.03);
  }

  private ensure() {
    if (this._muted) return undefined;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.bus = makeBus(this.ctx, this._volume);
    } catch {
      this.ctx = undefined;
      return undefined;
    }
    if (this.wantAmbient) this.startBed();
    return this.ctx;
  }

  unlock() {
    this.ensure();
  }

  /** `pitch` lets consecutive shots climb a little, so a fast word sounds like a run of notes. */
  play(name: Sfx, pitch = 1) {
    const ctx = this.ensure();
    if (!ctx || !this.bus || ctx.state !== 'running') return;
    voice({ bus: this.bus, out: this.bus.dry }, name, pitch, ctx.currentTime + 0.005);
  }

  /** Turn the quiet library ambience on or off (fades over ~2 s). Safe to call before `unlock()`. */
  ambient(on: boolean) {
    this.wantAmbient = on;
    if (on) {
      if (this.ensure()) this.startBed();
    } else this.stopBed();
  }

  get ambientOn() {
    return this.wantAmbient;
  }

  private startBed() {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus || this.bed) return;
    const now = ctx.currentTime;
    const bed: Bed = { oscs: [], nodes: [], chord: 0 };

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 850;
    filter.Q.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 300;
    lfo.connect(lfoDepth).connect(filter.frequency);
    const pad = ctx.createGain();
    pad.gain.value = PAD_GAIN;
    filter.connect(pad);
    pad.connect(bus.ambient);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    pad.connect(send).connect(bus.rev);
    bed.oscs.push(lfo);
    bed.nodes.push(filter, lfoDepth, pad, send);

    CHORDS[0].forEach((f, i) => {
      for (const [type, cents] of [['sine', -5], ['triangle', 5]] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        o.detune.value = cents;
        const g = ctx.createGain();
        g.gain.value = type === 'sine' ? 0.6 : 0.25;
        const pan = ctx.createStereoPanner();
        pan.pan.value = (i / 3) * 1.2 - 0.6;
        o.connect(g).connect(pan).connect(filter);
        o.start(now);
        bed.oscs.push(o);
        bed.nodes.push(g, pan);
      }
    });
    lfo.start(now);

    const level = bus.ambient.gain;
    level.cancelScheduledValues(now);
    level.setValueAtTime(level.value, now);
    level.linearRampToValueAtTime(this.ambientLevel, now + 2.5);

    // Glide the pad to the next chord every ~10 s (slow glides sound like a breathing chord, not a slide).
    bed.chordTimer = setInterval(() => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      bed.chord = (bed.chord + 1) % CHORDS.length;
      const t = this.ctx.currentTime;
      CHORDS[bed.chord].forEach((f, i) => {
        for (let k = 0; k < 2; k++) bed.oscs[1 + i * 2 + k].frequency.setTargetAtTime(f, t, 1.2);
      });
    }, 10000);

    const tick = () => {
      bed.timer = setTimeout(tick, rand(3500, 8000));
      if (!this.ctx || !this.bus || this.ctx.state !== 'running') return;
      this.ambientEvent(this.ctx.currentTime + 0.05);
    };
    bed.timer = setTimeout(tick, 3000);
    this.bed = bed;
  }

  private ambientEvent(t: number) {
    const bus = this.bus!;
    const o: Out = { bus, out: bus.ambient };
    const r = Math.random();
    if (r < 0.4) {
      // Distant chime: very soft, mostly reverb.
      const f = pick([880, 988, 1109, 1319, 1480, 1760]);
      tine(o, t, f, 0.025, 1.4, 1.2, rand(-0.7, 0.7));
      if (Math.random() < 0.5) tine(o, t + rand(0.25, 0.5), f * pick([1.25, 1.5, 0.75]), 0.018, 1.4, 1.2, rand(-0.7, 0.7));
    } else if (r < 0.7) {
      // Page rustle: a couple of airy swishes.
      const pan = rand(-0.8, 0.8);
      noise(o, t, { type: 'bandpass', f: rand(2500, 3500), to: rand(1800, 2400), q: 0.9, a: 0.08, d: 0.25, peak: 0.022, pan, send: 0.3 });
      noise(o, t + rand(0.18, 0.3), { type: 'bandpass', f: rand(3000, 4200), to: 2600, q: 0.9, a: 0.05, d: 0.18, peak: 0.016, pan, send: 0.3 });
    } else {
      // Candle crackle: a few tiny ticks.
      const pan = rand(-0.6, 0.6);
      const n = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        noise(o, t + rand(0, 0.6), { type: 'highpass', f: rand(1800, 3500), q: 0.7, a: 0.0008, d: rand(0.006, 0.02), peak: rand(0.02, 0.05), pan });
      }
    }
  }

  private stopBed() {
    const bed = this.bed;
    if (!bed) return;
    this.bed = undefined;
    clearTimeout(bed.timer);
    clearInterval(bed.chordTimer);
    if (!this.ctx || !this.bus) return;
    const now = this.ctx.currentTime;
    const level = this.bus.ambient.gain;
    level.cancelScheduledValues(now);
    level.setValueAtTime(level.value, now);
    level.linearRampToValueAtTime(0, now + 1.5);
    for (const o of bed.oscs) o.stop(now + 1.6);
    setTimeout(() => bed.nodes.forEach((n) => n.disconnect()), 1800);
  }
}

export const sfx = new Audio();

/**
 * Render one sound offline (for tests and tooling). Uses the same graph as the live engine, including the reverb,
 * compressor and limiter. `volume` defaults to the live default.
 */
export async function renderSfx(name: Sfx | Sfx[], pitch = 1, seconds = 3, volume = 0.45, rate = 48000): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  const bus = makeBus(ctx, volume);
  const out: Out = { bus, out: bus.dry };
  const names = Array.isArray(name) ? name : [name];
  names.forEach((n, i) => voice(out, n, pitch, 0.02 + i * 0.09));
  return ctx.startRendering();
}

/** Render the ambient bed's pad plus a burst of its events offline (tooling only). */
export async function renderAmbient(seconds = 8, volume = 0.45, rate = 48000): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  const bus = makeBus(ctx, volume);
  bus.ambient.gain.value = 1;
  const pad = ctx.createGain();
  pad.gain.value = PAD_GAIN;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 850;
  filter.connect(pad).connect(bus.ambient);
  CHORDS[0].forEach((f) => {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = 0.85;
    o.connect(g).connect(filter);
    o.start(0);
  });
  // Borrow the live event generator through a throwaway engine bound to this bus.
  const eng = new Audio() as unknown as { bus: Bus; ambientEvent(t: number): void };
  eng.bus = bus;
  for (let t = 0.5; t < seconds - 2; t += 1.2) eng.ambientEvent(t);
  return ctx.startRendering();
}
