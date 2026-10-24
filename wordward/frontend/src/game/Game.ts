// The game: spawns waves of creatures carrying words, routes every typed character to the closest one, fires the
// owl's star beam, and keeps score. three.js draws the world; the word tags above creatures are plain DOM elements
// positioned each frame (crisp text in any script, cheap to restyle). React only renders menus and the HUD from
// `GameState` snapshots.
//
// Every creature first wears a bubble shield with the word in the language you read (English in EN → RO). Typing it
// pops the bubble; then you type the translation to send the creature home. A sentence convoy has one big bubble
// with the whole source sentence; the balaur has one bubble per head.

import * as THREE from 'three';
import { Engine } from './engine';
import { Effects } from './effects';
import { makeBalaurBody, makeBubble, makeModel, tickBubbles, type Bubble, type Kind, type Model } from './enemies';
import { buildWorld, DEFENDER_FRONT, FIELD_HALF, FIELD_LENGTH, fieldZ, IMPACT_Y, LINE_Z, type World } from './world';
import { sfx } from './audio';
import { flush as flushProgress, isMastered, record } from './progress';
import {
  ENTRIES,
  glyphs,
  matches,
  sourceLang,
  stripHints,
  targetLang,
  type Direction,
  type Entry,
  type Glyph,
  type Lang,
} from '../vocab';

export type Mix = 'words' | 'mixed' | 'sentences';
export type Difficulty = 'easy' | 'normal' | 'hard';
/** Every kind of enemy: a single creature, a sentence convoy, or the boss. */
export type EnemyKind = Kind | 'convoy' | 'balaur';
type Layer = 'shield' | 'core';

export interface Settings {
  direction: Direction;
  categories: string[];
  mix: Mix;
  difficulty: Difficulty;
  /** Accept plain letters for Romanian diacritics (a for ă/â, s for ș, ...). */
  lenient: boolean;
  /** Type the word you read first, to pop the creature's bubble shield. */
  shields: boolean;
  /** Adventure mode: the mission run overrides topics, mode and length, and the round can be won. */
  run?: RunConfig;
}

/** One adventure mission in one variant, as the game plays it (built by `runFor` in campaign.ts). */
export interface RunConfig {
  missionId: string;
  variant: string;
  /** Position on the path. */
  n: number;
  emoji: string;
  ro: string;
  en: string;
  /** Shown under the title on the first wave, e.g. "🧠 Din memorie · From memory". */
  label?: string;
  /** Empty: every topic. */
  categories: string[];
  mix: Mix;
  waves: number;
  /** Fall speed multiplier. */
  speed: number;
  /** Only sentences of at most this many words. */
  maxWords?: number;
  /** Heads on the boss; 0 = no boss. Normally on the last wave only. */
  boss: number;
  bossEveryWave?: boolean;
  /** Castle health (default 10). */
  hp?: number;
  /** The translation is hidden until typed. */
  memory?: boolean;
  /** Typos allowed before the mission fails. */
  maxErrors?: number;
  /** Play exactly these entries (review missions). */
  entries?: string[];
  /** Play in this direction instead of the player's (reversed variant). */
  direction?: Direction;
}

export interface WordView {
  glyphs: Glyph[];
  pos: number;
  hint?: string;
  /** From-memory mode: letters after `pos` are hidden, except up to `peek` (revealed after two misses). */
  hidden?: boolean;
  peek?: number;
}

export interface LineView {
  lang: Lang;
  words: WordView[];
  /** `info`: shown for reading only (shields off). `waiting`: the other line has to be typed first. */
  state: 'active' | 'waiting' | 'done' | 'info';
  /** Index of the word being typed, when this line belongs to the current target. */
  current: number;
  shield: boolean;
}

export interface TargetView {
  kind: EnemyKind;
  name: [ro: string, en: string];
  lines: LineView[];
}

export interface Missed {
  entry: Entry;
  count: number;
}

export interface GameState {
  phase: 'idle' | 'playing' | 'paused' | 'over' | 'won';
  /** The adventure mission being played, or null in free play. */
  run: RunConfig | null;
  /** Stars earned when a mission is won (1–3). */
  stars: number;
  /** Why a mission ended early (too many typos), for the game-over screen. */
  failReason: string | null;
  hp: number;
  maxHp: number;
  score: number;
  wave: number;
  combo: number;
  multiplier: number;
  typed: number;
  errors: number;
  destroyed: number;
  target: TargetView | null;
  /** Big message in the middle of the screen ("Valul 3"), with a counter so React can restart its animation. */
  banner: { text: string; sub: string; n: number } | null;
  /** "A wild bat appeared!", the first time each creature shows up in a game. */
  toast: { ro: string; en: string; n: number } | null;
  missed: Missed[];
}

/** One creature (or a sentence banner) with its tag; it carries the words typed at it. */
interface Slot {
  anchor: THREE.Object3D;
  model?: Model;
  bubble?: Bubble;
  radius: number;
  tag: HTMLElement;
  /** Reading line shown when there is no shield to type. */
  info?: { lang: Lang; text: string };
  parts: WordPart[];
  /** Last on-screen position of the tag, for letter pops. */
  sx: number;
  sy: number;
  done: boolean;
}

interface WordPart {
  layer: Layer;
  lang: Lang;
  entry: Entry;
  glyphs: Glyph[];
  hint?: string;
  pos: number;
  mistakes: number;
  slot: Slot;
  done: boolean;
  /** From-memory mode: hidden until typed; `peek` is the last letter shown as a hint, `missAt` misses on this letter. */
  hidden: boolean;
  peek: number;
  missAt: number;
}

interface Enemy {
  id: number;
  kind: EnemyKind;
  entry: Entry;
  slots: Slot[];
  /** Words in typing order. */
  parts: WordPart[];
  partIdx: number;
  root: THREE.Group;
  body?: Model;
  x: number;
  y: number;
  /** Where on the wall it is heading. */
  aimX: number;
  speed: number;
  phase: number;
  mistakes: number;
}

