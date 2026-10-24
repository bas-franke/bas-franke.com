// One-shot race cues, all synthesized: countdown beeps, boost pad zap, impact crunches, lap chime, best-lap
// flourish and the finish fanfare. Each call builds a few short-lived nodes that stop themselves (and are then
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
