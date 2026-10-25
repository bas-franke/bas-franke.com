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
  /** Hip yaw (rad, + swings the muzzle left toward the screen centre and shows the gun's left flank) and cant (rad). */
  yaw: number;
  cant: number;
  /** Support hand: offset (m) from where show() puts it and roll (rad, about the palm; - turns the fingers over the top). */
  hand?: { x: number; y?: number; z: number; roll: number };
  /** Eye to rear sight when aimed. */
  eye: number;
  /** Recoil: kick back (m), muzzle climb (rad), random roll (rad); spring stiffness and damping. */
  back: number;
  climb: number;
  roll: number;
  k: number;
  c: number;
}

// Long guns sit low and to the right, the receiver near the camera's right edge and the barrel reaching in toward the
// centre at a slight angle.
const FEEL: Record<WeaponKind, ClassFeel> = {
  pistol: { hip: new THREE.Vector3(0.01, 0.075, -0.03), yaw: 0, cant: 0, eye: 0.3, back: 0.03, climb: 0.16, roll: 0.03, k: 520, c: 30 },
  smg: { hip: new THREE.Vector3(0.04, 0.03, 0.03), yaw: 0.1, cant: 0.04, eye: 0.22, back: 0.018, climb: 0.035, roll: 0.02, k: 700, c: 38 },
  rifle: { hip: new THREE.Vector3(0.04, 0.03, 0.04), yaw: 0.09, cant: 0.04, eye: 0.22, back: 0.026, climb: 0.05, roll: 0.025, k: 600, c: 34 },
  lmg: { hip: new THREE.Vector3(0.04, 0.02, 0.06), yaw: 0.07, cant: 0.04, eye: 0.27, back: 0.024, climb: 0.04, roll: 0.03, k: 560, c: 32 },
  shotgun: { hip: new THREE.Vector3(0.04, 0.025, 0.05), yaw: 0.07, cant: 0.04, eye: 0.24, back: 0.075, climb: 0.22, roll: 0.06, k: 300, c: 20 },
  sniper: { hip: new THREE.Vector3(0.04, 0.025, 0.06), yaw: 0.07, cant: 0.04, eye: 0.2, back: 0.085, climb: 0.26, roll: 0.05, k: 260, c: 18 },
};

/**
 * Per-gun overrides of the class feel. The MP5SD is fitted to the lobby reference shot (muzzle, red dot, rear drum and
 * grip each within ~1% of the frame): pointing nearly straight ahead, the muzzle at about 56% x, 58% y of the screen,
 * the red dot at 68% x, 57% y, the drum at 74% x, 69% y; the support hand cups the handguard from below just ahead of
 * the receiver, thumb along the near side.
 */
const GUN_FEEL: Partial<Record<WeaponId, Partial<ClassFeel>>> = {
  mp7: { hip: new THREE.Vector3(0.0074, 0.0333, -0.0173), yaw: 0.0084, cant: -0.0164, hand: { x: 0.01, y: 0.02, z: 0.02, roll: 0 } },
};
const feelCache = new Map<WeaponId, ClassFeel>();
const feelOf = (id: WeaponId): ClassFeel => {
  let f = feelCache.get(id);
  if (!f) feelCache.set(id, (f = { ...FEEL[WEAPONS[id].kind], ...GUN_FEEL[id] }));
  return f;
};

/** Guns whose `_sight` marker (weapons.glb) is the optic's axis rather than the top of an iron sight. */
const OPTIC_AXIS = new Set<WeaponId>(['mp7']);

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

/** Viewmodel key light: full strength, and how fast the probed world light reaches it; fill = FILL_MIN + key * share. */
const KEY_MAX = 16;
const KEY_GAIN = 1;
const FILL_MIN = 1.5;
const FILL_SHARE = 0.125;
/** World lights reaching this far (m) are huge distant shafts (facade, moon): they light the viewmodel only through the key. */
const FAR_LIGHT = 40;

