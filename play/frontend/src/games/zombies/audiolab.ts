// Dev lab for audio.ts at /lab-zombies-audio.html: a button per sound, and an offline render of each one with its
// peak, RMS and timbre (spectral centroid, attack, decay to -40 dB), so levels and voices can be checked without
// listening. `window.__zaudioLevels` holds the results; `window.__zaudioWav(label)` renders one job to a base64 WAV.

import type { Vec3 } from '@shared/math';
import { IMPACT_MATS, type ImpactMat } from '@shared/zombies/protocol';
import { WEAPON_IDS, WEAPONS, type WeaponId, type WeaponKind } from '@shared/zombies/weapons';
import type { ZAudio, ZSound } from './api';
import { type Surface, configureZAudio, createZAudio, playMatAt } from './audio';

const SOUNDS: ZSound[] = ['empty', 'reloadOut', 'reloadIn', 'pump', 'bolt', 'flesh', 'headshot', 'scream', 'swipe', 'tear', 'hammer', 'boom', 'buy', 'deny', 'hurt', 'down', 'revive', 'knife', 'throw', 'clink', 'waveStart', 'waveEnd', 'gameOver', 'points'];
const KINDS: WeaponKind[] = ['pistol', 'smg', 'rifle', 'shotgun', 'sniper', 'lmg'];
const SURFACES: Surface[] = ['concrete', 'wood', 'tile', 'mud', 'metal'];
const MATS = IMPACT_MATS.filter((m) => m !== 'none' && m !== 'flesh') as ImpactMat[];
const AT = { x: 0, y: 1.2, z: -2.5 };
const VOICES = ['moan', 'gurgle', 'choke', 'breath'];
const AMBIENT = ['moan', 'creak', 'metal', 'knock', 'rats', 'drip', 'bell', 'siren'] as const;
const ROOM = { floor: 'concrete' as const, interior: { minX: -12, maxX: 12, minZ: -15, maxZ: 15 } };

type Ambient = { ambient(kind: (typeof AMBIENT)[number], t?: number): void };
type Extra = { surface?: Surface; variant?: number; id?: number };

const live = createZAudio();
configureZAudio(live, ROOM);
live.listen({ x: 0, y: 1.6, z: 0 }, 0, 0);
const buttons = document.getElementById('buttons')!;
const add = (label: string, fn: () => void) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => (live.unlock(), fn());
  buttons.appendChild(b);
};
const playX = (a: ZAudio, name: ZSound, opts: Record<string, unknown>, pos?: Vec3) => (pos ? a.playAt(name, pos, opts) : a.play(name, opts));
for (const w of WEAPON_IDS) add(`shot ${w}`, () => live.play('shot', { kind: WEAPONS[w].kind, weapon: w }));
for (const s of SOUNDS) add(s, () => live.play(s, { amount: 0.8 }));
for (const v of VOICES) add(`groan ${v}`, () => playX(live, 'groan', { variant: VOICES.indexOf(v), id: Math.floor(Math.random() * 1e6) } as Extra, { x: -4, y: 1.5, z: -3 }));
add('crowd of 12 groans', () => {
  for (let i = 0; i < 12; i++) live.playAt('groan', { x: Math.random() * 16 - 8, y: 1.5, z: -4 - Math.random() * 8 }, { id: 1000 + i });
});
for (const s of SURFACES) add(`step ${s}`, () => playX(live, 'step', { surface: s, amount: 0.6 } as Extra));
for (const a of [0.3, 1, 1.5]) add(`impact size ${a}`, () => live.play('impact', { amount: a }));
for (const a of [0.1, 0.5, 1]) add(`crumble ${a}`, () => live.play('crumble', { amount: a }));
for (const m of MATS) add(`impact ${m}`, () => playMatAt(live, 'impact', AT, m));
for (const m of MATS) add(`break ${m}`, () => playMatAt(live, 'crumble', AT, m, 0.4));
add('shotgun x12 into brick', () => {
  for (let i = 0; i < 12; i++) playMatAt(live, 'impact', { x: AT.x + Math.random() - 0.5, y: AT.y, z: AT.z }, 'brick');
});
for (const k of AMBIENT) add(`ambient ${k}`, () => (live as unknown as Ambient).ambient(k));
add('shot far right (indoor)', () => live.playAt('shot', { x: 10, y: 1.5, z: -5 }, { kind: 'rifle', weapon: 'm4a1' }));
add('shot outside, heard inside', () => live.playAt('shot', { x: 20, y: 1.5, z: -5 }, { kind: 'rifle', weapon: 'm4a1' }));
add('tension 1', () => live.setTension(1));
add('tension 0', () => live.setTension(0));
add('hurt 0.9', () => live.setHurt(0.9, false));
add('heal', () => live.setHurt(0, false));
setInterval(() => live.listen({ x: 0, y: 1.6, z: 0 }, 0, 0), 50);

