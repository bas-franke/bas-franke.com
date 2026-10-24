import { type FormEvent, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { GAMES, LIMITS, type BotDifficulty, type GameId, type GameMode, type GameServerMsg, type PlayerInfo, type RoomView, type Team, colorHex } from '@shared/protocol';
import { MAP_LIST, RANDOM_MAP } from '@shared/rockets/maps';
import { MODES, MODE_IDS, TEAMS } from '@shared/rockets/modes';
import { DIFFICULTIES, type QuickStart, quickPlay, randomMapId, saveDifficulty, saveName, savedName } from '../api';
import { sfx } from '../engine/audio';
import { SCREENSHOTS } from '../games/catalog';
import { loadLook } from '../games/rockets/look';
import { gameModules } from '../games/registry';
import type { ClientContext, GameClient } from '../games/types';
import { RoomSocket } from '../net/socket';
import { GameCover } from '../ui/GameCover';
import { GameDetails } from '../ui/GameDetails';
import { Header } from '../ui/Header';
import { MapPicker } from './MapPicker';

/** The robot customiser brings three.js along, so it loads on first open. */
const CustomizeDialog = lazy(() => import('../games/rockets/CustomizeDialog').then((m) => ({ default: m.CustomizeDialog })));

interface ChatLine {
  id: number;
  from: string;
  text: string;
  system?: boolean;
}

const isKeyKind = (kind: string) => kind === 'init' || kind === 'round' || kind === 'phase';

/** How the last match in this room went, kept for the "play again" panel once the room is back to waiting. */
interface LastMatch {
  /** False when the host ended it before anyone won. */
  finished: boolean;
  winner: string | null;
  rows: { id: string; value: number }[];
  /** What `value` counts: frags in Rockets, points in Ruckus. */
  unit: string;
  /** Rockets map the match was played on. */
  mapId?: string;
  mapName?: string;
  /** Rockets team modes: the winning team (null on a draw). */
  winnerTeam?: Team | null;
}

/** Reads the final standings out of a game's `end` message; every game sends `scores` and `winner`. */
function lastMatchFrom(end: GameServerMsg | undefined, init: GameServerMsg | undefined): LastMatch {
  const e = end as { winner?: string | null; winnerTeam?: Team | null; scores?: { id: string; frags?: number; points?: number }[] } | undefined;
  const map = (init as { map?: { id: string; name: string } } | undefined)?.map;
  const rows = (e?.scores ?? []).map((r) => ({ id: r.id, value: r.frags ?? r.points ?? 0 }));
  const unit = e?.scores?.[0] && 'frags' in e.scores[0] ? 'frags' : 'points';
  return { finished: !!e, winner: e?.winner ?? null, rows, unit, mapId: map?.id, mapName: map?.name, winnerTeam: e?.winnerTeam };
}

export function RoomPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Quick play arrives with router state asking for an instant start; it never stops to ask for a name.
  const quick = (location.state as QuickStart | null)?.quickStart === true;
  const [name, setName] = useState(savedName() || (quick ? 'Player' : ''));
  const [askName, setAskName] = useState(!savedName() && !quick);
  const [socket, setSocket] = useState<RoomSocket | null>(null);
  const [you, setYou] = useState('');
  const [room, setRoom] = useState<RoomView | null>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [fatal, setFatal] = useState('');
  const [notice, setNotice] = useState('');
  const [lastMatch, setLastMatch] = useState<LastMatch | null>(null);
  const endMsg = useRef<GameServerMsg | undefined>(undefined);
  const autoStarted = useRef(false);
  const roomRef = useRef<RoomView | null>(null);
  const gameRef = useRef<GameClient | null>(null);
  const pendingGame = useRef<GameServerMsg[]>([]);
  // The latest state-defining messages, replayed to a game client that mounts after they arrived
  // (late joins, and React StrictMode's double mount in development).
  const keyMsgs = useRef<{ init?: GameServerMsg; round?: GameServerMsg; phase?: GameServerMsg }>({});
  const chatId = useRef(0);

  useEffect(() => {
    if (askName || !name) return;
    const s = new RoomSocket(code.toUpperCase(), name).connect();
    setSocket(s);
    setFatal('');
    const off = s.on((msg) => {
      switch (msg.t) {
        case 'welcome':
          setYou(msg.you);
          roomRef.current = msg.room;
          setRoom(msg.room);
          // Everyone sees our robot as we customised it.
          if (msg.room.game === 'rockets') s.send({ t: 'setLook', look: loadLook() });
          break;
        case 'room': {
          const was = roomRef.current?.state;
          roomRef.current = msg.room;
          setRoom(msg.room);
          gameRef.current?.onRoom(msg.room);
          if (msg.room.state === 'playing') setLastMatch(null);
          if (msg.room.state === 'waiting' && was === 'playing') {
            setLastMatch(lastMatchFrom(endMsg.current, keyMsgs.current.init));
            endMsg.current = undefined;
          }
          if (msg.room.state === 'waiting') {
            keyMsgs.current = {};
            pendingGame.current = [];
          }
          break;
        }
        case 'chat': {
          // The id is taken outside the updater: StrictMode runs updaters twice, which used to hand out duplicate keys.
          const line = { id: ++chatId.current, from: msg.from, text: msg.text, system: msg.system };
          setChat((c) => [...c.slice(-120), line]);
          break;
        }
        case 'error':
          setNotice(msg.message);
          break;
        case 'closed':
          setFatal(msg.reason);
          break;
        case 'g': {
          const kind = (msg.m as { k: string }).k;
          if (kind === 'init') keyMsgs.current.init = msg.m;
          else if (kind === 'round') keyMsgs.current = { ...keyMsgs.current, round: msg.m, phase: undefined };
          else if (kind === 'phase') keyMsgs.current.phase = msg.m;
          else if (kind === 'end') endMsg.current = msg.m;
          if (gameRef.current) gameRef.current.onMessage(msg.m);
          else if (!isKeyKind(kind)) pendingGame.current.push(msg.m);
          break;
        }
      }
    });
    return () => {
      off();
      s.close();
      setSocket(null);
    };
  }, [code, name, askName]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const leave = useCallback(() => navigate('/'), [navigate]);

  // Quick play: start the moment we are the host of a waiting room, once. Drop the router state afterwards so a
  // reload or the next match does not start by itself.
  useEffect(() => {
    if (!quick || autoStarted.current || !socket || !room || room.hostId !== you || room.state !== 'waiting') return;
    autoStarted.current = true;
    socket.send({ t: 'start' });
    navigate(location.pathname, { replace: true, state: null });
  }, [quick, socket, room, you, navigate, location.pathname]);

  const ctx = useMemo<ClientContext | null>(() => {
    if (!socket || !you) return null;
    return { you, socket, room: () => roomRef.current!, leave };
  }, [socket, you, leave]);

  const attachGame = useCallback((client: GameClient | null) => {
    gameRef.current = client;
    if (client) {
      const { init, round, phase } = keyMsgs.current;
      for (const m of [init, round, phase]) if (m) client.onMessage(m);
      for (const m of pendingGame.current) client.onMessage(m);
      pendingGame.current = [];
    }
  }, []);

  if (askName) {
    return (
      <NamePrompt
        code={code}
        initial={name}
        onSubmit={(n) => {
          saveName(n);
          setName(n);
          setAskName(false);
        }}
      />
    );
  }

  if (fatal) {
    return (
      <div className="page">
        <Header />
        <div className="panel notice-panel">
          <span className="room-code">{code.toUpperCase()}</span>
          <p>{fatal}</p>
          <div className="form-actions" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={leave}>
              Back to the lobby
            </button>
            {roomRef.current && <PlayNowButton game={roomRef.current.game} />}
          </div>
        </div>
      </div>
    );
  }

  if (!room || !ctx) {
    return (
      <div className="page">
        <Header />
        <p className="status-line">{quick ? 'Starting your match…' : `Joining room ${code.toUpperCase()}…`}</p>
      </div>
    );
  }

  const meta = GAMES[room.game];
  const isHost = room.hostId === you;

  return (
    <div className="page" style={{ ['--accent' as string]: meta.accent }}>
      <WaitingRoom room={room} you={you} isHost={isHost} socket={socket!} notice={notice} chat={chat} lastMatch={lastMatch} onLeave={leave} />
      {room.state === 'playing' && <GameStage game={room.game} ctx={ctx} attach={attachGame} />}
    </div>
  );
}

/** Starts a fresh quick-play room of the same game; offered where the current room is gone. */
function PlayNowButton({ game }: { game: GameId }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    sfx.unlock();
    setBusy(true);
    try {
      const code = await quickPlay(game);
      navigate(`/room/${code}`, { state: { quickStart: true } satisfies QuickStart });
    } catch {
      setBusy(false);
    }
  };
  return (
    <button className="btn primary" style={{ ['--accent' as string]: GAMES[game].accent }} onClick={go} disabled={busy}>
      {busy ? 'Starting…' : `Play ${GAMES[game].name} now`}
    </button>
  );
}

