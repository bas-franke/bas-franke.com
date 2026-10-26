// Chase camera, low and wide like the concept art: about 10.5 m behind and 3.7 m above the pod, pitched down only a
// few degrees so the pod sits in the bottom third and the horizon about 45% from the top, leaving room for the sky. It trails the pod's
// heading (so it swings out a little in turns and the pod slides across the frame), stretches back when the pod
// surges, widens the field of view with speed and boost, rolls with the road's banking and the turn, shakes on
// impacts and buzzes faintly at top speed. Also flies the intro over the grid, blends into the chase, looks back
// while C is held, and orbits the pod after the finish. Owned by the feel agent.

import * as THREE from 'three';
import { lookState } from './controls';

export interface CameraTarget {
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  speed01: number;
  boosting: boolean;
  surge: number;
  impact: number;
  /** Set once the player has crossed the finish line: the camera orbits the pod. */
  finished?: boolean;
}

/** Distance behind and height above the pod's centre at rest, and how far the view is pitched below the heading. */
const BACK = 10.5;
const HEIGHT = 3.7;
const PITCH = 0.03;
/** Vertical field of view at rest on a 16:9 screen, and the extra at full speed / on boost / on a pad surge. */
const FOV = 54;
const FOV_SPEED = 10;
const FOV_BOOST = 6;
const FOV_SURGE = 4;
/** Seconds the camera takes to blend from the intro into the chase. */
const BLEND = 0.9;

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

export class ChaseCamera {
  /** Camera position and look point relative to the pod. */
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** Smoothed heading the camera trails. */
  private readonly heading = new THREE.Vector3(0, 0, -1);
  private readonly prevForward = new THREE.Vector3(0, 0, -1);
  private fov = FOV;
  private shake = 0;
  private roll = 0;
  /** Smoothed extra distance behind the pod (grows on surges, the pod pulls away). */
  private lag = 0;
  private prevSpeed = 0;
  private first = true;
  private orbit = 0;
  /** Blend from the intro pose: remaining seconds, and the pose it started from. */
  private blend = 0;
  private readonly blendPos = new THREE.Vector3();
  private readonly blendLook = new THREE.Vector3();
  private blendFov = FOV;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /** Called as the intro ends (and after a teleport): ease from wherever the camera is into the chase. */
  reset() {
    if (this.first) return;
    this.blend = BLEND;
    this.blendPos.copy(this.camera.position);
    this.camera.getWorldDirection(tmpA);
    this.blendLook.copy(this.camera.position).addScaledVector(tmpA, 30);
    this.blendFov = this.camera.fov;
    this.first = true;
  }

