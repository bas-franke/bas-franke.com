import { useEffect, useRef, useState } from 'react';
import { GAMES, colorHex } from '@shared/protocol';
import { RK } from '@shared/rockets/constants';
import type { ScoreRow } from '@shared/rockets/protocol';
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
const sortScores = (scores: ScoreRow[]) => [...scores].sort((a, b) => b.frags - a.frags || a.deaths - b.deaths);

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

  const hp = Math.max(0, Math.min(RK.maxHealth, Math.round(s.hp)));
  const low = hp <= LOW_HP && !s.dead;
  const alive = !s.dead && !s.ended;
  const hitOn = now - s.hitAt < 0.25;
  const hurtFlash = now - s.hurtAt < 0.25;
  const arcOn = s.hurtDir !== undefined && Number.isFinite(s.hurtDir) && now - s.hurtAt < 1.1;
  const reloading = s.firedAt !== undefined && now - s.firedAt < RK.fireInterval + 0.1;
  const isHost = room.hostId === ctx.you;
  const nameOf = (id: string) => room.players.find((p) => p.id === id)?.name ?? '…';
  const colorOf = (id: string) => colorHex(room.players.find((p) => p.id === id)?.color ?? 0xffffff);

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
              <i className="ghost" style={{ width: `${hp}%` }} />
              <i className="fill" style={{ width: `${hp}%` }} />
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
        <span className={`rk-panel timer ${s.left <= 30 && !s.ended ? 'hurry' : ''}`}>{fmt(s.left)}</span>
      </div>

      <div className="corner tr">
        <div className="rk-panel rk-frags">
          <span className="label">Frags</span>
          <div className="row">
            <span className="big">{me?.frags ?? 0}</span>
            <span className="of">/{RK.fragLimit}</span>
          </div>
          {s.scores.length > 1 && (
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
        </div>
      )}

      {s.dead && !s.ended && (
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
            Click the arena to grab the mouse · <kbd>WASD</kbd> move · <kbd>Space</kbd> jump · click to fire
          </span>
        )}
        {!touchMode && s.dragLook && !s.ended && !menu && (
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
            <div className={`burst ${s.ended.winner === ctx.you ? 'win' : ''}`}>
              {s.ended.winner === ctx.you ? 'Victory!' : s.ended.winner ? 'Defeat!' : 'Draw!'}
            </div>
            <h2>{s.ended.winner ? `${nameOf(s.ended.winner)} wins` : 'Nobody wins'}</h2>
            <p className="sub">Back to the room in a moment.</p>
            <ScoreTable scores={s.ended.scores} you={ctx.you} nameOf={nameOf} colorOf={colorOf} />
            <div className="actions">
              <button className="btn ghost" onClick={ctx.leave}>
                Leave room
              </button>
            </div>
          </div>
        </div>
      )}

      {board && !s.ended && (
        <div className="overlay-center" style={{ pointerEvents: 'none' }}>
          <div className="scoreboard">
            <h2>{GAMES.rockets.name}</h2>
            <p className="sub">{`${s.mapName} · ${fmt(s.left)} left · first to ${RK.fragLimit} frags`}</p>
            <ScoreTable scores={s.scores} you={ctx.you} nameOf={nameOf} colorOf={colorOf} />
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
            <ScoreTable scores={s.scores} you={ctx.you} nameOf={nameOf} colorOf={colorOf} />
            <div className="actions">
              {isHost && (
                <button className="btn danger" onClick={() => ctx.socket.send({ t: 'stop' })}>
                  End match for everyone
                </button>
              )}
              <button className="btn ghost" onClick={ctx.leave}>
                Leave room
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

function ScoreTable({ scores, you, nameOf, colorOf }: { scores: ScoreRow[]; you: string; nameOf: (id: string) => string; colorOf: (id: string) => string }) {
  const sorted = sortScores(scores);
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: 36 }}>#</th>
          <th>Player</th>
          <th style={{ textAlign: 'right' }}>Frags</th>
          <th style={{ textAlign: 'right' }}>Deaths</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r, i) => (
          <tr key={r.id} className={`${r.id === you ? 'me' : ''} ${i === 0 && r.frags > 0 ? 'top' : ''}`}>
            <td className="rank">{i + 1}</td>
            <td>
              <span className="swatch" style={{ background: colorOf(r.id) }} />
              {nameOf(r.id)}
            </td>
            <td className="num">{r.frags}</td>
            <td className="num">{r.deaths}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
