// Garden Sentinels first-time coach: short, friendly, dismissible tips driven by the HUD state, shown once per player
// (localStorage `garden.coach.v1`). Rendered by Hud.tsx as <GardenCoach state={state} actions={actions} />.
//
// Tips: build (wave 1 build phase), upgrade (after the first build), early (gold to spare while the build timer runs),
// roster (first time each enemy kind shows up), send (versus), leak (first enemy reaching the greenhouse).
// The overlay is pointer-events: none; only the cards take clicks. Desktop: every card sits centred just above the
// build bar (clear of the portals at the map edges, the toasts and the NEXT strip up top). Phones: a slim card docked
// under the wave block (portrait) or bottom-left (landscape), hidden while a sheet or drawer is open (garden.css).
// On touch screens (pointer: coarse) the wording switches to taps and the key badges go away.

import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import { ENEMIES, type EnemyKind } from '@shared/garden/enemies';
import { TOWERS, TOWER_KINDS } from '@shared/garden/towers';
import type { GardenActions, GHudState } from './api';
import './coach.css';

const KEY = 'garden.coach.v1';

type TipId = 'build' | 'upgrade' | 'early' | 'send' | 'leak';

interface Saved {
  seen: TipId[];
  kinds: EnemyKind[];
  off: boolean;
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Saved>;
      return { seen: Array.isArray(s.seen) ? s.seen : [], kinds: Array.isArray(s.kinds) ? s.kinds : [], off: !!s.off };
    }
  } catch {
    /* private mode or junk: start fresh */
  }
  return { seen: [], kinds: [], off: false };
}

