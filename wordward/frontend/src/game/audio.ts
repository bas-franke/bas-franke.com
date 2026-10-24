// Tiny synthesized sound effects. No files to load, and it stays quiet until the first user gesture.

type Sfx = 'zap' | 'tink' | 'pop' | 'miss' | 'poof' | 'bigpoof' | 'bonk' | 'wave' | 'lose' | 'heal' | 'appear';

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

  /** `pitch` lets consecutive shots climb a little, so a fast word sounds like a run of notes. */
  play(name: Sfx, pitch = 1) {
    switch (name) {
      case 'zap':
        this.tone(880 * pitch, 0.08, 'sine', 0.12, 1.6);
        this.tone(1760 * pitch, 0.05, 'triangle', 0.05, 1.3);
        break;
      case 'tink':
        this.tone(1568 * pitch, 0.07, 'triangle', 0.1, 1.1);
        this.tone(2093 * pitch, 0.09, 'sine', 0.05, 1, 0.02);
        break;
      case 'pop':
        this.tone(500, 0.06, 'sine', 0.25, 3);
        this.noise(0.08, 0.15, 5000);
        [1047, 1319, 1568].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.08, 1, 0.04 + i * 0.04));
        break;
      case 'miss':
        this.tone(220, 0.09, 'square', 0.06, 0.8);
        this.tone(196, 0.12, 'square', 0.06, 0.8, 0.07);
        break;
      case 'poof':
        this.noise(0.3, 0.3, 2500);
        this.tone(392, 0.12, 'triangle', 0.15, 2);
        this.tone(784, 0.18, 'sine', 0.12, 1.5, 0.08);
        break;
      case 'bigpoof':
        this.noise(0.6, 0.45, 1800);
        [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.14, 1, i * 0.07));
        break;
      case 'bonk':
        this.tone(160, 0.25, 'sine', 0.5, 0.5);
        this.tone(320, 0.15, 'square', 0.12, 0.6);
        this.noise(0.25, 0.3, 900);
        break;
      case 'wave':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.16, 1, i * 0.1));
        break;
      case 'lose':
        [392, 370, 349, 262].forEach((f, i) => this.tone(f, i === 3 ? 0.7 : 0.3, 'triangle', 0.18, i === 3 ? 0.8 : 1, i * 0.28));
        break;
      case 'heal':
        this.tone(784, 0.12, 'sine', 0.16);
        this.tone(1175, 0.25, 'sine', 0.16, 1, 0.1);
        break;
      case 'appear':
        this.tone(660, 0.1, 'triangle', 0.1, 1.5);
        this.tone(990, 0.14, 'triangle', 0.1, 1.2, 0.09);
        break;
    }
  }
}

export const sfx = new Audio();
