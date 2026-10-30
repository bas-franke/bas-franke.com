// The owner's artwork. Every picture is a named slot: a file src/assets/art/<slot>.webp. Dropping a file in is all it
// takes (tools/art_import.py makes them from the generated PNGs); a slot without a file falls back to something else.
import type { ReactNode } from 'react';
import { WatchingCat } from './icons';

const files = import.meta.glob('../assets/art/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const artUrl = (slot: string): string | undefined => files[`../assets/art/${slot}.webp`];

/** The hero follows the clock, like the greeting. Until a time of day has its own painting, dusk stands in. */
export const heroSlot = (hour = new Date().getHours()) => (hour < 6 || hour >= 22 ? 'hero-night' : hour < 11 ? 'hero-morning' : hour < 18 ? 'hero-day' : 'hero-dusk');

export function HeroBanner({ children }: { children: ReactNode }) {
  return (
    <section className="hero">
      <img className="hero-art" src={artUrl(heroSlot()) ?? artUrl('hero-dusk')} alt="" />
      <div className="hero-copy">{children}</div>
    </section>
  );
}

/** A page's title on a painted strip: words on the left, the picture fading in from the right. */
export function PageBanner({ art, eyebrow, title, lede, aside }: { art: string; eyebrow: ReactNode; title: ReactNode; lede?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="page-banner">
      <img className="page-banner-art" src={artUrl(art)} alt="" />
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
  const src = artUrl(`cat-${mood}`);
  if (src) return <img src={src} width={width} alt="" />;
  return mood === 'asleep' ? <img src={artUrl('cat-asleep')} width={width} alt="" /> : <WatchingCat width={width} height={(width * 2) / 3} />;
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
