// Garden Sentinels HUD: wave bar, resources, tower purchase cards, the selected tower panel, versus boards and sends,
// toasts, scores, end screen and the escape menu. Reads GHudState from the client store and only talks back through
// GardenActions (see api.ts). Styles in garden.css, every class prefixed `gs-`.
//
// Keys handled here: Esc (cancel placing, then deselect, then the menu). Everything else (1-5, R, U, X, Tab, camera)
// belongs to client.ts; the HUD only shows the hints.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { colorHex } from '@shared/protocol';
import { G } from '@shared/garden/constants';
import { ENEMIES, SENDS, type EnemyKind } from '@shared/garden/enemies';
import { TFlag, type GScore } from '@shared/garden/protocol';
import { TARGET_MODES, TOWER_KINDS, TOWERS, type Level, type TargetMode, type TowerKind } from '@shared/garden/towers';
import { VolumeControl } from '../../ui/VolumeControl';
import { type ClientContext, type Store, useStore } from '../types';
import type { GardenActions, GHudState, HudSelected, Quality, Toast } from './api';
import { GardenCoach } from './Coach';
import { EnemyIcon, Heart, IncomeArrow, Leaf, Portrait, Skull, TowerIcon, Trophy } from './hudIcons';
import './garden.css';

/** Structural so the HUD does not depend on client.ts; GardenClient satisfies it. */
export interface GardenHudClient {
  store: Store<GHudState>;
  actions: GardenActions;
  setPaused?(paused: boolean): void;
}

