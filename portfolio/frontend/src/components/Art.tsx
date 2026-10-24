import { useState, type ReactNode } from 'react';
import { useTheme } from '../hooks/useTheme';

/**
 * Artwork from src/art (see ART.md). Files are picked up at build time, so a missing
 * image costs nothing: the fallback drawing is shown instead. If a `<name>-dark` file
 * exists it is used in dark mode; otherwise the light artwork is inverted.
 */
const files = import.meta.glob<string>('../art/*.{webp,png,jpg,jpeg}', { eager: true, import: 'default' });

export function artUrl(name: string): string | undefined {
  for (const ext of ['webp', 'png', 'jpg', 'jpeg']) {
    const url = files[`../art/${name}.${ext}`];
    if (url) return url;
  }
  return undefined;
}

interface Props {
  name: string;
  alt?: string;
  fallback?: ReactNode;
  className?: string;
  eager?: boolean;
}

export default function Art({ name, alt = '', fallback, className = '', eager = false }: Props) {
  const { theme } = useTheme();
  const [loaded, setLoaded] = useState<string | null>(null);

  const darkUrl = theme === 'dark' ? artUrl(`${name}-dark`) : undefined;
  const lightUrl = artUrl(name);
  const url = darkUrl ?? lightUrl;
  const inverted = theme === 'dark' && !darkUrl && Boolean(lightUrl);
  const ready = url !== undefined && loaded === url;

  return (
    <div className={`art ${ready ? 'art--ready' : ''} ${className}`.trim()}>
      {!ready && fallback}
      {url && (
        <img
          key={url}
          src={url}
          alt={alt}
          className={`art__img ${inverted ? 'art__img--inverted' : ''}`.trim()}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(url)}
        />
      )}
    </div>
  );
}
