// Dev lab for garden/audio.ts at /lab-garden-audio.html: a button per sound (and positional variants), a stress
// button, intensity / beams / zoom sliders, and an offline measurement (button or ?measure=1) that renders every
// sound, a stress burst, the music at each intensity and the ambience, printing peak and RMS. Results go to the
// console as `MEASURE {...}` lines and to `window.__gaudioLevels`; `window.__gaudioDone` is set when finished.

import { ENEMY_KINDS, type EnemyKind } from '@shared/garden/enemies';
import type { GAudio, GSound, P3 } from '../api';
import { createGAudio, primeGAudio } from '../audio';

const SOUNDS: GSound[] = ['laser', 'missile', 'boom', 'zap', 'disrupt', 'blocked', 'die', 'dieBig', 'leak', 'build', 'upgrade', 'sell', 'deny', 'click', 'hover', 'coin', 'waveStart', 'bossWave', 'waveClear', 'send', 'incoming', 'out', 'ping', 'victory', 'defeat', 'splash', 'heal', 'sun', 'moth'];
const SR = 48000;

const live = createGAudio();
let zoom = 0.3;
const target: P3 = { x: 0, y: 0, z: 0 };
live.listen(target, zoom);

const buttons = document.getElementById('buttons')!;
const add = (label: string, fn: () => void, cls = '') => {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.onclick = () => {
    live.unlock();
    fn();
  };
  buttons.appendChild(b);
};
const br = () => buttons.appendChild(document.createElement('br'));

for (const s of SOUNDS) add(s, () => live.play(s, { amount: s === 'upgrade' ? 3 : s === 'sell' ? 120 : 0.7 }));
br();
for (const k of ENEMY_KINDS) add(`die ${k}`, () => live.play(k === 'brute' || k === 'colossus' ? 'dieBig' : 'die', { kind: k }));
add('build sprinkler', () => live.play('build', { kind: 'sprinkler' }));
add('splash x6 (rate limit)', () => {
  for (let i = 0; i < 6; i++) setTimeout(() => live.play('splash', { at: { x: rnd(-6, 6), y: 0, z: rnd(-4, 4) } }), i * 40);
});
add('moth x4 (rate limit)', () => {
  for (let i = 0; i < 4; i++) setTimeout(() => live.play('moth', { at: { x: rnd(-6, 6), y: 2.4, z: 0 } }), i * 150);
});
for (const a of [0.2, 0.6, 1.2]) add(`boom size ${a}`, () => live.play('boom', { amount: a }));
br();
add('laser far left', () => live.play('laser', { at: { x: -14, y: 1, z: 0 } }));
add('laser far right', () => live.play('laser', { at: { x: 14, y: 1, z: 0 } }));
add('die other board (60 m)', () => live.play('die', { at: { x: 60, y: 0, z: 0 }, kind: 'runner' }));
add('leak other board (60 m)', () => live.play('leak', { at: { x: 60, y: 0, z: 0 } }));
br();
add(
  'STRESS: 100 deaths + 30 lasers',
  () => {
    live.setBeams(30);
    for (let i = 0; i < 100; i++)
      setTimeout(() => live.play('die', { at: { x: rnd(-15, 15), y: 0, z: rnd(-10, 10) }, kind: ENEMY_KINDS[i % 5] as EnemyKind }), Math.random() * 1000);
    for (let i = 0; i < 30; i++) setTimeout(() => live.play('laser', { at: { x: rnd(-15, 15), y: 1, z: rnd(-10, 10) } }), Math.random() * 1000);
    for (let i = 0; i < 10; i++) setTimeout(() => live.play('boom', { at: { x: rnd(-15, 15), y: 0, z: rnd(-10, 10) }, amount: 0.8 }), Math.random() * 1000);
    setTimeout(() => live.setBeams(Number(beams.value)), 1600);
  },
  'big',
);
add('Measure (offline)', () => void measure(), 'big');

const slider = (id: string, out: string, fn: (v: number) => void) => {
  const el = document.getElementById(id) as HTMLInputElement;
  const span = document.getElementById(out)!;
  el.oninput = () => {
    live.unlock();
    span.textContent = el.value;
    fn(Number(el.value));
  };
  return el;
};
slider('intensity', 'iv', (v) => live.setIntensity(v));
const beams = slider('beams', 'bv', (v) => live.setBeams(v));
slider('zoom', 'zv', (v) => {
  zoom = v;
  live.listen(target, zoom);
});

function rnd(lo: number, hi: number) {
  return lo + Math.random() * (hi - lo);
}

// ---- offline measurement ---------------------------------------------------------------------------------------------

interface Level {
  name: string;
  peak: number;
  rms: number;
  len: number;
}

const dB = (x: number) => (x > 0 ? 20 * Math.log10(x) : -200);

