import { type FormEvent, useMemo, useState } from 'react';
import { GAME_IDS, GAMES, LIMITS, type BotDifficulty, type GameId } from '@shared/protocol';
import { MAP_LIST, RANDOM_MAP } from '@shared/rockets/maps';
import { createRoom, saveName, savedName } from '../api';
import { GameCover } from '../ui/GameCover';
import { Modal } from '../ui/Modal';

/**
 * The create-room dialog in two steps: pick a game, then the room settings. Opened from a game tile it starts on
 * the settings step with that game chosen.
 */
export function CreateRoom({ initialGame, onClose, onCreated }: { initialGame?: GameId; onClose: () => void; onCreated: (code: string) => void }) {
  const [game, setGame] = useState<GameId | undefined>(initialGame);
  const [step, setStep] = useState<'game' | 'settings'>(initialGame ? 'settings' : 'game');
  const [name, setName] = useState(savedName());
  const [roomName, setRoomName] = useState('');

  return (
    <Modal label="Create a room" onClose={onClose}>
      {step === 'game' || !game ? (
        <PickGame
          selected={game}
          onClose={onClose}
          onPick={(id) => {
            setGame(id);
            setStep('settings');
          }}
        />
      ) : (
        <Settings
          key={game}
          game={game}
          name={name}
          roomName={roomName}
          onName={setName}
          onRoomName={setRoomName}
          onBack={() => setStep('game')}
          onClose={onClose}
          onCreated={onCreated}
        />
      )}
    </Modal>
  );
}

function PickGame({ selected, onPick, onClose }: { selected?: GameId; onPick: (id: GameId) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const games = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GAME_IDS.filter((id) => !q || GAMES[id].name.toLowerCase().includes(q) || GAMES[id].tagline.toLowerCase().includes(q));
  }, [query]);

  return (
    <>
      <div className="modal-head">
        <div>
          <span className="step">Step 1 of 2</span>
          <h2>Choose a game</h2>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {GAME_IDS.length > 6 && (
        <input className="search wide" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search games" aria-label="Search games" autoFocus />
      )}
      <ul className="game-picker">
        {games.map((id) => {
          const meta = GAMES[id];
          return (
            <li key={id}>
              <button type="button" className={`picker-row ${id === selected ? 'selected' : ''}`} style={{ ['--accent' as string]: meta.accent }} onClick={() => onPick(id)}>
                <GameCover game={id} className="picker-thumb" />
                <span className="picker-text">
                  <strong>{meta.name}</strong>
                  <span>{meta.tagline}</span>
                </span>
                <span className="pill accent">
                  {meta.minPlayers}–{meta.maxPlayers}
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          );
        })}
        {!games.length && <li className="empty">No game matches “{query}”.</li>}
      </ul>
    </>
  );
}

function Settings({
  game,
  name,
  roomName,
  onName,
  onRoomName,
  onBack,
  onClose,
  onCreated,
}: {
  game: GameId;
  name: string;
  roomName: string;
  onName: (v: string) => void;
  onRoomName: (v: string) => void;
  onBack: () => void;
  onClose: () => void;
  onCreated: (code: string) => void;
}) {
  const meta = GAMES[game];
  const [maxPlayers, setMaxPlayers] = useState(meta.maxPlayers);
  const [bots, setBots] = useState(1);
  const [difficulty, setDifficulty] = useState<BotDifficulty>('normal');
  const [map, setMap] = useState(RANDOM_MAP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hasMaps = game === 'rockets';
  const botCount = Math.min(bots, maxPlayers - 1);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const nick = name.trim() || 'Player';
      saveName(nick);
      const { room } = await createRoom({
        name: roomName.trim() || `${nick}'s ${meta.name.toLowerCase()} room`,
        game,
        maxPlayers,
        bots: botCount,
        botDifficulty: difficulty,
        map: hasMaps ? map : undefined,
      });
      onCreated(room.code);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ ['--accent' as string]: meta.accent }}>
      <div className="modal-head">
        <div>
          <span className="step">Step 2 of 2</span>
          <h2>Room settings</h2>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="chosen-game">
        <GameCover game={game} className="picker-thumb" />
        <div>
          <strong>{meta.name}</strong>
          <span>{meta.tagline}</span>
        </div>
        <button type="button" className="btn small ghost" onClick={onBack}>
          Change
        </button>
      </div>

      <div className="form-row">
        <label className="field">
          Your name
          <input value={name} onChange={(e) => onName(e.target.value)} maxLength={LIMITS.playerNameMax} placeholder="Player" autoFocus />
        </label>
        <label className="field">
          Room name
          <input value={roomName} onChange={(e) => onRoomName(e.target.value)} maxLength={LIMITS.roomNameMax} placeholder={`${meta.name} room`} />
        </label>
      </div>

      <div className="form-row">
        <label className="field">
          <span className="field-label">
            Seats <b>{maxPlayers}</b>
          </span>
          <input type="range" min={LIMITS.minPlayers} max={meta.maxPlayers} value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} />
        </label>
        <label className="field">
          <span className="field-label">
            Bots <b>{botCount}</b>
          </span>
          <input type="range" min={0} max={maxPlayers - 1} value={botCount} onChange={(e) => setBots(Number(e.target.value))} />
        </label>
      </div>

      <div className="form-row">
        <div className="field">
          Bot difficulty
          <div className="segmented">
            {(['easy', 'normal', 'hard'] as BotDifficulty[]).map((d) => (
              <button type="button" key={d} className={d === difficulty ? 'active' : ''} onClick={() => setDifficulty(d)}>
                {d}
              </button>
            ))}
          </div>
        </div>
        {hasMaps && (
          <label className="field">
            Map
            <select value={map} onChange={(e) => setMap(e.target.value)}>
              <option value={RANDOM_MAP}>Random every match</option>
              {MAP_LIST.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onBack}>
          Back
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create room'}
        </button>
      </div>
    </form>
  );
}
