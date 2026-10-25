// Tiny synthesized sound effects. No files to load, and it stays quiet until the first user gesture.
//
// Graph: every sound builds a few short-lived nodes that feed `bus` -> compressor (a soft limiter, so eight players
// firing at once do not clip) -> `master` (the volume setting) -> speakers. Noise comes from two buffers made once
// and replayed from random offsets, so firing and explosions allocate no sample data.
//
// Two ways to play:
// - `play(name, distance)` is flat and centred, the original API (Ruckus, and sounds that happen to the listener).
// - `playAt(name, x, y, z)` is positional: distance attenuation, stereo pan and a muffling low-pass, all relative to
//   the listener set each frame with `listen()`. Rockets in flight get a looping hiss with doppler via `rocket()`.
// Positional sounds share a voice budget; when it is full, new far-away sounds are simply dropped.
//
// The volume setting (level and mute) is shared by every game on the site, including the racer's own graph, and is
// remembered in localStorage. `subscribe()` tells graphs outside this file when it changes.

type Sfx =
  | 'fire'
  | 'boom'
  | 'hit'
  | 'kill'
  | 'hurt'
  | 'jump'
  | 'land'
  | 'pad'
  | 'pickup'
  | 'health'
  | 'armor'
  | 'mega'
  | 'spawn'
  | 'die'
  | 'coin'
  | 'dash'
  | 'tick'
  | 'go'
  | 'out'
  | 'win'
  | 'pass'
  | 'crack';

/** Exaggerated speed of sound (m/s) for doppler: real air (343) is too subtle at rocket speed. */
const SOUND_SPEED = 110;
/** Positional one-shots that may overlap; the rest are dropped. */
const MAX_VOICES = 24;
/** Rocket flight loops at once. */
const MAX_LOOPS = 6;
const OPEN = 20000;

/** Roughly how long each sound holds a voice, in seconds. */
const LENGTH: Partial<Record<Sfx, number>> = { boom: 2.5, fire: 1.1, die: 0.6, pad: 0.45, win: 0.8 };

interface Loop {
  src: AudioBufferSourceNode;
  osc: OscillatorNode;
  band: BiquadFilterNode;
  lp: BiquadFilterNode;
  pan: StereoPannerNode;
  gain: GainNode;
  seen: number;
}

class Audio {
  private ctx?: AudioContext;
  private master?: GainNode;
  private bus?: GainNode;
  private white?: AudioBuffer;
  private crackle?: AudioBuffer;
  /** Slider level, 0..1, kept while muted. Use `level` for what is actually heard. */
  volume = 0.5;
  muted = false;
  private subs = new Set<() => void>();
  /** Immutable snapshot for React (`useSyncExternalStore`). */
  private state: VolumeState = { volume: 0.5, muted: false };

  // Listener, from the camera. Velocity is derived from position changes, for doppler.
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private lvx = 0;
  private lvy = 0;
  private lvz = 0;
  private rx = 1;
  private rz = 0;
  private fx = 0;
  private fz = -1;
  private lastListen = 0;
  private frame = 0;

  // Result of `spatial()`, kept in fields so the hot path allocates nothing.
  private sa = 1;
  private sp = 0;
  private sc = OPEN;
  private sd = 0;

  /** End times of the positional voices in flight. */
  private voices = new Float64Array(MAX_VOICES);
  private loops = new Map<number | string, Loop>();
  private nextBeat = 0;

  constructor() {
    const v = loadVolume();
    this.volume = v.volume;
    this.muted = v.muted;
    this.state = v;
  }

