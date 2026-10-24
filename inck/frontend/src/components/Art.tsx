import { useEffect, useState } from 'react';

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

/** "Space & astronomy" → "space-astronomy", used for topic icon filenames. */
export const artSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
