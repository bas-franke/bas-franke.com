import { useEffect, useState } from 'react';
import { GAMES, type GameId } from '@shared/protocol';
import { SCREENSHOTS } from '../games/catalog';
import { GameCover } from './GameCover';

/** All screenshots of one game: a large current image with previous/next controls and a strip of thumbnails. */
export function Gallery({ game }: { game: GameId }) {
  const shots = SCREENSHOTS[game];
  const count = shots.length;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [game]);

  useEffect(() => {
    if (count < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setIndex((i) => (i + 1) % count);
      if (e.key === 'ArrowLeft') setIndex((i) => (i - 1 + count) % count);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count]);

  const current = shots[Math.min(index, Math.max(0, count - 1))];
  const prev = () => setIndex((i) => (i - 1 + count) % count);
  const next = () => setIndex((i) => (i + 1) % count);

  return (
    <div className="gallery" style={{ ['--accent' as string]: GAMES[game].accent }}>
      <div className="gallery-main">
        {current ? <img key={current.src} src={current.src} alt={current.alt} /> : <GameCover game={game} />}
        {count > 1 && (
          <>
            <button type="button" className="gallery-nav prev" aria-label="Previous screenshot" onClick={prev}>
              ‹
            </button>
            <button type="button" className="gallery-nav next" aria-label="Next screenshot" onClick={next}>
              ›
            </button>
          </>
        )}
        <span className="gallery-caption">
          {current ? current.caption : 'No screenshots yet'}
          {count > 1 && (
            <small>
              {index + 1} / {count}
            </small>
          )}
        </span>
      </div>
      {count > 1 && (
        <div className="gallery-thumbs">
          {shots.map((s, i) => (
            <button type="button" key={s.src} className={i === index ? 'active' : ''} onClick={() => setIndex(i)} aria-label={s.caption} title={s.caption}>
              <img src={s.src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
