import { type ReactNode, useEffect, useState } from 'react';
import { GAMES, colorHex } from '@shared/protocol';
import { ZB } from '@shared/zombies/constants';
import type { ZScore } from '@shared/zombies/protocol';
import { WEAPONS, type WeaponId, type WeaponKind } from '@shared/zombies/weapons';
import { VolumeControl } from '../../ui/VolumeControl';
import { type ClientContext, useStore } from '../types';
import type { Quality } from './api';
import type { ZombiesClient } from './client';
import { LoadingScreen } from './LoadingScreen';
import './zombies.css';

const WHY: Record<string, string> = { hit: '', kill: '', head: 'headshot', knife: 'knife', fix: 'barrier', revive: 'revive' };
/** The boxed tag next to the gun name; guns without one show their era. */
const TAG: Partial<Record<WeaponId, string>> = { mp7: 'suppressed', kar98k: 'scoped', barrett: 'scoped', m249: 'belt-fed' };
const KIND: Record<WeaponKind, string> = { pistol: 'sidearm', smg: 'sub-machine gun', rifle: 'rifle', shotgun: 'shotgun', sniper: 'sniper', lmg: 'light machine gun' };

export function ZombiesHud({ client, ctx }: { client: ZombiesClient; ctx: ClientContext }) {
  const s = useStore(client.hud);
  const [board, setBoard] = useState(false);
  const [menu, setMenu] = useState(false);
  const [, setTick] = useState(0);
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
      // No menu over the loading screen: there is nothing to pause yet.
      if (e.code === 'Escape' && client.hud.get().ready) setMenu((m) => !m);
    };
    const up = (e: KeyboardEvent) => e.code === 'Tab' && setBoard(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    // Timed HUD pieces (popups, markers, banners) fade on their own clock.
    const t = window.setInterval(() => setTick((n) => n + 1), 100);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.clearInterval(t);
    };
  }, [client]);

  useEffect(() => {
    client.setPaused(menu);
  }, [menu, client]);

  const now = performance.now();
  const w = WEAPONS[s.slots[s.cur] ?? s.slots[0]];
  const other = s.slots[s.cur === 0 ? 1 : 0];
  const lowAmmo = s.mag <= Math.ceil(w.mag * 0.25);
  const hitAge = now - s.hitAt;
  const killAge = now - s.killAt;
  const hurtAge = now - s.hurtAt;
  const bannerAge = s.banner ? now - s.banner.at : Infinity;
  const sorted = [...s.scores].sort((a, b) => b.points - a.points);
  const gap = Math.round(6 + s.spread * 900);

  return (
    <div className="hud ll">
      <LoadingScreen s={s} />

      {s.scope && !s.ended && (
        <div className="ll-scope">
          <i className="h" />
          <i className="v" />
          <i className="dot" />
        </div>
      )}
      {/* Crosshair: four ticks that open with the spread; gone while aiming. */}
      {s.life !== 2 && !s.ads && !s.ended && (
        <div className="ll-cross" style={{ ['--gap' as string]: `${gap}px` }}>
          <i className="t" />
          <i className="b" />
          <i className="l" />
          <i className="r" />
        </div>
      )}
      {hitAge < 220 && <div className={`ll-hit ${killAge < 300 ? 'kill' : ''} ${now - s.headAt < 220 ? 'head' : ''}`} style={{ opacity: 1 - hitAge / 220 }} />}
      {hurtAge < 900 && (
        <div className="ll-hurt" style={{ transform: `translate(-50%, -50%) rotate(${-s.hurtYaw}rad)`, opacity: 1 - hurtAge / 900 }}>
          <i />
        </div>
      )}

      <div className="ll-wave">
        <Tally n={s.wave} />
        {s.phase === 'break' && s.wave > 0 && <span className="ll-sub">next wave in {s.left}s</span>}
        {s.phase === 'break' && s.wave === 0 && <span className="ll-sub">first wave in {s.left}s</span>}
        {s.phase === 'wave' && <span className="ll-sub">{s.left} left</span>}
      </div>

      <div className="ll-points">
        <div className="ll-pts">{s.points}</div>
        <div className="ll-popups">
          {s.popups
            .filter((p) => now - p.at < 1100)
            .map((p) => (
              <span key={p.key} className={`ll-pop ${p.why}`} style={{ opacity: 1 - (now - p.at) / 1100, transform: `translate(${(p.key % 5) * 6}px, ${-(now - p.at) / 30}px)` }}>
                +{p.n} {WHY[p.why]}
              </span>
            ))}
        </div>
        <div className="ll-team">
          {sorted
            .filter((r) => r.id !== ctx.you)
            .slice(0, 9)
            .map((r) => (
              <div key={r.id} className={s.downed.some((d) => d.id === r.id) ? 'down' : ''}>
                <i style={{ background: colorOf(r.id) }} />
                <span>{nameOf(r.id)}</span>
                <b>{r.points}</b>
              </div>
            ))}
        </div>
      </div>

      <div className="ll-health">
        <div className="ll-bar">
          <i style={{ width: `${Math.max(0, Math.min(100, s.hp))}%` }} className={s.hp < 35 ? 'low' : ''} />
        </div>
        {s.armor > 0 && (
          <div className="ll-bar armor">
            <i style={{ width: `${s.armor}%` }} />
          </div>
        )}
      </div>

      <div className="ll-ammo">
        <div className="ll-gun">
          {w.name}
          <span className="ll-tag">{TAG[w.id] ?? w.era}</span>
        </div>
        <div className={`ll-count ${lowAmmo ? 'low' : ''}`}>
          {s.mag}
          <span>/ {s.res}</span>
        </div>
        <div className="ll-gear">
          <span className="ll-nades" title="Frag grenades (G)">
            {Array.from({ length: ZB.nadeMax }, (_, i) => (
              <i key={i} className={i < s.nades ? 'on' : ''} />
            ))}
          </span>
          {other && <span className="ll-other">2nd: {WEAPONS[other].name}</span>}
          {!s.flashlight && <span className="ll-other">flashlight off (F)</span>}
        </div>
        <div className="ll-mode">
          {w.auto ? 'full-auto' : w.perShell ? 'pump action' : 'semi-auto'} · {w.rpm} rpm · {KIND[w.kind]}
        </div>
        {s.reloading && <div className="ll-reload">Reloading</div>}
        {!s.reloading && s.mag === 0 && s.res > 0 && <div className="ll-reload">Press R to reload</div>}
        {!s.reloading && s.mag === 0 && s.res === 0 && <div className="ll-reload">Out of ammo: buy more at a locker</div>}
      </div>

      {s.prompt && !s.ended && (
        <div className="ll-prompt">
          {s.prompt}
          {s.progress !== null && (
            <div className="ll-progress">
              <i style={{ width: `${Math.round(s.progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {s.deny && now - s.deny.at < 1400 && <div className="ll-deny">{s.deny.text}</div>}

      <div className="ll-feed">
        {s.feed
          .filter((f) => now - f.at < 6000)
          .map((f) => (
            <div key={f.key} style={{ opacity: Math.min(1, (6000 - (now - f.at)) / 800) }}>
              {f.text}
            </div>
          ))}
      </div>

      {s.banner && bannerAge < 3800 && (
        <div className="ll-banner" style={{ opacity: Math.min(1, bannerAge / 300, (3800 - bannerAge) / 700) }}>
          <h2>{s.banner.text}</h2>
          <p>{s.banner.sub}</p>
        </div>
      )}

      {s.life === 1 && !s.ended && <div className="ll-downed">DOWN · {Math.ceil(s.bleed)}s · a teammate can hold E to revive you</div>}
      {s.life === 2 && !s.ended && <div className="ll-downed dead">You bled out. Back at the start of the next wave.</div>}

      <div className="menu-hint">
        Esc: menu · Tab: scores · E: use · G: grenade · V: knife{s.dragLook ? ' · drag to look, F to fire, Q to aim, L light' : ''}
      </div>

      {(board || s.ended) && (
        <div className="overlay-center" style={{ pointerEvents: s.ended ? 'auto' : 'none' }}>
          <div className="scoreboard ll-board">
            <h2>{s.ended ? `Overrun on wave ${s.ended.wave}` : `Wave ${s.wave} · ${s.mapName}`}</h2>
            <p className="sub">{s.ended ? 'The dead got in. Back to the room in a moment.' : 'Points spent and earned this match'}</p>
            <Scores scores={s.ended?.scores ?? s.scores} you={ctx.you} nameOf={nameOf} colorOf={colorOf} />
            {s.ended && (
              <div className="actions">
                <button className="btn ghost" onClick={ctx.leave}>
                  Back to main page
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {menu && !s.ended && (
        <PauseMenu
          client={client}
          ctx={ctx}
          isHost={isHost}
          code={room.code}
          onResume={() => setMenu(false)}
          scores={<Scores scores={s.scores} you={ctx.you} nameOf={nameOf} colorOf={colorOf} />}
        />
      )}
    </div>
  );
}

type Section = 'resume' | 'settings' | 'controls' | 'scores' | 'leave' | 'end';

/**
 * The Esc menu: big items on the left (arrows or hover to pick, Enter or click to act), the picked section on the
 * right, the match blurred behind. Resume, leave and end act; the others only show their panel.
 */
function PauseMenu({
  client,
  ctx,
  isHost,
  code,
  onResume,
  scores,
}: {
  client: ZombiesClient;
  ctx: ClientContext;
  isHost: boolean;
  code: string;
  onResume: () => void;
  scores: ReactNode;
}) {
  const s = useStore(client.hud);
  const items: { id: Section; label: string }[] = [
    { id: 'resume', label: 'Resume' },
    { id: 'settings', label: 'Settings' },
    { id: 'controls', label: 'Controls' },
    { id: 'scores', label: 'Scoreboard' },
    { id: 'leave', label: 'Back to main page' },
    ...(isHost ? [{ id: 'end' as const, label: 'End match for everyone' }] : []),
  ];
  const [sel, setSel] = useState<Section>('resume');
  // Ending the match for everyone takes a second press.
  const [arm, setArm] = useState(false);

  const act = (id: Section) => {
    setSel(id);
    if (id === 'resume') onResume();
    else if (id === 'leave') ctx.leave();
    else if (id === 'end') {
      if (arm) ctx.socket.send({ t: 'stop' });
      else setArm(true);
    }
  };

  useEffect(() => {
    if (sel !== 'end') setArm(false);
  }, [sel]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Sliders keep their own arrow keys.
      if (e.target instanceof HTMLInputElement) return;
      const i = items.findIndex((it) => it.id === sel);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = items.length;
        setSel(items[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n].id);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        act(sel);
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  });

  const panel = sel === 'resume' || sel === 'leave' || sel === 'end' ? 'summary' : sel;
  return (
    <div className="ll-pause" role="dialog" aria-label="Paused">
      <div className="ll-pause-side">
        <div className="ll-pause-brand">
          <span>Paused</span>
          <h2>Last Light</h2>
          <p>
            {s.mapName}
            {s.wave > 0 ? ` · wave ${s.wave}` : ''}
          </p>
        </div>
        <nav className="ll-pause-items">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              className={`${it.id === sel ? 'sel' : ''} ${it.id === 'end' ? 'danger' : ''}`}
              onMouseEnter={() => setSel(it.id)}
              onFocus={() => setSel(it.id)}
              onClick={() => act(it.id)}
            >
              {it.id === 'end' && arm ? 'Press again to end' : it.label}
            </button>
          ))}
        </nav>
        <div className="ll-pause-code">
          Room code <b>{code}</b>
        </div>
      </div>

      <div className="ll-pause-panel">
        {panel === 'summary' && (
          <>
            <h3>The dead do not wait</h3>
            <p className="ll-pause-note">
              {sel === 'leave'
                ? 'Leave the hotel and go back to the main page. The squad holds on without you.'
                : sel === 'end'
                  ? 'Ends the match for the whole squad and takes everyone back to the room.'
                  : 'The match keeps running while this menu is open. Esc to get back in.'}
            </p>
            <div className="ll-pause-stats">
              <div>
                <b>{s.wave}</b>wave
              </div>
              <div>
                <b>{s.points}</b>points
              </div>
              <div>
                <b>{s.scores.find((r) => r.id === ctx.you)?.kills ?? 0}</b>kills
              </div>
            </div>
          </>
        )}
        {panel === 'settings' && (
          <>
            <h3>Settings</h3>
            <div className="ll-settings">
              <label>
                Graphics
                <span className="segmented">
                  {(['low', 'medium', 'high'] as Quality[]).map((q) => (
                    <button key={q} type="button" className={q === s.quality ? 'active' : ''} onClick={() => client.setQuality(q)}>
                      {q}
                    </button>
                  ))}
                </span>
              </label>
              <label>
                <span>
                  Mouse sensitivity <b>{client.sens.toFixed(2)}</b>
                </span>
                <input type="range" min={0.2} max={3} step={0.05} defaultValue={client.sens} onChange={(e) => client.setSensitivity(+e.target.value)} />
              </label>
              <VolumeControl />
            </div>
          </>
        )}
        {panel === 'controls' && (
          <>
            <h3>Controls</h3>
            <dl className="ll-pause-keys">
              {GAMES.zombies.controls.map((c) => (
                <div key={c.keys}>
                  <dt>{c.keys}</dt>
                  <dd>{c.does}</dd>
                </div>
              ))}
              <div>
                <dt>Esc</dt>
                <dd>This menu</dd>
              </div>
            </dl>
          </>
        )}
        {panel === 'scores' && (
          <>
            <h3>Scoreboard</h3>
            <div className="ll-pause-scores">{scores}</div>
          </>
        )}
      </div>
    </div>
  );
}

/** The wave number as chalk tally marks up to five, numerals after that (CoD style). */
function Tally({ n }: { n: number }) {
  if (n <= 0) return <div className="ll-tally empty">·</div>;
  if (n > 5) return <div className="ll-tally num">{n}</div>;
  return (
    <div className="ll-tally">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i === 4 ? 'cross' : ''} style={{ transform: `rotate(${((i * 37) % 9) - 4}deg)` }} />
      ))}
    </div>
  );
}

function Scores({ scores, you, nameOf, colorOf }: { scores: ZScore[]; you: string; nameOf: (id: string) => string; colorOf: (id: string) => string }) {
  const sorted = [...scores].sort((a, b) => b.points - a.points);
  return (
    <table>
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>Survivor</th>
          <th className="num">Points</th>
          <th className="num">Kills</th>
          <th className="num">Heads</th>
          <th className="num">Downs</th>
          <th className="num">Revives</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.id} className={r.id === you ? 'me' : ''}>
            <td>
              <span className="swatch" style={{ background: colorOf(r.id) }} />
              {nameOf(r.id)}
            </td>
            <td className="num">{r.points}</td>
            <td className="num">{r.kills}</td>
            <td className="num">{r.heads}</td>
            <td className="num">{r.downs}</td>
            <td className="num">{r.revives}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
