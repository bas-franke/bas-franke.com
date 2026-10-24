import { useEffect, useState } from 'react';
import { colorHex } from '@shared/protocol';
import { RU } from '@shared/ruckus/constants';
import type { RuckusScore } from '@shared/ruckus/protocol';
import { type ClientContext, useStore } from '../types';
import { type RuckusClient, minigameName, minigameRules } from './client';

export function RuckusHud({ client, ctx }: { client: RuckusClient; ctx: ClientContext }) {
  const s = useStore(client.hud);
  const [board, setBoard] = useState(false);
  const [menu, setMenu] = useState(false);
  const room = ctx.room();
  const nameOf = (id: string) => room.players.find((p) => p.id === id)?.name ?? '…';
  const colorOf = (id: string) => colorHex(room.players.find((p) => p.id === id)?.color ?? 0xffffff);
  const isHost = room.hostId === ctx.you;

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

  const sorted = [...s.scores].sort((a, b) => b.points - a.points);
  const dashReady = s.dashCd <= 0;
  const holderName = s.holder ? nameOf(s.holder) : null;

  return (
    <div className="hud">
      <div className="corner tc">
        {s.mg && (
          <div>
            <div className="label">
              Round {s.round} of {s.rounds} · {minigameName(s.mg)}
            </div>
            <span className="timer">{s.phase === 'play' ? Math.ceil(s.left) : s.phase === 'intro' ? 'Get ready' : s.phase}</span>
          </div>
        )}
      </div>

      <div className="corner tr">
        <div className="label">Points</div>
        <div className="mini-scores">
          {sorted.map((r) => (
            <div key={r.id} className={r.id === ctx.you ? 'me' : ''}>
              <span>
                <span className="swatch" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: colorOf(r.id), marginRight: 8 }} />
                {nameOf(r.id)}
              </span>
              <span className="n">{r.points}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="corner bl">
        {s.phase === 'play' && !s.out && !s.spectating && (
          <>
            <div className="label">Dash {dashReady ? 'ready' : ''}</div>
            <div className="dash-meter">
              <i style={{ width: `${Math.round((1 - Math.min(1, s.dashCd / RU.dashCooldown)) * 100)}%`, background: dashReady ? 'var(--mint)' : 'rgba(255,255,255,0.5)' }} />
            </div>
            {s.mg === 'coins' && (
              <div className="big" style={{ marginTop: 8, color: 'var(--gold)' }}>
                {s.myCoins} <span className="label">coins</span>
              </div>
            )}
            {s.mg === 'hotpotato' && holderName && (
              <div style={{ marginTop: 8 }}>
                <span className="label">Bomb</span>{' '}
                <b style={{ color: s.holder === ctx.you ? 'var(--coral)' : undefined }}>{s.holder === ctx.you ? 'YOU have it!' : holderName}</b>
              </div>
            )}
          </>
        )}
        {s.out && s.phase === 'play' && <div className="out">You are out this round. Watch the others.</div>}
        {s.spectating && <div className="label">Spectating until the next round</div>}
      </div>
      <div className="menu-hint">Esc: menu · Tab: scores · Space / click: dash</div>

      {s.phase === 'intro' && s.mg && (
        <div className="banner">
          <h2>{minigameName(s.mg)}</h2>
          <p>{minigameRules(s.mg)}</p>
          <div className="count">{Math.max(1, Math.ceil(s.left))}</div>
        </div>
      )}

      {s.phase === 'results' && s.placements && !s.ended && (
        <div className="overlay-center" style={{ pointerEvents: 'none' }}>
          <div className="scoreboard">
            <h2>{s.placements[0] ? `${nameOf(s.placements[0])} takes the round` : 'Round over'}</h2>
            <p className="sub">
              {minigameName(s.mg)} · next round in {Math.ceil(s.left)}
            </p>
            <table>
              <tbody>
                {s.placements.map((id, i) => {
                  const score = s.scores.find((r) => r.id === id);
                  return (
                    <tr key={id} className={id === ctx.you ? 'me' : ''}>
                      <td className="num" style={{ width: 40, textAlign: 'left' }}>
                        {i + 1}.
                      </td>
                      <td>
                        <span className="swatch" style={{ background: colorOf(id) }} />
                        {nameOf(id)}
                      </td>
                      <td className="num">
                        {score?.points ?? 0}
                        <span className="gain">+{score?.last ?? 0}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(board || s.ended) && (
        <div className="overlay-center" style={{ pointerEvents: s.ended ? 'auto' : 'none' }}>
          <div className="scoreboard">
            <h2>{s.ended ? (s.ended.winner ? `${nameOf(s.ended.winner)} wins the Ruckus` : 'It is a tie') : 'Standings'}</h2>
            <p className="sub">{s.ended ? 'Back to the room in a moment.' : `After round ${Math.max(0, s.round - (s.phase === 'results' ? 0 : 1))} of ${s.rounds}`}</p>
            <Standings scores={s.ended?.scores ?? s.scores} you={ctx.you} nameOf={nameOf} colorOf={colorOf} />
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
            <h2>Menu</h2>
            <p className="sub">The game keeps going. Room code {room.code}.</p>
            <Standings scores={s.scores} you={ctx.you} nameOf={nameOf} colorOf={colorOf} />
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

function Standings({ scores, you, nameOf, colorOf }: { scores: RuckusScore[]; you: string; nameOf: (id: string) => string; colorOf: (id: string) => string }) {
  const sorted = [...scores].sort((a, b) => b.points - a.points);
  return (
    <table>
      <thead>
        <tr>
          <th>Player</th>
          <th style={{ textAlign: 'right' }}>Points</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r, i) => (
          <tr key={r.id} className={r.id === you ? 'me' : ''}>
            <td>
              <span className="swatch" style={{ background: colorOf(r.id) }} />
              {i === 0 && r.points > 0 ? '👑 ' : ''}
              {nameOf(r.id)}
            </td>
            <td className="num">{r.points}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
