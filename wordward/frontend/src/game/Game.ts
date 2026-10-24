// The game: spawns waves of word-carrying enemies, routes every typed character to the closest one, fires the laser,
// and keeps score. three.js draws the world; the word tags above enemies are plain DOM elements positioned each frame
// (crisp text in any script, cheap to restyle). React only renders menus and the HUD from `GameState` snapshots.

import * as THREE from 'three';
import { Engine } from './engine';
import { Effects } from './effects';
import { makeBalaurBody, makeModel, type Kind, type Model } from './enemies';
import { flush as flushProgress, isMastered, record } from './progress';
import { buildWorld, IMPACT_Y, type World } from './world';
import { sfx } from './audio';
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
} from '../vocab';

export type Mix = 'words' | 'mixed' | 'sentences';
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface Settings {
  direction: Direction;
  categories: string[];
  mix: Mix;
  difficulty: Difficulty;
  /** Accept plain letters for Romanian diacritics (a for ă/â, s for ș, ...). */
  lenient: boolean;
}

/** Every kind of enemy: a single-word model, a sentence convoy, or the boss. */
export type EnemyKind = Kind | 'convoy' | 'balaur';

export interface TargetView {
  source: string;
  /** The text being typed, as glyphs, and how many have been typed. For sentences: the current word. */
  glyphs: Glyph[];
  pos: number;
  /** Sentence progress: all words of the typed sentence and the index of the current one. */
  words?: string[];
  wordIdx?: number;
  kind: EnemyKind;
}

export interface Missed {
  entry: Entry;
  count: number;
}

export interface GameState {
  phase: 'idle' | 'playing' | 'paused' | 'over';
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
  /** Short message in the middle of the screen ("Valul 3"), with a counter so React can restart its animation. */
  banner: { text: string; sub: string; n: number } | null;
  missed: Missed[];
}

interface WordPart {
  /** The entry this word belongs to (each boss head has its own; convoy rocks share the sentence). */
  entry: Entry;
  source: string;
  glyphs: Glyph[];
  mistakes: number;
  /** Last on-screen position of its tag, for letter pops. */
  sx: number;
  sy: number;
  pos: number;
  model: Model;
  /** Offset from the enemy centre (sentences are a row of rocks). */
  offset: number;
  tag: HTMLElement;
  done: boolean;
}

interface Enemy {
  id: number;
  kind: EnemyKind;
  entry: Entry;
  source: string;
  target: string;
  parts: WordPart[];
  partIdx: number;
  root: THREE.Group;
  x: number;
  y: number;
  /** Where on the wall it is heading. */
  aimX: number;
  speed: number;
  phase: number;
  /** A tag under a sentence convoy showing the whole source sentence. */
  banner?: HTMLElement;
  /** The boss's body, which the heads sit on. */
  body?: Model;
  mistakes: number;
}

