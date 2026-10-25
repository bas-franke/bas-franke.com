// Coach lab: /lab-garden-coach.html?step=n plays a short scripted sequence of fake HUD states that triggers tip n.
//   1 build   2 upgrade   3 early call   4 runner   5 skitter   6 disruptor   7 brute   8 colossus   9 versus   10 leak
//   11 moth   12 bloomkin   13 sunburst   14 sprinkler (skitter packs again)
//   ?sheet shows the enemy portraits large.
// Each step pre-seeds localStorage (garden.coach.v1) so only that tip is due. A stand-in top bar and build bar show
// where the real HUD sits.

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EnemyKind } from '@shared/garden/enemies';
import type { GardenActions, GHudState } from '../api';
import { CoachPortrait, GardenCoach } from '../Coach';

const base: GHudState = {
  ready: true,
  mode: 'coop',
  mapName: 'Greenhouse Glade',
  wave: 1,
  maxWave: 30,
  phase: 'build',
  left: 22,
  progress: 0,
  lives: 20,
  maxLives: 20,
  boards: [{ b: 0, own: null, name: 'Garden', color: 0x4ee6d9, lives: 20, out: false }],
  players: [{ id: 'me', name: 'You', color: 0x4ee6d9, bot: false, gold: 260, income: 0, ready: false, b: 0 }],
  you: 'me',
  myBoard: 0,
  viewBoard: 0,
  gold: 260,
  income: 0,
  placing: null,
  selected: null,
  next: [{ kind: 'runner', count: 7 }],
  bossNext: false,
  toasts: [],
  scoresOpen: false,
  scores: [],
  end: null,
  quality: 'high',
  paused: false,
};

const ALL_TIPS = ['build', 'upgrade', 'early', 'send', 'leak', 'sun', 'sprinkler'];
const KINDS: EnemyKind[] = ['runner', 'skitter', 'disruptor', 'brute', 'colossus', 'moth', 'bloomkin'];

interface Step {
  name: string;
  seen: string[];
  kinds: EnemyKind[];
  frames: Partial<GHudState>[];
}

const roster = (i: number, wave: number): Step => {
  const kind = KINDS[i];
  const next = KINDS.slice(0, i + 1).map((k) => ({ kind: k, count: 3 }));
  return {
    name: `roster: ${kind}`,
    seen: ALL_TIPS,
    kinds: KINDS.slice(0, i),
    frames: [
      { wave, phase: 'build', next, left: 6 },
      { wave, phase: 'wave', left: 30, progress: 0.05 },
    ],
  };
};

const STEPS: Step[] = [
  { name: 'build', seen: [], kinds: [], frames: [{}] },
  {
    name: 'upgrade',
    seen: [],
    kinds: [],
    frames: [{ placing: 'laser' }, { placing: 'laser', gold: 160 }, { placing: null, gold: 160 }],
  },
  { name: 'early call', seen: ['build', 'upgrade'], kinds: [], frames: [{ gold: 160, left: 17 }] },
  roster(0, 1),
  roster(1, 3),
  roster(2, 5),
  roster(3, 7),
  roster(4, 10),
  { name: 'versus', seen: ['build', 'upgrade'], kinds: KINDS, frames: [{ mode: 'vs', wave: 2, gold: 120 }] },
  {
    name: 'leak',
    seen: ['build', 'upgrade', 'early', 'send'],
    kinds: KINDS,
    frames: [
      { wave: 2, phase: 'wave', left: 9 },
      { wave: 2, phase: 'wave', left: 8, lives: 19 },
    ],
  },
  roster(5, 8),
  roster(6, 11),
  { name: 'sunburst', seen: ['build', 'upgrade'], kinds: KINDS, frames: [{ wave: 1, sun: 1, gold: 60 }] },
  {
    name: 'sprinkler',
    seen: ALL_TIPS.filter((t) => t !== 'sprinkler'),
    kinds: KINDS,
    frames: [{ wave: 4, phase: 'build', next: [{ kind: 'runner', count: 10 }, { kind: 'skitter', count: 15 }], left: 14 }],
  },
];

const noop = () => {};
const actions: GardenActions = {
  place: noop,
  upgrade: noop,
  sell: noop,
  setTarget: noop,
  deselect: noop,
  ready: noop,
  send: noop,
  sun: noop,
  viewBoard: noop,
  setScoresOpen: noop,
  setQuality: noop,
  leave: noop,
};

function Lab({ n }: { n: number }) {
  const step = STEPS[n - 1];
  const [state, setState] = useState<GHudState | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem('garden.coach.v1', JSON.stringify({ seen: step.seen, kinds: step.kinds, off: false }));
    } catch {
      /* ignore */
    }
    let acc: GHudState = { ...base };
    let i = 0;
    const tick = () => {
      acc = { ...acc, ...step.frames[i] };
      setState(acc);
      i++;
      if (i < step.frames.length) t = window.setTimeout(tick, 150);
    };
    let t = window.setTimeout(tick, 0);
    return () => window.clearTimeout(t);
  }, [step]);

  return (
    <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 45%, #7cbf5a, #3d6e2c 70%, #26331c)' }}>
      {/* stand-ins for the real HUD */}
      <div style={{ position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', width: 'min(420px, 80vw)', height: 52, borderRadius: 14, background: 'rgba(31,38,48,.75)', color: '#f5e7d6', display: 'grid', placeItems: 'center', fontWeight: 700 }}>
        WAVE {state?.wave ?? 1} / 30
      </div>
      <div style={{ position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)', width: 'min(620px, calc(100vw - 24px))', height: 120, borderRadius: 18, background: 'rgba(31,38,48,.75)', display: 'flex', gap: 8, padding: 10, boxSizing: 'border-box' }}>
        {[1, 2, 3, 4, 5, 6].map((k) => (
          <div key={k} style={{ flex: 1, borderRadius: 12, background: '#f5e7d6', opacity: 0.85, display: 'grid', placeItems: 'center', fontWeight: 800, color: '#334050' }}>
            {k}
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', right: 12, top: 76, display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 260, justifyContent: 'flex-end' }}>
        {STEPS.map((s, i) => (
          <a key={i} href={`?step=${i + 1}`} style={{ padding: '3px 8px', borderRadius: 8, background: i + 1 === n ? '#FFA940' : 'rgba(245,231,214,.85)', color: '#2b3644', font: '600 12px system-ui', textDecoration: 'none' }}>
            {i + 1} {s.name}
          </a>
        ))}
      </div>
      {state && <GardenCoach state={state} actions={actions} />}
    </div>
  );
}

// ?sheet shows every portrait large, for art review.
function Sheet() {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#F5E7D6', display: 'flex', gap: 24, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
      {KINDS.map((k) => (
        <div key={k} style={{ width: 220, height: 220 }} className="gsc-sheet">
          <CoachPortrait kind={k} />
        </div>
      ))}
      <style>{'.gsc-sheet .gsc-portrait { width: 100%; height: 100%; }'}</style>
    </div>
  );
}

const q = Number(new URLSearchParams(location.search).get('step'));
const n = q >= 1 && q <= STEPS.length ? q : 1;
createRoot(document.getElementById('app')!).render(new URLSearchParams(location.search).has('sheet') ? <Sheet /> : <Lab n={n} />);
