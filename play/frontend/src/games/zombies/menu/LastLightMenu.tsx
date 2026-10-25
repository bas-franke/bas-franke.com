// Last Light's title screen at /lastlight: the key art drifting behind a failing-light wordmark, and a short vertical
// menu. Sub-screens (host, join, settings, how to play) slide in as a panel over the same backdrop; Esc or Backspace
// steps back. It only talks to the lobby API and local settings, so the chunk stays free of three.js; the match
// itself still runs in the waiting room at /room/CODE.

import { type BotDifficulty, GAMES, LIMITS, type RoomSummary } from '@shared/protocol';
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DIFFICULTIES, type QuickStart, createRoom, listRooms, quickBots, quickPlay, saveDifficulty, saveName, savedDifficulty, savedName } from '../../../api';
import { sfx } from '../../../engine/audio';
import { VolumeControl } from '../../../ui/VolumeControl';
import { Backdrop } from './Backdrop';
import { QUALITIES, type Quality, SENS_MAX, SENS_MIN, loadQuality, loadSensitivity, saveQuality, saveSensitivity } from './settings';
import './menu.css';

const META = GAMES.zombies;

type Screen = 'main' | 'host' | 'join' | 'settings' | 'help';

const PANEL_TITLES: Record<Exclude<Screen, 'main'>, { kicker: string; title: string }> = {
  host: { kicker: 'Open a room', title: 'Host a squad' },
  join: { kicker: 'Radio in', title: 'Join a squad' },
  settings: { kicker: 'Field kit', title: 'Settings' },
  help: { kicker: 'Briefing', title: 'How to play' },
};

/** Focusable things the arrow keys walk through, in document order. */
const NAV = 'button:not([disabled]), input:not([disabled]), a[href]';

