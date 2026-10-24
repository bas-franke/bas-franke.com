import { useEffect, useState } from 'react';

/**
 * Decorative illustration from /public/art (see inck/ART.md for the list and prompts).
 * Renders nothing until the file exists, so the site works with or without artwork.
 */
export default function Art({ name, fallback, className }: { name: string; fallback?: string; className?: string }) {
  const [src, setSrc] = useState(name);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setSrc(name);
    setMissing(false);
  }, [name]);

  if (missing) return null;
  return (
    <img
      src={`/art/${src}.png`}
      alt=""
      aria-hidden="true"
      className={className}
      draggable={false}
      decoding="async"
      onError={() => (fallback && src !== fallback ? setSrc(fallback) : setMissing(true))}
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
