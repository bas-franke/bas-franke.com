// The race HUD widgets: distance-to-go / position panels, timer, speedometer with boost bar, the pod damage diagram,
// minimap and the centre-screen messages (countdown, wrong way, finish). Each widget subscribes to its own slice of the
// HUD store so the per-frame updates only touch the few DOM nodes that changed; the gauge is an SVG dash, the damage
// diagram an SVG schematic coloured per part and the minimap a canvas.

import { memo, useEffect, useRef, useState } from 'react';
import { PART_IDS, PARTS, podLayout, type PartId } from '../core/damage';
import { PODS, type PodShape } from '../core/pods';
import type { RaceView } from '../RaceView';
import { fmtTime, ordinal, useHud } from './hudStore';

type P = { view: RaceView };

export const ToGoPanel = memo(function ToGoPanel({ view }: P) {
  const km = useHud(view, (s) => (s.toGo / 1000).toFixed(1));
  return (
    <div className="hud-lap hud-slant">
      <span className="hud-label">TO GO</span>
      <span className="hud-big">
        {km}
        <small>km</small>
      </span>
    </div>
  );
});

export const PosPanel = memo(function PosPanel({ view }: P) {
  const pos = useHud(view, (s) => s.position);
  const racers = useHud(view, (s) => s.racers);
  const prev = useRef(pos);
  const [delta, setDelta] = useState<{ d: number; n: number } | null>(null);
  useEffect(() => {
    if (pos !== prev.current) {
      setDelta((o) => ({ d: prev.current - pos, n: (o?.n ?? 0) + 1 }));
      prev.current = pos;
      const t = setTimeout(() => setDelta(null), 1400);
      return () => clearTimeout(t);
    }
  }, [pos]);
  return (
    <div className="hud-pos hud-slant">
      <span className="hud-label">POS</span>
      <span key={delta?.n ?? 0} className={`hud-big${delta ? ' hud-pop' : ''}`}>
        {pos}
        <small>/{racers}</small>
      </span>
      {delta && <span key={`d${delta.n}`} className={`hud-delta ${delta.d > 0 ? 'up' : 'down'}`}>{delta.d > 0 ? '▲' : '▼'}</span>}
    </div>
  );
});

export const TimePanel = memo(function TimePanel({ view }: P) {
  const time = useHud(view, (s) => fmtTime(s.time));
  return (
    <div className="hud-time">
      <div className="hud-time-row">
        <span className="hud-time-label">TIME</span>
        <span className="hud-time-val">{time}</span>
      </div>
    </div>
  );
});

// Speed arc: centre (140,150), r 118, from 192° (lower left) over the top to 28° (upper right).
const CX = 140;
const CY = 150;
const R = 118;
const A0 = 192;
const A1 = 28;
const pt = (a: number) => `${(CX + R * Math.cos((a * Math.PI) / 180)).toFixed(1)} ${(CY - R * Math.sin((a * Math.PI) / 180)).toFixed(1)}`;
const ARC = `M ${pt(A0)} A ${R} ${R} 0 0 1 ${pt(A1)}`;
/** Fraction of the arc at top speed; the rest is boost overspeed. */
const TOP = 0.86;

export const Speedo = memo(function Speedo({ view }: P) {
  const kmh = useHud(view, (s) => s.speedKmh);
  // Quantised so the SVG only changes when the fill visibly moves.
  const fill = useHud(view, (s) => Math.round(Math.min(1, Math.max(0, s.speed01) * TOP) * 400) / 4);
  const boosting = useHud(view, (s) => s.boosting);
  return (
    <div className={`hud-speedo${boosting ? ' boosting' : ''}`}>
      <svg className="hud-arc" viewBox="0 0 300 190" aria-hidden>
        <defs>
          <linearGradient id="hudArcGrad" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="250" y2="0">
            <stop offset="0" stopColor="#25d8ff" />
            <stop offset="0.3" stopColor="#3fe6ff" />
            <stop offset="0.52" stopColor="#b8f070" />
            <stop offset="0.66" stopColor="#ffd21f" />
            <stop offset="1" stopColor="#ffa514" />
          </linearGradient>
        </defs>
        <path className="hud-arc-bg" d={ARC} pathLength={100} />
        <path className="hud-arc-fill" d={ARC} pathLength={100} strokeDasharray={`${fill} 100`} />
        <path className="hud-arc-tick" d={ARC} pathLength={100} strokeDasharray="3 100" />
      </svg>
      <div className="hud-speed-plate">
        <span className="hud-speed-label">SPEED</span>
        <span className="hud-speed-num">{kmh}</span>
        <span className="hud-speed-unit">KM/H</span>
      </div>
      <BoostBar view={view} />
      <Damage view={view} />
    </div>
  );
});

