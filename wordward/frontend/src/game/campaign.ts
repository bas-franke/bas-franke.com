// The adventure: a path through eight chapters (village → forest → home → town → school → fair → mountains →
// citadel). Each chapter has a handful of missions, a review mission built from the words you are weakest at, and a
// boss mission. Progress is not a straight line on purpose:
//   - every mission has variants (from memory, reversed, speed, no-typos, …) that open once its standard run is won;
//   - some missions only open after a *variant* of an earlier mission (sometimes from an earlier chapter), so you go
//     back and replay it differently;
//   - a chapter's boss needs a number of stars and variant wins from that chapter, so you redo missions to earn them.
// Stars per mission and variant live in the save, per direction.

import { ENTRIES, type Direction } from '../vocab';
import type { Mix, RunConfig } from './Game';
import { isMastered } from './progress';
import { save, update } from './save';

export type Variant = 'std' | 'memory' | 'reverse' | 'speed' | 'perfect';

export const VARIANTS: Record<Variant, { emoji: string; ro: string; en: string; desc: string }> = {
  std: { emoji: '⭐', ro: 'Normal', en: 'Standard', desc: 'Pop the bubble, then type the translation.' },
  memory: { emoji: '🧠', ro: 'Din memorie', en: 'From memory', desc: 'The translation is hidden: type it from memory. Two misses on a letter show it.' },
  reverse: { emoji: '🔄', ro: 'Invers', en: 'Reversed', desc: 'Same words, the other direction.' },
  speed: { emoji: '⚡', ro: 'Viteză', en: 'Speed', desc: 'Creatures fall much faster and the castle has only 5 HP.' },
  perfect: { emoji: '🎯', ro: 'Fără greșeli', en: 'No typos', desc: 'Three typos and the mission is over.' },
};

export type Requirement =
  | { mission: string; variant: Variant }
  | { stars: number }
  | { variants: number };

export interface Mission {
  id: string;
  chapter: number;
  /** Position on the whole path, 1-based. */
  n: number;
  kind: 'mission' | 'review' | 'boss';
  emoji: string;
  ro: string;
  en: string;
  categories: string[];
  mix: Mix;
  waves: number;
  maxWords?: number;
  variants: Variant[];
  requires: Requirement[];
}

export interface Chapter {
  n: number;
  emoji: string;
  ro: string;
  en: string;
  missions: Mission[];
}

type M = [id: string, emoji: string, ro: string, en: string, categories: string[], variants: Variant[], extra?: Partial<Mission>];
type C = [emoji: string, ro: string, en: string, missions: M[], boss: [ro: string, en: string, stars: number, variants: number]];

const need = (mission: string, variant: Variant): Requirement => ({ mission, variant });

