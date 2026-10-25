// Dustrunners wire protocol: online podracing in a room. The pod physics, AI and damage live in the browser
// (frontend/src/racer/core); the server only runs the race clock, relays pod states and keeps the classification.
//
// Every client flies its own pod with the full simulation and sends its state ~20 times a second. Bots are flown by
// one client, the `simBy` of the bot (the server picks a connected human and moves the bots to another one when that
// player leaves). Everyone else draws remote pods from the relayed snapshots. Contacts are resolved on each side for
// its own pod only (the pod you hit is pushed on its owner's screen by its owner's copy of the contact).
//
// Flow: the match starts -> `init` (track, entrants) -> every client builds the track and sends `ready` with its pod
// -> once all humans are ready (or DR.loadTimeoutMs passed) the server sends `go` with the server time the lights go
// green (DR.leadInMs ahead: the intro fly-over plus the countdown) -> `state` from clients, `snap` to everyone ->
// `finish` per pod -> `finished` broadcasts -> when every human is in (or DR.finishGraceMs after the first human
// finisher, or DR.maxRaceMs) `end`, and the room goes back to waiting.

export const DR = {
  /** Snapshots the clients send and the server relays, per second. */
  snapHz: 20,
  /** Longest wait for slow loaders before the race starts without them (they join the grid late, from the start). */
  loadTimeoutMs: 25_000,
  /** From `go` to green: the intro fly-over (racer core INTRO 3.5 s) plus the countdown (COUNTDOWN 3 s). */
  leadInMs: 6_500,
  /** After the first human crosses the line, how long the rest have before the race is called. */
  finishGraceMs: 30_000,
  /** Hard cap on one race from green. */
  maxRaceMs: 12 * 60_000,
  /** Points by finishing place (1st..8th); unfinished pods score 0. */
  points: [10, 8, 6, 5, 4, 3, 2, 1],
  /** A pod whose owner sent no state for this long is relayed as a ghost (bit 3: not solid). */
  staleMs: 1_000,
  /** A human who sent no state for this long while racing loses the bots it flies to another client. */
  botStaleMs: 2_000,
} as const;

/**
 * Every pod part id (frontend racer/core/damage.ts PART_IDS): the server keeps only these in PodSnap.broken. Keep
 * the two lists the same when a part is added or renamed.
 */
export const DR_PART_IDS = [
  'intakeL', 'intakeR', 'fanL', 'fanR', 'clawsL', 'clawsR', 'nacelleL', 'nacelleR', 'finL', 'finR', 'flapL', 'flapR',
  'nozzleL', 'nozzleR', 'petalsL', 'petalsR', 'armTopL', 'armTopR', 'armOutL', 'armOutR', 'armInL', 'armInR',
  'armBellyL', 'armBellyR', 'binderL', 'binderR', 'binderMid', 'cableL', 'cableR', 'cockpitNose', 'canopy',
  'canopyFrame', 'antenna', 'mountL', 'mountR', 'stabL', 'stabR', 'tail', 'hull',
] as const;

/** One pod on the grid. Grid order is the array order (first = pole). */
export interface DrEntrant {
  id: string;
  name: string;
  /** 0xRRGGBB, the player's room colour (HUD, minimap, name tag). */
  color: number;
  bot: boolean;
  /** Pod design id (frontend racer/core/pods.ts PODS); flown with the design's stock stats, no upgrades. */
  pod: string;
  /** Bots only: the player whose client flies it. */
  simBy?: string;
  /** Bots only: AI skill 0..1 from the room's bot difficulty. */
  skill?: number;
  /** Joined after the start: watches this race, races the next one. */
  spectator?: boolean;
}

/** A pod's state on the wire; numbers are rounded by the sender (2 decimals for s/x/h, 3 for angles). */
export interface PodSnap {
  id: string;
  /** PodState s, x, v, psi, phi, yawRate, h, vy, roll. */
  s: number;
  x: number;
  v: number;
  psi: number;
  phi: number;
  yr: number;
  h: number;
  vy: number;
  roll: number;
  /** Flags: bit 0 boosting, bit 1 airborne, bit 2 wrecked, bit 3 ghost (respawned, not solid). */
  f: number;
  /** Control input for the animation: throttle, steer, brake (0..1 / -1..1, 2 decimals). */
  in: [number, number, number];
  /** Damage summary 0..1 (left engine, right engine, cockpit), for smoke and the standings. */
  dmg: [number, number, number];
  /** Part ids broken off so far (damage.ts PartId), so remote pods lose the same pieces. Cleared on respawn. */
  broken: string[];
  /** While wrecked: the tumble (Wreck roll, pitch, yaw, height). */
  wr?: [number, number, number, number];
  /**
   * Relayed snapshots only (the server sets it, clients do not send it): server time (ms) the owner captured this
   * state, from the `state` message's race time `t` (startAt + t * 1000, clamped to the last 500 ms before it
   * arrived). The same `at` in two snapshots is the same state: no news from that pod.
   */
  at?: number;
}

export interface DrResult {
  id: string;
  /** 1-based finishing place, or null while still racing / did not finish. */
  place: number | null;
  /** Race time in seconds at the line, or null. */
  time: number | null;
}

export type DustrunnersClientMsg =
  /** Track built, ready on the grid with this pod design. Also sent by a spectator once it has loaded. */
  | { k: 'ready'; pod: string }
  /** Own pod plus every bot this client flies. `t` = race time in seconds (negative before green). */
  | { k: 'state'; t: number; pods: PodSnap[] }
  /** Own pod or a bot this client flies crossed the finish line at race time `time` (seconds). */
  | { k: 'finish'; id: string; time: number };

export type DrPhase = 'loading' | 'starting' | 'racing' | 'done';

export type DustrunnersServerMsg =
  /**
   * Sent to each player when the match starts and to anyone joining mid-match. `startAt` is the server time (ms)
   * of the green light once `go` has been sent, else null. `loadBy` is the server time (ms) the race starts anyway
   * if not everyone has loaded by then (the load timeout), null once `go` was sent. Anyone joining after the match
   * started is a spectator; joining once the race is over gets the `end` message instead of an `init`.
   */
  | {
      k: 'init'; track: string; entrants: DrEntrant[]; phase: DrPhase; startAt: number | null; loadBy: number | null;
      results: DrResult[]; serverTime: number;
    }
  /** Everyone is loaded: lights go green at server time `startAt` (ms). */
  | { k: 'go'; startAt: number; entrants: DrEntrant[] }
  /** The entrant list changed (someone left, bots moved to another client, a spectator arrived). */
  | { k: 'entrants'; entrants: DrEntrant[] }
  /**
   * Latest state of every pod, relayed. `t` = server time (ms) the snapshot was put together; each pod's `at` is when
   * its state was captured (draw from that). Pods with no news for DR.staleMs come with the ghost flag set.
   */
  | { k: 'snap'; t: number; pods: PodSnap[] }
  /** A pod crossed the line. */
  | { k: 'finished'; id: string; time: number; place: number }
  /** The race is over. `scores` sorted by place (unfinished at the end, by distance). */
  | { k: 'end'; scores: { id: string; points: number; place: number | null; time: number | null }[]; winner: string | null };
