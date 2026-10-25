// HUD lab (/race/lab/hud): the race HUD over a flat desert backdrop, driven by a fake view with scripted state, so
// every HUD state can be screenshotted without a race. ?state=race|countdown|flash|final|finish|pause|wrongway|intro,
// ?touch for the phone controls.

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore } from '../../games/types';
import type { HudState, RaceView } from '../RaceView';
import { Hud } from '../ui/Hud';
import '../ui/racer.css';

export function mount(el: HTMLElement) {
  const q = new URLSearchParams(location.search);
  const state = q.get('state') ?? 'race';
  el.style.background = 'linear-gradient(180deg, #4d8fd6 0%, #b9dcef 32%, #e0905a 36%, #c8693a 60%, #d99a63 100%)';
  // A loop-ish outline for the minimap.
  const outline: [number, number][] = [];
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    outline.push([0.5 + 0.38 * Math.cos(a) + 0.08 * Math.cos(3 * a), 0.5 + 0.42 * Math.sin(a) - 0.1 * Math.sin(2 * a)]);
  }
  const colors = ['#ff8a2a', '#a040ff', '#ffc020', '#20c8b0', '#e83040', '#4080ff', '#ffffff', '#80e040'];
  const names = ['Bas', 'Vexa Moor', 'Sol Garrin', 'Teel Okk', 'Rook Darrow', 'Ilo Venn', 'Kass Brin', 'Mox Pell'];
  const hud = createStore<HudState>({
    phase: state === 'finish' ? 'finished' : state === 'countdown' ? 'countdown' : state === 'intro' ? 'intro' : 'racing',
    trackName: 'Redrock Run',
    countdown: state === 'countdown' ? 3 : -1,
    toGo: 2400,
    position: 5,
    racers: 8,
    time: 84.306,
    speedKmh: 748,
    speed01: 0.78,
    boost: 0.8,
    boosting: q.has('boosting'),
    drafting: q.has('drafting'),
    outline,
    pods: [],
    standings: names.map((name, i) => ({ name, color: colors[i], player: i === 4, finished: false })),
    wrongWay: state === 'wrongway',
    paused: state === 'pause',
  });
  const touch = { steer: 0, throttle: 0, brake: 0, boost: false, active: false };
  const view = { hud, touch, setPaused: (p: boolean) => hud.set({ paused: p }) } as unknown as RaceView;
  let t = 0;
  let n = 3;
  const timer = setInterval(() => {
    t += 0.05;
    const s = hud.get();
    const pods = colors.map((color, i) => {
      const u = (((t * 0.03 + i * 0.013) % 1) + 1) % 1;
      const p = outline[Math.floor(u * outline.length)];
      return { x: p[0], y: p[1], color, player: i === 0 };
    });
    const patch: Partial<HudState> = { pods };
    if (!q.has('still')) {
      patch.time = s.time + 0.05;
      patch.speedKmh = Math.round(700 + Math.sin(t) * 120);
      patch.speed01 = patch.speedKmh / 960;
    }
    if (state === 'countdown' && t > 1) {
      t = 0;
      n = n <= 0 ? 3 : n - 1;
      patch.countdown = n;
    }
    hud.set(patch);
  }, 50);
  const root = createRoot(el);
  root.render(createElement(Hud, { view, onQuit: () => undefined, onRestart: () => undefined }));
  return () => {
    clearInterval(timer);
    root.unmount();
  };
}
