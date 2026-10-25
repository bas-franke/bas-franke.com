// The title screen's backdrop: the key art from art.ts, one shot at a time with a slow Ken Burns drift and a long
// crossfade to the next. Two stacked layers swap roles, so only the incoming picture ever changes its src. With one
// picture it simply keeps drifting. Grain, flicker and vignette are pure CSS on top (menu.css).

import { useEffect, useState } from 'react';
import { type LLArt, LL_ART } from '../art';

/** How long each shot holds before the next fades in (the drift animation in menu.css lasts a bit longer). */
const HOLD_MS = 11000;

/** A few drift directions, so consecutive shots do not all pan the same way. Values feed CSS custom properties. */
const DRIFTS = [
  { x0: '-2%', y0: '1%', x1: '2%', y1: '-1%' },
  { x0: '2%', y0: '-1%', x1: '-2%', y1: '1.5%' },
  { x0: '0%', y0: '2%', x1: '-1.5%', y1: '-1.5%' },
  { x0: '-1.5%', y0: '-1.5%', x1: '1.5%', y1: '1%' },
];

interface Layer {
  art: LLArt;
  /** Bumps every time the layer shows a new shot, to restart its CSS animation via the React key. */
  n: number;
}

export function Backdrop({ onCaption }: { onCaption: (caption: string) => void }) {
  const [index, setIndex] = useState(0);
  // Layer 0 and 1 alternate; `front` is the visible one.
  const [layers, setLayers] = useState<[Layer | null, Layer | null]>(() => [LL_ART[0] ? { art: LL_ART[0], n: 0 } : null, null]);
  const [front, setFront] = useState<0 | 1>(0);

  useEffect(() => {
    if (LL_ART[index]) onCaption(LL_ART[index].caption);
  }, [index, onCaption]);

  useEffect(() => {
    if (LL_ART.length < 2) return;
    const next = (index + 1) % LL_ART.length;
    // Warm the cache well before the swap so the fade never reveals a half-loaded image.
    const img = new Image();
    img.src = LL_ART[next].src;
    const timer = setTimeout(() => {
      const back = front === 0 ? 1 : 0;
      setLayers((ls) => {
        const copy: [Layer | null, Layer | null] = [...ls];
        copy[back] = { art: LL_ART[next], n: index + 1 };
        return copy;
      });
      setFront(back);
      setIndex(next);
    }, HOLD_MS);
    return () => clearTimeout(timer);
  }, [index, front]);

  return (
    <div className="llm-backdrop" aria-hidden>
      {layers.map((l, i) => {
        if (!l) return null;
        const d = DRIFTS[l.n % DRIFTS.length];
        return (
          <div key={i} className={`llm-shot${i === front ? ' on' : ''}`}>
            <img
              key={l.n}
              src={l.art.src}
              alt=""
              decoding="async"
              style={{ ['--x0' as string]: d.x0, ['--y0' as string]: d.y0, ['--x1' as string]: d.x1, ['--y1' as string]: d.y1 }}
            />
          </div>
        );
      })}
      {!layers[0] && <div className="llm-shot on llm-empty" />}
      <div className="llm-flicker" />
      <div className="llm-vignette" />
      <div className="llm-grain" />
      <div className="llm-scan" />
    </div>
  );
}
