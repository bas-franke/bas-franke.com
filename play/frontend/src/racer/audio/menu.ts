// Menu sounds for the racer: tiny UI blips (hover, select, back, purchase, error) and a looping ambient desert wind
// with slow gusts and a faint whistle. Synthesized, on the racer's shared AudioContext (context.ts); silent until the
// page has had a user gesture, and the ambient bed starts by itself on the first one if it was asked for earlier.
//
//   import { menuAudio } from '../audio/menu';
//   menuAudio.hover(); menuAudio.select(); menuAudio.back(); menuAudio.purchase(); menuAudio.error();
//   menuAudio.startAmbient(); menuAudio.stopAmbient();   // e.g. on menu mount / unmount
//   menuAudio.setMuted(true);

import { sfx } from '../../engine/audio';
import { currentAudioContext, glide, loopNoise, noise, withAudioContext } from './context';
import { tone } from './cues';

interface Ambient {
  out: GainNode;
  nodes: AudioScheduledSourceNode[];
}

class MenuAudio {
  private out: GainNode | null = null;
  private ambient: Ambient | null = null;
  private wantAmbient = false;
  private cancel: (() => void) | null = null;
  private muted = false;
  private lastHover = 0;
  private armed = false;

  constructor() {
    sfx.subscribe(() => this.applyLevel());
  }

  /** The output bus on the shared context, or null before the first gesture. */
  private bus(): GainNode | null {
    if (this.out) return this.out;
    const ctx = currentAudioContext();
    if (!ctx) {
      // Make the context on the next gesture; nothing plays until then.
      if (!this.armed) {
        this.armed = true;
        withAudioContext(() => {});
      }
      return null;
    }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    this.out = ctx.createGain();
    this.out.gain.value = this.level();
    this.out.connect(comp).connect(ctx.destination);
    return this.out;
  }

  private level() {
    return this.muted ? 0 : Math.min(1, sfx.level * 2) * 0.8;
  }

  private ready(): [AudioContext, GainNode] | null {
    const out = this.bus();
    const ctx = currentAudioContext();
    if (!out || !ctx || ctx.state !== 'running') return null;
    return [ctx, out];
  }

  /** A soft tick when the pointer or focus moves onto an item (rate limited). */
  hover() {
    const r = this.ready();
    if (!r) return;
    const [ctx, out] = r;
    if (ctx.currentTime - this.lastHover < 0.04) return;
    this.lastHover = ctx.currentTime;
    tone(ctx, out, 1900, ctx.currentTime + 0.003, 0.05, 0.05, { type: 'triangle' });
  }

  /** Confirm: a bright upward double blip. */
  select() {
    const r = this.ready();
    if (!r) return;
    const [ctx, out] = r;
    const t = ctx.currentTime + 0.003;
    tone(ctx, out, 880, t, 0.09, 0.12, { type: 'square', lp: 3500 });
    tone(ctx, out, 1320, t + 0.06, 0.14, 0.12, { type: 'square', lp: 3500 });
  }

  /** Back / cancel: a short downward blip. */
  back() {
    const r = this.ready();
    if (!r) return;
    const [ctx, out] = r;
    tone(ctx, out, 700, ctx.currentTime + 0.003, 0.14, 0.11, { type: 'square', to: 420, lp: 2500 });
  }

  /** Purchase: a cash-register sparkle (two coin pings and a shimmer). */
  purchase() {
    const r = this.ready();
    if (!r) return;
    const [ctx, out] = r;
    const t = ctx.currentTime + 0.003;
    for (const [f, d] of [[1568, 0], [2093, 0.08], [2637, 0.16]] as const) {
      tone(ctx, out, f, t + d, 0.35, 0.09, { type: 'sine' });
      tone(ctx, out, f * 2.01, t + d, 0.15, 0.03, { type: 'sine' });
    }
    tone(ctx, out, 523, t, 0.3, 0.08, { type: 'triangle' });
  }

  /** Not allowed (too expensive, locked). */
  error() {
    const r = this.ready();
    if (!r) return;
    const [ctx, out] = r;
    const t = ctx.currentTime + 0.003;
    tone(ctx, out, 180, t, 0.12, 0.12, { type: 'square', lp: 1200 });
    tone(ctx, out, 150, t + 0.11, 0.18, 0.12, { type: 'square', lp: 1200 });
  }

  /** Starts the looping desert wind (idempotent). Before the first gesture it starts on that gesture. */
  startAmbient() {
    this.wantAmbient = true;
    if (this.ambient) return;
    const ctx = currentAudioContext();
    if (!ctx) {
      if (!this.cancel) this.cancel = withAudioContext(() => {
        this.cancel = null;
        if (this.wantAmbient) this.startAmbient();
      });
      return;
    }
    const out = this.bus()!;
    this.ambient = this.buildAmbient(ctx, out);
  }

  /** Fades the wind out and stops it. */
  stopAmbient() {
    this.wantAmbient = false;
    this.cancel?.();
    this.cancel = null;
    const a = this.ambient;
    const ctx = currentAudioContext();
    if (!a || !ctx) return;
    this.ambient = null;
    glide(a.out.gain, 0, ctx.currentTime, 0.25);
    setTimeout(() => {
      for (const n of a.nodes) n.stop();
      a.out.disconnect();
    }, 1500);
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.applyLevel();
  }

  private applyLevel() {
    const ctx = currentAudioContext();
    if (this.out && ctx) glide(this.out.gain, this.level(), ctx.currentTime, 0.05);
  }

  private buildAmbient(ctx: AudioContext, dest: AudioNode): Ambient {
    const bank = noise(ctx);
    const nodes: AudioScheduledSourceNode[] = [];
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(dest);
    glide(out.gain, 0.5, ctx.currentTime, 1.2);

    // Two gust layers: noise through a band-pass whose level and centre are swept by slow, unrelated LFOs.
    const gust = (f: number, q: number, rate: number, pan: number, level: number) => {
      const src = loopNoise(ctx, bank.white, 0.6);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = level;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(bp).connect(g).connect(p).connect(out);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const amp = ctx.createGain();
      amp.gain.value = level * 0.8;
      lfo.connect(amp).connect(g.gain);
      const sweep = ctx.createGain();
      sweep.gain.value = f * 0.4;
      lfo.connect(sweep).connect(bp.frequency);
      lfo.start();
      nodes.push(src, lfo);
    };
    gust(380, 0.8, 0.07, -0.4, 0.3);
    gust(700, 1.1, 0.113, 0.45, 0.18);
    // A deep rumble under it all.
    const rumble = loopNoise(ctx, bank.brown, 0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    const rg = ctx.createGain();
    rg.gain.value = 0.35;
    rumble.connect(lp).connect(rg).connect(out);
    nodes.push(rumble);
    // A faint whistle through the rocks: a narrow resonant band that drifts.
    const ws = loopNoise(ctx, bank.white, 1);
    const wbp = ctx.createBiquadFilter();
    wbp.type = 'bandpass';
    wbp.frequency.value = 1450;
    wbp.Q.value = 28;
    const wg = ctx.createGain();
    wg.gain.value = 0.12;
    const wl = ctx.createOscillator();
    wl.frequency.value = 0.05;
    const wd = ctx.createGain();
    wd.gain.value = 220;
    wl.connect(wd).connect(wbp.frequency);
    const wa = ctx.createGain();
    wa.gain.value = 0.12;
    wl.connect(wa).connect(wg.gain);
    ws.connect(wbp).connect(wg).connect(out);
    wl.start();
    nodes.push(ws, wl);
    return { out, nodes };
  }
}

export const menuAudio = new MenuAudio();
