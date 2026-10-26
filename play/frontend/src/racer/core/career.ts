// Career mode: a ladder of cups (a few races each, points per placement, prize money per race), a garage to buy
// pods and upgrades with the winnings, and a roster of rival pilots who get faster cup by cup. Saved in
// localStorage; everything here is plain data and pure functions so the UI can render it and the race can use it.

import type { AiProfile } from './ai';
import { NO_UPGRADES, PODS, applyUpgrades, podById, type Upgrades } from './pods';
import type { RacerSetup } from './race';
import type { RaceResult } from '../RaceView';

export interface Cup {
  id: string;
  name: string;
  /** Class letter shown on badges. */
  tier: 'C' | 'B' | 'A' | 'S';
  blurb: string;
  tracks: string[];
  /** Racers including the player. */
  field: number;
  /** AI skill range and how much their pods are upgraded (levels in every category). */
  aiSkill: [number, number];
  aiUpgrades: number;
  /** Prize per race by finishing position (credits). */
  prize: number[];
  /** Bonus for winning the cup overall. */
  cupBonus: number;
  /** Cup that must be finished in the top 3 to enter this one. */
  requires?: string;
}

export const POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

export const CUPS: Cup[] = [
  {
    id: 'dust',
    name: 'Dust Cup',
    tier: 'C',
    blurb: 'Your first season on the circuit. Learn the lines.',
    tracks: ['redrock'],
    field: 6,
    aiSkill: [0.12, 0.4],
    aiUpgrades: 0,
    prize: [900, 600, 400, 250, 150, 100],
    cupBonus: 800,
  },
  {
    id: 'mesa',
    name: 'Mesa Cup',
    tier: 'B',
    blurb: 'Golden hour and longer straights. The field gets hungry.',
    tracks: ['redrock'],
    field: 7,
    aiSkill: [0.35, 0.62],
    aiUpgrades: 1,
    prize: [1400, 950, 650, 400, 250, 150, 100],
    cupBonus: 1500,
    requires: 'dust',
  },
  {
    id: 'canyon',
    name: 'Canyon Cup',
    tier: 'A',
    blurb: 'The pros. Every gap is contested.',
    tracks: ['redrock'],
    field: 8,
    aiSkill: [0.62, 0.86],
    aiUpgrades: 3,
    prize: [2200, 1500, 1000, 650, 400, 250, 150, 100],
    cupBonus: 2600,
    requires: 'mesa',
  },
  {
    id: 'sun',
    name: 'Sun Crown',
    tier: 'S',
    blurb: 'The championship. Five races for the crown.',
    tracks: ['redrock'],
    field: 8,
    aiSkill: [0.78, 1],
    aiUpgrades: 5,
    prize: [3500, 2400, 1600, 1000, 650, 400, 250, 150],
    cupBonus: 6000,
    requires: 'canyon',
  },
];

export interface Rival {
  id: string;
  name: string;
  pod: string;
  /** Personal colours override the pod's livery secondary for the HUD. */
  bias: number;
  aggression: number;
  /** Added to the cup's skill range position. */
  talent: number;
}

export const RIVALS: Rival[] = [
  { id: 'vex', name: 'Vex Arrano', pod: 'crimson', bias: -0.3, aggression: 0.9, talent: 0.3 },
  { id: 'mira', name: 'Mira Solenne', pod: 'tide', bias: 0.4, aggression: 0.5, talent: 0.25 },
  { id: 'kobb', name: 'Kobb Dardo', pod: 'gilded', bias: 0.1, aggression: 0.8, talent: 0.15 },
  { id: 'sila', name: 'Sila Quen', pod: 'viper', bias: -0.5, aggression: 0.7, talent: 0.2 },
  { id: 'tarr', name: 'Old Tarr', pod: 'ember', bias: 0.6, aggression: 0.3, talent: 0.05 },
  { id: 'nix', name: 'Nix Halloway', pod: 'viper', bias: 0.2, aggression: 0.6, talent: 0.1 },
  { id: 'dune', name: 'Dune Okoro', pod: 'gilded', bias: -0.1, aggression: 0.4, talent: 0 },
  { id: 'reza', name: 'Reza Vantt', pod: 'tide', bias: -0.6, aggression: 0.75, talent: 0.12 },
  { id: 'pell', name: 'Pell Fiddik', pod: 'ember', bias: 0.3, aggression: 0.2, talent: -0.05 },
];

export interface CupProgress {
  /** Best overall cup finish (1-based), null if never completed. */
  best: number | null;
}

export interface ActiveCup {
  cupId: string;
  /** Index of the next race. */
  round: number;
  /** Points per racer id ('player' for the player). */
  points: Record<string, number>;
  /** Placement of the player in each finished race. */
  results: number[];
  /** Rival ids in this cup's field, fixed for the whole cup. */
  rivals: string[];
}