  private ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    try {
      const ctx = new AudioContext();
      this.master = ctx.createGain();
      this.master.gain.value = this.level;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 10;
      comp.ratio.value = 8;
      comp.attack.value = 0.002;
      comp.release.value = 0.2;
      this.bus = ctx.createGain();
      this.bus.gain.value = 0.8;
      this.bus.connect(comp).connect(this.master).connect(ctx.destination);
      this.white = makeWhite(ctx);
      this.crackle = makeCrackle(ctx);
      this.ctx = ctx;
    } catch {
      return undefined;
    }
    return this.ctx;
  }

  /** The context, only when it is running and audible (sounds scheduled while suspended would burst out later). */
  private live() {
    const ctx = this.ensure();
    return ctx && ctx.state === 'running' && this.level > 0 ? ctx : undefined;
  }

  unlock() {
    this.ensure();
  }

  /** What is heard, 0..1: the slider level, or 0 while muted. */
  get level() {
    return this.muted ? 0 : this.volume;
  }

  /** Master volume, 0..1. Raising it unmutes. Safe to call before the first gesture. */
  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));
    if (this.volume > 0) this.muted = false;
    this.changed();
  }

  setMuted(m: boolean) {
    this.muted = m;
    // Unmuting a slider left at zero would still be silent.
    if (!m && this.volume === 0) this.volume = 0.5;
    this.changed();
  }

  /** Called on every volume or mute change. Returns an unsubscribe function. */
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };

  snapshot = () => this.state;

  private changed() {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.level, this.ctx.currentTime, 0.02);
    this.state = { volume: this.volume, muted: this.muted };
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify(this.state));
    } catch {
      // Private mode or blocked storage: the setting lasts for this page only.
    }
    for (const fn of this.subs) fn();
  }

  // ---- listener -------------------------------------------------------------------------------------------------

  /**
   * Where the ears are: camera position and yaw (radians, three.js convention: 0 looks down -Z). Call once per frame;
   * it also retires rocket loops that stopped being updated.
   */
  listen(x: number, y: number, z: number, yaw: number) {
    const now = performance.now() / 1000;
    const dt = now - this.lastListen;
    if (dt > 0 && dt < 0.25) {
      // Smoothed, and capped so a respawn teleport does not register as a supersonic dash.
      const k = Math.min(1, dt * 10);
      this.lvx += (cap((x - this.lx) / dt) - this.lvx) * k;
      this.lvy += (cap((y - this.ly) / dt) - this.lvy) * k;
      this.lvz += (cap((z - this.lz) / dt) - this.lvz) * k;
    }
    this.lastListen = now;
    this.lx = x;
    this.ly = y;
    this.lz = z;
    this.fx = -Math.sin(yaw);
    this.fz = -Math.cos(yaw);
    this.rx = Math.cos(yaw);
    this.rz = -Math.sin(yaw);
    this.frame++;
    if (this.loops.size) this.loops.forEach(this.sweep);
  }

  private sweep = (loop: Loop, id: number | string) => {
    if (this.frame - loop.seen > 3) this.rocketEnd(id);
  };

  /** Fills sa (gain), sp (pan), sc (low-pass cutoff), sd (distance) for a source at x, y, z. */
  private spatial(x: number, y: number, z: number, ref: number) {
    const dx = x - this.lx;
    const dy = y - this.ly;
    const dz = z - this.lz;
    const d = Math.hypot(dx, dy, dz);
    const h = Math.hypot(dx, dz);
    this.sd = d;
    // Inverse distance: full inside `ref`, half at twice `ref`, and so on.
    this.sa = d <= ref ? 1 : ref / d;
    if (h < 0.3) {
      this.sp = 0;
      this.sc = OPEN;
      return;
    }
    const side = (dx * this.rx + dz * this.rz) / h;
    const front = (dx * this.fx + dz * this.fz) / h;
    // Sounds right next to you sit nearer the centre, so a point-blank hit is not hard-panned.
    this.sp = side * 0.8 * Math.min(1, h / 3);
    // Far sounds lose their top end; sounds behind you are a little duller, the cue for front versus back.
    this.sc = (OPEN / (1 + d / 10)) * (front < 0 ? 1 + front * 0.4 : 1);
  }

  /** Claims a voice slot for `dur` seconds, or returns false when the budget is full. */
  private claim(now: number, dur: number) {
    const v = this.voices;
    for (let i = 0; i < v.length; i++)
      if (v[i] <= now) {
        v[i] = now + dur;
        return true;
      }
    return false;
  }

  /** The node a positional sound's layers connect to: pan and low-pass in front of the bus, only when needed. */
  private route(ctx: AudioContext, pan: number, cutoff: number): AudioNode {
    let head: AudioNode = this.bus!;
    if (cutoff < 16000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      lp.connect(head);
      head = lp;
    }
    if (Math.abs(pan) > 0.02) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(head);
      head = p;
    }
    return head;
  }

  // ---- layers ---------------------------------------------------------------------------------------------------

  private tone(out: AudioNode, t: number, freq: number, dur: number, type: OscillatorType, gain: number, slide = 1, attack = 0.003) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide !== 1) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Filtered noise from a cached buffer; the filter sweeps from f0 to f1 over the sound. */
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
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(out);
    src.start(t, Math.random() * (buf.duration - 0.05));
    src.stop(t + dur + 0.02);
  }

  // ---- playing --------------------------------------------------------------------------------------------------

  /**
   * Flat, centred sound. `distance` in metres attenuates it; 0 = at the listener. `amount` (0..1) scales the sounds
   * that have a size: hit and hurt (damage / 100), land (fall speed).
   */
  play(name: Sfx, distance = 0, amount = 0.5) {
    const ctx = this.live();
    if (!ctx) return;
    const a = Math.max(0.05, 1 - distance / 40);
    if (distance > 0 && !this.claim(ctx.currentTime, LENGTH[name] ?? 0.35)) return;
    this.emit(ctx, name, this.bus!, a, distance, amount);
  }

  /** Positional sound at a world point, relative to the last `listen()`. */
  playAt(name: Sfx, x: number, y: number, z: number, amount = 0.5) {
    const ctx = this.live();
    if (!ctx) return;
    this.spatial(x, y, z, name === 'boom' ? 7 : 4);
    if (this.sa < 0.03) return;
    if (!this.claim(ctx.currentTime, LENGTH[name] ?? 0.35)) return;
    this.emit(ctx, name, this.route(ctx, this.sp, this.sc), this.sa, this.sd, amount);
  }

  private emit(ctx: AudioContext, name: Sfx, out: AudioNode, a: number, d: number, amount: number) {
    const t = ctx.currentTime + 0.005;
    const r = 0.94 + Math.random() * 0.12; // a little pitch variety so repeats do not machine-gun
    switch (name) {
      case 'fire':
        // A real launch: the backblast crack, a deep chest thump, then the motor's ragged roar tearing away.
        this.noise(out, t, 0.09, 0.7 * a, 'highpass', 1800, 1800, 0.7, this.white, 0.001);
        this.tone(out, t, 95 * r, 0.38, 'sine', 0.95 * a, 0.32);
        this.noise(out, t, 0.32, 0.6 * a, 'lowpass', 1000, 110, 0.8, this.white, 0.002);
        this.noise(out, t + 0.02, 1.1, 0.45 * a, 'lowpass', 3200 * r, 700, 0.6, this.white, 0.04);
        this.noise(out, t + 0.02, 0.9, 0.4 * a, 'bandpass', 520 * r, 300, 0.6, this.crackle, 0.03);
        break;
      case 'boom': {
        // A sharp crack, a sub-bass drop you feel, the roar, debris, a rolling tail and a late echo off the walls.
        // Up close the crack and debris dominate; far off only the low rumble carries, which is how distance reads.
        const near = Math.max(0, 1 - d / 30);
        this.noise(out, t, 0.12, 0.8 * a * (0.3 + near * 0.7), 'highpass', 1200, 1200, 0.7, this.white, 0.001);
        this.tone(out, t, 72 * r, 1.1, 'sine', 1.0 * a, 0.3, 0.004);
        this.tone(out, t, 55 * r, 0.8, 'triangle', 0.45 * a, 0.5);
        this.noise(out, t, 1.8, 0.8 * a, 'lowpass', 3000 * (0.3 + near * 0.7), 80, 0.7, this.white, 0.005);
        if (near > 0) this.noise(out, t + 0.03, 1.1, 0.5 * a * near, 'highpass', 1600, 1600, 0.7, this.crackle, 0.01);
        this.noise(out, t + 0.05, 2.4, (0.3 + 0.2 * (1 - near)) * a, 'lowpass', 220, 40, 1, this.white, 0.25);
        this.noise(out, t + 0.22 + 0.1 * r, 0.9, 0.25 * a, 'lowpass', 900, 100, 0.8, this.white, 0.02);
        break;
      }
      case 'hit': {
        // Hit confirm: a crisp, short, high tick that cuts through explosions. Bigger damage, lower pitch.
        const f = 2400 - 900 * Math.min(1, amount);
        this.tone(out, t, f, 0.05, 'square', 0.16 * a, 1, 0.001);
        this.tone(out, t, f * 1.5, 0.03, 'sine', 0.12 * a, 1, 0.001);
        break;
      }
      case 'kill':
        // Kill confirm: the hit tick, then a bright rising pair that is unmistakably "got one".
        this.tone(out, t, 1500, 0.05, 'square', 0.14 * a, 1, 0.001);
        this.tone(out, t + 0.07, 1047, 0.14, 'triangle', 0.26 * a);
        this.tone(out, t + 0.07, 2094, 0.1, 'sine', 0.08 * a);
        this.tone(out, t + 0.16, 1568, 0.28, 'triangle', 0.26 * a);
        this.tone(out, t + 0.16, 3136, 0.16, 'sine', 0.06 * a);
        break;
      case 'hurt': {
        // A grunt: falling saw through a vowel-ish band, plus a smack. More damage, deeper and louder.
        const k = 0.6 + Math.min(1, amount) * 0.5;
        this.tone(out, t, 260 * r * (1.15 - amount * 0.3), 0.2, 'sawtooth', 0.22 * a * k, 0.55);
        this.noise(out, t, 0.18, 0.3 * a * k, 'bandpass', 900 * r, 500, 2);
        this.noise(out, t, 0.05, 0.25 * a * k, 'lowpass', 1500);
        break;
      }
      case 'jump':
        this.tone(out, t, 280 * r, 0.1, 'triangle', 0.12 * a, 1.5);
        this.noise(out, t, 0.08, 0.06 * a, 'bandpass', 1200, 2400, 1);
        break;
      case 'land': {
        // A boot thud scaled by how hard you came down.
        const k = 0.35 + Math.min(1, amount) * 0.65;
        this.tone(out, t, 110 * r, 0.12, 'sine', 0.45 * a * k, 0.45);
        this.noise(out, t, 0.09, 0.3 * a * k, 'lowpass', 700, 150);
        break;
      }
      case 'pad':
        // Spring "fwoomp": a sweep up with an airy rush.
        this.tone(out, t, 160, 0.4, 'sine', 0.38 * a, 4.5);
        this.tone(out, t, 320, 0.25, 'triangle', 0.1 * a, 3);
        this.noise(out, t, 0.4, 0.2 * a, 'bandpass', 500, 3500, 1.5, this.white, 0.04);
        break;
      case 'pickup':
      case 'health':
        // Warm two-note rise.
        this.tone(out, t, 660, 0.12, 'sine', 0.22 * a);
        this.tone(out, t + 0.08, 990, 0.2, 'sine', 0.22 * a);
        break;
      case 'armor':
        // Metallic: square partials with a clank on top.
        this.noise(out, t, 0.05, 0.15 * a, 'bandpass', 3200, 3200, 6);
        this.tone(out, t, 440, 0.16, 'square', 0.1 * a);
        this.tone(out, t + 0.07, 587, 0.24, 'square', 0.1 * a);
        this.tone(out, t + 0.07, 1174, 0.18, 'sine', 0.08 * a);
        break;
      case 'mega':
        // A big shimmering arpeggio: it should feel like a prize.
        [523, 659, 784, 1047, 1319].forEach((f, i) => {
          this.tone(out, t + i * 0.055, f, 0.35, 'triangle', 0.18 * a);
          this.tone(out, t + i * 0.055, f * 2, 0.2, 'sine', 0.05 * a);
        });
        break;
      case 'spawn':
        this.tone(out, t, 440, 0.2, 'triangle', 0.15 * a, 1.5);
        break;
      case 'die':
        this.tone(out, t, 200, 0.5, 'sawtooth', 0.3 * a, 0.25);
        this.noise(out, t, 0.3, 0.2 * a, 'lowpass', 1200, 200);
        break;
      case 'coin':
        this.tone(out, t, 1320, 0.07, 'square', 0.12 * a);
        this.tone(out, t + 0.06, 1760, 0.14, 'square', 0.12 * a);
        break;
      case 'dash':
        this.noise(out, t, 0.18, 0.3 * a, 'lowpass', 2500, 100);
        break;
      case 'tick':
        this.tone(out, t, 880, 0.06, 'square', 0.12);
        break;
      case 'go':
        this.tone(out, t, 660, 0.12, 'square', 0.2);
        this.tone(out, t + 0.12, 880, 0.25, 'square', 0.2);
        break;
      case 'out':
        this.tone(out, t, 330, 0.25, 'sawtooth', 0.25 * a, 0.5);
        this.tone(out, t + 0.2, 165, 0.4, 'sawtooth', 0.2 * a, 0.5);
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(out, t + i * 0.12, f, 0.3, 'triangle', 0.2));
        break;
      case 'pass':
        this.tone(out, t, 500, 0.08, 'square', 0.15 * a, 1.5);
        break;
      case 'crack':
        this.noise(out, t, 0.12, 0.25 * a, 'lowpass', 3000, 100);
        break;
    }
  }

  // ---- rocket flight loops ----------------------------------------------------------------------------------------

  /**
   * Keeps the flight hiss of rocket `id` at this position and velocity. Call every frame while it flies; it pans,
   * fades with distance and dopplers (pitch up coming at you, down going away). Stops by itself a few frames after
   * the calls stop, or at once with `rocketEnd`.
   */
  rocket(id: number | string, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const ctx = this.live();
    if (!ctx) return;
    let loop = this.loops.get(id);
    if (!loop) {
      if (this.loops.size >= MAX_LOOPS) return;
      loop = this.startLoop(ctx);
      this.loops.set(id, loop);
    }
    loop.seen = this.frame;
    this.spatial(x, y, z, 3);
    // Radial speed away from the listener, of the rocket relative to the listener.
    const d = this.sd || 1;
    const vr = ((vx - this.lvx) * (x - this.lx) + (vy - this.lvy) * (y - this.ly) + (vz - this.lvz) * (z - this.lz)) / d;
    const dop = Math.min(1.6, Math.max(0.6, SOUND_SPEED / (SOUND_SPEED + vr)));
    const t = ctx.currentTime;
    loop.src.playbackRate.setTargetAtTime(dop, t, 0.04);
    loop.band.frequency.setTargetAtTime(800 * dop, t, 0.04);
    loop.osc.frequency.setTargetAtTime(52 * dop, t, 0.04);
    loop.lp.frequency.setTargetAtTime(this.sc, t, 0.04);
    loop.pan.pan.setTargetAtTime(this.sp, t, 0.04);
    loop.gain.gain.setTargetAtTime(this.sa < 0.03 ? 0 : 0.4 * this.sa, t, 0.04);
  }

  /** Stops a rocket's flight loop (it exploded or was removed). */
  rocketEnd(id: number | string) {
    const loop = this.loops.get(id);
    if (!loop) return;
    this.loops.delete(id);
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    loop.gain.gain.cancelScheduledValues(t);
    loop.gain.gain.setTargetAtTime(0, t, 0.03);
    loop.src.stop(t + 0.2);
    loop.osc.stop(t + 0.2);
  }

  private startLoop(ctx: AudioContext): Loop {
    const src = ctx.createBufferSource();
    src.buffer = this.white!;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    // A broad, low roar rather than a whistle: a real motor is mostly rushing air.
    band.frequency.value = 800;
    band.Q.value = 0.5;
    // A deep motor rumble under the roar, so the rocket has weight as well as a rush.
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 52;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.35;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = OPEN;
    const pan = ctx.createStereoPanner();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(band).connect(lp);
    osc.connect(oscGain).connect(lp);
    lp.connect(pan).connect(gain).connect(this.bus!);
    src.start(ctx.currentTime, Math.random() * (this.white!.duration - 0.05));
    osc.start();
    return { src, osc, band, lp, pan, gain, seen: this.frame };
  }

  // ---- heartbeat --------------------------------------------------------------------------------------------------

  /** Low-health heartbeat. Call every frame with current and maximum health; it beats below 30%, faster when lower. */
  heartbeat(hp: number, max: number) {
    const low = hp / max;
    if (hp <= 0 || low >= 0.3) return;
    const ctx = this.live();
    if (!ctx || ctx.currentTime < this.nextBeat) return;
    const t = ctx.currentTime + 0.01;
    const k = 1 - low / 0.3; // 0 at 30%, 1 at death's door
    this.nextBeat = t + 1.0 - 0.45 * k;
    const g = 0.35 + 0.3 * k;
    // Lub-dub, with triangle overtones so laptop speakers can carry it.
    this.tone(this.bus!, t, 95, 0.13, 'triangle', g, 0.55, 0.01);
    this.tone(this.bus!, t + 0.17, 80, 0.15, 'triangle', g * 0.7, 0.55, 0.01);
  }
}

