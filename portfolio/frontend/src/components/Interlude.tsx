import type { CSSProperties } from 'react';
import { artUrl } from './Art';
import { useTheme } from '../hooks/useTheme';

export type InterludeLayout = 'band' | 'split' | 'arch';

interface Props {
  name: string;
  line: string;
  alt: string;
  layout?: InterludeLayout;
  label?: string;
}

/** The line as separate words, so each can light up on its own as it scrolls past. */
function Words({ text }: { text: string }) {
  const words = text.split(' ');
  return (
    <>
      {words.map((word, i) => (
        <span key={`${word}-${i}`} className="word" style={{ '--i': i } as CSSProperties}>
          {word}
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  );
}

/**
 * A picture between two sections with one line of text. Three layouts keep the page from
 * repeating itself:
 * - `band`: full width, fading into the paper at both edges, the line over it;
 * - `split`: a framed picture that opens up as it scrolls in, beside the line, which lights
 *   up word by word;
 * - `arch`: a window-shaped picture with the two halves of the line sliding in from the sides.
 * There is no drawn fallback: a missing image simply leaves the interlude out. In dark mode a
 * `-dark` file is used when it exists; otherwise the picture is dimmed (inverting a painting looks wrong).
 */
export default function Interlude({ name, line, alt, layout = 'band', label }: Props) {
  const { theme } = useTheme();
  const file = `interlude-${name}`;
  const darkUrl = theme === 'dark' ? artUrl(`${file}-dark`) : undefined;
  const url = darkUrl ?? artUrl(file);
  if (!url) return null;

  const className = ['interlude', `interlude--${layout}`, theme === 'dark' && !darkUrl ? 'interlude--dimmed' : '']
    .filter(Boolean)
    .join(' ');
  const img = <img className="interlude__img" src={url} alt={alt} loading="lazy" decoding="async" draggable={false} />;

  if (layout === 'split') {
    return (
      <figure className={className}>
        <div className="container interlude__grid">
          <figcaption className="interlude__text">
            {label && (
              <p className="eyebrow" data-reveal>
                {label}
              </p>
            )}
            <p className="interlude__line">
              <Words text={line} />
            </p>
          </figcaption>
          <div className="interlude__frame">{img}</div>
        </div>
      </figure>
    );
  }

  if (layout === 'arch') {
    // the line breaks after its middle word: one half on either side of the window
    const words = line.split(' ');
    const half = Math.ceil(words.length / 2);
    return (
      <figure className={className}>
        <div className="container interlude__stage">
          <p className="interlude__half interlude__half--left" aria-hidden="true">
            {words.slice(0, half).join(' ')}
          </p>
          <div className="interlude__window">{img}</div>
          <p className="interlude__half interlude__half--right" aria-hidden="true">
            {words.slice(half).join(' ')}
          </p>
          <figcaption className="sr-only">{line}</figcaption>
        </div>
      </figure>
    );
  }

  return (
    <figure className={className}>
      {img}
      <figcaption className="container interlude__text" data-reveal>
        <p>{line}</p>
      </figcaption>
    </figure>
  );
}
