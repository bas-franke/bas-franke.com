import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Game, type Difficulty, type GameState, type LineView, type Mix, type RunConfig, type Settings, type WordView } from './game/Game';
import { sfx } from './game/audio';
import { masteredCount } from './game/progress';
import {
  CHAPTERS,
  chapterScore,
  describe,
  isOpen,
  maxChapterStars,
  maxStars,
  missionById,
  MISSIONS,
  nextMission,
  recordStars,
  requirementMet,
  runFor,
  starsFor,
  totalStars,
  VARIANTS,
  variantOpen,
  type Mission,
  type Variant,
} from './game/campaign';
import { save, update } from './game/save';
import { AccountError, accountState, authenticate, deleteAccount, initAccount, logout, onAccount, type AccountState } from './game/account';
import { CATEGORIES, countIn, ENTRIES, stripHints, type Direction } from './vocab';

const DEFAULTS: Settings = {
  direction: 'en-ro',
  categories: CATEGORIES.map((c) => c.id),
  mix: 'mixed',
  difficulty: 'normal',
  lenient: true,
  shields: true,
};

/** Settings from the save; topics added since they were saved start switched on. */
function loadSettings(): Settings {
  const s = { ...DEFAULTS, knownCategories: [] as string[], ...(save().settings as Partial<Settings> | undefined) };
  const known = new Set(CATEGORIES.map((c) => c.id));
  const seen = new Set(s.knownCategories.length ? s.knownCategories : s.categories);
  const fresh = s.knownCategories.length ? CATEGORIES.map((c) => c.id).filter((id) => !seen.has(id)) : [];
  const categories = [...s.categories.filter((c) => known.has(c)), ...fresh];
  const { knownCategories: _, run: __, ...rest } = s;
  return { ...rest, categories: categories.length ? categories : DEFAULTS.categories };
}

const touchDevice = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

/**
 * Keeps the app exactly inside the visible viewport. On phones the on-screen keyboard shrinks the visual viewport
 * (iOS does not resize the layout viewport), so the game, its HUD and the castle stay above the keyboard.
 */
function useVisualViewport(el: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    const apply = () => {
      const node = el.current;
      if (!node) return;
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      node.style.height = `${Math.round(h)}px`;
      node.style.transform = top ? `translateY(${Math.round(top)}px)` : '';
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
    };
  }, [el]);
}

const bestKeyFor = (s: Settings, run: RunConfig | null) => (run ? `${s.direction}:M:${run.missionId}:${run.variant}` : `${s.direction}:${s.difficulty}`);