const MAX_HP = 10;
const DIFF = {
  easy: { time: 1.35, cps: 1.4 },
  normal: { time: 1, cps: 2.2 },
  hard: { time: 0.75, cps: 3.2 },
};
/** Seconds an enemy of each kind takes to fall the whole screen at wave 1 on normal. */
const FALL_TIME: Record<EnemyKind, number> = { bat: 13, meteor: 16, ghost: 18, zmeu: 22, rock: 16, head: 22, convoy: 30, balaur: 55 };
const POPS = ['BUM!', 'PAC!', 'POC!', 'ZBANG!', 'BAM!', 'TRANC!', 'PUF!'];

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
  private spawned = 0;
  private waveLeft = 0;
  private spawnTimer = 0;
  private waveBreak = 0;
  private bossPending = false;
  private targetId = 0;
  private shake = 0;
  private hurtFlash = 0;
  private aim = new THREE.Vector3(0, 20, 0);
  private zapPitch = 1;
  private halfWidth = 14;
  private top = 26;
  private missed = new Map<string, Missed>();
  private listeners = new Set<(s: GameState) => void>();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  state: GameState = {
    phase: 'idle',
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
    missed: [],
  };

  constructor(container: HTMLElement, tags: HTMLElement) {
    this.engine = new Engine(container, { fov: 45, shadows: false });
    this.tags = tags;
    this.world = buildWorld(this.engine.scene);
    this.effects = new Effects(this.engine.scene);
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

  dispose() {
    this.clearEnemies();
    this.engine.dispose();
  }

  // ---- rounds --------------------------------------------------------------------------------------------------

  start(settings: Settings) {
    this.settings = settings;
    this.clearEnemies();
    this.effects.clear();
    const pool = ENTRIES.filter((e) => settings.categories.includes(e.category));
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
    this.spawned = 0;
    this.targetId = 0;
    this.state = { ...this.state, phase: 'playing', hp: MAX_HP, score: 0, wave: 0, combo: 0, multiplier: 1, typed: 0, errors: 0, destroyed: 0, banner: null };
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
    this.state = { ...this.state, phase: 'idle', banner: null };
    this.emit();
  }

  private nextWave() {
    const wave = this.state.wave + 1;
    const boss = wave % 5 === 0 && this.settings.mix !== 'sentences';
    this.bossPending = boss;
    this.waveLeft = Math.min(32, 5 + wave * 2) - (boss ? 6 : 0);
    this.waveBreak = 2.6;
    this.spawnTimer = 0;
    if (wave > 1) flushProgress();
    const heal = wave > 1 && this.state.hp < MAX_HP;
    if (heal) sfx.play('heal');
    this.state = {
      ...this.state,
      wave,
      hp: heal ? this.state.hp + 1 : this.state.hp,
      banner: boss
        ? { text: 'Balaurul!', sub: `Wave ${wave} · the many-headed dragon${heal ? ' · +1 ♥' : ''}`, n: wave }
        : { text: `Valul ${wave}`, sub: wave === 1 ? 'Wave 1 — apără cetatea!' : `Wave ${wave}${heal ? ' · +1 ♥' : ''}`, n: wave },
    };
    this.world.setDamage(this.state.hp / MAX_HP);
    if (wave > 1) sfx.play('wave');
    this.emit();
  }

  private gameOver() {
    flushProgress();
    sfx.play('lose');
    // Everything still in the air goes up in flames with the citadel.
    for (const e of [...this.enemies]) {
      this.effects.explode(e.root.position, 1.2);
      this.remove(e);
    }
    this.state = { ...this.state, phase: 'over', hp: 0, banner: null };
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
    const heads = Math.min(5, 2 + Math.floor(this.state.wave / 5));
    const entries: Entry[] = [];
    for (let tries = 0; entries.length < heads && tries < 40; tries++) {
      const e = this.draw(false);
      const len = countTyped(stripHints(e[targetLang(this.settings.direction)]));
      if ((len <= 9 || tries > 30) && !entries.includes(e)) entries.push(e);
    }
    this.create('balaur', entries);
  }

  private create(kind: EnemyKind, entries: Entry[]) {
    this.spawned++;
    const { direction } = this.settings;
    const first = entries[0];
    const source = first[sourceLang(direction)];
    const target = stripHints(first[targetLang(direction)]);
    // A sentence is one rock per word; the boss is one head per entry; anything else is a single word.
    const words =
      kind === 'convoy'
        ? target.split(' ').map((text) => ({ entry: first, source, text }))
        : entries.map((e) => ({ entry: e, source: e[sourceLang(direction)], text: stripHints(e[targetLang(direction)]) }));

    const root = new THREE.Group();
    this.engine.scene.add(root);
    // Lay the words out left to right, spaced by word length so their tags do not overlap.
    const widths = words.map((w) => {
      const chars = kind === 'balaur' ? Math.max(w.text.length, w.source.length * 0.8) : w.text.length;
      return Math.max(kind === 'balaur' ? 4.2 : 3, chars * 0.78 + 1.8);
    });
    const total = widths.reduce((a, b) => a + b, 0);
    let cursor = -total / 2;
    const offsets = widths.map((w) => {
      const o = cursor + w / 2;
      cursor += w;
      return o;
    });
    // Boss heads rise in an arch over the body.
    const headY = (x: number) => 3.4 - ((x * x) / (total * total)) * 3;
    let body: Model | undefined;
    if (kind === 'balaur') {
      body = makeBalaurBody(offsets.map((x) => ({ x, y: headY(x) })));
      root.add(body.root);
    }
    const parts: WordPart[] = words.map((w, i) => {
      const model = makeModel(kind === 'convoy' ? 'rock' : kind === 'balaur' ? 'head' : kind);
      model.root.position.set(offsets[i], kind === 'balaur' ? headY(offsets[i]) : 0, kind === 'balaur' ? 0.4 : 0);
      root.add(model.root);
      const tag = document.createElement('div');
      tag.className = `tag ${kind}`;
      this.tags.appendChild(tag);
      const part: WordPart = {
        entry: w.entry,
        source: w.source,
        glyphs: glyphs(w.text),
        pos: 0,
        mistakes: 0,
        sx: 0,
        sy: 0,
        model,
        offset: offsets[i],
        tag,
        done: false,
      };
      skipUntyped(part);
      return part;
    });

    const letters = parts.reduce((n, p) => n + p.glyphs.filter((g) => g.typed).length, 0);
    const margin = Math.min(this.halfWidth - 1, total / 2 + 2.5);
    const x = kind === 'balaur' ? 0 : (Math.random() * 2 - 1) * Math.max(0, this.halfWidth - margin);
    const aimX = kind === 'convoy' || kind === 'balaur' ? x * 0.6 : (Math.random() * 2 - 1) * Math.min(this.halfWidth * 0.8, 14);
    const diff = DIFF[this.settings.difficulty];
    const waveFactor = Math.min(2.3, 1 + (this.state.wave - 1) * 0.08);
    // Never faster than a learner at this difficulty can type it, plus a few seconds to read.
    const typeTime = letters / diff.cps + (parts.length > 1 ? 6 : 3);
    const time = Math.max((FALL_TIME[kind] * diff.time) / (kind === 'balaur' ? 1 : waveFactor), typeTime);
    const startY = this.top + (kind === 'balaur' ? 5 : 2);
    const enemy: Enemy = {
      id: this.nextId++,
      kind,
      entry: first,
      source,
      target,
      parts,
      partIdx: 0,
      root,
      x,
      y: startY,
      aimX,
      speed: (startY - IMPACT_Y) / time,
      phase: Math.random() * 10,
      mistakes: 0,
      body,
    };
    if (kind === 'convoy') {
      enemy.banner = document.createElement('div');
      enemy.banner.className = 'tag sentence-banner';
      enemy.banner.textContent = source;
      this.tags.appendChild(enemy.banner);
    }
    this.enemies.push(enemy);
    for (const p of parts) this.renderTag(enemy, p);
  }

  private clearEnemies() {
    for (const e of [...this.enemies]) this.remove(e);
    this.tags.querySelectorAll('.pop').forEach((p) => p.remove());
  }

  private remove(e: Enemy) {
    this.enemies.splice(this.enemies.indexOf(e), 1);
    for (const p of e.parts) p.tag.remove();
    e.banner?.remove();
    this.engine.scene.remove(e.root);
    e.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
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
      const started = part.pos > firstTyped(part.glyphs) || current.partIdx > 0;
      if (started && current.y - best.y < 1.2) best = current;
    }
    if (best && best.id !== this.targetId) {
      const old = this.enemies.find((e) => e.id === this.targetId);
      this.targetId = best.id;
      if (old) for (const p of old.parts) this.renderTag(old, p);
      for (const p of best.parts) this.renderTag(best, p);
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
    const want = part.glyphs[part.pos];
    if (!want) return;
    let { score, combo, typed, errors, destroyed } = this.state;
    typed++;
    if (matches(want.ch, ch, this.settings.lenient)) {
      part.pos++;
      skipUntyped(part);
      combo++;
      const multiplier = Math.min(5, 1 + Math.floor(combo / 12));
      score += 10 * multiplier;
      this.zapPitch = Math.min(2, this.zapPitch + 0.04);
      sfx.play('zap', this.zapPitch);
      const at = this.partPosition(enemy, part, this.tmp);
      this.fire(at);
      this.effects.sparks(at, 4, 5);
      this.letterPop(part, want.ch);
      if (part.pos >= part.glyphs.length) {
        part.done = true;
        if (enemy.kind !== 'convoy') record(part.entry.id, this.settings.direction, part.mistakes === 0);
        part.tag.remove();
        part.model.root.visible = false;
        this.effects.explode(at, enemy.kind === 'convoy' ? 0.9 : part.model.radius, DEBRIS[enemy.kind]);
        this.pop(at, enemy.kind === 'zmeu' ? 'ZDRANG!' : POPS[(Math.random() * POPS.length) | 0]);
        enemy.partIdx++;
        if (enemy.partIdx >= enemy.parts.length) {
          if (enemy.kind === 'convoy') record(enemy.entry.id, this.settings.direction, enemy.mistakes === 0);
          if (enemy.body) {
            this.effects.explode(enemy.root.position, 3.2, 0x3fae6b);
            this.pop(enemy.root.position, 'VICTORIE!');
          }
          sfx.play(enemy.kind === 'zmeu' || enemy.kind === 'convoy' || enemy.kind === 'balaur' ? 'bigboom' : 'boom');
          score += this.killBonus(enemy) * multiplier;
          destroyed++;
          this.remove(enemy);
        } else sfx.play('boom');
      } else this.renderTag(enemy, part);
      this.state = { ...this.state, score, combo, multiplier, typed, destroyed };
    } else {
      errors++;
      enemy.mistakes++;
      part.mistakes++;
      this.zapPitch = 1;
      sfx.play('miss');
      this.noteMissed(part.entry, 5);
      part.tag.classList.remove('wrong');
      void part.tag.offsetWidth;
      part.tag.classList.add('wrong');
      this.state = { ...this.state, combo: 0, multiplier: 1, typed, errors };
    }
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
  private letterPop(part: WordPart, ch: string) {
    const el = document.createElement('div');
    el.className = 'letter';
    el.textContent = ch;
    el.style.left = `${part.sx}px`;
    el.style.top = `${part.sy}px`;
    el.style.setProperty('--dx', `${((Math.random() - 0.5) * 120).toFixed(0)}px`);
    el.style.setProperty('--rot', `${((Math.random() - 0.5) * 540).toFixed(0)}deg`);
    this.tags.appendChild(el);
    setTimeout(() => el.remove(), 650);
  }

  private killBonus(e: Enemy) {
    const letters = e.parts.reduce((n, p) => n + p.glyphs.filter((g) => g.typed).length, 0);
    return letters * 5 + (e.mistakes === 0 ? 50 : 0) + (e.kind === 'balaur' ? 500 : 0);
  }

  private fire(at: THREE.Vector3) {
    const from = this.world.muzzle(this.tmp2);
    this.effects.laser(from, at);
  }

  private pop(at: THREE.Vector3, text: string) {
    const el = document.createElement('div');
    el.className = 'pop';
    el.textContent = text;
    const p = this.project(at);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.setProperty('--rot', `${(Math.random() - 0.5) * 24}deg`);
    this.tags.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  private targetView(): TargetView | null {
    const e = this.enemies.find((x) => x.id === this.targetId);
    if (!e) return null;
    const part = e.parts[e.partIdx];
    if (!part) return null;
    return {
      source: part.source,
      glyphs: part.glyphs,
      pos: part.pos,
      kind: e.kind,
      words: e.kind === 'convoy' ? e.parts.map((p) => p.glyphs.map((g) => g.ch).join('')) : undefined,
      wordIdx: e.kind === 'convoy' ? e.partIdx : undefined,
    };
  }

  // ---- tags ----------------------------------------------------------------------------------------------------

  private renderTag(e: Enemy, part: WordPart) {
    const isTarget = e.id === this.targetId;
    const isNext = isTarget && e.parts[e.partIdx] === part;
    part.tag.classList.toggle('target', isTarget);
    part.tag.classList.toggle('next', isNext);
    const typed = part.glyphs.map((g, i) => {
      const cls = i < part.pos ? 'done' : i === part.pos && isNext ? 'cur' : '';
      return `<span class="${cls}">${escape(g.ch)}</span>`;
    });
    const src = e.kind === 'convoy' ? '' : `<div class="src">${escape(part.source)}</div>`;
    part.tag.innerHTML = `${src}<div class="dst">${typed.join('')}</div>`;
  }

  private project(v: THREE.Vector3) {
    const p = this.tmp2.copy(v).project(this.engine.camera);
    const el = this.engine.renderer.domElement;
    return { x: (p.x * 0.5 + 0.5) * el.clientWidth, y: (-p.y * 0.5 + 0.5) * el.clientHeight };
  }

  private partPosition(e: Enemy, part: WordPart, out: THREE.Vector3) {
    return part.model.root.getWorldPosition(out).setZ(e.root.position.z);
  }

  // ---- frame ---------------------------------------------------------------------------------------------------

  /** Frame the play area: the wall at the bottom of the screen, at least ~22 m of width visible on narrow screens. */
  private placeCamera() {
    const cam = this.engine.camera;
    const tan = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const minHalfW = 11.5;
    const halfH = Math.max(15, minHalfW / cam.aspect);
    const d = halfH / tan;
    const bottom = -2.6;
    const centerY = bottom + halfH;
    cam.position.set(0, centerY + 2.5, d);
    cam.lookAt(0, centerY, 0);
    this.top = bottom + halfH * 2 - 1.5;
    this.halfWidth = halfH * cam.aspect;
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
        const maxAlive = Math.min(9, 3 + Math.floor(this.state.wave / 2));
        if (this.spawnTimer <= 0 && this.enemies.length < maxAlive) {
          this.spawn();
          this.waveLeft--;
          const gap = Math.max(1, 3.4 - this.state.wave * 0.17) * DIFF[this.settings.difficulty].time;
          this.spawnTimer = gap * (0.7 + Math.random() * 0.6) + (this.enemies.at(-1)?.kind === 'convoy' ? 3 : 0);
        }
      } else if (!this.enemies.length) this.nextWave();
      this.zapPitch = Math.max(1, this.zapPitch - dt * 0.6);
    }

    for (const e of [...this.enemies]) {
      e.y -= e.speed * step;
      const progress = 1 - (e.y - IMPACT_Y) / (this.top + 2 - IMPACT_Y);
      let x = e.x + (e.aimX - e.x) * Math.max(0, progress);
      if (e.kind === 'bat') x += Math.sin(t * 2.3 + e.phase) * 1.2;
      if (e.kind === 'ghost') x += Math.sin(t * 1.2 + e.phase) * 1.6;
      if (e.kind === 'balaur') x = Math.sin(t * 0.5 + e.phase) * Math.max(0, this.halfWidth - 12) * 0.5;
      e.root.position.set(x, e.y, 0);
      for (const p of e.parts) if (!p.done) p.model.animate(step, t);
      e.body?.animate(step, t);
      if (playing && e.y <= IMPACT_Y) this.impact(e);
    }
    if (this.state.phase !== 'playing' && this.state.phase !== 'paused') this.effects.update(dt);
    else this.effects.update(step);
    if (playing) this.pickTarget();

    // Turret follows the current target.
    const target = this.enemies.find((e) => e.id === this.targetId);
    if (target) {
      const part = target.parts[target.partIdx] ?? target.parts[0];
      this.aim.lerp(this.partPosition(target, part, this.tmp), Math.min(1, dt * 14));
    }
    const head = this.world.head;
    const dir = this.tmp.copy(this.aim).sub(head.getWorldPosition(this.tmp2)).normalize();
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.world.update(dt, t);

    // Camera shake after a hit.
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.5);
      const s = this.shake * this.shake * 0.8;
      this.engine.camera.position.x += (Math.random() - 0.5) * s;
      this.engine.camera.position.y += (Math.random() - 0.5) * s;
    }
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.engine.container.parentElement?.style.setProperty('--hurt', this.hurtFlash.toFixed(3));

    this.positionTags();
  }

  private impact(e: Enemy) {
    const remaining = e.parts.filter((p) => !p.done).length;
    const damage = e.kind === 'convoy' ? remaining : e.kind === 'balaur' ? remaining + 1 : e.kind === 'zmeu' ? 2 : 1;
    const at = this.tmp.set(e.root.position.x, IMPACT_Y, 0.5);
    this.effects.explode(at, 1.8, 0xb99c74);
    sfx.play('hurt');
    this.shake = 1;
    this.hurtFlash = 0.5;
    if (e.kind === 'convoy') this.noteMissed(e.entry, 4);
    else for (const p of e.parts) if (!p.done) this.noteMissed(p.entry, 4);
    this.remove(e);
    const hp = Math.max(0, this.state.hp - damage);
    this.state = { ...this.state, hp, combo: 0, multiplier: 1 };
    this.world.setDamage(hp / MAX_HP);
    if (hp <= 0) {
      this.gameOver();
      return;
    }
    this.emit();
  }

  private positionTags() {
    const v = this.tmp;
    for (const e of this.enemies) {
      for (const p of e.parts) {
        if (p.done) continue;
        p.model.root.getWorldPosition(v);
        v.y -= p.model.radius + 0.3;
        const s = this.project(v);
        p.sx = s.x;
        p.sy = s.y + 18;
        p.tag.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, 0)`;
      }
      if (e.banner) {
        // Under the row of word tags, so it never hides behind the HUD while the convoy enters at the top.
        v.copy(e.root.position);
        v.y -= 1.2;
        const s = this.project(v);
        e.banner.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, 2.4em)`;
        e.banner.classList.toggle('target', e.id === this.targetId);
      }
    }
  }
}

const DEBRIS: Record<EnemyKind, number> = {
  bat: 0x4a3070,
  ghost: 0xd8fff4,
  zmeu: 0x3fae6b,
  head: 0x3fae6b,
  balaur: 0x3fae6b,
  meteor: 0x8a5a9c,
  rock: 0x8a5a9c,
  convoy: 0x8a5a9c,
};

const countTyped = (text: string) => glyphs(text).filter((g) => g.typed).length;

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
