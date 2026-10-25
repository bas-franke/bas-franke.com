// A small top-down painting of a Garden Sentinels map, drawn as SVG straight from the map's ASCII grid and routes:
// grass, sandy paths (route polylines with round joins), water with lily pads, bridges, rocks, foliage, flowers,
// lamps, solar panels, the greenhouse as a golden dome and numbered entry portals with arrows along their routes.

import { useId, useMemo } from 'react';
import { G } from '@shared/garden/constants';
import type { GMapDef } from '@shared/garden/maps';

/** One colour per entry portal (route arrows, portal glow), in entry order. */
export const ENTRY_COLORS = ['#ff8a3d', '#3fd8ff', '#b77cff', '#ff5d8f', '#ffd23f', '#7cf4c9'];

/** Length of every route in metres. */
export function routeLengths(map: GMapDef): number[] {
  return map.routes.map((r) => {
    let d = 0;
    for (let i = 1; i < r.pts.length; i++) d += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]);
    return Math.round(d * G.cell);
  });
}

/** Deterministic 0..1 noise per cell (and salt), so a map always paints the same. */
function hash(x: number, y: number, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const PATHISH = new Set(['#', '=', 'E', 'G']);
const WATERISH = new Set(['~', 'o', '=']);
const FLOWER_COLORS = ['#ff8fc7', '#c58bff', '#fff4e0', '#ffd45c', '#ff7a7a'];

interface Cell {
  x: number;
  y: number;
  c: string;
}

/** A cell rect for the gooey layers; border cells reach past the edge so blobs do not round off there. */
function gooRect(x: number, y: number, cols: number, rows: number, grow: number) {
  const x0 = x === 0 ? -1 : x - grow;
  const y0 = y === 0 ? -1 : y - grow;
  const x1 = x === cols - 1 ? cols + 1 : x + 1 + grow;
  const y1 = y === rows - 1 ? rows + 1 : y + 1 + grow;
  return `M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
}

/** Point and unit tangent at distance `d` along a polyline (null past the end). */
function along(pts: [number, number][], d: number): { x: number; y: number; dx: number; dy: number } | null {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    if (d <= len) return { x: ax + ((bx - ax) * d) / len, y: ay + ((by - ay) * d) / len, dx: (bx - ax) / len, dy: (by - ay) / len };
    d -= len;
  }
  return null;
}

function polyLen(pts: [number, number][]) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return d;
}

export function GardenMapThumb({ map, className }: { map: GMapDef; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const art = useMemo(() => paint(map), [map]);
  const { cols, rows } = art;
  const id = (n: string) => `gsr-${uid}-${n}`;
  const warmth = map.mood?.warmth ?? 0.5;
  // Big maps shrink into the same card, so their portal badges grow to stay readable.
  const portalScale = Math.max(1, Math.min(1.6, cols / 32));

  return (
    <svg
      className={className}
      viewBox={`0 0 ${cols} ${rows}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Map of ${map.name}`}
      style={{ aspectRatio: `${cols} / ${rows}` }}
    >
      <defs>
        {/* Blur + alpha threshold: merges cell squares into soft, rounded blobs. */}
        <filter id={id('goo')} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="0.32" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9" />
        </filter>
        <radialGradient id={id('grass')} cx="50%" cy="45%" r="75%">
          <stop offset="0" stopColor="#79a94c" />
          <stop offset="1" stopColor="#4e7d34" />
        </radialGradient>
        <radialGradient id={id('dome')} cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#fff7c8" />
          <stop offset="0.45" stopColor="#ffd25e" />
          <stop offset="1" stopColor="#c98a1e" />
        </radialGradient>
        <radialGradient id={id('glow')}>
          <stop offset="0" stopColor="#ffe08a" stopOpacity="0.75" />
          <stop offset="1" stopColor="#ffe08a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('lamp')}>
          <stop offset="0" stopColor="#fff1b8" stopOpacity="0.9" />
          <stop offset="1" stopColor="#ffd56a" stopOpacity="0" />
        </radialGradient>
        {map.entries.map((_, i) => (
          <radialGradient key={i} id={id(`portal${i}`)}>
            <stop offset="0" stopColor="#fff" />
            <stop offset="0.35" stopColor={ENTRY_COLORS[i % ENTRY_COLORS.length]} />
            <stop offset="1" stopColor={ENTRY_COLORS[i % ENTRY_COLORS.length]} stopOpacity="0.25" />
          </radialGradient>
        ))}
      </defs>

      <rect x={-1} y={-1} width={cols + 2} height={rows + 2} fill={`url(#${id('grass')})`} />
      <path d={art.tufts} fill="#3f6b2b" opacity="0.55" />
      <path d={art.tuftsLight} fill="#9cc765" opacity="0.4" />

      {/* Water: bank, then surface, then a lighter shimmer. */}
      <g filter={`url(#${id('goo')})`}>
        <path d={art.waterBank} fill="#3b5a3a" />
      </g>
      <g filter={`url(#${id('goo')})`}>
        <path d={art.water} fill="#3a8fc4" />
      </g>
      <path d={art.ripples} stroke="#9fe0ff" strokeWidth="0.09" strokeLinecap="round" opacity="0.55" fill="none" />
      {art.pads.map((p, i) => (
        <g key={i} transform={`translate(${p.x} ${p.y}) rotate(${p.rot})`}>
          <path d={`M0 0L${p.r} -${p.r * 0.35}A${p.r} ${p.r} 0 1 1 ${p.r} ${p.r * 0.35}Z`} fill="#5fae4a" stroke="#2f6b2e" strokeWidth="0.05" />
          {p.bloom && <circle r={p.r * 0.32} cx={-p.r * 0.3} fill="#ffb3d6" />}
        </g>
      ))}

      {/* Paths: darker sandy edge, then the sand; routes on top give smooth round joins. */}
      <g filter={`url(#${id('goo')})`}>
        <path d={art.pathEdge} fill="#b38a57" />
        {map.routes.map((r, i) => (
          <polyline key={i} points={r.pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="#b38a57" strokeWidth={r.half * 2 + 0.35} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </g>
      <g filter={`url(#${id('goo')})`}>
        <path d={art.path} fill="#ecd3a2" />
        {map.routes.map((r, i) => (
          <polyline key={i} points={r.pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="#ecd3a2" strokeWidth={r.half * 2} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </g>

      {/* Bridges: planks across, rails along. */}
      {art.bridges.map((b, i) => (
        <g key={i}>
          <rect x={b.x} y={b.y} width={1} height={1} fill="#b47a46" />
          <path
            d={b.horiz ? `M${b.x + 0.33} ${b.y}v1M${b.x + 0.66} ${b.y}v1` : `M${b.x} ${b.y + 0.33}h1M${b.x} ${b.y + 0.66}h1`}
            stroke="#7a4d2a"
            strokeWidth="0.06"
          />
          {b.rails && <path d={b.rails} stroke="#e3d2ad" strokeWidth="0.14" strokeLinecap="round" />}
        </g>
      ))}

      {/* Lamps glow under everything that stands up. */}
      {art.lamps.map((l, i) => (
        <g key={i}>
          <circle cx={l.x} cy={l.y} r={1.1} fill={`url(#${id('lamp')})`} />
          <circle cx={l.x} cy={l.y} r={0.2} fill="#fff3c4" stroke="#6b5a3a" strokeWidth="0.06" />
        </g>
      ))}

      {art.solar.map((s, i) => (
        <g key={i}>
          <rect x={s.x + 0.1} y={s.y + 0.15} width={0.8} height={0.7} rx={0.06} fill="#2a4d82" stroke="#c7d6ea" strokeWidth="0.07" />
          <path d={`M${s.x + 0.5} ${s.y + 0.15}v0.7M${s.x + 0.1} ${s.y + 0.5}h0.8`} stroke="#7fa3d6" strokeWidth="0.05" />
        </g>
      ))}

      {art.rocks.map((r, i) => (
        <g key={i}>
          <circle cx={r.x + 0.06} cy={r.y + 0.1} r={r.r} fill="#2c3a28" opacity="0.45" />
          <circle cx={r.x} cy={r.y} r={r.r} fill="#8d9097" />
          <circle cx={r.x - r.r * 0.3} cy={r.y - r.r * 0.3} r={r.r * 0.45} fill="#b9bcc2" />
        </g>
      ))}

      {art.flowers.map((f, i) => (
        <g key={i}>
          <circle cx={f.x} cy={f.y} r={0.58} fill="#4b7d33" />
          {f.dots.map((d, j) => (
            <circle key={j} cx={d.x} cy={d.y} r={0.13} fill={d.c} />
          ))}
        </g>
      ))}

      <g>
        {art.foliage.map((t, i) => (
          <circle key={`s${i}`} cx={t.x + 0.12} cy={t.y + 0.16} r={t.r} fill="#1f3a1c" opacity="0.5" />
        ))}
        {art.foliage.map((t, i) => (
          <circle key={`b${i}`} cx={t.x} cy={t.y} r={t.r} fill={t.dark ? '#2c5a2a' : '#356b2f'} />
        ))}
        {art.foliage.map((t, i) => (
          <circle key={`h${i}`} cx={t.x - t.r * 0.28} cy={t.y - t.r * 0.3} r={t.r * 0.45} fill="#5c9a3f" opacity="0.8" />
        ))}
        {art.foliage
          .filter((t) => t.bloom)
          .map((t, i) => (
            <circle key={`f${i}`} cx={t.x + t.r * 0.3} cy={t.y} r={0.11} fill={t.bloom!} />
          ))}
      </g>

      {/* Route arrows, in the colour of the portal they come from. */}
      {art.arrows.map((a, i) => (
        <path
          key={i}
          d="M-0.32 -0.38L0.18 0L-0.32 0.38"
          transform={`translate(${a.x} ${a.y}) rotate(${a.rot})`}
          fill="none"
          stroke={a.color}
          strokeWidth="0.22"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={a.strong ? 1 : 0.75}
        />
      ))}

      {/* Greenhouse: warm glow, stone ring, golden geodesic dome. */}
      <g transform={`translate(${map.goal.x} ${map.goal.y})`}>
        <circle r={3.4} fill={`url(#${id('glow')})`} />
        <circle r={2.05} fill="#d8c69e" stroke="#8d7550" strokeWidth="0.1" />
        <circle r={1.72} fill={`url(#${id('dome')})`} stroke="#9a6514" strokeWidth="0.08" />
        <g stroke="#a86f17" strokeWidth="0.06" fill="none" opacity="0.7">
          <circle r={1.15} />
          <circle r={0.58} />
          {Array.from({ length: 8 }, (_, k) => {
            const a = (k / 8) * Math.PI * 2;
            return <line key={k} x1={Math.cos(a) * 0.58} y1={Math.sin(a) * 0.58} x2={Math.cos(a) * 1.72} y2={Math.sin(a) * 1.72} />;
          })}
        </g>
        <circle r={0.35} cx={-0.55} cy={-0.6} fill="#fffbe6" opacity="0.7" />
      </g>

      {/* Entry portals: stone ring, coloured glow, number. */}
      {map.entries.map((e, i) => (
        <g key={i} transform={`translate(${e.x} ${e.y}) scale(${portalScale})`}>
          <circle r={1.5} fill="#6f6a66" stroke="#2f2a28" strokeWidth="0.14" />
          <circle r={1.12} fill={`url(#${id(`portal${i}`)})`} />
          <text
            y={0.55}
            textAnchor="middle"
            fontSize="1.6"
            fontWeight="900"
            fontFamily="'Fredoka', 'Nunito', system-ui, sans-serif"
            fill="#fff"
            stroke="#1c1418"
            strokeWidth="0.24"
            paintOrder="stroke"
          >
            {i + 1}
          </text>
        </g>
      ))}

      {/* Sunlight warmth over the whole garden. */}
      <rect x={-1} y={-1} width={cols + 2} height={rows + 2} fill="#ffb347" opacity={0.04 + warmth * 0.08} style={{ mixBlendMode: 'soft-light' }} />
    </svg>
  );
}

/** Turns the grid and routes into SVG-ready shapes. */
function paint(map: GMapDef) {
  const rows = Math.max(1, map.grid.length);
  const cols = Math.max(1, ...map.grid.map((r) => r.length));
  const at = (x: number, y: number) => map.grid[y]?.[x] ?? '.';
  const cells: Cell[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) cells.push({ x, y, c: at(x, y) });

  let water = '';
  let waterBank = '';
  let path = '';
  let pathEdge = '';
  let tufts = '';
  let tuftsLight = '';
  let ripples = '';
  const pads: { x: number; y: number; r: number; rot: number; bloom: boolean }[] = [];
  const bridges: { x: number; y: number; horiz: boolean; rails: string }[] = [];
  const rocks: { x: number; y: number; r: number }[] = [];
  const foliage: { x: number; y: number; r: number; dark: boolean; bloom?: string }[] = [];
  const flowers: { x: number; y: number; dots: { x: number; y: number; c: string }[] }[] = [];
  const lamps: { x: number; y: number }[] = [];
  const solar: { x: number; y: number }[] = [];
  const circ = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;

  for (const { x, y, c } of cells) {
    const h = hash(x, y);
    if (WATERISH.has(c)) {
      water += gooRect(x, y, cols, rows, 0);
      waterBank += gooRect(x, y, cols, rows, 0.22);
      if (c !== '=' && h < 0.3) ripples += `M${x + 0.2 + h} ${y + 0.3 + h}h0.35`;
    }
    if (PATHISH.has(c)) {
      path += gooRect(x, y, cols, rows, 0);
      pathEdge += gooRect(x, y, cols, rows, 0.16);
    }
    switch (c) {
      case '.':
        if (h < 0.35) tufts += circ(x + 0.2 + hash(x, y, 1) * 0.6, y + 0.2 + hash(x, y, 2) * 0.6, 0.1 + h * 0.3);
        else if (h > 0.85) tuftsLight += circ(x + 0.5, y + 0.5, 0.22);
        break;
      case 'o':
        pads.push({ x: x + 0.5, y: y + 0.5, r: 0.3, rot: h * 360, bloom: hash(x, y, 3) < 0.35 });
        if (hash(x, y, 4) < 0.5) pads.push({ x: x + 0.2 + hash(x, y, 5) * 0.2, y: y + 0.25, r: 0.18, rot: hash(x, y, 6) * 360, bloom: false });
        break;
      case '=': {
        // Open water above or below means the bridge spans east-west.
        const wet = (ch: string) => ch === '~' || ch === 'o';
        const horiz = wet(at(x, y - 1)) || wet(at(x, y + 1)) || !(wet(at(x - 1, y)) || wet(at(x + 1, y)));
        // Rails only on the sides that face open water.
        let rails = '';
        if (horiz) {
          if (wet(at(x, y - 1))) rails += `M${x} ${y + 0.07}h1`;
          if (wet(at(x, y + 1))) rails += `M${x} ${y + 0.93}h1`;
        } else {
          if (wet(at(x - 1, y))) rails += `M${x + 0.07} ${y}v1`;
          if (wet(at(x + 1, y))) rails += `M${x + 0.93} ${y}v1`;
        }
        bridges.push({ x, y, horiz, rails });
        break;
      }
      case 'R': {
        const n = 2 + Math.floor(h * 2);
        for (let k = 0; k < n; k++) rocks.push({ x: x + 0.25 + hash(x, y, 10 + k) * 0.5, y: y + 0.25 + hash(x, y, 20 + k) * 0.5, r: 0.22 + hash(x, y, 30 + k) * 0.2 });
        break;
      }
      case 'T':
        foliage.push({ x: x + 0.5, y: y + 0.5, r: 0.62 + h * 0.2, dark: h < 0.5, bloom: hash(x, y, 7) < 0.3 ? FLOWER_COLORS[Math.floor(hash(x, y, 8) * FLOWER_COLORS.length)] : undefined });
        if (hash(x, y, 9) < 0.5) foliage.push({ x: x + 0.2 + hash(x, y, 11) * 0.6, y: y + 0.2, r: 0.4, dark: true });
        break;
      case 'f': {
        const dots = [];
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2 + h * 6;
          const rr = 0.15 + hash(x, y, 40 + k) * 0.25;
          dots.push({ x: x + 0.5 + Math.cos(a) * rr, y: y + 0.5 + Math.sin(a) * rr, c: FLOWER_COLORS[Math.floor(hash(x, y, 50 + k) * FLOWER_COLORS.length)] });
        }
        flowers.push({ x: x + 0.5, y: y + 0.5, dots });
        break;
      }
      case 'l':
        lamps.push({ x: x + 0.5, y: y + 0.5 });
        break;
      case 's':
        solar.push({ x, y });
        break;
    }
  }

  const arrows: { x: number; y: number; rot: number; color: string; strong: boolean }[] = [];
  for (const r of map.routes) {
    const color = ENTRY_COLORS[r.entry % ENTRY_COLORS.length];
    const total = polyLen(r.pts);
    // Skip the portal mouth and stop short of the greenhouse; a chevron every few cells along the way.
    for (let d = 1.6; d < total - 2.6; d += d < 5 ? 1.1 : 4.2) {
      const p = along(r.pts, d);
      if (!p) break;
      // Where routes share a path, one chevron is enough.
      if (arrows.some((a) => a.color !== color && Math.hypot(a.x - p.x, a.y - p.y) < 1.4)) continue;
      arrows.push({ x: p.x, y: p.y, rot: (Math.atan2(p.dy, p.dx) * 180) / Math.PI, color, strong: d < 5 });
    }
  }

  return { cols, rows, water, waterBank, path, pathEdge, tufts, tuftsLight, ripples, pads, bridges, rocks, foliage, flowers, lamps, solar, arrows };
}
