// World-space speed effects for a race: billowing sand clouds under and behind every pod, exhaust heat trails, speed
// lines and sand grains rushing past the camera, sparks on wall hits, glow rings on boost pads and the shock cone of a
// boosting pod. Built from a handful of instanced systems (8 draw calls); per-frame work is emitting new particles
// into ring buffers and updating a few uniforms, with no allocation.

import * as THREE from 'three';
import type { FxPod, FxView, SpeedFx, WorldContext } from '../world/types';
import { qualityScale } from './particles';
import { AirSystem } from './speedAir';
import { BurstSystem } from './speedBursts';
import { DustSystem } from './speedDust';
import { TrailSystem } from './speedTrails';

const MAX_PODS = 16;
const MAX_TRAILS = 40;
const DEFAULT_GLOW = '#7f86ff';

interface PodState {
  init: boolean;
  prevGround: THREE.Vector3;
  acc: number;
  hitCool: number;
  wasPad: boolean;
  wasBoost: boolean;
  cone: number;
  glow: THREE.Color;
  glowHex: string;
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
  const bursts = new BurstSystem(Math.round(420 * Math.max(0.35, qs)), 24, MAX_PODS);
  dust.mesh.name = 'dust';
  trails.mesh.name = 'trails';
  air.motes.name = 'motes';
  air.lines.name = 'lines';
  bursts.sparks.name = 'sparks';
  bursts.rings.name = 'rings';
  bursts.cones.name = 'cones';
  group.add(dust.mesh, trails.mesh, air.motes, air.lines, bursts.sparks, bursts.rings, bursts.cones);

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
  const puff = { pos: new THREE.Vector3(), normal: new THREE.Vector3(), vel: new THREE.Vector3(), size0: 0, size1: 0, life: 0, opacity: 0, rise: 0, drag: 0 };

  const stateFor = (k: number): PodState => {
    let s = states[k];
    if (!s) {
      s = { init: false, prevGround: new THREE.Vector3(), acc: 0, hitCool: 0, wasPad: false, wasBoost: false, cone: 0, glow: new THREE.Color(DEFAULT_GLOW), glowHex: '' };
      states[k] = s;
    }
    return s;
  };

  /** Sand kicked up from the road under/behind a pod. `wide` puffs are the slow, broad wake that spreads sideways. */
  function emitDust(fp: FxPod, s: PodState, intensity: number, far: boolean) {
    const t = Math.random();
    const wide = Math.random() < 0.25;
    const pl = fp.isPlayer;
    // The player's own dust is pushed out to the sides so it frames the pod instead of hiding it from the camera.
    const sign = Math.random() < 0.5 ? -1 : 1;
    const lat = pl ? sign * (wide ? 4 + Math.random() * 6 : 1.8 + Math.random() * 4.5) : (Math.random() * 2 - 1) * 4.5 * (wide ? 1.3 : 1);
    const along = pl ? -(2 + Math.random() * 8) : -(1 + Math.random() * 6);
    puff.pos.copy(s.prevGround).lerp(fp.ground, t).addScaledVector(fwd, along).addScaledVector(right, lat);
    puff.normal.copy(fp.groundNormal);
    const out = Math.sign(lat) * (wide ? 6 + Math.random() * 10 : 2 + Math.random() * 7) * (pl ? 1.4 : 1) * Math.min(1.2, intensity + 0.2);
    // The player's dust is carried along almost at pod speed (a cheat: real dust would stop) so it stays on screen
    // around the pod for a moment instead of flashing past the camera.
    const carry = pl ? (wide ? 0.62 + Math.random() * 0.2 : 0.74 + Math.random() * 0.2) : wide ? 0.18 + Math.random() * 0.2 : 0.3 + Math.random() * 0.35;
    puff.vel.copy(fp.velocity).multiplyScalar(carry).addScaledVector(right, out);
    const big = far ? 1.4 : pl ? 1 : 1.15;
    const grow = 0.6 + 0.4 * Math.min(1.3, intensity);
    puff.size0 = (1.2 + Math.random() * 1.6) * big;
    puff.size1 = (wide ? 10 + Math.random() * 7 : 5 + Math.random() * 5) * grow * big * (pl && !wide ? 0.7 : 1);
    puff.life = (wide ? 2.2 + Math.random() * 1.3 : 1.1 + Math.random() * 1.1) * (pl ? 1 : 0.8);
    puff.opacity = (wide ? 0.24 : 0.32 + Math.random() * 0.22) * (pl ? 1.15 : 0.85) * (far ? 1.3 : 1);
    puff.rise = (wide ? 0.3 + Math.random() * 0.6 : 0.4 + Math.random() * 1.0) * (pl ? 0.6 : 1);
    puff.drag = 1.3 + Math.random() * 1.1;
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
      dust.emit(puff);
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
      bursts.setTime(time, camVel);

      let nTrails = 0;
      const pods = view.pods;
      for (let k = 0; k < pods.length && k < MAX_PODS; k++) {
        const fp = pods[k];
        const s = stateFor(k);
        const obj = fp.visual.object;
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
          const rate = (fp.isPlayer ? 120 : 60) * (0.06 + intensity) * (1 + 0.35 * boost) * qs * (far ? 0.35 : 1);
          s.acc += rate * dt;
          while (s.acc >= 1) {
            s.acc -= 1;
            emitDust(fp, s, intensity, far);
          }
        }
        s.prevGround.copy(fp.ground);

        // Exhaust trails.
        for (const nz of fp.visual.nozzles) {
          if (nTrails >= MAX_TRAILS) break;
          nz.getWorldPosition(p);
          trails.update(nTrails++, time, { nozzle: p, glow: s.glow, speed01: intensity, boost }, cam);
        }

        s.hitCool -= dt;
        if (fp.impact > 0.04 && s.hitCool <= 0 && dist < 500) {
          impactBurst(fp, Math.min(1, fp.impact));
          s.hitCool = 0.07;
        }
        if (fp.padHit && !s.wasPad && dist < 600) padBurst(fp);
        s.wasPad = fp.padHit;
        const boosting = boost > 0;
        if (boosting && !s.wasBoost && dist < 400) boostKick(fp, s.glow);
        s.wasBoost = boosting;

        s.cone += (boost - s.cone) * Math.min(1, dt * (boost > s.cone ? 10 : 4));
        if (s.cone > 0.01 && intensity > 0.3) {
          const wob = 1 + Math.sin(time * 31 + k) * 0.04;
          m.compose(obj.position, obj.quaternion, q.copy(one).multiplyScalar(wob));
          bursts.cone(k, m, s.cone, s.glow);
        } else bursts.cone(k, null, 0, s.glow);
        if (fp.isPlayer) playerBoost = s.cone;
      }
      for (let k = Math.min(pods.length, MAX_PODS); k < MAX_PODS; k++) bursts.cone(k, null, 0, ringColor);
      trails.finish(nTrails);
      dust.flush();
      bursts.flush();
      air.update(dt, time, camera, camVel, view.speed01, playerBoost);
    },
    dispose() {
      dust.dispose();
      trails.dispose();
      air.dispose();
      bursts.dispose();
    },
  };
}