export class Viewmodel {
  /** Camera-space holder for the viewmodel and its lights. */
  private readonly lens = new THREE.Group();
  readonly group = new THREE.Group();
  /** A key and a fill only the viewmodel sees, steered by probe(). */
  private readonly key = new THREE.DirectionalLight(0xffc48a, 0);
  private readonly hemi = new THREE.HemisphereLight(0xffcf9a, 0x1a1410, 0);
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
    this.lens.add(this.group);
    camera.add(this.lens);
    // post.ts puts every light on all layers except those flagged `worldOnly`; the flag keeps these on the viewmodel's.
    this.key.layers.set(VIEWMODEL_LAYER);
    this.key.userData.worldOnly = true;
    this.key.position.set(-1, 1.2, 0.4);
    this.key.target.position.set(0.1, -0.15, -0.5);
    this.lens.add(this.key, this.key.target);
    this.hemi.layers.set(VIEWMODEL_LAYER);
    this.hemi.userData.worldOnly = true;
    this.lens.add(this.hemi);
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
        // A little behind the middle and slightly under and left of the bore, so on the MP5SD it cradles the
        // suppressor's rear half from below with the back of the glove toward the camera.
        const support = new THREE.Vector3(-0.01, 0.023, Math.max(-0.4, Math.min(-0.12, this.gun.front * 0.47 + 0.08)));
        this.armL.position.add(support.sub(LEFT_PALM));
      }
      // Per-gun hand tweak (GUN_FEEL): shift, then roll about the left palm (the rig's origin is the camera, so the roll is
      // paired with the shift that keeps the palm in place).
      const hand = feelOf(id).hand;
      this.armLBase.copy(this.armLRot);
      if (hand && WEAPONS[id].kind !== 'pistol') {
        this.armL.position.x += hand.x;
        this.armL.position.y += hand.y ?? 0;
        this.armL.position.z += hand.z;
        this.armLBase.z += hand.roll;
        const palm = PALM.clone().add(LEFT_PALM);
        this.armL.position.add(palm.clone().applyEuler(this.armLRot).sub(palm.applyEuler(this.armLBase)));
      }
      this.armLRest2.copy(this.armL.position);
    }
  }
  private readonly armLRest2 = new THREE.Vector3();
  /** The support arm's rotation for the current gun (armLRot plus the class roll). */
  private readonly armLBase = new THREE.Euler();

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
    const f = feelOf(g.id);
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
    const feel = feelOf(g.id);

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
    // Iron sights: the sight's top edge just under the eye line, so the target stays visible above it. Optics whose
    // `_sight` marker is the optical axis itself (OPTIC_AXIS) sit exactly on the eye line so the dot is centred.
    const lift = OPTIC_AXIS.has(g.id) ? 0 : 0.006;
    const aim = new THREE.Vector3(-g.sight.x, -g.sight.y - lift, -feel.eye - g.sight.z);
    const pos = hip.lerp(aim, ease(a));
    const rot = new THREE.Euler(0, 0, 0, 'YXZ');
    // Hip yaw and cant, gone when aimed.
    rot.y += feel.yaw * (1 - a);
    rot.z += feel.cant * (1 - a);

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
    if (this.armL) this.armL.rotation.copy(this.armLBase);

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
      this.armL.rotation.x = this.armLBase.x + armLPitch;
    }
    this.group.position.copy(pos);
    this.group.rotation.copy(rot);
    this.probe(dt, a);
  }

  // ---- light probe ---------------------------------------------------------------------------------------------
  // The hands and gun are lit by the world's lights too, but at night those are a few far lamps and the gun reads as
  // a black cut-out. A key and a fill only the viewmodel sees follow the light around the player: every few frames
  // the world's lights are weighed at the camera (inverse square, range window, spot cone), and the key turns toward
  // the strongest, takes on their colour and scales with how bright the spot is; the fill is a share of it.
  private lights: THREE.Light[] = [];
  private lightsAge = Infinity;
  private probeAge = Infinity;
  private readonly keyDir = new THREE.Vector3(-0.5, 0.75, 0.4);
  private readonly keyCol = new THREE.Color(0xffc48a);
  private keyLevel = 0;
  /** Last probe reading, for tuning (dev). */
  probeLum = 0;

  private probe(dt: number, ads: number) {
    const cam = this.lens.parent;
    if (!cam) return;
    this.lightsAge += dt;
    this.probeAge += dt;
    if (this.lightsAge > 2) {
      this.lightsAge = 0;
      let root: THREE.Object3D = cam;
      while (root.parent) root = root.parent;
      this.lights.length = 0;
      root.traverse((o) => {
        const l = o as THREE.Light;
        if (!l.isLight || l === this.key || l === this.hemi || !((l as THREE.PointLight).isPointLight || (l as THREE.SpotLight).isSpotLight)) return;
        // A shaft meant to light the atrium from 30 m away floods the gun's top faces right next to the eye; keep it on
        // the world layer (post.ts honours worldOnly) and let the key stand in for it.
        if (!l.userData.worldOnly && (l as THREE.PointLight).distance >= FAR_LIGHT) {
          l.userData.worldOnly = true;
          l.userData.vmKey = true;
          l.layers.set(0);
        }
        if (!l.userData.worldOnly || l.userData.vmKey) this.lights.push(l);
      });
    }
    if (this.probeAge >= 0.1) {
      this.probeAge = 0;
      const eye = cam.getWorldPosition(_v);
      const dir = _d.set(0, 0, 0);
      const r = { r: 0, g: 0, b: 0 };
      let lum = 0;
      for (const l of this.lights) {
        if (!l.visible || l.intensity <= 0) continue;
        const p = l.getWorldPosition(_w).sub(eye);
        const d2 = Math.max(0.25, p.lengthSq());
        const d = Math.sqrt(d2);
        const range = (l as THREE.PointLight).distance;
        if (range > 0 && d > range) continue;
        let w = l.intensity / d2;
        if (range > 0) {
          const x = d / range;
          w *= (1 - x * x * x * x) ** 2;
        }
        const spot = l as THREE.SpotLight;
        if (spot.isSpotLight) {
          // Cosine between the spot's axis and the way to the eye; soft falloff outside the cone (bounce off the floor).
          const axis = spot.target.getWorldPosition(_a).sub(spot.getWorldPosition(_b)).normalize();
          const c = -axis.dot(p) / d;
          const cosOuter = Math.cos(spot.angle);
          w *= c >= cosOuter ? 1 : 0.12;
        }
        const y = w * (0.3 * l.color.r + 0.6 * l.color.g + 0.1 * l.color.b);
        if (y <= 0) continue;
        lum += y;
        dir.addScaledVector(p, y / d);
        r.r += l.color.r * y;
        r.g += l.color.g * y;
        r.b += l.color.b * y;
      }
      this.probeLum = lum;
      if (lum > 0) {
        // Into camera space; keep the key a little above, ahead or behind, and from the left, so it rakes the left
        // flank the camera sees and rims the top edges.
        cam.getWorldQuaternion(_q).invert();
        dir.normalize().applyQuaternion(_q);
        dir.x = Math.min(dir.x, -0.35);
        dir.y = Math.max(dir.y, 0.5);
        dir.z = Math.max(dir.z, -0.6);
        this.keyDir.lerp(dir.normalize(), 0.5);
        const m = Math.max(r.r, r.g, r.b);
        this.keyCol.lerp(_c.setRGB(r.r / m, r.g / m, r.b / m), 0.5);
      }
    }
    // Soft knee: dark corners keep a little, bright spots saturate.
    const want = KEY_MAX * (1 - Math.exp(-this.probeLum * KEY_GAIN));
    this.keyLevel += (want - this.keyLevel) * (1 - Math.exp(-dt * 4));
    this.key.position.copy(this.keyDir).multiplyScalar(2).add(this.key.target.position);
    this.key.color.copy(this.keyCol);
    // Aimed, the rear of the gun is right at the eye: half the key so it does not glare.
    this.key.intensity = this.keyLevel * (1 - 0.5 * ads);
    this.hemi.color.copy(this.keyCol);
    this.hemi.intensity = FILL_MIN + this.keyLevel * FILL_SHARE;
  }
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();

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
