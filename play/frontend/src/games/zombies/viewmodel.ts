// First-person viewmodel: the arms and the gun in hand, rendered on VIEWMODEL_LAYER (post.ts draws it unfogged on top).
//
// The arms GLB is rigged around the camera with the right palm at PALM; the gun's origin is its grip, so the gun sits
// at the group origin and the arms hang at -PALM inside the group. Moving the group moves both, which keeps the hands
// on the gun through every pose. Animation is procedural:
//   - poses: hip (per weapon class), aimed (the gun's rear sight on the eye line), sprint, downed;
//   - springs: recoil (kick back, muzzle climb, roll), look sway, landing, all per weapon class;
//   - timelines: reload (tilt, mag out, mag in, charge), shell-by-shell loading, pump and bolt racks, switching
//     (lower, swap, raise), knife slash, grenade throw.
// Optional parts the guns may carry (from weapons.glb): `<id>_mag`, `<id>_sight`, `<id>_slide`, `<id>_bolt`,
// `<id>_pump`; anything missing is estimated or skipped.

import * as THREE from 'three';
import { WEAPONS, type WeaponId, type WeaponKind } from '@shared/zombies/weapons';
import { type Models, VIEWMODEL_LAYER } from './api';

/** Where the arms' right palm is, relative to the camera (from build_zombies.py). */
export const PALM = new THREE.Vector3(0.12, -0.21, -0.33);

interface ClassFeel {
  /** Hip offset from the palm. */
  hip: THREE.Vector3;
  /** Eye to rear sight when aimed. */
  eye: number;
  /** Recoil: kick back (m), muzzle climb (rad), random roll (rad); spring stiffness and damping. */
  back: number;
  climb: number;
  roll: number;
  k: number;
  c: number;
}

const FEEL: Record<WeaponKind, ClassFeel> = {
  pistol: { hip: new THREE.Vector3(0.01, 0.075, -0.03), eye: 0.3, back: 0.03, climb: 0.16, roll: 0.03, k: 520, c: 30 },
  smg: { hip: new THREE.Vector3(0.0, 0.06, 0.02), eye: 0.22, back: 0.018, climb: 0.035, roll: 0.02, k: 700, c: 38 },
  rifle: { hip: new THREE.Vector3(0.0, 0.06, 0.03), eye: 0.22, back: 0.026, climb: 0.05, roll: 0.025, k: 600, c: 34 },
  lmg: { hip: new THREE.Vector3(0.0, 0.05, 0.05), eye: 0.27, back: 0.024, climb: 0.04, roll: 0.03, k: 560, c: 32 },
  shotgun: { hip: new THREE.Vector3(0.0, 0.055, 0.04), eye: 0.24, back: 0.075, climb: 0.22, roll: 0.06, k: 300, c: 20 },
  sniper: { hip: new THREE.Vector3(0.0, 0.055, 0.05), eye: 0.2, back: 0.085, climb: 0.26, roll: 0.05, k: 260, c: 18 },
};

const ease = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
/** 0 → 1 → 0 over [a, b]. */
const bump = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin(((t - a) / (b - a)) * Math.PI));
/** 0 → 1 over [a, b], eased. */
const ramp = (t: number, a: number, b: number) => ease(clamp01((t - a) / (b - a)));

class Spring {
  x = 0;
  v = 0;
  step(dt: number, k: number, c: number) {
    // Semi-implicit Euler in small steps so stiff springs stay stable at low frame rates.
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-k * this.x - c * this.v) * h;
      this.x += this.v * h;
    }
  }
}

interface Gun {
  id: WeaponId;
  root: THREE.Object3D;
  muzzle: THREE.Object3D;
  mag: THREE.Object3D | null;
  magRest: THREE.Vector3 | null;
  slide: THREE.Object3D | null;
  slideRest: THREE.Vector3 | null;
  bolt: THREE.Object3D | null;
  boltRest: THREE.Vector3 | null;
  pump: THREE.Object3D | null;
  pumpRest: THREE.Vector3 | null;
  /** Rear sight in gun space. */
  sight: THREE.Vector3;
  /** Front end of the gun (most negative z) in gun space. */
  front: number;
}

/** The arms rig's left palm relative to its right palm (build_zombies.py). */
const LEFT_PALM = new THREE.Vector3(-0.1, 0.02, -0.2);

export interface VmFrame {
  dt: number;
  /** 0..1 aim blend (the client owns the timing so spread and FOV agree with it). */
  ads: number;
  sprint: boolean;
  /** 0..1 horizontal speed share of a walk. */
  move: number;
  /** Footstep phase (client's bob clock). */
  bob: number;
  onGround: boolean;
  /** Look change this frame, radians. */
  lookX: number;
  lookY: number;
  downed: boolean;
  visible: boolean;
}

