import { useState } from 'react';

/**
 * Decorative illustration from /public/art (see status/ART.md for the full list).
 * Renders nothing until the file exists, so the page works with or without artwork.
 */
export default function Art({ name, fallback, className }: { name: string; fallback?: string; className?: string }) {
  const [src, setSrc] = useState(name);
  const [missing, setMissing] = useState(false);

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
