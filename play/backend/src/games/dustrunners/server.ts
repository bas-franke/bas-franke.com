// Dustrunners: online podracing. The pods fly in the browsers (frontend/src/racer/core); this server is a thin
// authority that runs the race clock (load -> go -> green), relays pod states between clients, takes the finish
// times and keeps the classification. Every client flies its own pod; bots are flown by one human client each.

import { clamp } from '../../shared/math.js';
import type { BotDifficulty, GameClientMsg } from '../../shared/protocol.js';
import { DR, DR_PART_IDS, type DrEntrant, type DrPhase, type DrResult, type DustrunnersServerMsg, type PodSnap } from '../../shared/dustrunners/protocol.js';
import { DR_PODS, DR_TRACKS, drTrackById } from '../../shared/dustrunners/tracks.js';
import type { GameHost, GamePlayer, GameServer } from '../types.js';

const SKILL: Record<BotDifficulty, number> = { easy: 0.3, normal: 0.55, hard: 0.85 };
/** Fastest plausible race in seconds: a finish claimed sooner after green is rejected. */
const MIN_RACE_S = 10;
/** How far a finish time may run ahead of the server clock (clock offset estimate, frame timing). */
const FINISH_AHEAD_S = 2;
/** How far behind the server clock a finish may arrive (lag, a stalled tab catching up). */
const FINISH_BEHIND_S = 60;
const PART_IDS: ReadonlySet<string> = new Set(DR_PART_IDS);
/** How far before its arrival a state may say it was captured (older claims are clamped to this). */
const STATE_LAG_MS = 500;
const F_GHOST = 8;

interface Entrant extends DrEntrant {
  /** Human finished loading (sent `ready`). */
  loaded: boolean;
}

interface Finish {
  place: number;
  time: number;
}

const isPod = (p: unknown): p is (typeof DR_PODS)[number] => typeof p === 'string' && (DR_PODS as readonly string[]).includes(p);
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : 0);

/** Copies a client pod state into a clean PodSnap, or null when it is not one. */
function sanitizeSnap(raw: unknown, id: string): PodSnap | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.s !== 'number' || !Number.isFinite(r.s)) return null;
  const tuple3 = (v: unknown, lo: number, hi: number): [number, number, number] =>
    Array.isArray(v) ? [num(v[0], lo, hi), num(v[1], lo, hi), num(v[2], lo, hi)] : [0, 0, 0];
  const snap: PodSnap = {
    id,
    s: num(r.s, -1e5, 1e6),
    x: num(r.x, -1e4, 1e4),
    v: num(r.v, -1e4, 1e4),
    psi: num(r.psi, -1e3, 1e3),
    phi: num(r.phi, -1e3, 1e3),
    yr: num(r.yr, -1e3, 1e3),
    h: num(r.h, -1e4, 1e4),
    vy: num(r.vy, -1e4, 1e4),
    roll: num(r.roll, -1e3, 1e3),
    f: Math.floor(num(r.f, 0, 255)),
    in: tuple3(r.in, -1, 1),
    dmg: tuple3(r.dmg, 0, 1),
    // Known part ids only, once each (an id like 'constructor' would crash the receivers).
    broken: Array.isArray(r.broken) ? [...new Set(r.broken.filter((b): b is string => typeof b === 'string' && PART_IDS.has(b)))] : [],
  };
  if (Array.isArray(r.wr)) snap.wr = [num(r.wr[0], -1e3, 1e3), num(r.wr[1], -1e3, 1e3), num(r.wr[2], -1e3, 1e3), num(r.wr[3], -1e4, 1e4)];
  return snap;
}

class DustrunnersGame implements GameServer {
  private readonly track: string;
  private readonly entrants: Entrant[] = [];
  private readonly pods = new Map<string, PodSnap>();
  /** Server time (ms) each pod's last state arrived, and each human's last `state` message. */
  private readonly podHeardAt = new Map<string, number>();
  private readonly humanHeardAt = new Map<string, number>();
  private readonly finishes = new Map<string, Finish>();
  private phase: DrPhase = 'loading';
  /** Set once start() built the grid: everyone arriving after that watches this race. */
  private started = false;
  private startAt: number | null = null;
  /** Server time (ms) the load timeout fires, null once `go` was sent. */
  private loadBy: number | null = null;
  /** The `end` message, for anyone joining after the race. */
  private endMsg: DustrunnersServerMsg | null = null;
  /** Places handed out so far (a finisher who leaves keeps the place numbers of the others as they were). */
  private placed = 0;
  private firstHumanFinishAt: number | null = null;
  private snapTimer?: NodeJS.Timeout;
  private loadTimer?: NodeJS.Timeout;
  private greenTimer?: NodeJS.Timeout;
  private endTimer?: NodeJS.Timeout;
  private graceTimer?: NodeJS.Timeout;
  private readonly podOffset = Math.floor(Math.random() * DR_PODS.length);

