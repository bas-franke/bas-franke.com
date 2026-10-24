import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { GAMES, LIMITS, type BotDifficulty, type GameId, type GameServerMsg, type RoomView, colorHex } from '@shared/protocol';
import { MAP_LIST, RANDOM_MAP } from '@shared/rockets/maps';
import { saveName, savedName } from '../api';
import { sfx } from '../engine/audio';
import { SCREENSHOTS } from '../games/catalog';
import { gameModules } from '../games/registry';
import type { ClientContext, GameClient } from '../games/types';
import { RoomSocket } from '../net/socket';
import { GameCover } from '../ui/GameCover';
import { GameDetails } from '../ui/GameDetails';
import { Header } from '../ui/Header';

interface ChatLine {
  id: number;
  from: string;
  text: string;
  system?: boolean;
}

const isKeyKind = (kind: string) => kind === 'init' || kind === 'round' || kind === 'phase';

export function RoomPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [name, setName] = useState(savedName());
  const [askName, setAskName] = useState(!savedName());
  const [socket, setSocket] = useState<RoomSocket | null>(null);
  const [you, setYou] = useState('');
  const [room, setRoom] = useState<RoomView | null>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [fatal, setFatal] = useState('');
  const [notice, setNotice] = useState('');
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
        case 'room':
          roomRef.current = msg.room;
          setRoom(msg.room);
          gameRef.current?.onRoom(msg.room);
          if (msg.room.state === 'waiting') {
            keyMsgs.current = {};
            pendingGame.current = [];
          }
          break;
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
          <button className="btn primary" onClick={leave}>
            Back to the lobby
          </button>
        </div>
      </div>
    );
  }

  if (!room || !ctx) {
    return (
      <div className="page">
        <Header />
        <p className="status-line">Joining room {code.toUpperCase()}…</p>
      </div>
    );
  }

  const meta = GAMES[room.game];
  const isHost = room.hostId === you;

  return (
    <div className="page" style={{ ['--accent' as string]: meta.accent }}>
      <WaitingRoom room={room} you={you} isHost={isHost} socket={socket!} notice={notice} chat={chat} onLeave={leave} />
      {room.state === 'playing' && <GameStage game={room.game} ctx={ctx} attach={attachGame} />}
    </div>
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
  onLeave,
}: {
  room: RoomView;
  you: string;
  isHost: boolean;
  socket: RoomSocket;
  notice: string;
  chat: ChatLine[];
  onLeave: () => void;
}) {
  const meta = GAMES[room.game];
  const bots = room.players.filter((p) => p.bot).length;
  const humans = room.players.length - bots;
  const host = room.players.find((p) => p.id === room.hostId);
  const canStart = room.players.length >= meta.minPlayers;
  const [copied, setCopied] = useState(false);
  const [details, setDetails] = useState(false);
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
  const hasMaps = room.game === 'rockets';
  const mapName = MAP_LIST.find((m) => m.id === room.map)?.name ?? 'Random map';

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
            {bots ? ` + ${bots} ${bots === 1 ? 'bot' : 'bots'}` : ''} · {room.maxPlayers} seats
            {hasMaps && ` · ${mapName}`}
          </span>
        </div>
        <div className="room-code-box" title="Share this code">
          <span className="label">Room code</span>
          <span className="room-code">{room.code}</span>
        </div>
      </div>
      {notice && <p className="error">{notice}</p>}

      <div className="room-layout">
        <div className="panel">
          <div className="section-head">
            <h2>Players</h2>
            <span className="slots">
              {room.players.length} / {room.maxPlayers} seats
            </span>
          </div>
          <ul className="players">
            {room.players.map((p) => (
              <li key={p.id} className={!p.connected ? 'offline' : ''}>
                <span className="avatar" style={{ background: colorHex(p.color) }}>
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="who">{p.name}</span>
                {p.id === you && <span className="tag">you</span>}
                {p.id === room.hostId && <span className="tag host">host</span>}
                {p.bot && <span className="tag">bot · {room.botDifficulty}</span>}
                {!p.bot && p.id !== you && p.connected && <span className="tag">{p.ping} ms</span>}
                {!p.connected && <span className="tag">reconnecting…</span>}
              </li>
            ))}
            {Array.from({ length: room.maxPlayers - room.players.length }, (_, i) => (
              <li key={`free-${i}`} className="free">
                <span className="avatar" />
                <span className="who">Open seat</span>
              </li>
            ))}
          </ul>

          <div className="host-controls">
            {isHost ? (
              <>
                <div className="segmented" title="Bots">
                  <button type="button" onClick={() => setBots(bots - 1)} disabled={bots <= 0} aria-label="Fewer bots">
                    −
                  </button>
                  <button type="button" className="active" style={{ cursor: 'default' }}>
                    {bots} {bots === 1 ? 'bot' : 'bots'}
                  </button>
                  <button type="button" onClick={() => setBots(bots + 1)} disabled={room.players.length >= room.maxPlayers} aria-label="More bots">
                    +
                  </button>
                </div>
                <div className="segmented" title="Bot difficulty">
                  {(['easy', 'normal', 'hard'] as BotDifficulty[]).map((d) => (
                    <button type="button" key={d} className={d === room.botDifficulty ? 'active' : ''} onClick={() => setBots(bots, d)}>
                      {d}
                    </button>
                  ))}
                </div>
                {hasMaps && (
                  <select className="map-select" data-testid="map-select" title="Map" value={room.map} onChange={(e) => socket.send({ t: 'setMap', map: e.target.value })}>
                    <option value={RANDOM_MAP}>Random map</option>
                    {MAP_LIST.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className="btn primary start"
                  data-testid="start"
                  disabled={!canStart || room.state === 'playing'}
                  onClick={() => (sfx.unlock(), socket.send({ t: 'start' }))}
                >
                  {room.state === 'playing' ? 'Match running' : `Start ${meta.name}`}
                </button>
                {!canStart && <span className="slots" style={{ width: '100%' }}>Needs at least {meta.minPlayers} players. Add a bot or share the code.</span>}
              </>
            ) : (
              <span className="slots">
                {room.state === 'playing' ? 'A match is running; you will drop in.' : `Waiting for ${host?.name ?? 'the host'} to start the game.`}
              </span>
            )}
          </div>
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