  update(dt: number, t: CameraTarget, time: number) {
    const sp = Math.min(1.4, Math.max(0, t.speed01));
    const snap = this.first;

    // Turn rate from the change of the pod's heading, for roll and lag.
    let turn = 0;
    if (!snap && dt > 0) {
      tmpA.crossVectors(this.prevForward, t.forward);
      turn = THREE.MathUtils.clamp(tmpA.dot(t.up) / dt, -2, 2);
    }
    this.prevForward.copy(t.forward);

    // Trail the heading: a little swing out in turns, more at speed.
    if (snap) this.heading.copy(t.forward);
    else this.heading.lerp(t.forward, 1 - Math.exp(-dt * (7 - sp * 2))).normalize();

    // The pod pulling away on a boost or pad: stretch back, then settle.
    const accel = dt > 0 && !snap ? (t.speed01 - this.prevSpeed) / dt : 0;
    this.prevSpeed = t.speed01;
    this.lag += (THREE.MathUtils.clamp(accel * 3.5, -1, 3) - this.lag) * (1 - Math.exp(-dt * 3));

    const back = BACK + sp * 1.1 + this.lag;
    const height = HEIGHT + sp * 0.15;
    const want = tmpB.copy(t.pos).addScaledVector(this.heading, -back).addScaledVector(t.up, height);
    // Look ahead along the heading, pitched down so the horizon sits high and the pod low in the frame.
    const wantLook = tmpC.copy(want).addScaledVector(this.heading, 60).addScaledVector(t.up, -60 * Math.tan(PITCH));

    let fovBase = FOV;
    // Narrow (portrait) screens: keep the horizontal view wide instead of the vertical.
    const aspect = this.camera.aspect || 16 / 9;
    if (aspect < 1.5) {
      const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * 1.5);
      fovBase = Math.min(95, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect)));
    }
    const wantFov = fovBase + Math.min(1.2, sp) * FOV_SPEED + (t.boosting ? FOV_BOOST : 0) + (t.surge > 0 ? FOV_SURGE : 0);

    if (t.finished) this.finishOrbit(dt, t, want, wantLook);
    else this.orbit = 0;

    // Smooth the camera relative to the pod (not in the world), so speed never drags it further back.
    want.sub(t.pos);
    wantLook.sub(t.pos);
    if (snap) {
      this.pos.copy(want);
      this.look.copy(wantLook);
      this.up.copy(t.up);
      this.fov = wantFov;
    } else {
      const k = 1 - Math.exp(-dt * (t.finished ? 3 : 10));
      this.pos.lerp(want, k);
      this.look.lerp(wantLook, k);
      this.up.lerp(t.up, 1 - Math.exp(-dt * 5)).normalize();
      this.fov += (wantFov - this.fov) * (1 - Math.exp(-dt * 3.5));
    }
    this.first = false;

    // Look back (C held): over the engines at whoever is behind.
    const back2 = lookState.back && !t.finished;
    const camPos = tmpA.copy(this.pos).add(t.pos);
    const camLook = tmpB.copy(this.look).add(t.pos);
    if (back2) {
      camPos.copy(t.pos).addScaledVector(t.forward, 7).addScaledVector(t.up, 2.4);
      camLook.copy(t.pos).addScaledVector(t.forward, -60).addScaledVector(t.up, -3);
    }

    // Shake: impacts kick hard and decay; speed adds a fine buzz; boost a coarser rumble.
    this.shake = Math.max(this.shake * Math.exp(-dt * 5), t.impact);
    const buzz = 0.012 * sp * sp + (t.boosting ? 0.03 : 0) + (t.surge > 0 ? 0.015 : 0);
    const kick = this.shake * this.shake * 0.5;
    const n1 = Math.sin(time * 71.3) + Math.sin(time * 43.7 + 1.3) * 0.6;
    const n2 = Math.sin(time * 63.1 + 0.7) + Math.sin(time * 37.9 + 2.1) * 0.6;
    const n3 = Math.sin(time * 23.3 + 0.2) + Math.sin(time * 17.1 + 1.1) * 0.5;
    camPos.x += n1 * (buzz + kick);
    camPos.y += n2 * (buzz + kick);
    camPos.z += n3 * kick;

    // Roll: with the road's banking (via up) plus a touch into the turn and a jolt on hits.
    const wantRoll = THREE.MathUtils.clamp(turn * 0.05, -0.07, 0.07) + n3 * kick * 0.05;
    this.roll += (wantRoll - this.roll) * (1 - Math.exp(-dt * 4));

    if (this.blend > 0) {
      // Intro -> chase: ease from the intro's last pose.
      this.blend = Math.max(0, this.blend - dt);
      const k = 1 - this.blend / BLEND;
      const e = k * k * (3 - 2 * k);
      camPos.lerpVectors(this.blendPos, camPos, e);
      camLook.lerpVectors(this.blendLook, camLook, e);
      this.camera.fov = this.blendFov + (this.fov - this.blendFov) * e;
    } else this.camera.fov = this.fov;

    this.camera.position.copy(camPos);
    this.camera.up.copy(this.up);
    this.camera.lookAt(camLook);
    if (this.roll) this.camera.quaternion.multiply(tmpQ.setFromAxisAngle(tmpC.set(0, 0, 1), this.roll));
    this.camera.updateProjectionMatrix();
  }

  /** After the finish: swing round to the front of the pod and keep circling it slowly. */
  private finishOrbit(dt: number, t: CameraTarget, want: THREE.Vector3, wantLook: THREE.Vector3) {
    this.orbit += dt;
    const a = Math.min(Math.PI * 0.85, this.orbit * 0.9) + Math.max(0, this.orbit - 3.3) * 0.25;
    const r = 13 + Math.min(1, this.orbit / 3) * 3;
    const side = tmpA.crossVectors(t.forward, t.up).normalize();
    want.copy(t.pos).addScaledVector(t.forward, -Math.cos(a) * r).addScaledVector(side, Math.sin(a) * r).addScaledVector(t.up, 3 + Math.min(1, this.orbit / 3) * 1.5);
    wantLook.copy(t.pos).addScaledVector(t.up, 0.6);
  }

  /** Intro: a sweeping fly-over from high in front of the grid, down along its side to behind the back row. */
  intro(u: number, centre: THREE.Vector3, forward: THREE.Vector3) {
    const e = u * u * (3 - 2 * u);
    const fwd = tmpA.set(forward.x, 0, forward.z).normalize();
    const side = tmpB.set(-fwd.z, 0, fwd.x);
    // Bezier through four control points, relative to the grid centre.
    const p = (f: number, s: number, h: number, out: THREE.Vector3) => out.copy(centre).addScaledVector(fwd, f).addScaledVector(side, s).add(tmpC.set(0, h, 0));
    const b0 = p(150, -40, 55, new THREE.Vector3());
    const b1 = p(40, 70, 30, new THREE.Vector3());
    const b2 = p(-10, 35, 6, new THREE.Vector3());
    const b3 = p(-55, 0, 3.5, new THREE.Vector3());
    const v = 1 - e;
    this.camera.position
      .copy(b0)
      .multiplyScalar(v * v * v)
      .addScaledVector(b1, 3 * v * v * e)
      .addScaledVector(b2, 3 * v * e * e)
      .addScaledVector(b3, e * e * e);
    // Look at the grid, then further and further up the road towards the first corner.
    const look = new THREE.Vector3().copy(centre).addScaledVector(fwd, -10 + e * 80).add(tmpC.set(0, -1 + e * 2, 0));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(look);
    this.camera.fov = 50 + e * 10;
    this.camera.updateProjectionMatrix();
    this.first = false;
  }
}
