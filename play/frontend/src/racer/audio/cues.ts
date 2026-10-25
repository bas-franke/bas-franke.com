// One-shot race cues, all synthesized: countdown beeps, boost pad zap, impact crunches, lap chime, best-lap
// flourish, the finish fanfare and the part-break cues (metal tearing, an engine ripping off, glass, a shorting binder,
// a snapping cable). Each call builds a few short-lived nodes that stop themselves (and are then
// garbage collected), so nothing here needs disposing.

import { noise } from './context';

interface ToneOpts {
  type?: OscillatorType;
  /** Frequency at the end (exponential sweep). */
  to?: number;
  attack?: number;
  detune?: number;
  /** Optional low-pass cutoff. */
  lp?: number;
}

/** A single enveloped oscillator note starting at t0. */
export function tone(ctx: BaseAudioContext, dest: AudioNode, f: number, t0: number, dur: number, peak: number, o: ToneOpts = {}) {
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(f, t0);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
  if (o.detune) osc.detune.value = o.detune;
  const g = ctx.createGain();
  const a = o.attack ?? 0.005;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + a);
  g.gain.setTargetAtTime(0, t0 + a, dur / 4);
  let head: AudioNode = g;
  if (o.lp) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = o.lp;
    g.connect(lp);
    head = lp;
  }
  osc.connect(g);
  head.connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + 0.1);
}

/** A filtered noise burst. */
export function burst(ctx: BaseAudioContext, dest: AudioNode, t0: number, dur: number, peak: number, type: BiquadFilterType, f: number, q = 1, fTo?: number, buf?: AudioBuffer) {
  const src = ctx.createBufferSource();
  src.buffer = buf ?? noise(ctx).white;
  const flt = ctx.createBiquadFilter();
  flt.type = type;
  flt.frequency.setValueAtTime(f, t0);
  if (fTo) flt.frequency.exponentialRampToValueAtTime(fTo, t0 + dur);
  flt.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
  g.gain.setTargetAtTime(0, t0 + 0.004, dur / 4);
  src.connect(flt).connect(g).connect(dest);
  src.start(t0, Math.random() * (src.buffer.duration - dur - 0.2 > 0 ? src.buffer.duration - dur - 0.2 : 0));
  src.stop(t0 + dur + 0.1);
}

/** Countdown: 3, 2, 1 a low double-beep, 0 = GO, a high bright chord. */
export function countdownBeep(ctx: BaseAudioContext, dest: AudioNode, n: number) {
  const t = ctx.currentTime + 0.01;
  if (n > 0) {
    tone(ctx, dest, 440, t, 0.32, 0.22, { type: 'square', lp: 2400 });
    tone(ctx, dest, 220, t, 0.32, 0.18, { type: 'sine' });
  } else {
    for (const [f, a] of [[880, 0.2], [1320, 0.12], [1760, 0.07]] as const) tone(ctx, dest, f, t, 0.9, a, { type: 'square', lp: 5000 });
    tone(ctx, dest, 440, t, 0.9, 0.2, { type: 'sawtooth', lp: 2000 });
  }
}

/** Boost pad: an electric zap sweeping up, with a crackle of static. */
export function padZap(ctx: BaseAudioContext, dest: AudioNode, level = 1) {
  const t = ctx.currentTime + 0.005;
  tone(ctx, dest, 220, t, 0.45, 0.22 * level, { type: 'sawtooth', to: 1900, lp: 4000 });
  tone(ctx, dest, 330, t, 0.45, 0.12 * level, { type: 'square', to: 2600, lp: 6000, detune: 9 });
  burst(ctx, dest, t, 0.35, 0.5 * level, 'bandpass', 2500, 2, 7000, noise(ctx).crackle);
  burst(ctx, dest, t, 0.6, 0.25 * level, 'highpass', 1500, 0.7);
}

/** Impact crunch scaled by strength 0..1: a body thump, grinding noise and a metallic clang. */
export function crunch(ctx: BaseAudioContext, dest: AudioNode, k: number) {
  const t = ctx.currentTime + 0.005;
  const s = Math.min(1, Math.max(0.1, k));
  tone(ctx, dest, 95, t, 0.35 + 0.3 * s, 0.6 * s, { to: 38 });
  burst(ctx, dest, t, 0.25 + 0.35 * s, 0.7 * s, 'lowpass', 2200 + 2000 * s, 0.8, 300);
  burst(ctx, dest, t, 0.2 + 0.2 * s, 0.4 * s, 'bandpass', 1800, 1.5, 900, noise(ctx).crackle);
  // Inharmonic partials of a struck panel.
  const base = 310 + Math.random() * 120;
  for (const [r, a] of [[1, 0.1], [2.76, 0.06], [5.4, 0.035]] as const) tone(ctx, dest, base * r, t, 0.3 + 0.5 * s, a * s);
}

