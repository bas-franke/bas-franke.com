import { useEffect, useRef, useState } from 'react';
import { GAMES, type GameMode, type Team, colorHex } from '@shared/protocol';
import { RK } from '@shared/rockets/constants';
import { ELIM, MODES, TEAMS } from '@shared/rockets/modes';
import type { FlagSnap, ScoreRow } from '@shared/rockets/protocol';
import { type ClientContext, useStore } from '../types';
import type { FeedLine, RocketsClient, RocketsHudState } from './client';
import { SettingsPanel } from './SettingsPanel';
import { TouchControls, useTouchMode } from './TouchControls';
import { settings } from './settings';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * HUD fields the client may provide. They are optional so the HUD degrades gracefully: a missing field just hides
 * its widget (armor slot, speedometer, reload ring, damage arc).
 */
type HudExtra = {
  /** Current armor, 0..100. Undefined hides the armor slot. */
  armor?: number;
  /** Horizontal speed in metres per second. */
  speed?: number;
  /** Vertical speed in metres per second while airborne (up is positive). */
  vspeed?: number;
  /** Clock time (same clock as hitAt) of our last shot; drives the reload ring. */
  firedAt?: number;
  /** Direction of the last attacker relative to the view at hurtAt, radians clockwise from straight ahead. */
  hurtDir?: number;
};
/** Kill feed lines may carry ids so the HUD can colour names; plain text lines still render. */
type RichFeedLine = FeedLine & { by?: string; v?: string; self?: boolean };

const LOW_HP = 30;
/** Comic sound words for the kill feed, picked per line so a line keeps its word. */
const BLAMS = ['BLAM!', 'KA-BOOM!', 'WHAM!', 'POW!', 'KRAK!', 'BOOM!', 'SPLAT!'];
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
const sortScores = (scores: ScoreRow[]) => [...scores].sort((a, b) => (b.caps ?? 0) - (a.caps ?? 0) || b.frags - a.frags || a.deaths - b.deaths);
const TEAM_IDS: Team[] = [0, 1];
const otherTeam = (t: Team): Team => (t === 0 ? 1 : 0);
/** What the team score counts, for the score bar and the scoreboard subtitle. */
const GOAL_WORD = { frags: 'frags', captures: 'captures', rounds: 'rounds' } as const;
/** How long a big comic callout stays up. */
const CALLOUT_SECONDS = 2.4;

