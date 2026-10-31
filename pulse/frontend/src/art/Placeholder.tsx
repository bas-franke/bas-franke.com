// Placeholder for a slot without a picture yet: a soft gradient hashed from the slot name. The art agent replaces this
// with painted SVG scenes per slot; keep the props the same.
import { slotDef } from './slots';

const PALETTES = [
  ['#f6d6a8', '#e9a07a'], ['#cfe3c4', '#8fb58a'], ['#cfdcec', '#8aa3c4'], ['#f1d3d9', '#d99aa9'],
  ['#e8ddc8', '#c9a97a'], ['#d9d2ec', '#a79bd0'],
];

export function Placeholder({ slot, className = '', alt = '' }: { slot: string; className?: string; alt?: string }) {
  let h = 0;
  for (const c of slot) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = PALETTES[h % PALETTES.length];
  const def = slotDef(slot);
  return (
    <svg
      className={`art art-ph ${className}`}
      viewBox={`0 0 ${def?.w ?? 800} ${def?.h ?? 600}`}
      preserveAspectRatio="xMidYMid slice"
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    >
      <defs>
        <linearGradient id={`g-${slot}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={a} />
          <stop offset="1" stopColor={b} />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill={`url(#g-${slot})`} />
    </svg>
  );
}
