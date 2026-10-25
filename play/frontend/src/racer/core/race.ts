// One race: the grid, the countdown, every pod's flight, contacts between pods, slipstream, positions and the final
// classification. Courses are point-to-point, so a race is one run from the start line to the finish line. Pure simulation: no three.js scene, no DOM. RaceView renders it; the career awards it.
// Hits damage the pod's parts where they land (see damage.ts): physics reports where walls and rocks touched the pod
// (landings do no damage), contacts() works out where pods touched each other, and the tumble of a wreck lands on whatever part is
// lowest at each bounce. Damaged parts change the handling (handlingOf). Once a critical part breaks the pod is thrown
// up tumbling, bounces and skids to a stop (see stepWreck), then is put back in the middle of the corridor as a ghost
// that blinks and cannot be hit for a few seconds.
//
// Networked races (racer/net): a `remote` racer is flown on another screen. Its state is written from outside every
// frame (snapshots); the race never steps, hurts, wrecks, respawns or classifies it (its finish comes from the
// server), but it still pushes the local pods about in contacts(), gives slipstream and takes its place in the order.
// `hold` keeps the race on the grid until the server says go, setClock() keeps the race time on the server's clock,
// and a race without a local pod (`me` null: a spectator) follows `focus` instead.

import { aiInput, type AiProfile } from './ai';
import {
  applyHit, contactHits, damageSummary, isWrecked, newPodDamage, partAnchors, shatter, toPodSpace,
  type Hit, type HitKind, type PartAnchor, type PartHit, type PartId, type PodDamage,
} from './damage';
import { NO_INPUT, knifeAngle, newPodState, podHalfWidth, sideHit, stepPod, type PodInput, type PodState } from './physics';
import type { PodDesign, PodStats } from './pods';
import { Track } from './track';
import type { TrackDef } from './tracks';

export interface RacerSetup {
  id: string;
  name: string;
  pod: PodDesign;
  stats: PodStats;
  /** Omitted for the player. */
  ai?: AiProfile;
  /** Networked: flown on another screen, its state written from snapshots (see the header). */
  remote?: boolean;
  /** Networked: name tag / minimap colour (CSS), instead of the pod's paint. */
  color?: string;
}

export interface Racer extends RacerSetup {
  state: PodState;
  /** -1 on the grid, 0 after the start line, 1 past the finish line (the run counts as the one "lap"). */
  lap: number;
  lapStart: number;
  lapTimes: number[];
  bestLap: number;
  /** Race time at the finish, or null while racing. */
  finish: number | null;
  /** 1-based position, updated every step. */
  position: number;
  /** Metres past the start line, for ordering. */
  progress: number;
  /** Current control input (player or AI), for animation. */
  input: PodInput;
  /** Damage summary, 0..1: left engine, right engine, cockpit (damageSummary of `parts`, for the smoke and the HUD). */
  damage: [number, number, number];
  /** Health of every part, and where the parts sit on this pod's shape. */
  parts: PodDamage;
  anchors: Record<PartId, PartAnchor>;
  /** What the damage does to the handling. */
  handling: Handling;
  /** The steering as the cables pass it on (it lags the stick once they are damaged). */
  steerOut: number;
  /** Seconds left lying wrecked (0 = flying), and seconds left as a ghost after the respawn. */
  wrecked: number;
  ghost: number;
  /** Seconds before the same contact can do damage again (one crash is one hit, not one per physics step). */
  hurtCool: number;
  /** Where the contact that started the cooldown touched and how hard (a harder or separate one still counts). */
  lastHit: { point: [number, number, number]; energy: number } | null;
  /** The tumble of a wreck (meaningful while `wrecked` > 0). */
  wreck: Wreck;
  /** Networked: left the race. Not drawn, not solid, last in the order; never updated again. */
  gone?: boolean;
}

/**
 * A wreck's flight: height above the ground and vertical speed, sideways drift (m/s, + right), and its tumble as roll
 * (about the direction of travel), pitch and yaw relative to the course, with their rates in rad/s.
 */
export interface Wreck {
  h: number;
  vy: number;
  vx: number;
  roll: number;
  pitch: number;
  yaw: number;
  wr: number;
  wp: number;
  wy: number;
  /** Whether it has come to rest on the ground. */
  rest: boolean;
}

