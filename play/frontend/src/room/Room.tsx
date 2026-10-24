import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { GAMES, LIMITS, type BotDifficulty, type GameId, type GameServerMsg, type RoomView, colorHex } from '@shared/protocol';
import { MAP_LIST, RANDOM_MAP } from '@shared/rockets/maps';
import { DIFFICULTIES, type QuickStart, quickPlay, randomMapId, saveDifficulty, saveName, savedName } from '../api';
import { sfx } from '../engine/audio';
import { gameModules } from '../games/registry';
import type { ClientContext, GameClient } from '../games/types';
import { RoomSocket } from '../net/socket';
import { MapPicker } from './MapPicker';

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
}

/** Reads the final standings out of a game's `end` message; every game sends `scores` and `winner`. */
function lastMatchFrom(end: GameServerMsg | undefined, init: GameServerMsg | undefined): LastMatch {
  const e = end as { winner?: string | null; scores?: { id: string; frags?: number; points?: number }[] } | undefined;
  const map = (init as { map?: { id: string; name: string } } | undefined)?.map;
  const rows = (e?.scores ?? []).map((r) => ({ id: r.id, value: r.frags ?? r.points ?? 0 }));
  const unit = e?.scores?.[0] && 'frags' in e.scores[0] ? 'frags' : 'points';
  return { finished: !!e, winner: e?.winner ?? null, rows, unit, mapId: map?.id, mapName: map?.name };
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
        case 'chat':
          setChat((c) => [...c.slice(-120), { id: ++chatId.current, from: msg.from, text: msg.text, system: msg.system }]);
          break;
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
        <div className="panel" style={{ maxWidth: 520, margin: '40px auto', textAlign: 'center' }}>
          <h2 style={{ marginBottom: 8 }}>Room {code.toUpperCase()}</h2>
          <p style={{ color: 'var(--ink-dim)' }}>{fatal}</p>
          <div className="form-actions" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={leave}>
              Back to the lobby
            </button>
            <QuickPlayButton />
          </div>
        </div>
      </div>
    );
  }

  if (!room || !ctx) {
    return (
      <div className="page">
        <Header />
        <p className="status-line">{quick ? 'Dropping you into the arena…' : `Joining room ${code.toUpperCase()}…`}</p>
      </div>
    );
  }

  const meta = GAMES[room.game];
  const isHost = room.hostId === you;

  return (
    <div className="page" style={{ ['--accent' as string]: meta.accent }}>
      <Header />
      <WaitingRoom room={room} you={you} isHost={isHost} socket={socket!} notice={notice} chat={chat} lastMatch={lastMatch} onLeave={leave} />
      {room.state === 'playing' && <GameStage game={room.game} ctx={ctx} attach={attachGame} />}
    </div>
  );
}

/** Starts a fresh quick-play room; offered where the current room is gone. */
function QuickPlayButton() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    sfx.unlock();
    setBusy(true);
    try {
      const code = await quickPlay();
      navigate(`/room/${code}`, { state: { quickStart: true } satisfies QuickStart });
    } catch {
      setBusy(false);
    }
  };
  return (
    <button className="btn primary" style={{ ['--accent' as string]: GAMES.rockets.accent }} onClick={go} disabled={busy}>
      {busy ? 'Setting up…' : 'Quick play Rockets'}
    </button>
  );
}

