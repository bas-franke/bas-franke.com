// Dev only: the Garden Sentinels HUD over a garden-coloured backdrop with a fake store and actions.
// /lab-garden-hud.html            co-op, build phase
//   ?mode=vs                      versus (boards strip, sends, income)
//   &sel=1 | &sel=3               a selected tower (level 1 / level 3 with badges)
//   &end=1 | &end=0               end screen (victory / defeat; versus: you win / someone else wins)
//   &phase=wave                   wave phase (enemies left, progress)
//   &place=laser                  placing a tower
//   &scores=1  &menu=1  &boss=1  &poor=1  &view=2 (versus: watching another board)  &loading=1  &live=1 (ticking)
import { createRoot } from 'react-dom/client';
import type { RoomView } from '@shared/protocol';
import { G } from '@shared/garden/constants';
import type { EnemyKind } from '@shared/garden/enemies';
import type { GScore } from '@shared/garden/protocol';
import { TOWERS, spentUpTo, type Level, type TowerKind } from '@shared/garden/towers';
import { createStore, type ClientContext } from '../../types';
import type { GardenActions, GHudState, HudBoard, HudPlayer, Toast } from '../api';
import { GardenHud } from '../Hud';
import '../../../styles.css';

const q = new URLSearchParams(location.search);
const vs = q.get('mode') === 'vs';
const sel = Number(q.get('sel') ?? 0) as 0 | 1 | 2 | 3;
const phase = q.get('phase') === 'wave' ? 'wave' : 'build';
const boss = q.has('boss');

const PEOPLE: [string, string, number, boolean][] = [
  ['me', 'Bas', 0x2eb3ff, false],
  ['p2', 'Mira', 0xff7ab6, false],
  ['p3', 'Tomo', 0xffa940, false],
  ['p4', 'Juniper', 0x6baf4b, false],
  ['b1', 'Sprout', 0xa869ff, true],
];
const players: HudPlayer[] = PEOPLE.map(([id, name, color, bot], i) => ({
  id,
  name,
  color,
  bot,
  gold: [340, 120, 515, 80, 210][i],
  income: vs ? [64, 52, 40, 88, 40][i] : 0,
  ready: [false, true, true, false, false][i],
  b: vs ? i : 0,
}));
const boards: HudBoard[] = vs
  ? players.map((p, i) => ({ b: i, own: p.id, name: p.name, color: p.color, lives: [17, 20, 6, 0, 0][i], out: i >= 3, place: i === 3 ? 4 : i === 4 ? 5 : undefined }))
  : [{ b: 0, own: null, name: 'Garden', color: 0x6baf4b, lives: 14, out: false }];

const scores: GScore[] = players.map((p, i) => ({
  id: p.id,
  kills: [212, 140, 305, 66, 98][i],
  dmg: [48210, 30544, 70123, 12010, 21877][i],
  built: [1460, 980, 2100, 540, 720][i],
  sent: vs ? [420, 300, 650, 110, 90][i] : 0,
  points: [2480, 1720, 3310, 830, 1170][i],
  place: vs ? [undefined, undefined, undefined, 4, 5][i] : undefined,
}));

const selKind: TowerKind = q.get('kind') && (q.get('kind') as TowerKind) in TOWERS ? (q.get('kind') as TowerKind) : sel === 3 ? 'missile' : 'laser';
const selLv = (sel === 3 ? 3 : sel === 2 ? 2 : 1) as Level;

let toastKey = 1;
const t0 = performance.now();
const toasts: Toast[] = [
  { key: toastKey++, text: boss ? 'Wave 10: the Prism Colossus approaches!' : `Wave ${phase === 'wave' ? 12 : 11} incoming`, tone: boss ? 'boss' : 'info', at: t0 },
  ...(vs ? [{ key: toastKey++, text: 'Tomo sent 4 runners at you', tone: 'bad' as const, at: t0 }] : [{ key: toastKey++, text: '2 enemies reached the greenhouse (-3 lives)', tone: 'bad' as const, at: t0 }]),
  { key: toastKey++, text: 'Wave 10 cleared: +55 gold', tone: 'good', at: t0 },
];

