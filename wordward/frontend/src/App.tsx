import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Game, type Difficulty, type GameState, type LineView, type Mix, type Settings, type WordView } from './game/Game';
import { sfx } from './game/audio';
import { masteredCount } from './game/progress';
import { CATEGORIES, countIn, ENTRIES, stripHints, type Direction } from './vocab';

const SETTINGS_KEY = 'wordward:settings';
const BEST_KEY = 'wordward:best';

const DEFAULTS: Settings = {
  direction: 'en-ro',
  categories: CATEGORIES.map((c) => c.id),
  mix: 'mixed',
  difficulty: 'normal',
  lenient: true,
  shields: true,
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage full: settings just are not remembered.
  }
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

export default function App() {
  const app = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const tags = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const processed = useRef(0);
  const [game, setGame] = useState<Game | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [focused, setFocused] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => {
    const s = load(SETTINGS_KEY, { ...DEFAULTS, knownCategories: [] as string[] });
    const known = new Set(CATEGORIES.map((c) => c.id));
    // Topics added since the settings were saved start switched on.
    const seen = new Set(s.knownCategories.length ? s.knownCategories : s.categories);
    const fresh = CATEGORIES.map((c) => c.id).filter((id) => !seen.has(id) && s.knownCategories.length + s.categories.length > 0);
    const categories = [...s.categories.filter((c) => known.has(c)), ...fresh];
    return { ...s, categories: categories.length ? categories : DEFAULTS.categories };
  });
  const [best, setBest] = useState<Record<string, number>>(() => load(BEST_KEY, {}));
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

  useEffect(() => save(SETTINGS_KEY, { ...settings, knownCategories: CATEGORIES.map((c) => c.id) }), [settings]);

  const phase = state?.phase ?? 'idle';
  const bestKey = `${settings.direction}:${settings.difficulty}`;

  // Record a new best when a round ends.
  useEffect(() => {
    if (phase !== 'over' || !state) return;
    setBest((b) => {
      if ((b[bestKey] ?? 0) >= state.score) return b;
      const next = { ...b, [bestKey]: state.score };
      save(BEST_KEY, next);
      return next;
    });
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape pauses, Enter starts; leaving the tab or app pauses too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!game) return;
      if (e.key === 'Escape') {
        if (phase === 'playing') game.pause(true);
        else if (phase === 'paused') game.pause(false);
      } else if (e.key === 'Enter' && (phase === 'idle' || phase === 'over')) {
        start();
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

  const focusInput = () => input.current?.focus({ preventScroll: true });

  const start = () => {
    if (!game || !settings.categories.length) return;
    sfx.unlock();
    game.start(settings);
    focusInput();
  };

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
      {phase === 'idle' && <Menu settings={settings} setSettings={setSettings} best={best[bestKey] ?? 0} onStart={start} />}
      {phase === 'paused' && (
        <div className="overlay">
          <div className="card small">
            <h2>Pauză</h2>
            <p className="dim">Paused</p>
            <div className="row">
              <button className="btn primary" onClick={() => game?.pause(false)}>
                Continuă <small>Resume</small>
              </button>
              <button className="btn" onClick={() => game?.quit()}>
                Meniu <small>Menu</small>
              </button>
            </div>
          </div>
        </div>
      )}
      {phase === 'over' && state && (
        <GameOver state={state} settings={settings} best={best[bestKey] ?? 0} onAgain={start} onMenu={() => game?.quit()} />
      )}
    </div>
  );
}