export default function App() {
  const app = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const tags = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const processed = useRef(0);
  const [game, setGame] = useState<Game | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [focused, setFocused] = useState(false);
  const [screen, setScreen] = useState<'home' | 'map'>('home');
  /** The mission whose details sheet is open on the map. */
  const [sheet, setSheet] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [, refresh] = useState(0);
  const [accountOpen, setAccountOpen] = useState(false);
  useVisualViewport(app);

  useEffect(() => {
    const g = new Game(stage.current!, tags.current!);
    setGame(g);
    if (import.meta.env.DEV) Object.assign(window, { __ww: g });
    const off = g.subscribe(setState);
    return () => {
      off();
      g.dispose();
    };
  }, []);

  // Accounts: ask the server who we are once; logging in or out swaps the save, so re-read the settings then.
  useEffect(() => {
    void initAccount().then(() => {
      setSettings(loadSettings());
      refresh((n) => n + 1);
    });
  }, []);
  const accountChanged = () => {
    setSettings(loadSettings());
    refresh((n) => n + 1);
  };

  useEffect(() => {
    update((d) => {
      d.settings = { ...settings, knownCategories: CATEGORIES.map((c) => c.id) };
    });
  }, [settings]);

  const phase = state?.phase ?? 'idle';
  const run = state?.run ?? null;
  const bestKey = bestKeyFor(settings, run);
  const best = save().best[bestKey] ?? 0;

  // Record a new best when a round ends (won or lost), and the stars of a won mission.
  useEffect(() => {
    if ((phase !== 'over' && phase !== 'won') || !state) return;
    if ((save().best[bestKey] ?? 0) < state.score) update((d) => void (d.best[bestKey] = state.score));
    if (phase === 'won' && state.run) recordStars(settings.direction, state.run.missionId, state.run.variant as Variant, state.stars);
    refresh((n) => n + 1);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusInput = () => input.current?.focus({ preventScroll: true });

  const play = (r?: RunConfig) => {
    if (!game) return;
    if (!r && !settings.categories.length) return;
    sfx.unlock();
    setSheet(null);
    game.start({ ...settings, run: r });
    focusInput();
  };
  const playMission = (m: Mission, v: Variant) => play(runFor(settings.direction, m, v));
  // Replaying rebuilds the run, so a review mission picks fresh weak words.
  const replay = () => {
    const m = run && missionById(run.missionId);
    if (m) playMission(m, run.variant as Variant);
    else play();
  };
  const next = phase === 'won' ? nextMission(settings.direction) : undefined;
  const toMenu = () => {
    setScreen(run ? 'map' : 'home');
    game?.quit();
  };

  // Escape pauses, Enter starts or continues; leaving the tab or app pauses too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!game) return;
      if (e.key === 'Escape') {
        if (phase === 'playing') game.pause(true);
        else if (phase === 'paused') game.pause(false);
      } else if (e.key === 'Enter') {
        if (phase === 'over') replay();
        else if (phase === 'won') {
          if (next) playMission(next, 'std');
          else toMenu();
        }
        else if (phase === 'idle' && screen === 'home') play();
      }
    };
    const onHide = () => game?.pause(true);
    const onVisibility = () => document.hidden && onHide();
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  useEffect(() => {
    if (phase === 'playing') focusInput();
  }, [phase]);

  // Characters arrive through a hidden input, so dead keys, IMEs and phone keyboards all work. Android keyboards
  // compose whole words, and clearing the field mid-composition confuses them, so new characters are taken from the
  // end of the value and the field is only cleared between compositions.
  const onInput = (e: React.FormEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const value = el.value;
    if (value.length < processed.current) processed.current = value.length;
    const added = value.slice(processed.current);
    processed.current = value.length;
    for (const ch of added) game?.type(ch);
    if (!(e.nativeEvent as InputEvent).isComposing || value.length > 40) {
      el.value = '';
      processed.current = 0;
    }
  };
  const onCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    e.currentTarget.value = '';
    processed.current = 0;
  };

  const playing = phase === 'playing' || phase === 'paused';
  return (
    <div className="app" ref={app} onPointerDown={() => phase === 'playing' && setTimeout(focusInput)}>
      <div className="stage" ref={stage} />
      <div className="hurt" />
      <div className="tags" ref={tags} />
      <input
        ref={input}
        className="catcher"
        onInput={onInput}
        onCompositionEnd={onCompositionEnd}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        inputMode="text"
        aria-label="Type here"
      />
      {state && game && playing && <Hud state={state} game={game} />}
      {phase === 'playing' && !focused && touchDevice() && (
        <button className="tap-to-type" onClick={focusInput}>
          ⌨️ Atinge ca să scrii <small>Tap to type</small>
        </button>
      )}
      {phase === 'idle' && accountOpen && <AccountSheet onClose={() => setAccountOpen(false)} onChanged={accountChanged} />}
      {phase === 'idle' && screen === 'home' && (
        <Home
          onAccount={() => setAccountOpen(true)} settings={settings} setSettings={setSettings} best={save().best[bestKeyFor(settings, null)] ?? 0} onFree={() => play()} onAdventure={() => setScreen('map')} />
      )}
      {phase === 'idle' && screen === 'map' && (
        <CampaignMap onAccount={() => setAccountOpen(true)} settings={settings} setSettings={setSettings} sheet={sheet} setSheet={setSheet} onPlay={playMission} onBack={() => setScreen('home')} />
      )}
      {phase === 'paused' && (
        <div className="overlay">
          <div className="card small">
            <h2>Pauză</h2>
            <p className="dim">Paused</p>
            <div className="row">
              <button className="btn primary" onClick={() => game?.pause(false)}>
                Continuă <small>Resume</small>
              </button>
              <button className="btn" onClick={toMenu}>
                {run ? 'Hartă' : 'Meniu'} <small>{run ? 'Map' : 'Menu'}</small>
              </button>
            </div>
          </div>
        </div>
      )}
      {phase === 'over' && state && <GameOver state={state} settings={settings} best={best} onAgain={replay} onMenu={toMenu} />}
      {phase === 'won' && state && run && (
        <Won state={state} run={run} best={best} next={next} onNext={() => next && playMission(next, 'std')} onAgain={replay} onMap={toMenu} />
      )}
    </div>
  );
}

const HEART = 'M12 21.3l-1.5-1.3C5.4 15.4 2 12.3 2 8.5 2 5.4 4.4 3 7.5 3c1.7 0 3.4.8 4.5 2.1C13.1 3.8 14.8 3 16.5 3 19.6 3 22 5.4 22 8.5c0 3.8-3.4 6.9-8.5 11.5L12 21.3z';

/** A short row of hearts: one per HP up to five, otherwise each heart holds a share (10 HP = 5 hearts of 2, so halves). */
function Hearts({ hp, max }: { hp: number; max: number }) {
  const per = max <= 5 ? 1 : Math.ceil(max / 5);
  const n = Math.max(1, Math.ceil(max / per));
  return (
    <div className={`hearts${hp / max <= 0.2 ? ' low' : ''}`} role="img" aria-label={`HP ${hp}/${max}`} title={`HP ${hp}/${max}`}>
      {Array.from({ length: n }, (_, i) => {
        const fill = Math.max(0, Math.min(1, (hp - i * per) / per));
        return (
          <span key={i} className={`heart${fill <= 0 ? ' empty' : ''}`}>
            <svg viewBox="0 0 24 24" className="heart-bg" aria-hidden="true">
              <path d={HEART} />
            </svg>
            <svg viewBox="0 0 24 24" className="heart-fg" aria-hidden="true" style={{ clipPath: `inset(0 ${((1 - fill) * 100).toFixed(0)}% 0 0)` }}>
              <path d={HEART} />
              <ellipse cx="7.6" cy="7.6" rx="2.6" ry="1.7" transform="rotate(-35 7.6 7.6)" />
            </svg>
          </span>
        );
      })}
    </div>
  );
}