/** "A wild … appeared!" per kind; Romanian needs the article and adjective to agree with the creature's gender. */
const APPEARS: Record<EnemyKind, string> = {
  bat: 'Un liliac sălbatic a apărut!',
  meteor: 'Un pietroi sălbatic a apărut!',
  ghost: 'O fantomiță sălbatică a apărut!',
  zmeu: 'Un zmeuț sălbatic a apărut!',
  rock: 'O pietricică sălbatică a apărut!',
  head: 'Balaurul a apărut!',
  convoy: 'Un șir de pietricele a apărut!',
  balaur: 'Balaurul a apărut!',
};

export const NAMES: Record<EnemyKind, [ro: string, en: string]> = {
  bat: ['liliac', 'bat'],
  meteor: ['pietroi', 'rock buddy'],
  ghost: ['fantomiță', 'little ghost'],
  zmeu: ['zmeuț', 'baby dragon'],
  rock: ['pietricică', 'pebble'],
  head: ['cap de balaur', 'dragon head'],
  convoy: ['șir de pietricele', 'pebble parade'],
  balaur: ['Balaurul', 'the dragon'],
};

const MAX_HP = 10;
const DIFF = {
  easy: { time: 1.35, cps: 1.4 },
  normal: { time: 1, cps: 2.2 },
  hard: { time: 0.75, cps: 3.2 },
};
/** Seconds a creature of each kind takes to fall the whole field at wave 1 on normal. */
const FALL_TIME: Record<EnemyKind, number> = { bat: 15, meteor: 19, ghost: 21, zmeu: 25, rock: 19, head: 25, convoy: 36, balaur: 65 };
const POOFS = ['POF!', 'PUF!', 'BRAVO!', 'SUPER!', 'YUPI!', 'TOP!'];

/** The camera always shows at least this much of the field in front of the defence line (world units). */
const MIN_FIELD = 21;
/** Camera pitch below the horizon: a high view from in front; tall portrait screens look a little steeper. */
const PITCH_LANDSCAPE = THREE.MathUtils.degToRad(55);
const PITCH_PORTRAIT = THREE.MathUtils.degToRad(63);
/** Creatures are modelled at about 1 m radius and drawn bigger, so faces read on a phone. */
const CREATURE_SCALE = 1.45;
/** Narrow screens show at least this much width at the defence line: the field plus a sliver of the shelves' props. */
const MIN_HALF_WIDTH = FIELD_HALF + 1.1;
/** Screen pixels kept free above a creature for its word tag, so tags of new arrivals never slide under the HUD. */
const TAG_ROOM = 100;

export class Game {
  readonly engine: Engine;
  private world: World;
  private effects: Effects;
  private tags: HTMLElement;
  private enemies: Enemy[] = [];
  private nextId = 1;
  private settings!: Settings;
  private deck: Entry[] = [];
  private sentenceDeck: Entry[] = [];
  /** Entries the player got wrong, shown again a few spawns later. */
  private review: { entry: Entry; due: number }[] = [];
  private seen = new Set<EnemyKind>();
  private spawned = 0;
  private waveLeft = 0;
  private spawnTimer = 0;
  private waveBreak = 0;
  private bossPending = false;
  private targetId = 0;
  private shake = 0;
  private hurtFlash = 0;
  private aim = new THREE.Vector3(0, 1, LINE_Z - 20);
  private zapPitch = 1;
  private halfWidth = 14;
  private top = 26;
  /** Screen pixels covered by the HUD at the top and the word panel at the bottom; the defenders sit above the latter. */
  private insets = { top: 0, bottom: 0 };
  private missed = new Map<string, Missed>();
  private listeners = new Set<(s: GameState) => void>();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmpScale = new THREE.Vector3();

  state: GameState = {
    phase: 'idle',
    run: null,
    stars: 0,
    failReason: null,
    hp: MAX_HP,
    maxHp: MAX_HP,
    score: 0,
    wave: 0,
    combo: 0,
    multiplier: 1,
    typed: 0,
    errors: 0,
    destroyed: 0,
    target: null,
    banner: null,
    toast: null,
    missed: [],
  };

  constructor(container: HTMLElement, tags: HTMLElement) {
    this.engine = new Engine(container, { fov: 40, shadows: false, near: 1, far: 1200 });
    this.tags = tags;
    this.world = buildWorld(this.engine.scene);
    this.effects = new Effects(this.engine.scene);
    // Compile the beam and splat shaders now, so the first hit does not stutter.
    this.effects.prewarm(this.engine.renderer, this.engine.camera);
    this.engine.start((dt, t) => this.frame(dt, t));
  }

