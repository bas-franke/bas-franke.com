import { useEffect, useState } from 'react';
import day from '../art/hero.webp';
import night from '../art/hero-dark.webp';
import { useTheme } from '../hooks/useTheme';

/** Two curls of steam in a 160x205 box above the cup, following the plume painted in both pictures. */
const wisps = ['M55 200C34 168 40 150 60 124S104 70 110 12', 'M86 200C70 170 80 150 100 122S122 62 142 22'];

/** When the painting of the other theme starts loading, so it is ready for the toggle without slowing the first screen. */
const OTHER_PAINTING_DELAY = 2000;

/** The current theme's painting comes at once and first; the other one waits for the page to settle. */
function Painting({ src, current, settled, className }: { src: string; current: boolean; settled: boolean; className?: string }) {
  if (!current && !settled) return null;
  return (
    <img className={className} src={src} alt="" width="1200" height="1500" fetchPriority={current ? 'high' : 'low'} draggable={false} />
  );
}

/**
 * The painted window. Day and night are stacked so the theme can crossfade between them. Both paintings share
 * one composition, so the steam and the glimmer, placed in % of the scene, line up on either and at any crop.
 */
export default function HeroWindow() {
  const { theme } = useTheme();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), OTHER_PAINTING_DELAY);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="hero__window">
      <div className="hero__pane">
        <div className="hero__scene">
          <Painting src={day} current={theme === 'light'} settled={settled} />
          <Painting src={night} current={theme === 'dark'} settled={settled} className="hero__night" />
          <span className="glimmer" />
          {wisps.map((d) => (
            <svg key={d} className="steam" viewBox="0 0 160 205" aria-hidden="true" focusable="false">
              <path d={d} />
            </svg>
          ))}
        </div>
      </div>
    </div>
  );
}
