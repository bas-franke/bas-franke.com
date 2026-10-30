import InterludeImage, { type InterludeProps } from './InterludeImage';
import { useInterludeArt } from '../hooks/useInterludeArt';

/** A window-shaped picture on the night, with the two halves of the line sliding in from the sides. */
export default function InterludeArch({ name, line, alt, nightPainting }: InterludeProps) {
  const url = useInterludeArt(name, nightPainting);
  if (!url) return null;

  // the line breaks after its middle word: one half on either side of the window
  const words = line.split(' ');
  const half = Math.ceil(words.length / 2);
  return (
    <figure className="interlude interlude--arch night">
      <div className="container interlude__stage">
        <p className="interlude__voice interlude__half interlude__half--left" aria-hidden="true">
          {words.slice(0, half).join(' ')}
        </p>
        <div className="interlude__window">
          <InterludeImage src={url} alt={alt} />
        </div>
        <p className="interlude__voice interlude__half interlude__half--right" aria-hidden="true">
          {words.slice(half).join(' ')}
        </p>
        <figcaption className="sr-only">{line}</figcaption>
      </div>
    </figure>
  );
}
