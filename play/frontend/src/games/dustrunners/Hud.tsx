// Dustrunners room HUD: the racer's own race HUD (speed, boost, damage, minimap, position, countdown) in online mode,
// plus the room layer on top: the loading screen while the pilots load, a spectator banner for late joiners, the
// classification as pilots cross the line, the Tab standings, the escape menu (the race goes on behind it) and the
// final results. Styled like the racer HUD (racer/ui/hud.css); the room-only bits are in hud.css next to this file.

import { memo, useEffect, useState } from 'react';
import { colorHex } from '@shared/protocol';
import type { DrEntrant } from '@shared/dustrunners/protocol';
import { drTrackById } from '@shared/dustrunners/tracks';
import type { RaceView } from '../../racer/RaceView';
import { Hud as RaceHud } from '../../racer/ui/Hud';
import { fmtTime, ordinal, useHud, wantsTouch } from '../../racer/ui/hudStore';
import '../../racer/ui/racer.css';
import { InviteLink } from '../../ui/InviteLink';
import { VolumeControl } from '../../ui/VolumeControl';
import { type ClientContext, useStore } from '../types';
import { type DrScore, type DustrunnersClient, type DustrunnersHudState, pointsFor } from './client';
import './hud.css';

const noop = () => {};

export function DustrunnersHud({ client, ctx }: { client: DustrunnersClient; ctx: ClientContext }) {
  const s = useStore(client.hud);
  const [board, setBoard] = useState(false);
  const [menu, setMenu] = useState(false);
  // Same rule as the racer HUD (racer/ui/Hud.tsx): coarse pointer or ?touch, or the first touch anywhere.
  const [touch, setTouch] = useState(wantsTouch);
  const room = ctx.room();
  const isHost = room.hostId === ctx.you;
  const ended = !!s.ended;

  // The results board replaces the menu: close it when the race ends.
  useEffect(() => {
    if (ended) setMenu(false);
  }, [ended]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // With the menu or the results up, Tab moves between their buttons and Esc/P do nothing.
      if (ended) return;
      if (e.code === 'Tab' && !menu) {
        e.preventDefault();
        setBoard(true);
      }
      if ((e.code === 'Escape' || e.code === 'KeyP') && !e.repeat) setMenu((m) => !m);
    };
    const up = (e: KeyboardEvent) => e.code === 'Tab' && setBoard(false);
    const first = (e: PointerEvent) => {
      if (e.pointerType === 'touch') setTouch(true);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('pointerdown', first);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('pointerdown', first);
    };
  }, [ended, menu]);

  useEffect(() => {
    client.setPaused(menu);
  }, [menu, client]);

  return (
    <>
      {s.view && (
        // The racer's own FINISHED banner would show through the results board.
        <div className={`drn-race${(board || s.ended) && !menu ? ' boarded' : ''}`}>
          <RaceHud view={s.view} online onQuit={ctx.leave} onRestart={noop} onExit={ctx.leave} />
        </div>
      )}
      <div className={`hud drn${touch ? ' touch' : ''}`}>
        {!s.ready && !s.ended && <Loading s={s} />}
        {s.ready && s.phase === 'loading' && !s.spectator && <WaitingForPilots s={s} ctx={ctx} />}
        {s.spectator && !s.ended && <SpectatorBanner client={client} s={s} />}
        {s.results.length > 0 && !s.ended && <Classification s={s} ctx={ctx} />}
        {(board || s.ended) && !menu && <Board s={s} ctx={ctx} isHost={isHost} />}
        {!s.ended && (
          <>
            <button className="hud-pause-btn drn-menu-btn" aria-label="Menu" onClick={() => setMenu(true)}>
              <i />
              <i />
            </button>
            {/* Touch and narrow screens have no Tab key: a tap toggles the standings. */}
            {s.ready && (
              <button className={`drn-board-btn${board ? ' on' : ''}`} aria-pressed={board} onClick={() => setBoard((b) => !b)}>
                Standings
              </button>
            )}
            <div className="drn-hint menu-hint">Esc: menu · Tab: standings</div>
          </>
        )}
        {menu && !s.ended && (
          <div className="hud-pause" onPointerDown={(e) => e.target === e.currentTarget && setMenu(false)}>
            <div className="hud-pause-card" role="dialog" aria-modal="true" aria-label="Menu">
              <div className="hud-pause-sub">
                {s.trackName} · room {room.code}
              </div>
              <div className="hud-pause-title">MENU</div>
              <p className="drn-menu-note">The race goes on while this is open.</p>
              <button className="hud-pause-item primary" autoFocus onClick={() => setMenu(false)}>
                <span>Resume</span>
                <kbd>Esc</kbd>
              </button>
              {isHost && (
                <button className="hud-pause-item" onClick={() => ctx.socket.send({ t: 'stop' })}>
                  <span>End race for everyone</span>
                </button>
              )}
              <button className="hud-pause-item" onClick={ctx.leave}>
                <span>Back to main page</span>
              </button>
              <VolumeControl className="hud-volume" />
              <InviteLink code={room.code} variant="dustrunners" label="Invite pilots" hint="Joiners wait for the next race." />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** Ticks a re-render every `ms` while mounted (countdowns). */
function useNow(ms = 250) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Late joiners watch the race: the leader by default, a click cycles through the pilots. */
function SpectatorBanner({ client, s }: { client: DustrunnersClient; s: DustrunnersHudState }) {
  const [watching, setWatching] = useState<string | null>(null);
  const name = watching ? (s.entrants.find((e) => e.id === watching)?.name ?? 'the leader') : 'the leader';
  return (
    <div className="drn-banner">
      <b>Spectating</b> You joined mid-race and line up for the next one. Watching {name}.
      <button className="drn-follow" onClick={() => setWatching(client.followNext())}>
        Next pilot
      </button>
    </div>
  );
}

function Loading({ s }: { s: DustrunnersHudState }) {
  // Joined as the race was finishing: no race to build, the room goes back to waiting shortly.
  const done = s.phase === 'done';
  return (
    <div className="drn-center">
      <div className="drn-card">
        <div className="hud-pause-sub">{s.trackName || 'Dustrunners'}</div>
        <div className="drn-title">{s.error ? 'Something broke' : done ? 'Race just ended' : 'Loading the canyon'}</div>
        <p className="drn-sub">{s.error || (done ? 'The next race starts shortly.' : 'Building the track and warming up the turbines…')}</p>
        {!s.error && !done && <div className="drn-spinner" aria-hidden />}
      </div>
    </div>
  );
}

function WaitingForPilots({ s, ctx }: { s: DustrunnersHudState; ctx: ClientContext }) {
  useNow(500);
  const left = s.loadDeadline !== null ? Math.max(0, Math.ceil((s.loadDeadline - ctx.socket.serverNow()) / 1000)) : null;
  const racers = s.entrants.filter((e) => !e.spectator);
  return (
    <div className="drn-center">
      <div className="drn-card">
        <div className="hud-pause-sub">{s.trackName}</div>
        <div className="drn-title">Waiting for players to load</div>
        <p className="drn-sub">You are on the grid. The lights start once every pilot has loaded{left !== null ? `, in ${left} s at the latest` : ''}.</p>
        <ol className="drn-grid">
          {racers.map((e, i) => (
            <li key={e.id} className={e.id === ctx.you ? 'me' : ''}>
              <b>{i + 1}</b>
              <i style={{ background: colorHex(e.color) }} />
              <span>{e.id === ctx.you ? 'YOU' : e.name}</span>
              {e.bot && <em className="drn-tag">BOT</em>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Right side, as pilots cross the line: place, name, time. */
function Classification({ s, ctx }: { s: DustrunnersHudState; ctx: ClientContext }) {
  const byId = new Map(s.entrants.map((e) => [e.id, e]));
  const lead = s.results[0]?.time ?? null;
  const total = s.entrants.filter((e) => !e.spectator).length;
  return (
    <div className="drn-class">
      <div className="drn-class-head">
        FINISHED <small>{`${s.results.length}/${total}`}</small>
      </div>
      <ol>
        {s.results.map((r) => {
          const e = byId.get(r.id);
          return (
            <li key={r.id} className={r.id === ctx.you ? 'me' : ''}>
              <b>{r.place}</b>
              <i style={{ background: e ? colorHex(e.color) : '#888' }} />
              <span>{r.id === ctx.you ? 'YOU' : (e?.name ?? 'Left')}</span>
              <em>{r.place === 1 || lead === null || r.time === null ? fmtTime(r.time, true) : `+${(r.time - lead).toFixed(2)}`}</em>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface Row {
  id: string;
  entrant?: DrEntrant;
  place: number | null;
  time: number | null;
  points: number | null;
}

/** Live order from the race view (by pilot name, unique in a room), else the grid order. */
const LiveOrder = memo(function LiveOrder({ view, s, ctx }: { view: RaceView; s: DustrunnersHudState; ctx: ClientContext }) {
  const live = useHud(view, (h) => h.standings);
  const racers = s.entrants.filter((e) => !e.spectator);
  const rank = new Map(live.map((r, i) => [r.name, i]));
  const done = new Map(s.results.map((r) => [r.id, r]));
  const rows: Row[] = [...racers]
    .sort((a, b) => {
      const ra = done.get(a.id)?.place ?? 100 + (rank.get(a.name) ?? 50);
      const rb = done.get(b.id)?.place ?? 100 + (rank.get(b.name) ?? 50);
      return ra - rb;
    })
    .map((e) => ({ id: e.id, entrant: e, place: done.get(e.id)?.place ?? null, time: done.get(e.id)?.time ?? null, points: null }));
  return <BoardTable rows={rows} ctx={ctx} ping={s.ping} live />;
});

function Board({ s, ctx, isHost }: { s: DustrunnersHudState; ctx: ClientContext; isHost: boolean }) {
  const byId = new Map(s.entrants.map((e) => [e.id, e]));
  const winner = s.ended?.winner ? byId.get(s.ended.winner) : undefined;
  return (
    <div className="drn-center" style={{ pointerEvents: s.ended ? 'auto' : 'none' }}>
      <div className="drn-card drn-board">
        <div className="hud-pause-sub">{s.trackName}</div>
        <div className="drn-title">{s.ended ? (s.ended.winner === ctx.you ? 'You win!' : winner ? `${winner.name} wins` : 'Race over') : 'Standings'}</div>
        {s.ended ? (
          <BoardTable rows={s.ended.scores.map((r: DrScore) => ({ ...r, entrant: byId.get(r.id) }))} ctx={ctx} ping={s.ping} />
        ) : s.view ? (
          <LiveOrder view={s.view} s={s} ctx={ctx} />
        ) : (
          <BoardTable rows={s.entrants.filter((e) => !e.spectator).map((e) => ({ id: e.id, entrant: e, place: null, time: null, points: null }))} ctx={ctx} ping={s.ping} live />
        )}
        {s.ended && <NextRace ended={s.ended} ctx={ctx} isHost={isHost} />}
      </div>
    </div>
  );
}

/** Under the results: the countdown to the next race, and for the host the buttons to start it now or go back to the lobby. */
function NextRace({ ended, ctx, isHost }: { ended: NonNullable<DustrunnersHudState['ended']>; ctx: ClientContext; isHost: boolean }) {
  useNow(250);
  const left = Math.max(0, Math.ceil((ended.nextAt - ctx.socket.serverNow()) / 1000));
  const name = drTrackById(ended.next)?.name ?? 'the next track';
  return (
    <>
      <p className="drn-sub drn-next">
        Next race: <b>{name}</b> {left > 0 ? `in ${left} s` : 'starting…'}
        {!isHost && ' · the host can start it sooner'}
      </p>
      {isHost && (
        <button className="hud-pause-item primary" autoFocus onClick={() => ctx.socket.send({ t: 'start' })}>
          <span>Start next race now</span>
        </button>
      )}
      {isHost && (
        <button className="hud-pause-item" onClick={() => ctx.socket.send({ t: 'stop' })}>
          <span>Back to lobby</span>
        </button>
      )}
      <button className="hud-pause-item" onClick={ctx.leave}>
        <span>Back to main page</span>
      </button>
    </>
  );
}

function BoardTable({ rows, ctx, ping, live }: { rows: Row[]; ctx: ClientContext; ping: number; live?: boolean }) {
  const players = ctx.room().players;
  const lead = rows.find((r) => r.place === 1)?.time ?? null;
  return (
    <table className="drn-table">
      <thead>
        <tr>
          <th>Pos</th>
          <th>Pilot</th>
          <th className="num">Time</th>
          <th className="num">{live ? 'Ping' : 'Points'}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const e = r.entrant;
          const me = r.id === ctx.you;
          const p = players.find((x) => x.id === r.id);
          const ms = me ? ping : p && !p.bot ? p.ping : null;
          return (
            <tr key={r.id} className={me ? 'me' : ''}>
              <td>{r.place ? ordinal(r.place) : live ? ordinal(i + 1) : 'DNF'}</td>
              <td>
                <i className="drn-swatch" style={{ background: e ? colorHex(e.color) : '#888' }} />
                {e?.name ?? 'Left the race'}
                {me && <em className="drn-tag you">YOU</em>}
                {e?.bot && <em className="drn-tag">BOT</em>}
              </td>
              <td className="num">{r.time === null ? (live ? 'racing' : '—') : r.place === 1 || lead === null ? fmtTime(r.time) : `+${(r.time - lead).toFixed(3)}`}</td>
              <td className="num">{live ? (e?.bot ? '' : ms !== null && ms !== undefined ? `${ms} ms` : '') : (r.points ?? pointsFor(r.place))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
