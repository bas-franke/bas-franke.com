import { GAMES, type GameId } from '@shared/protocol';
import { Link } from 'react-router-dom';
import { Gallery } from './Gallery';
import { Modal } from './Modal';

/** Room games that also have a title screen of their own (settings, how to play, host / join). */
export const GAME_MENUS: Partial<Record<GameId, string>> = { zombies: '/lastlight' };

/** Everything about one game: screenshots, description, controls and (in the lobby) a button to host it. */
export function GameDetails({ game, onClose, onHost }: { game: GameId; onClose: () => void; onHost?: () => void }) {
  const meta = GAMES[game];
  return (
    <Modal size="lg" label={`About ${meta.name}`} onClose={onClose}>
      <div className="details" style={{ ['--accent' as string]: meta.accent }}>
        <Gallery game={game} />
        <div className="details-body">
          <div className="modal-head">
            <div>
              <span className="step">
                {meta.minPlayers}–{meta.maxPlayers} players · bots welcome
              </span>
              <h2>{meta.name}</h2>
            </div>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <p className="tagline">{meta.tagline}</p>
          <p className="desc">{meta.description}</p>
          <h4>Controls</h4>
          <dl className="controls">
            {meta.controls.map((c) => (
              <div key={c.keys} style={{ display: 'contents' }}>
                <dt>{c.keys}</dt>
                <dd>{c.does}</dd>
              </div>
            ))}
          </dl>
          {(onHost || GAME_MENUS[game]) && (
            <div className="form-actions">
              {GAME_MENUS[game] && (
                <Link className="btn big" to={GAME_MENUS[game]}>
                  Open the {meta.name} menu
                </Link>
              )}
              {onHost && (
                <button type="button" className="btn primary big" onClick={onHost}>
                  Create a {meta.name} room
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