function save(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Cheapest level 1 tower: "can afford something". */
const CHEAPEST = Math.min(...TOWER_KINDS.map((k) => TOWERS[k].levels[0].cost));

// Checked against towers.ts / enemies.ts: lasers (and shields, flowers) ignore armour (pierce 1), missiles do not
// (pierce 0); brutes have 50% armour, the colossus 40%, disruptors 10%, runners and skitters none.
const COUNTER: Record<EnemyKind, string> = {
  runner: 'Quick but fragile. Lasers melt them, and Slow Flowers keep them in range.',
  skitter: 'They come in packs. Missile Pod splash pops a whole pack at once.',
  disruptor: 'Zaps your towers offline. Bubble Shields block the bolts and protect nearby towers.',
  brute: 'Thick crystal armour halves missile damage. Lasers burn straight through it, and Slow Flowers keep it in the beam.',
  colossus: 'Lasers ignore its armour. It sheds skitters every time it cracks: keep a Missile Pod near the path to pop them.',
};

// ---- touch detection ------------------------------------------------------------------------------------------------

const COARSE = '(pointer: coarse)';
const subscribeCoarse = (cb: () => void) => {
  if (typeof matchMedia !== 'function') return () => {};
  const m = matchMedia(COARSE);
  m.addEventListener?.('change', cb);
  return () => m.removeEventListener?.('change', cb);
};
const coarseNow = () => typeof matchMedia === 'function' && matchMedia(COARSE).matches;

/** True on touch-first screens (phones, tablets): tap wording, no key badges. */
export function useCoarse(): boolean {
  return useSyncExternalStore(subscribeCoarse, coarseNow, () => false);
}

const bossFirst = (r: EnemyKind[]) => (r.includes('colossus') ? ['colossus' as EnemyKind, ...r.filter((k) => k !== 'colossus')] : r);

const TAG_CLASS: Record<string, string> = { Fast: 'fast', Swarm: 'swarm', Support: 'support', Armored: 'armored', Boss: 'boss' };

// ---- portraits ------------------------------------------------------------------------------------------------------
// Flat cel shapes, no gradients or ids, so many copies never clash.

const INK = '#1f2630';
const CREAM = '#F5E7D6';

function Eyes({ y, l, r, s = 2.6 }: { y: number; l: number; r: number; s?: number }) {
  return (
    <g>
      <ellipse cx={l} cy={y} rx={s} ry={s * 1.2} fill={INK} />
      <ellipse cx={r} cy={y} rx={s} ry={s * 1.2} fill={INK} />
      <circle cx={l + s * 0.35} cy={y - s * 0.45} r={s * 0.38} fill="#fff" />
      <circle cx={r + s * 0.35} cy={y - s * 0.45} r={s * 0.38} fill="#fff" />
    </g>
  );
}

function Blush({ y, l, r }: { y: number; l: number; r: number }) {
  return (
    <g fill="#ff8f8f" opacity="0.55">
      <ellipse cx={l} cy={y} rx="2.6" ry="1.5" />
      <ellipse cx={r} cy={y} rx="2.6" ry="1.5" />
    </g>
  );
}

const PORTRAITS: Record<EnemyKind, () => JSX.Element> = {
  runner: () => (
    <g>
      {/* tail */}
      <path d="M44 46 q14 -2 14 -16 q-6 6 -14 8 z" fill="#ff8a2a" />
      <path d="M58 30 q-2 6 -6 8 l2 -6 z" fill={INK} />
      {/* body and legs */}
      <ellipse cx="32" cy="50" rx="12" ry="8" fill="#ff8a2a" />
      <ellipse cx="32" cy="52" rx="6" ry="5" fill={CREAM} />
      <ellipse cx="25" cy="57.5" rx="4.5" ry="2.6" fill="#2b2f36" />
      <ellipse cx="39" cy="57.5" rx="4.5" ry="2.6" fill="#2b2f36" />
      {/* ears */}
      <path d="M17 26 L14 6 L28 18 z" fill="#ff8a2a" />
      <path d="M47 26 L50 6 L36 18 z" fill="#ff8a2a" />
      <path d="M15 12 L14 6 L19 10 z M49 12 L50 6 L45 10 z" fill={INK} />
      <path d="M18 21 L17 12 L24 18 z M46 21 L47 12 L40 18 z" fill="#ffd2a6" />
      {/* head */}
      <path d="M12 30 q0 -14 20 -14 q20 0 20 14 q0 10 -20 20 q-20 -10 -20 -20 z" fill="#FFA940" />
      <path d="M20 36 q12 -4 24 0 q-4 10 -12 13 q-8 -3 -12 -13 z" fill={CREAM} />
      <path d="M14 26 q4 -6 10 -7 q-6 4 -7 9 z" fill="#ffc47a" />
      <Eyes y={30} l={24} r={40} />
      <ellipse cx="32" cy="40" rx="2.4" ry="1.7" fill={INK} />
      <Blush y={36} l={19} r={45} />

    </g>
  ),
  skitter: () => (
    <g>
      {/* spikes */}
      <path
        d="M10 40 L4 30 L14 32 L10 20 L20 26 L22 13 L29 23 L34 10 L38 23 L46 13 L46 26 L56 21 L52 32 L61 31 L54 40 z"
        fill="#2fbdb1"
      />
      <path d="M22 13 L29 23 L25 24 z M34 10 L38 23 L33 22 z M46 13 L46 26 L42 24 z" fill="#9ff7ef" />
      {/* body */}
      <ellipse cx="32" cy="40" rx="22" ry="15" fill="#4EE6D9" />
      <path d="M14 36 q6 -10 18 -11 q-12 4 -15 13 z" fill="#a8fbf4" />
      {/* face */}
      <ellipse cx="32" cy="45" rx="13" ry="9" fill={CREAM} />
      <Eyes y={42} l={26} r={38} s={2.3} />
      <ellipse cx="32" cy="48" rx="2" ry="1.4" fill={INK} />
      <Blush y={47} l={21} r={43} />
      <ellipse cx="22" cy="56" rx="4" ry="2.4" fill="#26968c" />
      <ellipse cx="42" cy="56" rx="4" ry="2.4" fill="#26968c" />
    </g>
  ),
  disruptor: () => (
    <g>
      {/* antenna orb */}
      <path d="M32 18 L32 9" stroke="#7b47d1" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="32" cy="7" r="4.4" fill="#e2c9ff" />
      <circle cx="32" cy="7" r="2.2" fill="#fff" />
      {/* crystal crown */}
      <path d="M16 26 L12 10 L22 20 z M48 26 L52 10 L42 20 z" fill="#A869FF" />
      <path d="M14 14 L12 10 L17 15 z M50 14 L52 10 L47 15 z" fill="#d7b8ff" />
      {/* body */}
      <path d="M10 38 q0 -20 22 -20 q22 0 22 20 q0 16 -22 18 q-22 -2 -22 -18 z" fill="#A869FF" />
      <path d="M14 32 q4 -10 14 -12 q-9 5 -10 14 z" fill="#c9a2ff" />
      <path d="M18 40 q14 -4 28 0 q-4 11 -14 12 q-10 -1 -14 -12 z" fill="#ead9ff" />
      <Eyes y={34} l={24} r={40} s={2.8} />
      <path d="M28 44 q4 3 8 0" stroke={INK} strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <Blush y={41} l={18} r={46} />
      {/* little zaps */}
      <path d="M4 30 l4 2 l-3 2 l4 2" stroke="#FFA940" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M60 30 l-4 2 l3 2 l-4 2" stroke="#FFA940" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  ),
  brute: () => (
    <g>
      {/* back crystals */}
      <path d="M16 26 L18 6 L26 22 z" fill="#4EE6D9" />
      <path d="M26 22 L32 2 L38 22 z" fill="#7ff2e8" />
      <path d="M38 22 L46 6 L48 26 z" fill="#4EE6D9" />
      <path d="M8 34 L4 18 L16 28 z M56 34 L60 18 L48 28 z" fill="#2fc7ba" />
      <path d="M32 2 L35 12 L32 22 z" fill="#d4fffb" />
      {/* bulky body */}
      <path d="M6 44 q0 -22 26 -22 q26 0 26 22 q0 12 -26 14 q-26 -2 -26 -14 z" fill="#1f7f86" />
      <path d="M10 38 q6 -12 20 -14 q-14 6 -16 18 z" fill="#2c9aa1" />
      {/* face plate */}
      <path d="M18 42 q14 -6 28 0 q-2 12 -14 13 q-12 -1 -14 -13 z" fill="#3fb3b0" />
      <Eyes y={40} l={25} r={39} s={2.4} />
      <path d="M21 35 l8 2 M43 35 l-8 2" stroke={INK} strokeWidth="2" strokeLinecap="round" />
      <ellipse cx="32" cy="48.5" rx="2.2" ry="1.8" fill={INK} />
      {/* fists */}
      <ellipse cx="9" cy="54" rx="6" ry="5" fill="#176870" />
      <ellipse cx="55" cy="54" rx="6" ry="5" fill="#176870" />
      <path d="M6 50 L8 44 L11 50 z M52 50 L55 44 L58 50 z" fill="#4EE6D9" />
    </g>
  ),
  colossus: () => (
    <g>
      {/* prismatic crown */}
      <path d="M12 24 L10 4 L22 18 z" fill="#A869FF" />
      <path d="M22 18 L27 0 L32 16 z" fill="#2EB3FF" />
      <path d="M32 16 L37 0 L42 18 z" fill="#4EE6D9" />
      <path d="M42 18 L54 4 L52 24 z" fill="#FFA940" />
      <path d="M27 0 L29 9 L32 16 z M37 0 L39 9 L42 18 z" fill="#fff" opacity="0.7" />
      {/* faceted body */}
      <path d="M6 30 L32 16 L58 30 L56 50 L32 62 L8 50 z" fill="#8e7ce6" />
      <path d="M6 30 L32 16 L32 36 z" fill="#b59cff" />
      <path d="M58 30 L32 16 L32 36 z" fill="#6fd8f0" />
      <path d="M6 30 L32 36 L8 50 z" fill="#7a63d9" />
      <path d="M58 30 L32 36 L56 50 z" fill="#4fb6e8" />
      <path d="M8 50 L32 36 L32 62 z" fill="#ffb867" />
      <path d="M56 50 L32 36 L32 62 z" fill="#72eadf" />
      {/* face */}
      <path d="M20 34 L32 28 L44 34 L42 46 L32 50 L22 46 z" fill="#f2ecff" />
      <Eyes y={38} l={27} r={37} s={2.6} />
      <path d="M29 44 q3 2 6 0" stroke={INK} strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M14 46 l3 -4 M50 46 l-3 -4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
    </g>
  ),
};

export function CoachPortrait({ kind }: { kind: EnemyKind }) {
  const P = PORTRAITS[kind];
  return (
    <svg className={`gsc-portrait gsc-portrait-${kind}`} viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="34" r="30" fill="rgba(255,255,255,0.55)" />
      <P />
    </svg>
  );
}

function Kbd({ children }: { children: string }) {
  return <kbd className="gsc-kbd">{children}</kbd>;
}

// ---- tips -----------------------------------------------------------------------------------------------------------

interface Card {
  key: string;
  where: 'bar' | 'side' | 'top';
  tone?: 'bad';
  title: string;
  body: JSX.Element;
  kind?: EnemyKind;
  /** Auto-dismiss (marks it seen) after this many seconds. */
  ttl?: number;
}

type TipText = Omit<Card, 'key' | 'body'> & { body: (touch: boolean) => JSX.Element };

const TEXT: Record<TipId, TipText> = {
  build: {
    where: 'bar',
    title: 'Plant your first sentinel',
    body: (touch) =>
      touch ? (
        <>Tap a tower card, then tap a grass tile next to the path to preview it. Tap the same tile again to plant.</>
      ) : (
        <>
          Pick a tower below (or press <Kbd>1</Kbd>–<Kbd>5</Kbd>), then click a grass tile next to the path.
        </>
      ),
  },
  upgrade: {
    where: 'side',
    title: 'Nicely done!',
    body: (touch) =>
      touch ? (
        <>
          Tap a tower to upgrade or sell it. Level 3 towers are <b>Masterworks</b>.
        </>
      ) : (
        <>
          Click a tower to upgrade (<Kbd>U</Kbd>) or sell (<Kbd>X</Kbd>) it. Level 3 towers are <b>Masterworks</b>.
        </>
      ),
    ttl: 14,
  },
  early: {
    where: 'side',
    title: 'Ready?',
    body: (touch) =>
      touch ? (
        <>
          Tap <b>Call wave</b> at the top to start early for bonus gold.
        </>
      ) : (
        <>
          Press <Kbd>R</Kbd> or click <b>Call wave</b> to start early for bonus gold.
        </>
      ),
  },
  send: {
    where: 'side',
    title: 'Versus',
    body: (touch) =>
      touch ? (
        <>Tap the little runner at the top right to send enemies at your rivals. Sending raises your income every wave.</>
      ) : (
        <>Send enemies at your rivals from the Send panel. Sending raises your income every wave.</>
      ),
    ttl: 16,
  },
  leak: {
    where: 'top',
    tone: 'bad',
    title: 'Oh no, a leak!',
    body: () => <>An enemy reached the greenhouse! Strengthen the path near the greenhouse or cover the entrance it came from.</>,
    ttl: 9,
  },
};

export function GardenCoach({ state, actions }: { state: GHudState; actions: GardenActions }) {
  void actions;
  const touch = useCoarse();
  // client.ts reports how many towers you own; older builds did not (then a gold drop right after placing counts).
  const myTowers = state.myTowers;
  const [saved, setSaved] = useState<Saved>(load);
  // Tips currently wanted (transient conditions), and the enemy roster queue.
  const [built, setBuilt] = useState(false);
  const [leaked, setLeaked] = useState(false);
  const [roster, setRoster] = useState<EnemyKind[]>([]);
  const prev = useRef<{ gold: number; lives: number; phase: string; placing: boolean; wave: number } | null>(null);
  /** When placing last ended: the build is confirmed (gold drops) a tick after the client leaves placing mode. */
  const placingEnded = useRef(0);
  const lastNext = useRef<EnemyKind[]>([]);

  const update = (f: (s: Saved) => Saved) =>
    setSaved((s) => {
      const n = f(s);
      save(n);
      return n;
    });
  const markSeen = (id: TipId) => update((s) => (s.seen.includes(id) ? s : { ...s, seen: [...s.seen, id] }));
  const markKind = (k: EnemyKind) => {
    update((s) => (s.kinds.includes(k) ? s : { ...s, kinds: [...s.kinds, k] }));
    setRoster((r) => r.filter((x) => x !== k));
  };
  const turnOff = () => update((s) => ({ ...s, off: true }));

  // Watch transitions: first build (gold drops while placing or a tower of ours gets selected), leaks (lives drop),
  // a wave starting (the kinds previewed during the build phase now walk the path).
  useEffect(() => {
    if (!state.ready) return;
    const p = prev.current;
    const placing = state.placing != null;
    if (state.phase === 'build' && state.next.length) lastNext.current = state.next.map((n) => n.kind);
    if (p && p.placing && !placing) placingEnded.current = performance.now();
    if (!built && myTowers !== undefined && myTowers > 0) setBuilt(true);
    if (p) {
      const justPlaced = p.placing || placing || performance.now() - placingEnded.current < 1500;
      if (!built && myTowers === undefined && ((state.gold < p.gold && justPlaced) || state.selected?.mine)) setBuilt(true);
      if (state.lives < p.lives && state.phase !== 'over') setLeaked(true);
      if (state.phase === 'wave' && (p.phase !== 'wave' || p.wave !== state.wave)) {
        const kinds = lastNext.current.length ? lastNext.current : state.next.map((n) => n.kind);
        const fresh = kinds.filter((k, i) => kinds.indexOf(k) === i && !saved.kinds.includes(k));
        // The boss goes first: its card matters more than any lesser arrival.
        if (fresh.length) setRoster((r) => bossFirst([...r, ...fresh.filter((k) => !r.includes(k))]));
        lastNext.current = [];
      }
    } else if (state.phase === 'wave' && state.next.length) {
      // Joined mid-wave: best guess at what is on the path.
      const fresh = state.next.map((n) => n.kind).filter((k) => !saved.kinds.includes(k));
      if (fresh.length) setRoster(bossFirst(fresh));
    }
    prev.current = { gold: state.gold, lives: state.lives, phase: state.phase, placing, wave: state.wave };
  }, [state, built, saved.kinds, myTowers]);

  // Once the first build happened the build tip is done for good.
  useEffect(() => {
    if (built && !saved.seen.includes('build')) markSeen('build');
  }, [built]); // eslint-disable-line react-hooks/exhaustive-deps

  // The early-call tip counts as seen once a wave starts while it was on screen.
  const seen = (id: TipId) => saved.seen.includes(id);
  const hidden = !state.ready || saved.off || !!state.end || state.paused || state.scoresOpen || state.phase === 'over';

  let card: Card | null = null;
  const pick = (id: TipId): Card => ({ key: id, ...TEXT[id], body: TEXT[id].body(touch) });
  const rosterCard = (k: EnemyKind): Card => ({ key: `kind-${k}`, where: 'side', title: ENEMIES[k].name, kind: k, body: <>{COUNTER[k]}</>, ttl: 14 });
  if (!hidden) {
    if (roster[0] === 'colossus') card = rosterCard('colossus');
    else if (leaked && !seen('leak')) card = pick('leak');
    else if (roster.length) card = rosterCard(roster[0]);
    else if (!seen('build') && !built && state.phase === 'build' && state.wave <= 1) card = pick('build');
    else if (built && !seen('upgrade')) card = pick('upgrade');
    else if (state.mode === 'vs' && !seen('send') && seen('build') && state.wave >= 1) card = pick('send');
    else if (!seen('early') && seen('build') && state.phase === 'build' && state.left > 3 && state.gold >= CHEAPEST && !state.placing)
      card = pick('early');
  }

  const dismiss = () => {
    if (!card) return;
    if (card.kind) markKind(card.kind);
    else markSeen(card.key as TipId);
  };

  // Early tip: once the wave starts it has done its job.
  const showingEarly = card?.key === 'early';
  const wasEarly = useRef(false);
  useEffect(() => {
    if (showingEarly) wasEarly.current = true;
    else if (wasEarly.current && state.phase === 'wave') {
      wasEarly.current = false;
      markSeen('early');
    }
  }, [showingEarly, state.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-dismiss timed cards.
  const cardKey = card?.key;
  const ttl = card?.ttl;
  useEffect(() => {
    if (!cardKey || !ttl) return;
    const t = window.setTimeout(() => {
      if (cardKey.startsWith('kind-')) markKind(cardKey.slice(5) as EnemyKind);
      else markSeen(cardKey as TipId);
    }, ttl * 1000);
    return () => window.clearTimeout(t);
  }, [cardKey, ttl]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!card) return null;
  const d = card.kind ? ENEMIES[card.kind] : null;

  return (
    <div className="gsc-layer">
      <div
        key={card.key}
        className={`gsc-card gsc-at-${card.where}${touch ? ' gsc-touch' : ''}${card.tone ? ` gsc-${card.tone}` : ''}${d ? ' gsc-roster' : ''}`}
        role="status"
        aria-live="polite"
      >
        {card.kind && d ? (
          <div className="gsc-roster-head">
            <CoachPortrait kind={card.kind} />
            <div>
              <div className="gsc-eyebrow">New arrival</div>
              <div className="gsc-title">{d.name}</div>
              <span className={`gsc-tag gsc-tag-${TAG_CLASS[d.tag] ?? 'fast'}`}>{d.tag}</span>
            </div>
          </div>
        ) : (
          <div className="gsc-title">
            <span className="gsc-sprout" aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <path d="M10 18 V9" stroke="#4d8a33" strokeWidth="2" strokeLinecap="round" />
                <path d="M10 10 q-7 0 -7 -7 q7 0 7 7 z" fill="#6BAF4B" />
                <path d="M10 9 q6 0 7 -6 q-7 -1 -7 6 z" fill="#4EE6D9" />
              </svg>
            </span>
            {card.title}
          </div>
        )}
        <p className="gsc-body">{card.body}</p>
        <div className="gsc-foot">
          <button type="button" className="gsc-mute" onClick={turnOff}>
            Don't show tips
          </button>
          <button type="button" className="gsc-ok" onClick={dismiss}>
            Got it
          </button>
        </div>
        {card.ttl ? <div className="gsc-timer" style={{ animationDuration: `${card.ttl}s` }} /> : null}
      </div>
    </div>
  );
}
