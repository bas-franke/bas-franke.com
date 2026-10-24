// Adventure mode: a path of themed levels from first words to everything at once. Each level is a few waves of words
// from its topics, ends with the balaur (except sentence-only levels), gets a little faster than the one before, and
// unlocks the next one when cleared. Stars per level and direction live in the save.

import type { Direction } from '../vocab';
import type { Mix } from './Game';
import { save, update } from './save';

export interface Level {
  id: string;
  /** 1-based position on the map. */
  n: number;
  emoji: string;
  ro: string;
  en: string;
  categories: string[];
  mix: Mix;
  waves: number;
  /** Fall speed multiplier: early levels are slow, late ones quick. */
  speed: number;
  /** Only sentences of at most this many words (for the first sentence level). */
  maxWords?: number;
  /** Heads on the final-wave balaur; 0 = no boss. */
  boss: number;
}

type Def = [id: string, emoji: string, ro: string, en: string, categories: string[], waves: number, mix?: Mix, maxWords?: number];

const DEFS: Def[] = [
  ['salut', '🐣', 'Salut!', 'Hello!', ['basics'], 3],
  ['numere', '🔢', 'Numere și culori', 'Numbers & colours', ['numbers', 'colors'], 3],
  ['familia', '👪', 'Familia', 'Family', ['family', 'people'], 3],
  ['masa', '🍎', 'La masă', 'At the table', ['food', 'drinks', 'produce'], 4],
  ['animale', '🐻', 'Animale', 'Animals', ['animals'], 4],
  ['propozitii1', '💬', 'Primele propoziții', 'First sentences', ['sentences'], 3, 'sentences', 3],
  ['acasa', '🏠', 'Acasă', 'At home', ['home', 'home2'], 4],
  ['haine', '👕', 'Haine', 'Clothes', ['clothing', 'clothing2'], 4],
  ['corp', '🙋', 'Corpul', 'The body', ['body', 'health'], 4],
  ['vreme', '🌦️', 'Vreme', 'Weather', ['weather', 'weather2'], 4],
  ['timp', '⏰', 'Timp', 'Time', ['time', 'time2'], 4],
  ['oras', '🏙️', 'Prin oraș', 'Around town', ['places', 'city2'], 5],
  ['drum', '🚌', 'La drum', 'On the road', ['transport', 'travel'], 5],
  ['verbe', '🏃', 'Verbe', 'Verbs', ['verbs'], 5],
  ['adjective', '✨', 'Adjective', 'Adjectives', ['adjectives'], 5],
  ['vorba', '🗣️', 'De vorbă', 'Small talk', ['phrases', 'questions', 'sentences'], 5, 'mixed', 4],
  ['cumparaturi', '🛒', 'Cumpărături', 'Shopping', ['shopping', 'shopping2'], 5],
  ['bucatarie', '🍳', 'Bucătărie', 'Cooking', ['kitchen', 'food2'], 5],
  ['scoala', '🏫', 'Școală', 'School', ['school', 'school2'], 5],
  ['meserii', '💼', 'Meserii', 'Jobs', ['jobs', 'jobs2', 'office'], 5],
  ['natura', '🌲', 'Natură', 'Nature', ['nature', 'nature2'], 5],
  ['salbatice', '🦊', 'Animale sălbatice', 'Wild animals', ['animals2'], 5],
  ['sport', '⚽', 'Sport și hobby', 'Sport & hobbies', ['sports', 'hobbies'], 5],
  ['arta', '🎻', 'Muzică și artă', 'Music & art', ['arts'], 5],
  ['suflet', '💗', 'Suflet', 'Heart & mind', ['emotions', 'character'], 5],
  ['online', '💻', 'Online', 'Online', ['tech', 'internet'], 5],
  ['sarbatori', '🎄', 'Sărbători', 'Holidays', ['holidays', 'romania'], 5],
  ['stiinta', '🧪', 'Știință și spațiu', 'Science & space', ['science', 'space'], 5],
  ['cetate', '🏰', 'Cetate', 'Castles & legends', ['castle', 'things'], 5],
  ['propozitii2', '📚', 'Propoziții', 'Sentences', ['sentences'], 5, 'sentences'],
  ['legaturi', '🔗', 'Cuvinte mici', 'Little words', ['small', 'adverbs'], 5],
  ['verbe2', '🤸', 'Mai multe verbe', 'More verbs', ['verbs2', 'verbs3'], 6],
  ['adjective2', '🎭', 'Mai multe adjective', 'More adjectives', ['adjectives2', 'nouns'], 6],
  ['lumea', '🌍', 'Lumea', 'The world', ['countries', 'society', 'numbers2'], 6],
  ['maestru', '🏆', 'Maestru', 'Master', [], 8, 'mixed'],
];

export const LEVELS: Level[] = DEFS.map(([id, emoji, ro, en, categories, waves, mix = 'words', maxWords], i) => ({
  id,
  n: i + 1,
  emoji,
  ro,
  en,
  categories,
  mix,
  waves,
  speed: 0.78 + i * 0.018,
  maxWords,
  boss: mix === 'sentences' ? 0 : i < 9 ? 3 : i < 20 ? 4 : 5,
}));

const key = (direction: Direction, id: string) => `${direction}:${id}`;

export const starsFor = (direction: Direction, id: string) => save().levels[key(direction, id)] ?? 0;

/** The first level is always open; every other one opens when the level before it has at least one star. */
export const isUnlocked = (direction: Direction, level: Level) => level.n === 1 || starsFor(direction, LEVELS[level.n - 2].id) > 0;

export function recordStars(direction: Direction, id: string, stars: number) {
  update((d) => {
    d.levels[key(direction, id)] = Math.max(d.levels[key(direction, id)] ?? 0, stars);
  });
}

export const totalStars = (direction: Direction) => LEVELS.reduce((n, l) => n + starsFor(direction, l.id), 0);
