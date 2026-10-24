// What the player has learned, per entry and direction: how often a word was won without a single typo. Two clean
// wins count as "mastered"; the deck serves unmastered words first. Stored in the save (cookies + localStorage).

import { ENTRIES, type Direction } from '../vocab';
import { persist, save, update, wordHash } from './save';

export const MASTERED_AT = 2;

export function record(entryId: string, direction: Direction, clean: boolean) {
  update((d) => {
    const words = d.words[direction];
    const h = wordHash(entryId);
    words[h] = Math.min(3, (words[h] ?? 0) + (clean ? 1 : 0));
  });
}

export const flush = persist;

export const isMastered = (entryId: string, direction: Direction) => (save().words[direction][wordHash(entryId)] ?? 0) >= MASTERED_AT;

export function masteredCount(direction: Direction, categories: string[]) {
  const cats = new Set(categories);
  return ENTRIES.filter((e) => cats.has(e.category) && isMastered(e.id, direction)).length;
}
