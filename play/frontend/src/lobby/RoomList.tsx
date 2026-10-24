import { GAMES, type GameId, type RoomSummary } from '@shared/protocol';
import { GameCover } from '../ui/GameCover';

/** The server list: every open room, newest first, optionally filtered to one game. */
export function RoomList({ rooms, filter, onJoin, onCreate }: { rooms: RoomSummary[] | null; filter: GameId | 'all'; onJoin: (code: string) => void; onCreate: () => void }) {
  if (!rooms) {
    return (
      <div className="room-list" aria-busy="true" aria-label="Loading rooms">
        {[0, 1, 2].map((i) => (
          <div key={i} className="room-row skeleton" />
        ))}
      </div>
    );
  }
  const shown = filter === 'all' ? rooms : rooms.filter((r) => r.game === filter);
  if (!shown.length) {
    return (
      <div className="empty">
        <p>{filter !== 'all' && rooms.length ? `No open ${GAMES[filter].name} rooms right now.` : 'No open rooms right now.'}</p>
        <button type="button" className="btn primary" onClick={onCreate}>
          Create the first one
        </button>
        <span className="hint">You get a four-letter code to share, and bots can fill the empty seats.</span>
      </div>
    );
  }
  return (
    <div className="room-list">
      {shown.map((r) => (
        <RoomRow key={r.code} room={r} onJoin={() => onJoin(r.code)} />
      ))}
    </div>
  );
}

function RoomRow({ room: r, onJoin }: { room: RoomSummary; onJoin: () => void }) {
  const meta = GAMES[r.game];
  const taken = r.humans + r.bots;
  // Humans replace bots when they join, so a room is only full once humans hold every seat.
  const full = r.humans >= r.maxPlayers;
  const live = r.state === 'playing';
  const seats = Array.from({ length: r.maxPlayers }, (_, i) => (i < r.humans ? 'human' : i < taken ? 'bot' : 'free'));
  return (
    <article className="room-row" style={{ ['--accent' as string]: meta.accent }}>
      <div className="room-thumb">
        <GameCover game={r.game} />
      </div>
      <div className="room-info">
        <div className="name">
          {r.name} <span className="pill accent">{meta.name}</span>
        </div>
        <div className="meta">
          <span className="seats" aria-label={`${taken} of ${r.maxPlayers} seats taken`}>
            {seats.map((k, i) => (
              <i key={i} className={`seat ${k}`} />
            ))}
          </span>
          {r.humans} {r.humans === 1 ? 'player' : 'players'}
          {r.bots ? ` + ${r.bots} ${r.bots === 1 ? 'bot' : 'bots'}` : ''} · {r.maxPlayers} seats
        </div>
      </div>
      <span className="code" title="Room code">
        {r.code}
      </span>
      <span className={`pill state ${live ? 'live' : ''}`}>{live ? 'Live' : 'Waiting'}</span>
      <button type="button" className="btn small primary" onClick={onJoin} disabled={full}>
        {full ? 'Full' : live ? 'Drop in' : 'Join'}
      </button>
    </article>
  );
}
