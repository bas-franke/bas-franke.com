// Small shared pieces of the menus: the painted track thumbnail with its outline, credits, tier badges, pod swatches,
// the trophy, the top bar and the slanted button.

import { useEffect, useRef, type ReactNode } from 'react';
import { Track } from '../core/track';
import { trackById, type TrackDef } from '../core/tracks';
import type { PodDesign } from '../core/pods';
import { menuAudio } from '../audio/menu';
import { focusFirst } from './menuNav';
import { fmtCredits } from './menuStore';

const outlines = new Map<string, { d: string; start: [number, number]; finish: [number, number]; km: number }>();

/** SVG path of a course's outline in a 0..100 box, its start and finish points and race length. Cached per track. */
export function trackOutline(id: string) {
  let o = outlines.get(id);
  if (!o) {
    const t = new Track(trackById(id));
    const pts = t.minimap.points.filter((_, i, a) => i % 3 === 0 || i === a.length - 1);
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * 100).toFixed(1)} ${(y * 100).toFixed(1)}`).join(' ');
    const at = (s: number): [number, number] => {
      const [x, y] = t.minimap.project(t.frameAt(s).pos);
      return [x * 100, y * 100];
    };
    o = { d, start: at(t.startS), finish: at(t.finishS), km: t.raceLength / 1000 };
    outlines.set(id, o);
  }
  return o;
}

export function TrackOutline({ id, className }: { id: string; className?: string }) {
  const o = trackOutline(id);
  return (
    <svg className={className ?? 'dr-outline'} viewBox="-8 -8 116 116" aria-hidden>
      <path d={o.d} className="dr-outline-under" />
      <path d={o.d} className="dr-outline-line" />
      <rect x={o.start[0] - 4} y={o.start[1] - 4} width="8" height="8" className="dr-outline-start" />
      <circle cx={o.finish[0]} cy={o.finish[1]} r="4.5" className="dr-outline-start" />
    </svg>
  );
}

/** A tiny painting of the track's theme: sky, sun, mesas in their rock colours, dirt; the outline over it. */
export function TrackThumb({ def, outline = true }: { def: TrackDef; outline?: boolean }) {
  const th = def.theme;
  const sunY = 58 - Math.min(1, th.sunElevation / 0.6) * 46;
  const sunX = 20 + ((Math.sin(th.sunAzimuth) + 1) / 2) * 120;
  const g = `g-${def.id}`;
  // A per-track skyline so cards do not all look alike.
  const r = (i: number) => {
    const x = Math.sin(def.seed * 12.9898 + i * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const far = Array.from({ length: 7 }, (_, i) => [i * 28 - 6 + r(i) * 10, 44 + r(i + 9) * 14] as const);
  const farPath = `M0 90 L0 60 ${far.map(([x, y]) => `L${x} ${y} L${x + 14} ${y} L${x + 18} 60`).join(' ')} L160 60 L160 90 Z`;
  const spire = 30 + r(3) * 100;
  return (
    <svg className="dr-thumb" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <linearGradient id={`${g}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={th.skyTop} />
          <stop offset="1" stopColor={th.skyHorizon} />
        </linearGradient>
        <linearGradient id={`${g}-rock`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={th.rockLit} />
          <stop offset="0.35" stopColor={th.rockStrata} />
          <stop offset="0.45" stopColor={th.rockLit} />
          <stop offset="1" stopColor={th.rockShade} />
        </linearGradient>
        <linearGradient id={`${g}-dirt`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={th.sand} />
          <stop offset="1" stopColor={th.dirt} />
        </linearGradient>
      </defs>
      <rect width="160" height="90" fill={`url(#${g}-sky)`} />
      <circle cx={sunX} cy={sunY} r="14" fill={th.sunColor} opacity="0.35" />
      <circle cx={sunX} cy={sunY} r="6" fill={th.sunColor} />
      <path d={farPath} fill={th.haze} opacity="0.85" />
      <path d={`M${spire} 70 L${spire + 3} 30 L${spire + 9} 28 L${spire + 12} 70 Z`} fill={th.rockLit} opacity="0.9" />
      <path d="M-4 90 L-4 50 L18 48 L26 56 L40 55 L46 68 L70 72 L110 74 L122 58 L140 56 L150 46 L164 46 L164 90 Z" fill={`url(#${g}-rock)`} />
      <path d="M0 78 Q80 66 160 80 L160 90 L0 90 Z" fill={`url(#${g}-dirt)`} />
      {outline && (
        <g transform="translate(96 8) scale(0.56)">
          <TrackOutlineInline id={def.id} />
        </g>
      )}
    </svg>
  );
}

