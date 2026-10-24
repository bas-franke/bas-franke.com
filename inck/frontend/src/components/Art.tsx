import { useEffect, useState } from 'react';
import type { Category } from '../types';

// Remembered per page load, so a missing file is tried once, not once per card (and never flashes a broken image).
const missing = new Set<string>();

/**
 * Decorative illustration from /public/art (see inck/ART.md for the list and prompts).
 * Renders nothing until the file exists, so the site works with or without artwork.
 */
export default function Art({ name, fallback, className }: { name: string; fallback?: string; className?: string }) {
  const resolve = (n: string) => (missing.has(n) ? (fallback && n !== fallback && !missing.has(fallback) ? fallback : null) : n);
  const [src, setSrc] = useState<string | null>(() => resolve(name));

  useEffect(() => {
    setSrc(resolve(name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, fallback]);

  if (!src) return null;
  return (
    <img
      src={`/art/${src}.png`}
      alt=""
      aria-hidden="true"
      className={className}
      draggable={false}
      decoding="async"
      onError={() => {
        missing.add(src);
        setSrc(fallback && src !== fallback && !missing.has(fallback) ? fallback : null);
      }}
    />
  );
}

/** The existing topic icons, reused per category. */
const CATEGORY_ART: Record<Category, string> = {
  technology: 'topic-computing-ai',
  science: 'topic-space-astronomy',
  money: 'topic-economics-money',
  world: 'topic-weird-history',
  society: 'topic-design-architecture',
};

export function CategoryIcon({ category, className = 'topic-icon' }: { category: Category; className?: string }) {
  return <Art name={CATEGORY_ART[category] ?? 'topic-default'} fallback="topic-default" className={className} />;
}

/** The little flame that marks what the trend radar found hot. */
export function Flame({ className = 'flame' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M12 2c.6 3.2 2.4 5 4.2 6.9C18 10.8 19 12.6 19 15a7 7 0 0 1-14 0c0-1.8.6-3.4 1.7-4.8.3 1.2 1 2.2 2 2.9C8.3 10 9.2 6.7 12 2zm0 10c-1.5 1.6-2.5 3-2.5 4.4a2.5 2.5 0 0 0 5 0c0-1.4-1-2.8-2.5-4.4z" />
    </svg>
  );
}

/** Five little bars, filled up to the topic's heat. */
export function HeatMeter({ heat }: { heat: number }) {
  return (
    <span className="heat-meter" title={`${heat}/5`} aria-label={`heat ${heat} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= heat ? 'on' : ''} />
      ))}
    </span>
  );
}