export class Viewmodel {
  readonly group = new THREE.Group();
  private arms: THREE.Object3D | null = null;
  private armL: THREE.Object3D | null = null;
  private armLRest = new THREE.Vector3();
  private armLRot = new THREE.Euler();
  private gun: Gun | null = null;
  private readonly cache = new Map<WeaponId, Gun>();
  private ready = false;
  private knifeMesh: THREE.Object3D | null = null;
  private nadeMesh: THREE.Object3D | null = null;

  // Springs.
  private readonly kickZ = new Spring();
  private readonly kickX = new Spring();
  private readonly kickRoll = new Spring();
  private readonly swayX = new Spring();
  private readonly swayY = new Spring();
  private readonly land = new Spring();

  // Timelines (seconds elapsed, or -1 when idle).
  private reloadT = -1;
  private reloadDur = 1;
  private reloadShells = 0;
  private rackT = -1;
  private rackKind: 'pump' | 'bolt' | null = null;
  private switchT = -1;
  private pendingId: WeaponId | null = null;
  private knifeT = -1;
  private throwT = -1;
  private blowT = 1;
  private empty = false;
  private sprintK = 0;
  private downK = 0;

  constructor(
    private readonly models: Models,
    camera: THREE.Camera,
  ) {
    camera.add(this.group);
  }