const CHAPTERS_DEF: C[] = [
  ['🏡', 'Satul', 'The village', [
    ['salut', '🐣', 'Salut!', 'Hello!', ['basics'], ['std', 'memory', 'reverse'], { waves: 3 }],
    ['numere', '🔢', 'Numere și culori', 'Numbers & colours', ['numbers', 'colors'], ['std', 'memory', 'speed'], { waves: 3 }],
    ['familia', '👪', 'Familia', 'Family', ['family', 'people'], ['std', 'memory', 'reverse'], { waves: 3, requires: [need('salut', 'memory')] }],
    ['masa', '🍎', 'La masă', 'At the table', ['food', 'drinks', 'produce'], ['std', 'memory', 'speed']],
  ], ['Balaurul satului', 'The village dragon', 10, 2]],
  ['🌲', 'Pădurea', 'The forest', [
    ['animale', '🐻', 'Animale', 'Animals', ['animals'], ['std', 'memory', 'perfect']],
    ['natura', '🌼', 'Natură', 'Nature', ['nature'], ['std', 'reverse', 'speed']],
    ['vreme', '🌦️', 'Vreme', 'Weather', ['weather', 'weather2'], ['std', 'memory', 'perfect'], { requires: [need('animale', 'perfect')] }],
    ['propozitii1', '💬', 'Primele propoziții', 'First sentences', ['sentences'], ['std', 'memory', 'reverse'], { mix: 'sentences', maxWords: 3, waves: 3 }],
    ['salbatice', '🦊', 'Animale sălbatice', 'Wild animals', ['animals2'], ['std', 'speed', 'memory'], { requires: [need('natura', 'reverse')] }],
  ], ['Balaurul pădurii', 'The forest dragon', 14, 3]],
  ['🏠', 'Acasă', 'At home', [
    ['acasa', '🛋️', 'Prin casă', 'Around the house', ['home', 'home2'], ['std', 'memory', 'reverse']],
    ['haine', '👕', 'Haine', 'Clothes', ['clothing', 'clothing2'], ['std', 'speed', 'perfect']],
    ['corp', '🙋', 'Corpul', 'The body', ['body', 'health', 'body2'], ['std', 'memory', 'reverse'], { requires: [need('acasa', 'memory')] }],
    ['timp', '⏰', 'Timp', 'Time', ['time', 'time2'], ['std', 'memory', 'speed']],
    ['bucatarie', '🍳', 'Bucătărie', 'Cooking', ['kitchen', 'food2'], ['std', 'perfect', 'memory'], { requires: [need('masa', 'speed')] }],
  ], ['Balaurul din pod', 'The attic dragon', 15, 3]],
  ['🏙️', 'Orașul', 'The town', [
    ['oras', '🏛️', 'Prin oraș', 'Around town', ['places', 'city2'], ['std', 'memory', 'reverse']],
    ['drum', '🚌', 'La drum', 'On the road', ['transport', 'travel'], ['std', 'speed', 'memory']],
    ['cumparaturi', '🛒', 'Cumpărături', 'Shopping', ['shopping', 'shopping2'], ['std', 'perfect', 'reverse']],
    ['vorba', '🗣️', 'De vorbă', 'Small talk', ['phrases', 'questions', 'sentences'], ['std', 'memory', 'reverse'], { mix: 'mixed', maxWords: 4, requires: [need('propozitii1', 'memory')] }],
    ['numere2', '🧮', 'Numere mari', 'Big numbers', ['numbers2'], ['std', 'memory', 'perfect'], { requires: [need('numere', 'speed')] }],
  ], ['Balaurul din piață', 'The market dragon', 15, 4]],
  ['🏫', 'Școala', 'School', [
    ['scoala', '🎒', 'La școală', 'At school', ['school', 'school2'], ['std', 'memory', 'speed']],
    ['verbe', '🏃', 'Verbe', 'Verbs', ['verbs'], ['std', 'memory', 'speed']],
    ['adjective', '✨', 'Adjective', 'Adjectives', ['adjectives'], ['std', 'reverse', 'perfect'], { requires: [need('verbe', 'memory')] }],
    ['meserii', '💼', 'Meserii', 'Jobs', ['jobs', 'jobs2', 'office'], ['std', 'memory', 'reverse']],
    ['legaturi', '🔗', 'Cuvinte mici', 'Little words', ['small', 'adverbs'], ['std', 'perfect', 'memory'], { requires: [need('adjective', 'perfect')] }],
  ], ['Balaurul directorului', "The headmaster's dragon", 16, 4]],
  ['🎪', 'Târgul', 'The fair', [
    ['sport', '⚽', 'Sport și hobby', 'Sport & hobbies', ['sports', 'hobbies'], ['std', 'speed', 'memory']],
    ['arta', '🎻', 'Muzică și artă', 'Music & art', ['arts'], ['std', 'memory', 'reverse']],
    ['sarbatori', '🎄', 'Sărbători', 'Holidays', ['holidays', 'romania'], ['std', 'memory', 'perfect']],
    ['suflet', '💗', 'Suflet', 'Heart & mind', ['emotions', 'character'], ['std', 'reverse', 'memory'], { requires: [need('familia', 'reverse')] }],
    ['online', '💻', 'Online', 'Online', ['tech', 'internet'], ['std', 'speed', 'perfect']],
  ], ['Balaurul de la bâlci', 'The fairground dragon', 16, 5]],
  ['🏔️', 'Munții', 'The mountains', [
    ['stiinta', '🧪', 'Știință și spațiu', 'Science & space', ['science', 'space'], ['std', 'memory', 'reverse']],
    ['cetate', '🏰', 'Legende', 'Castles & legends', ['castle', 'things'], ['std', 'speed', 'perfect']],
    ['propozitii2', '📚', 'Propoziții', 'Sentences', ['sentences'], ['std', 'memory', 'reverse'], { mix: 'sentences', requires: [need('vorba', 'memory')] }],
    ['verbe2', '🤸', 'Mai multe verbe', 'More verbs', ['verbs2', 'verbs3'], ['std', 'memory', 'speed'], { waves: 6, requires: [need('verbe', 'speed')] }],
    ['adjective2', '🎭', 'Mai multe adjective', 'More adjectives', ['adjectives2', 'nouns'], ['std', 'reverse', 'perfect'], { waves: 6 }],
    ['lumea', '🌍', 'Lumea', 'The world', ['countries', 'society'], ['std', 'memory', 'reverse']],
  ], ['Balaurul munților', 'The mountain dragon', 20, 6]],
  ['🏰', 'Cetatea', 'The citadel', [
    ['maestru1', '📖', 'Toate cuvintele', 'Every word', [], ['std', 'memory', 'speed'], { waves: 6 }],
    ['maestru2', '📜', 'Toate propozițiile', 'Every sentence', ['sentences'], ['std', 'memory', 'reverse'], { mix: 'sentences', waves: 5 }],
    ['maestru3', '🏆', 'Maestru', 'Master', [], ['std', 'perfect', 'memory'], { mix: 'mixed', waves: 8, requires: [need('maestru1', 'memory')] }],
  ], ['Marele Balaur', 'The Great Dragon', 15, 4]],
];

