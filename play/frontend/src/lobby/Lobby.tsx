import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GAME_IDS, GAMES, LIMITS, type BotDifficulty, type GameId, type GameMeta, type RoomSummary } from '@shared/protocol';
import { createRoom, listRooms, saveName, savedName } from '../api';

export function Lobby() {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState<GameId | null>(null);
  const [joinCode, setJoinCode] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () =>
      listRooms()
        .then((r) => alive && (setRooms(r.rooms), setError('')))
        .catch((e: Error) => alive && setError(e.message));
    load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const join = (e: FormEvent) => {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (code) navigate(`/room/${code}`);
  };

  return (
    <div className="page">
      <header className="topbar">
        <a className="brand" href="/">
          play<span className="dot">.</span>
          <small>bas-franke.com</small>
        </a>
        <a className="btn ghost small" href="https://bas-franke.com">
          by Bas Franke
        </a>
      </header>

      <section className="hero">
        <h1>Pick a game. Host a room. Send the code.</h1>
        <p>
          Small multiplayer games that run in the browser, no account needed. A room lives as long as someone is in it, and you can fill
          the empty seats with bots.
        </p>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Games</h2>
          <span className="hint">All games: WASD to move, Tab for scores, Esc for the menu</span>
        </div>
        <div className="games">
          {GAME_IDS.map((id) => (
            <GameCard key={id} meta={GAMES[id]} onHost={() => setCreating(id)} />
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Open rooms</h2>
          <form onSubmit={join} style={{ display: 'flex', gap: 8 }}>
            <input
              className="mono"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="CODE"
              maxLength={4}
              aria-label="Room code"
              style={{ width: 90, textAlign: 'center', letterSpacing: '0.2em', padding: '6px 8px', borderRadius: 10, border: '1px solid var(--line-strong)', background: 'rgba(0,0,0,0.25)' }}
            />
            <button className="btn small" type="submit" disabled={joinCode.trim().length < 4}>
              Join by code
            </button>
          </form>
        </div>
        {error && <p className="error">{error}</p>}
        <RoomList rooms={rooms} onJoin={(code) => navigate(`/room/${code}`)} />
      </section>

      <footer className="site">
        <span>Built with three.js and Node.js. Everything runs on one small server, so rooms close when they empty.</span>
        <a href="https://github.com/bas-franke/bas-franke.com/tree/master/play">Source</a>
      </footer>

      {creating && <CreateRoomModal game={creating} onClose={() => setCreating(null)} onCreated={(code) => navigate(`/room/${code}`)} />}
    </div>
  );
}

function GameCard({ meta, onHost }: { meta: GameMeta; onHost: () => void }) {
  return (
    <article className="game-card" style={{ ['--accent' as string]: meta.accent }}>
      <div>
        <h3>{meta.name}</h3>
        <p className="tagline">{meta.tagline}</p>
      </div>
      <p className="desc">{meta.description}</p>
      <dl className="controls">
        {meta.controls.map((c) => (
          <div key={c.keys} style={{ display: 'contents' }}>
            <dt>{c.keys}</dt>
            <dd>{c.does}</dd>
          </div>
        ))}
      </dl>
      <div className="actions">
        <button className="btn primary" onClick={onHost}>
          Host a room
        </button>
        <span className="pill accent">
          {meta.minPlayers}–{meta.maxPlayers} players
        </span>
      </div>
    </article>
  );
}

function RoomList({ rooms, onJoin }: { rooms: RoomSummary[] | null; onJoin: (code: string) => void }) {
  if (!rooms) return <div className="empty">Loading rooms…</div>;
  if (!rooms.length) return <div className="empty">No open rooms right now. Host one and share the code.</div>;
  return (
    <div className="room-list">
      {rooms.map((r) => {
        const meta = GAMES[r.game];
        const full = r.humans + r.bots >= r.maxPlayers && r.bots === 0;
        return (
          <div className="room-row" key={r.code} style={{ ['--accent' as string]: meta.accent }}>
            <span className="code">{r.code}</span>
            <div>
              <div className="name">{r.name}</div>
              <div className="meta">
                <span className="pill accent">{meta.name}</span> · {r.humans} {r.humans === 1 ? 'player' : 'players'}
                {r.bots ? ` + ${r.bots} ${r.bots === 1 ? 'bot' : 'bots'}` : ''} · {r.maxPlayers} seats
              </div>
            </div>
            <span className={`pill ${r.state}`}>{r.state === 'playing' ? 'In a match' : 'Waiting'}</span>
            <button className="btn small" onClick={() => onJoin(r.code)} disabled={full}>
              {full ? 'Full' : 'Join'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function CreateRoomModal({ game: initial, onClose, onCreated }: { game: GameId; onClose: () => void; onCreated: (code: string) => void }) {
  const [game, setGame] = useState<GameId>(initial);
  const meta = GAMES[game];
  const [name, setName] = useState(savedName());
  const [roomName, setRoomName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(meta.maxPlayers);
  const [bots, setBots] = useState(1);
  const [difficulty, setDifficulty] = useState<BotDifficulty>('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
        bots: Math.min(bots, maxPlayers - 1),
        botDifficulty: difficulty,
      });
      onCreated(room.code);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ ['--accent' as string]: meta.accent }}>
        <h2>Host a room</h2>
        <p className="sub">You get a four-letter code to share. The room closes when the last player leaves.</p>

        <div className="segmented" style={{ marginBottom: 16 }}>
          {GAME_IDS.map((id) => (
            <button type="button" key={id} className={id === game ? 'active' : ''} onClick={() => setGame(id)}>
              {GAMES[id].name}
            </button>
          ))}
        </div>

        <div className="form-row">
          <label className="field">
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.playerNameMax} placeholder="Player" autoFocus />
          </label>
          <label className="field">
            Room name
            <input value={roomName} onChange={(e) => setRoomName(e.target.value)} maxLength={LIMITS.roomNameMax} placeholder={`${meta.name} room`} />
          </label>
        </div>

        <div className="form-row" style={{ marginTop: 14 }}>
          <label className="field">
            Seats: {maxPlayers}
            <input type="range" min={LIMITS.minPlayers} max={meta.maxPlayers} value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} />
          </label>
          <label className="field">
            Bots: {Math.min(bots, maxPlayers - 1)}
            <input type="range" min={0} max={maxPlayers - 1} value={Math.min(bots, maxPlayers - 1)} onChange={(e) => setBots(Number(e.target.value))} />
          </label>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          Bot difficulty
          <div className="segmented">
            {(['easy', 'normal', 'hard'] as BotDifficulty[]).map((d) => (
              <button type="button" key={d} className={d === difficulty ? 'active' : ''} onClick={() => setDifficulty(d)}>
                {d}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="error" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Creating…' : `Create ${meta.name} room`}
          </button>
        </div>
      </form>
    </div>
  );
}