const SEGMENTS = 5;

const BoostBar = memo(function BoostBar({ view }: P) {
  const boost = useHud(view, (s) => Math.round(s.boost * 60) / 60);
  const boosting = useHud(view, (s) => s.boosting);
  const drafting = useHud(view, (s) => s.drafting);
  const full = boost >= 0.999;
  return (
    <div className={`hud-boost${boosting ? ' boosting' : ''}${full ? ' full' : ''}${drafting ? ' drafting' : ''}`}>
      <span className="hud-boost-label">BOOST</span>
      <span className="hud-boost-segs">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span key={i} className="hud-seg">
            <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, boost * SEGMENTS - i))})` }} />
          </span>
        ))}
      </span>
      {drafting && <span className="hud-draft">DRAFT</span>}
    </div>
  );
});

/** Minimap: the outline is drawn once per size into a cached canvas; pods redraw at the store's ~12 Hz. */
export const Minimap = memo(function Minimap({ view }: P) {
  const outline = useHud(view, (s) => s.outline);
  const pods = useHud(view, (s) => s.pods);
  const canvas = useRef<HTMLCanvasElement>(null);
  const base = useRef<{ img: HTMLCanvasElement; w: number; h: number; map(p: [number, number]): [number, number] } | null>(null);
  const [size, setSize] = useState(0);

  useEffect(() => {
    const c = canvas.current!;
    const ro = new ResizeObserver(() => setSize(c.clientWidth * 1000 + c.clientHeight));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    c.width = w;
    c.height = h;
    const pad = Math.min(w, h) * 0.1;
    // Fit the 0..1 outline into the canvas keeping its aspect.
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const [x, y] of outline) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const k = Math.min((w - 2 * pad) / Math.max(1e-3, x1 - x0), (h - 2 * pad) / Math.max(1e-3, y1 - y0));
    const ox = (w - (x1 - x0) * k) / 2 - x0 * k;
    const oy = (h - (y1 - y0) * k) / 2 - y0 * k;
    const map = ([x, y]: [number, number]): [number, number] => [ox + x * k, oy + y * k];

    const img = document.createElement('canvas');
    img.width = w;
    img.height = h;
    const g = img.getContext('2d')!;
    const road = Math.max(3, Math.min(w, h) * 0.055);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    outline.forEach((p, i) => {
      const [x, y] = map(p);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = road + 6 * dpr;
    g.stroke();
    g.strokeStyle = '#f4f2ee';
    g.lineWidth = road + 2.5 * dpr;
    g.stroke();
    g.strokeStyle = '#aeb0b4';
    g.lineWidth = road - 1.5 * dpr;
    g.stroke();
    g.setLineDash([3 * dpr, 4 * dpr]);
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = Math.max(1, dpr * 0.8);
    g.stroke();
    g.setLineDash([]);

    // Checkered lines across the road at the start and the finish.
    const n = outline.length;
    for (const [i0, i1] of n > 2 ? [[0, 1], [n - 2, n - 1]] : []) {
      const [ax, ay] = map(outline[i0]);
      const [bx, by] = map(outline[i1]);
      const ang = Math.atan2(by - ay, bx - ax);
      const cs = road * 0.36;
      g.save();
      g.translate(ax, ay);
      g.rotate(ang);
      g.fillStyle = '#111';
      g.fillRect(-cs, -road * 0.85, cs * 2, road * 1.7);
      for (let i = 0; i < 2; i++)
        for (let j = 0; j < 5; j++) if ((i + j) % 2 === 0) {
          g.fillStyle = '#fff';
          g.fillRect(-cs + i * cs, -road * 0.85 + j * road * 0.34, cs, road * 0.34);
        }
      g.restore();
    }
    base.current = { img, w, h, map };
  }, [outline, size]);

  useEffect(() => {
    const c = canvas.current!;
    const b = base.current;
    if (!b || c.width !== b.w) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, b.w, b.h);
    g.drawImage(b.img, 0, 0);
    const r = Math.max(2.5, Math.min(b.w, b.h) * 0.032);
    // Rivals first so the player is drawn on top.
    for (const p of [...pods].sort((a, c2) => Number(a.player) - Number(c2.player))) {
      const [x, y] = b.map([p.x, p.y]);
      const rr = p.player ? r * 1.45 : r;
      g.beginPath();
      g.arc(x, y, rr, 0, Math.PI * 2);
      g.fillStyle = p.color;
      g.fill();
      g.lineWidth = p.player ? rr * 0.42 : rr * 0.3;
      g.strokeStyle = p.player ? '#fff' : 'rgba(10,10,14,0.85)';
      g.stroke();
      if (p.player) {
        g.beginPath();
        g.arc(x, y, rr * 1.9, 0, Math.PI * 2);
        g.lineWidth = Math.max(1, rr * 0.2);
        g.strokeStyle = 'rgba(255,214,40,0.8)';
        g.stroke();
      }
    }
  }, [pods, size]);

  return (
    <div className="hud-map">
      <canvas ref={canvas} className="hud-map-canvas" />
    </div>
  );
});

export const Standings = memo(function Standings({ view }: P) {
  const rows = useHud(view, (s) => s.standings);
  if (!rows.length) return null;
  return (
    <ol className="hud-standings">
      {rows.map((r, i) => (
        <li key={r.name} className={r.player ? 'me' : ''}>
          <b>{i + 1}</b>
          <i style={{ background: r.color }} />
          <span>{r.player ? 'YOU' : r.name}</span>
          {r.finished && <em>⚑</em>}
        </li>
      ))}
    </ol>
  );
});

export const Countdown = memo(function Countdown({ view }: P) {
  const n = useHud(view, (s) => s.countdown);
  if (n < 0) return null;
  return (
    <div className="hud-center">
      <div key={n} className={`hud-count${n === 0 ? ' go' : ''}`}>
        {n === 0 ? 'GO!' : n}
      </div>
    </div>
  );
});

const BAR_PARTS = [
  ['L', 'Left engine'],
  ['C', 'Cockpit'],
  ['R', 'Right engine'],
] as const;
const PART_INDEX = [0, 2, 1];

/** The pod's damage: the per-part diagram when the view publishes per-part health, else the old three HULL bars. */
const Damage = memo(function Damage({ view }: P) {
  const hasParts = useHud(view, (s) => !!s.parts);
  return hasParts ? <DamageDiagram view={view} /> : <DamageBar view={view} />;
});

/** Damage per part, left engine / cockpit / right engine as they sit on the pod: green, then amber, then red. */
const DamageBar = memo(function DamageBar({ view }: P) {
  const damage = useHud(view, (s) => s.damage);
  return (
    <div className="hud-damage">
      <span className="hud-damage-label">HULL</span>
      {BAR_PARTS.map(([k, title], i) => {
        const d = damage[PART_INDEX[i]];
        return (
          <span key={k} className={`hud-damage-part${d > 0.7 ? ' critical' : d > 0.4 ? ' hurt' : ''}`} title={title}>
            <b>{k}</b>
            <i style={{ transform: `scaleX(${Math.max(0, 1 - d)})` }} />
          </span>
        );
      })}
    </div>
  );
});

/** One drawn piece of the schematic: a closed shape (filled by health) or a line (binders, cables). */
interface Piece {
  part: PartId;
  d: string;
  line?: boolean;
}

const f1 = (n: number) => n.toFixed(2);
const poly = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${f1(x)} ${f1(y)}`).join('L')}Z`;
/** A box from z0 to z1, half width w, its corners rounded with radius r. */
function capsule(x: number, z0: number, z1: number, w: number, r: number) {
  const a = Math.min(r, w, (z1 - z0) / 2);
  const [l, rt] = [f1(x - w), f1(x + w)];
  return `M${l} ${f1(z0 + a)}Q${l} ${f1(z0)} ${f1(x - w + a)} ${f1(z0)}L${f1(x + w - a)} ${f1(z0)}Q${rt} ${f1(z0)} ${rt} ${f1(z0 + a)}`
    + `L${rt} ${f1(z1 - a)}Q${rt} ${f1(z1)} ${f1(x + w - a)} ${f1(z1)}L${f1(x - w + a)} ${f1(z1)}Q${l} ${f1(z1)} ${l} ${f1(z1 - a)}Z`;
}

/**
 * A top-down schematic of the pod in pod space (x right, z back, so the nose points up the screen), laid out like
 * core/damage.ts's anchors so each piece sits where the part that takes the hit sits. Drawn once at module load from a
 * stock pod shape: the HUD does not know the player's pod and the pods are close enough in proportion. Proportions are
 * nudged (thicker binders, bigger canopy and fins) so it still reads at a few dozen pixels.
 */
function podSchematic(shape: PodShape) {
  const { L, R, C, xE, zE, zC, ca } = podLayout(shape);
  const pieces: Piece[] = [];
  const front = zE - L / 2;
  const back = zE + L / 2;
  const cw = ca * 0.95;
  const noseZ = zC - C / 2;
  const hullZ0 = noseZ + C * 0.22;
  const w = R * 0.82;
  // Lines first, so the engines and the cockpit draw over their ends.
  pieces.push({ part: 'binderMid', line: true, d: `M${f1(-xE + w)} ${f1(zE - L * 0.15)}L${f1(xE - w)} ${f1(zE - L * 0.15)}` });
  for (const [s, k] of [[-1, 'L'], [1, 'R']] as const) {
    const x = s * xE;
    pieces.push({ part: `binder${k}`, line: true, d: `M${f1(s * cw)} ${f1(zC - C * 0.05)}L${f1(x - s * w)} ${f1(zE + 0.12 * L)}` });
    pieces.push({ part: `cable${k}`, line: true, d: `M${f1(s * 0.25)} ${f1(noseZ - 0.2)}L${f1(x - s * w * 0.3)} ${f1(zE - L / 4)}` });
  }
  for (const [s, k] of [[-1, 'L'], [1, 'R']] as const) {
    const x = s * xE;
    pieces.push({ part: `flap${k}`, d: poly([[x + s * w * 0.9, zE - 0.08 * L], [x + s * (w + 0.95), zE + 0.02 * L], [x + s * (w + 0.95), zE + 0.3 * L], [x + s * w * 0.9, zE + 0.34 * L]]) });
    pieces.push({ part: `nacelle${k}`, d: capsule(x, front + 0.13 * L, back - 0.15 * L, w, w * 0.5) });
    pieces.push({ part: `intake${k}`, d: capsule(x, front + 0.01 * L, front + 0.15 * L, w * 1.08, w * 0.3) });
    // Three claws: spikes ahead of the intake ring.
    const cz = front + 0.02 * L;
    const tip = front - 0.13 * L;
    const claw = (cx: number, lean: number): [number, number][] => [[cx - 0.2, cz], [cx + lean, tip], [cx + 0.2, cz]];
    pieces.push({ part: `claws${k}`, d: [claw(x - w * 0.7, -0.2), claw(x, 0), claw(x + w * 0.7, 0.2)].map(poly).join('') });
    pieces.push({ part: `nozzle${k}`, d: poly([[x - w * 0.85, back - 0.16 * L], [x + w * 0.85, back - 0.16 * L], [x + w * 0.6, back], [x - w * 0.6, back]]) });
    pieces.push({ part: `fin${k}`, d: poly([[x - 0.17, zE - 0.12 * L], [x + 0.17, zE - 0.12 * L], [x + 0.26, zE + 0.32 * L], [x - 0.26, zE + 0.32 * L]]) });
  }
  pieces.push({ part: 'hull', d: capsule(0, hullZ0, zC + C / 2 - 0.15, cw, cw * 0.6) });
  pieces.push({ part: 'cockpitNose', d: `M${f1(-cw)} ${f1(hullZ0 + 0.3)}Q${f1(-cw)} ${f1(noseZ)} 0 ${f1(noseZ - 0.35)}Q${f1(cw)} ${f1(noseZ)} ${f1(cw)} ${f1(hullZ0 + 0.3)}Z` });
  pieces.push({ part: 'canopy', d: capsule(0, zC - C * 0.3, zC + C * 0.12, cw * 0.55, cw * 0.5) });
  for (const [s, k] of [[-1, 'L'], [1, 'R']] as const) {
    pieces.push({ part: `stab${k}`, d: poly([[s * cw * 0.8, zC + C * 0.2], [s * (cw + 0.55), zC + C * 0.4], [s * (cw + 0.55), zC + C * 0.5], [s * cw * 0.8, zC + C * 0.42]]) });
  }
  pieces.push({ part: 'tail', d: capsule(0, zC + C / 2 - 0.3, zC + C / 2 + 0.25, cw * 0.6, 0.12) });
  // An X over each critical part for when it is gone, so a lost engine or cockpit reads at a glance.
  const cross = (x: number, z: number, hw: number, hh: number) =>
    `M${f1(x - hw)} ${f1(z - hh)}L${f1(x + hw)} ${f1(z + hh)}M${f1(x + hw)} ${f1(z - hh)}L${f1(x - hw)} ${f1(z + hh)}`;
  const crosses: Partial<Record<PartId, string>> = {
    nacelleL: cross(-xE, zE, w, L * 0.36),
    nacelleR: cross(xE, zE, w, L * 0.36),
    hull: cross(0, zC + C * 0.05, cw, C * 0.4),
  };
  const x0 = -(xE + w + 1.25);
  const z0 = front - 0.13 * L - 0.3;
  const z1 = zC + C / 2 + 0.45;
  return { pieces, crosses, viewBox: `${f1(x0)} ${f1(z0)} ${f1(-2 * x0)} ${f1(z1 - z0)}` };
}

const SCHEMATIC = podSchematic(PODS[0].shape);
const CRITICAL = PART_IDS.filter((id) => PARTS[id].critical);

/** Health colour: pale green-white when intact, through green and amber to red. */
function healthColor(h: number) {
  const k = Math.max(0, Math.min(1, (h - 0.12) / 0.88));
  return `hsl(${Math.round(120 * k ** 0.9)} 85% ${Math.round(50 + 34 * h * h)}%)`;
}

/**
 * Per-part damage: the pod schematic with each part filled by its health, a flash on every part that just lost health
 * (diffed against the previous publish), the critical parts (engines, cockpit) outlined heavier and blinking when low,
 * broken parts left as a dark dashed ghost, and the name of the last part lost under it for a moment.
 */
const DamageDiagram = memo(function DamageDiagram({ view }: P) {
  const parts = useHud(view, (s) => s.parts);
  const prev = useRef<Record<PartId, number> | undefined>(undefined);
  // Per-part hit counters: a new count re-keys the piece, which restarts its flash animation.
  const hits = useRef<Partial<Record<PartId, number>>>({});
  const [lost, setLost] = useState<{ name: string; n: number } | null>(null);
  const lostN = useRef(0);
  const pending = useRef<PartId | null>(null);

  // Diffed during render so the flash shows on the very render that brings the new health; the refs make it run
  // once per published object (the view only publishes a new one when something changed).
  if (parts && parts !== prev.current) {
    const old = prev.current;
    let broke: PartId | null = null;
    if (old) {
      for (const id of PART_IDS) {
        if (parts[id] < old[id] - 0.005) hits.current[id] = (hits.current[id] ?? 0) + 1;
        // One name per hit: a nacelle or the cockpit outranks the bits it takes with it.
        if (parts[id] <= 0 && old[id] > 0 && (!broke || (PARTS[id].critical && !PARTS[broke].critical))) broke = id;
      }
    }
    prev.current = parts;
    if (broke) pending.current = broke;
  }
  useEffect(() => {
    const id = pending.current;
    pending.current = null;
    if (id) setLost({ name: PARTS[id].name, n: ++lostN.current });
  }, [parts]);
  useEffect(() => {
    if (!lost) return;
    const t = setTimeout(() => setLost(null), 2200);
    return () => clearTimeout(t);
  }, [lost]);

  if (!parts) return null;
  return (
    <div className="hud-pod">
      <svg className="hud-pod-svg" viewBox={SCHEMATIC.viewBox} aria-hidden>
        {SCHEMATIC.pieces.map(({ part, d, line }, i) => {
          const h = Math.max(0, Math.min(1, parts[part] ?? 1));
          const n = hits.current[part] ?? 0;
          const state = h <= 0 ? ' broken' : h < 0.35 ? ' low' : '';
          const cls = `hud-pod-part${line ? (part.startsWith('cable') ? ' line thin' : ' line') : ''}${PARTS[part].critical ? ' crit' : ''}${state}${n ? ' hit' : ''}`;
          const c = healthColor(h);
          return <path key={`${i}.${n}`} className={cls} d={d} style={h <= 0 ? undefined : line ? { stroke: c } : { fill: c }} />;
        })}
        {CRITICAL.map((id) => (parts[id] ?? 1) <= 0 && <path key={id} className="hud-pod-cross" d={SCHEMATIC.crosses[id]} />)}
      </svg>
      <span className="hud-pod-label">POD</span>
      {lost && <span key={lost.n} className="hud-pod-lost">{lost.name} lost</span>}
    </div>
  );
});

export const Wrecked = memo(function Wrecked({ view }: P) {
  const left = useHud(view, (s) => Math.ceil(s.wrecked * 2) / 2);
  if (left <= 0) return null;
  return (
    <div className="hud-center">
      <div className="hud-wrecked">
        <div className="hud-wrecked-title">WRECKED</div>
        <div className="hud-wrecked-sub">Back on the course in {left.toFixed(1)}</div>
      </div>
    </div>
  );
});

export const WrongWay = memo(function WrongWay({ view }: P) {
  const ww = useHud(view, (s) => s.wrongWay && s.phase === 'racing');
  if (!ww) return null;
  return (
    <div className="hud-wrongway">
      <span>WRONG WAY</span>
    </div>
  );
});

export const FinishBanner = memo(function FinishBanner({ view }: P) {
  const finished = useHud(view, (s) => s.phase === 'finished');
  const pos = useHud(view, (s) => s.position);
  const time = useHud(view, (s) => (s.phase === 'finished' ? fmtTime(s.time) : ''));
  if (!finished) return null;
  return (
    <div className="hud-center">
      <div className={`hud-finish${pos === 1 ? ' win' : ''}`}>
        <div className="hud-finish-title">
          FINISHED <span>·</span> <b>{ordinal(pos)}</b>
        </div>
        <div className="hud-finish-time">{time}</div>
      </div>
    </div>
  );
});

export const IntroHint = memo(function IntroHint({ view, touch }: P & { touch: boolean }) {
  const show = useHud(view, (s) => s.phase === 'intro' || s.phase === 'countdown');
  const track = useHud(view, (s) => s.trackName);
  if (!show) return null;
  return (
    <div className="hud-hint">
      <div className="hud-hint-track">{track}</div>
      {touch ? (
        <div className="hud-hint-keys">
          <span><b>Drag left</b> steer</span>
          <span><b>THRUST</b> / <b>BRAKE</b> hold</span>
          <span><b>BOOST</b> tap</span>
        </div>
      ) : (
        <div className="hud-hint-keys">
          <span><kbd>W</kbd><kbd>↑</kbd> thrust</span>
          <span><kbd>S</kbd><kbd>↓</kbd> brake</span>
          <span><kbd>A</kbd><kbd>D</kbd> steer</span>
          <span><kbd>Q</kbd><kbd>E</kbd> on its side</span>
          <span><kbd>Space</kbd><kbd>Shift</kbd> boost</span>
          <span className="pad">gamepad works</span>
        </div>
      )}
    </div>
  );
});