export const CHAPTERS: Chapter[] = [];
export const MISSIONS: Mission[] = [];

CHAPTERS_DEF.forEach(([emoji, ro, en, defs, [bossRo, bossEn, bossStars, bossVariants]], ci) => {
  const chapter: Chapter = { n: ci + 1, emoji, ro, en, missions: [] };
  const add = (m: Omit<Mission, 'n' | 'chapter'>) => {
    const mission: Mission = { ...m, chapter: chapter.n, n: MISSIONS.length + 1 };
    MISSIONS.push(mission);
    chapter.missions.push(mission);
  };
  const cats = new Set<string>();
  for (const [id, memoji, mro, men, categories, variants, extra] of defs) {
    categories.forEach((c) => cats.add(c));
    add({ id, kind: 'mission', emoji: memoji, ro: mro, en: men, categories, mix: 'words', waves: 4 + Math.min(1, ci), variants, requires: [], ...extra });
  }
  add({
    id: `recap${chapter.n}`,
    kind: 'review',
    emoji: '🔁',
    ro: 'Recapitulare',
    en: `Review: ${en.toLowerCase()}`,
    categories: [...cats].filter((c) => c !== 'sentences'),
    mix: 'words',
    waves: 3,
    variants: ['std', 'memory'],
    requires: [],
  });
  add({
    id: `boss${chapter.n}`,
    kind: 'boss',
    emoji: '🐉',
    ro: bossRo,
    en: bossEn,
    categories: [...cats].filter((c) => c !== 'sentences'),
    mix: 'words',
    waves: 3,
    variants: ['std', 'perfect'],
    requires: [{ stars: bossStars }, { variants: bossVariants }],
  });
  CHAPTERS.push(chapter);
});

export const missionById = (id: string) => MISSIONS.find((m) => m.id === id);

// ---- progress ------------------------------------------------------------------------------------------------------

const key = (dir: Direction, id: string, v: Variant) => `${dir}:${id}:${v}`;

export function starsFor(dir: Direction, id: string, v: Variant = 'std'): number {
  const levels = save().levels;
  // Stars from the first adventure version (one star count per level) count as the standard variant.
  return Math.max(levels[key(dir, id, v)] ?? 0, v === 'std' ? (levels[`${dir}:${id}`] ?? 0) : 0);
}

export const cleared = (dir: Direction, id: string, v: Variant = 'std') => starsFor(dir, id, v) > 0;

export function recordStars(dir: Direction, id: string, v: Variant, stars: number) {
  update((d) => {
    d.levels[key(dir, id, v)] = Math.max(d.levels[key(dir, id, v)] ?? 0, stars);
  });
}

/** Stars and variant wins in one chapter, not counting the boss. */
export function chapterScore(dir: Direction, chapter: Chapter) {
  let stars = 0;
  let variants = 0;
  for (const m of chapter.missions) {
    if (m.kind === 'boss') continue;
    for (const v of m.variants) {
      const s = starsFor(dir, m.id, v);
      stars += s;
      if (v !== 'std' && s > 0) variants++;
    }
  }
  return { stars, variants };
}

