import { GAMES, SOLO_GAMES, type GameId, type SoloGameId } from '@shared/protocol';
import { type Screenshot, coverOf } from '../games/catalog';

/** A game's cover screenshot, or an accent-coloured placeholder while a game has no screenshots yet. */
export function GameCover({ game, shot, className = '' }: { game: GameId | SoloGameId; shot?: Screenshot; className?: string }) {
  const meta = game in GAMES ? GAMES[game as GameId] : SOLO_GAMES[game as SoloGameId];
  const s = shot ?? coverOf(game);
  if (s) return <img className={`cover ${className}`} src={s.src} alt={s.alt} loading="lazy" decoding="async" />;
  return (
    <div className={`cover placeholder ${className}`} style={{ ['--accent' as string]: meta.accent }} role="img" aria-label={`${meta.name}: no screenshot yet`}>
      <span>{meta.name.slice(0, 1)}</span>
    </div>
  );
}
