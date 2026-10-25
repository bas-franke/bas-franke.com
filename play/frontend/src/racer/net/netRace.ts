// A Dustrunners race in a room: a RaceView whose race is networked (NetCore). Used by games/dustrunners/client.ts.
//
// API
//   const net = new NetRace({ container, you, trackId, entrants, serverNow, send, onFinish, startAt?, results?, pod?, quality? });
//     Builds the track and the grid from `entrants` (the `init` message) and sends `ready` with the local pod right away
//     (`pod` option, else the career's selected pod, else 'ember'; always one of DR_PODS).
//   net.start()            starts rendering (the race waits on the grid until `go`; the intro plays from there).
//   net.onMessage(m)       feed every DustrunnersServerMsg here (init, go, entrants, snap, finished, end).
//   net.view               the RaceView: `view.hud` for the HUD store, `view.race` for the Race, `view.touch`.
//   net.race               shorthand for view.race; `race.me` is null for a spectator, `race.focus` is who is shown.
//   net.spectating         true when the local player is not on the grid (joined late / spectator entrant).
//   net.places             finishing places from the server, by entrant id.
//   net.follow(id | null)  spectators: watch this racer, or null for the leader (the default).
//   net.dispose()
//   onFinish(result)       ~2.6 s after the local pod crossed the line (never for a spectator); the race keeps running
//                          and the pod coasts on autopilot, other pods still arrive and are classified.
// Do not pause the view (view.setPaused) in a networked race: the local pod would stop for everyone.

import type { DrEntrant, DrResult, DustrunnersClientMsg, DustrunnersServerMsg } from '@shared/dustrunners/protocol';
import { DR_PODS } from '@shared/dustrunners/tracks';
import { loadCareer } from '../core/career';
import type { Race } from '../core/race';
import { RaceView, type RaceResult } from '../RaceView';
import type { Quality } from '../world/types';
import { NetCore, netSetups } from './netCore';

export interface NetRaceOptions {
  container: HTMLElement;
  /** The local player's id. */
  you: string;
  trackId: string;
  entrants: DrEntrant[];
  /** Server clock (ms), synced by the room client. */
  serverNow(): number;
  send(m: DustrunnersClientMsg): void;
  /** The local pod crossed the line (shortly after, like the solo results). */
  onFinish?(result: RaceResult): void;
  /** From `init` when joining a race that is already under way. */
  startAt?: number | null;
  results?: DrResult[];
  /** Pod design to fly; defaults to the career's selected pod. */
  pod?: string;
  quality?: Quality;
}

export class NetRace {
  readonly view: RaceView;
  readonly core: NetCore;
  readonly spectating: boolean;
  readonly pod: string;

  constructor(o: NetRaceOptions) {
    this.pod = pickPod(o.pod);
    const setups = netSetups(o.you, o.entrants, this.pod);
    this.spectating = !setups.some((s) => s.id === o.you);
    let core: NetCore | null = null;
    this.view = new RaceView(o.container, {
      trackId: o.trackId,
      racers: setups,
      quality: o.quality,
      networked: true,
      onFinish: (r) => o.onFinish?.(r),
      onFrame: (dt) => core?.frame(dt),
    });
    core = new NetCore(this.view.race, { you: o.you, serverNow: o.serverNow, send: o.send, startAt: o.startAt, results: o.results });
    this.core = core;
    o.send({ k: 'ready', pod: this.pod });
  }

  get race(): Race {
    return this.view.race;
  }

  get places(): ReadonlyMap<string, number> {
    return this.core.places;
  }

  start() {
    this.view.start();
  }

  onMessage(m: DustrunnersServerMsg) {
    this.core.onMessage(m);
  }

  follow(id: string | null) {
    this.core.followId = id;
  }

  dispose() {
    this.view.dispose();
  }
}

/** The pod to fly: the requested one, else the career's selected pod, else the starter; always one the room knows. */
function pickPod(want?: string): string {
  const known = (id: string | undefined): id is string => !!id && (DR_PODS as readonly string[]).includes(id);
  if (known(want)) return want;
  const career = loadCareer()?.pod;
  return known(career) ? career : 'ember';
}
