// Tiny synthesized sound effects. No files to load, and it stays quiet until the first user gesture.

type Sfx = 'zap' | 'miss' | 'boom' | 'bigboom' | 'hurt' | 'wave' | 'lose' | 'heal';

class Audio {
  private ctx?: AudioContext;
  private master?: GainNode;
  volume = 0.45;
  muted = false;

  private ensure() {
    if (this.muted) return undefined;
    if (this.ctx) return this.ctx.state === 'suspended' ? (void this.ctx.resume(), this.ctx) : this.ctx;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    } catch {
      return undefined;
    }
    return this.ctx;
  }

  unlock() {
    this.ensure();
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, slide = 1, at = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide !== 1) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain: number, lowpass = 2000, at = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + at;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(lowpass, t);
    filter.frequency.exponentialRampToValueAtTime(100, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
  }

  /** `pitch` lets consecutive laser shots climb a little, so a fast word sounds like a run of notes. */
  play(name: Sfx, pitch = 1) {
    switch (name) {
      case 'zap':
        this.tone(1400 * pitch, 0.09, 'square', 0.07, 0.35);
        this.tone(700 * pitch, 0.07, 'sawtooth', 0.05, 0.5);
        break;
      case 'miss':
        this.tone(140, 0.16, 'square', 0.12, 0.7);
        break;
      case 'boom':
        this.noise(0.45, 0.55, 1400);
        this.tone(110, 0.35, 'sine', 0.4, 0.4);
        break;
      case 'bigboom':
        this.noise(1.1, 0.8, 900);
        this.tone(70, 0.9, 'sine', 0.6, 0.3);
        break;
      case 'hurt':
        this.noise(0.6, 0.7, 700);
        this.tone(180, 0.5, 'sawtooth', 0.3, 0.4);
        break;
      case 'wave':
        [392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.16, 1, i * 0.1));
        break;
      case 'lose':
        [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.45, 'sawtooth', 0.15, 0.9, i * 0.22));
        break;
      case 'heal':
        this.tone(660, 0.12, 'sine', 0.18);
        this.tone(990, 0.25, 'sine', 0.18, 1, 0.1);
        break;
    }
  }
}

export const sfx = new Audio();