/** A little leafy sprig for the wave plate; the right one is mirrored in CSS. */
function Sprig({ right }: { right?: boolean }) {
  return (
    <svg className={`sprig${right ? ' right' : ''}`} viewBox="0 0 44 26" aria-hidden="true">
      <path d="M43 14C33 14 21 12 5 6" />
      <g>
        <ellipse cx="9" cy="6" rx="5" ry="2.4" transform="rotate(-18 9 6)" />
        <ellipse cx="17" cy="13" rx="5" ry="2.3" transform="rotate(32 17 13)" />
        <ellipse cx="21" cy="5.5" rx="4.6" ry="2.2" transform="rotate(-34 21 5.5)" />
        <ellipse cx="29" cy="17.5" rx="4.4" ry="2.1" transform="rotate(28 29 17.5)" />
        <ellipse cx="32" cy="8.5" rx="4" ry="2" transform="rotate(-30 32 8.5)" />
      </g>
      <circle cx="5" cy="6" r="1.5" className="berry" />
    </svg>
  );
}

function Hud({ state, game }: { state: GameState; game: Game }) {
  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // Tell the game how much of the screen the panels cover, so it keeps the castle in view above the word panel.
  useLayoutEffect(() => {
    const measure = () => game.setInsets(top.current?.offsetHeight ?? 0, bottom.current?.offsetHeight ?? 0);
    measure();
    const ro = new ResizeObserver(measure);
    if (top.current) ro.observe(top.current);
    if (bottom.current) ro.observe(bottom.current);
    return () => {
      ro.disconnect();
      game.setInsets(0, 0);
    };
  }, [game]);
  const t = state.target;
  const accuracy = state.typed ? Math.round(((state.typed - state.errors) / state.typed) * 100) : 100;
  const lvl = state.run;
  // The line being typed goes in the input box; the other language (read, waiting or done) sits small above it.
  const main = t ? (t.lines.find((l) => l.state === 'active') ?? t.lines[t.lines.length - 1]) : undefined;
  const others = t ? t.lines.filter((l) => l !== main) : [];
  return (
    <>
      <div className="hud top" ref={top}>
        <div className="hud-left">
          <Hearts hp={state.hp} max={state.maxHp} />
          <div className="hud-meta">
            {lvl ? `${lvl.emoji} M${lvl.n} · ` : ''}
            <span className="hp-num">
              {state.hp}/{state.maxHp}
            </span>
          </div>
        </div>
        <div className="wave-ribbon" aria-label={`Valul ${state.wave} · Wave ${state.wave}`}>
          <Sprig />
          <span className="wave-plate">
            Valul {state.wave}
            {lvl ? <small>/{lvl.waves}</small> : null}
          </span>
          <Sprig right />
        </div>
        <div className="hud-right">
          <div className="score">
            <div className="score-num">
              {state.multiplier > 1 && <span className="mult">×{state.multiplier}</span>}
              {state.score.toLocaleString()}
            </div>
            <div className="score-sub">
              {accuracy}% · combo {state.combo}
            </div>
          </div>
          <button className="pause" onClick={() => game.pause(true)} aria-label="Pause">
            <span>❚❚</span>
          </button>
        </div>
      </div>
      {state.toast && (
        <div className="toast" key={state.toast.n}>
          <b>{state.toast.ro}</b> <span>{state.toast.en}</span>
        </div>
      )}
      {state.banner && (
        <div className="banner" key={state.banner.n}>
          <div className="banner-text">{state.banner.text}</div>
          <div className="banner-sub">{state.banner.sub}</div>
        </div>
      )}
      <div className="hud bottom" ref={bottom}>
        <div className={`dialog${main?.shield ? ' shield' : ''}`}>
          {t && main ? (
            <>
              <div className="dialog-meta">
                <span className="dialog-name">
                  {t.name[0]} <small>{t.name[1]}</small>
                </span>
                {others.map((line, i) => (
                  <Line key={i} line={line} />
                ))}
              </div>
              <div className="dialog-input">
                <Line line={main} main />
                <span className="enter" aria-hidden="true">
                  ↵
                </span>
              </div>
            </>
          ) : (
            <div className="dialog-input idle">
              <span className="dialog-idle">
                Liniște… <small>All quiet. Get ready!</small>
              </span>
              <span className="caret" aria-hidden="true" />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Line({ line, main }: { line: LineView; main?: boolean }) {
  const icon = line.shield ? '🫧' : line.state === 'info' ? '👀' : line.state === 'done' ? '✓' : '⭐';
  return (
    <div className={`dline ${line.state}${line.shield ? ' shield' : ''}${main ? ' main' : ''}`}>
      <span className="lang">
        <i>{icon}</i> {line.lang.toUpperCase()}
      </span>
      <span className="dwords">
        {line.words.map((w, i) => (
          <Word
            key={i}
            word={w}
            live={line.state === 'active' && i === line.current}
            done={line.state === 'done' || (line.current >= 0 && i < line.current)}
          />
        ))}
      </span>
    </div>
  );
}

function Word({ word, live, done }: { word: WordView; live: boolean; done: boolean }) {
  return (
    <span className={`dw${done ? ' done' : ''}${live ? ' live' : ''}`}>
      {word.glyphs.map((g, i) => (
        <span key={i} className={i < word.pos ? 'g done' : live && i === word.pos ? 'g cur' : 'g'}>
          {live && i === word.pos && <i className="caret" aria-hidden="true" />}
          {word.hidden && i >= word.pos && i > (word.peek ?? -1) && g.typed ? '_' : g.ch}
        </span>
      ))}
      {live && word.pos >= word.glyphs.length && <i className="caret" aria-hidden="true" />}
      {word.hint && <small className="hint">{word.hint}</small>}
    </span>
  );
}

const DIRECTIONS: { id: Direction; label: string; sub: string }[] = [
  { id: 'en-ro', label: 'EN → RO', sub: 'Learn Romanian' },
  { id: 'ro-en', label: 'RO → EN', sub: 'Învață engleză' },
];
const MIXES: { id: Mix; label: string; sub: string }[] = [
  { id: 'words', label: 'Cuvinte', sub: 'Words' },
  { id: 'mixed', label: 'Amestec', sub: 'Mixed' },
  { id: 'sentences', label: 'Propoziții', sub: 'Sentences' },
];
const DIFFICULTIES: { id: Difficulty; label: string; sub: string }[] = [
  { id: 'easy', label: 'Ușor', sub: 'Easy' },
  { id: 'normal', label: 'Normal', sub: 'Normal' },
  { id: 'hard', label: 'Greu', sub: 'Hard' },
];

const BESTIARY: [emoji: string, ro: string, en: string][] = [
  ['🦇', 'Liliac', 'short words'],
  ['🪨', 'Pietroi', 'words'],
  ['👻', 'Fantomiță', 'long words'],
  ['🐲', 'Zmeuț', 'longest words'],
  ['🫧', 'Pietricele', 'sentences'],
  ['🐉', 'Balaurul', 'boss'],
];

type SetSettings = (s: Settings) => void;

/** Direction, difficulty and the two typing toggles: shared by adventure and free play. */
function CommonOptions({ settings, setSettings }: { settings: Settings; setSettings: SetSettings }) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ ...settings, [k]: v });
  return (
    <>
      <div className="field two">
        <div>
          <div className="field-label">Direcție · Direction</div>
          <div className="seg">
            {DIRECTIONS.map((d) => (
              <button key={d.id} className={settings.direction === d.id ? 'on' : ''} onClick={() => set('direction', d.id)}>
                <b>{d.label}</b>
                <small>{d.sub}</small>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="field-label">Dificultate · Difficulty</div>
          <div className="seg">
            {DIFFICULTIES.map((d) => (
              <button key={d.id} className={settings.difficulty === d.id ? 'on' : ''} onClick={() => set('difficulty', d.id)}>
                <b>{d.label}</b>
                <small>{d.sub}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="checks">
        <label className="check">
          <input type="checkbox" checked={settings.shields} onChange={(e) => set('shields', e.target.checked)} />
          <span>
            Scuturi 🫧 <span className="dim">type the word you read first</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.lenient} onChange={(e) => set('lenient', e.target.checked)} />
          <span>
            Diacritice ușoare <span className="dim">a = ă/â, i = î, s = ș, t = ț</span>
          </span>
        </label>
      </div>
    </>
  );
}

function SaveNote() {
  const acc = useAccount();
  return (
    <p className="save-note">
      {acc.user
        ? `☁️ Progresul lui ${acc.user.displayName} se salvează în cont și în cookie-uri · Progress is saved to your account and in cookies.`
        : '🍪 Progresul se salvează în cookie-uri pe acest dispozitiv · Progress is saved in cookies on this device.'}
      {!acc.user && acc.enabled && ' Fă-ți un cont ca să-l ai peste tot · Make an account to take it anywhere.'}
    </p>
  );
}

function useAccount() {
  const [acc, setAcc] = useState<AccountState>(accountState);
  useEffect(() => onAccount(setAcc), []);
  return acc;
}

/** The little "who am I" chip in the corner of the menus. Hidden when the server has no accounts. */
function AccountChip({ onOpen }: { onOpen: () => void }) {
  const acc = useAccount();
  if (!acc.enabled) return null;
  return (
    <button className={`account-chip${acc.user ? ' in' : ''}`} onClick={onOpen}>
      {acc.user ? (
        <>
          👤 {acc.user.displayName}
          <small>{acc.sync === 'error' ? ' ⚠️' : acc.sync === 'pending' ? ' ⏳' : ' ☁️'}</small>
        </>
      ) : (
        <>
          👤 Cont <small>Log in / sign up</small>
        </>
      )}
    </button>
  );
}

function AccountSheet({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const acc = useAccount();
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ text: string; field?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (deleting) await deleteAccount(password);
      else await authenticate(mode, username.trim(), password);
      setPassword('');
      setDeleting(false);
      onChanged();
    } catch (err) {
      setError({ text: err instanceof AccountError ? err.message : 'Serverul nu răspunde · The server did not answer', field: err instanceof AccountError ? err.field : undefined });
    } finally {
      setBusy(false);
    }
  };

  const out = async () => {
    setBusy(true);
    await logout();
    setBusy(false);
    onChanged();
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet account-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Account">
        <button className="sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        {acc.user && !deleting ? (
          <>
            <div className="sheet-head">
              <span className="sheet-emoji">🦉</span>
              <div>
                <div className="chapter-n">Contul tău · Your account</div>
                <h3>{acc.user.displayName}</h3>
              </div>
            </div>
            <p className="sheet-topics">
              {acc.sync === 'error'
                ? '⚠️ Nu am putut salva pe server; reîncercăm la următoarea schimbare · Could not reach the server; we retry on the next change.'
                : '☁️ Progresul tău se salvează pe server: intră de pe orice dispozitiv · Your progress is saved on the server: log in on any device.'}
            </p>
            <div className="row">
              <button className="btn" onClick={out} disabled={busy}>
                Ieși <small>Log out</small>
              </button>
              <button className="btn danger" onClick={() => setDeleting(true)}>
                Șterge contul <small>Delete account</small>
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} className="account-form">
            <div className="sheet-head">
              <span className="sheet-emoji">{deleting ? '🗑️' : '🦉'}</span>
              <div>
                <div className="chapter-n">{deleting ? 'Șterge contul · Delete account' : 'Cont · Account'}</div>
                <h3>{deleting ? 'Ești sigur?' : mode === 'register' ? 'Cont nou' : 'Intră'}</h3>
                <div className="dim">{deleting ? 'This removes your account and its saved progress.' : mode === 'register' ? 'Create an account' : 'Log in'}</div>
              </div>
            </div>
            {!deleting && (
              <>
                <div className="seg small-seg account-tabs">
                  <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>
                    <b>Cont nou</b>
                  </button>
                  <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
                    <b>Am cont</b>
                  </button>
                </div>
                <p className="sheet-topics">
                  {mode === 'register'
                    ? '🎈 Fără email. Alege un nume și o parolă; progresul de pe acest dispozitiv vine cu tine · No email needed. Your progress on this device comes along.'
                    : '🔑 Progresul de pe acest dispozitiv se adaugă la cont · Progress on this device is added to your account.'}
                </p>
                <label className={`input${error?.field === 'username' ? ' bad' : ''}`}>
                  <span>Nume · Username</span>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={20}
                    required
                  />
                </label>
              </>
            )}
            <label className={`input${error?.field === 'password' ? ' bad' : ''}`}>
              <span>Parolă · Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'register' && !deleting ? 'new-password' : 'current-password'}
                minLength={deleting ? 1 : 6}
                required
              />
            </label>
            {error && <p className="form-error">{error.text}</p>}
            <div className="row">
              <button className={`btn ${deleting ? 'danger' : 'primary'}`} type="submit" disabled={busy}>
                {busy ? '…' : deleting ? 'Șterge definitiv · Delete' : mode === 'register' ? 'Creează contul · Sign up' : 'Intră · Log in'}
              </button>
              {deleting && (
                <button className="btn" type="button" onClick={() => setDeleting(false)}>
                  Înapoi <small>Back</small>
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}


function Home({
  settings,
  setSettings,
  best,
  onFree,
  onAdventure,
  onAccount,
}: {
  onAccount: () => void;
  settings: Settings;
  setSettings: SetSettings;
  best: number;
  onFree: () => void;
  onAdventure: () => void;
}) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ ...settings, [k]: v });
  const toggleCat = (id: string) =>
    set('categories', settings.categories.includes(id) ? settings.categories.filter((c) => c !== id) : [...settings.categories, id]);
  const total = useMemo(() => countIn(settings.categories), [settings.categories]);
  const allWords = ENTRIES.length;
  const mastered = masteredCount(settings.direction, CATEGORIES.map((c) => c.id));
  const stars = totalStars(settings.direction);
  const sample = useMemo(() => ENTRIES[(Math.random() * ENTRIES.length) | 0], []);
  const [showFree, setShowFree] = useState(false);
  const readLang = settings.direction === 'en-ro' ? 'English' : 'Romanian';
  return (
    <div className="overlay menu">
      <div className="card">
        <div className="card-top">
          <div className="plaque">
            <Sprig />
            <h1 className="logo">Wordward</h1>
            <Sprig right />
          </div>
          <AccountChip onOpen={onAccount} />
        </div>
        <p className="tagline">
          Apără cetatea cu vorbe! <span className="dim">Defend the castle with words.</span>
        </p>
        <ol className="how">
          <li>
            <b>🫧 Pop the bubble:</b> type the {readLang} word on the creature.
          </li>
          <li>
            <b>⭐ Send it home:</b> type the translation. The closest one is always your target.
          </li>
        </ol>

        <CommonOptions settings={settings} setSettings={setSettings} />

        <div className="modes">
          <button className="mode-card adventure" onClick={onAdventure}>
            <span className="mode-emoji">🗺️</span>
            <span>
              <b>Aventură</b> <small>Adventure</small>
              <span className="mode-sub">
                {MISSIONS.length} misiuni · ⭐ {stars}/{maxStars}
              </span>
            </span>
          </button>
          <button className={`mode-card free${showFree ? ' open' : ''}`} onClick={() => setShowFree(!showFree)}>
            <span className="mode-emoji">♾️</span>
            <span>
              <b>Joc liber</b> <small>Free play</small>
              <span className="mode-sub">{best > 0 ? `Record ${best.toLocaleString()}` : 'Endless waves, your topics'}</span>
            </span>
          </button>
        </div>

        {showFree && (
          <div className="free-panel">
            <div className="field">
              <div className="field-label">Mod · Mode</div>
              <div className="seg">
                {MIXES.map((m) => (
                  <button key={m.id} className={settings.mix === m.id ? 'on' : ''} onClick={() => set('mix', m.id)}>
                    <b>{m.label}</b>
                    <small>{m.sub}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <div className="field-label">
                Teme · Topics{' '}
                <span className="dim">
                  ({settings.categories.length}/{CATEGORIES.length}, {total.toLocaleString()} entries)
                </span>
              </div>
              <div className="topic-actions">
                <button className="link" onClick={() => set('categories', CATEGORIES.map((c) => c.id))}>
                  all
                </button>
                <button className="link" onClick={() => set('categories', [])}>
                  none
                </button>
              </div>
              <div className="chips">
                {CATEGORIES.map((c) => (
                  <button key={c.id} className={settings.categories.includes(c.id) ? 'chip on' : 'chip'} onClick={() => toggleCat(c.id)}>
                    {c.ro} <small>{c.en}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="start-row">
              <button className="btn primary big" disabled={!settings.categories.length} onClick={onFree}>
                Start!
              </button>
            </div>
          </div>
        )}

        <div className="progress-row">
          <div>
            Stăpânite · Mastered: <b>{mastered.toLocaleString()}</b> / {allWords.toLocaleString()}
          </div>
          <div className="sample">
            {stripHints(sample.en)} = <b>{stripHints(sample.ro)}</b>
          </div>
        </div>

        <div className="bestiary">
          {BESTIARY.map(([emoji, ro, en]) => (
            <span key={ro}>
              <i>{emoji}</i> <b>{ro}</b> {en}
            </span>
          ))}
        </div>
        <SaveNote />
      </div>
    </div>
  );
}

function Stars({ n, of = 3 }: { n: number; of?: number }) {
  return (
    <span className="stars" aria-label={`${n} of ${of} stars`}>
      {Array.from({ length: of }, (_, i) => (
        <span key={i} className={i < n ? 'star on' : 'star'}>
          ★
        </span>
      ))}
    </span>
  );
}

/** Horizontal position (percent) of the n-th node on a chapter's winding path. */
const PATH_X = [50, 78, 50, 22];
const ROW = 112;

function CampaignMap({
  settings,
  setSettings,
  sheet,
  setSheet,
  onPlay,
  onBack,
  onAccount,
}: {
  onAccount: () => void;
  settings: Settings;
  setSettings: SetSettings;
  sheet: string | null;
  setSheet: (id: string | null) => void;
  onPlay: (m: Mission, v: Variant) => void;
  onBack: () => void;
}) {
  const dir = settings.direction;
  const current = nextMission(dir);
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, []);
  const open = sheet ? missionById(sheet) : undefined;
  return (
    <div className="overlay menu">
      <div className="card map-card">
        <div className="map-head">
          <button className="btn back" onClick={onBack} aria-label="Back">
            ←
          </button>
          <div>
            <h2>Aventură</h2>
            <p className="dim">
              Adventure · ⭐ {totalStars(dir)}/{maxStars}
            </p>
          </div>
          <div className="seg small-seg">
            {DIRECTIONS.map((d) => (
              <button key={d.id} className={dir === d.id ? 'on' : ''} onClick={() => setSettings({ ...settings, direction: d.id })}>
                <b>{d.label}</b>
              </button>
            ))}
          </div>
          <AccountChip onOpen={onAccount} />
        </div>
        {CHAPTERS.map((ch) => {
          const score = chapterScore(dir, ch);
          const reachable = isOpen(dir, ch.missions[0]);
          const rows = ch.missions.length;
          const points = ch.missions.map((_, i) => `${PATH_X[i % 4]},${i * ROW + 46}`).join(' ');
          return (
            <section key={ch.n} className={`chapter${reachable ? '' : ' far'}`}>
              <div className="chapter-head">
                <span className="chapter-emoji">{ch.emoji}</span>
                <div>
                  <div className="chapter-n">Capitolul {ch.n} · Chapter {ch.n}</div>
                  <b>{ch.ro}</b> <span className="dim">{ch.en}</span>
                </div>
                <span className="chapter-stars">
                  ⭐ {score.stars}/{maxChapterStars(ch)}
                </span>
              </div>
              <div className="path" style={{ height: rows * ROW }}>
                <svg className="trail" viewBox={`0 0 100 ${rows * ROW}`} preserveAspectRatio="none" aria-hidden="true">
                  <polyline points={points} />
                </svg>
                {ch.missions.map((m, i) => {
                  const unlocked = isOpen(dir, m);
                  const stars = starsFor(dir, m.id);
                  const variantsWon = m.variants.filter((v) => v !== 'std' && starsFor(dir, m.id, v) > 0).length;
                  return (
                    <div key={m.id} className="node-wrap" style={{ left: `${PATH_X[i % 4]}%`, top: i * ROW }}>
                      <button
                        ref={m === current ? currentRef : undefined}
                        className={`node ${m.kind}${unlocked ? '' : ' locked'}${stars ? ' cleared' : ''}${m === current ? ' current' : ''}`}
                        onClick={() => setSheet(m.id)}
                        aria-label={`${m.ro}: ${unlocked ? `${stars} stars` : 'locked'}`}
                      >
                        <span className="node-emoji">{unlocked ? m.emoji : '🔒'}</span>
                        <span className="node-n">{m.n}</span>
                        {m.variants.length > 1 && (
                          <span className="node-variants">
                            {m.variants
                              .filter((v) => v !== 'std')
                              .map((v) => (
                                <i key={v} className={starsFor(dir, m.id, v) ? 'won' : ''}>
                                  {VARIANTS[v].emoji}
                                </i>
                              ))}
                          </span>
                        )}
                      </button>
                      <span className="node-label">
                        {m.ro}
                        {stars > 0 && <Stars n={stars} />}
                        {stars > 0 && variantsWon < m.variants.length - 1 && <small className="node-more">+{m.variants.length - 1 - variantsWon} variante</small>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
        <SaveNote />
      </div>
      {open && <MissionSheet mission={open} dir={dir} onPlay={onPlay} onGo={setSheet} onClose={() => setSheet(null)} />}
    </div>
  );
}

function MissionSheet({
  mission,
  dir,
  onPlay,
  onGo,
  onClose,
}: {
  mission: Mission;
  dir: Direction;
  onPlay: (m: Mission, v: Variant) => void;
  onGo: (id: string) => void;
  onClose: () => void;
}) {
  const unlocked = isOpen(dir, mission);
  const prev = MISSIONS[mission.n - 2];
  const topics = mission.categories.length
    ? mission.categories.map((id) => CATEGORIES.find((c) => c.id === id)?.ro ?? id).join(', ')
    : 'toate temele · every topic';
  const chapter = CHAPTERS[mission.chapter - 1];
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={mission.ro}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <div className="sheet-head">
          <span className="sheet-emoji">{mission.emoji}</span>
          <div>
            <div className="chapter-n">
              Misiunea {mission.n} · {chapter.emoji} {chapter.ro}
              {mission.kind === 'review' ? ' · recapitulare' : mission.kind === 'boss' ? ' · boss' : ''}
            </div>
            <h3>{mission.ro}</h3>
            <div className="dim">{mission.en}</div>
          </div>
        </div>
        <p className="sheet-topics">
          {mission.kind === 'review'
            ? '🔁 Cuvintele pe care încă nu le știi din capitol · the words of this chapter you have not mastered yet'
            : `📚 ${topics} · ${mission.waves} valuri${mission.kind === 'boss' ? ', balaur în fiecare val' : ''}`}
        </p>
        {!unlocked && (
          <div className="reqs">
            <div className="field-label">🔒 Încuiat · Locked: ai nevoie de · you need</div>
            {prev && (
              <Req ok={starsFor(dir, prev.id) > 0} text={`⭐ ${prev.ro} · ${VARIANTS.std.ro}`} onGo={() => onGo(prev.id)} />
            )}
            {mission.requires.map((r, i) => {
              const d = describe(dir, mission, r);
              return <Req key={i} ok={requirementMet(dir, mission, r)} text={d.text} progress={d.progress} onGo={d.goto ? () => onGo(d.goto!) : undefined} />;
            })}
          </div>
        )}
        <div className="variants">
          {mission.variants.map((v) => {
            const info = VARIANTS[v];
            const can = variantOpen(dir, mission, v);
            const stars = starsFor(dir, mission.id, v);
            return (
              <div key={v} className={`variant${can ? '' : ' locked'}`}>
                <span className="variant-emoji">{info.emoji}</span>
                <div className="variant-text">
                  <b>{info.ro}</b> <span className="dim">{info.en}</span>
                  <div className="variant-desc">{can || v === 'std' ? info.desc : 'Câștigă întâi varianta normală · Win the standard run first.'}</div>
                </div>
                <Stars n={stars} />
                <button className="btn primary play" disabled={!can} onClick={() => onPlay(mission, v)}>
                  {stars ? 'Din nou' : 'Joacă'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Req({ ok, text, progress, onGo }: { ok: boolean; text: string; progress?: string; onGo?: () => void }) {
  return (
    <div className={`req${ok ? ' ok' : ''}`}>
      <span className="req-mark">{ok ? '✓' : '✗'}</span>
      <span className="req-text">{text}</span>
      {progress && <span className="req-progress">{progress}</span>}
      {!ok && onGo && (
        <button className="link" onClick={onGo}>
          mergi →
        </button>
      )}
    </div>
  );
}

function Won({
  state,
  run,
  best,
  next,
  onNext,
  onAgain,
  onMap,
}: {
  state: GameState;
  run: RunConfig;
  best: number;
  next?: Mission;
  onNext: () => void;
  onAgain: () => void;
  onMap: () => void;
}) {
  const accuracy = state.typed ? Math.round(((state.typed - state.errors) / state.typed) * 100) : 100;
  const variant = VARIANTS[run.variant as Variant];
  return (
    <div className="overlay">
      <div className="card won">
        <div className="won-emoji">{run.emoji}</div>
        <h2>Misiune completă!</h2>
        <p className="dim">
          {run.ro} · {run.en} · {variant.emoji} {variant.ro}
        </p>
        <div className="won-stars">
          <Stars n={state.stars} />
        </div>
        <div className="stats">
          <div>
            <b>{state.score.toLocaleString()}</b>
            <span>{state.score >= best ? 'Record nou! · New best' : 'Scor · Score'}</span>
          </div>
          <div>
            <b>
              {state.hp}/{state.maxHp}
            </b>
            <span>HP</span>
          </div>
          <div>
            <b>{state.destroyed}</b>
            <span>Trimiși acasă · Sent home</span>
          </div>
          <div>
            <b>{accuracy}%</b>
            <span>Precizie · Accuracy</span>
          </div>
        </div>
        {state.stars < 3 && <p className="hint-line">⭐⭐⭐ = 80%+ HP left and 90%+ accuracy</p>}
        <div className="row">
          {next && (
            <button className="btn primary" onClick={onNext}>
              {next.emoji} {next.ro} <small>Next · Enter</small>
            </button>
          )}
          <button className="btn" onClick={onAgain}>
            Din nou <small>Replay</small>
          </button>
          <button className="btn" onClick={onMap}>
            Hartă <small>Map</small>
          </button>
        </div>
      </div>
    </div>
  );
}

function GameOver({
  state,
  settings,
  best,
  onAgain,
  onMenu,
}: {
  state: GameState;
  settings: Settings;
  best: number;
  onAgain: () => void;
  onMenu: () => void;
}) {
  const accuracy = state.typed ? Math.round(((state.typed - state.errors) / state.typed) * 100) : 100;
  const isBest = state.score > 0 && state.score >= best;
  const [src, dst] = settings.direction === 'en-ro' ? (['en', 'ro'] as const) : (['ro', 'en'] as const);
  return (
    <div className="overlay">
      <div className="card">
        <h2 className="over-title">Cetatea a obosit!</h2>
        <p className="dim">
          {state.failReason ? `${state.failReason}. ` : ''}
          {state.run ? `${state.run.emoji} ${state.run.ro} · ${state.run.en}. ` : ''}The castle needs a nap. Great effort, try again!
        </p>
        <div className="stats">
          <div>
            <b>{state.score.toLocaleString()}</b>
            <span>{isBest ? 'Record nou! · New best' : 'Scor · Score'}</span>
          </div>
          <div>
            <b>{state.wave}</b>
            <span>Valul · Wave</span>
          </div>
          <div>
            <b>{state.destroyed}</b>
            <span>Trimiși acasă · Sent home</span>
          </div>
          <div>
            <b>{accuracy}%</b>
            <span>Precizie · Accuracy</span>
          </div>
        </div>
        {state.missed.length > 0 && (
          <div className="practice">
            <div className="field-label">De exersat · Words to practise</div>
            <ul>
              {state.missed.slice(0, 12).map((m) => (
                <li key={m.entry.id}>
                  <span>{m.entry[src]}</span>
                  <b>{m.entry[dst]}</b>
                  <small>×{m.count}</small>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="row">
          <button className="btn primary" onClick={onAgain}>
            Din nou! <small>Play again · Enter</small>
          </button>
          <button className="btn" onClick={onMenu}>
            {state.run ? 'Hartă' : 'Meniu'} <small>{state.run ? 'Map' : 'Menu'}</small>
          </button>
        </div>
      </div>
    </div>
  );
}