  subscribe(fn: (s: GameState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => void this.listeners.delete(fn);
  }

  private emit() {
    this.state = { ...this.state, target: this.targetView(), missed: [...this.missed.values()].sort((a, b) => b.count - a.count) };
    for (const fn of this.listeners) fn(this.state);
  }

  /** Pixels hidden behind HUD panels; the camera frames the defenders just above the bottom one. */
  setInsets(top: number, bottom: number) {
    this.insets = { top, bottom };
  }

  dispose() {
    this.clearEnemies();
    this.engine.dispose();
  }

  // ---- rounds --------------------------------------------------------------------------------------------------

  start(input: Settings) {
    const { run } = input;
    // A mission picks the topics, the mode and the waves (and maybe the direction); difficulty and toggles stay the
    // player's.
    const settings: Settings = run
      ? {
          ...input,
          direction: run.direction ?? input.direction,
          categories: run.categories.length ? run.categories : [...new Set(ENTRIES.map((e) => e.category))],
          mix: run.mix,
        }
      : input;
    this.settings = settings;
    this.clearEnemies();
    this.effects.clear();
    const words = (e: Entry) => stripHints(e[targetLang(settings.direction)]).split(' ').length;
    const only = run?.entries?.length ? new Set(run.entries) : null;
    const pool = ENTRIES.filter(
      (e) => (only ? only.has(e.id) : settings.categories.includes(e.category)) && (!run?.maxWords || !e.sentence || words(e) <= run.maxWords),
    );
    // Draws come from the end of a deck, so words not yet mastered go last and are served first.
    const order = (list: Entry[]) => {
      const mastered = list.filter((e) => isMastered(e.id, settings.direction));
      const fresh = list.filter((e) => !isMastered(e.id, settings.direction));
      return [...shuffle(mastered), ...shuffle(fresh)];
    };
    this.deck = order(pool.filter((e) => !e.sentence));
    this.sentenceDeck = order(pool.filter((e) => e.sentence));
    if (settings.mix === 'sentences' && !this.sentenceDeck.length) this.sentenceDeck = shuffle(ENTRIES.filter((e) => e.sentence));
    if (settings.mix !== 'sentences' && !this.deck.length) this.deck = shuffle(ENTRIES.filter((e) => !e.sentence));
    this.review = [];
    this.missed.clear();
    this.seen.clear();
    this.spawned = 0;
    this.targetId = 0;
    this.state = {
      ...this.state,
      phase: 'playing',
      run: run ?? null,
      stars: 0,
      failReason: null,
      hp: run?.hp ?? MAX_HP,
      maxHp: run?.hp ?? MAX_HP,
      score: 0,
      wave: 0,
      combo: 0,
      multiplier: 1,
      typed: 0,
      errors: 0,
      destroyed: 0,
      banner: null,
      toast: null,
    };
    this.world.setDamage(1);
    this.nextWave();
  }

  pause(paused: boolean) {
    if (this.state.phase === 'playing' && paused) this.state = { ...this.state, phase: 'paused' };
    else if (this.state.phase === 'paused' && !paused) this.state = { ...this.state, phase: 'playing' };
    else return;
    this.emit();
  }

  quit() {
    flushProgress();
    this.clearEnemies();
    this.state = { ...this.state, phase: 'idle', banner: null, toast: null };
    this.emit();
  }

  private nextWave() {
    const wave = this.state.wave + 1;
    if (wave > 1) flushProgress();
    const run = this.settings.run;
    if (run && wave > run.waves) {
      this.win();
      return;
    }
    // Free play: a balaur every 5th wave. Adventure: on the mission's last wave, or every wave for a boss mission.
    const boss = run ? run.boss > 0 && (run.bossEveryWave || wave === run.waves) : wave % 5 === 0 && this.settings.mix !== 'sentences';
    this.bossPending = boss;
    // Missions count waves from their place on the path, so later missions start busier.
    const busy = run ? wave + Math.floor(run.n / 8) : wave;
    this.waveLeft = Math.max(3, Math.min(30, 4 + busy * 2) - (boss ? 6 : 0));
    this.waveBreak = 2.6;
    this.spawnTimer = 0;
    const heal = wave > 1 && this.state.hp < this.state.maxHp;
    if (heal) sfx.play('heal');
    this.state = {
      ...this.state,
      wave,
      hp: heal ? this.state.hp + 1 : this.state.hp,
      banner: boss
        ? { text: 'Balaurul!', sub: `Valul ${wave} · Wave ${wave} · boss${heal ? ' · +1 ♥' : ''}`, n: wave }
        : run && wave === 1
          ? { text: `${run.emoji} ${run.ro}`, sub: run.label ?? run.en, n: wave }
          : { text: `Valul ${wave}`, sub: wave === 1 ? 'Apără cetatea! · Defend the castle!' : `Wave ${wave}${run ? `/${run.waves}` : ''}${heal ? ' · +1 ♥' : ''}`, n: wave },
    };
    this.world.setDamage(this.state.hp / this.state.maxHp);
    if (wave > 1) sfx.play('wave');
    this.emit();
  }

  /** All waves of the mission cleared: stars for health left and accuracy (the app records them). */
  private win() {
    const { hp, maxHp, typed, errors } = this.state;
    const accuracy = typed ? (typed - errors) / typed : 1;
    const health = hp / maxHp;
    const stars = health >= 0.8 && accuracy >= 0.9 ? 3 : health >= 0.4 && accuracy >= 0.75 ? 2 : 1;
    flushProgress();
    sfx.play('bigpoof');
    this.state = { ...this.state, phase: 'won', stars, banner: null, toast: null };
    this.emit();
  }

  private gameOver(reason: string | null = null) {
    flushProgress();
    sfx.play('lose');
    // Everything still in the air poofs away with the game.
    for (const e of [...this.enemies]) {
      this.effects.poof(e.root.position, 1.2, 0xffffff);
      this.remove(e);
    }
    this.state = { ...this.state, phase: 'over', hp: reason ? this.state.hp : 0, banner: null, toast: null, failReason: reason };
    this.world.setDamage(0);
    this.emit();
  }

  // ---- spawning ------------------------------------------------------------------------------------------------

  private draw(sentence: boolean): Entry {
    const due = this.review.findIndex((r) => r.due <= this.spawned && r.entry.sentence === sentence);
    if (due >= 0) return this.review.splice(due, 1)[0].entry;
    const deck = sentence ? this.sentenceDeck : this.deck;
    const alive = new Set(this.enemies.map((e) => e.entry.id));
    for (let i = deck.length - 1; i >= 0; i--) {
      if (alive.has(deck[i].id)) continue;
      const [e] = deck.splice(i, 1);
      deck.unshift(e);
      return e;
    }
    return deck[deck.length - 1];
  }

  private wantSentence(): boolean {
    const { mix } = this.settings;
    if (mix === 'words' || !this.sentenceDeck.length) return false;
    if (mix === 'sentences' || !this.deck.length) return true;
    if (this.enemies.some((e) => e.kind === 'balaur')) return false;
    const convoys = this.enemies.filter((e) => e.kind === 'convoy').length;
    return this.state.wave >= 2 && convoys < (this.state.wave >= 6 ? 2 : 1) && Math.random() < 0.28;
  }

  private spawn() {
    const entry = this.draw(this.wantSentence());
    const letters = countTyped(stripHints(entry[targetLang(this.settings.direction)]));
    let kind: EnemyKind;
    if (entry.sentence) kind = 'convoy';
    else if (letters <= 4) kind = 'bat';
    else if (letters <= 7) kind = Math.random() < 0.7 ? 'meteor' : 'ghost';
    else if (letters <= 10) kind = Math.random() < 0.6 ? 'ghost' : 'meteor';
    else kind = 'zmeu';
    this.create(kind, [entry]);
  }

  /** The balaur: one head per word (3 at wave 5, one more every 5 waves, at most 5), short words only. */
  private spawnBoss() {
    const run = this.settings.run;
    const heads = run?.boss ? Math.min(5, run.boss + (run.bossEveryWave ? this.state.wave - 1 : 0)) : Math.min(5, 2 + Math.floor(this.state.wave / 5));
    const entries: Entry[] = [];
    for (let tries = 0; entries.length < heads && tries < 40; tries++) {
      const e = this.draw(false);
      const len = countTyped(stripHints(e[targetLang(this.settings.direction)]));
      if ((len <= 8 || tries > 30) && !entries.includes(e)) entries.push(e);
    }
    this.create('balaur', entries);
  }

  private makeTag(kind: string) {
    const tag = document.createElement('div');
    tag.className = `tag ${kind}`;
    this.tags.appendChild(tag);
    return tag;
  }

  private create(kind: EnemyKind, entries: Entry[]) {
    this.spawned++;
    const { direction, shields } = this.settings;
    const src = sourceLang(direction);
    const dst = targetLang(direction);
    const first = entries[0];
    const root = new THREE.Group();
    this.engine.scene.add(root);
    const word = (layer: Layer, entry: Entry, text: string, slot: Slot): WordPart => {
      const part: WordPart = {
        layer,
        lang: layer === 'shield' ? src : dst,
        entry,
        glyphs: glyphs(stripHints(text)),
        hint: hintOf(text),
        pos: 0,
        mistakes: 0,
        slot,
        done: false,
        hidden: layer === 'core' && !!this.settings.run?.memory,
        peek: -1,
        missAt: 0,
      };
      skipUntyped(part);
      slot.parts.push(part);
      return part;
    };
    const slots: Slot[] = [];
    const parts: WordPart[] = [];
    let body: Model | undefined;
    let total = 0;

    if (kind === 'convoy') {
      // A row of pebbles, one per word of the translation, inside one long bubble carrying the source sentence.
      const words = stripHints(first[dst]).split(' ');
      const widths = words.map((w) => Math.max(2.8, w.length * 0.72 + 1.6));
      total = widths.reduce((a, b) => a + b, 0);
      let cursor = -total / 2;
      const banner: Slot = { anchor: root, radius: 1.9, tag: this.makeTag('sentence-banner'), parts: [], sx: 0, sy: 0, done: false };
      if (shields) {
        banner.bubble = makeBubble(1.9, total / 2 + 0.9);
        root.add(banner.bubble.root);
        for (const w of stripHints(first[src]).split(' ')) parts.push(word('shield', first, w, banner));
      } else banner.info = { lang: src, text: first[src] };
      slots.push(banner);
      for (let i = 0; i < words.length; i++) {
        const model = makeModel('rock');
        model.root.position.x = cursor + widths[i] / 2;
        cursor += widths[i];
        root.add(model.root);
        const slot: Slot = { anchor: model.root, model, radius: model.radius, tag: this.makeTag('rock'), parts: [], sx: 0, sy: 0, done: false };
        slots.push(slot);
        parts.push(word('core', first, words[i], slot));
      }
    } else {
      // One creature per entry (the balaur has several heads), each with its own bubble and its own pair of words.
      const widths = entries.map((e) => {
        const chars = Math.max(stripHints(e[dst]).length, stripHints(e[src]).length);
        return Math.max(kind === 'balaur' ? 4.4 : 3, chars * 0.72 + 2);
      });
      total = widths.reduce((a, b) => a + b, 0);
      let cursor = -total / 2;
      const headY = (x: number) => 3.6 - ((x * x) / (total * total)) * 3;
      const offsets = widths.map((w) => {
        const o = cursor + w / 2;
        cursor += w;
        return o;
      });
      if (kind === 'balaur') {
        body = makeBalaurBody(offsets.map((x) => ({ x, y: headY(x) })));
        root.add(body.root);
      }
      entries.forEach((e, i) => {
        const model = makeModel(kind === 'balaur' ? 'head' : (kind as Kind));
        if (kind === 'balaur') model.root.position.set(offsets[i], headY(offsets[i]), 0.4);
        root.add(model.root);
        const slot: Slot = { anchor: model.root, model, radius: model.radius, tag: this.makeTag(kind), parts: [], sx: 0, sy: 0, done: false };
        if (shields) {
          // Hug the creature: the dome (see shield.ts) reaches 1.54 r up and 0.88 r out, so size it to the taller of
          // its height and its girth. Hovering creatures (the moth) get their bubble lifted around the body.
          const h = (model as { height?: number }).height ?? model.radius * 2;
          slot.bubble = makeBubble(Math.max(model.radius * 1.05, h * 0.6));
          if (kind === 'bat') slot.bubble.root.position.y = h * 0.28;
          model.root.add(slot.bubble.root);
          parts.push(word('shield', e, e[src], slot));
        } else slot.info = { lang: src, text: e[src] };
        parts.push(word('core', e, e[dst], slot));
        slots.push(slot);
      });
    }

    // Scale the group up, but never wider than the screen (long sentences on a narrow phone).
    const scale = Math.min(CREATURE_SCALE, (this.halfWidth * 2 - 1.5) / Math.max(1, total));
    root.scale.setScalar(scale);
    for (const s of slots) s.radius *= scale;
    total *= scale;
    const letters = parts.reduce((n, p) => n + p.glyphs.filter((g) => g.typed).length, 0);
    // Keep the creature and its word tag inside the field: groups by their width, single creatures by their word.
    const chars = Math.max(...entries.map((e) => Math.max(stripHints(e[dst]).length, stripHints(e[src]).length)));
    const group = kind === 'convoy' || kind === 'balaur';
    const margin = Math.min(this.halfWidth - 0.5, group ? total / 2 + 0.6 : 1.2 + chars * 0.06);
    const lim = Math.max(0, this.halfWidth - margin);
    const startY = this.top + (kind === 'balaur' ? 5 : 2);
    // Spread out: of a few candidate lanes, take the one farthest from creatures already near the same depth.
    let x = 0;
    if (kind !== 'balaur') {
      let best = -1;
      const LANES = 9;
      for (let i = 0; i < LANES; i++) {
        const cx = -lim + ((i + 0.2 + Math.random() * 0.6) / LANES) * 2 * lim;
        let d = 99;
        for (const o of this.enemies) d = Math.min(d, Math.abs(cx - this.laneX(o)) + Math.abs(startY - o.y) * 0.45);
        if (d > best) {
          best = d;
          x = cx;
        }
      }
    }
    // Drift a little towards the middle on the way down, never all into one column.
    const aimX = group ? x * 0.6 : THREE.MathUtils.clamp(x * 0.7 + (Math.random() * 2 - 1) * 1.5, -lim, lim);
    const diff = DIFF[this.settings.difficulty];
    const waveFactor = Math.min(2.3, 1 + (this.state.wave - 1) * 0.08);
    // Never faster than a learner at this difficulty can type it, plus a few seconds to read.
    const typeTime = letters / diff.cps + (parts.length > 2 ? 6 : 3);
    const levelSpeed = this.settings.run?.speed ?? 1;
    const time = Math.max((FALL_TIME[kind] * diff.time) / (kind === 'balaur' ? levelSpeed : waveFactor * levelSpeed), typeTime);
    const enemy: Enemy = {
      id: this.nextId++,
      kind,
      entry: first,
      slots,
      parts,
      partIdx: 0,
      root,
      body,
      x,
      y: startY,
      aimX,
      speed: (startY - IMPACT_Y) / time,
      phase: Math.random() * 10,
      mistakes: 0,
    };
    this.enemies.push(enemy);
    for (const s of slots) this.renderTag(enemy, s);
    if (!this.seen.has(kind)) {
      this.seen.add(kind);
      const en = kind === 'balaur' ? 'The dragon appeared!' : kind === 'convoy' ? 'A pebble parade appeared!' : `A wild ${NAMES[kind][1]} appeared!`;
      this.state = { ...this.state, toast: { ro: APPEARS[kind], en, n: this.spawned } };
      sfx.play('appear');
      this.emit();
    }
  }

  private clearEnemies() {
    for (const e of [...this.enemies]) this.remove(e);
    this.tags.querySelectorAll('.pop, .letter').forEach((p) => p.remove());
  }

  private remove(e: Enemy) {
    this.enemies.splice(this.enemies.indexOf(e), 1);
    for (const s of e.slots) s.tag.remove();
    this.engine.scene.remove(e.root);
    e.root.traverse((o) => {
      const geo = (o as THREE.Mesh).geometry;
      // Bubble geometry is shared by every bubble; everything else belongs to this creature.
      if (geo && !geo.userData.shared) geo.dispose();
    });
    if (this.targetId === e.id) this.targetId = 0;
  }

  // ---- typing --------------------------------------------------------------------------------------------------

  /** The closest enemy to the wall. A half-typed target keeps focus unless another one is clearly closer. */
  private pickTarget(): Enemy | undefined {
    let best: Enemy | undefined;
    for (const e of this.enemies) if (!best || e.y < best.y) best = e;
    const current = this.enemies.find((e) => e.id === this.targetId);
    if (current && best && current !== best) {
      const part = current.parts[current.partIdx];
      const started = current.partIdx > 0 || part.pos > firstTyped(part.glyphs);
      if (started && current.y - best.y < 1.2) best = current;
    }
    if (best && best.id !== this.targetId) {
      const old = this.enemies.find((e) => e.id === this.targetId);
      this.targetId = best.id;
      if (old) for (const s of old.slots) this.renderTag(old, s);
      for (const s of best.slots) this.renderTag(best, s);
      this.emit();
    }
    return best;
  }

  type(ch: string) {
    if (this.state.phase !== 'playing') return;
    sfx.unlock();
    if (!ch.trim()) return;
    const enemy = this.pickTarget();
    if (!enemy) return;
    const part = enemy.parts[enemy.partIdx];
    const want = part?.glyphs[part.pos];
    if (!want) return;
    let { score, combo, typed, errors, destroyed } = this.state;
    typed++;
    if (!matches(want.ch, ch, this.settings.lenient)) {
      errors++;
      enemy.mistakes++;
      part.mistakes++;
      this.zapPitch = 1;
      sfx.play('miss');
      this.world.oops();
      this.noteMissed(part.entry, 5);
      part.slot.tag.classList.remove('wrong');
      void part.slot.tag.offsetWidth;
      part.slot.tag.classList.add('wrong');
      if (part.hidden && ++part.missAt >= 2) part.peek = part.pos;
      this.renderTag(enemy, part.slot);
      this.state = { ...this.state, combo: 0, multiplier: 1, typed, errors };
      const limit = this.settings.run?.maxErrors;
      if (limit !== undefined && errors >= limit) {
        this.gameOver('Prea multe greșeli · Too many typos');
        return;
      }
      this.emit();
      return;
    }

    part.pos++;
    part.missAt = 0;
    skipUntyped(part);
    combo++;
    const multiplier = Math.min(5, 1 + Math.floor(combo / 12));
    score += 10 * multiplier;
    this.zapPitch = Math.min(2, this.zapPitch + 0.04);
    const slot = part.slot;
    const at = this.slotPosition(slot, this.tmp);
    this.world.cast();
    this.effects.beam(this.world.muzzle(this.tmp2), at, part.layer === 'shield' ? 0x5fd0ff : 0xff6fb5);
    // The letter just typed flies off as a golden glyph.
    this.effects.sparkles(at, 3, 4, 0.18, want.ch);
    this.letterPop(slot, want.ch, part.layer);
    if (part.layer === 'shield') {
      sfx.play('tink', this.zapPitch);
      slot.bubble?.hit();
    } else {
      sfx.play('zap', this.zapPitch);
      slot.model?.hit();
    }

    if (part.pos >= part.glyphs.length) {
      part.done = true;
      enemy.partIdx++;
      if (part.layer === 'shield' && slot.parts.every((p) => p.layer !== 'shield' || p.done) && slot.bubble) {
        // Last shield word of this bubble: pop it.
        this.effects.pop(at, slot.radius * (slot.model ? 1.45 : 1));
        slot.bubble.root.removeFromParent();
        slot.bubble = undefined;
        sfx.play('pop');
        this.pop(at, 'POC!', 'pop-shield');
      }
      if (part.layer === 'core') {
        if (enemy.kind !== 'convoy') record(part.entry.id, this.settings.direction, part.mistakes === 0);
        slot.done = true;
        slot.tag.remove();
        if (slot.model) {
          slot.model.root.visible = false;
          this.effects.poof(at, slot.radius, slot.model.color);
        }
        this.pop(at, POOFS[(Math.random() * POOFS.length) | 0]);
        if (enemy.partIdx < enemy.parts.length) sfx.play('poof');
      }
      if (enemy.partIdx >= enemy.parts.length) {
        if (enemy.kind === 'convoy') record(enemy.entry.id, this.settings.direction, enemy.mistakes === 0);
        if (enemy.body) {
          this.effects.poof(enemy.root.position, 3.2, 0x5fd68a);
          this.pop(enemy.root.position, 'VICTORIE!', 'pop-big');
        }
        sfx.play(enemy.kind === 'zmeu' || enemy.kind === 'convoy' || enemy.kind === 'balaur' ? 'bigpoof' : 'poof');
        score += this.killBonus(enemy) * multiplier;
        destroyed++;
        this.remove(enemy);
      } else for (const s of enemy.slots) if (!s.done) this.renderTag(enemy, s);
    } else this.renderTag(enemy, slot);
    this.state = { ...this.state, score, combo, multiplier, typed, destroyed };
    this.emit();
  }

  /** Remember a word the player struggled with: listed at game over and served again a few enemies later. */
  private noteMissed(entry: Entry, after: number) {
    const m = this.missed.get(entry.id) ?? { entry, count: 0 };
    m.count++;
    this.missed.set(entry.id, m);
    if (!this.review.some((r) => r.entry.id === entry.id)) this.review.push({ entry, due: this.spawned + after });
  }

  /** The letter just shot flies off its tag. */
  private letterPop(slot: Slot, ch: string, layer: Layer) {
    const el = document.createElement('div');
    el.className = `letter ${layer}`;
    el.textContent = ch;
    el.style.left = `${slot.sx}px`;
    el.style.top = `${slot.sy}px`;
    el.style.setProperty('--dx', `${((Math.random() - 0.5) * 120).toFixed(0)}px`);
    el.style.setProperty('--rot', `${((Math.random() - 0.5) * 540).toFixed(0)}deg`);
    this.tags.appendChild(el);
    setTimeout(() => el.remove(), 650);
  }

  private killBonus(e: Enemy) {
    const letters = e.parts.reduce((n, p) => n + p.glyphs.filter((g) => g.typed).length, 0);
    return letters * 5 + (e.mistakes === 0 ? 50 : 0) + (e.kind === 'balaur' ? 500 : 0);
  }

  private pop(at: THREE.Vector3, text: string, cls = '') {
    const el = document.createElement('div');
    el.className = `pop ${cls}`;
    el.textContent = text;
    const p = this.project(at);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.setProperty('--rot', `${(Math.random() - 0.5) * 24}deg`);
    this.tags.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  // ---- views ---------------------------------------------------------------------------------------------------

  /** The shield line and the word line for a group of parts; the first unfinished one is active. */
  private lines(e: Enemy, group: WordPart[], info?: { lang: Lang; text: string }): LineView[] {
    const current = e.id === this.targetId ? e.parts[e.partIdx] : undefined;
    const out: LineView[] = [];
    if (info) {
      out.push({ lang: info.lang, words: [{ glyphs: glyphs(stripHints(info.text)), pos: 0, hint: hintOf(info.text) }], state: 'info', current: -1, shield: false });
    }
    let open = false;
    for (const layer of ['shield', 'core'] as const) {
      const ps = group.filter((p) => p.layer === layer);
      if (!ps.length) continue;
      const done = ps.every((p) => p.done);
      // Convoy pebbles only hold core words, but they still wait for the sentence bubble to pop.
      const blocked = layer === 'core' && e.parts.some((p) => p.layer === 'shield' && !p.done && p.slot !== ps[0].slot && e.kind === 'convoy');
      const state = done ? 'done' : !open && !blocked ? 'active' : 'waiting';
      if (state === 'active') open = true;
      out.push({
        lang: ps[0].lang,
        words: ps.map((p) => ({ glyphs: p.glyphs, pos: p.pos, hint: p.hint, hidden: p.hidden, peek: p.peek })),
        state,
        current: current ? ps.indexOf(current) : -1,
        shield: layer === 'shield',
      });
    }
    return out;
  }

  private targetView(): TargetView | null {
    const e = this.enemies.find((x) => x.id === this.targetId);
    const part = e?.parts[e.partIdx];
    if (!e || !part) return null;
    const group = e.kind === 'convoy' ? e.parts : e.parts.filter((p) => p.slot === part.slot);
    const info = e.kind === 'convoy' ? e.slots[0].info : part.slot.info;
    return { kind: e.kind, name: NAMES[e.kind], lines: this.lines(e, group, info) };
  }

  private renderTag(e: Enemy, slot: Slot) {
    const isTarget = e.id === this.targetId;
    slot.tag.classList.toggle('target', isTarget);
    slot.tag.classList.toggle('shielded', !!slot.bubble);
    slot.tag.innerHTML = this.lines(e, slot.parts, slot.info)
      .map((line) => {
        const words = line.words.map((w, wi) => {
          const live = line.state === 'active' && wi === line.current;
          const chars = w.glyphs
            .map((g, i) => {
              const ch = w.hidden && i >= w.pos && i > (w.peek ?? -1) && g.typed ? '_' : g.ch;
              return `<span class="${i < w.pos ? 'done' : live && i === w.pos ? 'cur' : ''}">${escape(ch)}</span>`;
            })
            .join('');
          const hint = w.hint ? `<small>${escape(w.hint)}</small>` : '';
          return `<span class="w">${chars}${hint}</span>`;
        });
        return `<div class="line ${line.state}${line.shield ? ' shield' : ''}"><b>${line.lang.toUpperCase()}</b>${words.join(' ')}</div>`;
      })
      .join('');
  }

  private project(v: THREE.Vector3) {
    const p = this.tmp2.copy(v).project(this.engine.camera);
    const el = this.engine.renderer.domElement;
    return { x: (p.x * 0.5 + 0.5) * el.clientWidth, y: (-p.y * 0.5 + 0.5) * el.clientHeight };
  }

  /** Height of a slot's creature above its origin, in world units (falls back to its diameter). */
  private slotHeight(slot: Slot) {
    if (!slot.model) return slot.radius;
    const h = (slot.model as { height?: number }).height;
    return h !== undefined ? h * slot.anchor.getWorldScale(this.tmpScale).y : slot.radius * 2;
  }

  /** Where beams hit a slot: the middle of its creature's body. */
  private slotPosition(slot: Slot, out: THREE.Vector3) {
    slot.anchor.getWorldPosition(out);
    out.y += slot.model ? this.slotHeight(slot) * 0.5 : 0.5;
    return out;
  }

  // ---- frame ---------------------------------------------------------------------------------------------------

  /**
   * Frame the field from high above and in front, with a fixed pitch. The camera height is solved so the defenders'
   * front edge sits right above the word panel, at least MIN_FIELD of the field shows below the HUD and at least
   * MIN_HALF_WIDTH of its width shows at the defence line (narrow phones then look from higher up). For a pixel row
   * at NDC v, the ray dips `pitch - atan(v tan(fov/2))` below the horizon and meets the floor `h / tan(dip)` ahead of
   * the camera, so both constraints are linear in the height h.
   */
  private placeCamera() {
    const cam = this.engine.camera;
    const el = this.engine.renderer.domElement;
    const H = el.clientHeight || 1;
    const W = el.clientWidth || 1;
    const aspect = W / H;
    const tanF = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const pitch = THREE.MathUtils.lerp(PITCH_PORTRAIT, PITCH_LANDSCAPE, THREE.MathUtils.clamp((aspect - 0.5) / 0.8, 0, 1));
    const bottomPx = Math.max(H * 0.45, H - this.insets.bottom - 6);
    const topPx = Math.min(H * 0.3, this.insets.top * 0.55 + 4);
    const vb = 1 - (2 * bottomPx) / H;
    const vt = 1 - (2 * topPx) / H;
    const dipB = pitch - Math.atan(vb * tanF);
    const dipT = Math.max(0.2, pitch - Math.atan(vt * tanF));
    const zB = LINE_Z + DEFENDER_FRONT;
    // Field length visible past the line: (zB - LINE_Z) is lost in front, then h * kL.
    const kL = 1 / Math.tan(dipT) - 1 / Math.tan(dipB);
    // Depth of the line point along the view axis: (DEFENDER_FRONT + h / tan(dipB)) cos(pitch) + h sin(pitch).
    const kD = Math.cos(pitch) / Math.tan(dipB) + Math.sin(pitch);
    const hLen = (MIN_FIELD + DEFENDER_FRONT) / kL;
    const hWide = (MIN_HALF_WIDTH / (tanF * aspect) - DEFENDER_FRONT * Math.cos(pitch)) / kD;
    const h = Math.max(hLen, hWide, 6);
    cam.position.set(0, h, zB + h / Math.tan(dipB));
    cam.rotation.set(-pitch, 0, 0);
    cam.updateMatrixWorld();
    // Creatures enter just under the HUD (never past the far end of the hall); spawns happen at `top + 2`.
    const visible = h * kL - DEFENDER_FRONT;
    // ...and low enough that their word tags clear the HUD.
    const spawnPx = Math.min(H * 0.4, Math.max(topPx, this.insets.top + TAG_ROOM));
    const dipS = Math.max(0.2, pitch - Math.atan((1 - (2 * spawnPx) / H) * tanF));
    const spawnVisible = h * (1 / Math.tan(dipS) - 1 / Math.tan(dipB)) - DEFENDER_FRONT;
    this.top = IMPACT_Y + Math.min(FIELD_LENGTH - 4, visible - 1.5, spawnVisible) - 2;
    const lineHalf = (DEFENDER_FRONT * Math.cos(pitch) + h * kD) * tanF * aspect;
    this.halfWidth = Math.min(FIELD_HALF - 0.6, lineHalf - 0.4);
  }

  private frame(dt: number, t: number) {
    this.placeCamera();
    const playing = this.state.phase === 'playing';
    const step = playing ? dt : 0;

    if (playing) {
      if (this.waveBreak > 0) {
        this.waveBreak -= dt;
        if (this.waveBreak <= 0 && this.state.banner) {
          this.state = { ...this.state, banner: null };
          this.emit();
        }
      } else if (this.bossPending) {
        this.bossPending = false;
        this.spawnBoss();
        this.spawnTimer = 8;
      } else if (this.waveLeft > 0) {
        this.spawnTimer -= dt;
        const maxAlive = Math.min(8, 3 + Math.floor(this.state.wave / 2));
        if (this.spawnTimer <= 0 && this.enemies.length < maxAlive) {
          this.spawn();
          this.waveLeft--;
          const gap = Math.max(1.2, 3.6 - this.state.wave * 0.17) * DIFF[this.settings.difficulty].time;
          this.spawnTimer = gap * (0.7 + Math.random() * 0.6) + (this.enemies.at(-1)?.kind === 'convoy' ? 3 : 0);
        }
      } else if (!this.enemies.length) this.nextWave();
      this.zapPitch = Math.max(1, this.zapPitch - dt * 0.6);
    }

    for (const e of [...this.enemies]) {
      e.y -= e.speed * step;
      let x = this.laneX(e);
      if (e.kind === 'bat') x += Math.sin(t * 2.3 + e.phase) * 0.7;
      if (e.kind === 'ghost') x += Math.sin(t * 1.2 + e.phase) * 0.9;
      if (e.kind === 'balaur') x = Math.sin(t * 0.5 + e.phase) * Math.max(0, this.halfWidth - 11) * 0.5;
      e.root.position.set(x, 0, fieldZ(e.y));
      for (const s of e.slots) {
        if (s.model && !s.done) s.model.animate(step, t);
        s.bubble?.update(dt, t);
      }
      e.body?.animate(step, t);
      if (playing && e.y <= IMPACT_Y) this.impact(e);
    }
    tickBubbles(t);
    this.effects.update(this.state.phase === 'paused' ? 0 : dt);
    if (playing) this.pickTarget();

    // The robot cannon follows the current target.
    const target = this.enemies.find((e) => e.id === this.targetId);
    if (target) {
      const part = target.parts[target.partIdx] ?? target.parts[0];
      this.aim.copy(this.slotPosition(part.slot, this.tmp));
    }
    this.world.aimAt(this.aim, dt);
    this.world.update(dt, t);

    // Camera shake after a bonk.
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.5);
      const s = this.shake * this.shake * 0.6;
      this.engine.camera.position.x += (Math.random() - 0.5) * s;
      this.engine.camera.position.y += (Math.random() - 0.5) * s;
      this.engine.camera.updateMatrixWorld();
    }
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.engine.container.parentElement?.style.setProperty('--hurt', this.hurtFlash.toFixed(3));

    this.positionTags();
  }

