// The vocabulary as typed entries, plus the rules for turning a line of text into the characters a player types.

import { WORDS_A } from './words-a';
import { WORDS_B } from './words-b';
import { SENTENCES } from './sentences';

export type Lang = 'en' | 'ro';
/** `en-ro`: you read English and type Romanian. `ro-en`: the other way round. */
export type Direction = 'en-ro' | 'ro-en';

export interface Entry {
  id: string;
  en: string;
  ro: string;
  category: string;
  sentence: boolean;
}

export interface Category {
  id: string;
  en: string;
  ro: string;
}

export const CATEGORIES: Category[] = [
  { id: 'basics', en: 'Basics', ro: 'De bază' },
  { id: 'numbers', en: 'Numbers', ro: 'Numere' },
  { id: 'colors', en: 'Colours', ro: 'Culori' },
  { id: 'family', en: 'Family', ro: 'Familie' },
  { id: 'people', en: 'People', ro: 'Oameni' },
  { id: 'body', en: 'Body', ro: 'Corp' },
  { id: 'food', en: 'Food', ro: 'Mâncare' },
  { id: 'drinks', en: 'Drinks', ro: 'Băuturi' },
  { id: 'produce', en: 'Fruit & veg', ro: 'Fructe și legume' },
  { id: 'animals', en: 'Animals', ro: 'Animale' },
  { id: 'nature', en: 'Nature', ro: 'Natură' },
  { id: 'weather', en: 'Weather', ro: 'Vreme' },
  { id: 'time', en: 'Time & dates', ro: 'Timp' },
  { id: 'home', en: 'Home', ro: 'Casă' },
  { id: 'clothing', en: 'Clothing', ro: 'Haine' },
  { id: 'places', en: 'Places', ro: 'Locuri' },
  { id: 'transport', en: 'Transport', ro: 'Transport' },
  { id: 'jobs', en: 'Jobs', ro: 'Meserii' },
  { id: 'school', en: 'School', ro: 'Școală' },
  { id: 'tech', en: 'Technology', ro: 'Tehnologie' },
  { id: 'hobbies', en: 'Hobbies', ro: 'Hobby-uri' },
  { id: 'health', en: 'Health', ro: 'Sănătate' },
  { id: 'shopping', en: 'Shopping', ro: 'Cumpărături' },
  { id: 'things', en: 'Things & legends', ro: 'Lucruri și legende' },
  { id: 'verbs', en: 'Verbs', ro: 'Verbe' },
  { id: 'adjectives', en: 'Adjectives', ro: 'Adjective' },
  { id: 'small', en: 'Small words', ro: 'Cuvinte mici' },
  { id: 'emotions', en: 'Feelings', ro: 'Sentimente' },
  { id: 'sentences', en: 'Sentences', ro: 'Propoziții' },
];

function parse(block: string, category: string, sentence: boolean): Entry[] {
  const out: Entry[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [en, ro] = line.split('|').map((s) => s.trim());
    if (!en || !ro) continue;
    out.push({ id: `${category}:${en}`, en, ro, category, sentence });
  }
  return out;
}

export const ENTRIES: Entry[] = [
  ...Object.entries({ ...WORDS_A, ...WORDS_B }).flatMap(([cat, block]) => parse(block, cat, false)),
  ...parse(SENTENCES, 'sentences', true),
];

export const countIn = (cats: string[]) => ENTRIES.filter((e) => cats.includes(e.category)).length;

export const sourceLang = (d: Direction): Lang => (d === 'en-ro' ? 'en' : 'ro');
export const targetLang = (d: Direction): Lang => (d === 'en-ro' ? 'ro' : 'en');

/** The text without its "(hint)" parts: what actually has to be typed. */
export const stripHints = (s: string) => s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

export interface Glyph {
  ch: string;
  /** Letters, digits, hyphens and apostrophes must be typed; spaces and punctuation are skipped for you. */
  typed: boolean;
}

export function glyphs(text: string): Glyph[] {
  return [...text].map((ch) => ({ ch, typed: /[\p{L}\p{N}'’-]/u.test(ch) }));
}

/** Lower case, and optionally without diacritics, so `a` matches `ă`/`â`, `s` matches `ș`, and so on. */
export function fold(ch: string, lenient: boolean): string {
  // Old cedilla forms (ş ţ) still come out of some keyboards; treat them as the correct comma-below letters.
  let c = ch.toLowerCase().replace('’', "'").replace('ş', 'ș').replace('ţ', 'ț');
  if (lenient) c = c.normalize('NFD').replace(/\p{M}/gu, '');
  return c;
}

export const matches = (want: string, got: string, lenient: boolean) => fold(want, lenient) === fold(got, lenient);
