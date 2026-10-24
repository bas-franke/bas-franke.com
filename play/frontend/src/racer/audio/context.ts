// The racer's one AudioContext, shared by the race soundscape and the menus, plus the noise buffers every voice
// replays. Browsers cap how many contexts a page may open, so races reuse this one and never close it; a race only
// tears down its own nodes. The context is created only once the page has had a user gesture (no autoplay warnings)
// and is resumed on the next gesture if the browser suspended it.

let shared: AudioContext | null = null;
let failed = false;
let waiting = false;
const ready: ((ctx: AudioContext) => void)[] = [];
const buffers = new WeakMap<BaseAudioContext, NoiseBank>();

export interface NoiseBank {
  /** 2 s of white noise, for looping beds (start each source at a random offset so layers do not phase). */
  white: AudioBuffer;
  /** 2 s of brown-ish noise (integrated white), a deep rumble. */
  brown: AudioBuffer;
  /** 1 s of sparse random clicks, for exhaust crackle and grit. */
  crackle: AudioBuffer;
}

function activated() {
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return ua ? ua.hasBeenActive : false;
}

function create(): AudioContext | null {
  if (shared || failed) return shared;
  try {
    shared = new AudioContext({ latencyHint: 'interactive' });
  } catch {
    failed = true;
    return null;
  }
  for (const cb of ready.splice(0)) cb(shared);
  return shared;
}

function onGesture() {
  const ctx = create();
  if (ctx && ctx.state === 'suspended') void ctx.resume();
}

function listen() {
  if (waiting) return;
  waiting = true;
  // Stays registered: a context the OS interrupted (phone call, tab switch on iOS) needs another gesture to resume.
  for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(ev, onGesture, { capture: true, passive: true });
}

/**
 * Calls `cb` with the shared context as soon as it may exist: right away when the page already had a gesture,
 * otherwise on the first one. Returns a cancel function.
 */
export function withAudioContext(cb: (ctx: AudioContext) => void): () => void {
  listen();
  if (shared) {
    if (shared.state === 'suspended') void shared.resume();
    cb(shared);
    return () => {};
  }
  if (activated()) {
    const ctx = create();
    if (ctx) {
      if (ctx.state === 'suspended') void ctx.resume();
      cb(ctx);
    }
    return () => {};
  }
  ready.push(cb);
  return () => {
    const i = ready.indexOf(cb);
    if (i >= 0) ready.splice(i, 1);
  };
}

/** The shared context if it already exists. */
export function currentAudioContext(): AudioContext | null {
  return shared;
}

/** Noise buffers for a context, made once per context. */
export function noise(ctx: BaseAudioContext): NoiseBank {
  let bank = buffers.get(ctx);
  if (bank) return bank;
  const sr = ctx.sampleRate;
  const white = ctx.createBuffer(1, sr * 2, sr);
  const brown = ctx.createBuffer(1, sr * 2, sr);
  const crackle = ctx.createBuffer(1, sr, sr);
  const w = white.getChannelData(0);
  const b = brown.getChannelData(0);
  const c = crackle.getChannelData(0);
  let last = 0;
  for (let i = 0; i < w.length; i++) {
    w[i] = Math.random() * 2 - 1;
    last = (last + 0.02 * w[i]) / 1.02;
    b[i] = last * 3.5;
  }
  // Brown noise drifts: remove the DC so loops do not thump at the seam.
  let mean = 0;
  for (let i = 0; i < b.length; i++) mean += b[i];
  mean /= b.length;
  for (let i = 0; i < b.length; i++) b[i] -= mean;
  // Clicks: decaying single-sample pops of random sign and size, ~300 a second.
  for (let i = 0; i < c.length; i++) {
    if (Math.random() < 300 / sr) {
      const a = (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.7);
      const len = 20 + Math.floor(Math.random() * 120);
      for (let k = 0; k < len && i + k < c.length; k++) c[i + k] += a * Math.exp(-k / (len * 0.25)) * (Math.random() * 2 - 1);
    }
  }
  bank = { white, brown, crackle };
  buffers.set(ctx, bank);
  return bank;
}

/** A looping noise source started at a random offset. */
export function loopNoise(ctx: BaseAudioContext, buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = rate;
  src.start(ctx.currentTime, Math.random() * (buf.duration - 0.1));
  return src;
}

/** Soft-clip curve for engine snarl; `k` is the drive. */
export function driveCurve(k: number, n = 1024): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}

/** Smoothly moves an AudioParam towards a value (no zipper noise). */
export function glide(p: AudioParam, v: number, t: number, tau = 0.05) {
  p.setTargetAtTime(v, t, tau);
}