export const maxChapterStars = (chapter: Chapter) =>
  chapter.missions.filter((m) => m.kind !== 'boss').reduce((n, m) => n + m.variants.length * 3, 0);

export function requirementMet(dir: Direction, mission: Mission, r: Requirement): boolean {
  if ('mission' in r) return cleared(dir, r.mission, r.variant);
  const score = chapterScore(dir, CHAPTERS[mission.chapter - 1]);
  return 'stars' in r ? score.stars >= r.stars : score.variants >= r.variants;
}

export function describe(dir: Direction, mission: Mission, r: Requirement): { text: string; progress?: string; goto?: string } {
  if ('mission' in r) {
    const m = missionById(r.mission)!;
    const v = VARIANTS[r.variant];
    return { text: `${v.emoji} ${m.ro} · ${v.ro}`, goto: m.id };
  }
  const score = chapterScore(dir, CHAPTERS[mission.chapter - 1]);
  if ('stars' in r) return { text: `⭐ ${r.stars} stele în capitol · stars in this chapter`, progress: `${Math.min(score.stars, r.stars)}/${r.stars}` };
  return { text: `🎭 ${r.variants} variante câștigate · variant wins`, progress: `${Math.min(score.variants, r.variants)}/${r.variants}` };
}

/** Open when the previous mission on the path is won (standard) and every requirement is met. */
export function isOpen(dir: Direction, mission: Mission): boolean {
  const prev = MISSIONS[mission.n - 2];
  if (prev && !cleared(dir, prev.id)) return false;
  return mission.requires.every((r) => requirementMet(dir, mission, r));
}

/** Variants open after the standard run is won. */
export const variantOpen = (dir: Direction, mission: Mission, v: Variant) => v === 'std' ? isOpen(dir, mission) : cleared(dir, mission.id);

export const totalStars = (dir: Direction) => MISSIONS.reduce((n, m) => n + m.variants.reduce((k, v) => k + starsFor(dir, m.id, v), 0), 0);
export const maxStars = MISSIONS.reduce((n, m) => n + m.variants.length * 3, 0);

/** The next thing to play: the first open mission whose standard run is not won yet. */
export const nextMission = (dir: Direction) => MISSIONS.find((m) => isOpen(dir, m) && !cleared(dir, m.id));

// ---- runs ------------------------------------------------------------------------------------------------------------

/** Turns a mission and variant into the settings the game runs with. */
export function runFor(dir: Direction, mission: Mission, variant: Variant): RunConfig {
  const base = 0.78 + (mission.n - 1) * 0.011;
  const heads = mission.chapter <= 2 ? 3 : mission.chapter <= 5 ? 4 : 5;
  const run: RunConfig = {
    missionId: mission.id,
    variant,
    n: mission.n,
    emoji: mission.emoji,
    ro: mission.ro,
    en: mission.en,
    categories: mission.categories,
    mix: mission.mix,
    waves: mission.waves,
    maxWords: mission.maxWords,
    speed: base,
    boss: mission.mix === 'sentences' ? 0 : heads,
    label: `Misiunea ${mission.n} · ${VARIANTS[variant].emoji} ${VARIANTS[variant].ro} · ${VARIANTS[variant].en}`,
  };
  if (mission.kind === 'boss') {
    run.bossEveryWave = true;
    run.boss = heads;
    run.speed = base + 0.05;
  }
  if (mission.kind === 'review') run.entries = reviewEntries(dir, mission.categories);
  switch (variant) {
    case 'memory':
      run.memory = true;
      run.speed *= 0.85;
      break;
    case 'reverse':
      run.direction = dir === 'en-ro' ? 'ro-en' : 'en-ro';
      break;
    case 'speed':
      run.speed *= 1.4;
      run.hp = 5;
      break;
    case 'perfect':
      run.maxErrors = 3;
      break;
  }
  return run;
}

/** Up to 40 random entries from these topics (all topics when empty) that the player has not mastered yet. */
function reviewEntries(dir: Direction, categories: string[]): string[] {
  const cats = new Set(categories);
  const pool = ENTRIES.filter((e) => (!cats.size || cats.has(e.category)) && !e.sentence);
  const weak = pool.filter((e) => !isMastered(e.id, dir));
  // Once nearly everything is mastered, review the whole chapter again.
  const list = weak.length >= 12 ? weak : pool;
  return list
    .map((e) => ({ id: e.id, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, 40)
    .map((e) => e.id);
}
