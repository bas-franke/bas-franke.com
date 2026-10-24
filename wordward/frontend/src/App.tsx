import { useEffect, useMemo, useRef, useState } from 'react';
import { Game, type Difficulty, type GameState, type Mix, type Settings } from './game/Game';
import { sfx } from './game/audio';
import { masteredCount } from './game/progress';
import { CATEGORIES, countIn, ENTRIES, sourceLang, stripHints, targetLang, type Direction } from './vocab';

const SETTINGS_KEY = 'wordward:settings';
const BEST_KEY = 'wordward:best';

const DEFAULTS: Settings = {
  direction: 'en-ro',
  categories: CATEGORIES.map((c) => c.id),
  mix: 'mixed',
  difficulty: 'normal',
  lenient: true,
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

export default function App() {
  const stage = useRef<HTMLDivElement>(null);
  const tags = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [settings, setSettings] = useState<Settings>(() => {
    const s = load(SETTINGS_KEY, DEFAULTS);
    const known = new Set(CATEGORIES.map((c) => c.id));
    const categories = s.categories.filter((c) => known.has(c));
    return { ...s, categories: categories.length ? categories : DEFAULTS.categories };
  });
  const [best, setBest] = useState<Record<string, number>>(() => load(BEST_KEY, {}));

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

  useEffect(() => save(SETTINGS_KEY, settings), [settings]);

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

  // Keyboard: characters arrive through a hidden input (works with dead keys, IMEs and phone keyboards).
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
    const onBlur = () => game?.pause(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  });

  useEffect(() => {
    if (phase === 'playing') input.current?.focus();
  }, [phase]);

  const start = () => {
    if (!game || !settings.categories.length) return;
    sfx.unlock();
    game.start(settings);
    input.current?.focus();
  };

  const onInput = (e: React.FormEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const text = el.value;
    el.value = '';
    for (const ch of text) game?.type(ch);
  };

  return (
    <div className="app" onPointerDown={() => phase === 'playing' && setTimeout(() => input.current?.focus())}>
      <div className="stage" ref={stage} />
      <div className="hurt" />
      <div className="tags" ref={tags} />
      <input
        ref={input}
        className="catcher"
        onInput={onInput}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label="Type here"
      />
      {state && (phase === 'playing' || phase === 'paused') && <Hud state={state} settings={settings} onPause={() => game?.pause(true)} />}
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

function Hearts({ hp, max }: { hp: number; max: number }) {
  return (
    <div className="hearts" aria-label={`${hp} of ${max} health`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < hp ? 'heart on' : 'heart'}>
          ♥
        </span>
      ))}
    </div>
  );
}

function Hud({ state, settings, onPause }: { state: GameState; settings: Settings; onPause: () => void }) {
  const t = state.target;
  const src = sourceLang(settings.direction).toUpperCase();
  const dst = targetLang(settings.direction).toUpperCase();
  const accuracy = state.typed ? Math.round(((state.typed - state.errors) / state.typed) * 100) : 100;
  return (
    <>
      <div className="hud top">
        <div className="panel">
          <div className="label">Cetatea · Citadel</div>
          <Hearts hp={state.hp} max={state.maxHp} />
        </div>
        <div className="panel center">
          <div className="label">Valul · Wave</div>
          <div className="big">{state.wave}</div>
        </div>
        <div className="panel right">
          <div className="label">Scor · Score</div>
          <div className="big">
            {state.score.toLocaleString()}
            {state.multiplier > 1 && <span className="mult">×{state.multiplier}</span>}
          </div>
          <div className="tiny">
            {accuracy}% · combo {state.combo}
          </div>
        </div>
        <button className="pause" onClick={onPause} aria-label="Pause">
          ❚❚
        </button>
      </div>
      {state.banner && (
        <div className="banner" key={state.banner.n}>
          <div className="banner-text">{state.banner.text}</div>
          <div className="banner-sub">{state.banner.sub}</div>
        </div>
      )}
      <div className="hud bottom">
        {t ? (
          <div className="target-card">
            <div className="lang-row">
              <span className="lang">{src}</span>
              <span className="target-src">{t.source}</span>
            </div>
            <div className="lang-row">
              <span className="lang accent">{dst}</span>
              <span className="target-dst">
                {t.words
                  ? t.words.map((w, i) => (
                      <span key={i} className={i < t.wordIdx! ? 'w done' : i === t.wordIdx ? 'w cur' : 'w'}>
                        {i === t.wordIdx ? <Glyphs glyphs={t.glyphs} pos={t.pos} /> : w}
                      </span>
                    ))
                  : (
                    <span className="w cur">
                      <Glyphs glyphs={t.glyphs} pos={t.pos} />
                    </span>
                  )}
              </span>
            </div>
          </div>
        ) : (
          <div className="target-card idle">
            <span className="dim">Liniște… · All quiet</span>
          </div>
        )}
      </div>
    </>
  );
}