export interface VolumeState {
  volume: number;
  muted: boolean;
}

const VOLUME_KEY = 'play.volume.v1';

/** The saved setting; before it existed, Rockets kept the volume in its own settings, so that is the fallback. */
function loadVolume(): VolumeState {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw) {
      const r = JSON.parse(raw) as Partial<VolumeState>;
      return { volume: num(r.volume) ?? 0.5, muted: r.muted === true };
    }
    const old = localStorage.getItem('rockets.settings.v1');
    if (old) return { volume: num((JSON.parse(old) as { volume?: unknown }).volume) ?? 0.5, muted: false };
  } catch {
    // Blocked storage or a malformed value: fall through to the default.
  }
  return { volume: 0.5, muted: false };
}

const cap = (v: number) => Math.max(-40, Math.min(40, v));

/** Two seconds of white noise, made once. */
function makeWhite(ctx: AudioContext) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** Sparse random clicks of random size: debris crackle when high-passed. Made once. */
function makeCrackle(ctx: AudioContext) {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    if (Math.random() < 0.004) {
      const amp = (Math.random() * 2 - 1) * (0.4 + Math.random() * 0.6);
      const len = 8 + Math.floor(Math.random() * 40);
      for (let j = 0; j < len && i + j < data.length; j++) data[i + j] += amp * (1 - j / len) * (Math.random() * 2 - 1);
      i += len;
    }
  }
  return buf;
}

export const sfx = new Audio();