interface Level {
  peak: number;
  rms: number;
  ms: number;
  /** Energy-weighted spectral centroid, Hz. */
  centroid: number;
  /** Seconds from start to the envelope peak. */
  attack: number;
  /** Seconds from the peak until the envelope stays below -40 dB of it. */
  decay: number;
}

/** In-place radix-2 FFT on re/im. */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2];
        const ai = im[i + k + len / 2];
        const xr = ar * wr - ai * wi;
        const xi = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k] - xr;
        im[i + k + len / 2] = im[i + k] - xi;
        re[i + k] += xr;
        im[i + k] += xi;
      }
  }
}

function analyse(buf: AudioBuffer): Omit<Level, 'ms'> {
  const sr = buf.sampleRate;
  const n = buf.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
  }
  let peak = 0;
  let sum = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const x = Math.abs(d[i]);
      if (x > peak) peak = x;
      sum += x * x;
    }
  }
  // Envelope in 5 ms windows.
  const win = Math.floor(sr * 0.005);
  const envl: number[] = [];
  for (let i = 0; i < n; i += win) {
    let m = 0;
    for (let j = i; j < Math.min(n, i + win); j++) m = Math.max(m, Math.abs(mono[j]));
    envl.push(m);
  }
  let pk = 0;
  for (let i = 1; i < envl.length; i++) if (envl[i] > envl[pk]) pk = i;
  const floor = envl[pk] * 0.01;
  let last = pk;
  for (let i = pk; i < envl.length; i++) if (envl[i] > floor) last = i;
  // Spectral centroid over 2048-sample frames, weighted by frame energy.
  const N = 2048;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  let num = 0;
  let den = 0;
  for (let s = 0; s + N <= n; s += N) {
    for (let i = 0; i < N; i++) {
      re[i] = mono[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      num += p * ((k * sr) / N);
      den += p;
    }
  }
  return { peak, rms: Math.sqrt(sum / (n * buf.numberOfChannels)), centroid: den > 0 ? num / den : 0, attack: (pk * win) / sr, decay: ((last - pk) * win) / sr };
}

async function render(play: (a: ZAudio) => void, seconds: number) {
  const ctx = new OfflineAudioContext(2, 44100 * seconds, 44100);
  const a = createZAudio(ctx);
  configureZAudio(a, ROOM);
  a.listen({ x: 0, y: 1.6, z: 0 }, 0, 0);
  play(a);
  return ctx.startRendering();
}

async function level(play: (a: ZAudio) => void, seconds = 4): Promise<Level> {
  const t0 = performance.now();
  const buf = await render(play, seconds);
  return { ...analyse(buf), ms: performance.now() - t0 };
}

/** 16-bit stereo WAV, base64. */
function wav(buf: AudioBuffer) {
  const n = buf.length;
  const v = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, buf.sampleRate, true);
  v.setUint32(28, buf.sampleRate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 4, true);
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i])) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i])) * 32767, true);
  }
  let bin = '';
  const u = new Uint8Array(v.buffer);
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
}

