// Dev only: the Garden Sentinels waiting-room panels with a fake room, both modes side by side.
// Open /lab-garden-room.html. Uses GMAPS when the map author has filled it, else a few generated stand-in maps.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { GameMode, RoomView } from '@shared/protocol';
import { GMAPS, type GMapDef, type GRoute } from '@shared/garden/maps';
import type { GMode } from '@shared/garden/constants';
import { GardenPanels } from './GardenPanels';
import { GardenMapThumb } from './GardenMapThumb';
import '../styles.css';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec {
  id: string;
  name: string;
  blurb: string;
  modes: GMode[];
  w: number;
  h: number;
  routes: GRoute[];
  goal: [number, number];
  water: [number, number, number, number][];
  seed: number;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.max(Math.abs(px - (ax + dx * t)), Math.abs(py - (ay + dy * t)));
}

function build(s: Spec): GMapDef {
  const g = Array.from({ length: s.h }, () => Array.from({ length: s.w }, () => '.'));
  const set = (c: number, r: number, ch: string) => {
    if (r >= 0 && r < s.h && c >= 0 && c < s.w) g[r][c] = ch;
  };
  const get = (c: number, r: number) => g[r]?.[c];
  const rect = (c0: number, r0: number, c1: number, r1: number, ch: string) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) set(c, r, ch);
  };
  for (const [a, b, c, d] of s.water) rect(a, b, c, d, '~');
  for (const rt of s.routes)
    for (let r = 0; r < s.h; r++)
      for (let c = 0; c < s.w; c++)
        for (let i = 1; i < rt.pts.length; i++)
          if (segDist(c + 0.5, r + 0.5, ...rt.pts[i - 1], ...rt.pts[i]) < rt.half) set(c, r, get(c, r) === '~' || get(c, r) === '=' ? '=' : '#');
  const entries = s.routes.map((rt) => {
    const [x, y] = rt.pts[0];
    const ex = Math.max(1, Math.min(s.w - 1, Math.round(x)));
    const ey = Math.max(1, Math.min(s.h - 1, Math.round(y)));
    rect(ex - 1, ey - 1, ex, ey, 'E');
    return { x: ex, y: ey, facing: 0 };
  });
  rect(s.goal[0] - 2, s.goal[1] - 2, s.goal[0] + 1, s.goal[1] + 1, 'G');
  const rand = rng(s.seed);
  const near = (c: number, r: number, chs: string) => {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (chs.includes(get(c + dc, r + dr) ?? '')) return true;
    return false;
  };
  for (let r = 0; r < s.h; r++) for (let c = 0; c < s.w; c++) if (get(c, r) === '~' && rand() < 0.22 && !near(c, r, '#=')) set(c, r, 'o');
  for (let r = 0; r < s.h; r++)
    for (let c = 0; c < s.w; c++) {
      if (get(c, r) !== '.') continue;
      const edge = r === 0 || r === s.h - 1 || c === 0 || c === s.w - 1;
      const x = rand();
      if (edge && x < 0.6) set(c, r, rand() < 0.2 ? 'f' : 'T');
      else if (near(c, r, '~o') && x < 0.14) set(c, r, 'R');
      else if (near(c, r, '#') && x < 0.06) set(c, r, 'l');
      else if (x < 0.04) set(c, r, 'T');
      else if (x < 0.06) set(c, r, 'f');
      else if (x < 0.066) set(c, r, 's');
    }
  return { id: s.id, name: s.name, blurb: s.blurb, modes: s.modes, grid: g.map((row) => row.join('')), entries, goal: { x: s.goal[0], y: s.goal[1] }, routes: s.routes, mood: { warmth: 0.6, water: 0.5 } };
}

const SAMPLES: Spec[] = [
  {
    id: 'lily',
    name: 'Lily Locks',
    blurb: 'Three portals, two streams and a greenhouse in the middle.',
    modes: ['coop'],
    w: 32,
    h: 20,
    seed: 3,
    goal: [19, 11],
    water: [[6, 0, 7, 5], [3, 6, 8, 11], [4, 12, 5, 19], [22, 6, 31, 7], [12, 17, 24, 19]],
    routes: [
      { entry: 0, half: 1, pts: [[1, 3], [10, 3], [14, 6], [14, 11], [17, 11]] },
      { entry: 1, half: 1, pts: [[1, 16], [10, 16], [11, 11], [17, 11]] },
      { entry: 2, half: 1, pts: [[31, 3], [26, 3], [26, 14], [19, 15], [19, 13]] },
    ],
  },
  {
    id: 'meander',
    name: 'Meander',
    blurb: 'One long winding path. Lots of room to build.',
    modes: ['coop', 'vs'],
    w: 28,
    h: 18,
    seed: 11,
    goal: [24, 9],
    water: [[10, 7, 17, 10]],
    routes: [{ entry: 0, half: 1, pts: [[1, 3], [22, 3], [22, 7], [6, 7], [6, 14], [20, 14], [22, 11]] }],
  },
  {
    id: 'twinbrook',
    name: 'Twinbrook',
    blurb: 'Two portals meet at the bridge.',
    modes: ['vs'],
    w: 22,
    h: 16,
    seed: 5,
    goal: [11, 12],
    water: [[0, 7, 21, 8]],
    routes: [
      { entry: 0, half: 1, pts: [[1, 2], [7, 2], [11, 6], [11, 10]] },
      { entry: 1, half: 1, pts: [[21, 2], [15, 2], [11, 6]] },
    ],
  },
  {
    id: 'four',
    name: 'Crossroads',
    blurb: 'Four portals, one door. Hold the centre.',
    modes: ['coop'],
    w: 30,
    h: 20,
    seed: 21,
    goal: [15, 10],
    water: [[2, 9, 9, 11], [21, 8, 27, 10]],
    routes: [
      { entry: 0, half: 1, pts: [[1, 2], [8, 2], [13, 8]] },
      { entry: 1, half: 1, pts: [[29, 2], [22, 2], [17, 8]] },
      { entry: 2, half: 1, pts: [[1, 18], [8, 18], [13, 12]] },
      { entry: 3, half: 1, pts: [[29, 18], [22, 18], [17, 12]] },
    ],
  },
];

if (GMAPS.length === 0) GMAPS.push(...SAMPLES.map(build));

function Lab({ mode, host }: { mode: GMode; host: boolean }) {
  const [room, setRoom] = useState<RoomView>({
    code: 'GRDN',
    name: 'Garden lab',
    game: 'garden' as RoomView['game'],
    state: 'waiting' as RoomView['state'],
    maxPlayers: 6,
    botDifficulty: 'normal' as RoomView['botDifficulty'],
    map: GMAPS.find((m) => m.modes.includes(mode))?.id ?? 'random',
    mode,
    hostId: 'me',
    players: [],
  });
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <GardenPanels
        room={room}
        isHost={host}
        playing={false}
        setMode={(m: GameMode) => setRoom((r) => ({ ...r, mode: m }))}
        setMap={(m: string) => setRoom((r) => ({ ...r, map: m }))}
      />
    </div>
  );
}

const big = new URLSearchParams(location.search).has('big');

createRoot(document.getElementById('root')!).render(
  big ? (
    <main style={{ padding: 16, display: 'grid', gap: 16 }}>
      {GMAPS.map((m) => (
        <GardenMapThumb key={m.id} map={m} className="gsr-big" />
      ))}
    </main>
  ) : (
  <main style={{ maxWidth: 1100, margin: '0 auto', padding: '24px var(--gutter)', display: 'grid', gap: 28 }}>
    <Lab mode="coop" host />
    <Lab mode="vs" host={false} />
  </main>
  ),
);