export function RocketsHud({ client, ctx }: { client: RocketsClient; ctx: ClientContext }) {
  const s = useStore(client.hud) as RocketsHudState & HudExtra;
  const [board, setBoard] = useState(false);
  const [menu, setMenu] = useState(false);
  const [now, setNow] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const touchMode = useTouchMode();
  const settingsOpen = useRef(false);
  settingsOpen.current = showSettings;
  const cfg = useStore(settings);
  const hpPanel = useRef<HTMLDivElement>(null);
  const room = ctx.room();
  // Once the player has the mouse (or drag-look) and has moved, the controls hints are noise: drop them for good.
  const engaged = useRef(false);
  if ((s.locked || s.dragLook) && !s.dead && (s.speed ?? 0) > 0.5) engaged.current = true;
  // Each (re)spawn: a quick colour fade-in, then a shimmer cue while spawn protection lasts.
  const wasDead = useRef(true);
  const spawnedAt = useRef(-Infinity);
  const spawns = useRef(0);
  if (wasDead.current && !s.dead && !s.ended) {
    spawnedAt.current = performance.now() / 1000;
    spawns.current++;
  }
  wasDead.current = s.dead;
  const me = s.scores.find((r) => r.id === ctx.you);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        setBoard(true);
      }
      if (e.code === 'Escape') {
        if (settingsOpen.current) setShowSettings(false);
        else setMenu((m) => !m);
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Tab' && setBoard(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => {
    client.setPaused(menu);
  }, [menu, client]);

  useEffect(() => {
    const t = setInterval(() => setNow(performance.now() / 1000), 100);
    return () => clearInterval(t);
  }, []);

  // Getting hurt jolts the health panel. Web Animations keep this off React's render path; reduced motion (the
  // setting, which defaults to the OS preference) gets a brightness pulse instead of a shake.
  useEffect(() => {
    const el = hpPanel.current;
    if (!el || !s.hurtAt) return;
    const frames = settings.get().reducedMotion
      ? [{ filter: 'brightness(1.8)' }, { filter: 'none' }]
      : [
          { transform: 'translate(0, 0)' },
          { transform: 'translate(-7px, 3px) rotate(-1.5deg)' },
          { transform: 'translate(6px, -2px) rotate(1deg)' },
          { transform: 'translate(-4px, 1px)' },
          { transform: 'translate(2px, 0)' },
          { transform: 'translate(0, 0)' },
        ];
    el.animate(frames, { duration: 360, easing: 'ease-out' });
  }, [s.hurtAt]);

  const mode = s.mode ?? room.mode ?? 'ffa';
  const rules = MODES[mode];
  const teams = rules.teams;
  const myTeam = s.myTeam;
  // Elimination starts everyone on more health; the bar fills against that.
  const hpMax = mode === 'elim' ? ELIM.health : RK.maxHealth;
  const hp = Math.max(0, Math.round(s.hp));
  const hpPct = Math.min(100, (hp / hpMax) * 100);
  const low = hp <= LOW_HP && !s.dead;
  const alive = !s.dead && !s.ended;
  const hitOn = now - s.hitAt < 0.25;
  const hurtFlash = now - s.hurtAt < 0.25;
  const arcOn = s.hurtDir !== undefined && Number.isFinite(s.hurtDir) && now - s.hurtAt < 1.1;
  const shielded = !s.dead && !s.ended && now - spawnedAt.current < RK.spawnProtection;
  const reloading = s.firedAt !== undefined && now - s.firedAt < RK.fireInterval + 0.1;
  const isHost = room.hostId === ctx.you;
  const nameOf = (id: string) => room.players.find((p) => p.id === id)?.name ?? '…';
  const teamOfId = (id: string): Team | undefined => (teams ? (room.players.find((p) => p.id === id)?.team ?? s.scores.find((r) => r.id === id)?.team) : undefined);
  // Names read in team colours in team modes, so the feed and boards say at a glance who is on which side.
  const colorOf = (id: string) => {
    const t = teamOfId(id);
    return t !== undefined ? TEAMS[t].css : colorHex(room.players.find((p) => p.id === id)?.color ?? 0xffffff);
  };
  const callout = s.callout && now - s.callout.at < CALLOUT_SECONDS ? s.callout : null;
  const round = mode === 'elim' ? s.round : undefined;
  const intermission = round?.state === 'over';
  const enemyFlag = myTeam !== undefined ? s.flags?.[otherTeam(myTeam)] : undefined;
  const carrying = mode === 'ctf' && enemyFlag?.s === 1 && enemyFlag.by === ctx.you;
  const ts = s.ts ?? [0, 0];
  const scoreTable = (scores: ScoreRow[]) => (
    <ScoreTable scores={scores} you={ctx.you} nameOf={nameOf} colorOf={colorOf} teams={teams ? ts : undefined} caps={mode === 'ctf'} teamOf={teamOfId} />
  );

  const sorted = sortScores(s.scores);
  const place = Math.max(1, sorted.findIndex((r) => r.id === ctx.you) + 1);
  const best = sorted.find((r) => r.id !== ctx.you)?.frags ?? 0;
  const lead = (me?.frags ?? 0) - best;
  const feed = (s.feed as RichFeedLine[]).filter((l) => now - l.at < 6);
  const killer = s.dead ? [...(s.feed as RichFeedLine[])].reverse().find((l) => l.v === ctx.you) : undefined;

  return (
    <div className={`hud rk ${low ? 'low' : ''} ${cfg.reducedMotion ? 'calm' : ''} ${touchMode ? 'touch-mode' : ''}`}>
      <div className={`flash ${hurtFlash ? 'on' : ''}`} />
      {low && <div className="rk-lowvig" />}
      {spawns.current > 0 && !s.dead && <div key={spawns.current} className="rk-spawnfade" />}
      {shielded && alive && <div className="rk-shield">Shielded</div>}

      {arcOn && alive && (
        <div className="rk-dmg" style={{ transform: `translate(-50%, -50%) rotate(${s.hurtDir}rad)` }}>
          <svg key={s.hurtAt} viewBox="0 0 260 260">
            <path className="ink" d="M79.3 21.3 A120 120 0 0 1 180.7 21.3" />
            <path className="red" d="M79.3 21.3 A120 120 0 0 1 180.7 21.3" />
            <path className="tip" d="M118 6 L130 -8 L142 6 Z" />
          </svg>
        </div>
      )}

      {alive && (
        <div className={`rk-xhair ${hitOn ? 'hit' : ''}`}>
          <i className="n" />
          <i className="e" />
          <i className="s" />
          <i className="w" />
          <b />
          {reloading && (
            <svg key={s.firedAt} className="rk-reload" viewBox="0 0 48 48">
              <circle className="track" cx="24" cy="24" r="20" />
              <circle className="fill" cx="24" cy="24" r="20" style={{ animationDuration: `${RK.fireInterval}s` }} />
            </svg>
          )}
          {now - s.hitAt < 0.5 && (
            <div key={s.hitAt} className="rk-hitmark">
              <i />
              <i />
              <i />
              <i />
            </div>
          )}
        </div>
      )}

      {touchMode && !s.ended && !menu && (
        <TouchControls touch={(client as unknown as { touch: import('../../engine/touch').TouchInput }).touch} onMenu={() => setMenu(true)} onScores={setBoard} />
      )}

      <div className="corner tl">
        <div ref={hpPanel} className={`rk-panel rk-health ${low ? 'low' : ''}`}>
          <div className="row">
            <span className="label">Health</span>
            {low && <span className="rk-tag">Low!</span>}
          </div>
          <div className="row">
            <span className="big">{hp}</span>
            <div className="rk-bar hp">
              <i className="ghost" style={{ width: `${hpPct}%` }} />
              <i className="fill" style={{ width: `${hpPct}%` }} />
            </div>
          </div>
          {s.armor !== undefined && (
            <div className="row armor">
              <span className="label">Armor</span>
              <span className="mid">{Math.max(0, Math.round(s.armor))}</span>
              <div className="rk-bar ar">
                <i className="fill" style={{ width: `${Math.max(0, Math.min(100, s.armor))}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="corner tc">
        {teams ? (
          <TeamBar
            mode={mode}
            ts={ts}
            myTeam={myTeam}
            left={s.left}
            hurry={s.left <= 30 && !s.ended}
            overtime={!!s.overtime}
            flags={mode === 'ctf' ? s.flags : undefined}
            flagReturn={s.flagReturn}
            alive={round?.alive}
            roundNo={round?.n}
            roundLeft={round && round.state === 'play' ? round.left : undefined}
            nameOf={(id) => (id === ctx.you ? 'You' : nameOf(id))}
          />
        ) : (
          <span className={`rk-panel timer ${s.left <= 30 && !s.ended ? 'hurry' : ''}`}>{fmt(s.left)}</span>
        )}
      </div>

      {callout && !s.ended && (
        <div key={callout.id} className="rk-callout" style={callout.team !== undefined ? { ['--team' as string]: TEAMS[callout.team].css } : undefined}>
          {callout.text}
        </div>
      )}
      {intermission && round && !s.ended && (
        <div className="rk-intermission">
          <span className="label">Round {round.n} over</span>
          <b>
            Next round in <em key={Math.ceil(round.left)}>{Math.max(1, Math.ceil(round.left))}</em>
          </b>
        </div>
      )}
      {carrying && alive && myTeam !== undefined && (
        <div className="rk-carry" style={{ ['--team' as string]: TEAMS[otherTeam(myTeam)].css }}>
          You have the {TEAMS[otherTeam(myTeam)].name} flag! Bring it home
        </div>
      )}

      <div className="corner tr">
        <div className="rk-panel rk-frags">
          <span className="label">{mode === 'ctf' ? 'Frags · caps' : 'Frags'}</span>
          <div className="row">
            <span className="big">{me?.frags ?? 0}</span>
            {mode === 'ffa' && <span className="of">/{rules.limit}</span>}
            {mode === 'ctf' && <span className="of">· {me?.caps ?? 0}</span>}
          </div>
          {teams && myTeam !== undefined && (
            <div className="rk-place" style={{ color: TEAMS[myTeam].css }}>
              Team {TEAMS[myTeam].name}
            </div>
          )}
          {!teams && s.scores.length > 1 && (
            <div className={`rk-place ${place === 1 ? 'first' : ''}`}>
              {ordinal(place)} · {lead > 0 ? `+${lead}` : lead === 0 ? 'tied' : lead}
            </div>
          )}
        </div>
        <div className="rk-feed">
          {feed.map((l) => (
            <FeedRow key={l.id} line={l} you={ctx.you} nameOf={nameOf} colorOf={colorOf} />
          ))}
        </div>
      </div>

      {alive && s.speed !== undefined && (
        <div className={`rk-speed ${s.speed > RK.groundSpeed * 1.6 ? 'fast' : s.speed > RK.groundSpeed + 0.5 ? 'gain' : ''}`}>
          <b>{Math.round(s.speed)}</b>
          <span>m/s</span>
          {s.vspeed !== undefined && Math.abs(s.vspeed) > 2 && (
            <em className={s.vspeed > 0 ? 'up' : 'down'}>
              {s.vspeed > 0 ? '▲' : '▼'}
              {Math.round(Math.abs(s.vspeed))}
            </em>
          )}
        </div>
      )}

      {s.dead && !s.ended && mode === 'elim' && !intermission && (
        <div className="rk-respawn rk-spectate">
          <h2>Out for this round</h2>
          <p>
            {s.spectating ? (
              <>
                Watching <span style={{ color: colorOf(s.spectating) }}>{nameOf(s.spectating)}</span> · click or Space for the next teammate
              </>
            ) : (
              'Waiting for the next round'
            )}
          </p>
        </div>
      )}
      {s.dead && !s.ended && mode !== 'elim' && (
        <div className="rk-respawn">
          <div className="burst">SPLAT!</div>
          <h2>{killer?.by && !killer.self ? `${nameOf(killer.by)} got you` : 'You got rocketed'}</h2>
          <p>
            Respawn in <b key={Math.ceil(s.respawnIn)}>{Math.max(1, Math.ceil(s.respawnIn))}</b>
          </p>
        </div>
      )}

      <div className="corner bc">
        {!touchMode && !s.locked && !s.dragLook && !s.ended && !menu && (
          <span className="hint-bar" onClick={() => client.setPaused(false)}>
            {engaged.current ? (
              'Click the arena to grab the mouse'
            ) : (
              <>
                Click the arena to grab the mouse · <kbd>WASD</kbd> move · <kbd>Space</kbd> jump · click to fire
              </>
            )}
          </span>
        )}
        {!touchMode && s.dragLook && !engaged.current && !s.ended && !menu && (
          <span className="hint-bar">
            Pointer lock is unavailable here: drag to look, <kbd>F</kbd> or <kbd>Ctrl</kbd> to fire
          </span>
        )}
      </div>
      {touchMode ? (
        cfg.showFps && s.fps > 0 && <div className="menu-hint top">{s.fps} fps</div>
      ) : (
        <div className="menu-hint">
          {cfg.showFps && s.fps > 0 && <span className="fps">{s.fps} fps · </span>}
          Esc: menu · Tab: scores
        </div>
      )}

      {s.ended && (
        <div className="overlay-center" style={{ pointerEvents: 'auto' }}>
          <div className="scoreboard end">
            {teams && s.ended.winnerTeam !== undefined ? (
              <>
                <div className={`burst ${s.ended.winnerTeam !== null && s.ended.winnerTeam === myTeam ? 'win' : ''}`}>
                  {s.ended.winnerTeam === null ? 'Draw!' : s.ended.winnerTeam === myTeam ? 'Victory!' : 'Defeat!'}
                </div>
                <h2 className="rk-teamwin" style={s.ended.winnerTeam !== null ? { color: TEAMS[s.ended.winnerTeam].css } : undefined}>
                  {s.ended.winnerTeam === null ? 'Nobody wins' : `${TEAMS[s.ended.winnerTeam].name} wins`}
                </h2>
              </>
            ) : (
              <>
                <div className={`burst ${s.ended.winner === ctx.you ? 'win' : ''}`}>
                  {s.ended.winner === ctx.you ? 'Victory!' : s.ended.winner ? 'Defeat!' : 'Draw!'}
                </div>
                <h2>{s.ended.winner ? `${nameOf(s.ended.winner)} wins` : 'Nobody wins'}</h2>
              </>
            )}
            <p className="sub">Back to the room in a moment.</p>
            {scoreTable(s.ended.scores)}
            <div className="actions">
              {isHost && (
                // Restart straight away instead of waiting for the room to come back.
                <button className="btn primary" onClick={() => (ctx.socket.send({ t: 'stop' }), ctx.socket.send({ t: 'start' }))}>
                  Play again
                </button>
              )}
              <button className="btn ghost" onClick={ctx.leave}>
                Back to main page
              </button>
            </div>
          </div>
        </div>
      )}

      {board && !s.ended && (
        <div className="overlay-center" style={{ pointerEvents: 'none' }}>
          <div className="scoreboard">
            <h2>{GAMES.rockets.name}</h2>
            <p className="sub">{`${rules.name} · ${s.mapName} · ${fmt(s.left)} left · first to ${rules.limit} ${teams ? GOAL_WORD[rules.goal] : 'frags'}`}</p>
            {scoreTable(s.scores)}
          </div>
        </div>
      )}

      {menu && !s.ended && (
        <div className="overlay-center">
          <div className="scoreboard">
            <h2>Paused (for you)</h2>
            <p className="sub">
              The match keeps running on {s.mapName}. Room code {room.code}.
            </p>
            {scoreTable(s.scores)}
            <div className="actions">
              {teams && myTeam !== undefined && (
                // The server kills us without penalty and we respawn on the other side.
                <button className="btn rk-switch" style={{ ['--team' as string]: TEAMS[otherTeam(myTeam)].css }} onClick={() => (client.switchTeam(otherTeam(myTeam)), setMenu(false))}>
                  Switch to {TEAMS[otherTeam(myTeam)].name}
                </button>
              )}
              {isHost && (
                <button className="btn danger" onClick={() => ctx.socket.send({ t: 'stop' })}>
                  End match for everyone
                </button>
              )}
              <button className="btn ghost" onClick={ctx.leave}>
                Back to main page
              </button>
              <button className="btn ghost" onClick={() => setShowSettings(true)}>
                Settings
              </button>
              <button className="btn primary" onClick={() => setMenu(false)}>
                Resume
              </button>
            </div>
          </div>
        </div>
      )}
      {menu && showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} rawSupported={(client as { rawSupported?: boolean | null }).rawSupported ?? null} />
      )}
    </div>
  );
}

function FeedRow({ line, you, nameOf, colorOf }: { line: RichFeedLine; you: string; nameOf: (id: string) => string; colorOf: (id: string) => string }) {
  const mine = line.by === you || line.v === you;
  if (!line.v) {
    return (
      <div className="rk-line">
        <span>{line.text}</span>
      </div>
    );
  }
  const victim = (
    <span className="who" style={{ color: colorOf(line.v) }}>
      {line.v === you ? 'You' : nameOf(line.v)}
    </span>
  );
  return (
    <div className={`rk-line ${mine ? 'mine' : ''}`}>
      {line.self || !line.by ? (
        <>
          {victim}
          <span className="blam">OOPS!</span>
        </>
      ) : (
        <>
          <span className="who" style={{ color: colorOf(line.by) }}>
            {line.by === you ? 'You' : nameOf(line.by)}
          </span>
          <span className="blam">{BLAMS[line.id % BLAMS.length]}</span>
          {victim}
        </>
      )}
    </div>
  );
}

/** Top-centre bar in team modes: Red score, the clock and the goal, Blue score; flag states (CTF) or alive counts (elim). */
function TeamBar({
  mode,
  ts,
  myTeam,
  left,
  hurry,
  overtime,
  flags,
  flagReturn,
  alive,
  roundNo,
  roundLeft,
  nameOf,
}: {
  mode: GameMode;
  ts: [number, number];
  myTeam?: Team;
  left: number;
  hurry: boolean;
  overtime: boolean;
  flags?: [FlagSnap, FlagSnap];
  flagReturn?: [number, number];
  alive?: [number, number];
  roundNo?: number;
  roundLeft?: number;
  nameOf: (id: string) => string;
}) {
  const rules = MODES[mode];
  const side = (t: Team) => (
    <div className={`rk-team t${t} ${t === myTeam ? 'mine' : ''} ${ts[t] > ts[otherTeam(t)] ? 'ahead' : ''}`} style={{ ['--team' as string]: TEAMS[t].css }}>
      <span className="name">{TEAMS[t].name}</span>
      <b key={ts[t]}>{ts[t]}</b>
      {flags && <FlagStatus flag={flags[t]} team={t} returnIn={flagReturn?.[t] ?? 0} nameOf={nameOf} />}
      {alive && (
        <span className="rk-alive" title="Alive">
          {Array.from({ length: Math.min(8, Math.max(alive[t], 0)) }, (_, i) => (
            <i key={i} />
          ))}
          <em>{alive[t]} up</em>
        </span>
      )}
    </div>
  );
  return (
    <div className="rk-teambar">
      {side(0)}
      <div className="mid">
        <span className={`timer ${hurry ? 'hurry' : ''}`}>{fmt(roundLeft ?? left)}</span>
        <span className="goal">
          {overtime ? 'Sudden death' : roundNo ? `Round ${roundNo} · first to ${rules.limit}` : `First to ${rules.limit} ${GOAL_WORD[rules.goal]}`}
        </span>
      </div>
      {side(1)}
    </div>
  );
}

/** A little ink-outlined flag: upright at base, tilted and pulsing when taken, on its side when dropped. */
function FlagStatus({ flag, team, returnIn, nameOf }: { flag: FlagSnap; team: Team; returnIn: number; nameOf: (id: string) => string }) {
  const state = flag.s === 0 ? 'base' : flag.s === 1 ? 'taken' : 'dropped';
  const text = flag.s === 0 ? 'At base' : flag.s === 1 ? (flag.by ? `${nameOf(flag.by)}!` : 'Taken!') : `Dropped · ${returnIn}s`;
  return (
    <span className={`rk-flag ${state}`}>
      <svg viewBox="0 0 24 24" aria-hidden>
        <path className="pole" d="M6 3 V22" />
        <path className="cloth" d="M7 4 C11 2.5 14 6 19 4.5 V12 C14 13.5 11 10 7 11.5 Z" style={{ fill: TEAMS[team].css }} />
      </svg>
      <span>{text}</span>
    </span>
  );
}

function ScoreTable({
  scores,
  you,
  nameOf,
  colorOf,
  teams,
  caps,
  teamOf,
}: {
  scores: ScoreRow[];
  you: string;
  nameOf: (id: string) => string;
  colorOf: (id: string) => string;
  /** Team modes: team scores; rows are grouped under a header per team. */
  teams?: [number, number];
  /** Show the captures column (CTF). */
  caps?: boolean;
  teamOf?: (id: string) => Team | undefined;
}) {
  const sorted = sortScores(scores);
  const cols = caps ? 5 : 4;
  const row = (r: ScoreRow, i: number) => (
    <tr key={r.id} className={`${r.id === you ? 'me' : ''} ${i === 0 && (r.frags > 0 || (r.caps ?? 0) > 0) ? 'top' : ''}`}>
      <td className="rank">{i + 1}</td>
      <td>
        <span className="swatch" style={{ background: colorOf(r.id) }} />
        {nameOf(r.id)}
      </td>
      {caps && <td className="num">{r.caps ?? 0}</td>}
      <td className="num">{r.frags}</td>
      <td className="num">{r.deaths}</td>
    </tr>
  );
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: 36 }}>#</th>
          <th>Player</th>
          {caps && <th style={{ textAlign: 'right' }}>Caps</th>}
          <th style={{ textAlign: 'right' }}>Frags</th>
          <th style={{ textAlign: 'right' }}>Deaths</th>
        </tr>
      </thead>
      {teams ? (
        TEAM_IDS.map((t) => {
          const rows = sorted.filter((r) => (r.team ?? teamOf?.(r.id)) === t);
          const frags = rows.reduce((n, r) => n + r.frags, 0);
          return (
            <tbody key={t} className="rk-teamrows" style={{ ['--team' as string]: TEAMS[t].css }}>
              <tr className="team-head">
                <td colSpan={cols}>
                  <span className="tname">{TEAMS[t].name}</span>
                  <b>{teams[t]}</b>
                  <span className="tsub">
                    {rows.length} {rows.length === 1 ? 'player' : 'players'} · {frags} frags
                  </span>
                </td>
              </tr>
              {rows.map(row)}
            </tbody>
          );
        })
      ) : (
        <tbody>{sorted.map(row)}</tbody>
      )}
    </table>
  );
}