const newWreck = (): Wreck => ({ h: 0, vy: 0, vx: 0, roll: 0, pitch: 0, yaw: 0, wr: 0, wp: 0, wy: 0, rest: true });

/** Damage parts. */
export const LEFT_ENGINE = 0;
export const RIGHT_ENGINE = 1;
export const COCKPIT = 2;
/** Seconds a wrecked pod lies before it respawns, and seconds of ghosting after. */
export const WRECK_TIME = 0.5;
/** Gravity on a tumbling wreck, and how much of its vertical speed survives a bounce. */
const WRECK_GRAVITY = 24;
const WRECK_BOUNCE = 0.45;
export const GHOST_TIME = 3;
/** Seconds one contact counts as one hit, and how far apart (m, pod space) two contacts must be to count apart. */
const HURT_COOL = 0.3;
const HURT_APART = 2.5;

/**
 * How a damaged pod flies: its stats with less thrust (damaged intakes and engines) and top speed (nozzles), steering
 * authority towards each side (a missing fin turns that way weaker), air brake strength (flaps), steering pulls (+ =
 * right: the flap left on the other side drags, the stronger engine pushes the pod round towards the weaker one), a
 * wobble from snapped binders and a steering lag from cut cables. The canopy does nothing to the flight.
 */
export interface Handling {
  stats: PodStats;
  turnL: number;
  turnR: number;
  brake: number;
  pull: number;
  brakePull: number;
  thrustPull: number;
  wobble: number;
  lag: number;
  seed: number;
}

export function handlingOf(stats: PodStats, parts: PodDamage, seed = 0): Handling {
  const h = parts.health;
  const lost = (id: PartId) => 1 - h[id];
  // An engine breathes through its intake and the fan behind it: a jammed fan chokes it like a crushed intake.
  const eL = (0.6 + 0.4 * Math.min(h.intakeL, h.fanL)) * (0.85 + 0.15 * h.nacelleL);
  const eR = (0.6 + 0.4 * Math.min(h.intakeR, h.fanR)) * (0.85 + 0.15 * h.nacelleR);
  const flaps = lost('flapL') - lost('flapR');
  // A binder wobbles once it snaps, or once the mount it hangs from on the cockpit gives way.
  const tether = (binder: PartId, mount?: PartId) =>
    (parts.broken.has(binder) || (mount && parts.broken.has(mount)) ? 0.1 : 0) + Math.max(lost(binder), mount ? lost(mount) : 0) * 0.04;
  const wobble = tether('binderL', 'mountL') + tether('binderR', 'mountR') + tether('binderMid');
  // The nozzle shapes the exhaust; the petals round it trim it a little more.
  const exhaust = 0.045 * (lost('nozzleL') + lost('nozzleR')) + 0.015 * (lost('petalsL') + lost('petalsR'));
  return {
    stats: { ...stats, thrust: (stats.thrust * (eL + eR)) / 2, topSpeed: stats.topSpeed * (1 - exhaust) },
    turnL: 1 - 0.3 * lost('finL'),
    turnR: 1 - 0.3 * lost('finR'),
    brake: 1 - 0.2 * (lost('flapL') + lost('flapR')),
    pull: 0.04 * flaps,
    brakePull: 0.2 * flaps,
    thrustPull: 0.3 * (eL - eR),
    wobble,
    lag: 0.14 * (lost('cableL') + lost('cableR')),
    seed,
  };
}

export type Phase = 'intro' | 'countdown' | 'racing' | 'finished';

export interface RaceEvents {
  onLap?(r: Racer, lapTime: number, best: boolean): void;
  onFinish?(r: Racer): void;
  onImpact?(r: Racer, strength: number): void;
  /** A hit damaged parts (pod space, see damage.ts): dent the pod at `hit.point`, break off the parts that broke. */
  onParts?(r: Racer, hits: PartHit[], hit: Hit): void;
  onPad?(r: Racer): void;
  onWreck?(r: Racer): void;
  onRespawn?(r: Racer): void;
  onCountdown?(n: number): void;
}

export const COUNTDOWN = 3;
/** Seconds the camera flies over the grid before the countdown. */
export const INTRO = 3.5;
const STEP = 1 / 120;

