import InterludeImage, { type InterludeProps } from './InterludeImage';
import { useInterludeArt } from '../hooks/useInterludeArt';

/** Full width, fading into the paper at both edges, the line over it. Without a picture for this hour, the line alone. */
export default function InterludeBand({ name, line, alt, nightPainting }: InterludeProps) {
  const url = useInterludeArt(name, nightPainting);
  return (
    <figure className={url ? 'interlude interlude--band' : 'interlude interlude--band interlude--bare'}>
      {url && <InterludeImage src={url} alt={alt} />}
      <figcaption className="container interlude__text" data-reveal>
        <p className="interlude__voice">{line}</p>
      </figcaption>
    </figure>
  );
}
