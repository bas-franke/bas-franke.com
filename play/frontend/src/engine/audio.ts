// Tiny synthesized sound effects. No files to load, and it stays quiet until the first user gesture.

type Sfx = 'fire' | 'boom' | 'hit' | 'hurt' | 'jump' | 'pad' | 'pickup' | 'spawn' | 'die' | 'coin' | 'dash' | 'tick' | 'go' | 'out' | 'win' | 'pass' | 'crack';

class Audio {
  private ctx?: AudioContext;
  private master?: GainNode;
  volume = 0.5;

  private ensure() {
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

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
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

  /** `distance` in metres attenuates the sound; 0 = at the listener. */
  play(name: Sfx, distance = 0) {
    const a = Math.max(0.05, 1 - distance / 40);
    switch (name) {
      case 'fire':
        this.noise(0.25, 0.5 * a, 1200);
        this.tone(160, 0.3, 'sawtooth', 0.25 * a, 0.3);
        break;
      case 'boom':
        this.noise(0.7, 0.9 * a, 900);
        this.tone(70, 0.6, 'sine', 0.6 * a, 0.4);
        break;
      case 'hit':
        this.tone(1200, 0.08, 'square', 0.15, 1.2);
        break;
      case 'hurt':
        this.tone(220, 0.18, 'sawtooth', 0.25, 0.6);
        this.noise(0.15, 0.2, 800);
        break;
      case 'jump':
        this.tone(300, 0.12, 'triangle', 0.12 * a, 1.6);
        break;
      case 'pad':
        this.tone(220, 0.35, 'sine', 0.3 * a, 3);
        break;
      case 'pickup':
        this.tone(660, 0.1, 'sine', 0.2);
        this.tone(990, 0.15, 'sine', 0.2, 1, 0.08);
        break;
      case 'spawn':
        this.tone(440, 0.2, 'triangle', 0.15 * a, 1.5);
        break;
      case 'die':
        this.tone(200, 0.5, 'sawtooth', 0.3 * a, 0.25);
        break;
      case 'coin':
        this.tone(1320, 0.07, 'square', 0.12 * a);
        this.tone(1760, 0.14, 'square', 0.12 * a, 1, 0.06);
        break;
      case 'dash':
        this.noise(0.18, 0.3 * a, 2500);
        break;
      case 'tick':
        this.tone(880, 0.06, 'square', 0.12);
        break;
      case 'go':
        this.tone(660, 0.12, 'square', 0.2);
        this.tone(880, 0.25, 'square', 0.2, 1, 0.12);
        break;
      case 'out':
        this.tone(330, 0.25, 'sawtooth', 0.25 * a, 0.5);
        this.tone(165, 0.4, 'sawtooth', 0.2 * a, 0.5, 0.2);
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.2, 1, i * 0.12));
        break;
      case 'pass':
        this.tone(500, 0.08, 'square', 0.15 * a, 1.5);
        break;
      case 'crack':
        this.noise(0.12, 0.25 * a, 3000);
        break;
    }
  }
}

export const sfx = new Audio();