const endParam = q.get('end');
const initial: GHudState = {
  ready: !q.has('loading'),
  mode: vs ? 'vs' : 'coop',
  mapName: 'Moonpetal Meadow',
  wave: boss ? 9 : 11,
  maxWave: vs ? 0 : G.coopWaves,
  phase: endParam !== null ? 'over' : phase,
  left: phase === 'wave' ? 37 : 14,
  progress: 0.42,
  lives: vs ? boards[Number(q.get('view') ?? 0)].lives : 14,
  maxLives: G.lives,
  boards,
  players,
  you: 'me',
  myBoard: 0,
  viewBoard: vs ? Number(q.get('view') ?? 0) : 0,
  gold: q.has('poor') ? 95 : 340,
  income: vs ? 64 : 0,
  placing: (q.get('place') as TowerKind | null) ?? null,
  selected: sel
    ? {
        tower: { id: 7, k: selKind, lv: selLv, b: 0, x: 4, y: 6, own: 'me', tm: 0, spent: spentUpTo(selKind, selLv) },
        ownerName: 'Bas',
        ownerColor: 0x2eb3ff,
        mine: true,
        upCost: selLv < 3 ? TOWERS[selKind].levels[selLv as 1 | 2].cost : null,
        sellValue: Math.round(spentUpTo(selKind, selLv) * G.sellRefund),
        flags: sel === 3 ? 2 | 4 : 0,
      }
    : null,
  next: boss
    ? [
        { kind: 'runner', count: 18 },
        { kind: 'skitter', count: 5 },
        { kind: 'disruptor', count: 2 },
        { kind: 'brute', count: 2 },
        { kind: 'colossus', count: 1 },
      ]
    : [
        { kind: 'runner', count: 20 },
        { kind: 'skitter', count: 6 },
        { kind: 'disruptor', count: 2 },
        { kind: 'brute', count: 2 },
      ],
  bossNext: boss,
  toasts,
  scoresOpen: q.has('scores'),
  scores,
  end: endParam !== null ? { win: endParam === '1', winner: vs ? (endParam === '1' ? 'me' : 'p3') : null, wave: vs ? 23 : endParam === '1' ? 30 : 17 } : null,
  quality: 'high',
  paused: false,
};

const store = createStore<GHudState>(initial);
const toast = (text: string, tone: Toast['tone']) => store.set((s) => ({ toasts: [...s.toasts.slice(-5), { key: toastKey++, text, tone, at: performance.now() }] }));

const actions: GardenActions = {
  place: (kind) => store.set({ placing: kind, selected: null }),
  upgrade: (id) =>
    store.set((s) => {
      const c = s.selected;
      if (!c || c.tower.id !== id || c.upCost === null) return {};
      if (s.gold < c.upCost) {
        toast('Not enough gold', 'bad');
        return {};
      }
      const lv = (c.tower.lv + 1) as Level;
      const spent = spentUpTo(c.tower.k, lv);
      return {
        gold: s.gold - c.upCost,
        selected: { ...c, tower: { ...c.tower, lv, spent }, upCost: lv < 3 ? TOWERS[c.tower.k].levels[lv as 1 | 2].cost : null, sellValue: Math.round(spent * G.sellRefund) },
      };
    }),
  sell: () => store.set((s) => ({ gold: s.gold + (s.selected?.sellValue ?? 0), selected: null })),
  setTarget: (_id, tm) => store.set((s) => (s.selected ? { selected: { ...s.selected, tower: { ...s.selected.tower, tm } } } : {})),
  deselect: () => store.set({ selected: null }),
  ready: () => store.set((s) => ({ players: s.players.map((p) => (p.id === s.you ? { ...p, ready: !p.ready } : p)) })),
  send: (kind: EnemyKind, to) => {
    store.set((s) => ({ gold: s.gold - 50, income: s.income + 3 }));
    toast(`Sent ${kind} at ${to === undefined ? 'the next garden' : boards[to].name}`, 'info');
  },
  viewBoard: (b) => store.set((s) => ({ viewBoard: b, lives: s.boards[b]?.lives ?? s.lives })),
  setScoresOpen: (open) => store.set({ scoresOpen: open }),
  setQuality: (quality) => store.set({ quality }),
  leave: () => alert('leave'),
};