  /** Call once the GLBs are loaded. */
  attach(id: WeaponId) {
    this.ready = true;
    this.arms = this.models.arms();
    this.arms.position.set(-PALM.x, -PALM.y, -PALM.z);
    this.armL = this.arms.getObjectByName('ArmL') ?? null;
    if (this.armL) {
      this.armLRest.copy(this.armL.position);
      this.armLRot.copy(this.armL.rotation);
    }
    this.group.add(this.arms);
    // A plain combat knife for melee, hidden until used.
    const knife = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.9, roughness: 0.32 });
    const grip = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.8 });
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.032, 0.19), steel);
    blade.position.set(0, 0.02, -0.12);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.03, 0.11), grip);
    handle.position.set(0, 0.0, 0.0);
    knife.add(blade, handle);
    knife.visible = false;
    this.knifeMesh = knife;
    this.group.add(knife);
    const nade = this.models.prop('nade');
    nade.visible = false;
    nade.scale.setScalar(1);
    this.nadeMesh = nade;
    (this.armL ?? this.group).add(nade);
    nade.position.set(0.02, -0.17, -0.5);
    this.show(id);
    setLayer(this.group, VIEWMODEL_LAYER);
  }

  get muzzle(): THREE.Object3D | null {
    return this.gun?.muzzle ?? null;
  }

  get id(): WeaponId | null {
    return this.gun?.id ?? null;
  }

  /** True while an animation should hold the trigger (switching, knifing, throwing, mid-reload). */
  get busy() {
    return this.switchT >= 0 || this.knifeT >= 0 || (this.throwT >= 0 && this.throwT < 0.45);
  }

  private build(id: WeaponId): Gun {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const g = this.models.weapon(id);
    g.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });
    const part = (n: string) => g.root.getObjectByName(`${id}_${n}`) ?? null;
    const slide = part('slide');
    const bolt = part('bolt');
    const pump = part('pump');
    const sightObj = part('sight');
    const est = estimateSight(g.root, g.mag);
    const sight = sightObj ? sightObj.getWorldPosition(new THREE.Vector3()).sub(g.root.getWorldPosition(new THREE.Vector3())) : est.sight;
    const gun: Gun = {
      id,
      root: g.root,
      muzzle: g.muzzle,
      mag: g.mag,
      magRest: g.mag ? g.mag.position.clone() : null,
      slide,
      slideRest: slide ? slide.position.clone() : null,
      bolt,
      boltRest: bolt ? bolt.position.clone() : null,
      pump,
      pumpRest: pump ? pump.position.clone() : null,
      sight,
      front: est.front,
    };
    setLayer(g.root, VIEWMODEL_LAYER);
    this.cache.set(id, gun);
    return gun;
  }

  private show(id: WeaponId) {
    if (this.gun) this.group.remove(this.gun.root);
    this.gun = this.build(id);
    this.group.add(this.gun.root);
    this.empty = false;
    this.reloadT = -1;
    this.rackT = -1;
    // The support hand: wrapped around the grip for pistols, under the handguard (about 45% of the way to the
    // muzzle) for everything else.
    if (this.armL) {
      this.armL.position.copy(this.armLRest);
      if (WEAPONS[id].kind === 'pistol') this.armL.position.add(new THREE.Vector3(0.1, -0.122, 0.22));
      else {
        const support = new THREE.Vector3(0, 0.043, Math.max(-0.46, Math.min(-0.14, this.gun.front * 0.47)));
        this.armL.position.add(support.sub(LEFT_PALM));
      }
      this.armLRest2.copy(this.armL.position);
    }
  }
  private readonly armLRest2 = new THREE.Vector3();

  /** Lower the current gun, swap, raise the new one. `instant` skips the animation (first equip, server resync). */
  equip(id: WeaponId, instant = false) {
    if (!this.ready) return;
    if (this.gun?.id === id && this.pendingId === null) return;
    if (instant || !this.gun) {
      this.show(id);
      this.switchT = -1;
      this.pendingId = null;
      return;
    }
    this.pendingId = id;
    this.switchT = 0;
  }

  fire() {
    const g = this.gun;
    if (!g) return;
    const w = WEAPONS[g.id];
    const f = FEEL[w.kind];
    const r = 0.8 + Math.random() * 0.4;
    this.kickZ.v += f.back * 60 * r;
    this.kickX.v += f.climb * 60 * r;
    this.kickRoll.v += (Math.random() - 0.5) * f.roll * 120;
    this.blowT = 0;
    if (g.id === 'trench') this.startRack('pump');
    else if (g.id === 'kar98k') this.startRack('bolt');
  }

  private startRack(kind: 'pump' | 'bolt') {
    this.rackKind = kind;
    this.rackT = -0.12;
  }

  setEmpty(empty: boolean) {
    this.empty = empty;
  }

  reload(duration: number, shells: number) {
    this.reloadT = 0;
    this.reloadDur = Math.max(0.3, duration);
    this.reloadShells = shells;
    this.rackT = -1;
  }

  cancelReload() {
    this.reloadT = -1;
  }

  knife() {
    this.knifeT = 0;
  }

  throwNade() {
    this.throwT = 0;
  }

  landed(fallSpeed: number) {
    this.land.v -= Math.min(1.6, 0.25 + fallSpeed * 0.08);
  }

  update(f: VmFrame) {
    const g = this.gun;
    this.group.visible = f.visible && this.ready;
    if (!g) return;
    const dt = f.dt;
    const w = WEAPONS[g.id];
    const feel = FEEL[w.kind];

    // Springs.
    this.kickZ.step(dt, feel.k, feel.c);
    this.kickX.step(dt, feel.k * 0.8, feel.c * 0.9);
    this.kickRoll.step(dt, 260, 22);
    // Sway lags the look: the gun is dragged against the turn, then springs back.
    this.swayX.v += -f.lookX * 9 * (1 - f.ads * 0.75);
    this.swayY.v += f.lookY * 9 * (1 - f.ads * 0.75);
    this.swayX.step(dt, 120, 14);
    this.swayY.step(dt, 120, 14);
    this.land.step(dt, 140, 13);
    this.sprintK += ((f.sprint && this.reloadT < 0 ? 1 : 0) - this.sprintK) * (1 - Math.exp(-dt * 10));
    this.downK += ((f.downed ? 1 : 0) - this.downK) * (1 - Math.exp(-dt * 6));

    // Base pose: hip or aimed.
    const a = f.ads * (1 - this.sprintK);
    const hip = PALM.clone().add(feel.hip);
    // The sight's top edge just under the eye line, so the target stays visible above it.
    const aim = new THREE.Vector3(-g.sight.x, -g.sight.y - 0.006, -feel.eye - g.sight.z);
    const pos = hip.lerp(aim, ease(a));
    const rot = new THREE.Euler(0, 0, 0, 'YXZ');

    // Bob (much less when aimed) and idle breathing.
    const bobAmt = f.onGround ? f.move * (1 - a * 0.85) : 0;
    const ph = f.bob * Math.PI;
    pos.x += Math.sin(ph) * 0.011 * bobAmt;
    pos.y += -Math.abs(Math.cos(ph)) * 0.012 * bobAmt + Math.sin(performance.now() / 900) * 0.0018 * (1 - a);
    rot.z += Math.sin(ph) * 0.02 * bobAmt;

    // Sway.
    pos.x += this.swayX.x * 0.02;
    pos.y += this.swayY.x * 0.02;
    rot.y += this.swayX.x * 0.12;
    rot.x += this.swayY.x * 0.12;
    rot.z += this.swayX.x * 0.08;

    // Landing.
    pos.y += this.land.x * 0.04;
    rot.x += this.land.x * 0.08;

    // Recoil.
    pos.z += this.kickZ.x * (1 - a * 0.4);
    rot.x += this.kickX.x * (1 - a * 0.5);
    rot.z += this.kickRoll.x;

    // Sprint: gun canted across the chest.
    pos.x += -0.03 * this.sprintK;
    pos.y += -0.04 * this.sprintK;
    rot.x += -0.32 * this.sprintK;
    rot.y += 0.55 * this.sprintK;
    rot.z += 0.25 * this.sprintK;

    // Downed: the pistol held low and wobbling.
    pos.y -= 0.05 * this.downK;
    rot.z += 0.15 * this.downK * Math.sin(performance.now() / 700);

    // ---- timelines ----
    let armLOff = new THREE.Vector3();
    let armLPitch = 0;
    if (this.armL) this.armL.rotation.copy(this.armLRot);

    // Reload.
    if (this.reloadT >= 0) {
      this.reloadT += dt;
      const t = clamp01(this.reloadT / this.reloadDur);
      if (w.perShell) {
        // Rolled over to show the loading port; the left hand pushes a shell in, again and again; pump at the end.
        const tilt = ramp(t, 0, 0.12) * (1 - ramp(t, 0.86, 1));
        rot.z += 0.55 * tilt;
        rot.x += 0.12 * tilt;
        pos.y -= 0.03 * tilt;
        const shells = Math.max(1, this.reloadShells);
        const loadEnd = 0.84;
        if (t > 0.1 && t < loadEnd) {
          const k = ((t - 0.1) / (loadEnd - 0.1)) * shells;
          const s = k - Math.floor(k);
          armLOff.set(0.02 * Math.sin(s * Math.PI), -0.07 * Math.sin(s * Math.PI), 0.05 * (1 - s));
        }
        if (t >= loadEnd) armLOff.z += 0.09 * bump(t, loadEnd, 1);
        if (g.pump && g.pumpRest) g.pump.position.z = g.pumpRest.z + 0.08 * bump(t, loadEnd, 1);
      } else {
        // Tilt, drop the mag, fetch a new one, seat it, charge.
        const tilt = ramp(t, 0, 0.14) * (1 - ramp(t, 0.82, 1));
        rot.z += 0.42 * tilt;
        rot.x += 0.16 * tilt;
        pos.y -= 0.035 * tilt;
        pos.x -= 0.02 * tilt;
        if (g.mag && g.magRest) {
          const out = ramp(t, 0.12, 0.34);
          const back = ramp(t, 0.48, 0.7);
          const drop = out * (1 - back);
          g.mag.position.set(g.magRest.x, g.magRest.y - 0.3 * drop, g.magRest.z + 0.04 * drop);
          g.mag.visible = !(t > 0.34 && t < 0.48);
        }
        // The left hand goes down for the fresh mag and comes back.
        const reach = bump(t, 0.1, 0.76);
        armLOff.set(0.03 * reach, -0.16 * reach, 0.16 * reach);
        armLPitch = -0.25 * reach;
        // Charge: a sharp pull back.
        const charge = bump(t, 0.78, 0.92);
        pos.z += 0.028 * charge;
        rot.x -= 0.06 * charge;
        if (g.slide && g.slideRest) g.slide.position.z = g.slideRest.z + 0.03 * charge;
        if (g.bolt && g.boltRest) g.bolt.position.z = g.boltRest.z + 0.06 * charge;
      }
      if (this.reloadT >= this.reloadDur) {
        this.reloadT = -1;
        this.empty = false;
        if (g.mag && g.magRest) {
          g.mag.position.copy(g.magRest);
          g.mag.visible = true;
        }
      }
    }

    // Pump / bolt after a shot.
    if (this.rackT > -1 && this.reloadT < 0) {
      this.rackT += dt;
      if (this.rackT >= 0) {
        if (this.rackKind === 'pump') {
          const t = clamp01(this.rackT / 0.42);
          const s = Math.sin(t * Math.PI);
          armLOff.z += 0.1 * s;
          pos.z += 0.01 * s;
          rot.x += 0.03 * s;
          if (g.pump && g.pumpRest) g.pump.position.z = g.pumpRest.z + 0.09 * s;
          if (t >= 1) this.rackT = -1;
        } else {
          // Bolt: rolled over, hand up and back, forward, down.
          const t = clamp01(this.rackT / 0.8);
          const s = bump(t, 0, 1);
          rot.z += -0.35 * s;
          rot.x += 0.05 * s;
          pos.x -= 0.015 * s;
          pos.y -= 0.02 * s;
          if (g.bolt && g.boltRest) g.bolt.position.z = g.boltRest.z + 0.09 * bump(t, 0.2, 0.8);
          if (t >= 1) this.rackT = -1;
        }
      }
    }

    // Pistol slide: blowback on every shot, locked back on an empty mag.
    this.blowT += dt;
    if (g.slide && g.slideRest) {
      const blow = this.blowT < 0.07 ? Math.sin((this.blowT / 0.07) * Math.PI) : 0;
      g.slide.position.z = g.slideRest.z + 0.028 * Math.max(blow, this.empty && this.reloadT < 0 ? 1 : 0);
    }

    // Switching: lower, swap at the bottom, raise.
    if (this.switchT >= 0) {
      this.switchT += dt;
      const down = 0.2;
      const up = 0.26;
      let k: number;
      if (this.switchT < down) k = ease(this.switchT / down);
      else {
        if (this.pendingId && this.gun?.id !== this.pendingId) this.show(this.pendingId);
        this.pendingId = null;
        k = 1 - ease(clamp01((this.switchT - down) / up));
      }
      pos.y -= 0.22 * k;
      rot.x -= 0.7 * k;
      rot.z += 0.2 * k;
      if (this.switchT >= down + up) this.switchT = -1;
    }

    // Knife: the gun drops away, the knife hand slashes right to left.
    if (this.knifeMesh) this.knifeMesh.visible = false;
    if (this.knifeT >= 0) {
      this.knifeT += dt;
      const t = clamp01(this.knifeT / 0.45);
      const out = bump(t, 0, 1);
      const sw = ease(clamp01((t - 0.15) / 0.5));
      g.root.visible = t > 0.92;
      if (this.knifeMesh) {
        this.knifeMesh.visible = t < 0.92;
        this.knifeMesh.rotation.set(-0.3 + 0.4 * sw, 0.9 - 1.9 * sw, 0.6 - 1.2 * sw);
      }
      pos.x += 0.08 - 0.26 * sw;
      pos.y += 0.04 * out - 0.06 * sw * out;
      pos.z -= 0.16 * out;
      rot.y += (0.6 - 1.5 * sw) * out;
      rot.z += -0.5 * out;
      if (t >= 1) {
        this.knifeT = -1;
        g.root.visible = true;
      }
    } else g.root.visible = true;

    // Grenade: gun dips, left arm winds up and throws.
    if (this.nadeMesh) this.nadeMesh.visible = false;
    if (this.throwT >= 0) {
      this.throwT += dt;
      const t = clamp01(this.throwT / 0.65);
      const dip = bump(t, 0, 1);
      pos.y -= 0.12 * dip;
      rot.x -= 0.4 * dip;
      const wind = ramp(t, 0, 0.35) * (1 - ramp(t, 0.35, 0.55));
      const fling = bump(t, 0.35, 0.8);
      armLPitch += 1.1 * wind - 0.5 * fling;
      armLOff.add(new THREE.Vector3(-0.05 * wind, 0.05 * wind, 0.18 * wind - 0.12 * fling));
      if (this.nadeMesh) this.nadeMesh.visible = t < 0.5;
      if (t >= 1) this.throwT = -1;
    }

    if (this.armL) {
      this.armL.position.copy(this.armLRest2).add(armLOff);
      this.armL.rotation.x = this.armLRot.x + armLPitch;
    }
    this.group.position.copy(pos);
    this.group.rotation.copy(rot);
  }
}

function setLayer(o: THREE.Object3D, layer: number) {
  o.traverse((c) => c.layers.set(layer));
}

/**
 * Rear sight of a gun with no `_sight` marker: the highest point of the receiver just above and in front of the grip
 * (the mag excluded), in gun space.
 */
function estimateSight(root: THREE.Object3D, mag: THREE.Object3D | null): { sight: THREE.Vector3; front: number } {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const v = new THREE.Vector3();
  let best = -Infinity;
  let minZ = 0;
  let maxY = -Infinity;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || o === mag || (mag && isAncestor(mag, o))) return;
    const pos = m.geometry.getAttribute('position');
    const mat = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mat);
      if (v.z < minZ) minZ = v.z;
      if (v.y > maxY) maxY = v.y;
      if (v.z > -0.14 && v.z < 0.06 && v.y > best) best = v.y;
    }
  });
  if (!Number.isFinite(best)) best = Number.isFinite(maxY) ? maxY : 0.06;
  return { sight: new THREE.Vector3(0, best + 0.004, -0.04), front: minZ };
}

function isAncestor(a: THREE.Object3D, o: THREE.Object3D) {
  for (let p = o.parent; p; p = p.parent) if (p === a) return true;
  return false;
}