function HpBar({ hp, max }: { hp: number; max: number }) {
  const frac = hp / max;
  const tone = frac > 0.5 ? 'good' : frac > 0.2 ? 'warn' : 'bad';
  return (
    <div className="hp">
      <span className="hp-label">HP</span>
      <div className="hp-track">
        <div className={`hp-fill ${tone}`} style={{ width: `${frac * 100}%` }} />
      </div>
      <span className="hp-num">
        {hp}/{max}
      </span>
    </div>
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
  return (
    <>
      <div className="hud top" ref={top}>
        <div className="panel castle">
          <div className="panel-head">
            <span className="name">Cetatea</span>
            <span className="lvl">Valul {state.wave}</span>
          </div>
          <HpBar hp={state.hp} max={state.maxHp} />
        </div>
        <div className="panel score">
          <div className="big">
            {state.score.toLocaleString()}
            {state.multiplier > 1 && <span className="mult">×{state.multiplier}</span>}
          </div>
          <div className="tiny">
            {accuracy}% · combo {state.combo}
          </div>
        </div>
        <button className="pause" onClick={() => game.pause(true)} aria-label="Pause">
          ❚❚
        </button>
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
        <div className="dialog">
          {t ? (
            <>
              <div className="dialog-name">
                {t.name[0]} <small>{t.name[1]}</small>
              </div>
              {t.lines.map((line, i) => (
                <Line key={i} line={line} />
              ))}
            </>
          ) : (
            <div className="dialog-idle">
              Liniște… <small>All quiet. Get ready!</small>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Line({ line }: { line: LineView }) {
  const icon = line.shield ? '🫧' : line.state === 'info' ? '👀' : '⭐';
  return (
    <div className={`dline ${line.state}${line.shield ? ' shield' : ''}`}>
      <span className="lang">
        {icon} {line.lang.toUpperCase()}
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
          {g.ch}
        </span>
      ))}
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
  ['🐉', 'Balaurul', 'boss, every 5th wave'],
];

function Menu({
  settings,
  setSettings,
  best,
  onStart,
}: {
  settings: Settings;
  setSettings: (s: Settings) => void;
  best: number;
  onStart: () => void;
}) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ ...settings, [k]: v });
  const toggleCat = (id: string) =>
    set('categories', settings.categories.includes(id) ? settings.categories.filter((c) => c !== id) : [...settings.categories, id]);
  const total = useMemo(() => countIn(settings.categories), [settings.categories]);
  const mastered = masteredCount(settings.direction, settings.categories);
  const sample = useMemo(() => ENTRIES[(Math.random() * ENTRIES.length) | 0], []);
  const [showTopics, setShowTopics] = useState(false);
  const readLang = settings.direction === 'en-ro' ? 'English' : 'Romanian';
  return (
    <div className="overlay menu">
      <div className="card">
        <h1 className="logo">Wordward</h1>
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

        <div className="field">
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

        <div className="field two">
          <div>
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

        <div className="field">
          <button className="field-label toggle" onClick={() => setShowTopics(!showTopics)} aria-expanded={showTopics}>
            {showTopics ? '▾' : '▸'} Teme · Topics{' '}
            <span className="dim">
              ({settings.categories.length}/{CATEGORIES.length}, {total.toLocaleString()} entries)
            </span>
          </button>
          {showTopics && (
            <>
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
            </>
          )}
        </div>

        <div className="start-row">
          <button className="btn primary big" disabled={!settings.categories.length} onClick={onStart}>
            Start!
          </button>
          <div className="best">
            {best > 0 && (
              <div>
                Record: <b>{best.toLocaleString()}</b>
              </div>
            )}
            <div className="mastered">
              Stăpânite · Mastered: <b>{mastered.toLocaleString()}</b> / {total.toLocaleString()}
            </div>
            <div className="sample">
              {stripHints(sample.en)} = <b>{stripHints(sample.ro)}</b>
            </div>
          </div>
        </div>

        <div className="bestiary">
          {BESTIARY.map(([emoji, ro, en]) => (
            <span key={ro}>
              <i>{emoji}</i> <b>{ro}</b> {en}
            </span>
          ))}
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
        <p className="dim">The castle needs a nap. Great effort, try again!</p>
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
            Din nou! <small>Play again</small>
          </button>
          <button className="btn" onClick={onMenu}>
            Meniu <small>Menu</small>
          </button>
        </div>
      </div>
    </div>
  );
}
