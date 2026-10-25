// Dustrunners in a room: the racer's own RaceView, driven by NetRace (racer/net/netRace.ts), which flies our pod and
// the bots we simulate and draws everyone else from the relayed snapshots. This client is the glue to the room: it
// builds a NetRace when `init` arrives (and a fresh one if another `init` comes), forwards the game messages to it and
// keeps the room-level HUD state (phase, entrants, classification, spectator, ping) in a store for Hud.tsx. The
// per-frame race HUD (speed, boost, minimap, position) reads the RaceView's own store.

import type { GameServerMsg, RoomView } from '@shared/protocol';
import { DR, type DrEntrant, type DrPhase, type DrResult, type DustrunnersClientMsg, type DustrunnersServerMsg } from '@shared/dustrunners/protocol';
import { drTrackById } from '@shared/dustrunners/tracks';
import { sfx } from '../../engine/audio';
import type { RaceView } from '../../racer/RaceView';
import type { NetRace } from '../../racer/net/netRace';
import { type ClientContext, type GameClient, createStore } from '../types';

export interface DrScore {
  id: string;
  points: number;
  place: number | null;
  time: number | null;
}

export interface DustrunnersHudState {
  /** The track is built and the race view runs (the screenshot tool waits for this). */
  ready: boolean;
  /** 'waiting' until the first `init`; 'racing' is set locally once the server's green-light time has passed. */
  phase: DrPhase | 'waiting';
  trackId: string | null;
  trackName: string;
  entrants: DrEntrant[];
  /** Pods over the line so far, by place. */
  results: DrResult[];
  /** Server time (ms) of the green light, once `go` was sent. */
  startAt: number | null;
  /** Server time (ms) the race starts at the latest even if someone is still loading. */
  loadDeadline: number | null;
  /** We joined after the start: watching this race, racing the next one. */
  spectator: boolean;
  /** Round trip to the server in ms. */
  ping: number;
  /** Escape menu open. */
  paused: boolean;
  /** The race view of the current race, for the racer HUD widgets. */
  view: RaceView | null;
  /** Set when loading the race failed. */
  error: string;
  ended: { scores: DrScore[]; winner: string | null } | null;
}

/** Points for a finishing place (1-based); unfinished pods score nothing. */
export const pointsFor = (place: number | null) => (place ? (DR.points[place - 1] ?? 0) : 0);

export class DustrunnersClient implements GameClient {
  readonly hud = createStore<DustrunnersHudState>({
    ready: false,
    phase: 'waiting',
    trackId: null,
    trackName: '',
    entrants: [],
    results: [],
    startAt: null,
    loadDeadline: null,
    spectator: false,
    ping: 0,
    paused: false,
    view: null,
    error: '',
    ended: null,
  });

  private container?: HTMLElement;
  private race?: NetRace;
  /** Bumped by every `init` and on unmount, so a race that finishes loading after it was superseded is thrown away. */
  private gen = 0;
  /** Messages that arrived while the race module was still loading; replayed into the new race. */
  private backlog: DustrunnersServerMsg[] = [];
  private timer = 0;
  private disposed = false;

  constructor(private readonly ctx: ClientContext) {}

  // ---- lifecycle --------------------------------------------------------------------------------------------

  mount(container: HTMLElement) {
    this.container = container;
    sfx.unlock();
    // Phase and ping between messages: the green light is a server time, not a message.
    this.timer = window.setInterval(() => this.tick(), 200);
  }

  unmount() {
    this.disposed = true;
    this.gen++;
    window.clearInterval(this.timer);
    this.disposeRace();
  }

  setPaused(paused: boolean) {
    // Online the race goes on while the menu is open: never view.setPaused, the local pod would stop for everyone.
    this.hud.set({ paused });
  }

  onRoom(_room: RoomView) {
    // Names and colours come with the entrant list; nothing to redraw here.
  }

  /** Sends a game message to the server. */
  private send = (m: DustrunnersClientMsg) => this.ctx.socket.send({ t: 'g', m });

  // ---- messages -----------------------------------------------------------------------------------------------