  /** Where a creature walks across the field at its current distance (before any per-kind sway). */
  private laneX(e: Enemy) {
    const progress = 1 - (e.y - IMPACT_Y) / (this.top + 2 - IMPACT_Y);
    return e.x + (e.aimX - e.x) * Math.max(0, progress);
  }

  private impact(e: Enemy) {
    const remaining = e.slots.filter((s) => s.model && !s.done).length;
    const damage = e.kind === 'convoy' ? remaining : e.kind === 'balaur' ? remaining + 1 : e.kind === 'zmeu' ? 2 : 1;
    const at = this.tmp.set(e.root.position.x, 0.4, LINE_Z);
    this.effects.dust(at, 1.8);
    this.pop(at, 'BONK!', 'pop-bonk');
    sfx.play('bonk');
    this.shake = 1;
    this.hurtFlash = 0.5;
    for (const p of e.parts) if (!p.done) this.noteMissed(p.entry, 4);
    this.remove(e);
    const hp = Math.max(0, this.state.hp - damage);
    this.state = { ...this.state, hp, combo: 0, multiplier: 1 };
    this.world.setDamage(hp / this.state.maxHp);
    if (hp <= 0) {
      this.gameOver();
      return;
    }
    this.emit();
  }

  /** Word tags float above their creatures like speech bubbles; a convoy's sentence banner floats above the pebbles' tags. */
  private positionTags() {
    const v = this.tmp;
    for (const e of this.enemies) {
      for (const s of e.slots) {
        if (s.done) continue;
        s.anchor.getWorldPosition(v);
        if (s.model) v.y += Math.max(this.slotHeight(s), s.bubble ? s.radius * 2.6 : 0) + 0.25;
        else v.y += s.radius * 1.6;
        const p = this.project(v);
        // Keep the tag on screen and below the HUD (its bottom edge is at p.y).
        const el = this.engine.renderer.domElement;
        p.x = Math.min(el.clientWidth - 64, Math.max(64, p.x));
        p.y = Math.max(this.insets.top + 40, p.y);
        s.sx = p.x;
        s.sy = p.y - 18;
        const shift = s.model ? '-100%' : 'calc(-100% - 2.6em)';
        s.tag.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, ${shift})`;
      }
    }
  }
}

const countTyped = (text: string) => glyphs(text).filter((g) => g.typed).length;

/** The "(hint)" parts of a text, shown small next to the word: "(to) eat" → "to". */
function hintOf(text: string) {
  const hints = [...text.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  return hints.length ? hints.join(', ') : undefined;
}

function firstTyped(g: Glyph[]) {
  const i = g.findIndex((x) => x.typed);
  return i < 0 ? g.length : i;
}

function skipUntyped(part: WordPart) {
  while (part.pos < part.glyphs.length && !part.glyphs[part.pos].typed) part.pos++;
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
