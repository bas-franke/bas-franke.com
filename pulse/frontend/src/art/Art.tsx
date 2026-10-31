// One component for every picture: <Art slot="hero-day" className="..." />. A slot is a *place* in the UI; the user's
// generated files (see FILES in slots.ts and ART.md) are mapped onto places below, so pages never change when pictures
// arrive. Without a matching file in src/assets/art/<file>.webp the place shows its painted placeholder.
import { useIsDark } from '../theme';
import { Placeholder } from './Placeholder';

const files = import.meta.glob('../assets/art/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const url = (file: string): string | undefined => files[`../assets/art/${file}.webp`];

/** Place -> file used in the light theme (the first that exists wins). */
const LIGHT: Record<string, string[]> = {
  'hero-morning': ['dashboard-hero'],
  'hero-day': ['dashboard-hero'],
  'hero-evening': ['dashboard-hero'],
  'hero-night': ['night-hero', 'dashboard-hero'],
  'banner-board': ['rainy-banner'],
  'banner-notes': ['notes-hero'],
  'empty-board': ['empty-tasks'],
  'empty-column': ['empty-tasks'],
  'empty-today': ['celebrate'],
  'empty-search': ['empty-notes'],
  'card-overdue': ['overdue'],
  loading: ['loading-404'],
  notfound: ['loading-404'],
};
/** Place -> file used in the dark theme (before the light mapping). */
const DARK: Record<string, string[]> = {
  'hero-morning': ['night-hero'],
  'hero-day': ['night-hero'],
  'hero-evening': ['night-hero'],
};

/** The file behind a place for the current theme, or undefined while it only has a placeholder. */
export function artUrl(slot: string, dark = false): string | undefined {
  const tries = [...(dark ? [`${slot}-dark`, ...(DARK[slot] ?? [])] : []), slot, ...(LIGHT[slot] ?? [])];
  for (const t of tries) {
    const u = url(t);
    if (u) return u;
  }
}

export function useArt(slot: string) {
  const dark = useIsDark();
  const src = artUrl(slot, dark);
  const night = dark && !!src && (src === url('night-hero') || src === url(`${slot}-dark`));
  return { src, night };
}

/** The dashboard hero follows the clock. */
export const heroSlot = (hour = new Date().getHours()) =>
  hour >= 5 && hour < 11 ? 'hero-morning' : hour >= 11 && hour < 17 ? 'hero-day' : hour >= 17 && hour < 21 ? 'hero-evening' : 'hero-night';

export function Art({ slot, className = '', alt = '' }: { slot: string; className?: string; alt?: string }) {
  const { src, night } = useArt(slot);
  if (!src) return <Placeholder slot={slot} className={className} alt={alt} />;
  return <img className={`art ${className}`} src={src} alt={alt} loading="lazy" decoding="async" data-night={night || undefined} />;
}
