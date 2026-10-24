// Menu-side persistence and helpers outside the career save: quick race / time trial settings, time trial records,
// and applying a finished race to the save exactly once (React may render or mount the results twice).

import { awardRace, cupById, cupUnlocked, loadCareer, saveCareer, CUPS, type CareerSave, type RaceAward } from '../core/career';
import type { RaceResult } from '../RaceView';
import type { RaceRequest } from './Menus';

export interface QuickSettings {
  trackId: string;
  laps: number;
  opponents: number;
  difficulty: number;
}

export const DIFFICULTIES = [
  { name: 'Rookie', skill: 0.3, upgrades: 0 },
  { name: 'Racer', skill: 0.55, upgrades: 1 },
  { name: 'Ace', skill: 0.75, upgrades: 3 },
  { name: 'Legend', skill: 0.95, upgrades: 5 },
];

export interface TrialRecord {
  /** Best lap and best full run (seconds), and the laps of that run. */
  lap: number | null;
  run: number | null;
  runLaps: number;
}

const QUICK_KEY = 'racer.quick.v1';
const TRIAL_KEY = 'racer.trials.v1';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: settings last for this visit */
  }
}

export function loadQuick(): QuickSettings {
  return read<QuickSettings>(QUICK_KEY, { trackId: 'redrock', laps: 3, opponents: 7, difficulty: 1 });
}
export function saveQuick(q: QuickSettings) {
  write(QUICK_KEY, q);
}

export function loadTrials(): Record<string, TrialRecord> {
  return read<Record<string, TrialRecord>>(TRIAL_KEY, {});
}

export interface Applied {
  /** Career races: the award and the save after it (null when the request no longer matches the save). */
  award: RaceAward | null;
  save: CareerSave | null;
  before: CareerSave | null;
  /** Cups that became enterable with this race. */
  unlocked: string[];
  /** Time trials: the record before this run, and which records it set. */
  trialBefore?: TrialRecord;
  newLapRecord?: boolean;
  newRunRecord?: boolean;
}

const applied = new WeakMap<RaceResult, Applied>();

/** Applies a finished race (career award, trial records) once per result object and returns what changed. */
export function applyFinished(req: RaceRequest, result: RaceResult): Applied {
  const done = applied.get(result);
  if (done) return done;
  let out: Applied = { award: null, save: loadCareer(), before: null, unlocked: [] };
  if (req.kind === 'career') {
    const s = loadCareer();
    const a = s?.active;
    const cup = a ? cupById(a.cupId) : null;
    // Only award when the save is still at the round this race was for.
    const matches = !!(s && a && cup && cup.tracks[a.round] === result.trackId && (req.cupId === undefined || (req.cupId === a.cupId && req.round === a.round)));
    if (s && matches) {
      const { save, award } = awardRace(s, result);
      saveCareer(save);
      const unlocked = CUPS.filter((c) => !cupUnlocked(s, c) && cupUnlocked(save, c)).map((c) => c.id);
      out = { award, save, before: s, unlocked };
    }
  } else if (req.kind === 'trial') {
    const all = loadTrials();
    const prev = all[result.trackId] ?? { lap: null, run: null, runLaps: 0 };
    const laps = req.laps ?? 0;
    const lap = Number.isFinite(result.playerBestLap) ? result.playerBestLap : null;
    const run = Number.isFinite(result.playerTime) ? result.playerTime : null;
    const newLapRecord = lap !== null && (prev.lap === null || lap < prev.lap);
    // Runs only compare at the same lap count.
    const newRunRecord = run !== null && (prev.run === null || prev.runLaps !== laps || run < prev.run);
    all[result.trackId] = {
      lap: newLapRecord ? lap : prev.lap,
      run: newRunRecord ? run : prev.run,
      runLaps: newRunRecord ? laps : prev.runLaps,
    };
    write(TRIAL_KEY, all);
    out = { ...out, trialBefore: prev, newLapRecord, newRunRecord };
  }
  applied.set(result, out);
  return out;
}

/** 83.456 -> "1:23.456". */
export function fmtTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export function fmtCredits(n: number): string {
  return n.toLocaleString('en-US');
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
