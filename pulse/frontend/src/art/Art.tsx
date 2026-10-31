// One component for every picture: <Art slot="hero-day" className="..." />. Renders src/assets/art/<slot>.webp (or
// <slot>-dark.webp in the dark theme) when the file exists, else a painted placeholder. The art agent owns the
// placeholders (Placeholder.tsx); everything else only uses <Art> and the exports below.
import { useIsDark } from '../theme';
import { Placeholder } from './Placeholder';

const files = import.meta.glob('../assets/art/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const artUrl = (slot: string): string | undefined => files[`../assets/art/${slot}.webp`];

/** A slot's picture for the current theme (undefined while there is only a placeholder). */
export function useArt(slot: string) {
  const dark = useIsDark();
  const night = dark ? artUrl(`${slot}-dark`) : undefined;
  return { src: night ?? artUrl(slot), night: !!night };
}

/** The dashboard hero follows the clock. */
export const heroSlot = (hour = new Date().getHours()) =>
  hour >= 5 && hour < 11 ? 'hero-morning' : hour >= 11 && hour < 17 ? 'hero-day' : hour >= 17 && hour < 21 ? 'hero-evening' : 'hero-night';

export function Art({ slot, className = '', alt = '' }: { slot: string; className?: string; alt?: string }) {
  const { src, night } = useArt(slot);
  if (!src) return <Placeholder slot={slot} className={className} alt={alt} />;
  return <img className={`art ${className}`} src={src} alt={alt} loading="lazy" decoding="async" data-night={night || undefined} />;
}