export interface CareerSave {
  version: 1;
  pilot: string;
  credits: number;
  ownedPods: string[];
  pod: string;
  upgrades: Record<string, Upgrades>;
  cups: Record<string, CupProgress>;
  active: ActiveCup | null;
  stats: { races: number; wins: number; podiums: number; earnings: number };
  /** Best run time per track id (seconds). */
  bestLaps: Record<string, number>;
  /** 3 = best times are runs on the long (4x) point-to-point courses (2: the short ones, older: circuit laps). */
  courses?: number;
}

const KEY = 'racer.career.v1';

export function newCareer(pilot = 'You'): CareerSave {
  return {
    version: 1,
    pilot,
    credits: 500,
    ownedPods: ['ember'],
    pod: 'ember',
    upgrades: { ember: { ...NO_UPGRADES } },
    cups: {},
    active: null,
    stats: { races: 0, wins: 0, podiums: 0, earnings: 0 },
    bestLaps: {},
    courses: 3,
  };
}

export function loadCareer(): CareerSave | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as CareerSave;
    if (s.version !== 1) return null;
    // Best times from the old lapped circuits and the short courses do not compare with the long courses.
    if (s.courses !== 3) return { ...s, bestLaps: {}, courses: 3 };
    return s;
  } catch {
    return null;
  }
}

export function saveCareer(s: CareerSave) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode or full storage: the career lives for this session only.
  }
}

export function resetCareer() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function cupById(id: string): Cup {
  return CUPS.find((c) => c.id === id) ?? CUPS[0];
}

export function cupUnlocked(s: CareerSave, cup: Cup): boolean {
  if (!cup.requires) return true;
  const best = s.cups[cup.requires]?.best;
  return best !== null && best !== undefined && best <= 3;
}

/** Price of the next level of an upgrade category, or null at the max. */
export function upgradePrice(level: number): number | null {
  const prices = [350, 700, 1200, 1900, 2800];
  return level < prices.length ? prices[level] : null;
}

export function startCup(s: CareerSave, cupId: string): CareerSave {
  const cup = cupById(cupId);
  const pool = [...RIVALS].sort((a, b) => b.talent - a.talent);
  // Lower cups get the weaker half of the roster plus one star; the top cups get the best.
  const tierIndex = CUPS.indexOf(cup);
  const ordered = tierIndex < 2 ? [pool[tierIndex], ...pool.slice(3).reverse(), ...pool.slice(0, 3)] : pool;
  const rivals = ordered.filter((r, i, a) => a.indexOf(r) === i).slice(0, cup.field - 1).map((r) => r.id);
  const points: Record<string, number> = { player: 0 };
  for (const r of rivals) points[r] = 0;
  return { ...s, active: { cupId, round: 0, points, results: [], rivals } };
}

/** The racers for the next race of the active cup (player last, so they start at the back of the grid). */
export function cupRacers(s: CareerSave): RacerSetup[] {
  const a = s.active;
  if (!a) throw new Error('no active cup');
  const cup = cupById(a.cupId);
  const u = cup.aiUpgrades;
  const ai: RacerSetup[] = a.rivals.map((id, i) => {
    const rv = RIVALS.find((r) => r.id === id)!;
    const pod = podById(rv.pod);
    const t = a.rivals.length > 1 ? 1 - i / (a.rivals.length - 1) : 1;
    const skill = Math.min(1, Math.max(0, cup.aiSkill[0] + (cup.aiSkill[1] - cup.aiSkill[0]) * t + rv.talent * 0.3));
    const profile: AiProfile = { skill, bias: rv.bias, aggression: rv.aggression };
    const stats = applyUpgrades(pod.stats, { thrust: u, topSpeed: u, handling: u, boost: u });
    // Weaker pilots also fly a little slower.
    stats.topSpeed *= 0.94 + 0.06 * skill;
    stats.thrust *= 0.92 + 0.08 * skill;
    return { id: rv.id, name: rv.name, pod, stats, ai: profile };
  });
  return [...ai, playerRacer(s)];
}

export function playerRacer(s: CareerSave): RacerSetup {
  const pod = podById(s.pod);
  return { id: 'player', name: s.pilot, pod, stats: applyUpgrades(pod.stats, s.upgrades[pod.id] ?? NO_UPGRADES) };
}

export interface RaceAward {
  position: number;
  prize: number;
  points: number;
  /** Set when this race finished the cup. */
  cupDone: { position: number; bonus: number; standings: { id: string; points: number }[] } | null;
  newBestLap: boolean;
}