export function LastLightMenu() {
  const navigate = useNavigate();
  const [screen, setScreen] = useState<Screen>('main');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [difficulty, setDifficulty] = useState<BotDifficulty>(savedDifficulty);
  const menuRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The menu item that opened the current panel gets focus back when it closes.
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = `${META.name} · play`;
    return () => {
      document.title = prev;
    };
  }, []);

  const open = (s: Screen) => {
    opener.current = document.activeElement as HTMLElement | null;
    setError('');
    setScreen(s);
  };
  const back = useCallback(() => {
    setScreen('main');
    // After the panel unmounts, so focus lands on the visible menu.
    requestAnimationFrame(() => (opener.current ?? menuRef.current?.querySelector<HTMLElement>(NAV))?.focus());
  }, []);

  // New panel: focus its first control, so the keyboard carries straight on.
  useEffect(() => {
    if (screen === 'main') menuRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    else (panelRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panelRef.current?.querySelector<HTMLElement>(NAV))?.focus();
  }, [screen]);

  // Arrow keys move the focus like a console menu; Esc / Backspace go back. Inputs keep the keys they need.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el instanceof HTMLInputElement && el.type !== 'range' && el.type !== 'button';
      if (e.key === 'Escape' || (e.key === 'Backspace' && !typing)) {
        if (screen !== 'main') {
          e.preventDefault();
          back();
        }
        return;
      }
      // The briefing is text to read: there the arrows scroll the (focused) panel body instead.
      if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || screen === 'help') return;
      const scope = screen === 'main' ? menuRef.current : panelRef.current;
      if (!scope) return;
      const list = [...scope.querySelectorAll<HTMLElement>(NAV)].filter((n) => n.offsetParent !== null);
      if (!list.length) return;
      e.preventDefault();
      const i = el ? list.indexOf(el) : -1;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = i < 0 ? list[0] : list[(i + step + list.length) % list.length];
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screen, back]);

  const playSolo = async () => {
    // The click is the gesture browsers want before the match may make sound.
    sfx.unlock();
    setBusy(true);
    setError('');
    try {
      const code = await quickPlay('zombies');
      navigate(`/room/${code}`, { state: { quickStart: true } satisfies QuickStart });
    } catch (err) {
      setError(`Could not start a match: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  const pickDifficulty = (d: BotDifficulty) => {
    setDifficulty(d);
    saveDifficulty(d);
  };

  const items: { id: Screen | 'solo'; label: string; sub: string; onClick: () => void }[] = [
    { id: 'solo', label: busy ? 'Calling it in…' : 'Play solo', sub: `You and ${quickBots('zombies')} bots · ${DIFFICULTIES.find((d) => d.id === difficulty)?.label}`, onClick: playSolo },
    { id: 'host', label: 'Host a squad', sub: 'Open a room for friends', onClick: () => open('host') },
    { id: 'join', label: 'Join a squad', sub: 'Room code or open rooms', onClick: () => open('join') },
    { id: 'settings', label: 'Settings', sub: 'Graphics, mouse, sound, name', onClick: () => open('settings') },
    { id: 'help', label: 'How to play', sub: 'Controls and the rules', onClick: () => open('help') },
  ];

  return (
    <div className={`llm${screen !== 'main' ? ' has-panel' : ''}`} style={{ ['--ll-red' as string]: META.accent }}>
      <Backdrop onCaption={setCaption} />

      <div className="llm-main" ref={menuRef}>
        <header className="llm-head">
          <span className="llm-kicker">Grand Meridian Hotel · 1–{META.maxPlayers} players</span>
          <h1 className="llm-title" aria-label={META.name}>
            <span aria-hidden>LAST</span>
            <span aria-hidden>
              L<i className="llm-dying">I</i>GHT
            </span>
          </h1>
          <p className="llm-tagline">{META.tagline}</p>
        </header>

        <nav className="llm-menu" aria-label="Main menu">
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              className={`llm-item${screen === it.id ? ' active' : ''}`}
              onClick={it.onClick}
              disabled={it.id === 'solo' && busy}
              aria-expanded={it.id === 'solo' ? undefined : screen === it.id}
              data-autofocus={i === 0 ? '' : undefined}
            >
              <span className="llm-item-label">{it.label}</span>
              <span className="llm-item-sub">{it.sub}</span>
            </button>
          ))}
          <Link className="llm-item llm-exit" to="/">
            <span className="llm-item-label">Back to main page</span>
            <span className="llm-item-sub">All games on play.bas-franke.com</span>
          </Link>
        </nav>
        {error && (
          <p className="llm-error" role="alert">
            {error}
          </p>
        )}
        <p className="llm-keys" aria-hidden>
          <kbd>↑</kbd>
          <kbd>↓</kbd> select · <kbd>Enter</kbd> confirm · <kbd>Esc</kbd> back
        </p>
      </div>

      {screen !== 'main' && (
        <section className="llm-panel" ref={panelRef} aria-label={PANEL_TITLES[screen].title} key={screen}>
          <div className="llm-panel-head">
            <div>
              <span className="llm-kicker">{PANEL_TITLES[screen].kicker}</span>
              <h2>{PANEL_TITLES[screen].title}</h2>
            </div>
            <button type="button" className="llm-close" onClick={back} aria-label="Back to the menu">
              ← Back
            </button>
          </div>
          <div className="llm-panel-body" tabIndex={-1} data-autofocus={screen === 'help' ? '' : undefined}>
            {screen === 'host' && <HostScreen difficulty={difficulty} onDifficulty={pickDifficulty} onCreated={(code) => navigate(`/room/${code}`)} />}
            {screen === 'join' && <JoinScreen onJoin={(code) => navigate(`/room/${code}`)} onHost={() => setScreen('host')} />}
            {screen === 'settings' && <SettingsScreen difficulty={difficulty} onDifficulty={pickDifficulty} />}
            {screen === 'help' && <HelpScreen />}
          </div>
        </section>
      )}

      {caption && (
        <p className="llm-caption" key={caption}>
          <span className="llm-rec" aria-hidden />
          {caption}
        </p>
      )}
    </div>
  );
}

// ---- sub-screens ------------------------------------------------------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="llm-field">
      <span className="llm-label">{label}</span>
      {children}
      {hint && <span className="llm-hint">{hint}</span>}
    </div>
  );
}

/** A row of mutually exclusive buttons; Left / Right walk it like a console option switcher. */
function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = options.findIndex((o) => o.id === value);
    const next = options[(i + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length];
    onChange(next.id);
    // Keep the focus on the selected button so the next Up / Down leaves from here.
    (e.currentTarget.querySelector(`[data-id="${next.id}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="llm-choice" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} data-id={o.id} className={o.id === value ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** − value + with Left / Right as shortcuts. */
function Stepper({ value, min, max, onChange, label, unit }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string; unit: (n: number) => string }) {
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      onChange(Math.max(min, Math.min(max, value + (e.key === 'ArrowRight' ? 1 : -1))));
    }
  };
  return (
    <div className="llm-stepper" role="group" aria-label={label} onKeyDown={onKey}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`Fewer ${label.toLowerCase()}`}>
        −
      </button>
      <output aria-live="polite">{unit(value)}</output>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`More ${label.toLowerCase()}`}>
        +
      </button>
    </div>
  );
}