export class Race {
  readonly track: Track;
  readonly racers: Racer[];
  /** The pod this screen's controls fly: the first racer with neither `ai` nor `remote`; null for a spectator. */
  readonly me: Racer | null;
  /** The racer the camera, the HUD and the audio are about: `me`, or whoever a spectator watches. */
  focus: Racer;
  phase: Phase = 'intro';
  /** Seconds since the start lights went green (negative during intro/countdown). */
  time = -(INTRO + COUNTDOWN);
  playerInput: PodInput = { ...NO_INPUT };
  /** When true the player's pod is flown by the AI (attract mode, screenshots, after the finish). */
  autopilot = false;
  /** Networked: while true the race waits on the grid (time does not run) until the server's go. */
  hold = false;
  private acc = 0;
  private lastCount = 99;
  private readonly playerAi: AiProfile = { skill: 0.9, bias: 0, aggression: 0.6 };
  /** Per-racer control input after the damage has had its say (reused every step). */
  private readonly ctrls: PodInput[];

  readonly laps = 1;

  constructor(def: TrackDef, setups: RacerSetup[], private events: RaceEvents = {}) {
    this.track = new Track(def);
    // Grid: two columns, the player at the back, 16 m between rows, on the run-up just behind the start line.
    this.racers = setups.map((r, i) => {
      const row = Math.floor(i / 2);
      const col = i % 2 === 0 ? -1 : 1;
      const s = this.track.startS - 12 - row * 16 - (col > 0 ? 7 : 0);
      const x = col * Math.min(7, this.track.frameAt(s).width / 4);
      const parts = newPodDamage();
      return {
        ...r, state: newPodState(s, x), lap: -1, lapStart: 0, lapTimes: [], bestLap: Infinity, finish: null, position: i + 1,
        progress: 0, input: { ...NO_INPUT }, damage: [0, 0, 0], parts, anchors: partAnchors(r.pod.shape),
        handling: handlingOf(r.stats, parts, i * 7.3), steerOut: 0, wrecked: 0, ghost: 0, hurtCool: 0, lastHit: null,
        wreck: newWreck(),
      };
    });
    this.ctrls = this.racers.map(() => ({ ...NO_INPUT }));
    this.me = this.racers.find((r) => !r.ai && !r.remote) ?? null;
    this.focus = this.me ?? this.racers[0];
    this.updateOrder();
  }

  /** The racer the screen is about (see `focus`); in a solo race always the player's own pod. */
  get player(): Racer {
    return this.focus;
  }

