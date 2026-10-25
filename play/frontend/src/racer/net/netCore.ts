// The networked race without the rendering (three-free, so the headless net test runs it under Node): builds the grid
// from the room's entrants, and every frame writes the remote pods from the snapshot buffers, keeps the race clock on
// the server's and sends this client's pods (its own plus the bots it flies). NetRace (netRace.ts) wraps it with a
// RaceView. See backend/src/shared/dustrunners/protocol.ts for the netcode model.

import type { DrEntrant, DrResult, DustrunnersClientMsg, DustrunnersServerMsg } from '@shared/dustrunners/protocol';
import { podById } from '../core/pods';
import type { Race, Racer, RacerSetup } from '../core/race';
import { F_GHOST, INTERP_DELAY, STALE_MS, SnapBuffer, applyPod, encodePod, extrapolate } from './snap';

/** Snapshots per second (protocol.ts DR.snapHz; a value here so this module needs no runtime import of shared code). */
export const SNAP_HZ = 20;

const cssColor = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * The grid for this client, in entrant order (first = pole), spectators left out: every pod on its design's stock
 * stats; `you` flown here with `myPod`; bots this client flies (`simBy` === you) by their AI, everyone else remote.
 */
export function netSetups(you: string, entrants: DrEntrant[], myPod: string): RacerSetup[] {
  return entrants
    .filter((e) => !e.spectator)
    .map((e, i) => {
      const own = e.id === you;
      const pod = podById(own ? myPod : e.pod);
      const setup: RacerSetup = { id: e.id, name: e.name, pod, stats: { ...pod.stats }, color: cssColor(e.color) };
      if (e.bot) {
        // Spread the bots over the road so they do not all queue on one line.
        setup.ai = { skill: e.skill ?? 0.6, bias: ((i * 0.618) % 1) * 1.6 - 0.8, aggression: 0.5 };
        setup.remote = e.simBy !== you;
      } else setup.remote = !own;
      return setup;
    });
}

export interface NetCoreOptions {
  you: string;
  serverNow(): number;
  send(m: DustrunnersClientMsg): void;
  /** Server time (ms) of the green light if `go` was already sent (joining mid-race), else null. */
  startAt?: number | null;
  /** Finishes so far (joining mid-race). */
  results?: DrResult[];
}

export class NetCore {
  /** Server time (ms) of the green light, null until `go`. */
  startAt: number | null;
  /** Finishing places from the server, by entrant id. */
  readonly places = new Map<string, number>();
  /** True once the server sent `end`: nothing more is sent. */
  ended = false;
  /** A spectator's camera: this racer's id, or null for whoever leads. */
  followId: string | null = null;
  private readonly buffers = new Map<string, SnapBuffer>();
  /** Server time (ms, this client's estimate) each remote pod last got a new snapshot. */
  private readonly newsAt = new Map<string, number>();
  private readonly byId = new Map<string, Racer>();
  private sendAcc = 0;

  constructor(readonly race: Race, private readonly o: NetCoreOptions) {
    for (const r of race.racers) this.byId.set(r.id, r);
    this.startAt = o.startAt ?? null;
    race.networked = true;
    race.hold = this.startAt === null;
    race.addEvents({
      onFinish: (r) => {
        if (!r.remote && !r.gone && r.finish !== null && !this.ended) o.send({ k: 'finish', id: r.id, time: round3(r.finish) });
      },
    });
    for (const res of o.results ?? []) if (res.place !== null && res.time !== null) this.finished(res.id, res.time, res.place);
  }

  /** Pods this client sends: its own and the bots it flies. */
  local(): Racer[] {
    return this.race.racers.filter((r) => !r.remote && !r.gone);
  }