function NamePrompt({ code, initial, onSubmit }: { code: string; initial: string; onSubmit: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(value.trim() || 'Player');
  };
  return (
    <div className="page">
      <Header />
      <form className="panel notice-panel" onSubmit={submit}>
        <span className="room-code">{code.toUpperCase()}</span>
        <h2>You are joining a room</h2>
        <p>What should the others call you?</p>
        <label className="field" style={{ textAlign: 'left' }}>
          Your name
          <input value={value} onChange={(e) => setValue(e.target.value)} maxLength={LIMITS.playerNameMax} placeholder="Player" autoFocus />
        </label>
        <div className="form-actions">
          <button className="btn primary" type="submit">
            Join
          </button>
        </div>
      </form>
    </div>
  );
}

function WaitingRoom({
  room,
  you,
  isHost,
  socket,
  notice,
  chat,
  lastMatch,
  onLeave,
}: {
  room: RoomView;
  you: string;
  isHost: boolean;
  socket: RoomSocket;
  notice: string;
  chat: ChatLine[];
  lastMatch: LastMatch | null;
  onLeave: () => void;
}) {
  const meta = GAMES[room.game];
  const bots = room.players.filter((p) => p.bot).length;
  const humans = room.players.length - bots;
  const host = room.players.find((p) => p.id === room.hostId);
  const canStart = room.players.length >= meta.minPlayers;
  const playing = room.state === 'playing';
  const [copied, setCopied] = useState(false);
  const [details, setDetails] = useState(false);
  const [customize, setCustomize] = useState(false);
  const shots = SCREENSHOTS[room.game];

  const share = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  const setBots = (count: number, difficulty?: BotDifficulty) => socket.send({ t: 'setBots', count, difficulty });
  const setMap = (map: string) => socket.send({ t: 'setMap', map });
  const setMode = (mode: GameMode) => socket.send({ t: 'setMode', mode });
  const setTeam = (team: Team) => socket.send({ t: 'setTeam', team });
  const start = () => (sfx.unlock(), socket.send({ t: 'start' }));
  const hasMaps = room.game === 'rockets';
  const mapName = MAP_LIST.find((m) => m.id === room.map)?.name ?? 'Random map';
  const difficulty = DIFFICULTIES.find((d) => d.id === room.botDifficulty) ?? DIFFICULTIES[1];
  const botsLabel = `${bots} ${difficulty.label.toLowerCase()} ${bots === 1 ? 'bot' : 'bots'}`;
  const rules = hasMaps ? MODES[room.mode ?? 'ffa'] : null;
  const teamMode = !!rules?.teams;
  const onMap = hasMaps ? ` on ${room.map === RANDOM_MAP ? 'a random map' : mapName}` : '';
  const lineup = teamMode
    ? `${rules!.name}: ${teamCount(room.players, 0)} vs ${teamCount(room.players, 1)}${onMap}, first to ${rules!.limit} ${GOAL_WORDS[rules!.goal]}`
    : `${rules ? `${rules.name}: ` : ''}${humans} ${humans === 1 ? 'player' : 'players'} vs ${botsLabel}${onMap}${rules ? `, first to ${rules.limit} frags` : ''}`;
  const myTeam = room.players.find((p) => p.id === you)?.team;
  const playerRow = (p: PlayerInfo) => (
    <li key={p.id} className={!p.connected ? 'offline' : ''}>
      <span className="avatar" style={{ background: colorHex(p.color) }}>
        {p.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="who">{p.name}</span>
      {p.id === you && <span className="tag">you</span>}
      {p.id === room.hostId && <span className="tag host">host</span>}
      {p.bot && <span className="tag">bot · {difficulty.label.toLowerCase()}</span>}
      {!p.bot && p.id !== you && p.connected && <span className="tag">{p.ping} ms</span>}
      {!p.connected && <span className="tag">reconnecting…</span>}
    </li>
  );

  return (
    <>
      <Header>
        <button className="btn small" onClick={share}>
          {copied ? 'Link copied' : 'Copy invite link'}
        </button>
        <button className="btn small ghost" onClick={onLeave}>
          Leave
        </button>
      </Header>

      <div className="room-title">
        <div className="room-title-main">
          <span className="pill accent">{meta.name}</span>
          <h1>{room.name}</h1>
          <span className="slots">
            {humans} {humans === 1 ? 'player' : 'players'}
            {bots ? ` + ${botsLabel}` : ''} · {room.maxPlayers} seats
            {hasMaps && ` · ${mapName}`}
          </span>
        </div>
        <div className="room-code-box" title="Share this code">
          <span className="label">Room code</span>
          <span className="room-code">{room.code}</span>
        </div>
      </div>
      {notice && <p className="error">{notice}</p>}

      {lastMatch && !playing && (
        <AfterMatch room={room} you={you} isHost={isHost} last={lastMatch} canStart={canStart} onStart={start} onMap={setMap} onLeave={onLeave} />
      )}

      <div className="room-layout">
        <div className="room-main">
          <div className="panel">
            <div className="section-head">
              <h2>Players</h2>
              <span className="slots">
                {room.players.length} / {room.maxPlayers} seats
              </span>
            </div>
            {teamMode ? (
              <div className="team-columns">
                {([0, 1] as Team[]).map((t) => {
                  const members = room.players.filter((p) => p.team === t);
                  return (
                    <div key={t} className={`team-col${myTeam === t ? ' mine' : ''}`} style={{ ['--team' as string]: TEAMS[t].css }}>
                      <div className="team-col-head">
                        <h3>{TEAMS[t].name}</h3>
                        <span className="slots">
                          {members.length} {members.length === 1 ? 'player' : 'players'}
                        </span>
                        {myTeam === t ? (
                          <span className="tag team-you">your team</span>
                        ) : (
                          <button type="button" className="btn small team-join" data-testid={`join-${t === 0 ? 'red' : 'blue'}`} onClick={() => setTeam(t)}>
                            Join {TEAMS[t].name}
                          </button>
                        )}
                      </div>
                      <ul className="players">{members.map(playerRow)}</ul>
                    </div>
                  );
                })}
              </div>
            ) : (
              <ul className="players">
                {room.players.map(playerRow)}
                {Array.from({ length: room.maxPlayers - room.players.length }, (_, i) => (
                  <li key={`free-${i}`} className="free">
                    <span className="avatar" />
                    <span className="who">Open seat</span>
                  </li>
                ))}
              </ul>
            )}
            {/* Room for per-player actions next to the line-up (the robot customiser button goes here). */}
            <div className="player-actions">
              {room.game === 'rockets' && (
                <button type="button" className="btn small" data-testid="customize" onClick={() => setCustomize(true)}>
                  Customize robot
                </button>
              )}
            </div>
            {customize && (
              <Suspense fallback={null}>
                <CustomizeDialog onChange={(look) => socket.send({ t: 'setLook', look })} onClose={() => setCustomize(false)} />
              </Suspense>
            )}

            <div className="host-controls">
              {isHost ? (
                <>
                  <span className="slots">{canStart ? lineup : `Needs at least ${meta.minPlayers} players. Add a bot or share the code.`}</span>
                  <button className="btn primary start start-btn" data-testid="start" disabled={!canStart || playing} onClick={start}>
                    {playing ? 'Match running' : `Start ${meta.name}`}
                  </button>
                </>
              ) : (
                <span className="slots">
                  {playing ? 'A match is running; you will drop in.' : `Waiting for ${host?.name ?? 'the host'} to start the game.`} {lineup}.
                </span>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="section-head">
              <h2>Bots</h2>
              <span className="slots">{isHost ? 'Fill empty seats; players always bump a bot.' : 'The host sets these.'}</span>
            </div>
            <div className="bot-controls">
              <div className="bot-count">
                <button type="button" className="btn small" onClick={() => setBots(bots - 1)} disabled={!isHost || bots <= 0} aria-label="Fewer bots">
                  −
                </button>
                <span className="bot-num">
                  <b>{bots}</b>
                  {bots === 1 ? 'bot' : 'bots'}
                </span>
                <button type="button" className="btn small" onClick={() => setBots(bots + 1)} disabled={!isHost || room.players.length >= room.maxPlayers} aria-label="More bots">
                  +
                </button>
              </div>
              <div className="difficulty-cards" role="radiogroup" aria-label="Bot difficulty">
                {DIFFICULTIES.map((d) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={d.id === room.botDifficulty}
                    key={d.id}
                    className={`difficulty-card${d.id === room.botDifficulty ? ' active' : ''}`}
                    disabled={!isHost}
                    onClick={() => (setBots(bots, d.id), saveDifficulty(d.id))}
                  >
                    <b>{d.label}</b>
                    <span>{d.blurb}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {hasMaps && rules && (
            <div className="panel">
              <div className="section-head">
                <h2>Mode</h2>
                <span className="slots">
                  {rules.name}
                  {!isHost && ' · the host picks'}
                </span>
              </div>
              {/* The cards are the picker; this select stays for keyboard users and the screenshot tool. */}
              {isHost && (
                <select className="visually-hidden" data-testid="mode-select" aria-label="Game mode" value={room.mode} disabled={playing} onChange={(e) => setMode(e.target.value as GameMode)}>
                  {MODE_IDS.map((id) => (
                    <option key={id} value={id}>
                      {MODES[id].name}
                    </option>
                  ))}
                </select>
              )}
              <div className="mode-cards" role="radiogroup" aria-label="Game mode">
                {MODE_IDS.map((id) => {
                  const m = MODES[id];
                  return (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={id === room.mode}
                      key={id}
                      className={`mode-card mode-${id}${id === room.mode ? ' active' : ''}`}
                      disabled={!isHost || playing}
                      onClick={() => setMode(id)}
                    >
                      <span className="mode-icon" aria-hidden>
                        {MODE_ICONS[id]}
                      </span>
                      <b>{m.name}</b>
                      <span>{m.blurb}</span>
                      <em>
                        {m.teams ? 'Red vs Blue' : 'Solo'} · {Math.round(m.seconds / 60)} min
                      </em>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {hasMaps && (
            <div className="panel">
              <div className="section-head">
                <h2>Map</h2>
                <span className="slots">
                  {mapName}
                  {!isHost && ' · the host picks'}
                </span>
              </div>
              {/* The cards are the picker; this select stays for keyboard users and the screenshot tool. */}
              {isHost && (
                <select className="visually-hidden" data-testid="map-select" aria-label="Map" value={room.map} onChange={(e) => setMap(e.target.value)}>
                  <option value={RANDOM_MAP}>Random map</option>
                  {MAP_LIST.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              )}
              <MapPicker value={room.map} editable={isHost} onPick={setMap} />
              <p className="slots map-legend">
                <i className="spawn" /> spawn <i className="pad" /> jump pad <i className="pack" /> health · brighter is higher
              </p>
            </div>
          )}
        </div>

        <div className="room-side">
          <div className="panel game-panel">
            <button type="button" className="panel-cover" onClick={() => setDetails(true)} aria-label={`Screenshots of ${meta.name}`}>
              <GameCover game={room.game} />
              {shots.length > 0 && <span className="tile-shots">{shots.length} screenshots</span>}
            </button>
            <h2>{meta.name}</h2>
            <p className="tagline">{meta.tagline}</p>
            <p className="desc">{meta.description}</p>
            <dl className="controls">
              {meta.controls.map((c) => (
                <div key={c.keys} style={{ display: 'contents' }}>
                  <dt>{c.keys}</dt>
                  <dd>{c.does}</dd>
                </div>
              ))}
            </dl>
          </div>
          <Chat chat={chat} socket={socket} />
        </div>
      </div>
      {details && <GameDetails game={room.game} onClose={() => setDetails(false)} />}
    </>
  );
}

const GOAL_WORDS = { frags: 'frags', captures: 'captures', rounds: 'rounds' } as const;
const teamCount = (players: PlayerInfo[], team: Team) => players.filter((p) => p.team === team).length;
/** A comic glyph per mode for the mode cards. */
const MODE_ICONS: Record<GameMode, string> = { ffa: '✸', tdm: '⚔', ctf: '⚑', elim: '☠' };

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;

/** Shown above the room after a match: who won, where you placed, and one click to go again. */
function AfterMatch({
  room,
  you,
  isHost,
  last,
  canStart,
  onStart,
  onMap,
  onLeave,
}: {
  room: RoomView;
  you: string;
  isHost: boolean;
  last: LastMatch;
  canStart: boolean;
  onStart: () => void;
  onMap: (id: string) => void;
  onLeave: () => void;
}) {
  const player = (id: string) => room.players.find((p) => p.id === id);
  const sorted = [...last.rows].sort((a, b) => b.value - a.value);
  const place = sorted.findIndex((r) => r.id === you);
  const myTeam = player(you)?.team;
  const headline = !last.finished
    ? 'Match ended early'
    : last.winnerTeam !== undefined
      ? last.winnerTeam === null
        ? 'Draw'
        : `${TEAMS[last.winnerTeam].name} won${last.winnerTeam === myTeam ? ': that is you!' : ''}`
      : last.winner === you
        ? 'You won!'
        : last.winner
          ? `${player(last.winner)?.name ?? 'Someone'} won`
          : 'Draw';
  const nextMap = () => {
    onMap(randomMapId(last.mapId));
    onStart();
  };

  return (
    <div className="panel after-match">
      <div className="after-result">
        <span className="pill accent">Match over{last.mapName ? ` · ${last.mapName}` : ''}</span>
        <h2>{headline}</h2>
        {place >= 0 && (
          <p className="slots">
            You finished {ordinal(place + 1)} of {sorted.length} with {sorted[place].value} {last.unit}.
          </p>
        )}
        {sorted.length > 0 && (
          <ol className="podium">
            {sorted.slice(0, 3).map((r) => {
              const p = player(r.id);
              return (
                <li key={r.id} className={r.id === you ? 'me' : ''}>
                  <span className="swatch" style={{ background: p ? colorHex(p.color) : 'var(--ink-faint)' }} />
                  <span className="who">{p?.name ?? 'Left the room'}</span>
                  <span className="num">{r.value}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <div className="after-actions">
        {isHost ? (
          <>
            <button className="btn primary start-btn" onClick={onStart} disabled={!canStart}>
              Play again
            </button>
            {room.game === 'rockets' && room.map !== RANDOM_MAP && (
              <button className="btn" onClick={nextMap} disabled={!canStart}>
                Play on another map
              </button>
            )}
          </>
        ) : (
          <span className="slots">Waiting for the host to start the next match.</span>
        )}
        <button className="btn ghost" onClick={onLeave}>
          Back to the lobby
        </button>
      </div>
    </div>
  );
}

function Chat({ chat, socket }: { chat: ChatLine[]; socket: RoomSocket }) {
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [chat]);
  const send = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    socket.send({ t: 'chat', text: t });
    setText('');
  };
  return (
    <div className="panel chat">
      <div className="chat-log" ref={logRef}>
        {chat.length === 0 && <span className="sys">Say hi.</span>}
        {chat.map((l) =>
          l.system ? (
            <div key={l.id} className="sys">
              {l.text}
            </div>
          ) : (
            <div key={l.id}>
              <span className="from">{l.from}</span> {l.text}
            </div>
          ),
        )}
      </div>
      <form onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={LIMITS.chatMax} placeholder="Message" />
        <button className="btn small" type="submit">
          Send
        </button>
      </form>
    </div>
  );
}

/** Full-screen canvas plus the game's HUD. Created when the room enters the playing state, torn down after. */
function GameStage({ game, ctx, attach }: { game: GameId; ctx: ClientContext; attach: (client: GameClient | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [client, setClient] = useState<GameClient | null>(null);
  const module = gameModules[game];

  useEffect(() => {
    const c = module.create(ctx);
    c.mount(hostRef.current!);
    attach(c);
    setClient(c);
    if (import.meta.env.DEV) (window as unknown as { __playClient?: GameClient }).__playClient = c;
    return () => {
      attach(null);
      c.unmount();
      setClient(null);
    };
  }, [module, ctx, attach]);

  const Hud = module.Hud;
  return (
    <div className="stage" style={{ ['--accent' as string]: GAMES[game].accent }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {client && <Hud client={client} ctx={ctx} />}
    </div>
  );
}