(async () => {
  const body = document.querySelector('#levels tbody')!;
  const out: Record<string, Level> = {};
  const jobs: [string, (a: ZAudio) => void, number?][] = [
    ['(silence)', () => undefined],
    ...WEAPON_IDS.map((w: WeaponId) => [`shot ${w}`, (a: ZAudio) => a.play('shot', { kind: WEAPONS[w].kind, weapon: w })] as [string, (a: ZAudio) => void]),
    ...KINDS.map((k) => [`shot class ${k}`, (a: ZAudio) => a.play('shot', { kind: k })] as [string, (a: ZAudio) => void]),
    ['shot m4a1 at 10 m indoor', (a) => a.playAt('shot', { x: 10, y: 1.5, z: 0 }, { kind: 'rifle', weapon: 'm4a1' })],
    ['shot m4a1 outside 20 m', (a) => a.playAt('shot', { x: 20, y: 1.5, z: 0 }, { kind: 'rifle', weapon: 'm4a1' })],
    ...SOUNDS.map((s) => [s, (a: ZAudio) => a.play(s, { amount: 0.8 })] as [string, (a: ZAudio) => void]),
    ...VOICES.map((v, i) => [`groan ${v}`, (a: ZAudio) => playX(a, 'groan', { variant: i, id: 7 + i, amount: 0.8 } as Extra, { x: 2, y: 1.5, z: -2 })] as [string, (a: ZAudio) => void]),
    ['groan crowd x12', (a) => {
      for (let i = 0; i < 12; i++) a.playAt('groan', { x: (i % 4) * 3 - 4, y: 1.5, z: -3 - Math.floor(i / 4) * 2 }, { id: 100 + i });
    }],
    ...SURFACES.map((s) => [`step ${s}`, (a: ZAudio) => playX(a, 'step', { surface: s, amount: 0.6 } as Extra)] as [string, (a: ZAudio) => void]),
    ...[0.3, 1, 1.5].map((x) => [`impact ${x}`, (a: ZAudio) => a.play('impact', { amount: x })] as [string, (a: ZAudio) => void]),
    ...[0.1, 0.5, 1].map((x) => [`crumble ${x}`, (a: ZAudio) => a.play('crumble', { amount: x })] as [string, (a: ZAudio) => void]),
    ['impact generic 0.5 at 2.5 m', (a) => a.playAt('impact', AT, { amount: 0.5 }), 2],
    ['crumble generic 0.4 at 2.5 m', (a) => a.playAt('crumble', AT, { amount: 0.4 }), 3],
    ...MATS.map((m) => [`impact ${m}`, (a: ZAudio) => playMatAt(a, 'impact', AT, m), 2] as [string, (a: ZAudio) => void, number]),
    ...MATS.map((m) => [`break ${m}`, (a: ZAudio) => playMatAt(a, 'crumble', AT, m, 0.4), 3] as [string, (a: ZAudio) => void, number]),
    ['impact brick x12 (shotgun, capped)', (a) => {
      for (let i = 0; i < 12; i++) playMatAt(a, 'impact', { x: AT.x + (i % 4) * 0.2 - 0.3, y: AT.y, z: AT.z }, 'brick');
    }, 2],
    ...AMBIENT.map((k) => [`ambient ${k}`, (a: ZAudio) => (a as unknown as Ambient).ambient(k, 0), k === 'bell' || k === 'siren' ? 12 : 4] as [string, (a: ZAudio) => void, number]),
  ];
  (window as unknown as { __zaudioWav: (label: string) => Promise<string | null> }).__zaudioWav = async (label) => {
    const job = jobs.find((j) => j[0] === label);
    return job ? wav(await render(job[1], job[2] ?? 4)) : null;
  };
  for (const [label, fn, secs] of jobs) {
    const r = await level(fn, secs ?? 4);
    out[label] = r;
    const tr = document.createElement('tr');
    const bad = r.peak > 0.99 || (r.peak < 0.005 && label !== '(silence)');
    tr.innerHTML = `<td>${label}</td><td class="${bad ? 'bad' : ''}">${r.peak.toFixed(3)}</td><td>${r.rms.toFixed(4)}</td><td>${r.centroid.toFixed(0)}</td><td>${(r.attack * 1000).toFixed(0)}</td><td>${r.decay.toFixed(2)}</td><td>${r.ms.toFixed(0)}</td>`;
    body.appendChild(tr);
  }
  (window as unknown as { __zaudioLevels: typeof out }).__zaudioLevels = out;
})();