  constructor(private readonly host: GameHost) {
    // The next race of a series comes with its track; else the room's pick, or a random one.
    const map = host.seriesMap ?? host.settings.map;
    this.track = drTrackById(map)?.id ?? DR_TRACKS[Math.floor(Math.random() * DR_TRACKS.length)].id;
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------

  start() {
    for (const p of this.host.players()) this.entrants.push(this.makeEntrant(p, false));
    this.started = true;
    this.assignBots();
    this.loadBy = Date.now() + DR.loadTimeoutMs;
    for (const e of this.entrants) if (!e.bot) this.sendInit(e.id);
    this.loadTimer = setTimeout(() => this.go(), DR.loadTimeoutMs);
    this.snapTimer = setInterval(() => this.broadcastSnap(), 1000 / DR.snapHz);
    this.checkAllReady();
  }

  stop() {
    clearInterval(this.snapTimer);
    clearTimeout(this.loadTimer);
    clearTimeout(this.greenTimer);
    clearTimeout(this.endTimer);
    clearTimeout(this.graceTimer);
    this.snapTimer = this.loadTimer = this.greenTimer = this.endTimer = this.graceTimer = undefined;
  }

  addPlayer(p: GamePlayer) {
    if (this.entrants.some((e) => e.id === p.id)) return;
    // The race is over: show the result, nothing to build.
    if (this.phase === 'done') {
      if (!p.bot && this.endMsg) this.host.send(p.id, this.endMsg);
      return;
    }
    // The other clients built their grid from start()'s entrants: anyone later only watches, and a bot added now
    // sits this race out (nobody would fly it or draw it).
    if (p.bot && this.started) return;
    this.entrants.push(this.makeEntrant(p, this.started));
    if (p.bot) this.assignBots();
    if (!p.bot) this.sendInit(p.id);
    this.broadcastEntrants();
  }

  removePlayer(id: string) {
    const i = this.entrants.findIndex((e) => e.id === id);
    if (i < 0) return;
    this.entrants.splice(i, 1);
    this.pods.delete(id);
    this.podHeardAt.delete(id);
    this.humanHeardAt.delete(id);
    // A finisher who leaves keeps its entry, so the places already handed out stay as broadcast (end() re-counts).
    // Bots this player flew move to someone else.
    for (const e of this.entrants) if (e.bot && e.simBy === id) delete e.simBy;
    this.assignBots();
    if (this.phase === 'done') return;
    this.broadcastEntrants();
    // Nobody racing any more (only spectators, or nobody at all): call the race.
    if (!this.entrants.some((e) => !e.bot && !e.spectator)) {
      this.end();
      return;
    }
    if (this.phase === 'loading') this.checkAllReady();
    else this.checkEnd();
  }

  onMessage(id: string, m: GameClientMsg) {
    if (this.phase === 'done' || !m || typeof m !== 'object') return;
    const sender = this.entrants.find((e) => e.id === id && !e.bot);
    if (!sender) return;
    switch (m.k) {
      case 'ready':
        this.onReady(sender, (m as { pod?: unknown }).pod);
        return;
      case 'state':
        this.onState(sender, (m as { pods?: unknown }).pods, (m as { t?: unknown }).t);
        return;
      case 'finish':
        this.onFinish(sender, (m as { id?: unknown }).id, (m as { time?: unknown }).time);
        return;
    }
  }

  // ---- entrants -------------------------------------------------------------------------------------------------

  private makeEntrant(p: GamePlayer, spectator: boolean): Entrant {
    const e: Entrant = { id: p.id, name: p.name, color: p.color, bot: p.bot, pod: 'ember', loaded: p.bot };
    if (p.bot) {
      const bots = this.entrants.filter((x) => x.bot).length;
      e.pod = DR_PODS[(this.podOffset + bots) % DR_PODS.length];
      e.skill = SKILL[this.host.botDifficulty()] ?? SKILL.normal;
    }
    if (spectator) e.spectator = true;
    return e;
  }

  /**
   * Gives every bot without a (present, responsive) pilot one, spreading them over the humans racing (else any
   * human). A human whose client went quiet while racing (background tab) loses its bots; it does not get them back.
   * Returns whether any bot changed hands.
   */
  private assignBots(): boolean {
    const all = this.entrants.filter((e) => !e.bot);
    const racing = all.filter((e) => !e.spectator);
    const pool = racing.length ? racing : all;
    const awake = pool.filter((h) => !this.quiet(h.id));
    const humans = awake.length ? awake : pool;
    if (!humans.length) return false;
    const ids = new Set(humans.map((h) => h.id));
    const load = new Map(humans.map((h) => [h.id, 0]));
    for (const e of this.entrants) if (e.bot && e.simBy && ids.has(e.simBy)) load.set(e.simBy, load.get(e.simBy)! + 1);
    let moved = false;
    for (const e of this.entrants) {
      if (!e.bot || (e.simBy && ids.has(e.simBy))) continue;
      let best = humans[0].id;
      for (const h of humans) if (load.get(h.id)! < load.get(best)!) best = h.id;
      e.simBy = best;
      load.set(best, load.get(best)! + 1);
      moved = true;
    }
    return moved;
  }

  /** A human that has sent no state for DR.botStaleMs while racing (counted from green if it never sent one). */
  private quiet(id: string, now = Date.now()): boolean {
    if (this.phase !== 'racing' || this.startAt === null) return false;
    return now - Math.max(this.humanHeardAt.get(id) ?? 0, this.startAt) > DR.botStaleMs;
  }

  private wire(): DrEntrant[] {
    return this.entrants.map(({ loaded: _loaded, ...e }) => e);
  }

  /** Who may send states and finishes for pod `podId`: its own player, or the human flying that bot. */
  private owns(sender: Entrant, podId: unknown): Entrant | undefined {
    const e = this.entrants.find((x) => x.id === podId);
    if (!e || e.spectator) return undefined;
    return e.id === sender.id || (e.bot && e.simBy === sender.id) ? e : undefined;
  }

  // ---- race flow ------------------------------------------------------------------------------------------------

  private onReady(sender: Entrant, pod: unknown) {
    // After go the pod design may still change while nobody has seen this pod fly (a slow loader).
    if (isPod(pod) && (this.phase === 'loading' || sender.spectator || !this.pods.has(sender.id))) sender.pod = pod;
    if (sender.loaded) return;
    sender.loaded = true;
    if (this.phase === 'loading') this.checkAllReady();
    else this.broadcastEntrants();
  }

  private checkAllReady() {
    if (this.phase !== 'loading') return;
    // Spectators are not waited for.
    if (this.entrants.every((e) => e.bot || e.loaded || e.spectator)) this.go();
  }

  private go() {
    if (this.phase !== 'loading') return;
    clearTimeout(this.loadTimer);
    const startAt = Date.now() + DR.leadInMs;
    this.startAt = startAt;
    this.loadBy = null;
    this.phase = 'starting';
    this.host.broadcast({ k: 'go', startAt, entrants: this.wire() });
    this.greenTimer = setTimeout(() => {
      if (this.phase !== 'starting') return;
      this.phase = 'racing';
      this.endTimer = setTimeout(() => this.end(), DR.maxRaceMs);
      this.checkEnd();
    }, DR.leadInMs);
  }

  private onState(sender: Entrant, pods: unknown, t: unknown) {
    if (!Array.isArray(pods)) return;
    const now = Date.now();
    this.humanHeardAt.set(sender.id, now);
    // When the owner captured it, on the server clock: its race time, kept within the last STATE_LAG_MS.
    const told = typeof t === 'number' && Number.isFinite(t) && this.startAt !== null ? this.startAt + t * 1000 : now;
    const at = Math.round(clamp(told, now - STATE_LAG_MS, now));
    for (const raw of pods.slice(0, this.entrants.length)) {
      const e = this.owns(sender, (raw as { id?: unknown } | null)?.id);
      if (!e) continue;
      const snap = sanitizeSnap(raw, e.id);
      if (!snap) continue;
      // Never older than what was relayed already (a state from a pilot the bot just left).
      const prev = this.pods.get(e.id)?.at ?? -Infinity;
      snap.at = Math.max(at, prev + 1);
      this.pods.set(e.id, snap);
      this.podHeardAt.set(e.id, now);
    }
  }

  private onFinish(sender: Entrant, podId: unknown, time: unknown) {
    if (this.phase !== 'racing' || this.startAt === null) return;
    const e = this.owns(sender, podId);
    if (!e || this.finishes.has(e.id) || typeof time !== 'number' || !Number.isFinite(time)) return;
    const elapsed = (Date.now() - this.startAt) / 1000;
    if (time < MIN_RACE_S || time > elapsed + FINISH_AHEAD_S || time < elapsed - FINISH_BEHIND_S) return;
    const place = ++this.placed;
    const rounded = Math.round(time * 1000) / 1000;
    this.finishes.set(e.id, { place, time: rounded });
    this.host.broadcast({ k: 'finished', id: e.id, time: rounded, place });
    if (!e.bot && this.firstHumanFinishAt === null) {
      this.firstHumanFinishAt = Date.now();
      this.graceTimer = setTimeout(() => this.end(), DR.finishGraceMs);
    }
    this.checkEnd();
  }

  /** The race is over once every human racing is in; bots do not have to finish. */
  private checkEnd() {
    if (this.phase !== 'racing') return;
    const humans = this.entrants.filter((e) => !e.bot && !e.spectator);
    if (humans.every((h) => this.finishes.has(h.id))) this.end();
  }

  private end() {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.stop();
    // Finishers by time order; the rest by how far they got. Places are re-counted among the pods still here.
    const racers = this.entrants.filter((e) => !e.spectator);
    const done = racers.filter((e) => this.finishes.has(e.id)).sort((a, b) => this.finishes.get(a.id)!.place - this.finishes.get(b.id)!.place);
    const rest = racers
      .filter((e) => !this.finishes.has(e.id))
      .sort((a, b) => (this.pods.get(b.id)?.s ?? -Infinity) - (this.pods.get(a.id)?.s ?? -Infinity));
    const scores = [
      ...done.map((e, i) => ({ id: e.id, points: DR.points[i] ?? 0, place: i + 1, time: this.finishes.get(e.id)!.time })),
      ...rest.map((e) => ({ id: e.id, points: 0, place: null, time: null })),
    ];
    const next = this.nextTrack();
    this.endMsg = { k: 'end', scores, winner: done[0]?.id ?? null, next, nextAt: Date.now() + DR.resultsMs };
    this.host.broadcast(this.endMsg);
    this.host.matchEnded({ inMs: DR.resultsMs, map: next });
  }

  /** The track after this one: the next course in the list when the host picked one, else a different random one. */
  private nextTrack(): string {
    const i = DR_TRACKS.findIndex((t) => t.id === this.track);
    if (drTrackById(this.host.settings.map)) return DR_TRACKS[(i + 1) % DR_TRACKS.length].id;
    const others = DR_TRACKS.filter((t) => t.id !== this.track);
    return others.length ? others[Math.floor(Math.random() * others.length)].id : this.track;
  }

  // ---- sending --------------------------------------------------------------------------------------------------

  private results(): DrResult[] {
    return this.entrants
      .filter((e) => !e.spectator)
      .map((e) => {
        const f = this.finishes.get(e.id);
        return { id: e.id, place: f?.place ?? null, time: f?.time ?? null };
      });
  }

  private sendInit(id: string) {
    this.host.send(id, {
      k: 'init',
      track: this.track,
      entrants: this.wire(),
      phase: this.phase,
      startAt: this.startAt,
      loadBy: this.loadBy,
      results: this.results(),
      serverTime: Date.now(),
    });
  }

  private broadcastEntrants() {
    if (this.phase === 'done') return;
    this.host.broadcast({ k: 'entrants', entrants: this.wire() });
  }

  private broadcastSnap() {
    if (this.phase !== 'starting' && this.phase !== 'racing') return;
    const now = Date.now();
    // Bots of a client that went quiet move to one still sending (assignBots passes over quiet humans).
    if (this.entrants.some((e) => e.bot && e.simBy && this.quiet(e.simBy, now)) && this.assignBots()) this.broadcastEntrants();
    if (!this.pods.size) return;
    // Every pod's latest state (receivers skip the ones whose `at` they have); one gone quiet is relayed as a ghost,
    // so nobody crashes into a pod frozen in a stalled tab.
    const pods = [...this.pods.values()].map((p) => (now - (this.podHeardAt.get(p.id) ?? 0) > DR.staleMs ? { ...p, f: p.f | F_GHOST } : p));
    this.host.broadcast({ k: 'snap', t: now, pods });
  }}

export const createDustrunnersGame = (host: GameHost): GameServer => new DustrunnersGame(host);
