import type { ReactElement } from 'react';
import type { MotifKind } from '../content';

/**
 * Procedural line drawings in the site's own ink. They stand in for the artwork
 * described in ART.md until it exists, and adapt to light and dark mode on their own.
 */

const W = 600;
const H = 400;

function wave(y: number, amplitude: number, phase: number, step = 12): string {
  const parts: string[] = [];
  for (let x = 0; x <= W; x += step) {
    const yy = y + Math.sin((x / W) * Math.PI * 2 + phase) * amplitude;
    parts.push(`${x === 0 ? 'M' : 'L'}${x} ${yy.toFixed(1)}`);
  }
  return parts.join(' ');
}

function Horizon() {
  const rows = [192, 204, 218, 234, 252, 272, 294, 318, 344, 372, 400];
  return (
    <>
      <circle cx="430" cy="118" r="44" className="line" opacity=".7" />
      <line x1="0" y1="186" x2={W} y2="186" className="line" opacity=".75" />
      {rows.map((y, i) => (
        <path key={y} d={wave(y, 1.5 + i * 0.35, i * 0.9)} className="line" opacity={0.55 - i * 0.045} />
      ))}
    </>
  );
}

function Rise() {
  return (
    <>
      {[70, 110, 150, 190, 230, 270, 310, 350].map((y) => (
        <line key={y} x1="40" y1={y} x2="560" y2={y} className="line" opacity=".22" />
      ))}
      <path d="M40 300 C 170 300, 240 230, 320 178 S 470 100, 560 72" className="accent" />
      <circle cx="560" cy="72" r="4" className="accent-fill" />
    </>
  );
}

function Ledger() {
  const cols = Array.from({ length: 11 }, (_, i) => 60 + i * 48);
  const rows = Array.from({ length: 8 }, (_, i) => 60 + i * 40);
  const filled: [number, number, number][] = [[3, 2, 0.35], [4, 2, 0.35], [6, 4, 0.6], [7, 5, 0.3], [2, 5, 0.25], [8, 1, 0.3]];
  return (
    <>
      {cols.map((x) => (
        <line key={`c${x}`} x1={x} y1="60" x2={x} y2="340" className="line" opacity=".28" />
      ))}
      {rows.map((y) => (
        <line key={`r${y}`} x1="60" y1={y} x2="540" y2={y} className="line" opacity=".28" />
      ))}
      {filled.map(([c, r, o]) => (
        <rect key={`${c}-${r}`} x={60 + c * 48} y={60 + r * 40} width="48" height="40" className="accent-fill" opacity={o} />
      ))}
    </>
  );
}

function Ripples() {
  const radii = [18, 42, 70, 102, 138, 178, 222, 270];
  return (
    <>
      {radii.map((r, i) => (
        <circle key={r} cx="300" cy="200" r={r} className="line" opacity={0.6 - i * 0.07} />
      ))}
    </>
  );
}

function Drop() {
  const ripples = [30, 70, 120, 180, 250];
  return (
    <>
      <line x1="300" y1="30" x2="300" y2="150" className="line" opacity=".5" />
      <ellipse cx="300" cy="172" rx="7" ry="10" className="ink-fill" opacity=".85" />
      {ripples.map((rx, i) => (
        <ellipse key={rx} cx="300" cy="300" rx={rx} ry={rx * 0.32} className="line" opacity={0.55 - i * 0.1} />
      ))}
    </>
  );
}

function Pulse() {
  return (
    <>
      <line x1="40" y1="120" x2="560" y2="120" className="line" opacity=".18" />
      <line x1="40" y1="280" x2="560" y2="280" className="line" opacity=".18" />
      <line x1="40" y1="200" x2="250" y2="200" className="line" opacity=".6" />
      <line x1="350" y1="200" x2="560" y2="200" className="line" opacity=".6" />
      <path d="M250 200 L268 200 L283 150 L300 250 L316 200 L350 200" className="accent" />
    </>
  );
}

function Fold() {
  return (
    <>
      <rect x="166" y="96" width="300" height="240" className="line" opacity=".25" />
      <rect x="150" y="80" width="300" height="240" className="line" opacity=".65" />
      <line x1="150" y1="80" x2="450" y2="320" className="line" opacity=".3" />
      <line x1="190" y1="130" x2="300" y2="130" className="accent" />
      <line x1="190" y1="152" x2="262" y2="152" className="line" opacity=".45" />
      <line x1="190" y1="174" x2="282" y2="174" className="line" opacity=".45" />
    </>
  );
}

const drawings: Record<MotifKind, () => ReactElement> = {
  horizon: Horizon,
  rise: Rise,
  ledger: Ledger,
  ripples: Ripples,
  drop: Drop,
  pulse: Pulse,
  fold: Fold,
};

export default function Motif({ kind }: { kind: MotifKind }) {
  const Drawing = drawings[kind];
  return (
    <svg className={`motif motif--${kind}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <Drawing />
    </svg>
  );
}
