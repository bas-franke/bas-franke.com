import { GAMES, type GameId } from '@shared/protocol';
import { Gallery } from './Gallery';
import { Modal } from './Modal';

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
          {onHost && (
            <div className="form-actions">
              <button type="button" className="btn primary big" onClick={onHost}>
                Create a {meta.name} room
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