/** Peak over everything; RMS over the active part (50 ms windows within 40 dB of the loudest one), or from `from` s on. */
function analyse(name: string, buf: AudioBuffer, from?: number): Level {
  const n = buf.length;
  const win = Math.floor(buf.sampleRate * 0.05);
  const start = from !== undefined ? Math.floor(from * buf.sampleRate) : 0;
  let peak = 0;
  const wins: number[] = [];
  for (let i = start; i < n; i += win) {
    let sum = 0;
    let cnt = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let j = i; j < Math.min(n, i + win); j++) {
        const x = d[j];
        if (Math.abs(x) > peak) peak = Math.abs(x);
        sum += x * x;
        cnt++;
      }
    }
    wins.push(sum / Math.max(1, cnt));
  }
  const loud = Math.max(...wins);
  const keep = from !== undefined ? wins : wins.filter((w) => w > loud * 1e-4);
  const rms = Math.sqrt(keep.reduce((a, b) => a + b, 0) / Math.max(1, keep.length));
  return { name, peak: dB(peak), rms: dB(rms), len: (keep.length * win) / buf.sampleRate };
}

async function render(secs: number, fn: (a: GAudio, ctx: OfflineAudioContext) => void) {
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
  const a = createGAudio(ctx);
  a.listen({ x: 0, y: 0, z: 0 }, 0);
  fn(a, ctx);
  const buf = await ctx.startRendering();
  a.dispose();
  return buf;
}

const results: Level[] = [];
const tbody = document.querySelector('#levels tbody')!;
function report(l: Level) {
  results.push(l);
  console.log('MEASURE ' + JSON.stringify({ name: l.name, peak: +l.peak.toFixed(2), rms: +l.rms.toFixed(2), len: +l.len.toFixed(2) }));
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${l.name}</td><td class="${l.peak > -1 ? 'bad' : ''}">${l.peak.toFixed(1)}</td><td>${l.rms.toFixed(1)}</td><td>${l.len.toFixed(2)}</td>`;
  tbody.appendChild(tr);
}

async function measure() {
  tbody.innerHTML = '';
  results.length = 0;
  for (const s of SOUNDS) {
    const long = s === 'victory' || s === 'defeat' || s === 'bossWave' || s === 'sun';
    const buf = await render(long ? 4.5 : 2.5, (a) => a.play(s, { amount: s === 'upgrade' ? 3 : s === 'sell' ? 120 : 0.7 }));
    report(analyse(s, buf));
  }
  for (const k of ENEMY_KINDS) {
    const big = k === 'brute' || k === 'colossus';
    report(analyse(`${big ? 'dieBig' : 'die'} ${k}`, await render(2.5, (a) => a.play(big ? 'dieBig' : 'die', { kind: k }))));
  }
  for (const amt of [0.2, 1.5, 4]) report(analyse(`boom amount ${amt}`, await render(2.5, (a) => a.play('boom', { amount: amt }))));
  report(analyse('laser hum, 1 beam', await render(3, (a) => a.setBeams(1)), 1.5));
  report(analyse('laser hum, 30 beams', await render(3, (a) => a.setBeams(30)), 1.5));
  report(analyse('build sprinkler', await render(2.5, (a) => a.play('build', { kind: 'sprinkler' }))));
  report(analyse('sun at 60 m (other board)', await render(3, (a) => a.play('sun', { at: { x: 60, y: 0, z: 0 } }))));
  report(analyse('die at 60 m (other board)', await render(2.5, (a) => a.play('die', { at: { x: 60, y: 0, z: 0 } }))));

  // Stress: 100 deaths, 30 lasers and 10 booms scattered over a second, 30 beams humming, with music at intensity 1.
  const stressBuf = await render(3, (a, ctx) => {
    a.setIntensity(1);
    a.setBeams(30);
    primeGAudio(a, 3, { music: true, ambience: true });
    const events: [number, () => void][] = [];
    for (let i = 0; i < 100; i++) events.push([Math.random(), () => a.play('die', { at: { x: rnd(-15, 15), y: 0, z: rnd(-10, 10) }, kind: ENEMY_KINDS[i % 5] })]);
    for (let i = 0; i < 30; i++) events.push([Math.random(), () => a.play('laser', { at: { x: rnd(-15, 15), y: 1, z: rnd(-10, 10) } })]);
    for (let i = 0; i < 10; i++) events.push([Math.random(), () => a.play('boom', { at: { x: rnd(-15, 15), y: 0, z: rnd(-10, 10) }, amount: 0.8 })]);
    // Offline contexts can only suspend on render-quantum boundaries; group the events into 128-frame slots.
    const slots = new Map<number, (() => void)[]>();
    for (const [t, fn] of events) {
      const q = Math.max(1, Math.round((t * SR) / 128));
      let list = slots.get(q);
      if (!list) slots.set(q, (list = []));
      list.push(fn);
    }
    for (const [q, list] of slots)
      void ctx.suspend((q * 128) / SR).then(() => {
        for (const fn of list) fn();
        void ctx.resume();
      });
  });
  report(analyse('STRESS 100 die + 30 laser + 10 boom', stressBuf));

  for (const x of [0, 1, 2]) {
    const buf = await render(26, (a) => {
      a.setIntensity(x);
      primeGAudio(a, 26, { music: true });
    });
    report(analyse(`music intensity ${x}`, buf, 4));
  }
  report(analyse('ambience', await render(14, (a) => primeGAudio(a, 14, { ambience: true })), 2));

  (window as unknown as { __gaudioLevels: Level[]; __gaudioDone: boolean }).__gaudioLevels = results;
  (window as unknown as { __gaudioDone: boolean }).__gaudioDone = true;
  console.log('MEASURE_DONE');
}

if (new URLSearchParams(location.search).has('measure')) void measure();