function Header() {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        play<span className="dot">.</span>
        <small>bas-franke.com</small>
      </a>
    </header>
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
      <form className="panel" onSubmit={submit} style={{ maxWidth: 420, margin: '40px auto' }}>
        <h2 style={{ marginBottom: 6 }}>Joining room {code.toUpperCase()}</h2>
        <p style={{ color: 'var(--ink-dim)', marginTop: 0 }}>What should the others call you?</p>
        <label className="field">
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
  const start = () => (sfx.unlock(), socket.send({ t: 'start' }));
  const hasMaps = room.game === 'rockets';
  const mapName = MAP_LIST.find((m) => m.id === room.map)?.name ?? 'Random every match';
  const difficulty = DIFFICULTIES.find((d) => d.id === room.botDifficulty) ?? DIFFICULTIES[1];
  const lineup = `${humans} ${humans === 1 ? 'player' : 'players'} vs ${bots} ${difficulty.label.toLowerCase()} ${bots === 1 ? 'bot' : 'bots'}${hasMaps ? ` on ${mapName === 'Random every match' ? 'a random map' : mapName}` : ''}`;

  return (
    <>
      <div className="room-title">
        <h1>{room.name}</h1>
        <span className="room-code" title="Room code">
          {room.code}
        </span>
        <span className="pill accent">{meta.name}</span>
        <button className="btn small" onClick={share}>
          {copied ? 'Link copied' : 'Copy invite link'}
        </button>
        <button className="btn small ghost" onClick={onLeave}>
          Leave
        </button>
      </div>
      {notice && <p className="error">{notice}</p>}

      {lastMatch && !playing && (
        <AfterMatch room={room} you={you} isHost={isHost} last={lastMatch} canStart={canStart} onStart={start} socket={socket} onLeave={onLeave} />
      )}

      <div className="room-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          <div className="panel">
            <div className="section-head" style={{ marginBottom: 10 }}>
              <h2>Players</h2>
              <span className="slots">
                {room.players.length} / {room.maxPlayers} seats
              </span>
            </div>
            <ul className="players">
              {room.players.map((p) => (
                <li key={p.id} className={!p.connected ? 'offline' : ''}>
                  <span className="swatch" style={{ background: colorHex(p.color) }} />
                  <span className="who">{p.name}</span>
                  {p.id === you && <span className="tag">you</span>}
                  {p.id === room.hostId && <span className="tag">host</span>}
                  {p.bot && <span className="tag">bot · {difficulty.label.toLowerCase()}</span>}
                  {!p.bot && p.id !== you && p.connected && <span className="tag">{p.ping} ms</span>}
                </li>
              ))}
            </ul>

            <div className="start-row">
              {isHost ? (
                <>
                  <button className="btn primary start-btn" disabled={!canStart || playing} onClick={start}>
                    {playing ? 'Match running' : `Start ${meta.name}`}
                  </button>
                  <span className="slots">{canStart ? lineup : `Needs at least ${meta.minPlayers} players. Add a bot or share the code.`}</span>
                </>
              ) : (
                <span className="slots">
                  {playing ? 'A match is running; you will drop in.' : `Waiting for ${host?.name ?? 'the host'} to start the game.`} {lineup}.
                </span>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="section-head" style={{ marginBottom: 12 }}>
              <h2>Bots</h2>
              <span className="slots">{isHost ? 'Fill empty seats; players always bump a bot.' : 'The host sets these.'}</span>
            </div>
            <div className="bot-controls">
              <div className="bot-count" aria-label="Number of bots">
                <button type="button" className="btn small" onClick={() => setBots(bots - 1)} disabled={!isHost || bots <= 0} aria-label="Remove a bot">
                  −
                </button>
                <span className="bot-num">
                  <b>{bots}</b>
                  {bots === 1 ? 'bot' : 'bots'}
                </span>
                <button type="button" className="btn small" onClick={() => setBots(bots + 1)} disabled={!isHost || room.players.length >= room.maxPlayers} aria-label="Add a bot">
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

          {hasMaps && (
            <div className="panel">
              <div className="section-head" style={{ marginBottom: 12 }}>
                <h2>Map</h2>
                <span className="slots">
                  {mapName}
                  {!isHost && ' · the host picks'}
                </span>
              </div>
              <MapPicker value={room.map} editable={isHost} onPick={(map) => socket.send({ t: 'setMap', map })} />
              <p className="slots map-legend">
                <i className="spawn" /> spawn <i className="pad" /> jump pad <i className="pack" /> health · brighter is higher
              </p>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="panel">
            <h2 style={{ fontSize: 20, marginBottom: 6 }}>{meta.name}</h2>
            <p style={{ color: 'var(--ink-dim)', margin: '0 0 12px' }}>{meta.description}</p>
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
    </>
  );
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** Shown above the room after a match: who won, where you placed, and one click to go again. */
function AfterMatch({
  room,
  you,
  isHost,
  last,
  canStart,
  onStart,
  socket,
  onLeave,
}: {
  room: RoomView;
  you: string;
  isHost: boolean;
  last: LastMatch;
  canStart: boolean;
  onStart: () => void;
  socket: RoomSocket;
  onLeave: () => void;
}) {
  const player = (id: string) => room.players.find((p) => p.id === id);
  const sorted = [...last.rows].sort((a, b) => b.value - a.value);
  const place = sorted.findIndex((r) => r.id === you);
  const headline = !last.finished ? 'Match ended early' : last.winner === you ? 'You won!' : last.winner ? `${player(last.winner)?.name ?? 'Someone'} won` : 'Draw';
  const hasMaps = room.game === 'rockets';
  const nextMap = () => {
    socket.send({ t: 'setMap', map: randomMapId(last.mapId) });
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
            {hasMaps && room.map !== RANDOM_MAP && (
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
