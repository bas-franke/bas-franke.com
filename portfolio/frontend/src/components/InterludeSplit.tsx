import type { CSSProperties } from 'react';
import InterludeImage, { type InterludeProps } from './InterludeImage';
import { useInterludeArt } from '../hooks/useInterludeArt';

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

/** A framed picture that opens up as it scrolls in, beside the line, which lights up word by word. */
export default function InterludeSplit({ name, line, alt, nightPainting }: InterludeProps) {
  const url = useInterludeArt(name, nightPainting);
  if (!url) return null;

  return (
    <figure className="interlude interlude--split">
      <div className="container interlude__grid">
        <figcaption className="interlude__text">
          <p className="interlude__voice interlude__line">
            <Words text={line} />
          </p>
        </figcaption>
        <div className="interlude__frame">
          <InterludeImage src={url} alt={alt} />
        </div>
      </div>
    </figure>
  );
}
