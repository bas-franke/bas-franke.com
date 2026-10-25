import { artUrl } from './Art';
import { useTheme } from '../hooks/useTheme';

interface Props {
  name: string;
  line: string;
  alt: string;
}

/**
 * A full-width picture between two sections, fading into the paper at both edges, with
 * one line of text over it. Unlike the line-art slots there is no drawn fallback: a
 * missing image simply leaves the band out. In dark mode a `-dark` file is used when it
 * exists; otherwise the picture is dimmed (inverting a painting looks wrong).
 */
export default function Interlude({ name, line, alt }: Props) {
  const { theme } = useTheme();
  const file = `interlude-${name}`;
  const darkUrl = theme === 'dark' ? artUrl(`${file}-dark`) : undefined;
  const url = darkUrl ?? artUrl(file);
  if (!url) return null;

  return (
    <figure className={`interlude ${theme === 'dark' && !darkUrl ? 'interlude--dimmed' : ''}`.trim()}>
      <img className="interlude__img" src={url} alt={alt} loading="lazy" decoding="async" draggable={false} />
      <figcaption className="container interlude__text" data-reveal>
        <p>{line}</p>
      </figcaption>
    </figure>
  );
}
