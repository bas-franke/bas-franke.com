// What the player has learned, per entry and direction, kept in localStorage: how often a word was destroyed and
// how often without a single typo. Two clean kills count as "mastered"; the deck serves unmastered words first.

import { ENTRIES, type Direction } from '../vocab';

const KEY = 'wordward:progress';
export const MASTERED_AT = 2;

type Record = { [entryAndDirection: string]: [clean: number, total: number] };

let cache: Record | null = null;

function read(): Record {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record;
  } catch {
    cache = {};
  }
  return cache!;
}

export function record(entryId: string, direction: Direction, clean: boolean) {
  const r = read();
  const k = `${direction}|${entryId}`;
  const [c, t] = r[k] ?? [0, 0];
  r[k] = [c + (clean ? 1 : 0), t + 1];
}

export function flush() {
  try {
    localStorage.setItem(KEY, JSON.stringify(read()));
  } catch {
    // Storage blocked or full: progress just is not remembered.
  }
}

export const isMastered = (entryId: string, direction: Direction) => (read()[`${direction}|${entryId}`]?.[0] ?? 0) >= MASTERED_AT;

export function masteredCount(direction: Direction, categories: string[]) {
  const cats = new Set(categories);
  return ENTRIES.filter((e) => cats.has(e.category) && isMastered(e.id, direction)).length;
}