  onMessage(m: GameServerMsg) {
    const msg = m as DustrunnersServerMsg;
    switch (msg.k) {
      case 'init':
        this.onInit(msg);
        return;
      case 'go':
        this.hud.set({ phase: 'starting', startAt: msg.startAt, entrants: msg.entrants, spectator: this.isSpectator(msg.entrants) });
        break;
      case 'entrants':
        this.hud.set({ entrants: msg.entrants, spectator: this.isSpectator(msg.entrants) });
        break;
      case 'finished': {
        const r: DrResult = { id: msg.id, place: msg.place, time: msg.time };
        this.hud.set((s) => ({ results: [...s.results.filter((x) => x.id !== msg.id), r].sort((a, b) => (a.place ?? 99) - (b.place ?? 99)) }));
        break;
      }
      case 'end':
        this.hud.set({ phase: 'done', ended: { scores: msg.scores, winner: msg.winner } });
        if (msg.winner === this.ctx.you) sfx.play('win');
        break;
      case 'snap':
        break;
    }
    if (this.race) this.race.onMessage(msg);
    else if (this.hud.get().trackId) {
      // Only the newest snapshot matters to a race that is still loading.
      if (msg.k === 'snap') this.backlog = this.backlog.filter((b) => b.k !== 'snap');
      this.backlog.push(msg);
    }
  }

  private onInit(msg: Extract<DustrunnersServerMsg, { k: 'init' }>) {
    const gen = ++this.gen;
    this.disposeRace();
    this.backlog = [];
    this.followed = null;
    this.hud.set({
      ready: false,
      phase: msg.phase,
      trackId: msg.track,
      trackName: drTrackById(msg.track)?.name ?? msg.track,
      entrants: msg.entrants,
      results: msg.results.filter((r) => r.place !== null).sort((a, b) => a.place! - b.place!),
      startAt: msg.startAt,
      // The server's own load deadline (null once `go` was sent).
      loadDeadline: msg.phase === 'loading' ? msg.loadBy : null,
      spectator: this.isSpectator(msg.entrants),
      view: null,
      error: '',
      ended: null,
    });
    // The race is already over: nothing to build. The HUD says so; the `end` results may still follow.
    if (msg.phase === 'done') return;
    // The racer (three.js world, pods, effects) loads on first use; the room page stays light.
    import('../../racer/net/netRace')
      .then(({ NetRace }) => {
        if (gen !== this.gen || this.disposed || !this.container) return;
        const race = new NetRace({
          container: this.container,
          you: this.ctx.you,
          trackId: msg.track,
          entrants: msg.entrants,
          serverNow: () => this.ctx.socket.serverNow(),
          send: this.send,
          startAt: msg.startAt,
          results: msg.results,
        });
        this.race = race;
        // Then whatever came while the racer loaded (go, entrants, the newest snapshot, finishers).
        if (race.spectating !== this.hud.get().spectator) this.hud.set({ spectator: race.spectating });
        for (const m of this.backlog) race.onMessage(m);
        this.backlog = [];
        race.start();
        this.hud.set({ ready: true, view: race.view });
        if (import.meta.env.DEV) (window as unknown as { __dustrunners?: DustrunnersClient }).__dustrunners = this;
      })
      .catch((e: Error) => {
        if (gen === this.gen) this.hud.set({ error: `Could not load the race: ${e.message}` });
      });
  }

  /** Spectators: watch the next pilot on the grid, or the leader again after the last one. Returns who is watched. */
  followNext(): string | null {
    const racers = this.hud.get().entrants.filter((e) => !e.spectator);
    const i = this.followed === null ? -1 : racers.findIndex((e) => e.id === this.followed);
    this.followed = racers[i + 1]?.id ?? null;
    this.race?.follow(this.followed);
    return this.followed;
  }
  private followed: string | null = null;

  private disposeRace() {
    this.race?.dispose();
    this.race = undefined;
    this.hud.set({ view: null, ready: false });
  }

  private isSpectator(entrants: DrEntrant[]) {
    return !!entrants.find((e) => e.id === this.ctx.you)?.spectator;
  }

  private tick() {
    const s = this.hud.get();
    const patch: Partial<DustrunnersHudState> = {};
    const ping = Math.round(this.ctx.socket.rtt);
    if (ping !== s.ping) patch.ping = ping;
    if (s.phase === 'starting' && s.startAt !== null && this.ctx.socket.serverNow() >= s.startAt) patch.phase = 'racing';
    if (Object.keys(patch).length) this.hud.set(patch);
  }
}
