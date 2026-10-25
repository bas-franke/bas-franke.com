// World-space speed effects for a race: billowing sand clouds under and behind every pod, exhaust heat trails, speed
// lines and sand grains rushing past the camera, sparks on wall hits, glow rings on boost pads and the shock cone of a
// boosting pod, and black smoke (with embers once it is bad) from damaged parts and wrecks. Built from a handful of
// instanced systems (10 draw calls); per-frame work is emitting new particles
// into ring buffers and updating a few uniforms, with no allocation.
//
// Destruction: when the race fills in a pod's contact (`hit`) the sparks, dust and paint flecks burst from the real
// contact point; with per-part `health` and `anchors` every damaged part smokes by its own health, engine parts that
// are nearly gone burn, and damaged or snapped binders arc. Smoking debris (`smokeSources`) gets rising columns and
// flames. Without those (menus, labs) the old per-side sparks and three smoke points are used.

import * as THREE from 'three';
import { PARTS, PART_IDS } from '../core/damage';
import type { PartAnchor, PartId } from '../core/damage';
import type { FxPod, FxView, SmokeSource, SpeedFx, WorldContext } from '../world/types';
import { FireSystem } from './fire';
import { qualityScale } from './particles';
import { AirSystem } from './speedAir';
import { BurstSystem } from './speedBursts';
import { DustSystem } from './speedDust';
import { TrailSystem } from './speedTrails';

const MAX_PODS = 16;
const MAX_TRAILS = 40;
const DEFAULT_GLOW = '#7f86ff';
const NONE: THREE.Object3D[] = [];
/** The binders' base colour (vehicle/pod.ts mixes 30 % of the livery glow into it); arcs match it. */
const BINDER = '#4feaff';

const NP = PART_IDS.length;
/** How much each part smokes when damaged (binders and cables crackle instead of smoking). */
const SMOKE_W = new Float32Array(PART_IDS.map((id) => {
  if (PARTS[id].group === 'binders') return 0;
  if (id.startsWith('nacelle') || id === 'hull') return 1;
  if (id.startsWith('nozzle')) return 0.7;
  if (id.startsWith('intake')) return 0.6;
  // A bent aerial or a loose armour plate is no fire: barely a wisp (the engine under the plate smokes for itself).
  if (id === 'antenna') return 0;
  if (id.startsWith('arm')) return 0.15;
  return id === 'cockpitNose' || id === 'tail' ? 0.5 : 0.35;
}));
/** Parts that catch fire as they wear down: the engines, and the cockpit hull once it is badly hurt (BURN_AT). */
const BURNS = PART_IDS.map((id) => /^(nacelle|intake|nozzle|fan)/.test(id) || id === 'hull');
/** 1 = an energy binder (arcs in its colour), 2 = a steering cable (spits hot sparks), 0 = neither. */
const ARCS = PART_IDS.map((id) => (id.startsWith('binder') ? 1 : id.startsWith('cable') ? 2 : 0));
const HULL = PART_IDS.indexOf('hull');
const NACELLE = PART_IDS.map((id) => id.startsWith('nacelle'));
/**
 * Below this health a part catches fire: a lick of flame at first, growing into a blaze that pours off the pod as the
 * part goes (burnOf). The hull, being armoured, holds out longer.
 */
const BURN_AT = new Float32Array(PART_IDS.map((id) => (id === 'hull' ? 0.45 : 0.6)));
/** How fiercely a part with health `hv` burns, 0 (not yet) .. 1 (nearly gone), eased so it builds late. */
function burnOf(i: number, hv: number): number {
  const x = Math.min(1, Math.max(0, (BURN_AT[i] - hv) / BURN_AT[i]));
  return x * (0.4 + 0.6 * x);
}

/**
 * How heavy the smoke of a part with damage `d` (1 - health) is, 0..1: thin grey wisps through moderate damage
 * (health 0.4-0.7 gives < 0.2), only turning thick and black towards the end (health 0.2 and below, and wrecks).
 */
function smokeHeavy(d: number): number {
  const x = Math.min(1, Math.max(0, (d - 0.3) / 0.65));
  return x * x;
}
const ARC_AT = 0.7;

interface PodState {
  init: boolean;
  prevGround: THREE.Vector3;
  acc: number;
  hitCool: number;
  wasPad: boolean;
  wasBoost: boolean;
  cone: number;
  /** Smoke emission accumulators per damage part, and whether the pod was wrecked last frame. */
  smoke: number[];
  wasWrecked: boolean;
  glow: THREE.Color;
  glowHex: string;
  /** Per-part emission accumulators (smoke puffs, flames, arcs), indexed like PART_IDS. */
  partSmoke: Float32Array;
  partFire: Float32Array;
  partArc: Float32Array;
  /** Livery paint (flecks knocked off in pod hits, brightened for additive drawing) and the binders' arc colour. */
  paint: THREE.Color[];
  arc: THREE.Color;
  paintKey: string;
}

