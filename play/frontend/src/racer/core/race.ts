// One race: the grid, the countdown, every pod's flight, contacts between pods, slipstream, positions and the final
// classification. Courses are point-to-point, so a race is one run from the start line to the finish line. Pure simulation: no three.js scene, no DOM. RaceView renders it; the career awards it.
// Hits damage a pod where they land (the engine on that side, or the cockpit from behind and on hard landings); once a
// part is wrecked the pod is thrown up tumbling, bounces and skids to a stop (see stepWreck), then is put back in the middle of the corridor as a ghost that blinks and
// cannot be hit for a few seconds.

import { aiInput, type AiProfile } from './ai';
import { NO_INPUT, newPodState, podHalfWidth, stepPod, type PodInput, type PodState } from './physics';
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
  /** Damage per part, 0..1: left engine, right engine, cockpit. A part at 1 wrecks the pod. */
  damage: [number, number, number];
  /** Seconds left lying wrecked (0 = flying), and seconds left as a ghost after the respawn. */
  wrecked: number;
  ghost: number;
  /** Seconds before the next hit can do damage (one crash is one hit, not one per physics step). */
  hurtCool: number;
  /** The tumble of a wreck (meaningful while `wrecked` > 0). */
  wreck: Wreck;
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
export const WRECK_TIME = 3;
/** Gravity on a tumbling wreck, and how much of its vertical speed survives a bounce. */
const WRECK_GRAVITY = 24;
const WRECK_BOUNCE = 0.45;
export const GHOST_TIME = 3;
/** Damage per unit of impact above the threshold that a scrape stays under. */
const HURT = 0.42;
const HURT_MIN = 0.12;
/** The same for walls, rocks and landings: a square hit wrecks the part, a solid one does over half. */
const TERRAIN_HURT = 1.2;

export type Phase = 'intro' | 'countdown' | 'racing' | 'finished';

export interface RaceEvents {
  onLap?(r: Racer, lapTime: number, best: boolean): void;
  onFinish?(r: Racer): void;
  onImpact?(r: Racer, strength: number): void;
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
  readonly player: Racer;
  phase: Phase = 'intro';
  /** Seconds since the start lights went green (negative during intro/countdown). */
  time = -(INTRO + COUNTDOWN);
  playerInput: PodInput = { ...NO_INPUT };
  /** When true the player's pod is flown by the AI (attract mode, screenshots, after the finish). */
  autopilot = false;
  private acc = 0;
  private lastCount = 99;
  private readonly playerAi: AiProfile = { skill: 0.9, bias: 0, aggression: 0.6 };

  readonly laps = 1;

  constructor(def: TrackDef, setups: RacerSetup[], private events: RaceEvents = {}) {
    this.track = new Track(def);
    // Grid: two columns, the player at the back, 16 m between rows, on the run-up just behind the start line.
    this.racers = setups.map((r, i) => {
      const row = Math.floor(i / 2);
      const col = i % 2 === 0 ? -1 : 1;
      const s = this.track.startS - 12 - row * 16 - (col > 0 ? 7 : 0);
      const x = col * Math.min(7, this.track.frameAt(s).width / 4);
      return { ...r, state: newPodState(s, x), lap: -1, lapStart: 0, lapTimes: [], bestLap: Infinity, finish: null, position: i + 1, progress: 0, input: { ...NO_INPUT }, damage: [0, 0, 0], wrecked: 0, ghost: 0, hurtCool: 0, wreck: newWreck() };
    });
    this.player = this.racers.find((r) => !r.ai) ?? this.racers[0];
    this.updateOrder();
  }

  /** Advances the race by dt seconds of real time (fixed 120 Hz substeps). */
  update(dt: number) {
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
      let input: PodInput;
      if (!live) {
        // Engines revving on the grid: hold position.
        input = { ...NO_INPUT, throttle: 0 };
      } else if (r === this.player && !this.autopilot && r.finish === null) {
        input = this.playerInput;
      } else {
        const profile = r.ai ?? this.playerAi;
        input = aiInput(this.track, {
          state: r.state,
          stats: r.stats,
          profile,
          gapToPlayer: r === this.player ? 0 : r.progress - this.player.progress,
          others: others.filter((_, j) => j !== i),
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
      stepPod(r.state, input, this.track, r.stats, dt);
      if (r.state.impact > 0.02) {
        this.events.onImpact?.(r, r.state.impact);
        const side = r.state.impactSide;
        this.hurt(r, r.state.impact, side < 0 ? [LEFT_ENGINE] : side > 0 ? [RIGHT_ENGINE] : [COCKPIT], TERRAIN_HURT);
      }
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
      if (r === this.player) this.phase = 'finished';
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
            this.bump(this.racers[i], hit * 0.5, side);
            this.bump(this.racers[j], hit * 0.5, -side);
            this.hurt(this.racers[i], hit * 0.4, [side > 0 ? RIGHT_ENGINE : LEFT_ENGINE]);
            this.hurt(this.racers[j], hit * 0.4, [side > 0 ? LEFT_ENGINE : RIGHT_ENGINE]);
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
              this.hurt(rb, hit * 0.6, [LEFT_ENGINE, RIGHT_ENGINE]);
              this.hurt(rf, hit * 0.45, [COCKPIT]);
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
    return r.wrecked <= 0 && r.ghost <= 0;
  }

  /** Damages `parts` (shared between them) for a hit of `strength`; a part reaching 1 wrecks the pod. */
  private hurt(r: Racer, strength: number, parts: number[], rate = HURT) {
    if (!this.solid(r) || r.finish !== null || r.hurtCool > 0 || strength < HURT_MIN) return;
    r.hurtCool = 0.3;
    const d = ((strength - HURT_MIN) * rate) / parts.length;
    for (const p of parts) r.damage[p] = Math.min(1, r.damage[p] + d);
    if (r.damage.some((v) => v >= 1)) this.wreckPod(r);
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
    st.v = Math.max(0, st.v - (w.h > 0.05 ? 7 : 55) * dt);
    st.s = this.track.clamp(st.s + st.v * dt);
    const lim = this.track.frameAt(st.s).width / 2 - 3;
    st.x += w.vx * dt;
    if (Math.abs(st.x) > lim) {
      // Off the wall and back into the corridor.
      st.x = Math.sign(st.x) * lim;
      w.vx = -w.vx * 0.5;
      w.wy = -w.wy;
      st.impact = Math.min(1, Math.abs(w.vx) / 8 + 0.3);
      st.impactSide = Math.sign(st.x);
    }
    if (!w.rest) {
      w.vy -= WRECK_GRAVITY * dt;
      w.h += w.vy * dt;
      if (w.h <= 0) {
        w.h = 0;
        if (w.vy < -3) {
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
    const ground = w.h < 0.4;
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
    r.damage = [0, 0, 0];
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
        if (o === r) continue;
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
      if (a.finish !== null && b.finish !== null) return a.finish - b.finish;
      if (a.finish !== null) return -1;
      if (b.finish !== null) return 1;
      return b.progress - a.progress;
    });
    order.forEach((r, i) => (r.position = i + 1));
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
