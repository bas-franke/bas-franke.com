import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Game, type Difficulty, type GameState, type LineView, type Mix, type RunConfig, type Settings as GameSettings, type WordView } from './game/Game';
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
import { chapterIcon, Icon, IconText, MissionEmblem, VARIANT_ICON, type IconName } from './icons';

/** The game's settings plus the app's own: sound effects and the ambient library bed (both saved with the rest). */
type Settings = GameSettings & { sound: boolean; ambient: boolean };

const DEFAULTS: Settings = {
  direction: 'en-ro',
  categories: CATEGORIES.map((c) => c.id),
  mix: 'mixed',
  difficulty: 'normal',
  lenient: true,
  shields: true,
  sound: true,
  ambient: true,
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
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
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

  // Sound: mute and ambience follow the settings; browsers only start audio after a user gesture, so the ambience
  // is (re)applied on the first pointer or key press too (play() unlocks the context as well).
  useEffect(() => {
    sfx.muted = !settings.sound;
    sfx.ambient(settings.sound && settings.ambient);
  }, [settings.sound, settings.ambient]);
  useEffect(() => {
    const first = () => {
      window.removeEventListener('pointerdown', first, true);
      window.removeEventListener('keydown', first, true);
      if (!settingsRef.current.sound) return;
      sfx.unlock();
      sfx.ambient(settingsRef.current.ambient);
    };
    window.addEventListener('pointerdown', first, true);
    window.addEventListener('keydown', first, true);
    return () => {
      window.removeEventListener('pointerdown', first, true);
      window.removeEventListener('keydown', first, true);
    };
  }, []);
  const toggleSound = () => setSettings({ ...settings, sound: !settings.sound });

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
      {state && game && playing && <Hud state={state} game={game} sound={settings.sound} onSound={toggleSound} />}
      {phase === 'playing' && !focused && touchDevice() && (
        <button className="tap-to-type" onClick={focusInput}>
          <Icon name="keyboard" /> Tap to type
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
            <h2>Paused</h2>
            <p className="dim">Take a breath. The creatures will wait.</p>
            <div className="row">
              <button className="btn primary" onClick={() => game?.pause(false)}>
                Resume <small>Esc</small>
              </button>
              <button className="btn" onClick={toMenu}>
                {run ? 'Map' : 'Menu'}
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

function Hud({ state, game, sound, onSound }: { state: GameState; game: Game; sound: boolean; onSound: () => void }) {
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
            {lvl ? (
              <>
                <MissionEmblem mission={{ id: lvl.missionId, kind: 'mission', n: lvl.n }} /> M{lvl.n} ·{' '}
              </>
            ) : null}
            <span className="hp-num">
              {state.hp}/{state.maxHp}
            </span>
          </div>
        </div>
        <div className="wave-ribbon" aria-label={`Wave ${state.wave}`}>
          <Sprig />
          <span className="wave-plate">
            Wave {state.wave}
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
          <button className="pause sound" onClick={onSound} aria-label={sound ? 'Sound on: mute' : 'Sound off: unmute'} aria-pressed={sound} title={sound ? 'Mute' : 'Unmute'}>
            <span>
              <Icon name={sound ? 'speaker' : 'speakerOff'} />
            </span>
          </button>
          <button className="pause" onClick={() => game.pause(true)} aria-label="Pause">
            <span>
              <Icon name="pause" />
            </span>
          </button>
        </div>
      </div>
      {state.toast && (
        <div className="toast" key={state.toast.n}>
          <b>{state.toast.ro}</b> {state.toast.en && <span>{state.toast.en}</span>}
        </div>
      )}
      {state.banner && (
        <div className="banner" key={state.banner.n}>
          <div className="banner-text">
            {/* The boss banner has no emoji of its own: give it the Bookwyrm, like a mission intro gets its emblem. */}
            {state.banner.text === 'The Bookwyrm!' && (
              <>
                <Icon name="dragon" />{' '}
              </>
            )}
            <IconText text={state.banner.text} />
          </div>
          <div className="banner-sub">
            <IconText text={state.banner.sub} />
          </div>
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
                  <Icon name="enter" />
                </span>
              </div>
            </>
          ) : (
            <div className="dialog-input idle">
              <span className="dialog-idle">
                All quiet… <small>Get ready!</small>
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
  const icon: IconName = line.shield ? 'shield' : line.state === 'info' ? 'eye' : line.state === 'done' ? 'check' : 'star';
  return (
    <div className={`dline ${line.state}${line.shield ? ' shield' : ''}${main ? ' main' : ''}`}>
      <span className="lang">
        <Icon name={icon} className="lang-icon" /> {line.lang.toUpperCase()}
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
      {word.glyphs.map((g, i) => {
        const hid = word.hidden && i >= word.pos && i > (word.peek ?? -1) && g.typed;
        return (
          <span key={i} className={`${i < word.pos ? 'g done' : live && i === word.pos ? 'g cur' : 'g'}${hid ? ' hid' : ''}`}>
            {live && i === word.pos && <i className="caret" aria-hidden="true" />}
            {hid ? '_' : g.ch}
          </span>
        );
      })}
      {live && word.pos >= word.glyphs.length && <i className="caret" aria-hidden="true" />}
      {word.hint && <small className="hint">{word.hint}</small>}
    </span>
  );
}

const DIRECTIONS: { id: Direction; label: string; sub: string }[] = [
  { id: 'en-ro', label: 'EN → RO', sub: 'Learn Romanian' },
  { id: 'ro-en', label: 'RO → EN', sub: 'Learn English' },
];
const MIXES: { id: Mix; label: string; sub: string }[] = [
  { id: 'words', label: 'Words', sub: 'one at a time' },
  { id: 'mixed', label: 'Mixed', sub: 'words & sentences' },
  { id: 'sentences', label: 'Sentences', sub: 'whole lines' },
];
const DIFFICULTIES: { id: Difficulty; label: string; sub: string }[] = [
  { id: 'easy', label: 'Easy', sub: 'slow & gentle' },
  { id: 'normal', label: 'Normal', sub: 'just right' },
  { id: 'hard', label: 'Hard', sub: 'quick fingers' },
];

const BESTIARY: [icon: IconName, name: string, what: string][] = [
  ['moth', 'Glimmerwing', 'short words'],
  ['soot', 'Sootling', 'words'],
  ['snail', 'Scrollshell', 'long words'],
  ['tome', 'Tome Toter', 'longest words'],
  ['ink', 'Inklings', 'sentences'],
  ['dragon', 'Bookwyrm', 'boss'],
];

type SetSettings = (s: Settings) => void;

/** Direction, difficulty and the two typing toggles: shared by adventure and free play. */
function CommonOptions({ settings, setSettings }: { settings: Settings; setSettings: SetSettings }) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ ...settings, [k]: v });
  return (
    <>
      <div className="field two">
        <div>
          <div className="field-label">Direction</div>
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
          <div className="field-label">Difficulty</div>
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
            Shields <Icon name="shield" className="gold" /> <span className="dim">type the word you read first</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.lenient} onChange={(e) => set('lenient', e.target.checked)} />
          <span>
            Easy accents <span className="dim">a = ă/â, i = î, s = ș, t = ț</span>
          </span>
        </label>
      </div>
    </>
  );
}

/** Two round brass toggles: sound effects and the quiet library ambience. */
function SoundToggles({ settings, setSettings }: { settings: Settings; setSettings: SetSettings }) {
  const { sound, ambient } = settings;
  return (
    <div className="sound-toggles">
      <button
        className={`round-toggle${sound ? ' on' : ''}`}
        onClick={() => setSettings({ ...settings, sound: !sound })}
        aria-pressed={sound}
        aria-label="Sound"
        title={sound ? 'Sound on' : 'Sound off'}
      >
        <Icon name={sound ? 'speaker' : 'speakerOff'} />
      </button>
      <button
        className={`round-toggle${sound && ambient ? ' on' : ''}`}
        onClick={() => setSettings({ ...settings, ambient: !ambient, sound: !ambient ? true : sound })}
        aria-pressed={sound && ambient}
        aria-label="Library ambience"
        title={sound && ambient ? 'Ambience on' : 'Ambience off'}
      >
        <Icon name={sound && ambient ? 'music' : 'musicOff'} />
      </button>
    </div>
  );
}

function SaveNote() {
  const acc = useAccount();
  return (
    <p className="save-note">
      {acc.user ? (
        <>
          <Icon name="cloud" /> {acc.user.displayName}'s progress is saved to the account and in cookies.
        </>
      ) : (
        <>
          <Icon name="cookie" /> Progress is saved in cookies on this device.
        </>
      )}
      {!acc.user && acc.enabled && ' Make an account to take it anywhere.'}
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
          <Icon name="user" /> {acc.user.displayName}
          <small className="sync">
            {acc.sync === 'error' ? (
              <Icon name="alert" label="Not synced" />
            ) : acc.sync === 'pending' ? (
              <Icon name="hourglass" label="Saving" />
            ) : (
              <Icon name="cloud" label="Saved" />
            )}
          </small>
        </>
      ) : (
        <>
          <span>
            <Icon name="user" /> Account
          </span>
          <small>Log in / sign up</small>
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
      setError({ text: err instanceof AccountError ? err.message : 'The server did not answer', field: err instanceof AccountError ? err.field : undefined });
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
          <Icon name="close" />
        </button>
        {acc.user && !deleting ? (
          <>
            <div className="sheet-head">
              <span className="sheet-emoji">
                <Icon name="owl" />
              </span>
              <div>
                <div className="chapter-n">Your account</div>
                <h3>{acc.user.displayName}</h3>
              </div>
            </div>
            <p className="sheet-topics">
              {acc.sync === 'error' ? (
                <>
                  <Icon name="alert" /> Could not reach the server; we retry on the next change.
                </>
              ) : (
                <>
                  <Icon name="cloud" /> Your progress is saved on the server: log in on any device.
                </>
              )}
            </p>
            <div className="row">
              <button className="btn" onClick={out} disabled={busy}>
                Log out
              </button>
              <button className="btn danger" onClick={() => setDeleting(true)}>
                Delete account
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} className="account-form">
            <div className="sheet-head">
              <span className="sheet-emoji">
                <Icon name={deleting ? 'trash' : 'owl'} />
              </span>
              <div>
                <div className="chapter-n">{deleting ? 'Delete account' : 'Account'}</div>
                <h3>{deleting ? 'Are you sure?' : mode === 'register' ? 'New account' : 'Log in'}</h3>
                <div className="dim">{deleting ? 'This removes your account and its saved progress.' : mode === 'register' ? 'Pick a name and a password' : 'Welcome back!'}</div>
              </div>
            </div>
            {!deleting && (
              <>
                <div className="seg small-seg account-tabs">
                  <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>
                    <b>New account</b>
                  </button>
                  <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
                    <b>I have one</b>
                  </button>
                </div>
                <p className="sheet-topics">
                  {mode === 'register' ? (
                    <>
                      <Icon name="sparkle" /> No email needed. Pick a name and a password; your progress on this device comes along.
                    </>
                  ) : (
                    <>
                      <Icon name="key" /> Progress on this device is added to your account.
                    </>
                  )}
                </p>
                <label className={`input${error?.field === 'username' ? ' bad' : ''}`}>
                  <span>Username</span>
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
              <span>Password</span>
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
                {busy ? '…' : deleting ? 'Delete forever' : mode === 'register' ? 'Sign up' : 'Log in'}
              </button>
              {deleting && (
                <button className="btn" type="button" onClick={() => setDeleting(false)}>
                  Back
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
          <div className="top-actions">
            <SoundToggles settings={settings} setSettings={setSettings} />
            <AccountChip onOpen={onAccount} />
          </div>
        </div>
        <p className="tagline">
          Defend the library with words! <span className="dim">Learn Romanian and English as you type.</span>
        </p>
        <ol className="how">
          <li>
            <b>
              <Icon name="shield" className="gold" /> Pop the bubble:
            </b> type the {readLang} word on the creature.
          </li>
          <li>
            <b>
              <Icon name="star" className="gold" /> Send it home:
            </b> type the translation. The closest one is always your target.
          </li>
        </ol>

        <CommonOptions settings={settings} setSettings={setSettings} />

        <div className="modes">
          <button className="mode-card adventure" onClick={onAdventure}>
            <span className="mode-emoji">
              <Icon name="map" />
            </span>
            <span>
              <b>Adventure</b> <small>Campaign</small>
              <span className="mode-sub">
                {MISSIONS.length} missions · <Icon name="star" className="gold" /> {stars}/{maxStars}
              </span>
            </span>
          </button>
          <button className={`mode-card free${showFree ? ' open' : ''}`} onClick={() => setShowFree(!showFree)}>
            <span className="mode-emoji">
              <Icon name="infinity" />
            </span>
            <span>
              <b>Free play</b> <small>Your rules</small>
              <span className="mode-sub">{best > 0 ? `Best ${best.toLocaleString()}` : 'Endless waves, your topics'}</span>
            </span>
          </button>
        </div>

        {showFree && (
          <div className="free-panel">
            <div className="field">
              <div className="field-label">Mode</div>
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
                Topics{' '}
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
                    {c.en}
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
            Mastered: <b>{mastered.toLocaleString()}</b> / {allWords.toLocaleString()}
          </div>
          <div className="sample">
            {stripHints(sample.en)} = <b>{stripHints(sample.ro)}</b>
          </div>
        </div>

        <div className="bestiary">
          {BESTIARY.map(([icon, name, what]) => (
            <span key={name}>
              <Icon name={icon} /> <b>{name}</b> {what}
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
        <Icon key={i} name="star" className={i < n ? 'star on' : 'star'} />
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
            <Icon name="back" />
          </button>
          <div>
            <h2>Adventure</h2>
            <p className="dim">
              <Icon name="star" className="gold" /> {totalStars(dir)}/{maxStars} stars
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
                <span className="chapter-emoji">
                  <Icon name={chapterIcon(ch.n)} />
                </span>
                <div>
                  <div className="chapter-n">Chapter {ch.n}</div>
                  <b>{ch.en}</b>
                </div>
                <span className="chapter-stars">
                  <Icon name="star" className="gold" /> {score.stars}/{maxChapterStars(ch)}
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
                        aria-label={`${m.en}: ${unlocked ? `${stars} stars` : 'locked'}`}
                      >
                        <span className="node-emoji">{unlocked ? <MissionEmblem mission={m} /> : <Icon name="lock" className="brass" />}</span>
                        <span className="node-n">{m.n}</span>
                        {m.variants.length > 1 && (
                          <span className="node-variants">
                            {m.variants
                              .filter((v) => v !== 'std')
                              .map((v) => (
                                <Icon
                                  key={v}
                                  name={VARIANT_ICON[v]}
                                  className={starsFor(dir, m.id, v) ? 'won' : ''}
                                  label={`${VARIANTS[v].en}${starsFor(dir, m.id, v) ? ' (won)' : ''}`}
                                />
                              ))}
                          </span>
                        )}
                      </button>
                      <span className="node-label">
                        {m.en}
                        {stars > 0 && <Stars n={stars} />}
                        {stars > 0 && variantsWon < m.variants.length - 1 && (
                          <small className="node-more">
                            +{m.variants.length - 1 - variantsWon} {m.variants.length - 1 - variantsWon === 1 ? 'variant' : 'variants'}
                          </small>
                        )}
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
    ? mission.categories.map((id) => CATEGORIES.find((c) => c.id === id)?.en ?? id).join(', ')
    : 'every topic';
  const chapter = CHAPTERS[mission.chapter - 1];
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={mission.en}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
        <div className="sheet-head">
          <span className={`sheet-emoji ${mission.kind}`}>
            <MissionEmblem mission={mission} />
          </span>
          <div>
            <div className="chapter-n">
              Mission {mission.n} · <Icon name={chapterIcon(chapter.n)} /> {chapter.en}
              {mission.kind === 'review' ? ' · review' : mission.kind === 'boss' ? ' · boss' : ''}
            </div>
            <h3>{mission.en}</h3>
          </div>
        </div>
        <p className="sheet-topics">
          {mission.kind === 'review' ? (
            <>
              <Icon name="review" /> The words of this chapter you have not mastered yet
            </>
          ) : (
            <>
              <Icon name="book" /> {`${topics} · ${mission.waves} waves${mission.kind === 'boss' ? ', the Bookwyrm in every wave' : ''}`}
            </>
          )}
        </p>
        {!unlocked && (
          <div className="reqs">
            <div className="field-label">
              <Icon name="lock" className="brass" /> Locked: you need
            </div>
            {prev && (
              <Req ok={starsFor(dir, prev.id) > 0} text={`⭐ ${prev.en} · ${VARIANTS.std.en}`} onGo={() => onGo(prev.id)} />
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
                <span className="variant-emoji">
                  <Icon name={VARIANT_ICON[v]} />
                </span>
                <div className="variant-text">
                  <b>{info.en}</b>
                  <div className="variant-desc">{can || v === 'std' ? info.desc : 'Win the standard run first.'}</div>
                </div>
                <Stars n={stars} />
                <button className="btn primary play" disabled={!can} onClick={() => onPlay(mission, v)}>
                  {stars ? 'Replay' : 'Play'}
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
      <span className="req-mark">
        <Icon name={ok ? 'check' : 'close'} label={ok ? 'done' : 'not yet'} />
      </span>
      <span className="req-text">
        <IconText text={text} />
      </span>
      {progress && <span className="req-progress">{progress}</span>}
      {!ok && onGo && (
        <button className="link" onClick={onGo}>
          go <Icon name="next" />
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
        <div className="won-emoji">
          <MissionEmblem mission={{ id: run.missionId, kind: 'mission', n: run.n }} />
        </div>
        <h2>Mission complete!</h2>
        <p className="dim">
          {run.en} · <Icon name={VARIANT_ICON[run.variant as Variant]} /> {variant.en}
        </p>
        <div className="won-stars">
          <Stars n={state.stars} />
        </div>
        <div className="stats">
          <div>
            <b>{state.score.toLocaleString()}</b>
            <span>{state.score >= best ? 'New best!' : 'Score'}</span>
          </div>
          <div>
            <b>
              {state.hp}/{state.maxHp}
            </b>
            <span>HP</span>
          </div>
          <div>
            <b>{state.destroyed}</b>
            <span>Sent home</span>
          </div>
          <div>
            <b>{accuracy}%</b>
            <span>Accuracy</span>
          </div>
        </div>
        {state.stars < 3 && <p className="hint-line">
            <Stars n={3} /> = 80%+ HP left and 90%+ accuracy
          </p>}
        <div className="row">
          {next ? (
            <button className="btn primary" onClick={onNext}>
              <MissionEmblem mission={next} /> {next.en} <small>Next · Enter</small>
            </button>
          ) : (
            // With nothing left to unlock, Enter goes to the map: it is the main button then.
            <button className="btn primary" onClick={onMap}>
              Map <small>Enter</small>
            </button>
          )}
          <button className="btn" onClick={onAgain}>
            Replay
          </button>
          {next && (
            <button className="btn" onClick={onMap}>
              Map
            </button>
          )}
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
      <div className="card over">
        <div className="won-emoji over-emoji">
          {state.run ? <MissionEmblem mission={{ id: state.run.missionId, kind: 'mission', n: state.run.n }} /> : <Icon name="owl" />}
        </div>
        <h2 className="over-title">The library needs a nap!</h2>
        {state.failReason && (
          <p className="fail-reason">
            <Icon name="perfect" /> <IconText text={state.failReason} />
          </p>
        )}
        <p className="dim">
          {state.run ? (
            <>
              {state.run.en} · <Icon name={VARIANT_ICON[state.run.variant as Variant]} /> {VARIANTS[state.run.variant as Variant].en}.{' '}
            </>
          ) : (
            ''
          )}
          Great effort, try again!
        </p>
        <div className="stats">
          <div>
            <b>{state.score.toLocaleString()}</b>
            <span>{isBest ? 'New best!' : 'Score'}</span>
          </div>
          <div>
            <b>{state.wave}</b>
            <span>Wave</span>
          </div>
          <div>
            <b>{state.destroyed}</b>
            <span>Sent home</span>
          </div>
          <div>
            <b>{accuracy}%</b>
            <span>Accuracy</span>
          </div>
        </div>
        {state.missed.length > 0 && (
          <div className="practice">
            <div className="field-label">Words to practise</div>
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
            Play again <small>Enter</small>
          </button>
          <button className="btn" onClick={onMenu}>
            {state.run ? 'Map' : 'Menu'}
          </button>
        </div>
      </div>
    </div>
  );
}
