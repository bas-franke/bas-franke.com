import { GAMES, type GameId } from '@shared/protocol';
import { type Screenshot, coverOf } from '../games/catalog';

/** A game's cover screenshot, or an accent-coloured placeholder while a game has no screenshots yet. */
export function GameCover({ game, shot, className = '' }: { game: GameId; shot?: Screenshot; className?: string }) {
  const meta = GAMES[game];
  const s = shot ?? coverOf(game);
  if (s) return <img className={`cover ${className}`} src={s.src} alt={s.alt} loading="lazy" decoding="async" />;
  return (
    <div className={`cover placeholder ${className}`} style={{ ['--accent' as string]: meta.accent }} role="img" aria-label={`${meta.name}: no screenshot yet`}>
      <span>{meta.name.slice(0, 1)}</span>
    </div>
  );
}
