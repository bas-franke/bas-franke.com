import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GAME_IDS, GAMES, type GameId, type GameMeta, type RoomSummary } from '@shared/protocol';
import { type QuickStart, listRooms, quickBots, quickPlay } from '../api';
import { sfx } from '../engine/audio';
import { SCREENSHOTS } from '../games/catalog';
import { GameCover } from '../ui/GameCover';
import { GameDetails } from '../ui/GameDetails';
import { Header } from '../ui/Header';
import { CreateRoom } from './CreateRoom';
import { RoomList } from './RoomList';

type Dialog = { kind: 'create'; game?: GameId } | { kind: 'details'; game: GameId } | null;

const isGame = (v: string | null): v is GameId => v !== null && v in GAMES;

/** The front page: the list of open rooms with one big button to create a room, then the game catalogue. */
export function Lobby() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<GameId | 'all'>('all');
  const [query, setQuery] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [quick, setQuick] = useState<GameId | null>(null);
  // /?create or /?create=rockets opens the create dialog straight away (used by links from elsewhere).
  const [dialog, setDialog] = useState<Dialog>(() => {
    const create = params.get('create');
    return create === null ? null : { kind: 'create', game: isGame(create) ? create : undefined };
  });

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

  const closeDialog = () => {
    setDialog(null);
    if (params.has('create')) setParams({}, { replace: true });
  };

  // One click from a tile to a running match: a fresh room with bots that the room page starts on arrival.
  const playNow = async (game: GameId) => {
    // The click is the user gesture the browser wants before it lets the game make sound.
    sfx.unlock();
    setQuick(game);
    setError('');
    try {
      const code = await quickPlay(game);
      navigate(`/room/${code}`, { state: { quickStart: true } satisfies QuickStart });
    } catch (err) {
      setError((err as Error).message);
      setQuick(null);
    }
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (code.length === 4) navigate(`/room/${code}`);
  };

  const counts = useMemo(() => {
    const c: Partial<Record<GameId, number>> = {};
    for (const r of rooms ?? []) c[r.game] = (c[r.game] ?? 0) + 1;
    return c;
  }, [rooms]);
  const players = useMemo(() => (rooms ?? []).reduce((n, r) => n + r.humans, 0), [rooms]);
  const games = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GAME_IDS.filter((id) => !q || GAMES[id].name.toLowerCase().includes(q) || GAMES[id].tagline.toLowerCase().includes(q));
  }, [query]);

  return (
    <div className="page lobby">
      <Header>
        <a className="btn ghost small" href="https://bas-franke.com">
          by Bas Franke
        </a>
      </Header>

      <section className="deck" aria-labelledby="rooms-title">
        <div className="deck-head">
          <div className="deck-title">
            <h1 id="rooms-title">Open rooms</h1>
            <p>Jump into a room, enter a code from a friend, or create your own and share it. No account needed.</p>
          </div>
          <div className="deck-actions">
            <form className="join-code" onSubmit={join}>
              <input
                className="mono"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                placeholder="CODE"
                maxLength={4}
                aria-label="Room code"
                autoComplete="off"
                spellCheck={false}
              />
              <button className="btn" type="submit" disabled={joinCode.length < 4}>
                Join
              </button>
            </form>
            <button type="button" className="btn primary big" onClick={() => setDialog({ kind: 'create' })}>
              <PlusIcon /> Create a room
            </button>
          </div>
        </div>

        <div className="deck-bar">
          <div className="chips" role="group" aria-label="Filter rooms by game">
            <button type="button" className={`chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
              All <span className="count">{rooms?.length ?? '–'}</span>
            </button>
            {GAME_IDS.map((id) => (
              <button
                type="button"
                key={id}
                className={`chip ${filter === id ? 'active' : ''}`}
                style={{ ['--accent' as string]: GAMES[id].accent }}
                onClick={() => setFilter(id)}
              >
                <i className="dot" />
                {GAMES[id].name} <span className="count">{counts[id] ?? 0}</span>
              </button>
            ))}
          </div>
          <span className="live-stat">
            <i className="pulse" />
            {rooms ? `${players} ${players === 1 ? 'player' : 'players'} online · ${rooms.length} ${rooms.length === 1 ? 'room' : 'rooms'}` : 'Connecting…'}
          </span>
        </div>

        {error && <p className="error">{error}</p>}
        <RoomList rooms={rooms} filter={filter} onJoin={(code) => navigate(`/room/${code}`)} onCreate={() => setDialog({ kind: 'create', game: filter === 'all' ? undefined : filter })} />
      </section>

      <section className="section" aria-labelledby="games-title">
        <div className="section-head">
          <h2 id="games-title">
            Games <span className="count">{GAME_IDS.length}</span>
          </h2>
          <input className="search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search games" aria-label="Search games" />
        </div>
        {games.length ? (
          <div className="game-grid">
            {games.map((id) => (
              <GameTile
                key={id}
                meta={GAMES[id]}
                busy={quick === id}
                onDetails={() => setDialog({ kind: 'details', game: id })}
                onHost={() => setDialog({ kind: 'create', game: id })}
                onPlay={() => playNow(id)}
              />
            ))}
          </div>
        ) : (
          <div className="empty">
            <p>No game matches “{query}”.</p>
          </div>
        )}
        <p className="hint kbd-hint" style={{ marginTop: 14 }}>
          Every game: <kbd>WASD</kbd> to move, <kbd>Tab</kbd> for scores, <kbd>Esc</kbd> for the menu. Rooms live as long as someone is in them.
        </p>
      </section>

      <footer className="site">
        <span>Built with three.js and Node.js. Everything runs on one small server, so rooms close when they empty.</span>
        <a href="https://github.com/bas-franke/bas-franke.com/tree/master/play">Source</a>
      </footer>

      {dialog?.kind === 'create' && <CreateRoom initialGame={dialog.game} onClose={closeDialog} onCreated={(code) => navigate(`/room/${code}`)} />}
      {dialog?.kind === 'details' && <GameDetails game={dialog.game} onClose={closeDialog} onHost={() => setDialog({ kind: 'create', game: dialog.game })} />}
    </div>
  );
}

/**
 * One compact card in the catalogue: cover, name, tagline, player range. Details on the picture; Host opens the create
 * dialog, Play now drops you straight into a match against bots.
 */
function GameTile({ meta, busy, onDetails, onHost, onPlay }: { meta: GameMeta; busy: boolean; onDetails: () => void; onHost: () => void; onPlay: () => void }) {
  const shots = SCREENSHOTS[meta.id].length;
  return (
    <article className="game-tile" style={{ ['--accent' as string]: meta.accent }}>
      <button type="button" className="tile-media" onClick={onDetails} aria-label={`About ${meta.name}`}>
        <GameCover game={meta.id} />
        {shots > 0 && (
          <span className="tile-shots">
            <CameraIcon /> {shots}
          </span>
        )}
      </button>
      <div className="tile-body">
        <div className="tile-title">
          <h3>{meta.name}</h3>
          <span className="pill accent">
            {meta.minPlayers}–{meta.maxPlayers}
          </span>
        </div>
        <p>{meta.tagline}</p>
        <div className="tile-actions">
          <button type="button" className="btn small ghost" onClick={onDetails}>
            Details
          </button>
          <button type="button" className="btn small" onClick={onHost}>
            Host
          </button>
          <button type="button" className="btn small primary play-now" onClick={onPlay} disabled={busy} title={`Start a match against ${quickBots(meta.id)} bots right away`}>
            <PlayIcon /> {busy ? 'Starting…' : 'Play now'}
          </button>
        </div>
      </div>
    </article>
  );
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}