/** Lap chime: a two-note bell. */
export function lapChime(ctx: BaseAudioContext, dest: AudioNode) {
  const t = ctx.currentTime + 0.01;
  bell(ctx, dest, 988, t, 0.16);
  bell(ctx, dest, 1319, t + 0.14, 0.16);
}

/** Best lap: a quick rising arpeggio with a shimmer on top. */
export function bestFlourish(ctx: BaseAudioContext, dest: AudioNode) {
  const t = ctx.currentTime + 0.01;
  const notes = [784, 988, 1175, 1568, 1976];
  notes.forEach((f, i) => bell(ctx, dest, f, t + i * 0.075, 0.13));
  burst(ctx, dest, t + 0.3, 0.9, 0.06, 'highpass', 6000, 0.7);
}

function bell(ctx: BaseAudioContext, dest: AudioNode, f: number, t: number, a: number) {
  tone(ctx, dest, f, t, 0.9, a);
  tone(ctx, dest, f * 2.0, t, 0.5, a * 0.35);
  tone(ctx, dest, f * 3.01, t, 0.3, a * 0.15);
}

/** Finish fanfare: brassy chord stabs, grander for a better position. */
export function fanfare(ctx: BaseAudioContext, dest: AudioNode, position: number) {
  const t = ctx.currentTime + 0.02;
  const brass = (f: number, at: number, dur: number, a: number) => {
    tone(ctx, dest, f, at, dur, a, { type: 'sawtooth', lp: 2600, attack: 0.03 });
    tone(ctx, dest, f, at, dur, a * 0.7, { type: 'sawtooth', lp: 2600, attack: 0.03, detune: 12 });
  };
  if (position === 1) {
    // G C E G ... big C major with the octave.
    const seq: [number, number][] = [[392, 0], [523, 0.14], [659, 0.28]];
    for (const [f, d] of seq) brass(f, t + d, 0.22, 0.09);
    for (const f of [523, 659, 784, 1047]) brass(f, t + 0.45, 1.8, 0.07);
    burst(ctx, dest, t + 0.45, 1.6, 0.05, 'highpass', 7000, 0.7);
  } else if (position <= 3) {
    for (const [f, d] of [[440, 0], [554, 0.15]] as const) brass(f, t + d, 0.22, 0.08);
    for (const f of [440, 554, 659]) brass(f, t + 0.32, 1.2, 0.07);
  } else {
    // A plain resolved cadence: finished, not celebrated.
    brass(392, t, 0.3, 0.07);
    for (const f of [349, 440, 523]) brass(f, t + 0.3, 0.9, 0.055);
  }
}

// ---------- part breaks (core/damage.ts) ----------
// Each takes a strength k (0..1, how hard the hit that broke it was) and is scaled to it; `size` makes the same cue
// read for a little stabiliser or a whole nose cone (0 = small, high and short; 1 = big, low and long).

/** A panel tearing off and snapping: a sharp crack, a ripping noise sweep and a short ring of the freed piece. */
export function metalTear(ctx: BaseAudioContext, dest: AudioNode, k: number, size = 0.5) {
  const t = ctx.currentTime + 0.005;
  const s = Math.min(1, Math.max(0.2, k));
  const bank = noise(ctx);
  burst(ctx, dest, t, 0.06, 1 * s, 'highpass', 2500 - 1200 * size, 0.8);
  // The tear: crackle through a band that slides down as the rivets let go.
  burst(ctx, dest, t + 0.01, 0.18 + 0.25 * size, 1 * s, 'bandpass', 3200 - 1400 * size, 3, 600 - 200 * size, bank.crackle);
  burst(ctx, dest, t + 0.02, 0.12 + 0.2 * size, 0.5 * s, 'bandpass', 1800 - 600 * size, 6, 500);
  const base = (900 - 550 * size) * (0.9 + Math.random() * 0.2);
  for (const [r, a] of [[1, 0.14], [2.41, 0.08], [3.93, 0.045]] as const) tone(ctx, dest, base * r, t + 0.03, 0.25 + 0.35 * size, a * s, { to: base * r * 0.96 });
}

/** An engine nacelle ripping free: a deep double clang, a body thump and the whoosh of it tumbling away. */
export function engineTearOff(ctx: BaseAudioContext, dest: AudioNode, k: number) {
  const t = ctx.currentTime + 0.005;
  const s = Math.min(1, Math.max(0.4, k));
  tone(ctx, dest, 70, t, 0.9, 0.7 * s, { to: 30 });
  burst(ctx, dest, t, 0.5, 0.8 * s, 'lowpass', 1600, 0.8, 200);
  burst(ctx, dest, t, 0.35, 0.5 * s, 'bandpass', 2400, 2, 700, noise(ctx).crackle);
  // Struck heavy plate: low inharmonic partials ringing long, struck twice as it twists free.
  for (const [dt, base] of [[0, 150 + Math.random() * 30], [0.11, 118 + Math.random() * 20]] as const) {
    for (const [r, a] of [[1, 0.14], [2.32, 0.09], [4.11, 0.05], [6.8, 0.025]] as const) tone(ctx, dest, base * r, t + dt, 1.4 - 0.12 * r, a * s);
  }
  // The whoosh: a noise band rising then falling as the engine tumbles past.
  whoosh(ctx, dest, t + 0.12, 0.9, 0.4 * s, 350, 1900);
}