function Glyphs({ glyphs, pos }: { glyphs: { ch: string }[]; pos: number }) {
  return (
    <>
      {glyphs.map((g, i) => (
        <span key={i} className={i < pos ? 'g done' : i === pos ? 'g cur' : 'g'}>
          {g.ch}
        </span>
      ))}
    </>
  );
}

const DIRECTIONS: { id: Direction; label: string; sub: string }[] = [
  { id: 'en-ro', label: 'EN → RO', sub: 'Read English, type Romanian' },
  { id: 'ro-en', label: 'RO → EN', sub: 'Citește română, scrie engleză' },
];
const MIXES: { id: Mix; label: string; sub: string }[] = [
  { id: 'words', label: 'Cuvinte', sub: 'Words' },
  { id: 'mixed', label: 'Amestec', sub: 'Words + sentences' },
  { id: 'sentences', label: 'Propoziții', sub: 'Sentences' },
];
const DIFFICULTIES: { id: Difficulty; label: string; sub: string }[] = [
  { id: 'easy', label: 'Ușor', sub: 'Easy' },
  { id: 'normal', label: 'Normal', sub: 'Normal' },
  { id: 'hard', label: 'Greu', sub: 'Hard' },
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
  return (
    <div className="overlay menu">
      <div className="card">
        <h1 className="logo">Wordward</h1>
        <p className="tagline">
          Apără cetatea cu vorbe. <span className="dim">Defend the citadel with words.</span>
        </p>
        <p className="how">
          Monsters fall on the citadel carrying a word. Type its translation to fire the laser, letter by letter. The
          closest enemy is always your target. Both languages stay on screen, so you learn as you play.
        </p>

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

        <label className="check">
          <input type="checkbox" checked={settings.lenient} onChange={(e) => set('lenient', e.target.checked)} />
          <span>
            Diacritice ușoare <span className="dim">— type a for ă/â, i for î, s for ș, t for ț</span>
          </span>
        </label>

        <div className="field">
          <div className="field-label">
            Teme · Topics <span className="dim">({total.toLocaleString()} entries)</span>
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
          <button className="btn primary big" disabled={!settings.categories.length} onClick={onStart}>
            Start <small>Enter</small>
          </button>
          <div className="best">
            {best > 0 && (
              <>
                Record: <b>{best.toLocaleString()}</b>
              </>
            )}
            <div className="mastered">
              Stăpânite · Mastered: <b>{mastered.toLocaleString()}</b> / {total.toLocaleString()}
            </div>
            <div className="sample">
              <span className="dim">Exemplu:</span> {stripHints(sample.en)} = <b>{stripHints(sample.ro)}</b>
            </div>
          </div>
        </div>

        <div className="bestiary">
          <span>🦇 liliac · short words</span>
          <span>☄️ meteorit · words</span>
          <span>👻 strigoi · long words</span>
          <span>🐉 zmeu · longest words</span>
          <span>🪨 convoi · sentences, left to right</span>
          <span>🐲 balaur · boss every 5th wave</span>
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
  const src = sourceLang(settings.direction);
  const dst = targetLang(settings.direction);
  return (
    <div className="overlay">
      <div className="card">
        <h2 className="over-title">Cetatea a căzut!</h2>
        <p className="dim">The citadel has fallen.</p>
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
            <span>Învinși · Defeated</span>
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
            Din nou <small>Play again · Enter</small>
          </button>
          <button className="btn" onClick={onMenu}>
            Meniu <small>Menu</small>
          </button>
        </div>
      </div>
    </div>
  );
}