  /** Advances the race by dt seconds of real time (fixed 120 Hz substeps). */
  update(dt: number) {
    if (this.hold) {
      this.acc = 0;
      return;
    }
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.step(STEP);
    }
  }

  private step(dt: number) {
    this.time += dt;
    if (this.phase === 'intro' && this.time >= -COUNTDOWN) this.phase = 'countdown';
    if (this.phase === 'countdown') {
      const n = Math.ceil(-this.time);
      if (n !== this.lastCount && n <= COUNTDOWN) {
        this.lastCount = n;
        this.events.onCountdown?.(n);
      }
      if (this.time >= 0) {
        this.phase = 'racing';
        this.events.onCountdown?.(0);
      }
    }
    const live = this.phase === 'racing' || this.phase === 'finished';

    const others = this.racers.map((r) => ({ s: r.state.s, x: r.state.x, v: r.state.v }));
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      if (r.remote) {
        this.stepRemote(r, dt);
        continue;
      }
      let input: PodInput;
      if (!live) {
        // Engines revving on the grid: hold position.
        input = { ...NO_INPUT, throttle: 0 };
      } else if (r === this.me && !this.autopilot && r.finish === null) {
        input = this.playerInput;
      } else {
        const profile = r.ai ?? this.playerAi;
        input = aiInput(this.track, {
          state: r.state,
          stats: r.stats,
          profile,
          gapToPlayer: r === this.me ? 0 : r.progress - (this.me ?? this.focus).progress,
          others: others.filter((_, j) => j !== i),
          wear: Math.max(...r.damage),
        }, this.time);
        // Finished pods coast to a stop on the run-off.
        if (r.finish !== null) input = { ...input, throttle: 0, brake: 0.4, boost: false, roll: 0 };
      }
      if (!live) {
        r.input = input;
        continue;
      }
      r.hurtCool = Math.max(0, r.hurtCool - dt);
      r.ghost = Math.max(0, r.ghost - dt);
      if (r.wrecked > 0) {
        r.input = { ...NO_INPUT };
        this.stepWreck(r, dt);
        if (r.state.impact > 0.02) this.events.onImpact?.(r, r.state.impact);
        r.wrecked -= dt;
        if (r.wrecked <= 0) this.respawn(r);
        continue;
      }
      r.input = input;
      const prevS = r.state.s;
      stepPod(r.state, this.control(r, i, input, dt), this.track, r.handling.stats, dt);
      if (r.state.impact > 0.02) this.events.onImpact?.(r, r.state.impact);
      const hit = r.state.hit;
      // Landings never hurt: a jump is part of the course (the hit is still there for the dust).
      if (hit && hit.kind !== 'landing') this.hurt(r, hit);
      if (r.state.headOn && hit) this.headOn(r, hit);
      if (r.state.padHit) this.events.onPad?.(r);
      // Crossing the start line, then the finish line.
      const line = r.lap < 0 ? this.track.startS : this.track.finishS;
      if (r.lap < 1 && prevS < line && r.state.s >= line) this.crossLine(r);
    }
    if (live) {
      this.contacts();
      this.slipstream();
    }
    this.updateOrder();
  }

  private crossLine(r: Racer) {
    r.lap++;
    if (r.lap >= 1) {
      const t = this.time - r.lapStart;
      const best = t < r.bestLap;
      if (best) r.bestLap = t;
      r.lapTimes.push(t);
      if (r.finish === null) this.events.onLap?.(r, t, best);
    }
    r.lapStart = this.time;
    if (r.lap >= this.laps && r.finish === null) {
      r.finish = this.time;
      this.events.onFinish?.(r);
      if (r === this.me) this.phase = 'finished';
    }
  }

  /** Pods shove each other sideways and trade a little speed when they touch. */
  private contacts() {
    for (let i = 0; i < this.racers.length; i++) {
      for (let j = i + 1; j < this.racers.length; j++) {
        // Ghosts and wrecks fly through everyone.
        if (!this.solid(this.racers[i]) || !this.solid(this.racers[j])) continue;
        const a = this.racers[i].state;
        const b = this.racers[j].state;
        const ds = b.s - a.s;
        const dx = b.x - a.x;
        const reachS = 7;
        const reachX = podHalfWidth(a) + podHalfWidth(b) - 0.4;
        if (Math.abs(ds) < reachS && Math.abs(dx) < reachX && Math.abs(a.h - b.h) < 2) {
          const overlapX = reachX - Math.abs(dx);
          const overlapS = reachS - Math.abs(ds);
          if (overlapX / reachX < overlapS / reachS) {
            // Side by side: push apart laterally and knock both velocities outwards; harder the deeper the overlap.
            const push = overlapX / 2 + 0.05;
            const side = dx >= 0 ? 1 : -1;
            // How fast they closed sideways (x + right, so -v sin(phi)): a swipe hits harder than drifting together.
            const closing = Math.max(0, (b.v * Math.sin(b.phi) - a.v * Math.sin(a.phi)) * side);
            const energy = 0.03 + closing / 40 + overlapX * 0.02;
            const ra = this.racers[i];
            const rb = this.racers[j];
            a.x -= push * side;
            b.x += push * side;
            const kick = 0.03 + Math.min(0.06, overlapX * 0.02);
            a.phi += kick * side;
            b.phi -= kick * side;
            a.yawRate += kick * side * 2;
            b.yawRate -= kick * side * 2;
            // Rubbing costs both a little speed.
            a.v *= 0.997;
            b.v *= 0.997;
            const hit = Math.min(1, overlapX / 2.5);
            this.bump(ra, hit * 0.5, side);
            this.bump(rb, hit * 0.5, -side);
            // Flank to flank, further forward on the one behind.
            this.hurt(ra, sideHit(a, side, -ds * 0.5, energy, 'pod'));
            this.hurt(rb, sideHit(b, -side, ds * 0.5, energy, 'pod'));
          } else {
            // Nose to tail: the one behind loses speed, the one in front gains a little.
            const [back, front] = ds > 0 ? [a, b] : [b, a];
            const dv = back.v - front.v;
            if (dv > 0) {
              back.v -= dv * 0.6;
              front.v += dv * 0.3;
              const hit = Math.min(1, dv / 15);
              const rb = back === a ? this.racers[i] : this.racers[j];
              const rf = front === a ? this.racers[i] : this.racers[j];
              this.bump(rb, hit, 0);
              this.bump(rf, hit * 0.6, 0);
              // The one behind on its intakes and claws (more on the side the other is on), the one in front on its
              // tail and nozzles: each on the parts reaching furthest towards the other.
              const lat = front.x - back.x;
              const along = front.s - back.s;
              const gap = Math.hypot(lat, along) || 1;
              const e = Math.min(1.6, dv / 32);
              this.ground(rb, toPodSpace(lat / gap, 0, -along / gap, back.psi, 0, knifeAngle(back)), e, 'pod', true);
              this.ground(rf, toPodSpace(-lat / gap, 0, along / gap, front.psi, 0, knifeAngle(front)), e * 0.7, 'pod', true);
            }
            const sep = (overlapS / 2) * Math.sign(ds || 1);
            a.s = this.track.clamp(a.s - sep * 0.5);
            b.s = this.track.clamp(b.s + sep * 0.5);
          }
        }
      }
    }
  }

  private solid(r: Racer) {
    return r.wrecked <= 0 && r.ghost <= 0 && !r.gone;
  }

  /**
   * Damages the pod's parts with a hit. A contact that goes on (a scrape, a pod leaning on another) counts once per
   * HURT_COOL; within that only a harder push adds (what it adds over the first), or a contact somewhere else on the
   * pod. `cooled` false (a wreck's bounces, a landing) always counts. Ghosts and finished pods take nothing.
   */
  private hurt(r: Racer, hit: Hit, cooled = true) {
    // A remote pod's damage is worked out on its owner's screen.
    if (r.remote || r.ghost > 0 || r.finish !== null) return;
    if (cooled) {
      const last = r.lastHit;
      const p = hit.point;
      if (r.hurtCool > 0 && last && Math.hypot(p[0] - last.point[0], p[1] - last.point[1], p[2] - last.point[2]) < HURT_APART) {
        if (hit.energy <= last.energy) return;
        const more = Math.sqrt(hit.energy ** 2 - last.energy ** 2);
        last.energy = hit.energy;
        hit = { ...hit, energy: more };
      } else r.lastHit = { point: p, energy: hit.energy };
      r.hurtCool = HURT_COOL;
    }
    const out = applyHit(r.parts, r.anchors, hit);
    if (!out.length) return;
    r.damage = damageSummary(r.parts);
    r.handling = handlingOf(r.stats, r.parts, r.handling.seed);
    this.events.onParts?.(r, out, hit);
    if (r.wrecked <= 0 && isWrecked(r.parts)) this.wreckPod(r);
  }

  /** Nose square into a rock at speed: the pod is gone, whatever its parts had left. Ghosts and finished pods pass. */
  private headOn(r: Racer, hit: Hit) {
    if (r.wrecked > 0 || r.ghost > 0 || r.finish !== null) return;
    const out = shatter(r.parts, hit.point[0]);
    r.damage = damageSummary(r.parts);
    r.handling = handlingOf(r.stats, r.parts, r.handling.seed);
    if (out.length) this.events.onParts?.(r, out, hit);
    this.wreckPod(r);
  }

  /** The pod meets a surface lying `toward` (pod space): the parts reaching furthest that way take it (contactHits). */
  private ground(r: Racer, toward: [number, number, number], energy: number, kind: HitKind, cooled = false) {
    for (const h of contactHits(r.anchors, toward, energy, kind, r.parts)) this.hurt(r, h, cooled);
  }

  /** The stick as the damaged pod passes it on: weaker towards a missing fin, pulls, wobble, lag. No allocations. */
  private control(r: Racer, k: number, input: PodInput, dt: number): PodInput {
    const h = r.handling;
    const c = this.ctrls[k];
    c.throttle = input.throttle;
    c.boost = input.boost;
    c.roll = input.roll;
    c.brake = input.brake * h.brake;
    let steer = input.steer * (input.steer < 0 ? h.turnL : h.turnR);
    steer += h.pull + h.brakePull * input.brake + h.thrustPull * input.throttle;
    if (h.wobble > 0) steer += h.wobble * (Math.sin(this.time * 6.1 + h.seed) * 0.6 + Math.sin(this.time * 13.7 + h.seed * 2) * 0.4);
    r.steerOut = h.lag > 0 ? r.steerOut + (steer - r.steerOut) * (1 - Math.exp(-dt / h.lag)) : steer;
    c.steer = Math.max(-1, Math.min(1, r.steerOut));
    return c;
  }

  /**
   * The pod goes down: thrown up and away from what it hit, spinning hardest about its length (harder the faster it
   * was going), the nose kicked up or down and slewed round.
   */
  private wreckPod(r: Racer) {
    const st = r.state;
    const k = Math.min(1.3, st.v / 90);
    const side = st.impactSide || (Math.random() < 0.5 ? -1 : 1);
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    r.wrecked = WRECK_TIME;
    st.boosting = false;
    st.boostLeft = 0;
    r.wreck = {
      h: st.h,
      vy: Math.max(st.vy, 0) + 5 + 9 * k,
      vx: -side * rnd(4, 10) * k,
      roll: 0,
      pitch: 0,
      yaw: 0,
      wr: side * rnd(5, 9) * (0.4 + k),
      wp: rnd(-3, 3) * k,
      wy: -side * rnd(1, 3) * k,
      rest: false,
    };
    this.events.onWreck?.(r);
  }

  /**
   * A wreck in flight: it keeps most of its speed in the air and tumbles; each time it comes down it bounces (lower
   * every time, each bounce a hit with sparks and a crunch), the ground grabs at it so it slews round, and once it stops
   * bouncing it skids to a stop and settles flat or on its back.
   */
  private stepWreck(r: Racer, dt: number) {
    const st = r.state;
    const w = r.wreck;
    st.impact = 0;
    st.boosting = false;
    st.boostLeft = 0;
    // The ground under it (a ledge, a tunnel floor, a kicker).
    const g = this.track.lift(st.s, st.x);
    st.v = Math.max(0, st.v - (w.h - g > 0.05 ? 7 : 55) * dt);
    st.s = this.track.clamp(st.s + st.v * dt);
    const lim = this.track.frameAt(st.s).width / 2 - 3;
    st.x += w.vx * dt;
    if (Math.abs(st.x) > lim) {
      // Off the wall and back into the corridor, on whatever part faces the wall.
      this.ground(r, toPodSpace(Math.sign(st.x), 0, 0, w.yaw, w.pitch, w.roll), Math.min(2, Math.abs(w.vx) / 10 + 0.2), 'wall');
      st.x = Math.sign(st.x) * lim;
      w.vx = -w.vx * 0.5;
      w.wy = -w.wy;
      st.impact = Math.min(1, Math.abs(w.vx) / 8 + 0.3);
      st.impactSide = Math.sign(st.x);
    }
    if (!w.rest) {
      w.vy -= WRECK_GRAVITY * dt;
      w.h += w.vy * dt;
      if (w.h <= g) {
        w.h = g;
        if (w.vy < -3) {
          // The bounce lands on the lowest parts: the world's down turned into the tumbling pod.
          this.ground(r, toPodSpace(0, -1, 0, w.yaw, w.pitch, w.roll), Math.min(2, -w.vy / 12), 'ground');
          st.impact = Math.min(1, -w.vy / 12);
          st.impactSide = 0;
          w.vy *= -WRECK_BOUNCE;
          w.wr *= 0.6;
          w.wp = -w.wp * 0.5 + (Math.random() - 0.5) * 2;
          w.wy += (Math.random() - 0.5) * 3;
          w.vx *= 0.7;
          st.v *= 0.82;
        } else {
          w.vy = 0;
          w.rest = true;
        }
      }
    }
    // On the ground the spin dies away and the wreck settles flat, or upside down if it is nearer that.
    if (w.rest) w.h = g;
    const ground = w.h - g < 0.4;
    const damp = Math.exp(-(ground ? 4 : 0.3) * dt);
    w.wr *= damp;
    w.wp *= damp;
    w.wy *= Math.exp(-(ground ? 2 : 0.2) * dt);
    if (ground) w.vx *= Math.exp(-3 * dt);
    w.roll += w.wr * dt;
    w.pitch += w.wp * dt;
    w.yaw += w.wy * dt;
    if (w.rest) {
      const ease = 1 - Math.exp(-5 * dt);
      w.roll += (Math.round(w.roll / Math.PI) * Math.PI - w.roll) * ease;
      w.pitch += (Math.round(w.pitch / Math.PI) * Math.PI - w.pitch) * ease;
    }
    st.h = w.h;
  }

  /** Back on the course where the pod went down, in the middle of the corridor (or the nearest lane clear of rocks). */
  private respawn(r: Racer) {
    const t = this.track;
    const st = r.state;
    const s = Math.max(t.startS + 5, Math.min(t.finishS - 5, st.s));
    const clear = (x: number) => !t.obstacles.some((o) => o.s > s - 15 && o.s < s + 90 && Math.abs(o.x - x) < o.r + 5);
    const hw = t.frameAt(s).width / 2 - 5;
    let x = 0;
    for (const c of [0, 6, -6, 12, -12, 18, -18, 24, -24]) {
      if (Math.abs(c) <= hw && clear(c)) {
        x = c;
        break;
      }
    }
    Object.assign(st, newPodState(s, x), { v: r.stats.topSpeed * 0.4, boost: st.boost });
    r.wreck = newWreck();
    r.parts = newPodDamage();
    r.damage = damageSummary(r.parts);
    r.handling = handlingOf(r.stats, r.parts, r.handling.seed);
    r.steerOut = 0;
    r.lastHit = null;
    r.hurtCool = 0;
    r.ghost = GHOST_TIME;
    this.events.onRespawn?.(r);
  }

  /** Reports a pod-to-pod hit (physics resets impacts every step, so contacts raise theirs after it). */
  private bump(r: Racer, strength: number, side: number) {
    if (strength <= r.state.impact) return;
    const fresh = r.state.impact < 0.02;
    r.state.impact = strength;
    if (side) r.state.impactSide = side;
    if (fresh && strength > 0.02) this.events.onImpact?.(r, strength);
  }

  /** Flying in someone's wake (close behind, lined up) gives a small top-speed bonus and refills boost faster. */
  private slipstream() {
    for (const r of this.racers) {
      for (const o of this.racers) {
        if (o === r || o.gone) continue;
        const d = o.state.s - r.state.s;
        if (d > 10 && d < 45 && Math.abs(o.state.x - r.state.x) < 4.5 && r.state.v > 40) {
          r.state.draft = 0.4;
          break;
        }
      }
    }
  }

  private updateOrder() {
    // On the grid s is just short of the start line, so progress is slightly negative.
    for (const r of this.racers) r.progress = r.state.s - this.track.startS;
    const order = [...this.racers].sort((a, b) => {
      if (a.gone || b.gone) return (a.gone ? 1 : 0) - (b.gone ? 1 : 0);
      if (a.finish !== null && b.finish !== null) return a.finish - b.finish;
      if (a.finish !== null) return -1;
      if (b.finish !== null) return 1;
      return b.progress - a.progress;
    });
    order.forEach((r, i) => (r.position = i + 1));
  }

  // --- Networked races (racer/net). Nothing here runs in a solo race. ---

  /** A remote pod between snapshots: not flown here; its cues reset like physics resets them, wreck/ghost run down. */
  private stepRemote(r: Racer, dt: number) {
    const st = r.state;
    st.impact = 0;
    st.padHit = false;
    st.hit = null;
    st.headOn = false;
    // They stay above zero while the snapshots say so (remoteFlags), counting down only for the ghost's blink.
    if (r.ghost > 0) r.ghost = Math.max(0.02, r.ghost - dt);
    if (r.wrecked > 0) r.wrecked = Math.max(0.02, r.wrecked - dt);
    r.lap = r.finish !== null ? 1 : st.s >= this.track.startS ? 0 : -1;
  }

  /** Listens to the race's events next to the ones given to the constructor (the view's), which still run first. */
  addEvents(more: RaceEvents) {
    const a = this.events;
    const merged: Record<string, (...args: never[]) => void> = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(more)]) as Set<keyof RaceEvents>) {
      merged[k] = (...args: never[]) => {
        (a[k] as ((...x: never[]) => void) | undefined)?.(...args);
        (more[k] as ((...x: never[]) => void) | undefined)?.(...args);
      };
    }
    this.events = merged as RaceEvents;
  }

  /**
   * Puts the race on the server's clock (`t` = seconds since green, negative before). Before the green light (or when
   * far off) it jumps there: a late go shortens the intro, one after the green goes straight into the race. Once racing
   * it only eases towards it, a few milliseconds per call, so the physics never sees a jump.
   */
  setClock(t: number) {
    const err = t - this.time;
    const grid = this.phase === 'intro' || this.phase === 'countdown';
    if ((grid && Math.abs(err) > 0.1) || Math.abs(err) > 1) {
      this.time = t;
      if (grid && t >= 0) {
        this.phase = 'racing';
        this.lastCount = 0;
        if (t < 1) this.events.onCountdown?.(0);
      }
      return;
    }
    this.time += Math.max(-0.004, Math.min(0.004, err * 0.1));
  }

  /**
   * Moves a bot between remote (drawn from snapshots) and flown here by its AI, which carries on from the state the
   * snapshots left it in. Only for racers with an `ai` profile; `me` never changes.
   */
  setRemote(r: Racer, remote: boolean) {
    if (!!r.remote === remote) return;
    r.remote = remote;
    if (remote) return;
    r.lap = r.finish !== null ? 1 : r.state.s >= this.track.startS ? 0 : -1;
    r.lapStart = 0;
    r.handling = handlingOf(r.stats, r.parts, r.handling.seed);
    r.steerOut = 0;
    r.hurtCool = 0;
    r.lastHit = null;
    if (r.wrecked > 0) {
      r.wrecked = Math.min(r.wrecked, WRECK_TIME);
      r.wreck.rest = false;
    }
  }

  /** Changes a racer's pod design (the grid is built before everyone has picked): fires onRespawn for a new model. */
  setPod(r: Racer, pod: PodDesign, stats: PodStats) {
    r.pod = pod;
    r.stats = stats;
    r.anchors = partAnchors(pod.shape);
    r.parts = newPodDamage();
    r.damage = damageSummary(r.parts);
    r.handling = handlingOf(stats, r.parts, r.handling.seed);
    this.events.onRespawn?.(r);
  }

  /**
   * A remote pod's broken parts as its owner reports them. Newly broken ones break here too (onParts with a hit on
   * the first of them, so the view breaks them off and throws them); a list that lost parts means the owner respawned
   * the pod (onRespawn, fresh parts).
   */
  remoteParts(r: Racer, broken: readonly string[]) {
    const now = new Set(broken as PartId[]);
    for (const id of r.parts.broken) {
      if (!now.has(id)) {
        r.parts = newPodDamage();
        this.events.onRespawn?.(r);
        break;
      }
    }
    const hits: PartHit[] = [];
    for (const id of now) {
      if (r.parts.broken.has(id) || !(id in r.parts.health)) continue;
      hits.push({ part: id, amount: r.parts.health[id], health: 0, broke: true });
      r.parts.health[id] = 0;
      r.parts.broken.add(id);
    }
    if (!hits.length) return;
    const p = r.anchors[hits[0].part].pos;
    const n = Math.hypot(p[0], p[1], p[2]) || 1;
    this.events.onParts?.(r, hits, { point: [...p], dir: [-p[0] / n, -p[1] / n, -p[2] / n], energy: 0.9, kind: 'pod' });
  }

  /** A remote pod's wrecked / ghost flags: going down fires onWreck; both run down only for the view (stepRemote). */
  remoteFlags(r: Racer, wrecked: boolean, ghost: boolean) {
    if (wrecked && r.wrecked <= 0) {
      r.wrecked = WRECK_TIME;
      this.events.onWreck?.(r);
    } else if (!wrecked) r.wrecked = 0;
    if (ghost && r.ghost <= 0) r.ghost = GHOST_TIME;
    else if (!ghost) r.ghost = 0;
  }

  /** A pod's finish as the server classified it (remote pods never cross the line here). */
  setFinish(r: Racer, time: number) {
    if (r.finish !== null) return;
    r.finish = time;
    r.lap = 1;
    r.lapTimes.push(time);
    r.bestLap = Math.min(r.bestLap, time);
    this.updateOrder();
  }

  /**
   * Final classification once the player has finished: pods still racing get a projected time from their remaining
   * distance at their average pace, so the results screen does not have to wait for everyone.
   */
  classification(): { racer: Racer; time: number; projected: boolean }[] {
    const total = this.track.raceLength;
    return [...this.racers]
      .map((r) => {
        if (r.finish !== null) return { racer: r, time: r.finish, projected: false };
        const done = Math.max(1, r.progress);
        const pace = this.time / done;
        return { racer: r, time: this.time + (total - done) * pace, projected: true };
      })
      .sort((a, b) => a.time - b.time);
  }
}