// Selecting a tower in the lab: press 1-5 to place, click the backdrop to "build" (gold drops) and select it.
window.addEventListener('keydown', (e) => {
  const k = ['laser', 'shield', 'slow', 'missile', 'beacon'][Number(e.key) - 1] as TowerKind | undefined;
  if (k) actions.place(store.get().placing === k ? null : k);
  if (e.code === 'KeyR') actions.ready();
  if (e.code === 'Tab') {
    e.preventDefault();
    actions.setScoresOpen(true);
  }
});
window.addEventListener('keyup', (e) => e.code === 'Tab' && actions.setScoresOpen(false));

if (q.has('live')) {
  window.setInterval(() => {
    store.set((s) => ({
      gold: s.gold + (Math.random() < 0.5 ? 6 : 2),
      progress: (s.progress + 0.02) % 1,
      left: s.phase === 'build' ? Math.max(0, s.left - 1) : Math.max(0, s.left - 1),
    }));
    if (Math.random() < 0.15) toast('An enemy reached the greenhouse', 'bad');
  }, 1000);
}

const room: RoomView = {
  code: 'MOSS',
  hostId: 'me',
  players: players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
} as unknown as RoomView;
const ctx: ClientContext = {
  you: 'me',
  socket: { send: (m: unknown) => console.log('socket', m) } as unknown as ClientContext['socket'],
  room: () => room,
  leave: () => alert('leave'),
};

function Backdrop() {
  const onClick = () => {
    const s = store.get();
    if (s.placing) {
      const k = s.placing;
      const cost = TOWERS[k].levels[0].cost;
      if (s.gold < cost) return toast('Not enough gold', 'bad');
      store.set({
        gold: s.gold - cost,
        placing: null,
        selected: {
          tower: { id: Math.floor(Math.random() * 1e6), k, lv: 1, b: 0, x: 1, y: 1, own: 'me', tm: 0, spent: cost },
          ownerName: 'Bas',
          ownerColor: 0x2eb3ff,
          mine: true,
          upCost: TOWERS[k].levels[1].cost,
          sellValue: Math.round(cost * G.sellRefund),
          flags: 0,
        },
      });
    } else store.set({ selected: null });
  };
  return (
    <div onClick={onClick} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'linear-gradient(180deg, #a9d8ee 0%, #cfeccd 22%, #86c062 23%, #6aa84a 100%)' }}>
      <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <path d="M-50 520 C 250 420, 420 700, 760 600 S 1250 360, 1700 470" stroke="#e8d6b6" strokeWidth="90" fill="none" strokeLinecap="round" />
        <path d="M-50 520 C 250 420, 420 700, 760 600 S 1250 360, 1700 470" stroke="#f3e5c8" strokeWidth="62" fill="none" strokeLinecap="round" strokeDasharray="30 26" />
        <ellipse cx="1180" cy="720" rx="190" ry="70" fill="#4fb6d8" opacity="0.85" />
        <ellipse cx="1160" cy="705" rx="120" ry="34" fill="#9fe2f5" opacity="0.6" />
        {Array.from({ length: 40 }, (_, i) => (
          <circle key={i} cx={(i * 397) % 1600} cy={240 + ((i * 211) % 640)} r={14 + ((i * 7) % 22)} fill={i % 3 ? '#4f8f3a' : '#5ea546'} opacity="0.9" />
        ))}
        {Array.from({ length: 24 }, (_, i) => (
          <circle key={`f${i}`} cx={(i * 263 + 80) % 1600} cy={260 + ((i * 157) % 600)} r="6" fill={['#ffa940', '#a869ff', '#4ee6d9', '#ff7ab6'][i % 4]} />
        ))}
        <rect x="700" y="160" width="200" height="120" rx="20" fill="#f5e7d6" opacity="0.9" />
        <path d="M690 170 L800 100 L910 170 Z" fill="#bfe8f0" stroke="#fff" strokeWidth="6" />
      </svg>
    </div>
  );
}

function Lab() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Backdrop />
      <GardenHud client={{ store, actions }} ctx={ctx} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Lab />);
if (q.has('menu')) setTimeout(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' })), 300);