function HostScreen({ difficulty, onDifficulty, onCreated }: { difficulty: BotDifficulty; onDifficulty: (d: BotDifficulty) => void; onCreated: (code: string) => void }) {
  const [name, setName] = useState(savedName);
  const [roomName, setRoomName] = useState('');
  const [seats, setSeats] = useState(4);
  const [bots, setBots] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const botCount = Math.min(bots, seats - 1);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    sfx.unlock();
    setBusy(true);
    setError('');
    try {
      const nick = name.trim() || 'Player';
      saveName(nick);
      const { room } = await createRoom({
        name: roomName.trim() || `${nick}'s squad`,
        game: 'zombies',
        maxPlayers: seats,
        bots: botCount,
        botDifficulty: difficulty,
      });
      onCreated(room.code);
    } catch (err) {
      setError(`Could not open the room: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="llm-form">
      <Field label="Your name">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.playerNameMax} placeholder="Player" data-autofocus="" />
      </Field>
      <Field label="Squad name">
        <input value={roomName} onChange={(e) => setRoomName(e.target.value)} maxLength={LIMITS.roomNameMax} placeholder={`${name.trim() || 'Player'}'s squad`} />
      </Field>
      <Field label="Seats" hint="Humans and bots together. 4+ opens the lounge bar, 7+ the restaurant.">
        <Stepper label="Seats" value={seats} min={META.minPlayers + 1} max={META.maxPlayers} onChange={setSeats} unit={(n) => `${n} seats`} />
      </Field>
      <Field label="Bots" hint="They hold a door, revive you and take a seat each. Kick them in the room later.">
        <Stepper label="Bots" value={botCount} min={0} max={seats - 1} onChange={setBots} unit={(n) => (n === 0 ? 'No bots' : `${n} bot${n > 1 ? 's' : ''}`)} />
      </Field>
      <Field label="Bot difficulty" hint={DIFFICULTIES.find((d) => d.id === difficulty)?.blurb}>
        <Choice label="Bot difficulty" value={difficulty} options={DIFFICULTIES} onChange={onDifficulty} />
      </Field>
      {error && (
        <p className="llm-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="llm-cta" disabled={busy}>
        {busy ? 'Opening the doors…' : 'Open the room'}
      </button>
    </form>
  );
}

function JoinScreen({ onJoin, onHost }: { onJoin: (code: string) => void; onHost: () => void }) {
  const [code, setCode] = useState('');
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      listRooms()
        .then((r) => alive && (setRooms(r.rooms.filter((x) => x.game === 'zombies')), setOffline(false)))
        .catch(() => alive && setOffline(true));
    load();
    const timer = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.length === 4) onJoin(code);
  };

  return (
    <div className="llm-form">
      <form onSubmit={submit} className="llm-code-row">
        <Field label="Room code" hint="Four characters, from the host's room page.">
          <input
            className="llm-code"
            value={code}
            // Room codes use letters and digits only; normalise as the player types.
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
            placeholder="ABCD"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-label="Room code"
            data-autofocus=""
          />
        </Field>
        <button type="submit" className="llm-cta small" disabled={code.length !== 4}>
          Join
        </button>
      </form>

      <div className="llm-label llm-rooms-head">
        Open squads {rooms && <span className="llm-count">{rooms.length}</span>}
      </div>
      {offline ? (
        <p className="llm-empty-note">Can’t reach the server right now. A room code still works once it is back.</p>
      ) : rooms === null ? (
        <p className="llm-empty-note">Listening for survivors…</p>
      ) : rooms.length === 0 ? (
        <div className="llm-empty-note">
          <p>No squads out there right now.</p>
          <button type="button" className="llm-link" onClick={onHost}>
            Host one →
          </button>
        </div>
      ) : (
        <ul className="llm-rooms">
          {rooms.map((r) => {
            const full = r.humans + r.bots >= r.maxPlayers && r.bots === 0;
            return (
              <li key={r.code}>
                <button type="button" className="llm-room" onClick={() => onJoin(r.code)} disabled={full}>
                  <span className="llm-room-name">{r.name}</span>
                  <span className="llm-room-meta">
                    {r.humans} {r.humans === 1 ? 'survivor' : 'survivors'}
                    {r.bots > 0 && ` + ${r.bots} bots`} · {r.maxPlayers} seats · {r.state === 'playing' ? 'under siege' : 'waiting'}
                  </span>
                  <span className="llm-room-code">{full ? 'Full' : r.code}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SettingsScreen({ difficulty, onDifficulty }: { difficulty: BotDifficulty; onDifficulty: (d: BotDifficulty) => void }) {
  const [quality, setQuality] = useState<Quality>(loadQuality);
  const [sens, setSens] = useState(loadSensitivity);
  const [name, setName] = useState(savedName);

  return (
    <div className="llm-form">
      <Field label="Graphics" hint={QUALITIES.find((q) => q.id === quality)?.blurb}>
        <Choice
          label="Graphics"
          value={quality}
          options={QUALITIES}
          onChange={(q) => {
            setQuality(q);
            saveQuality(q);
          }}
        />
      </Field>
      <Field label="Mouse sensitivity">
        <div className="llm-slider">
          <input
            type="range"
            min={SENS_MIN}
            max={SENS_MAX}
            step={0.05}
            value={sens}
            aria-label="Mouse sensitivity"
            onChange={(e) => {
              setSens(+e.target.value);
              saveSensitivity(+e.target.value);
            }}
            // Left / Right adjust; Up / Down still move between settings.
            onKeyDown={(e) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.stopPropagation()}
          />
          <b>{sens.toFixed(2)}</b>
        </div>
      </Field>
      <Field label="Volume" hint="Shared with every game on the site.">
        <VolumeControl className="llm-volume" />
      </Field>
      <Field label="Bot difficulty" hint={DIFFICULTIES.find((d) => d.id === difficulty)?.blurb}>
        <Choice label="Bot difficulty" value={difficulty} options={DIFFICULTIES} onChange={onDifficulty} />
      </Field>
      <Field label="Player name" hint="What your squad sees over your head.">
        <input
          value={name}
          maxLength={LIMITS.playerNameMax}
          placeholder="Player"
          onChange={(e) => {
            setName(e.target.value);
            if (e.target.value.trim()) saveName(e.target.value.trim());
          }}
        />
      </Field>
    </div>
  );
}

const RULES: { title: string; text: string }[] = [
  { title: 'Waves', text: 'The dead come in waves, each bigger and faster than the last. They break in through the boarded doors and windows.' },
  { title: 'Points', text: 'Every hit earns points, kills and headshots more. Nailing boards back up and reviving teammates pays too.' },
  { title: 'Buying', text: 'Spend points at the stations around the lobby: guns old and new, ammo, grenades and armor. Press E to buy.' },
  { title: 'Barricades', text: 'Hold E at a broken window or door to nail the boards back up. Every board buys you time.' },
  { title: 'Revives', text: 'A downed teammate bleeds out unless someone holds E over them; the fallen come back at the next wave. When nobody is left standing, the night is over.' },
  { title: 'The hotel', text: 'The atrium is always open. A squad of 4 or more (bots count) opens the lounge bar, 7 or more the restaurant.' },
];

function HelpScreen() {
  return (
    <div className="llm-help">
      <div className="llm-label">Controls</div>
      <dl className="llm-controls">
        {META.controls.map((c) => (
          <div key={c.keys}>
            <dt>
              <kbd>{c.keys}</kbd>
            </dt>
            <dd>{c.does}</dd>
          </div>
        ))}
        <div>
          <dt>
            <kbd>Esc</kbd>
          </dt>
          <dd>Pause menu and settings</dd>
        </div>
      </dl>
      <div className="llm-label">Rules of the night</div>
      <ol className="llm-rules">
        {RULES.map((r) => (
          <li key={r.title}>
            <b>{r.title}</b>
            <span>{r.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