  /** Every frame, before the race steps. */
  frame(dt: number) {
    const race = this.race;
    const now = this.o.serverNow();
    if (this.startAt !== null) {
      race.hold = false;
      race.setClock((now - this.startAt) / 1000);
    }
    const at = now - INTERP_DELAY;
    for (const r of race.racers) {
      if (!r.remote || r.gone) continue;
      const p = this.buffers.get(r.id)?.sample(at);
      if (!p) continue;
      // No news from its owner for a while (a stalled tab): not solid, nobody crashes into a frozen pod.
      const stale = now - (this.newsAt.get(r.id) ?? -Infinity) > STALE_MS;
      applyPod(race, r, stale && !(p.f & F_GHOST) ? { ...p, f: p.f | F_GHOST } : p);
    }
    if (!race.me) race.focus = this.watched();
    if (this.startAt === null || this.ended) return;
    this.sendAcc += dt;
    if (this.sendAcc < 1 / SNAP_HZ) return;
    this.sendAcc = Math.min(this.sendAcc - 1 / SNAP_HZ, 1 / SNAP_HZ);
    const pods = this.local();
    if (pods.length) this.o.send({ k: 'state', t: round3(race.time), pods: pods.map(encodePod) });
  }

  onMessage(m: DustrunnersServerMsg) {
    switch (m.k) {
      case 'init':
        if (m.startAt !== null) this.startAt = m.startAt;
        this.entrants(m.entrants);
        for (const res of m.results) if (res.place !== null && res.time !== null) this.finished(res.id, res.time, res.place);
        break;
      case 'go':
        this.startAt = m.startAt;
        this.entrants(m.entrants);
        break;
      case 'entrants':
        this.entrants(m.entrants);
        break;
      case 'snap':
        for (const p of m.pods) {
          const r = this.byId.get(p.id);
          if (!r || !r.remote) continue;
          let b = this.buffers.get(p.id);
          if (!b) this.buffers.set(p.id, (b = new SnapBuffer()));
          // Keyed on the pod's capture time (`at`); a relay without news repeats it and is skipped.
          if (b.push(p.at ?? m.t, p)) this.newsAt.set(p.id, this.o.serverNow());
        }
        break;
      case 'finished':
        this.finished(m.id, m.time, m.place);
        break;
      case 'end':
        this.ended = true;
        break;
    }
  }

  private finished(id: string, time: number, place: number) {
    this.places.set(id, place);
    const r = this.byId.get(id);
    // The own pod crossed the line here; a bot flown here may have crossed it on its previous pilot's screen
    // (setFinish leaves a pod that has its finish already alone).
    if (r && r !== this.race.me) this.race.setFinish(r, time);
  }

  /**
   * The entrant list changed: departed pods (or ones now spectating) disappear, pods whose design changed get the new
   * one, and bots move between this client and others (a bot handed to this client flies on from its last snapshot).
   */
  private entrants(list: DrEntrant[]) {
    const race = this.race;
    const you = this.o.you;
    for (const r of race.racers) {
      if (r.gone) continue;
      const e = list.find((x) => x.id === r.id);
      if (!e || e.spectator) {
        if (r === race.me) continue;
        r.remote = true;
        r.gone = true;
        continue;
      }
      if (r !== race.me && e.pod !== r.pod.id) {
        const pod = podById(e.pod);
        race.setPod(r, pod, { ...pod.stats });
      }
      if (!e.bot || !r.ai) continue;
      const mine = e.simBy === you;
      if (mine && r.remote) {
        const last = this.buffers.get(r.id)?.latest;
        if (last) applyPod(race, r, extrapolate(last.p, Math.min(0.25, Math.max(0, (this.o.serverNow() - last.t) / 1000))));
        this.buffers.delete(r.id);
        this.newsAt.delete(r.id);
      }
      race.setRemote(r, !mine);
    }
  }

  /** Who a spectator watches: the followed racer while it is still in, else the leader. */
  private watched(): Racer {
    const race = this.race;
    const f = this.followId !== null ? this.byId.get(this.followId) : undefined;
    if (f && !f.gone) return f;
    return race.racers.find((r) => r.position === 1 && !r.gone) ?? race.focus;
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