/** A band of noise that sweeps up to `peakF` and back down, swelling in and out (things flying past). */
function whoosh(ctx: BaseAudioContext, dest: AudioNode, t0: number, dur: number, peak: number, f0: number, peakF: number) {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx).white;
  const flt = ctx.createBiquadFilter();
  flt.type = 'bandpass';
  flt.Q.value = 1.4;
  flt.frequency.setValueAtTime(f0, t0);
  flt.frequency.exponentialRampToValueAtTime(peakF, t0 + dur * 0.4);
  flt.frequency.exponentialRampToValueAtTime(f0 * 0.7, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + dur * 0.4);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  src.connect(flt).connect(g).connect(dest);
  src.start(t0, Math.random() * 1);
  src.stop(t0 + dur + 0.05);
}

/** The canopy shattering: a hard crack, then a spray of tiny glassy tinkles falling away. */
export function glassShatter(ctx: BaseAudioContext, dest: AudioNode, k: number) {
  const t = ctx.currentTime + 0.005;
  const s = Math.min(1, Math.max(0.3, k));
  burst(ctx, dest, t, 0.05, 0.9 * s, 'highpass', 3000, 0.7);
  burst(ctx, dest, t, 0.4, 0.3 * s, 'highpass', 5000, 0.8, 8000, noise(ctx).crackle);
  for (let i = 0; i < 16; i++) {
    const at = t + 0.01 + Math.random() ** 1.6 * 0.45;
    const f = 2600 + Math.random() * 5200;
    tone(ctx, dest, f, at, 0.04 + Math.random() * 0.12, (0.03 + Math.random() * 0.05) * s, { detune: Math.random() * 40 });
  }
}

/** An energy binder shorting out: a buzzing arc that stutters and dies, with a crackle of sparks. */
export function binderZap(ctx: BaseAudioContext, dest: AudioNode, k: number) {
  const t = ctx.currentTime + 0.005;
  const s = Math.min(1, Math.max(0.3, k));
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const g = ctx.createGain();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1400;
  bp.Q.value = 1.2;
  // The arc jumps between pitches and cuts in and out (a few scheduled steps, no per-frame work).
  g.gain.setValueAtTime(0, t);
  let at = t;
  for (let i = 0; i < 9; i++) {
    osc.frequency.setValueAtTime(90 + Math.random() * 260, at);
    g.gain.setValueAtTime((Math.random() < 0.75 ? 0.45 : 0.04) * s * (1 - i / 11), at);
    at += 0.02 + Math.random() * 0.04;
  }
  g.gain.setTargetAtTime(0, at, 0.03);
  osc.connect(bp).connect(g).connect(dest);
  osc.start(t);
  osc.stop(at + 0.25);
  burst(ctx, dest, t, 0.45, 0.9 * s, 'bandpass', 3800, 2, 1500, noise(ctx).crackle);
  tone(ctx, dest, 1800, t, 0.25, 0.1 * s, { type: 'square', to: 300, lp: 5000 });
}

/** A steering cable snapping: a crack and a slack, wobbling twang dropping in pitch. */
export function cableTwang(ctx: BaseAudioContext, dest: AudioNode, k: number) {
  const t = ctx.currentTime + 0.005;
  const s = Math.min(1, Math.max(0.3, k));
  burst(ctx, dest, t, 0.04, 0.6 * s, 'highpass', 3500, 0.8);
  const f = 210 + Math.random() * 60;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(f, t);
  osc.frequency.exponentialRampToValueAtTime(f * 0.45, t + 0.7);
  // The wobble of the loose cable: a fast vibrato that slows with it.
  const vib = ctx.createOscillator();
  vib.frequency.setValueAtTime(22, t);
  vib.frequency.linearRampToValueAtTime(7, t + 0.7);
  const vibDepth = ctx.createGain();
  vibDepth.gain.value = f * 0.06;
  vib.connect(vibDepth).connect(osc.frequency);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(3500, t);
  lp.frequency.exponentialRampToValueAtTime(500, t + 0.7);
  lp.Q.value = 4;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.16 * s, t + 0.004);
  g.gain.setTargetAtTime(0, t + 0.004, 0.2);
  osc.connect(lp).connect(g).connect(dest);
  for (const o of [osc, vib]) {
    o.start(t);
    o.stop(t + 0.9);
  }
}
