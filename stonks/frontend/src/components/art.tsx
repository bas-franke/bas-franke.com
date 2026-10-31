// The owner's artwork. Every picture is a named slot: a file src/assets/art/<slot>.webp. Dropping a file in is all it
// takes (tools/art_import.py makes them from the generated PNGs). <slot>-dark.webp, when it exists, replaces the slot in
// the dark theme. A slot without a file shows its placeholder, or the fallback the caller gives.
import type { ReactNode } from 'react';
import { useIsDark } from '../theme';
import { WatchingCat } from './icons';

const files = import.meta.glob('../assets/art/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const artUrl = (slot: string): string | undefined => files[`../assets/art/${slot}.webp`];

/** A slot's picture for the current theme. `night` says it was painted for the dark theme, so CSS doesn't dim it. */
export function useArt(slot: string) {
  const dark = useIsDark();
  const night = dark ? artUrl(`${slot}-dark`) : undefined;
  return { src: night ?? artUrl(slot), night: !!night };
}

/** Where a picture will go, with the slot's name so the file to make is easy to find in ART.md. */
function ArtPlaceholder({ slot, className = '' }: { slot: string; className?: string }) {
  return (
    <span className={`art-ph ${className}`} aria-hidden="true" title={slot}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <circle cx="8.5" cy="9.5" r="1.6" />
        <path d="m4 17 5-4.5 3.5 3 3-2.5L20 17" />
      </svg>
      <span className="art-ph-name">{slot}</span>
    </span>
  );
}

/** One slot: its picture, or `fallback`, or the placeholder. Decorative unless given `alt`. */
export function Art({ slot, className, alt = '', fallback, width, height }: { slot: string; className?: string; alt?: string; fallback?: ReactNode; width?: number; height?: number }) {
  const { src, night } = useArt(slot);
  if (!src) return fallback !== undefined ? <>{fallback}</> : <ArtPlaceholder slot={slot} className={className} />;
  return <img className={className} src={src} alt={alt} width={width} height={height} data-night={night || undefined} />;
}

/**
 * The hero follows the clock, like the greeting, and the theme: the light theme only ever shows daylight, the dark one
 * dusk and night. Until a time of day has its own painting, dusk stands in.
 */
export const heroSlot = (dark: boolean, hour = new Date().getHours()) =>
  dark ? (hour >= 6 && hour < 22 ? 'hero-dusk' : 'hero-night') : hour >= 5 && hour < 11 ? 'hero-morning' : 'hero-day';

export function HeroBanner({ children }: { children: ReactNode }) {
  const slot = heroSlot(useIsDark());
  const src = artUrl(slot);
  return (
    <section className="hero">
      <img className="hero-art" src={src ?? artUrl('hero-dusk')} alt="" />
      <div className="hero-copy">{children}</div>
    </section>
  );
}

/** A page's title on a painted strip: words on the left, the picture fading in from the right. */
export function PageBanner({ art, eyebrow, title, lede, aside }: { art: string; eyebrow: ReactNode; title: ReactNode; lede?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="page-banner">
      <Art slot={art} className="page-banner-art" />
      <div className="page-banner-copy">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
        {aside && <div className="page-banner-aside">{aside}</div>}
      </div>
    </header>
  );
}

export type Mood = 'awake' | 'asleep' | 'trouble';

/** The cat that shows how the bot is doing. */
export function CatArt({ mood, width = 150 }: { mood: Mood; width?: number }) {
  const sleeping = <img src={artUrl('cat-asleep')} width={width} alt="" />;
  return <Art slot={`cat-${mood}`} width={width} fallback={mood === 'asleep' ? sleeping : <WatchingCat width={width} height={(width * 2) / 3} />} />;
}

export const SleepingCatArt = ({ className = 'empty-art', width = 300, art = 'cat-asleep' }: { className?: string; width?: number; art?: string }) => (
  <img
    className={className}
    src={artUrl(art) ?? artUrl('cat-asleep')}
    width={width}
    height={Math.round((width * 283) / 360)}
    alt="A white cat asleep by a tablet showing candles, with a lamp and a cup of tea"
  />
);

export function EmptyState({ title, children, action, art }: { title: string; children?: ReactNode; action?: ReactNode; art?: string }) {
  return (
    <div className="empty">
      <SleepingCatArt art={art} />
      <h3>{title}</h3>
      {children && <p className="small" style={{ maxWidth: '46ch' }}>{children}</p>}
      {action}
    </div>
  );
}

/** A coin's picture, or its letters until it has one. */
export function Coin({ symbol }: { symbol: string }) {
  const src = artUrl(`coin-${symbol.toLowerCase()}`);
  return src ? <img className="coin-art" src={src} width={34} height={34} alt="" /> : <span className={`coin ${symbol}`}>{symbol.slice(0, 4)}</span>;
}