const LEVEL_NAMES: Record<Level, string> = { 1: 'Basic', 2: 'Enhanced', 3: 'Masterwork' };
const TARGET_LABELS = ['First', 'Last', 'Strong', 'Close'];
const TOAST_MS = { info: 3600, good: 3600, bad: 4200, boss: 5600 } as const;
const hex = (c: number) => colorHex(c & 0xffffff);
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function GardenHud({ client, ctx }: { client: GardenHudClient; ctx: ClientContext }) {
  const s = useStore(client.store);
  const a = client.actions;
  const [menu, setMenu] = useState(false);
  const [drawer, setDrawer] = useState<'none' | 'people' | 'send'>('none');
  const [sendTo, setSendTo] = useState<number | undefined>(undefined);

  // Esc: cancel placing, then deselect, then toggle the menu. Read the store at key time so a stale render never
  // decides it.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) t.blur();
      const st = client.store.get();
      setMenu((m) => {
        if (m) return false;
        if (st.placing) {
          client.actions.place(null);
          return false;
        }
        if (st.selected) {
          client.actions.deselect();
          return false;
        }
        return !st.end;
      });
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [client]);

  useEffect(() => {
    client.setPaused?.(menu);
  }, [menu, client]);

  const room = ctx.room();
  const isHost = room.hostId === ctx.you;
  const nameOf = (id: string) => s.players.find((p) => p.id === id)?.name ?? room.players.find((p) => p.id === id)?.name ?? '…';
  const colorOf = (id: string) => {
    const c = s.players.find((p) => p.id === id)?.color ?? room.players.find((p) => p.id === id)?.color;
    return c === undefined ? '#ccc' : hex(c);
  };

  const vs = s.mode === 'vs';
  const myBoard = s.boards.find((b) => b.b === s.myBoard);
  const imOut = vs && !!myBoard?.out;
  const viewing = s.boards.find((b) => b.b === s.viewBoard);
  const onOther = vs && s.viewBoard !== s.myBoard;
  const over = s.phase === 'over' || !!s.end;

  return (
    <div className={`hud gs ${vs ? 'gs-vs' : 'gs-coop'} ${s.placing ? 'gs-is-placing' : ''}`}>
      {!s.ready && (
        <div className="gs-loading">
          <div className="gs-loading-card">
            <span className="gs-sprout" />
            Planting the garden…
          </div>
        </div>
      )}

      {/* ---- top left: resources + people ---- */}
      <div className="gs-tl">
        <Resources s={s} imOut={imOut} viewingName={onOther ? viewing?.name : undefined} />
        <div className={`gs-people ${drawer === 'people' ? 'open' : ''}`}>
          {vs ? <Boards s={s} onView={a.viewBoard} /> : <Players s={s} />}
        </div>
      </div>

      {/* ---- top centre: wave bar, next wave, call wave ---- */}
      <div className="gs-tc">
        <WaveBar s={s} />
        {!over && (
          <div className="gs-wave-row">
            <NextWave s={s} />
            {s.phase === 'build' && !imOut && <CallWave s={s} onReady={a.ready} />}
          </div>
        )}
        <Toasts toasts={s.toasts} />
      </div>

      {/* ---- top right: menu + scores ---- */}
      <div className="gs-tr">
        <button type="button" className="gs-icon-btn" title="Scores (Tab)" aria-label="Scores" onClick={() => a.setScoresOpen(!s.scoresOpen)}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 17 V10 H7 V17 Z M8 17 V4 H12 V17 Z M13 17 V7.5 H17 V17 Z" fill="currentColor" />
          </svg>
        </button>
        <button type="button" className="gs-icon-btn" title="Menu (Esc)" aria-label="Menu" onClick={() => setMenu((m) => !m)}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5 H17 M3 10 H17 M3 15 H17" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className={`gs-icon-btn gs-only-narrow ${drawer === 'people' ? 'on' : ''}`}
          aria-label={vs ? 'Gardens' : 'Players'}
          onClick={() => setDrawer((d) => (d === 'people' ? 'none' : 'people'))}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="7" cy="7" r="3" fill="currentColor" />
            <circle cx="14" cy="8" r="2.4" fill="currentColor" opacity="0.7" />
            <path d="M1.5 17 C2 12.5 4.5 11 7 11 C9.5 11 12 12.5 12.5 17 Z M12 17 C12.4 13.6 13.4 12.4 14.5 12.4 C16.4 12.4 18 13.6 18.5 17 Z" fill="currentColor" />
          </svg>
        </button>
        {vs && !imOut && (
          <button type="button" className={`gs-icon-btn gs-only-narrow ${drawer === 'send' ? 'on' : ''}`} aria-label="Send enemies" onClick={() => setDrawer((d) => (d === 'send' ? 'none' : 'send'))}>
            <EnemyIcon kind="runner" />
          </button>
        )}
      </div>

      {onOther && viewing && (
        <button type="button" className="gs-viewing" onClick={() => a.viewBoard(s.myBoard)}>
          <i style={{ background: hex(viewing.color) }} />
          <span className="gs-viewing-text">
            Watching <b>{viewing.name}</b>’s garden
          </span>
          <span className="gs-viewing-back">Back to yours</span>
        </button>
      )}

      {/* ---- right: selected tower ---- */}
      {s.selected && <TowerPanel s={s} sel={s.selected} a={a} />}

      {/* ---- bottom left (versus): sends ---- */}
      {vs && !imOut && !over && (
        <div className={`gs-send-wrap ${drawer === 'send' ? 'open' : ''}`}>
          <SendPanel s={s} a={a} to={sendTo} setTo={setSendTo} />
        </div>
      )}

      {/* ---- bottom: build cards ---- */}
      {!over && !imOut && (
        <div className="gs-bottom">
          {s.placing && (
            <div className="gs-placing-hint">
              Placing <b>{TOWERS[s.placing].name}</b> · click a free tile · <kbd>Esc</kbd> or right-click to cancel
            </div>
          )}
          <BuildCards s={s} onPlace={a.place} />
        </div>
      )}
      {imOut && !over && (
        <div className="gs-bottom">
          <div className="gs-out-note">Your garden has wilted. Watch the others from the garden strip.</div>
        </div>
      )}

      <GardenCoach state={menu && !s.paused ? { ...s, paused: true } : s} actions={a} />

      <div className="gs-hint">
        <kbd>1</kbd>–<kbd>5</kbd> build · <kbd>R</kbd> call wave · <kbd>U</kbd> upgrade · <kbd>X</kbd> sell · <kbd>Tab</kbd> scores · <kbd>Esc</kbd> menu
      </div>

      {s.scoresOpen && !s.end && !menu && (
        <div className="gs-overlay gs-pass">
          <div className="gs-sheet">
            <h2>
              Wave {s.wave}
              {s.maxWave ? ` / ${s.maxWave}` : ''} <span>· {s.mapName}</span>
            </h2>
            <p className="gs-sub">{vs ? 'Versus: last garden standing wins.' : 'Co-op: defend the greenhouse together.'}</p>
            <ScoreTable scores={s.scores} vs={vs} you={s.you || ctx.you} nameOf={nameOf} colorOf={colorOf} />
          </div>
        </div>
      )}

      {s.end && <EndScreen s={s} you={s.you || ctx.you} nameOf={nameOf} colorOf={colorOf} onLeave={a.leave} />}

      {menu && !s.end && (
        <div className="gs-overlay">
          <div className="gs-sheet gs-menu">
            <h2>Menu</h2>
            <p className="gs-sub">
              The garden keeps growing while you are here. Room code <b className="gs-code">{room.code}</b>
            </p>
            <div className="gs-settings">
              <div className="gs-setting">
                <span>Graphics</span>
                <span className="gs-seg">
                  {(['low', 'medium', 'high'] as Quality[]).map((q) => (
                    <button key={q} type="button" className={q === s.quality ? 'on' : ''} onClick={() => a.setQuality(q)}>
                      {q}
                    </button>
                  ))}
                </span>
              </div>
              <div className="gs-setting">
                <span>Sound</span>
                <VolumeControl />
              </div>
            </div>
            <h3>Controls</h3>
            <ul className="gs-controls">
              <li>
                <span className="gs-keys"><kbd>1</kbd>–<kbd>5</kbd></span>
                <span>pick a tower, click a tile to plant it</span>
              </li>
              <li>
                <span className="gs-keys"><kbd>R</kbd></span>
                <span>call the next wave early (bonus gold)</span>
              </li>
              <li>
                <span className="gs-keys"><kbd>U</kbd> <kbd>X</kbd></span>
                <span>upgrade / sell the selected tower</span>
              </li>
              <li>
                <span className="gs-keys"><kbd>Tab</kbd></span>
                <span>scores</span>
              </li>
              <li>
                <span className="gs-keys"><kbd>WASD</kbd> drag</span>
                <span>pan the camera</span>
              </li>
              <li>
                <span className="gs-keys"><kbd>Wheel</kbd> pinch</span>
                <span>zoom</span>
              </li>
              <li>
                <span className="gs-keys"><kbd>Esc</kbd> right-click</span>
                <span>cancel placing, deselect</span>
              </li>
            </ul>
            <div className="gs-actions">
              {isHost && (
                <button type="button" className="gs-btn danger" onClick={() => ctx.socket.send({ t: 'stop' })}>
                  End match for everyone
                </button>
              )}
              <button type="button" className="gs-btn ghost" onClick={a.leave}>
                Back to main page
              </button>
              <button type="button" className="gs-btn primary" onClick={() => setMenu(false)}>
                Resume
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- resources ---------------------------------------------------------------------------------------------------

/** Eases a number towards its target so gold counts up instead of jumping. */
function useTween(value: number, ms = 350) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const cur = useRef(value);
  useEffect(() => {
    from.current = cur.current;
    const t0 = performance.now();
    let raf = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = 1 - (1 - k) ** 3;
      cur.current = from.current + (value - from.current) * e;
      setShown(Math.round(cur.current));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

/** Floating "+12" / "-100" deltas next to a number. */
function useDeltas(value: number) {
  const prev = useRef(value);
  const [list, setList] = useState<{ key: number; d: number }[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const d = value - prev.current;
    prev.current = value;
    if (!d) return;
    const key = ++seq.current;
    setList((l) => [...l.slice(-3), { key, d }]);
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      setList((l) => l.filter((x) => x.key !== key));
    }, 1100);
    timers.current.add(t);
  }, [value]);
  useEffect(() => {
    const set = timers.current;
    return () => set.forEach((t) => window.clearTimeout(t));
  }, []);
  return list;
}

function Resources({ s, imOut, viewingName }: { s: GHudState; imOut: boolean; viewingName?: string }) {
  const gold = useTween(s.gold);
  const deltas = useDeltas(s.gold);
  const lifeDeltas = useDeltas(s.lives);
  const lastGain = deltas[deltas.length - 1];
  const lifeFrac = s.maxLives > 0 ? Math.max(0, Math.min(1, s.lives / s.maxLives)) : 0;
  return (
    <div className="gs-res gs-card-cream">
      <div className="gs-res-row gs-gold" title="Gold">
        <Leaf />
        <b key={lastGain?.key ?? 0} className={`gs-num ${lastGain ? (lastGain.d > 0 ? 'up' : 'down') : ''}`}>
          {fmt(gold)}
        </b>
        <span className="gs-deltas">
          {deltas.map((d) => (
            <i key={d.key} className={d.d > 0 ? 'up' : 'down'}>
              {d.d > 0 ? '+' : '−'}
              {fmt(Math.abs(d.d))}
            </i>
          ))}
        </span>
      </div>
      <div className={`gs-res-row gs-lives ${lifeFrac <= 0.25 ? 'low' : ''}`} title={viewingName ? `${viewingName}’s lives` : 'Greenhouse lives'}>
        <Heart />
        <b key={lifeDeltas[lifeDeltas.length - 1]?.key ?? 0} className={`gs-num ${lifeDeltas.length ? 'hurt' : ''}`}>
          {s.lives}
        </b>
        <span className="gs-life-bar">
          <i style={{ width: `${lifeFrac * 100}%` }} />
        </span>
      </div>
      {s.mode === 'vs' && !imOut && (
        <div className="gs-res-row gs-income" title="Income paid at the start of every wave. Sends raise it.">
          <IncomeArrow />
          <b className="gs-num">+{fmt(s.income)}</b>
          <span className="gs-res-label">per wave</span>
        </div>
      )}
    </div>
  );
}

function Players({ s }: { s: GHudState }) {
  if (s.players.length <= 1) return null;
  const build = s.phase === 'build';
  return (
    <div className="gs-list gs-card-slate">
      <div className="gs-list-title">Gardeners</div>
      {s.players.map((p) => (
        <div key={p.id} className={`gs-list-row ${p.id === s.you ? 'me' : ''}`}>
          <i className="gs-swatch" style={{ background: hex(p.color) }} />
          <span className="gs-name">
            {p.name}
            {p.bot && <em>bot</em>}
          </span>
          <span className="gs-mini-gold">
            <Leaf />
            {fmt(p.gold)}
          </span>
          {build && !p.bot && <span className={`gs-check ${p.ready ? 'on' : ''}`} title={p.ready ? 'Ready for the next wave' : 'Still building'} />}
        </div>
      ))}
    </div>
  );
}

function Boards({ s, onView }: { s: GHudState; onView: (b: number) => void }) {
  const sorted = [...s.boards].sort((x, y) => Number(x.out) - Number(y.out) || (x.place ?? 0) - (y.place ?? 0) || x.b - y.b);
  return (
    <div className="gs-list gs-card-slate gs-boards">
      <div className="gs-list-title">Gardens</div>
      {sorted.map((b) => (
        <button
          type="button"
          key={b.b}
          className={`gs-list-row gs-board ${b.b === s.viewBoard ? 'viewing' : ''} ${b.b === s.myBoard ? 'me' : ''} ${b.out ? 'out' : ''}`}
          onClick={() => onView(b.b)}
          title={b.b === s.viewBoard ? 'You are watching this garden' : `Look at ${b.name}’s garden`}
        >
          <i className="gs-swatch" style={{ background: hex(b.color) }} />
          <span className="gs-name">
            {b.name}
            {b.b === s.myBoard && <em>you</em>}
          </span>
          {b.out ? (
            <span className="gs-place">{b.place ? ordinal(b.place) : 'out'}</span>
          ) : (
            <span className="gs-mini-lives">
              <Heart />
              {b.lives}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

// ---- wave ------------------------------------------------------------------------------------------------------------

function WaveBar({ s }: { s: GHudState }) {
  const build = s.phase === 'build';
  // During the build phase the wave on the bar is the one coming up.
  const shown = Math.max(1, build ? s.wave + 1 : s.wave);
  const capped = s.maxWave ? Math.min(shown, s.maxWave) : shown;
  const block = Math.floor((capped - 1) / 10);
  const pips = Array.from({ length: 10 }, (_, i) => block * 10 + i + 1);
  const bossWave = capped % 10 === 0;
  return (
    <div className={`gs-wave gs-card-slate ${bossWave ? 'boss' : ''} ${build ? 'build' : ''}`}>
      <div className="gs-wave-title">
        WAVE <b className="gs-num">{capped}</b>
        {s.maxWave > 0 && <span className="gs-num"> / {s.maxWave}</span>}
      </div>
      <div className="gs-pips">
        {pips.map((n) => {
          const isBoss = n % 10 === 0;
          const done = build ? n < shown : n < s.wave;
          const cur = n === shown;
          const fill = cur && !build ? Math.max(0.08, Math.min(1, s.progress)) : 0;
          if (isBoss)
            return (
              <span key={n} className={`gs-pip-boss ${done ? 'done' : ''} ${cur ? 'cur' : ''}`} title={`Wave ${n}: boss`}>
                <Skull />
              </span>
            );
          return (
            <span key={n} className={`gs-pip ${done ? 'done' : ''} ${cur ? 'cur' : ''}`}>
              {cur && <i style={{ width: `${fill * 100}%` }} />}
            </span>
          );
        })}
      </div>
      <div className="gs-wave-sub">
        {s.phase === 'build' && (
          <>
            {s.wave === 0 ? 'First wave' : 'Next wave'} in <b className="gs-num">{Math.ceil(s.left)}s</b>
          </>
        )}
        {s.phase === 'wave' && (
          <>
            <b className="gs-num">{fmt(s.left)}</b> {s.left === 1 ? 'enemy' : 'enemies'} left
          </>
        )}
        {s.phase === 'over' && 'Match over'}
      </div>
    </div>
  );
}

function NextWave({ s }: { s: GHudState }) {
  if (!s.next.length) return null;
  return (
    <div className={`gs-next ${s.bossNext ? 'boss' : ''}`}>
      <span className="gs-next-label">Next</span>
      {s.next.map((g) => (
        <span key={g.kind} className={`gs-chip gs-chip-${g.kind}`} title={`${ENEMIES[g.kind].name}: ${ENEMIES[g.kind].blurb}`}>
          <EnemyIcon kind={g.kind} />
          <b className="gs-num">×{g.count}</b>
        </span>
      ))}
      {s.bossNext && <span className="gs-boss-tag">BOSS</span>}
    </div>
  );
}

function CallWave({ s, onReady }: { s: GHudState; onReady: () => void }) {
  const humans = s.players.filter((p) => !p.bot);
  const ready = humans.filter((p) => p.ready).length;
  const me = s.players.find((p) => p.id === s.you);
  const bonus = Math.max(0, Math.floor(s.left)) * G.earlyBonusPerSec;
  return (
    <button type="button" className={`gs-call ${me?.ready ? 'on' : ''}`} onClick={onReady} title="Start the next wave early once everyone is ready; bonus gold for every second skipped.">
      <span className="gs-call-main">
        {me?.ready ? 'Ready!' : 'Call wave'} <kbd>R</kbd>
      </span>
      {humans.length > 1 && (
        <span className="gs-call-count gs-num">
          {ready}/{humans.length}
        </span>
      )}
      {bonus > 0 && (
        <span className="gs-call-bonus gs-num">
          +{bonus}
          <Leaf />
        </span>
      )}
    </button>
  );
}

// ---- toasts ----------------------------------------------------------------------------------------------------------

/** Each toast lives for TOAST_MS from when the HUD first saw it (independent of the clock behind `at`). */
function Toasts({ toasts }: { toasts: Toast[] }) {
  const seen = useRef(new Map<number, number>());
  const [, setTick] = useState(0);
  const now = performance.now();
  for (const t of toasts) if (!seen.current.has(t.key)) seen.current.set(t.key, now);
  const live = toasts.filter((t) => now - (seen.current.get(t.key) ?? now) < TOAST_MS[t.tone]).slice(-4);
  useEffect(() => {
    if (!live.length) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [live.length]);
  useEffect(() => {
    const keep = new Set(toasts.map((t) => t.key));
    for (const k of seen.current.keys()) if (!keep.has(k)) seen.current.delete(k);
  }, [toasts]);
  return (
    <div className="gs-toasts" aria-live="polite">
      {live.map((t) => {
        const age = now - (seen.current.get(t.key) ?? now);
        const leaving = age > TOAST_MS[t.tone] - 400;
        return (
          <div key={t.key} className={`gs-toast ${t.tone} ${leaving ? 'leaving' : ''}`}>
            {t.tone === 'boss' && <Skull />}
            {t.text}
          </div>
        );
      })}
    </div>
  );
}

// ---- build cards -----------------------------------------------------------------------------------------------------

function damageLabel(k: TowerKind, lv: Level): string {
  const l = TOWERS[k].levels[lv - 1];
  switch (k) {
    case 'laser':
      return `${l.dmg} dps${l.count ? `, chains ${l.count}` : ''}`;
    case 'shield':
      return `${l.dmg} dps zap`;
    case 'slow':
      return `${Math.round((l.slow ?? 0) * 100)}% slow`;
    case 'missile':
      return `${l.dmg} × ${l.count ?? 1} splash`;
    case 'beacon':
      return `+${Math.round((l.buffDmg ?? 0) * 100)}% dmg`;
  }
}

function BuildCards({ s, onPlace }: { s: GHudState; onPlace: (k: TowerKind | null) => void }) {
  return (
    <div className="gs-cards" role="toolbar" aria-label="Build a tower">
      {TOWER_KINDS.map((k) => {
        const d = TOWERS[k];
        const cost = d.levels[0].cost;
        const poor = s.gold < cost;
        const active = s.placing === k;
        return (
          <button
            type="button"
            key={k}
            className={`gs-tcard ${poor ? 'poor' : ''} ${active ? 'active' : ''}`}
            onClick={() => onPlace(active ? null : k)}
            aria-pressed={active}
            aria-label={`${d.name}, ${cost} gold, key ${d.key}`}
          >
            <span className="gs-tcard-art">
              <Portrait name={`tower_${k}_1`} fallback={<TowerIcon kind={k} />} />
              <kbd className="gs-key">{d.key}</kbd>
            </span>
            <span className="gs-tcard-name">{d.name}</span>
            <span className="gs-tcard-cost gs-num">
              <Leaf />
              {cost}
            </span>
            <span className="gs-tip" role="tooltip">
              <b>{d.name}</b>
              <span>{d.blurb}</span>
              <span className="gs-tip-stats">
                <span>
                  Range <b className="gs-num">{d.levels[0].range} m</b>
                </span>
                <span>
                  {k === 'beacon' ? 'Buff' : k === 'slow' ? 'Field' : 'Damage'} <b className="gs-num">{damageLabel(k, 1)}</b>
                </span>
              </span>
              <span className="gs-tip-note">{d.notes[0]}</span>
              {poor && <span className="gs-tip-poor">Need {cost - s.gold} more gold</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---- selected tower --------------------------------------------------------------------------------------------------

interface Stat {
  label: string;
  v: number;
  unit?: string;
  /** Lower is better (reload time). */
  low?: boolean;
  pct?: boolean;
}

function statsOf(k: TowerKind, lv: Level): Stat[] {
  const l = TOWERS[k].levels[lv - 1];
  const out: Stat[] = [];
  switch (k) {
    case 'laser':
      out.push({ label: 'Damage', v: l.dmg, unit: '/s' }, { label: 'Range', v: l.range, unit: ' m' }, { label: 'Chains', v: l.count ?? 0 });
      break;
    case 'shield':
      out.push({ label: 'Zap', v: l.dmg, unit: '/s' }, { label: 'Bubble', v: l.range, unit: ' m' }, { label: 'Stun', v: l.reflect ?? 0, unit: ' s' });
      break;
    case 'slow':
      out.push({ label: 'Slow', v: (l.slow ?? 0) * 100, pct: true }, { label: 'Field', v: l.range, unit: ' m' }, { label: 'Sting', v: l.dmg, unit: '/s' });
      break;
    case 'missile':
      out.push(
        { label: 'Damage', v: l.dmg },
        { label: 'Missiles', v: l.count ?? 1 },
        { label: 'Reload', v: l.interval ?? 0, unit: ' s', low: true },
        { label: 'Splash', v: l.splash ?? 0, unit: ' m' },
        { label: 'Range', v: l.range, unit: ' m' },
      );
      break;
    case 'beacon':
      out.push(
        { label: 'Damage buff', v: (l.buffDmg ?? 0) * 100, pct: true },
        { label: 'Rate buff', v: (l.buffRate ?? 0) * 100, pct: true },
        { label: 'Range buff', v: (l.buffRange ?? 0) * 100, pct: true },
        { label: 'Aura', v: l.range, unit: ' m' },
      );
      break;
  }
  return out;
}

const statText = (st: Stat) => (st.pct ? `+${Math.round(st.v)}%` : `${Math.round(st.v * 10) / 10}${st.unit ?? ''}`);

function TowerPanel({ s, sel, a }: { s: GHudState; sel: HudSelected; a: GardenActions }) {
  const t = sel.tower;
  const d = TOWERS[t.k];
  const now = statsOf(t.k, t.lv);
  const next = t.lv < 3 ? statsOf(t.k, (t.lv + 1) as Level) : null;
  const canUp = sel.mine || s.mode === 'coop';
  const poor = sel.upCost !== null && s.gold < sel.upCost;
  const team = hex(sel.ownerColor);
  const badges: [string, string][] = [];
  if (sel.flags & TFlag.disabled) badges.push(['disabled', 'Disabled']);
  if (sel.flags & TFlag.shielded) badges.push(['shielded', 'Shielded']);
  if (sel.flags & TFlag.buffed) badges.push(['buffed', 'Buffed']);
  return (
    <div className={`gs-panel gs-card-cream lv${t.lv}`} style={{ ['--gs-owner' as string]: team } as CSSProperties}>
      <button type="button" className="gs-close" aria-label="Deselect" onClick={a.deselect}>
        ×
      </button>
      <div className="gs-panel-head">
        <span className="gs-panel-art">
          <Portrait key={`${t.k}${t.lv}`} name={`tower_${t.k}_${t.lv}`} fallback={<TowerIcon kind={t.k} team={team} />} />
        </span>
        <div>
          <div className="gs-panel-name">{d.name}</div>
          <div className="gs-panel-lv">
            <span className="gs-lv-pips">
              {[1, 2, 3].map((n) => (
                <i key={n} className={n <= t.lv ? 'on' : ''} />
              ))}
            </span>
            Lv {t.lv} {LEVEL_NAMES[t.lv]}
          </div>
          <div className="gs-panel-owner">
            <i className="gs-swatch" style={{ background: team }} />
            {sel.mine ? 'Yours' : sel.ownerName}
          </div>
        </div>
      </div>
      {badges.length > 0 && (
        <div className="gs-badges">
          {badges.map(([k, label]) => (
            <span key={k} className={`gs-badge ${k}`}>
              {label}
            </span>
          ))}
        </div>
      )}
      <div className="gs-stats">
        {now.map((st, i) => {
          const nx = next?.[i];
          const better = nx && (st.low ? nx.v < st.v : nx.v > st.v);
          if (!st.v && !nx?.v) return null;
          return (
            <div key={st.label} className="gs-stat">
              <span>{st.label}</span>
              <b className="gs-num">{st.v ? statText(st) : '–'}</b>
              <span className={`gs-next-val gs-num ${better ? 'better' : ''}`}>{nx && better ? `→ ${statText(nx)}` : ''}</span>
            </div>
          );
        })}
      </div>
      <p className="gs-note">{next ? `Next: ${d.notes[t.lv as 1 | 2]}` : d.notes[t.lv - 1]}</p>
      {d.targets && (
        <div className="gs-target">
          <span>Target</span>
          <span className="gs-seg small">
            {TARGET_MODES.map((_, i) => (
              <button key={i} type="button" className={t.tm === i ? 'on' : ''} disabled={!sel.mine} onClick={() => a.setTarget(t.id, i as TargetMode)}>
                {TARGET_LABELS[i]}
              </button>
            ))}
          </span>
        </div>
      )}
      <div className="gs-panel-actions">
        {canUp &&
          (sel.upCost !== null ? (
            <button type="button" className={`gs-btn up ${poor ? 'poor' : ''}`} disabled={poor} onClick={() => a.upgrade(t.id)}>
              Upgrade <kbd>U</kbd>
              <span className="gs-cost gs-num">
                <Leaf />
                {sel.upCost}
              </span>
            </button>
          ) : (
            <span className="gs-max">Masterwork</span>
          ))}
        {sel.mine && (
          <button type="button" className="gs-btn sell" onClick={() => a.sell(t.id)}>
            Sell <kbd>X</kbd>
            <span className="gs-cost gs-num">+{sel.sellValue}</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ---- versus sends ----------------------------------------------------------------------------------------------------

function SendPanel({ s, a, to, setTo }: { s: GHudState; a: GardenActions; to: number | undefined; setTo: (b: number | undefined) => void }) {
  const foes = s.boards.filter((b) => b.b !== s.myBoard && !b.out);
  const target = foes.some((f) => f.b === to) ? to : undefined;
  return (
    <div className="gs-send gs-card-slate">
      <div className="gs-list-title">
        Sends <span>gold now, income forever</span>
      </div>
      <div className="gs-send-grid">
        {SENDS.map((d) => {
          const locked = s.wave < d.from;
          const poor = s.gold < d.cost;
          return (
            <button
              type="button"
              key={d.kind}
              className={`gs-send-btn ${locked ? 'locked' : ''} ${poor ? 'poor' : ''}`}
              disabled={locked || poor || !foes.length}
              onClick={() => a.send(d.kind as EnemyKind, target)}
              title={`${ENEMIES[d.kind].name}: ${ENEMIES[d.kind].blurb}`}
            >
              <EnemyIcon kind={d.kind} />
              <span className="gs-send-count gs-num">×{d.count}</span>
              {locked ? (
                <span className="gs-send-lock">Wave {d.from}</span>
              ) : (
                <>
                  <span className="gs-send-cost gs-num">
                    <Leaf />
                    {d.cost}
                  </span>
                  <span className="gs-send-inc gs-num">+{d.income}/w</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      {foes.length > 1 && (
        <div className="gs-send-to">
          <span>At</span>
          <button type="button" className={target === undefined ? 'on' : ''} onClick={() => setTo(undefined)}>
            Next
          </button>
          {foes.map((f) => (
            <button type="button" key={f.b} className={target === f.b ? 'on' : ''} onClick={() => setTo(f.b)} title={f.name}>
              <i className="gs-swatch" style={{ background: hex(f.color) }} />
              {f.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- scores + end ----------------------------------------------------------------------------------------------------

function ScoreTable({ scores, vs, you, nameOf, colorOf }: { scores: GScore[]; vs: boolean; you: string; nameOf: (id: string) => string; colorOf: (id: string) => string }) {
  const sorted = [...scores].sort((x, y) => (vs && x.place && y.place ? x.place - y.place : 0) || y.points - x.points);
  return (
    <div className="gs-table-wrap">
      <table className="gs-table">
        <thead>
          <tr>
            {vs && <th className="num">#</th>}
            <th>Gardener</th>
            <th className="num">Points</th>
            <th className="num">Kills</th>
            <th className="num">Damage</th>
            <th className="num">Built</th>
            {vs && <th className="num">Sent</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id} className={r.id === you ? 'me' : ''}>
              {vs && <td className="num">{r.place ? ordinal(r.place) : '–'}</td>}
              <td>
                <i className="gs-swatch" style={{ background: colorOf(r.id) }} />
                {nameOf(r.id)}
              </td>
              <td className="num">{fmt(r.points)}</td>
              <td className="num">{fmt(r.kills)}</td>
              <td className="num">{fmt(r.dmg)}</td>
              <td className="num">{fmt(r.built)}</td>
              {vs && <td className="num">{fmt(r.sent)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EndScreen({ s, you, nameOf, colorOf, onLeave }: { s: GHudState; you: string; nameOf: (id: string) => string; colorOf: (id: string) => string; onLeave: () => void }) {
  const e = s.end!;
  const vs = s.mode === 'vs';
  const iWon = vs ? e.winner === you : e.win;
  const title = vs ? (e.winner === you ? 'Your garden stands!' : e.winner ? `${nameOf(e.winner)} wins` : 'No garden left') : e.win ? 'Garden saved!' : 'Garden overrun';
  const sub = vs
    ? `Last garden standing after wave ${e.wave}.`
    : e.win
      ? `All ${s.maxWave || e.wave} waves held back. The greenhouse is safe.`
      : `The aliens reached the greenhouse on wave ${e.wave}.`;
  return (
    <div className="gs-overlay">
      <div className={`gs-sheet gs-end ${iWon ? 'win' : 'lose'}`}>
        <div className="gs-end-art">{iWon ? <Trophy /> : <Heart />}</div>
        <h2>{title}</h2>
        <p className="gs-sub">{sub}</p>
        {vs && e.winner && (
          <p className="gs-winner">
            <i className="gs-swatch" style={{ background: colorOf(e.winner) }} />
            {nameOf(e.winner)}
          </p>
        )}
        <ScoreTable scores={s.scores} vs={vs} you={you} nameOf={nameOf} colorOf={colorOf} />
        <div className="gs-actions">
          <span className="gs-sub small">Back to the room in a moment.</span>
          <button type="button" className="gs-btn ghost" onClick={onLeave}>
            Back to main page
          </button>
        </div>
      </div>
    </div>
  );
}
