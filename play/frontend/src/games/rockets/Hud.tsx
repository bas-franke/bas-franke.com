import { useEffect, useState } from 'react';
import { GAMES, colorHex } from '@shared/protocol';
import { RK } from '@shared/rockets/constants';
import type { ScoreRow } from '@shared/rockets/protocol';
import { type ClientContext, useStore } from '../types';
import type { RocketsClient } from './client';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function RocketsHud({ client, ctx }: { client: RocketsClient; ctx: ClientContext }) {
  const s = useStore(client.hud);
  const [board, setBoard] = useState(false);
  const [menu, setMenu] = useState(false);
  const [now, setNow] = useState(0);
  const room = ctx.room();
  const me = s.scores.find((r) => r.id === ctx.you);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        setBoard(true);
      }
      if (e.code === 'Escape') setMenu((m) => !m);
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

  const hitFlash = now - s.hitAt < 0.15;
  const hurtFlash = now - s.hurtAt < 0.25;
  const isHost = room.hostId === ctx.you;
  const nameOf = (id: string) => room.players.find((p) => p.id === id)?.name ?? '…';
  const colorOf = (id: string) => colorHex(room.players.find((p) => p.id === id)?.color ?? 0xffffff);

  return (
    <div className="hud">
      <div className={`flash ${hurtFlash ? 'on' : ''}`} />
      {!s.dead && !s.ended && <div className={`crosshair ${hitFlash ? 'hit' : ''}`} />}

      <div className="corner tl">
        <div className="label">Health</div>
        <div className="big" style={{ color: s.hp <= 30 ? 'var(--coral)' : undefined }}>
          {Math.max(0, Math.round(s.hp))}
        </div>
        <div className="hp-bar">
          <i className={s.hp <= 30 ? 'low' : ''} style={{ width: `${Math.max(0, Math.min(100, s.hp))}%` }} />
        </div>
      </div>

      <div className="corner tc">
        <span className="timer">{fmt(s.left)}</span>
      </div>

      <div className="corner tr">
        <div className="label">Frags · first to {RK.fragLimit}</div>
        <div className="big">{me?.frags ?? 0}</div>
        <div className="feed">
          {s.feed
            .filter((l) => now - l.at < 6)
            .map((l) => (
              <div key={l.id}>{l.text}</div>
            ))}
        </div>
      </div>

      <div className="corner bc">
        {s.dead && !s.ended && (
          <div className="banner" style={{ position: 'static', transform: 'none' }}>
            <h2 style={{ fontSize: 28 }}>You got rocketed</h2>
            <p>Respawning in {Math.ceil(s.respawnIn)}…</p>
          </div>
        )}
        {!s.locked && !s.dragLook && !s.ended && !menu && (
          <span className="hint-bar" onClick={() => client.setPaused(false)}>
            Click the arena to grab the mouse · <kbd>WASD</kbd> move · <kbd>Space</kbd> jump · click to fire
          </span>
        )}
        {s.dragLook && !s.ended && !menu && (
          <span className="hint-bar">
            Pointer lock is unavailable here: drag to look, <kbd>F</kbd> or <kbd>Ctrl</kbd> to fire
          </span>
        )}
      </div>
      <div className="menu-hint">
        {s.fps > 0 && <span className="fps">{s.fps} fps · </span>}
        Esc: menu · Tab: scores
      </div>

      {(board || s.ended) && (
        <div className="overlay-center" style={{ pointerEvents: s.ended ? 'auto' : 'none' }}>
          <div className="scoreboard">
            <h2>{s.ended ? (s.ended.winner ? `${nameOf(s.ended.winner)} wins` : 'Draw') : GAMES.rockets.name}</h2>
            <p className="sub">{s.ended ? 'Back to the room in a moment.' : `${s.mapName} · ${fmt(s.left)} left · first to ${RK.fragLimit} frags`}</p>
            <ScoreTable scores={s.scores} you={ctx.you} nameOf={nameOf} colorOf={colorOf} />
            {s.ended && (
              <div className="actions">
                <button className="btn ghost" onClick={ctx.leave}>
                  Leave room
                </button>
              </div>
            )}
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
              <button className="btn primary" onClick={() => setMenu(false)}>
                Resume
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ScoreTable({ scores, you, nameOf, colorOf }: { scores: ScoreRow[]; you: string; nameOf: (id: string) => string; colorOf: (id: string) => string }) {
  const sorted = [...scores].sort((a, b) => b.frags - a.frags || a.deaths - b.deaths);
  return (
    <table>
      <thead>
        <tr>
          <th>Player</th>
          <th style={{ textAlign: 'right' }}>Frags</th>
          <th style={{ textAlign: 'right' }}>Deaths</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.id} className={r.id === you ? 'me' : ''}>
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
