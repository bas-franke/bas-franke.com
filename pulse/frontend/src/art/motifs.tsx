// Small painted building blocks for the placeholder scenes. Colours come from the theme variables through color-mix,
// so every motif adapts to light and dark. Origins: most motifs sit with (0,0) at the bottom centre.
import type { ReactNode } from 'react';

/** Theme colour `a` at p % over `b` (a theme variable name, default the card colour). */
export const m = (a: string, p: number, b = 'card') => `color-mix(in srgb, var(--${a}) ${p}%, var(--${b}))`;
/** Style object that fills with a colour. */
export const f = (fill: string, extra: Record<string, string | number> = {}) => ({ style: { fill, ...extra } });
export const st = (stroke: string, w: number, extra: Record<string, string | number> = {}) => ({
  style: { fill: 'none', stroke, strokeWidth: w, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, ...extra },
});
/** Deterministic pseudo random 0..1. */
export const rnd = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export const NIGHT = ['#1c2540', '#3b4472'];

export const G = ({ x = 0, y = 0, s = 1, r = 0, children }: { x?: number; y?: number; s?: number; r?: number; children?: ReactNode }) => (
  <g transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`}>{children}</g>
);

export const Grad = ({ id, a, b, dir = 'v' }: { id: string; a: string; b: string; dir?: 'v' | 'h' }) => (
  <linearGradient id={id} x1="0" y1="0" x2={dir === 'h' ? 1 : 0} y2={dir === 'h' ? 0 : 1}>
    <stop offset="0" style={{ stopColor: a }} />
    <stop offset="1" style={{ stopColor: b }} />
  </linearGradient>
);
export const Glow = ({ id, c }: { id: string; c: string }) => (
  <radialGradient id={id}>
    <stop offset="0" style={{ stopColor: c, stopOpacity: 0.85 }} />
    <stop offset="1" style={{ stopColor: c, stopOpacity: 0 }} />
  </radialGradient>
);

export const Bg = ({ id, w, h }: { id: string; w: number; h: number }) => <rect width={w} height={h} fill={`url(#${id})`} />;

/** Layered rolling hills; layers go back to front, each [colour, amplitude]. */
export function Hills({ w, h, y, gap = 40, layers }: { w: number; h: number; y: number; gap?: number; layers: [string, number][] }) {
  return (
    <>
      {layers.map(([c, amp], i) => {
        const b = y + i * gap;
        const s = i % 2 ? -1 : 1;
        const d = `M0 ${h} V${b} C${w * 0.18} ${b - amp * s}, ${w * 0.38} ${b + amp * s}, ${w * 0.58} ${b - amp * 0.3 * s} S${w * 0.88} ${b - amp * s}, ${w} ${b + amp * 0.2 * s} V${h}Z`;
        return <path key={i} d={d} {...f(c)} />;
      })}
    </>
  );
}

export const Sun = ({ x, y, r, c }: { x: number; y: number; r: number; c: string }) => (
  <g>
    <circle cx={x} cy={y} r={r * 2.1} {...f(c, { opacity: 0.16 })} />
    <circle cx={x} cy={y} r={r * 1.5} {...f(c, { opacity: 0.26 })} />
    <circle cx={x} cy={y} r={r} {...f(c)} />
  </g>
);

export const Moon = ({ x, y, r }: { x: number; y: number; r: number }) => (
  <g>
    <circle cx={x} cy={y} r={r * 1.9} {...f('#f4e6c0', { opacity: 0.12 })} />
    <circle cx={x} cy={y} r={r} {...f('#f4e6c0')} />
    <circle cx={x - r * 0.3} cy={y - r * 0.2} r={r * 0.2} {...f('#e5d3a6')} />
    <circle cx={x + r * 0.35} cy={y + r * 0.3} r={r * 0.26} {...f('#e5d3a6')} />
  </g>
);

export const Stars = ({ w, h, n = 40, seed = 1 }: { w: number; h: number; n?: number; seed?: number }) => (
  <g>
    {Array.from({ length: n }, (_, i) => (
      <circle key={i} cx={rnd(i + seed) * w} cy={rnd(i * 3 + seed + 9) * h} r={0.8 + rnd(i + 50) * 1.8} {...f('#fff3d6', { opacity: 0.35 + rnd(i + 7) * 0.5 })} />
    ))}
  </g>
);

export const Cloud = ({ x, y, s = 1, c = '#ffffff', o = 0.85 }: { x: number; y: number; s?: number; c?: string; o?: number }) => (
  <G x={x} y={y} s={s}>
    <g {...f(c, { opacity: o })}>
      <ellipse cx="0" cy="0" rx="46" ry="16" />
      <circle cx="-14" cy="-12" r="18" />
      <circle cx="12" cy="-18" r="22" />
      <circle cx="32" cy="-6" r="14" />
    </g>
  </G>
);

export const Plant = ({ x, y, s = 1, leaf = m('green', 85), pot = m('accent', 80) }: { x: number; y: number; s?: number; leaf?: string; pot?: string }) => (
  <G x={x} y={y} s={s}>
    <ellipse cx="0" cy="-70" rx="12" ry="34" transform="rotate(-30 0 -30)" {...f(leaf)} />
    <ellipse cx="0" cy="-70" rx="12" ry="34" transform="rotate(30 0 -30)" {...f(leaf)} />
    <ellipse cx="0" cy="-76" rx="13" ry="40" {...f(m('green', 68))} />
    <path d="M-20 -32H20L15 0H-15Z" {...f(pot)} />
    <rect x="-23" y="-39" width="46" height="11" rx="5.5" {...f(m('accent', 68))} />
  </G>
);

export const Mug = ({ x, y, s = 1, c = m('blue', 70), steam = true }: { x: number; y: number; s?: number; c?: string; steam?: boolean }) => (
  <G x={x} y={y} s={s}>
    {steam && (
      <g {...st(m('ink', 30, 'bg-2'), 3.5)}>
        <path className="steam" d="M-8 -48c-8-8 8-14 0-24" />
        <path className="steam s2" d="M6 -48c-8-8 8-14 0-24" />
      </g>
    )}
    <path d="M23 -30q17 0 17 10t-17 10" {...st(c, 6)} />
    <path d="M-22 -40H22V-9Q22 0 12 0H-12Q-22 0 -22 -9Z" {...f(c)} />
    <rect x="-22" y="-40" width="44" height="7" rx="3.5" {...f('#fff', { opacity: 0.25 })} />
  </G>
);

export const Cup = ({ x, y, s = 1, c = m('rose', 55), steam = false }: { x: number; y: number; s?: number; c?: string; steam?: boolean }) => (
  <G x={x} y={y} s={s}>
    {steam && (
      <g {...st(m('ink', 28, 'bg-2'), 3)}>
        <path className="steam" d="M-4 -40c-7-7 7-12 0-21" />
      </g>
    )}
    <ellipse cx="0" cy="2" rx="34" ry="6" {...f(m('ink', 12, 'bg-2'), { opacity: 0.5 })} />
    <path d="M18 -26q14 0 14 8t-14 8" {...st(c, 5)} />
    <path d="M-20 -32H20Q20 0 0 0T-20 -32Z" {...f(c)} />
    <ellipse cx="0" cy="-32" rx="20" ry="5" {...f(m('accent', 45, 'ink'), { opacity: 0.55 })} />
  </G>
);

export const Lamp = ({ x, y, s = 1, lit = true, id }: { x: number; y: number; s?: number; lit?: boolean; id: string }) => (
  <G x={x} y={y} s={s}>
    {lit && <circle cx="0" cy="-92" r="170" fill={`url(#${id})`} />}
    <ellipse cx="0" cy="-2" rx="30" ry="7" {...f(m('ink', 55, 'bg-2'))} />
    <rect x="-4" y="-96" width="8" height="94" rx="4" {...f(m('ink', 55, 'bg-2'))} />
    <path d="M-16 -148H16L34 -92H-34Z" {...f(lit ? '#f7c96b' : m('gold', 70))} />
    {lit && <ellipse cx="0" cy="-92" rx="34" ry="6" {...f('#fff1c4', { opacity: 0.9 })} />}
  </G>
);

export const Books = ({ x, y, s = 1, lamp = false }: { x: number; y: number; s?: number; lamp?: boolean }) => (
  <G x={x} y={y} s={s}>
    <rect x="-56" y="-20" width="112" height="20" rx="4" {...f(m('blue', 75))} />
    <rect x="-46" y="-42" width="96" height="22" rx="4" transform="rotate(-2 0 -30)" {...f(m('accent', 80))} />
    <rect x="-50" y="-62" width="90" height="20" rx="4" transform="rotate(2 0 -50)" {...f(m('green', 75))} />
    <rect x="-44" y="-80" width="80" height="18" rx="4" transform="rotate(-3 0 -70)" {...f(m('gold', 80))} />
    <path d="M-52 -10H52M-40 -31H46M-44 -51H36" {...st(m('card', 90), 2, { opacity: 0.6 })} />
    {lamp && <circle cx="0" cy="-100" r="6" {...f('#f7c96b')} />}
  </G>
);

export const Kettle = ({ x, y, s = 1, c = m('blue', 70), anim = false }: { x: number; y: number; s?: number; c?: string; anim?: boolean }) => (
  <G x={x} y={y} s={s}>
    <g {...st(m('ink', 30, 'bg-2'), 5)}>
      <path className={anim ? 'steam' : undefined} d="M-6 -86c-12-10 12-18 0-34" />
      <path className={anim ? 'steam s2' : undefined} d="M14 -88c-12-10 12-18 0-34" />
    </g>
    <path d="M32 -56q36 -8 30 -44" {...st(m('ink', 50, 'bg-2'), 5)} />
    <path d="M-30 -52L-62 -78" {...st(c, 9)} />
    <path d="M-40 -34Q-40 -80 0 -80T40 -34Q40 0 0 0T-40 -34Z" {...f(c)} />
    <path d="M-22 -72Q0 -88 22 -72Z" {...f(m('ink', 40, 'bg-2'))} />
    <circle cx="0" cy="-84" r="5" {...f(m('ink', 55, 'bg-2'))} />
    <path d="M-30 -44Q-26 -62 -8 -66" {...st('#fff', 4, { opacity: 0.35 })} />
  </G>
);

export const Tree = ({ x, y, s = 1, c = m('green', 80), trunk = m('accent', 40, 'ink') }: { x: number; y: number; s?: number; c?: string; trunk?: string }) => (
  <G x={x} y={y} s={s}>
    <rect x="-7" y="-70" width="14" height="70" rx="6" {...f(trunk)} />
    <circle cx="0" cy="-100" r="42" {...f(c)} />
    <circle cx="-26" cy="-78" r="26" {...f(c)} />
    <circle cx="28" cy="-80" r="28" {...f(c)} />
  </G>
);

export const Pine = ({ x, y, s = 1, c = m('green', 60, 'ink'), snow = false }: { x: number; y: number; s?: number; c?: string; snow?: boolean }) => (
  <G x={x} y={y} s={s}>
    <rect x="-5" y="-14" width="10" height="14" {...f(m('accent', 30, 'ink'))} />
    <path d="M0 -120L28 -60H-28Z M0 -90L38 -26H-38Z" {...f(c)} />
    {snow && <path d="M0 -120L12 -96Q0 -102 -12 -96Z M0 -90L16 -62Q0 -68 -16 -62Z" {...f('#fff', { opacity: 0.85 })} />}
  </G>
);

export const Flower = ({ x, y, s = 1, c = m('rose', 80), h = 40 }: { x: number; y: number; s?: number; c?: string; h?: number }) => (
  <G x={x} y={y} s={s}>
    <path d={`M0 0V${-h}`} {...st(m('green', 75), 3)} />
    {[0, 72, 144, 216, 288].map((a) => (
      <circle key={a} cx={Math.cos((a * Math.PI) / 180) * 7} cy={-h + Math.sin((a * Math.PI) / 180) * 7} r="6" {...f(c)} />
    ))}
    <circle cx="0" cy={-h} r="4" {...f(m('gold', 90))} />
  </G>
);

export const Leaf = ({ x, y, r = 0, s = 1, c }: { x: number; y: number; r?: number; s?: number; c: string }) => (
  <G x={x} y={y} s={s} r={r}>
    <path d="M0 -14Q12 -2 0 14Q-12 -2 0 -14Z" {...f(c)} />
    <path d="M0 -10V12" {...st('#fff', 1.5, { opacity: 0.35 })} />
  </G>
);

export const Rain = ({ w, h, n = 60, o = 0.35, c = '#cfe0ff' }: { w: number; h: number; n?: number; o?: number; c?: string }) => (
  <g {...st(c, 2.4, { opacity: o })}>
    {Array.from({ length: n }, (_, i) => {
      const x = rnd(i + 3) * w;
      const y = rnd(i * 5 + 1) * h;
      return <path key={i} d={`M${x} ${y}l-6 26`} />;
    })}
  </g>
);

/** A wall with a rounded window hole, plus frame and mullions. Draw the outside scene before it. */
export function Win({ W, H, x, y, w, h, r = 28, wall, frame, bars = true }: { W: number; H: number; x: number; y: number; w: number; h: number; r?: number; wall: string; frame: string; bars?: boolean }) {
  const hole = `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
  return (
    <g>
      <path d={`M0 0H${W}V${H}H0Z ${hole}`} fillRule="evenodd" {...f(wall)} />
      <path d={hole} {...st(frame, 14)} />
      {bars && <path d={`M${x + w / 2} ${y}V${y + h}M${x} ${y + h * 0.52}H${x + w}`} {...st(frame, 9)} />}
    </g>
  );
}

export const Sill = ({ x, y, w, c }: { x: number; y: number; w: number; c: string }) => (
  <g>
    <rect x={x} y={y} width={w} height="26" rx="10" {...f(c)} />
    <rect x={x + 14} y={y + 26} width={w - 28} height="10" rx="5" {...f(m('ink', 20, 'bg-2'), { opacity: 0.3 })} />
  </g>
);

export const Pen = ({ x, y, r = 0, s = 1 }: { x: number; y: number; r?: number; s?: number }) => (
  <G x={x} y={y} r={r} s={s}>
    <rect x="-40" y="-4" width="80" height="8" rx="4" {...f(m('gold', 85))} />
    <path d="M40 -4L58 0L40 4Z" {...f(m('ink', 70, 'bg-2'))} />
    <rect x="-40" y="-4" width="16" height="8" rx="4" {...f(m('rose', 80))} />
  </G>
);

export const Notebook = ({ x, y, s = 1, r = 0, open = false, c = m('accent', 78) }: { x: number; y: number; s?: number; r?: number; open?: boolean; c?: string }) => (
  <G x={x} y={y} s={s} r={r}>
    {open ? (
      <>
        <path d="M-90 -6L0 4L90 -6V-70L0 -58L-90 -70Z" {...f(m('card', 95, 'bg-2'))} />
        <path d="M0 4V-58" {...st(m('ink', 25, 'bg-2'), 2)} />
        <path d="M-74 -52L-14 -44M-74 -38L-14 -30M-74 -24L-14 -16M14 -44L74 -52M14 -30L74 -38M14 -16L74 -24" {...st(m('blue', 40, 'bg-2'), 2.5)} />
        <path d="M-90 -6L0 4L90 -6V0L0 10L-90 0Z" {...f(m('ink', 20, 'bg-2'))} />
      </>
    ) : (
      <>
        <rect x="-60" y="-84" width="120" height="84" rx="8" {...f(c)} />
        <rect x="-60" y="-84" width="14" height="84" rx="6" {...f(m('ink', 25, 'accent'), { opacity: 0.35 })} />
        <rect x="-20" y="-62" width="62" height="34" rx="6" {...f(m('card', 90), { opacity: 0.85 })} />
      </>
    )}
  </G>
);

export const Candle = ({ x, y, s = 1, id }: { x: number; y: number; s?: number; id: string }) => (
  <G x={x} y={y} s={s}>
    <circle cx="0" cy="-70" r="80" fill={`url(#${id})`} />
    <rect x="-13" y="-52" width="26" height="52" rx="6" {...f(m('card', 95, 'bg-2'))} />
    <path d="M0 -84Q10 -68 0 -58Q-10 -68 0 -84Z" {...f('#f7c96b')} />
    <path d="M0 -76Q4 -68 0 -62Q-4 -68 0 -76Z" {...f('#fff4d0')} />
  </G>
);