export function createSpeedFx(ctx: WorldContext): SpeedFx {
  const { theme, quality, camera } = ctx;
  const qs = qualityScale(quality);
  const group = new THREE.Group();
  group.name = 'speedFx';

  const sunDir = new THREE.Vector3(Math.sin(theme.sunAzimuth), Math.tan(theme.sunElevation), Math.cos(theme.sunAzimuth)).normalize();
  const dust = new DustSystem(Math.round(5200 * qs), theme, sunDir);
  const trails = new TrailSystem(MAX_TRAILS);
  const air = new AirSystem(Math.round(150 * Math.max(0.35, qs)), Math.round(420 * qs), new THREE.Color(theme.sand), new THREE.Color(theme.sunColor));
  const bursts = new BurstSystem(Math.round(700 * Math.max(0.35, qs)), 24, MAX_PODS);
  const fireCount = Math.round(1400 * Math.max(0.4, qs));
  const fire = new FireSystem(fireCount);
  // Smoke is grey here and darkened per puff with the damage; it streaks more than dust so it reads as speed.
  const smokeCount = Math.round(2600 * Math.max(0.4, qs));
  const smoke = new DustSystem(smokeCount, theme, sunDir, {
    tint: { lit: new THREE.Vector3(0.5, 0.48, 0.46), shade: new THREE.Vector3(0.13, 0.125, 0.13) },
    near: [2, 9],
    shutter: 0.06,
  });
  smoke.mesh.name = 'smoke';
  dust.mesh.name = 'dust';
  trails.mesh.name = 'trails';
  air.motes.name = 'motes';
  air.lines.name = 'lines';
  bursts.sparks.name = 'sparks';
  bursts.rings.name = 'rings';
  bursts.cones.name = 'cones';
  fire.mesh.name = 'fire';
  group.add(smoke.mesh, dust.mesh, trails.mesh, air.motes, air.lines, bursts.sparks, bursts.rings, bursts.cones, fire.mesh);

  const states: PodState[] = [];
  const camVel = new THREE.Vector3();
  const prevCam = new THREE.Vector3();
  let camInit = false;
  let playerBoost = 0;

  // Scratch objects, reused every frame.
  const right = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const v = new THREE.Vector3();
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  const padColor = new THREE.Color(3.2, 1.35, 0.3);
  const ringColor = new THREE.Color();
  const puff = { pos: new THREE.Vector3(), normal: new THREE.Vector3(), vel: new THREE.Vector3(), size0: 0, size1: 0, life: 0, opacity: 0, rise: 0, drag: 0, shade: 1 };
  const fireColor = new THREE.Color(3.4, 1.2, 0.25);
  const flashColor = new THREE.Color(3, 2.2, 1.2);
  const chipColor = new THREE.Color(0.85, 0.66, 0.46);
  const flame = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), size0: 0, size1: 0, life: 0, rise: 0, drag: 0, heat: 0 };
  // More scratch for the destruction effects (kept apart from p/q/v, which the emit helpers use).
  const ap = new THREE.Vector3();
  const podRight = new THREE.Vector3();
  const segA = new THREE.Vector3();
  const segB = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const rates = new Float32Array(NP);
  let frameDt = 0;
  // Per-frame emission budgets for the other pods and the debris, so a pack of wrecks never churns the ring buffers
  // faster than their puffs live (the player's own effects always get through).
  let smokeLeft = 0;
  let fireLeft = 0;

  const stateFor = (k: number): PodState => {
    let s = states[k];
    if (!s) {
      s = {
        init: false, prevGround: new THREE.Vector3(), acc: 0, hitCool: 0, wasPad: false, wasBoost: false, cone: 0,
        smoke: [0, 0, 0], wasWrecked: false, glow: new THREE.Color(DEFAULT_GLOW), glowHex: '',
        partSmoke: new Float32Array(NP), partFire: new Float32Array(NP), partArc: new Float32Array(NP),
        paint: [new THREE.Color(), new THREE.Color(), new THREE.Color()], arc: new THREE.Color(), paintKey: '',
      };
      states[k] = s;
    }
    return s;
  };

  /** Whole emissions for a fractional count this frame (no accumulator: used where there is no state to keep). */
  const stochastic = (x: number) => Math.floor(x + Math.random());

  /** Sand kicked up from the road under/behind a pod. `wide` puffs are the slow, broad wake that spreads sideways. */
  function emitDust(fp: FxPod, s: PodState, intensity: number, far: boolean) {
    const t = Math.random();
    const wide = Math.random() < 0.25;
    const pl = fp.isPlayer;
    // The player's own dust is pushed out to the sides so it frames the pod instead of hiding it from the camera.
    const sign = Math.random() < 0.5 ? -1 : 1;
    const lat = pl ? sign * (wide ? 5 + Math.random() * 6 : 3 + Math.random() * 4) : (Math.random() * 2 - 1) * 4.5 * (wide ? 1.3 : 1);
    const along = pl ? -(2 + Math.random() * 8) : -(1 + Math.random() * 6);
    puff.pos.copy(s.prevGround).lerp(fp.ground, t).addScaledVector(fwd, along).addScaledVector(right, lat);
    puff.normal.copy(fp.groundNormal);
    const out = Math.sign(lat) * (wide ? 6 + Math.random() * 10 : 2 + Math.random() * 7) * (pl ? 1.4 : 1) * Math.min(1.2, intensity + 0.2);
    // The player's dust is carried along with the pod for a moment (a cheat: real dust would stop) so it frames the
    // pod instead of flashing past the camera, but it drops back soon enough not to hang in front of the view.
    const carry = pl ? (wide ? 0.45 + Math.random() * 0.2 : 0.55 + Math.random() * 0.2) : wide ? 0.18 + Math.random() * 0.2 : 0.3 + Math.random() * 0.35;
    puff.vel.copy(fp.velocity).multiplyScalar(carry).addScaledVector(right, out);
    const big = far ? 1.4 : pl ? 1 : 1.15;
    const grow = 0.6 + 0.4 * Math.min(1.3, intensity);
    puff.size0 = (1.2 + Math.random() * 1.6) * big;
    puff.size1 = (wide ? 10 + Math.random() * 7 : 5 + Math.random() * 5) * grow * big * (pl && !wide ? 0.7 : 1);
    puff.life = (wide ? 2.2 + Math.random() * 1.3 : 1.1 + Math.random() * 1.1) * (pl ? 1 : 0.8);
    puff.opacity = (wide ? 0.2 : 0.26 + Math.random() * 0.18) * (pl ? 0.7 : 0.6) * (far ? 1.4 : 1);
    puff.rise = (wide ? 0.3 + Math.random() * 0.6 : 0.4 + Math.random() * 1.0) * (pl ? 0.6 : 1);
    puff.drag = 1.3 + Math.random() * 1.1;
    puff.shade = 1;
    dust.emit(puff);
  }

  function impactBurst(fp: FxPod, strength: number) {
    const side = fp.impactSide || (Math.random() < 0.5 ? -1 : 1);
    const n = Math.round((6 + strength * 34) * Math.max(0.4, qs));
    const pos = fp.visual.object.position;
    for (let j = 0; j < n; j++) {
      p.copy(pos).addScaledVector(right, side * (3.2 + Math.random() * 0.6)).addScaledVector(fwd, (Math.random() - 0.5) * 6).addScaledVector(up, (Math.random() - 0.4) * 1.5);
      v.copy(fp.velocity).multiplyScalar(0.55 + Math.random() * 0.35)
        .addScaledVector(right, -side * (2 + Math.random() * 10))
        .addScaledVector(up, 2 + Math.random() * 9)
        .addScaledVector(fwd, (Math.random() - 0.5) * 12);
      bursts.spark(p, v, 0.35 + Math.random() * 0.5, 0.025 + Math.random() * 0.03);
    }
    const puffs = Math.round(3 + strength * 6);
    for (let j = 0; j < puffs; j++) {
      puff.pos.copy(fp.ground).addScaledVector(right, side * (4 + Math.random() * 2)).addScaledVector(fwd, -Math.random() * 6);
      puff.normal.copy(fp.groundNormal);
      puff.vel.copy(fp.velocity).multiplyScalar(0.45).addScaledVector(right, -side * Math.random() * 5);
      puff.size0 = 2 + Math.random() * 2;
      puff.size1 = 8 + Math.random() * 6;
      puff.life = 1.2 + Math.random();
      puff.opacity = 0.45;
      puff.rise = 2 + Math.random() * 3;
      puff.drag = 1.6;
      puff.shade = 1;
      dust.emit(puff);
    }
  }

  /**
   * Smoke from a part with damage `d` (0.25..1): light grey and thin at first, thick and black when the part is nearly
   * gone. At speed it is torn off in long streaks that stream back behind the pod; slow, it billows up around it. Puffs
   * are spread back along the pod's path over the frame, so a fast pod leaves an unbroken trail.
   */
  function emitSmoke(fp: FxPod, part: number, d: number) {
    fp.visual.damagePoints[part].getWorldPosition(ap);
    emitSmokeAt(fp, ap, d, 1);
  }

  /** Smoke from world point `src` (see emitSmoke); `scale` < 1 for small parts (a fin smokes less than an engine). */
  function emitSmokeAt(fp: FxPod, src: THREE.Vector3, d: number, scale: number) {
    if (!fp.isPlayer && smokeLeft <= 0) return;
    smokeLeft--;
    const heavy = smokeHeavy(d);
    const sp = Math.min(1.3, Math.max(0, fp.speed01));
    puff.pos.copy(src).addScaledVector(fp.velocity, -Math.random() * frameDt);
    puff.pos.x += (Math.random() - 0.5) * 1.2 * scale;
    puff.pos.z += (Math.random() - 0.5) * 1.2 * scale;
    puff.normal.set(0, 1, 0);
    // The player's smoke is torn off the part and streams back past the lens, sooner the faster the pod goes, and is
    // flung out to its own side (left parts left, right parts right) so it runs down the edges of the screen instead
    // of up the middle; everyone else's falls behind at once into a trail.
    const own = fp.isPlayer && !fp.wrecked;
    puff.vel.copy(fp.velocity).multiplyScalar(own ? 1 - 0.3 * Math.min(1, sp) : 0.7 - 0.35 * Math.min(1, sp) + Math.random() * 0.15);
    if (own) {
      podRight.setFromMatrixColumn(fp.visual.object.matrixWorld, 0).normalize();
      const off = v.copy(src).sub(fp.visual.object.position).dot(podRight);
      const side = Math.abs(off) > 0.3 ? Math.sign(off) : Math.random() < 0.5 ? -1 : 1;
      puff.vel.addScaledVector(podRight, side * (4 + 14 * Math.min(1, sp)) * (0.7 + Math.random() * 0.6));
    }
    const churn = 3 + 6 * sp;
    puff.vel.x += (Math.random() - 0.5) * churn;
    puff.vel.z += (Math.random() - 0.5) * churn;
    puff.size0 = (0.5 + Math.random() * 0.6) * (0.5 + 0.5 * scale);
    puff.size1 = (own ? 1.8 + Math.random() * 1.6 : 3 + Math.random() * 2.5) * (0.6 + 0.9 * heavy) * (1 - 0.35 * Math.min(1, sp)) * (fp.wrecked ? 1.6 : 1) * (0.55 + 0.45 * scale);
    // The player's own smoke billows round the pod when it is slow; kept small so it never blankets the view.
    if (own) puff.size1 = Math.min(puff.size1, (1.5 + 1.5 * heavy) * (1 + Math.min(1, sp)));
    puff.life = (own ? 1 + Math.random() * 0.5 : 1.2 + Math.random() * 0.9) + heavy * 0.7;
    puff.opacity = (0.16 + 0.5 * heavy) * (own ? 0.8 : 1);
    puff.rise = (2 + Math.random() * 2.5) * (1 - 0.4 * Math.min(1, sp)) * (own ? 0.5 : 1);
    puff.drag = own ? 0.4 + 1.4 * Math.min(1, sp) : 1.1 + Math.random() * 0.6;
    puff.shade = 1 - 0.88 * heavy;
    smoke.emit(puff);
    // Embers once the part is close to going.
    if (heavy > 0.5 && Math.random() < 0.5) {
      v.copy(fp.velocity).multiplyScalar(0.6).add(q.set((Math.random() - 0.5) * 5, 3 + Math.random() * 6, (Math.random() - 0.5) * 5));
      bursts.spark(puff.pos, v, 0.3 + Math.random() * 0.4, 0.03 + Math.random() * 0.03);
    }
  }

  /** A pod going down: a flash of fire, a shower of sparks thrown out all round and a burst of black smoke. */
  function wreckBurst(fp: FxPod) {
    const pos = fp.visual.object.position;
    bursts.ring(pos, right, up, 7, 0.35, fireColor);
    bursts.ring(pos, right, fwd, 11, 0.5, fireColor);
    for (let j = 0; j < 90 * Math.max(0.5, qs); j++) {
      v.copy(fp.velocity).multiplyScalar(0.6).add(q.set((Math.random() - 0.5) * 36, 3 + Math.random() * 22, (Math.random() - 0.5) * 36));
      bursts.spark(pos, v, 0.5 + Math.random() * 0.9, 0.04 + Math.random() * 0.05);
    }
    // A pod that has lost parts may have lost its smoke points with them: burst from the hull then.
    for (let j = 0; j < 18; j++) {
      if (fp.anchors) emitSmokeAt(fp, p.set(...fp.anchors.hull.pos).applyMatrix4(fp.visual.object.matrixWorld), 1, 1.3);
      else emitSmoke(fp, j % 3, 1);
    }
  }

  /** Brightened copies of the livery (additive sparks vanish if dark) and the binder arc colour, when it changes. */
  function paintFor(fp: FxPod, s: PodState) {
    const l = fp.livery;
    const key = l ? l.primary + l.secondary + l.accent + l.glow : '';
    if (key === s.paintKey) return;
    s.paintKey = key;
    s.paint[0].set(l?.primary ?? '#c0c0c0');
    s.paint[1].set(l?.secondary ?? '#808080');
    s.paint[2].set(l?.accent ?? '#ffffff');
    for (const c of s.paint) c.multiplyScalar(1.6).addScalar(0.15);
    s.arc.set(BINDER).lerp(s.glow, 0.3).multiplyScalar(5);
  }

  /** Two unit vectors across `dir` (the plane sparks fan out in). */
  function across(dir: THREE.Vector3) {
    t1.crossVectors(dir, Math.abs(dir.y) < 0.9 ? up : right).normalize();
    t2.crossVectors(dir, t1).normalize();
  }

  /**
   * A contact at its real point (world space): hot sparks spraying off the surface (`dir` points away from what was
   * hit) and carried along with the pod, plus by kind: sand and stone chips off a wall or rock, paint flecks in the
   * pod's livery from another pod, a ring of dust slammed out of the ground on a landing or belly scrape.
   */
  function hitBurst(fp: FxPod, s: PodState, hit: NonNullable<FxPod['hit']>) {
    const e = Math.min(2, Math.max(0, hit.energy));
    const e1 = Math.min(1.5, e);
    const ground = hit.kind === 'landing' || hit.kind === 'ground';
    const dir = hit.dir;
    across(dir);
    const n = Math.min(80, Math.round((4 + 36 * e1) * (ground ? 0.6 : 1) * Math.max(0.4, qs)));
    for (let j = 0; j < n; j++) {
      p.copy(hit.point).addScaledVector(t1, (Math.random() - 0.5) * 0.5).addScaledVector(t2, (Math.random() - 0.5) * 0.5);
      const spray = ground ? 6 + Math.random() * 14 : 4 + Math.random() * 14;
      v.copy(fp.velocity).multiplyScalar(0.5 + Math.random() * 0.4)
        .addScaledVector(dir, (ground ? 1 + Math.random() * 4 : 2 + Math.random() * 9) * (0.6 + 0.4 * e1))
        .addScaledVector(t1, (Math.random() - 0.5) * spray)
        .addScaledVector(t2, (Math.random() - 0.5) * spray)
        .addScaledVector(up, 1 + Math.random() * 5);
      bursts.spark(p, v, 0.3 + Math.random() * 0.5, 0.022 + Math.random() * 0.03 * (0.6 + 0.4 * e1));
    }
    if (e > 0.6) bursts.ring(hit.point, t1, t2, 1.2 + e, 0.14, flashColor);

    if (hit.kind === 'pod') {
      // Flecks of paint knocked off: slower, tumbling down under gravity.
      paintFor(fp, s);
      const nf = Math.round((3 + 10 * e1) * Math.max(0.5, qs));
      for (let j = 0; j < nf; j++) {
        v.copy(fp.velocity).multiplyScalar(0.6 + Math.random() * 0.3)
          .addScaledVector(dir, 2 + Math.random() * 5)
          .addScaledVector(t1, (Math.random() - 0.5) * 8)
          .addScaledVector(t2, (Math.random() - 0.5) * 8)
          .addScaledVector(up, 2 + Math.random() * 4);
        bursts.spark(hit.point, v, 0.5 + Math.random() * 0.6, 0.04 + Math.random() * 0.03, s.paint[j % 3], 1.1);
      }
    } else if (!ground) {
      // Wall or rock: a puff of sand and grit off the face, and (rock) chips of stone.
      const puffs = Math.round(2 + e1 * 5);
      for (let j = 0; j < puffs; j++) {
        puff.pos.copy(hit.point).addScaledVector(dir, -0.3).addScaledVector(t1, (Math.random() - 0.5) * 1.5).addScaledVector(t2, (Math.random() - 0.5) * 1.5);
        puff.normal.copy(dir);
        puff.vel.copy(fp.velocity).multiplyScalar(0.35 + Math.random() * 0.2).addScaledVector(dir, 2 + Math.random() * 4).addScaledVector(up, Math.random() * 2);
        puff.size0 = 1.4 + Math.random() * 1.2;
        puff.size1 = (5 + Math.random() * 4) * (0.7 + 0.3 * e1);
        puff.life = 0.9 + Math.random() * 0.7;
        puff.opacity = 0.4;
        puff.rise = 1.5;
        puff.drag = 1.8;
        puff.shade = hit.kind === 'rock' ? 0.8 : 0.95;
        dust.emit(puff);
      }
      if (hit.kind === 'rock') {
        for (let j = 0; j < Math.round(3 + 8 * e1); j++) {
          v.copy(fp.velocity).multiplyScalar(0.4 + Math.random() * 0.3)
            .addScaledVector(dir, 3 + Math.random() * 6)
            .addScaledVector(t1, (Math.random() - 0.5) * 10)
            .addScaledVector(up, 2 + Math.random() * 5);
          bursts.spark(hit.point, v, 0.6 + Math.random() * 0.5, 0.045 + Math.random() * 0.03, chipColor, 1.3);
        }
      }
    } else {
      // Landing or belly scrape: dust slammed out sideways all round under the pod.
      const puffs = Math.round((4 + 9 * e1) * Math.max(0.5, qs));
      for (let j = 0; j < puffs; j++) {
        const a = (j / puffs + Math.random() * 0.1) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        puff.pos.copy(fp.ground).addScaledVector(right, ca * (2 + Math.random() * 2)).addScaledVector(fwd, sa * (2 + Math.random() * 3));
        puff.normal.copy(fp.groundNormal);
        puff.vel.copy(fp.velocity).multiplyScalar(0.5).addScaledVector(right, ca * (8 + Math.random() * 10) * (0.5 + 0.5 * e1)).addScaledVector(fwd, sa * (6 + Math.random() * 8) * (0.5 + 0.5 * e1));
        puff.size0 = 2 + Math.random() * 1.5;
        puff.size1 = (7 + Math.random() * 5) * (0.7 + 0.3 * e1);
        puff.life = 1.1 + Math.random() * 0.7;
        puff.opacity = 0.32 + 0.12 * e1;
        puff.rise = 1 + Math.random();
        puff.drag = 2.2;
        puff.shade = 1;
        dust.emit(puff);
      }
    }
  }

  /** A flame tongue from a burning part at world point `src`; `f` 0..1 how fiercely, `r` the part's radius. */
  function emitFire(fp: FxPod, src: THREE.Vector3, f: number, r: number) {
    if (!fp.isPlayer && fireLeft <= 0) return;
    fireLeft--;
    const sp = Math.min(1, Math.max(0, fp.speed01));
    const own = fp.isPlayer && !fp.wrecked;
    // Tongues start on the part's skin (its top half and sides), so the fire looks attached to it.
    flame.pos.copy(src).addScaledVector(fp.velocity, -Math.random() * frameDt);
    flame.pos.x += (Math.random() - 0.5) * r * 1.2;
    // (From the top of its skin, not its centre, or a big part's flames would burn inside it until they were huge.)
    flame.pos.y += r * (0.45 + 0.5 * Math.random());
    flame.pos.z += (Math.random() - 0.5) * r * 0.8;
    // The gas falls back off the pod a little (the flame licks backwards); the player's rides closer, so its fire
    // stays on the engine instead of streaming into the lens.
    // A blaze is torn off harder and trails further back than a lick of flame.
    flame.vel.copy(fp.velocity).multiplyScalar(own ? 0.97 - (0.05 + 0.12 * f) * sp : 0.9 - (0.12 + 0.18 * f) * sp);
    flame.vel.x += (Math.random() - 0.5) * 1.2;
    flame.vel.z += (Math.random() - 0.5) * 1.2;
    flame.size0 = r * (0.14 + 0.1 * Math.random());
    flame.size1 = r * (0.35 + 0.25 * Math.random()) * (0.5 + 2.2 * f) * (fp.wrecked ? 1.4 : 1);
    flame.life = 0.14 + Math.random() * 0.14 + 0.3 * f;
    flame.rise = 6 + Math.random() * 6;
    flame.drag = own ? 0.2 : 0.8;
    flame.heat = 0.75 + 0.5 * f;
    fire.emit(flame);
    // Embers spat out of the flames.
    if (Math.random() < 0.08 * (0.5 + 2 * f)) {
      v.copy(fp.velocity).multiplyScalar(0.75).add(q.set((Math.random() - 0.5) * 5, 3 + Math.random() * 5, (Math.random() - 0.5) * 5));
      bursts.spark(flame.pos, v, 0.4 + Math.random() * 0.4, 0.025 + Math.random() * 0.02);
    }
  }

  /** Pod-space anchor of a part, in world space. */
  function worldAt(fp: FxPod, a: PartAnchor, out: THREE.Vector3): THREE.Vector3 {
    return out.set(a.pos[0], a.pos[1], a.pos[2]).applyMatrix4(fp.visual.object.matrixWorld);
  }

  /**
   * The ends of a binder or cable (world space, into segA/segB), from the anchors: a side binder's anchor is the
   * midpoint between the cockpit and its engine, the centre binder spans between the engines' inboard sides, and a
   * cable runs from the cockpit nose to the top of its engine.
   */
  function linkEnds(fp: FxPod, id: PartId, an: Readonly<Record<PartId, PartAnchor>>) {
    const m = an[id].pos;
    if (id === 'binderMid') {
      const hx = Math.max(0.5, an.nacelleR.pos[0] - an.nacelleR.r * 1.1);
      segA.set(m[0] - hx, m[1], m[2]);
      segB.set(m[0] + hx, m[1], m[2]);
    } else {
      const o = id.startsWith('binder') ? an.hull.pos : an.cockpitNose.pos;
      const k = id.startsWith('binder') ? 0.7 : 1;
      segA.set(m[0] - (m[0] - o[0]) * k, m[1] - (m[1] - o[1]) * k, m[2] - (m[2] - o[2]) * k);
      segB.set(m[0] + (m[0] - o[0]) * k, m[1] + (m[1] - o[1]) * k, m[2] + (m[2] - o[2]) * k);
    }
    const mw = fp.visual.object.matrixWorld;
    segA.applyMatrix4(mw);
    segB.applyMatrix4(mw);
  }

  /**
   * One discharge from a damaged or snapped link: a jagged bolt (a few strokes riding along with the pod) and a spit of
   * crackling sparks in the binder's colour. Damaged, the bolt jumps off the beam somewhere along it; snapped, it reaches
   * out of a stub end towards the far side it lost. Cables have no energy in them: they just spit hot sparks.
   */
  function arc(fp: FxPod, s: PodState, id: PartId, kind: number, broken: boolean, an: Readonly<Record<PartId, PartAnchor>>) {
    linkEnds(fp, id, an);
    if (kind === 2) {
      p.copy(segA).lerp(segB, Math.random());
      for (let j = 0; j < 3; j++) {
        v.copy(fp.velocity).multiplyScalar(0.85).add(q.set((Math.random() - 0.5) * 6, 1 + Math.random() * 4, (Math.random() - 0.5) * 6));
        bursts.spark(p, v, 0.2 + Math.random() * 0.25, 0.02);
      }
      return;
    }
    paintFor(fp, s);
    const end = Math.random() < 0.5;
    if (broken) {
      p.copy(end ? segA : segB);
      q.copy(end ? segB : segA).sub(p).multiplyScalar(0.2 + Math.random() * 0.35).add(p);
    } else {
      p.copy(segA).lerp(segB, 0.1 + Math.random() * 0.8);
      q.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(0.6 + Math.random() * 0.9).add(p);
    }
    const len = p.distanceTo(q);
    const n = 3 + Math.floor(Math.random() * 3);
    const life = 0.06 + Math.random() * 0.08;
    ap.copy(p);
    for (let j = 1; j <= n; j++) {
      v.copy(p).lerp(q, j / n);
      if (j < n) v.add(t1.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(len * 0.45));
      bursts.stroke(ap, v, fp.velocity, life, 0.045 + Math.random() * 0.03, s.arc);
      ap.copy(v);
    }
    for (let j = 0; j < 5; j++) {
      v.copy(fp.velocity).multiplyScalar(0.95).add(t1.set((Math.random() - 0.5) * 9, (Math.random() - 0.3) * 7, (Math.random() - 0.5) * 9));
      bursts.spark(Math.random() < 0.5 ? q : p, v, 0.15 + Math.random() * 0.25, 0.025, s.arc, 0.4);
    }
  }

  /**
   * Smoke, fire and arcs from each damaged part by its own health. Broken parts that came off make nothing here (their
   * debris smokes); the hull and the links stay on the pod when broken. A wreck pours smoke out of everything left.
   * Emission per pod is capped, so a pod with every part smoking costs no more than one with a smoking engine.
   */
  function partEffects(fp: FxPod, s: PodState, dist: number, h: Readonly<Record<PartId, number>>, an: Readonly<Record<PartId, PartAnchor>>, dt: number) {
    const wreck = fp.wrecked;
    const fast = 1 + 1.2 * Math.min(1.3, Math.max(0, fp.speed01));
    const qn = Math.max(0.4, qs);
    let total = 0;
    for (let i = 0; i < NP; i++) {
      const id = PART_IDS[i];
      const hv = h[id];
      const gone = hv <= 0 && PARTS[id].detaches;
      const d = wreck ? Math.max(0.9, 1 - hv) : 1 - hv;
      rates[i] = 0;
      if (SMOKE_W[i] === 0 || gone || d < 0.25) continue;
      const hv2 = smokeHeavy(d);
      rates[i] = (wreck ? 7 : fp.isPlayer ? 4 + 26 * hv2 : 2 + 11 * hv2) * SMOKE_W[i] * fast * qn;
      total += rates[i];
    }
    const cap = (wreck ? 28 : fp.isPlayer ? 36 : 18) * fast * qn;
    const k = total > cap ? cap / total : 1;
    for (let i = 0; i < NP; i++) {
      if (rates[i] === 0) {
        s.partSmoke[i] = 0;
        continue;
      }
      const id = PART_IDS[i];
      const a = an[id];
      const d = wreck ? Math.max(0.9, 1 - h[id]) : 1 - h[id];
      s.partSmoke[i] += rates[i] * k * dt;
      while (s.partSmoke[i] >= 1) {
        s.partSmoke[i] -= 1;
        emitSmokeAt(fp, worldAt(fp, a, ap), d, Math.min(1.3, 0.4 + a.r * 0.6));
      }
    }

    // Fire, nearer in only: engine parts (and a badly hurt hull) burn harder the more they are damaged, the whole pod
    // fiercer the more of it is hurt; a wreck burns from everything left of its engines and hull.
    if (dist < 450) {
      const far = dist > 220 ? 0.5 : 1;
      let burning = 0;
      const engineLeft = h.nacelleL > 0 || h.nacelleR > 0;
      // How far gone the pod is overall (its worst engine and the hull): more parts get a full share of flames.
      const worst = 1 - Math.min(h.nacelleL, h.nacelleR, h.hull);
      const shares = 2 + Math.round(3 * worst);
      for (let i = 0; i < NP; i++) {
        const id = PART_IDS[i];
        const hv = h[id];
        // A wreck burns as an engine on fire (its nacelles; the hull only once both engines are gone), not as a
        // cluster of every engine part at once.
        const burns = (wreck ? NACELLE[i] || (i === HULL && !engineLeft) : BURNS[i]) && !(hv <= 0 && PARTS[id].detaches);
        const f = wreck ? Math.max(0.7, burnOf(i, hv)) : burnOf(i, hv);
        if (!burns || f <= 0) {
          s.partFire[i] = 0;
          continue;
        }
        // At most a few burning parts per pod get full rate; the rest flicker along at a fraction.
        const share = burning++ < shares ? 1 : 0.3;
        s.partFire[i] += (fp.isPlayer ? 34 : 18) * (0.15 + 1.1 * f) * share * far * Math.max(0.5, qs) * dt;
        const a = an[id];
        while (s.partFire[i] >= 1) {
          s.partFire[i] -= 1;
          emitFire(fp, worldAt(fp, a, ap), Math.min(1, f), Math.min(1.2, a.r));
        }
      }
    }

    // Arcs, close enough to see them.
    if (dist < 350 && !wreck) {
      for (let i = 0; i < NP; i++) {
        const kind = ARCS[i];
        if (kind === 0) continue;
        const id = PART_IDS[i];
        const hv = h[id];
        // A snapped cable just hangs dead; a snapped binder keeps discharging out of its stubs.
        if (hv >= ARC_AT || (kind === 2 && hv <= 0)) {
          s.partArc[i] = 0;
          continue;
        }
        const rate = hv <= 0 ? 9 : 1.5 + 9 * (ARC_AT - hv) / ARC_AT;
        s.partArc[i] += rate * (kind === 2 ? 0.6 : 1) * dt;
        while (s.partArc[i] >= 1) {
          s.partArc[i] -= 1;
          arc(fp, s, id, kind, hv <= 0, an);
        }
      }
    }
  }

  /** Smoking debris: a rising column, black when it is thick, and flames licking up from burning pieces. */
  function debrisEffects(src: SmokeSource, dist: number, dt: number) {
    const amt = Math.min(1, Math.max(0, src.amount));
    const far = dist > 300 ? 0.5 : 1;
    const n = stochastic(amt * (5 + 9 * amt) * Math.max(0.4, qs) * far * dt);
    for (let j = 0; j < n && smokeLeft > 0; j++, smokeLeft--) {
      puff.pos.copy(src.pos);
      puff.pos.x += (Math.random() - 0.5) * 0.8;
      puff.pos.z += (Math.random() - 0.5) * 0.8;
      puff.normal.set(0, 1, 0);
      puff.vel.set((Math.random() - 0.5) * 1.6, 0, (Math.random() - 0.5) * 1.6);
      puff.size0 = 0.8 + Math.random() * 0.6;
      puff.size1 = (2.5 + Math.random() * 2) * (0.6 + 0.6 * amt);
      puff.life = 1.8 + Math.random() * 1.2;
      puff.opacity = 0.15 + 0.35 * amt;
      puff.rise = 2.5 + Math.random() * 2;
      puff.drag = 0.8;
      puff.shade = 1 - 0.85 * amt ** 0.8 * (src.burning ? 1 : 0.8);
      smoke.emit(puff);
    }
    if (!src.burning || dist > 450) return;
    const nf = stochastic((7 + 7 * amt) * Math.max(0.5, qs) * far * dt);
    for (let j = 0; j < nf && fireLeft > 0; j++, fireLeft--) {
      flame.pos.copy(src.pos);
      flame.pos.x += (Math.random() - 0.5) * 0.6;
      flame.pos.z += (Math.random() - 0.5) * 0.6;
      flame.vel.set((Math.random() - 0.5) * 0.8, 0.3, (Math.random() - 0.5) * 0.8);
      flame.size0 = 0.12 + Math.random() * 0.1;
      flame.size1 = (0.3 + Math.random() * 0.25) * (0.7 + 0.4 * amt);
      flame.life = 0.25 + Math.random() * 0.2;
      flame.rise = 4 + Math.random() * 3;
      flame.drag = 2;
      flame.heat = 0.7 + 0.3 * amt;
      fire.emit(flame);
    }
  }

  function padBurst(fp: FxPod) {
    p.copy(fp.ground).addScaledVector(fp.groundNormal, 0.2);
    bursts.ring(p, right, fwd, 10, 0.7, padColor);
    q.copy(fp.groundNormal);
    bursts.ring(p.addScaledVector(q, 1.2), right, q, 7, 0.45, padColor);
    for (let j = 0; j < 14 * Math.max(0.5, qs); j++) {
      p.copy(fp.ground).addScaledVector(right, (Math.random() - 0.5) * 8);
      v.copy(fp.velocity).multiplyScalar(0.7).addScaledVector(fp.groundNormal, 4 + Math.random() * 10).addScaledVector(right, (Math.random() - 0.5) * 14);
      bursts.spark(p, v, 0.4 + Math.random() * 0.4, 0.035);
    }
  }

  function boostKick(fp: FxPod, glow: THREE.Color) {
    const pos = fp.visual.object.position;
    p.copy(pos).addScaledVector(fwd, -7);
    ringColor.copy(glow).multiplyScalar(2.2);
    bursts.ring(p, right, up, 6.5, 0.45, ringColor);
    p.copy(pos).addScaledVector(fwd, -11);
    bursts.ring(p, right, up, 9, 0.6, ringColor);
  }

  return {
    object: group,
    update(view: FxView) {
      const { dt, time } = view;
      if (dt <= 0) return;
      const cam = view.camera.position;
      if (!camInit) {
        prevCam.copy(cam);
        camInit = true;
      }
      // Smoothed camera velocity: the streak direction of everything that rushes past.
      v.copy(cam).sub(prevCam).divideScalar(dt);
      if (v.lengthSq() > 400 * 400) v.set(0, 0, 0); // teleport (intro cut, reset)
      camVel.lerp(v, Math.min(1, dt * 20));
      prevCam.copy(cam);
      dust.setTime(time, camVel);
      smoke.setTime(time, camVel);
      fire.setTime(time, camVel);
      frameDt = dt;
      smokeLeft = Math.max(6, (smokeCount * dt) / 1.6);
      fireLeft = Math.max(4, (fireCount * dt) / 0.45);
      bursts.setTime(time, camVel);

      let nTrails = 0;
      const pods = view.pods;
      for (let k = 0; k < pods.length && k < MAX_PODS; k++) {
        const fp = pods[k];
        const s = stateFor(k);
        const obj = fp.visual.object;
        // Part anchors and contact points go through the pod's world matrix, which the renderer has not updated yet.
        if (fp.anchors) obj.updateWorldMatrix(true, false);
        right.set(1, 0, 0).applyQuaternion(obj.quaternion);
        fwd.set(0, 0, -1).applyQuaternion(obj.quaternion);
        up.set(0, 1, 0).applyQuaternion(obj.quaternion);
        const hex = fp.livery?.glow ?? DEFAULT_GLOW;
        if (hex !== s.glowHex) {
          s.glow.set(hex);
          s.glowHex = hex;
        }
        if (!s.init) {
          s.prevGround.copy(fp.ground);
          s.init = true;
        }
        const intensity = THREE.MathUtils.clamp(fp.speed01, 0, 1.4);
        const dist = obj.position.distanceTo(cam);
        const boost = fp.boosting ? 1 : fp.surge > 0 ? 0.7 : 0;

        // Dust: rate grows with speed; far pods emit fewer, bigger puffs; nothing beyond the haze.
        if (dist < 900) {
          const far = dist > 260;
          const rate = (fp.isPlayer ? 70 : 45) * (0.06 + intensity) * (1 + 0.35 * boost) * qs * (far ? 0.35 : 1);
          s.acc += rate * dt;
          while (s.acc >= 1) {
            s.acc -= 1;
            emitDust(fp, s, intensity, far);
          }
        }
        s.prevGround.copy(fp.ground);

        // Exhaust trails.
        for (const nz of fp.wrecked ? NONE : fp.visual.nozzles) {
          if (nTrails >= MAX_TRAILS) break;
          nz.getWorldPosition(p);
          trails.update(nTrails++, time, { nozzle: p, glow: s.glow, speed01: intensity, boost }, cam);
        }

        s.hitCool -= dt;
        const hit = fp.hit;
        if (hit && hit.energy > 0.03 && s.hitCool <= 0 && dist < 500) {
          hitBurst(fp, s, hit);
          s.hitCool = 0.07;
        } else if (!hit && fp.impact > 0.04 && s.hitCool <= 0 && dist < 500) {
          impactBurst(fp, Math.min(1, fp.impact));
          s.hitCool = 0.07;
        }
        if (fp.padHit && !s.wasPad && dist < 600) padBurst(fp);
        s.wasPad = fp.padHit;
        const boosting = boost > 0;
        if (boosting && !s.wasBoost && dist < 400) boostKick(fp, s.glow);
        s.wasBoost = boosting;

        // Smoke: from a part once it is a quarter gone, thicker the worse it is; a wreck pours it out of everything.
        if (dist < 700) {
          if (fp.wrecked && !s.wasWrecked) wreckBurst(fp);
          if (fp.health && fp.anchors) partEffects(fp, s, dist, fp.health, fp.anchors, dt);
          else for (let part = 0; part < 3; part++) {
            const d = fp.wrecked ? 1 : fp.damage[part] ?? 0;
            if (d < 0.25) continue;
            // More puffs at speed, so the streaks join up into a trail.
            const fast = 1 + 1.2 * Math.min(1.3, Math.max(0, fp.speed01));
            s.smoke[part] += (fp.wrecked ? 16 : fp.isPlayer ? 8 + 30 * (d - 0.25) : 3 + 13 * (d - 0.25)) * fast * Math.max(0.4, qs) * dt;
            while (s.smoke[part] >= 1) {
              s.smoke[part] -= 1;
              emitSmoke(fp, part, d);
            }
          }
        }
        s.wasWrecked = fp.wrecked;

        s.cone += (boost - s.cone) * Math.min(1, dt * (boost > s.cone ? 10 : 4));
        if (s.cone > 0.01 && intensity > 0.3) {
          const wob = 1 + Math.sin(time * 31 + k) * 0.04;
          m.compose(obj.position, obj.quaternion, q.copy(one).multiplyScalar(wob));
          bursts.cone(k, m, s.cone, s.glow);
        } else bursts.cone(k, null, 0, s.glow);
        if (fp.isPlayer) playerBoost = s.cone;
      }
      for (let k = Math.min(pods.length, MAX_PODS); k < MAX_PODS; k++) bursts.cone(k, null, 0, ringColor);
      for (const src of view.smokeSources ?? []) {
        const d = src.pos.distanceTo(cam);
        if (d < 700 && src.amount > 0) debrisEffects(src, d, dt);
      }
      trails.finish(nTrails);
      dust.flush();
      smoke.flush();
      fire.flush();
      bursts.flush();
      air.update(dt, time, camera, camVel, view.speed01, playerBoost);
    },
    dispose() {
      dust.dispose();
      smoke.dispose();
      fire.dispose();
      trails.dispose();
      air.dispose();
      bursts.dispose();
    },
  };
}