/** Applies a finished cup race to the save. */
export function awardRace(s: CareerSave, result: RaceResult): { save: CareerSave; award: RaceAward } {
  const a = s.active;
  if (!a) throw new Error('no active cup');
  const cup = cupById(a.cupId);
  const points = { ...a.points };
  result.order.forEach((o, i) => {
    points[o.id] = (points[o.id] ?? 0) + (POINTS[i] ?? 0);
  });
  const position = result.playerPosition;
  const prize = cup.prize[position - 1] ?? 0;
  const prevBest = s.bestLaps[result.trackId];
  const newBestLap = Number.isFinite(result.playerBestLap) && (prevBest === undefined || result.playerBestLap < prevBest);
  let save: CareerSave = {
    ...s,
    credits: s.credits + prize,
    stats: {
      races: s.stats.races + 1,
      wins: s.stats.wins + (position === 1 ? 1 : 0),
      podiums: s.stats.podiums + (position <= 3 ? 1 : 0),
      earnings: s.stats.earnings + prize,
    },
    bestLaps: newBestLap ? { ...s.bestLaps, [result.trackId]: result.playerBestLap } : s.bestLaps,
    active: { ...a, round: a.round + 1, points, results: [...a.results, position] },
  };
  let cupDone: RaceAward['cupDone'] = null;
  if (a.round + 1 >= cup.tracks.length) {
    // Ties go to the player: it is their career.
    const standings = cupStandings(points);
    const cupPos = standings.findIndex((r) => r.id === 'player') + 1;
    const bonus = cupPos === 1 ? cup.cupBonus : cupPos === 2 ? Math.round(cup.cupBonus * 0.5) : cupPos === 3 ? Math.round(cup.cupBonus * 0.25) : 0;
    const prev = s.cups[cup.id]?.best ?? null;
    save = {
      ...save,
      credits: save.credits + bonus,
      stats: { ...save.stats, earnings: save.stats.earnings + bonus },
      cups: { ...s.cups, [cup.id]: { best: prev === null ? cupPos : Math.min(prev, cupPos) } },
      active: null,
    };
    cupDone = { position: cupPos, bonus, standings };
  }
  return { save, award: { position, prize, points: POINTS[position - 1] ?? 0, cupDone, newBestLap } };
}

export function buyPod(s: CareerSave, podId: string): CareerSave | null {
  const pod = podById(podId);
  if (s.ownedPods.includes(podId) || s.credits < pod.price) return null;
  return { ...s, credits: s.credits - pod.price, ownedPods: [...s.ownedPods, podId], pod: podId, upgrades: { ...s.upgrades, [podId]: { ...NO_UPGRADES } } };
}

/** Buys the next level of an upgrade for an owned pod (the flown one by default). */
export function buyUpgrade(s: CareerSave, cat: keyof Upgrades, podId = s.pod): CareerSave | null {
  if (!s.ownedPods.includes(podId)) return null;
  const u = s.upgrades[podId] ?? { ...NO_UPGRADES };
  const price = upgradePrice(u[cat]);
  if (price === null || s.credits < price) return null;
  return { ...s, credits: s.credits - price, upgrades: { ...s.upgrades, [podId]: { ...u, [cat]: u[cat] + 1 } } };
}

/** Flies an owned pod from now on. */
export function selectPod(s: CareerSave, podId: string): CareerSave {
  return s.ownedPods.includes(podId) ? { ...s, pod: podId } : s;
}

/** Display name of a racer id in the career ('player' is the pilot). */
export function racerName(s: CareerSave, id: string): string {
  return id === 'player' ? s.pilot : (RIVALS.find((r) => r.id === id)?.name ?? id);
}

/** Pod a racer id flies in the career. */
export function racerPod(s: CareerSave, id: string) {
  return podById(id === 'player' ? s.pod : (RIVALS.find((r) => r.id === id)?.pod ?? 'ember'));
}

/** Points table sorted best first; ties go to the player, as in awardRace. */
export function cupStandings(points: Record<string, number>): { id: string; points: number }[] {
  return Object.entries(points)
    .map(([id, p]) => ({ id, points: p }))
    .sort((x, y) => y.points - x.points || (x.id === 'player' ? -1 : y.id === 'player' ? 1 : 0));
}

/** A quick race (outside the career): a field of rivals at medium skill on any track; `upgrades` levels their pods. */
export function quickRaceRacers(player: RacerSetup, field = 8, skill = 0.6, upgrades = 2): RacerSetup[] {
  const ai = RIVALS.slice(0, field - 1).map((rv, i) => {
    const pod = podById(rv.pod);
    const k = Math.min(1, Math.max(0, skill + (0.5 - i / (field - 1)) * 0.3));
    return { id: rv.id, name: rv.name, pod, stats: applyUpgrades(pod.stats, { thrust: upgrades, topSpeed: upgrades, handling: upgrades, boost: upgrades }), ai: { skill: k, bias: rv.bias, aggression: rv.aggression } };
  });
  return [...ai, player];
}

export { PODS };