function TrackOutlineInline({ id }: { id: string }) {
  const o = trackOutline(id);
  return (
    <>
      <path d={o.d} className="dr-outline-under" />
      <path d={o.d} className="dr-outline-line" />
      <rect x={o.start[0] - 4} y={o.start[1] - 4} width="8" height="8" className="dr-outline-start" />
      <circle cx={o.finish[0]} cy={o.finish[1]} r="4.5" className="dr-outline-start" />
    </>
  );
}

export function Credits({ n, delta }: { n: number; delta?: number }) {
  return (
    <span className="dr-credits">
      <CreditIcon />
      <b>{fmtCredits(n)}</b>
      <small>CR</small>
      {delta ? <em className="dr-credits-delta">+{fmtCredits(delta)}</em> : null}
    </span>
  );
}

export function CreditIcon() {
  return (
    <svg className="dr-credit-icon" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1 L15 8 L8 15 L1 8 Z" />
      <path d="M8 4.5 L11.5 8 L8 11.5 L4.5 8 Z" className="dr-credit-icon-in" />
    </svg>
  );
}

export function TierBadge({ tier, big }: { tier: string; big?: boolean }) {
  return <span className={`dr-tier dr-tier-${tier}${big ? ' dr-tier-big' : ''}`}>{tier}</span>;
}

export function PodSwatch({ pod }: { pod: PodDesign }) {
  return (
    <span
      className="dr-swatch"
      style={{ background: `linear-gradient(90deg, ${pod.livery.primary} 0 55%, ${pod.livery.secondary} 55% 80%, ${pod.livery.glow} 80%)` }}
      aria-hidden
    />
  );
}

export function Trophy({ place = 1 }: { place?: number }) {
  const col = place === 1 ? ['#ffe27a', '#f2b51e', '#a8650c'] : place === 2 ? ['#f1f4f8', '#b9c3cf', '#6c7787'] : ['#ffc29a', '#d9773f', '#7b3a17'];
  return (
    <svg className="dr-trophy" viewBox="0 0 120 140" aria-hidden>
      <defs>
        <linearGradient id={`tro-${place}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={col[0]} />
          <stop offset="0.55" stopColor={col[1]} />
          <stop offset="1" stopColor={col[2]} />
        </linearGradient>
      </defs>
      <path d="M22 18 Q4 18 6 38 Q9 58 34 62" fill="none" stroke={col[2]} strokeWidth="7" />
      <path d="M98 18 Q116 18 114 38 Q111 58 86 62" fill="none" stroke={col[2]} strokeWidth="7" />
      <path d="M20 10 L100 10 Q100 70 60 84 Q20 70 20 10 Z" fill={`url(#tro-${place})`} />
      <path d="M34 18 Q36 56 56 72" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="5" strokeLinecap="round" />
      <rect x="52" y="82" width="16" height="20" fill={col[2]} />
      <path d="M30 102 L90 102 L96 126 L24 126 Z" fill={`url(#tro-${place})`} />
      <rect x="18" y="124" width="84" height="10" rx="2" fill="#2a1a12" />
      <text x="60" y="54" textAnchor="middle" className="dr-trophy-num">
        {place}
      </text>
    </svg>
  );
}

export function TopBar({ title, sub, onBack, right }: { title: string; sub?: ReactNode; onBack(): void; right?: ReactNode }) {
  return (
    <header className="dr-topbar">
      <button
        className="dr-back"
        onClick={() => {
          menuAudio.back();
          onBack();
        }}
        aria-label="Back"
      >
        <span className="dr-back-arrow">‹</span>
        <span className="dr-back-text">Back</span>
        <kbd className="dr-hint">Esc</kbd>
      </button>
      <div className="dr-topbar-title">
        <h1>{title}</h1>
        {sub && <div className="dr-topbar-sub">{sub}</div>}
      </div>
      <div className="dr-topbar-right">{right}</div>
    </header>
  );
}

/** Slanted menu button. `kind` picks the look: primary (yellow), normal (dark), ghost. */
export function Btn(props: {
  children: ReactNode;
  onClick?(): void;
  kind?: 'primary' | 'normal' | 'ghost' | 'danger';
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      className={`dr-btn dr-btn-${props.kind ?? 'normal'} ${props.className ?? ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      data-autofocus={props.autoFocus ? '' : undefined}
      title={props.title}
    >
      <span>{props.children}</span>
    </button>
  );
}

/** An inline yes/no question; it takes the focus while open so pads and keyboards land on it. */
export function Confirm({ children }: { children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (el.current) focusFirst(el.current);
  }, []);
  return (
    <div className="dr-confirm" data-nav-layer ref={el}>
      {children}
    </div>
  );
}
