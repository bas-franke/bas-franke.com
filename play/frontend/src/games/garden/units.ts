// Garden Sentinels units: tower and enemy views. Towers sit on their cell centre, pop in when built, bounce into the
// next level's model on upgrade, yaw their heads smoothly toward the aim point (slow scan when idle) and droop with a
// flickering glow while disabled. Enemies follow their interpolated EnemyFrame, walk with a clip whose speed follows
// their real ground speed (bobbing when the GLB has no clip), flash white on hits, wobble when stunned, tint blue
// when slowed and play their death before going back to a per-kind pool.
//
// Cheap by construction: every enemy health bar is one instanced, shader-billboarded draw; every blob shadow is one
// instanced draw; materials are cloned once per pooled view and only touched when their state changes; no per-frame
// allocations in update().

import * as THREE from 'three';
import { cellToWorld, type BoardOrigin } from '@shared/garden/board';
import { ENEMIES, type EnemyKind } from '@shared/garden/enemies';
import type { GMapDef } from '@shared/garden/maps';
import { EFlag, TFlag, type TowerInfo } from '@shared/garden/protocol';
import { TOWERS, type Level, type TowerKind } from '@shared/garden/towers';
import type { CreateUnits, EnemyFrame, EnemyModel, GardenModels, P3, TowerModel, Units } from './api';

/** Model heights (m) per enemy kind (api.ts GLB conventions). */
const ENEMY_H: Record<EnemyKind, number> = { runner: 0.8, skitter: 0.5, disruptor: 0.9, brute: 1.8, colossus: 3 };
const BAR_W: Record<EnemyKind, number> = { runner: 0.6, skitter: 0.45, disruptor: 0.65, brute: 1.0, colossus: 1.6 };
const TOWER_H: Record<TowerKind, number> = { laser: 1.35, shield: 1.25, slow: 1.4, missile: 1.3, beacon: 1.9 };

const TAU = Math.PI * 2;
/** Above this many enemies, small ones stop casting real shadows. */
const SHADOW_CROWD = 120;
/** Seconds a corpse takes to sink away after its die clip. */
const CORPSE_SINK = 0.7;
const wrapAngle = (a: number) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
const damp = (k: number, dt: number) => 1 - Math.exp(-k * dt);
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Elastic pop 0 -> 1 with overshoot. */
function popScale(t: number, from: number) {
  if (t >= 1) return 1;
  const e = 1 - Math.pow(2, -9 * t) * Math.cos(t * 11);
  return from + (1 - from) * e;
}

// ---- shared visuals ------------------------------------------------------------------------------------------------

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.5, 'rgba(0,0,0,0.32)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft translucent disc with a crisp edge line, drawn on the ground. Scale the mesh by the radius. */
function rangeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x8fe8ff) },
      uRadius: { value: 5 },
      uTime: { value: 0 },
      uAlpha: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uRadius; uniform float uTime; uniform float uAlpha;
      varying vec2 vUv;
      void main() {
        float d = length(vUv);
        if (d > 1.0) discard;
        float px = fwidth(d);
        float lineW = 0.07 / uRadius;
        float edge = smoothstep(1.0 - lineW - px, 1.0 - lineW, d) * (1.0 - smoothstep(1.0 - px, 1.0, d));
        float fill = 0.05 + 0.16 * smoothstep(0.35, 1.0, d);
        // Slow ripple travelling outwards.
        float rip = smoothstep(0.06, 0.0, abs(fract(d * 1.0 - uTime * 0.35) - 0.5) - 0.44) * 0.06 * d;
        float a = max(edge * 0.9, fill + rip);
        gl_FragColor = vec4(mix(uColor, vec3(1.0), edge * 0.35), a * uAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    extensions: { derivatives: true } as never,
  });
}

/** Rotating dashed ring for the selection. */
function ringMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xffffff) }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime;
      varying vec2 vUv;
      void main() {
        float d = length(vUv);
        float px = fwidth(d) * 1.5;
        float band = smoothstep(0.78 - px, 0.78, d) * (1.0 - smoothstep(0.96, 0.96 + px, d));
        float inner = smoothstep(0.62, 0.78, d) * (1.0 - smoothstep(0.78, 0.8, d)) * 0.35;
        float ang = atan(vUv.y, vUv.x);
        float dash = smoothstep(0.15, 0.3, abs(fract(ang / 6.2831853 * 12.0 + uTime * 0.4) - 0.5));
        float a = band * (0.55 + 0.45 * dash) + inner;
        if (a < 0.01) discard;
        gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.25 * dash * band), a * (0.85 + 0.15 * sin(uTime * 4.0)));
      }`,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
}

/** Instanced, shader-billboarded health bars: per instance a world centre, the fill (0..1) and a width. */
function makeBars(capacity: number) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geom = new THREE.InstancedBufferGeometry();
  geom.index = base.index;
  geom.setAttribute('position', base.getAttribute('position'));
  geom.setAttribute('uv', base.getAttribute('uv'));
  const offs = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  const data = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
  offs.setUsage(THREE.DynamicDrawUsage);
  data.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('aOffset', offs);
  geom.setAttribute('aData', data);
  geom.instanceCount = 0;
  const material = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec3 aOffset; attribute vec2 aData;
      varying vec2 vUv; varying float vHp; varying float vW;
      void main() {
        vUv = uv; vHp = aData.x; vW = aData.y;
        vec4 mv = viewMatrix * vec4(aOffset, 1.0);
        // Constant-ish pixel thickness: height grows a little with distance.
        float h = 0.09 + 0.004 * -mv.z;
        mv.xy += position.xy * vec2(aData.y, h);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; varying float vHp; varying float vW;
      void main() {
        vec2 p = vUv;
        float bx = 0.035 / vW; float by = 0.22;
        bool border = p.x < bx || p.x > 1.0 - bx || p.y < by || p.y > 1.0 - by;
        vec3 green = vec3(0.45, 0.92, 0.35), amber = vec3(1.0, 0.72, 0.18), red = vec3(1.0, 0.28, 0.2);
        vec3 c = vHp > 0.5 ? mix(amber, green, (vHp - 0.5) * 2.0) : mix(red, amber, vHp * 2.0);
        float fx = (p.x - bx) / (1.0 - 2.0 * bx);
        vec3 col = fx <= vHp ? c * (0.85 + 0.25 * p.y) : vec3(0.12, 0.1, 0.1);
        if (border) col = vec3(0.06, 0.05, 0.05);
        gl_FragColor = vec4(col, border ? 0.85 : 0.95);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const meshB = new THREE.Mesh(geom, material);
  meshB.frustumCulled = false;
  meshB.renderOrder = 10;
  return { mesh: meshB, offs, data, capacity, geom };
}

// ---- views ---------------------------------------------------------------------------------------------------------

interface TowerView {
  info: TowerInfo;
  color: number;
  model: TowerModel;
  /** Placed at the cell centre; holds tilt (droop). */
  group: THREE.Group;
  /** Holds pop scale. */
  pop: THREE.Group;
  x: number;
  z: number;
  lv: Level;
  aim: P3 | null;
  hasAim: boolean;
  ax: number;
  az: number;
  flags: number;
  headQ0: THREE.Quaternion;
  headYaw: number;
  scanPhase: number;
  popT: number;
  popFrom: number;
  droop: number;
  glowBase: number[];
  h: number;
}

interface Swap {
  mesh: THREE.Mesh;
  base: THREE.Material | THREE.Material[];
  own: THREE.Material | THREE.Material[];
}

interface MatState {
  mat: THREE.MeshStandardMaterial;
  color: THREE.Color;
  emissive: THREE.Color;
  ei: number;
}

interface EnemyView {
  id: number;
  kind: EnemyKind;
  model: EnemyModel;
  group: THREE.Group;
  mats: MatState[];
  meshes: THREE.Mesh[];
  swaps: Swap[];
  shadow: boolean;
  x: number;
  z: number;
  px: number;
  pz: number;
  yaw: number;
  tyaw: number;
  hp: number;
  f: number;
  speedMul: number;
  vel: number;
  flash: number;
  tint: number;
  /** 1 while slowed (target of `tint`). */
  dying: number;
  dieDur: number;
  castT: number;
  phase: number;
  stamp: number;
  fresh: boolean;
  painted: boolean;
}

const tmpV = new THREE.Vector3();
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const cullSphere = new THREE.Sphere();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);
const SLOW_TINT = new THREE.Color(0x5a9cff);
const SLOW_GLOW = new THREE.Color(0x0a1e3a);

export const createUnits: CreateUnits = (scene: THREE.Scene, def: GMapDef, origins: BoardOrigin[], models: GardenModels): Units => {
  const root = new THREE.Group();
  root.name = 'garden-units';
  scene.add(root);

  const towers = new Map<number, TowerView>();
  const enemies = new Map<number, EnemyView>();
  const dying: EnemyView[] = [];
  const kindH = new Map<EnemyKind, number>();
  const hOf = (k: EnemyKind) => kindH.get(k) ?? ENEMY_H[k];
  const pool = new Map<EnemyKind, EnemyView[]>();
  let stamp = 0;
  let time = 0;
  let frame = 0;

  // Blob shadows (towers + enemies) in one instanced draw.
  const blobTex = blobTexture();
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  let blobs = new THREE.InstancedMesh(blobGeo, blobMat, 1024);
  blobs.frustumCulled = false;
  blobs.count = 0;
  blobs.renderOrder = 1;
  blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(blobs);

  let bars = makeBars(1024);
  root.add(bars.mesh);

  // Selection ring + range circle; ghost model + its range circle.
  const discGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const selRing = new THREE.Mesh(discGeo, ringMaterial());
  selRing.visible = false;
  selRing.renderOrder = 3;
  root.add(selRing);
  const selRange = new THREE.Mesh(discGeo, rangeMaterial());
  selRange.visible = false;
  selRange.renderOrder = 2;
  root.add(selRange);
  const ghostRange = new THREE.Mesh(discGeo, rangeMaterial());
  ghostRange.visible = false;
  ghostRange.renderOrder = 2;
  root.add(ghostRange);
  let selId: number | null = null;
  let selT = 0;

  const ghostOk = new THREE.MeshStandardMaterial({ color: 0xbff7d0, emissive: 0x3fbf6a, emissiveIntensity: 0.6, transparent: true, opacity: 0.5, depthWrite: false, roughness: 0.5 });
  const ghostBad = new THREE.MeshStandardMaterial({ color: 0xff9a8a, emissive: 0xd0302a, emissiveIntensity: 0.7, transparent: true, opacity: 0.5, depthWrite: false, roughness: 0.5 });
  const ghosts = new Map<TowerKind, TowerModel>();
  const ghostGroup = new THREE.Group();
  ghostGroup.visible = false;
  root.add(ghostGroup);
  let ghostKind: TowerKind | null = null;
  let ghostIsOk = true;

  function ghostModel(kind: TowerKind) {
    let g = ghosts.get(kind);
    if (!g) {
      g = models.tower(kind, 1, 0xffffff);
      g.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = false;
        m.receiveShadow = false;
        m.renderOrder = 4;
      });
      ghosts.set(kind, g);
    }
    return g;
  }
  function paintGhost(g: TowerModel, ok: boolean) {
    const mt = ok ? ghostOk : ghostBad;
    g.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = mt;
    });
  }

  // ---- towers ------------------------------------------------------------------------------------------------------

  function towerPos(t: TowerInfo) {
    const o = origins[t.b] ?? origins[0] ?? { x: 0, z: 0 };
    return cellToWorld(def, o, t.x + 0.5, t.y + 0.5);
  }

  function attachModel(v: TowerView, model: TowerModel) {
    v.model = model;
    v.pop.add(model.root);
    v.headQ0 = model.head ? model.head.quaternion.clone() : new THREE.Quaternion();
    v.glowBase = model.glow.map((m) => m.emissiveIntensity);
    v.h = TOWER_H[v.info.k] * (1 + (v.lv - 1) * 0.08);
  }

  function makeTowerView(t: TowerInfo, color: number): TowerView {
    const p = towerPos(t);
    const group = new THREE.Group();
    group.position.set(p.x, 0, p.z);
    const pop = new THREE.Group();
    group.add(pop);
    root.add(group);
    const v: TowerView = {
      info: { ...t },
      color,
      model: null as unknown as TowerModel,
      group,
      pop,
      x: p.x,
      z: p.z,
      lv: t.lv,
      aim: null,
      hasAim: false,
      ax: 0,
      az: 0,
      flags: 0,
      headQ0: new THREE.Quaternion(),
      headYaw: 0,
      scanPhase: (t.id * 1.618) % TAU,
      popT: 0,
      popFrom: 0,
      droop: 0,
      glowBase: [],
      h: 1.4,
    };
    attachModel(v, models.tower(t.k, t.lv, color));
    // Start facing the board centre-ish so a row of new towers does not all point north.
    v.headYaw = v.scanPhase;
    return v;
  }

  function updateTower(v: TowerView, dt: number) {
    // Pop / bounce.
    if (v.popT < 1) {
      v.popT = Math.min(1, v.popT + dt / 0.55);
      const s = popScale(v.popT, v.popFrom);
      v.pop.scale.set(s, s * (1 + (1 - v.popT) * 0.0), s);
    }
    const disabled = (v.flags & TFlag.disabled) !== 0;
    // Droop while disabled.
    const td = disabled ? 1 : 0;
    v.droop += (td - v.droop) * damp(6, dt);
    v.group.rotation.set(v.droop * 0.1, 0, v.droop * 0.07);
    // Head yaw.
    const head = v.model.head;
    if (head) {
      let target: number;
      if (v.hasAim && !disabled) target = Math.atan2(-(v.ax - v.x), -(v.az - v.z));
      else {
        v.scanPhase += dt * (disabled ? 0 : 0.35);
        target = v.scanPhase + Math.sin(time * 0.7 + v.info.id) * 0.4;
      }
      const k = v.hasAim ? 12 : 2.5;
      v.headYaw += wrapAngle(target - v.headYaw) * damp(k, dt);
      v.headYaw = wrapAngle(v.headYaw);
      tmpQ.setFromAxisAngle(UP, v.headYaw);
      head.quaternion.copy(tmpQ).multiply(v.headQ0);
      if (disabled) {
        // Sagging head.
        tmpQ.setFromAxisAngle(tmpV.set(1, 0, 0), -0.25 * v.droop);
        head.quaternion.multiply(tmpQ);
      }
    }
    // Glow: gentle pulse, brighter when buffed, flicker when disabled.
    const buffed = (v.flags & TFlag.buffed) !== 0 ? 1.3 : 1;
    const pulse = 0.88 + 0.12 * Math.sin(time * 2.2 + v.info.id * 0.7);
    let k = pulse * buffed;
    if (disabled) {
      const n = Math.sin(time * 37 + v.info.id) * Math.sin(time * 13.3);
      k = n > 0.35 ? 0.6 : 0.04;
    }
    const g = v.model.glow;
    for (let i = 0; i < g.length; i++) g[i].emissiveIntensity = v.glowBase[i] * k;
  }

  // ---- enemies -----------------------------------------------------------------------------------------------------

  function acquire(kind: EnemyKind, id: number): EnemyView {
    const list = pool.get(kind);
    let v = list?.pop();
    if (!v) {
      const model = models.enemy(kind);
      if (!kindH.has(kind)) {
        // Real model height (bind pose) for the health bar and the beam / missile aim point.
        const box = new THREE.Box3().setFromObject(model.root);
        kindH.set(kind, isFinite(box.max.y) ? clamp(box.max.y, 0.3, 6) : ENEMY_H[kind]);
      }
      const group = new THREE.Group();
      group.add(model.root);
      // Per-instance material clones (glow ones already are) so flashes and tints are per enemy. Meshes draw with the
      // shared template materials while nothing is flashing or tinted (fewer material switches in big crowds) and
      // swap to the clones only while a hit flash or slow tint is showing.
      const own = new Set<THREE.Material>(model.glow);
      const swaps: Swap[] = [];
      const seen = new Map<THREE.Material, THREE.MeshStandardMaterial>();
      const mats: MatState[] = [];
      const meshes: THREE.Mesh[] = [];
      model.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        meshes.push(m);
        const swap = (src: THREE.Material) => {
          const s = src as THREE.MeshStandardMaterial;
          if (!s.isMeshStandardMaterial) return src;
          let c = seen.get(src);
          if (!c) {
            c = own.has(src) ? s : s.clone();
            if (c !== s) c.userData.src = src;
            seen.set(src, c);
            mats.push({ mat: c, color: c.color.clone(), emissive: c.emissive.clone(), ei: c.emissiveIntensity });
          }
          return c;
        };
        const mine = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
        const baseOf = (x: THREE.Material) => (x.userData.src as THREE.Material | undefined) ?? x;
        const base = Array.isArray(mine) ? mine.map(baseOf) : baseOf(mine);
        swaps.push({ mesh: m, base, own: mine });
        m.material = base;
      });
      v = {
        id,
        kind,
        model,
        group,
        mats,
        meshes,
        swaps,
        shadow: true,
        x: 0,
        z: 0,
        px: 0,
        pz: 0,
        yaw: 0,
        tyaw: 0,
        hp: 1,
        f: 0,
        speedMul: 1,
        vel: 0,
        flash: 0,
        tint: 0,
        dying: 0,
        dieDur: 0,
        castT: 0,
        phase: 0,
        stamp: 0,
        fresh: true,
        painted: false,
      };
    }
    v.id = id;
    v.fresh = true;
    v.dying = 0;
    v.flash = 0;
    v.tint = 0;
    v.castT = 0;
    v.vel = 0;
    v.hp = 1;
    v.phase = (id * 0.37) % 1;
    v.group.scale.setScalar(1);
    v.group.visible = true;
    v.group.rotation.set(0, 0, 0);
    v.model.root.position.set(0, 0, 0);
    v.model.root.rotation.set(0, 0, 0);
    v.model.root.scale.setScalar(1);
    const a = v.model.actions;
    v.model.mixer.stopAllAction();
    if (a.walk) {
      a.walk.reset().play();
      a.walk.time = v.phase * a.walk.getClip().duration;
    }
    if (a.idle) {
      a.idle.reset().play();
      a.idle.setEffectiveWeight(0);
    }
    paint(v, true);
    root.add(v.group);
    return v;
  }

  function release(v: EnemyView) {
    v.group.removeFromParent();
    v.model.mixer.stopAllAction();
    let list = pool.get(v.kind);
    if (!list) pool.set(v.kind, (list = []));
    list.push(v);
  }

  /** Applies hit flash and slow tint to the instance materials (only when they changed). */
  function paint(v: EnemyView, force = false) {
    const active = v.flash > 0.001 || v.tint > 0.001;
    if (!active && !v.painted && !force) return;
    if (active !== v.painted || force) for (const w of v.swaps) w.mesh.material = active ? w.own : w.base;
    if (!active) {
      v.painted = false;
      return;
    }
    for (const s of v.mats) {
      s.mat.color.copy(s.color).lerp(SLOW_TINT, v.tint * 0.4);
      if (v.flash > 0.001) {
        if (s.mat.emissiveMap) {
          // Palette-mapped crystals: the map colours the emissive, so the flash is a strong intensity boost.
          s.mat.emissive.copy(s.emissive);
          s.mat.emissiveIntensity = s.ei * (1 + 2.5 * v.flash);
        } else {
          // Plain bodies (vertex coloured, no emissive): glow white for the flash.
          s.mat.emissive.copy(s.emissive).lerp(SLOW_GLOW, v.tint).lerp(WHITE, v.flash * 0.65);
          s.mat.emissiveIntensity = Math.max(s.ei, v.tint) + (1.0 - Math.max(s.ei, v.tint)) * v.flash;
        }
      } else if (!s.mat.emissiveMap) {
        // Dark vertex-coloured bodies barely show a colour multiply, so slowed ones also get a faint icy glow.
        s.mat.emissive.copy(s.emissive).lerp(SLOW_GLOW, v.tint);
        s.mat.emissiveIntensity = Math.max(s.ei, v.tint);
      } else {
        s.mat.emissive.copy(s.emissive);
        s.mat.emissiveIntensity = s.ei;
      }
    }
    v.painted = active;
  }

  function updateEnemy(v: EnemyView, dt: number, mixDt: number) {
    const def = ENEMIES[v.kind];
    // Ground speed from the interpolated positions.
    if (v.fresh) {
      v.px = v.x;
      v.pz = v.z;
      v.yaw = v.tyaw;
      v.fresh = false;
    }
    const moved = Math.hypot(v.x - v.px, v.z - v.pz);
    const inst = dt > 0 ? Math.min(moved / dt, def.speed * 3) : 0;
    v.vel += (inst - v.vel) * damp(8, dt);
    v.px = v.x;
    v.pz = v.z;
    v.yaw += wrapAngle(v.tyaw - v.yaw) * damp(9, dt);
    v.group.position.set(v.x, 0, v.z);
    v.group.rotation.y = v.yaw;
    const rate = clamp(v.vel / def.speed, 0, 2.2);
    const moving = clamp(rate * 3, 0, 1);
    const a = v.model.actions;
    const stunned = (v.f & EFlag.stunned) !== 0;
    if (a.walk) {
      a.walk.timeScale = stunned ? 0 : Math.max(0.25, rate);
      a.walk.setEffectiveWeight(a.idle ? moving : 1);
      if (a.idle) a.idle.setEffectiveWeight(1 - moving);
    } else {
      // Bob fallback: hops scaled with speed.
      v.phase += dt * rate * (v.kind === 'skitter' ? 4 : v.kind === 'brute' || v.kind === 'colossus' ? 1.3 : 2.6);
      const h = ENEMY_H[v.kind];
      const s = Math.sin(v.phase * TAU);
      v.model.root.position.y = Math.abs(s) * h * 0.06 * moving;
      v.model.root.rotation.z = s * 0.06 * moving;
      v.model.root.rotation.x = -0.05 * moving;
    }
    // Stun wobble.
    if (stunned) {
      v.group.rotation.z = Math.sin(time * 18 + v.id) * 0.12;
      v.group.rotation.x = Math.cos(time * 14 + v.id) * 0.06;
    } else if (v.group.rotation.z !== 0 || v.group.rotation.x !== 0) {
      v.group.rotation.z *= 0.8;
      v.group.rotation.x *= 0.8;
    }
    // Cast fallback (no clip): hop + quick spin.
    if (v.castT > 0) {
      v.castT = Math.max(0, v.castT - dt);
      if (!a.cast) {
        const t = 1 - v.castT / 0.6;
        v.model.root.position.y += Math.sin(t * Math.PI) * 0.25;
        v.model.root.rotation.y = t * TAU;
      }
    }
    const slowed = (v.f & EFlag.slowed) !== 0 ? 1 : 0;
    v.tint += (slowed - v.tint) * damp(6, dt);
    if (v.flash > 0) v.flash = Math.max(0, v.flash - dt * 6);
    paint(v);
    if (mixDt > 0) v.model.mixer.update(mixDt);
  }

  function updateDying(v: EnemyView, dt: number) {
    v.dying += dt;
    const a = v.model.actions;
    const t = v.dying / v.dieDur;
    if (!a.die) {
      // Tip over and shrink.
      const k = Math.min(1, v.dying / 0.35);
      v.group.rotation.z = k * k * 1.4;
      const s = t > 0.5 ? Math.max(0.001, 1 - (t - 0.5) * 2) : 1;
      v.group.scale.setScalar(s);
    } else {
      // The clip ends with the body on its side: hold, then sink the corpse into the ground.
      const after = v.dying - (v.dieDur - CORPSE_SINK);
      if (after > 0) {
        const k = Math.min(1, after / CORPSE_SINK);
        v.group.position.y = -k * k * hOf(v.kind) * 0.6;
        v.group.scale.setScalar(Math.max(0.001, 1 - k * 0.5));
      }
    }
    if (v.flash > 0) {
      v.flash = Math.max(0, v.flash - dt * 4);
      paint(v);
    }
    v.model.mixer.update(dt);
    return v.dying >= v.dieDur;
  }

  // ---- picking -----------------------------------------------------------------------------------------------------

  const PICK_R = 0.85;
  function rayCylinder(ray: THREE.Ray, cx: number, cz: number, r: number, h: number): number {
    const ox = ray.origin.x - cx;
    const oz = ray.origin.z - cz;
    const dx = ray.direction.x;
    const dz = ray.direction.z;
    const A = dx * dx + dz * dz;
    let best = Infinity;
    if (A > 1e-8) {
      const B = 2 * (ox * dx + oz * dz);
      const C = ox * ox + oz * oz - r * r;
      const disc = B * B - 4 * A * C;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
          if (t < 0) continue;
          const y = ray.origin.y + ray.direction.y * t;
          if (y >= 0 && y <= h && t < best) best = t;
        }
      }
    }
    // Top cap.
    if (Math.abs(ray.direction.y) > 1e-6) {
      const t = (h - ray.origin.y) / ray.direction.y;
      if (t >= 0 && t < best) {
        const x = ox + dx * t;
        const z = oz + dz * t;
        if (x * x + z * z <= r * r) best = t;
      }
    }
    return best;
  }

  // ---- capacity growth ---------------------------------------------------------------------------------------------

  function ensureCapacity(n: number) {
    if (n > blobs.instanceMatrix.count) {
      const cap = Math.ceil(n * 1.5);
      root.remove(blobs);
      blobs.dispose();
      blobs = new THREE.InstancedMesh(blobGeo, blobMat, cap);
      blobs.frustumCulled = false;
      blobs.renderOrder = 1;
      blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      root.add(blobs);
    }
    if (n > bars.capacity) {
      root.remove(bars.mesh);
      bars.geom.dispose();
      (bars.mesh.material as THREE.Material).dispose();
      bars = makeBars(Math.ceil(n * 1.5));
      root.add(bars.mesh);
    }
  }

  function setBlob(i: number, x: number, z: number, r: number, alpha = 1) {
    tmpS.set(r * 2 * alpha, 1, r * 2 * alpha);
    tmpM.makeScale(tmpS.x, 1, tmpS.z);
    tmpM.setPosition(x, 0.02, z);
    blobs.setMatrixAt(i, tmpM);
  }

  // ---- api ---------------------------------------------------------------------------------------------------------

  const units: Units = {
    addTower(t, color) {
      const old = towers.get(t.id);
      if (old) units.removeTower(t.id);
      const v = makeTowerView(t, color);
      v.popT = 0;
      v.popFrom = 0.01;
      v.pop.scale.setScalar(0.01);
      towers.set(t.id, v);
    },
    upgradeTower(id, lv) {
      const v = towers.get(id);
      if (!v || v.lv === lv) return;
      const yaw = v.headYaw;
      v.model.dispose();
      v.lv = lv;
      v.info.lv = lv;
      attachModel(v, models.tower(v.info.k, lv, v.color));
      v.headYaw = yaw;
      v.popT = 0;
      v.popFrom = 0.72;
      v.pop.scale.setScalar(0.72);
    },
    removeTower(id) {
      const v = towers.get(id);
      if (!v) return;
      v.model.dispose();
      v.group.removeFromParent();
      towers.delete(id);
      if (selId === id) units.select(null);
    },
    setTowerState(id, aim, flags) {
      const v = towers.get(id);
      if (!v) return;
      v.flags = flags;
      if (aim) {
        v.hasAim = true;
        v.ax = aim.x;
        v.az = aim.z;
      } else if (v.hasAim) {
        v.hasAim = false;
        v.scanPhase = v.headYaw;
      }
    },
    muzzle(id, i) {
      const v = towers.get(id);
      if (!v || !v.model.muzzles.length) return null;
      const m = v.model.muzzles[((i % v.model.muzzles.length) + v.model.muzzles.length) % v.model.muzzles.length];
      m.updateWorldMatrix(true, false);
      tmpV.setFromMatrixPosition(m.matrixWorld);
      return { x: tmpV.x, y: tmpV.y, z: tmpV.z };
    },
    syncEnemies(list: EnemyFrame[]) {
      stamp++;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        let v = enemies.get(e.id);
        if (!v) {
          v = acquire(e.kind, e.id);
          enemies.set(e.id, v);
        }
        v.stamp = stamp;
        v.x = e.x;
        v.z = e.z;
        v.tyaw = e.yaw;
        v.hp = e.hp;
        v.f = e.f;
        v.speedMul = e.speed;
      }
      for (const [id, v] of enemies) {
        if (v.stamp !== stamp) {
          enemies.delete(id);
          release(v);
        }
      }
    },
    kill(id) {
      const v = enemies.get(id);
      if (!v) return;
      enemies.delete(id);
      v.flash = 1;
      paint(v);
      const a = v.model.actions;
      if (a.die) {
        a.walk?.fadeOut(0.12);
        a.idle?.fadeOut(0.12);
        a.cast?.stop();
        a.die.reset().setEffectiveWeight(1).fadeIn(0.08).play();
        v.dieDur = a.die.getClip().duration + 0.25 + CORPSE_SINK;
      } else {
        v.dieDur = 0.7;
      }
      v.dying = 0.0001;
      v.group.visible = true;
      dying.push(v);
    },
    hit(id) {
      const v = enemies.get(id);
      if (v) v.flash = 1;
    },
    enemyPos(id) {
      const v = enemies.get(id);
      if (!v) return null;
      return { x: v.x, y: hOf(v.kind) * 0.5, z: v.z };
    },
    cast(id) {
      const v = enemies.get(id);
      if (!v) return;
      v.castT = 0.6;
      const c = v.model.actions.cast;
      if (c) {
        c.reset().setEffectiveWeight(1).fadeIn(0.1).play();
        v.castT = c.getClip().duration;
      }
    },
    select(id) {
      selId = id != null && towers.has(id) ? id : null;
      selT = 0;
      const v = selId != null ? towers.get(selId)! : null;
      selRing.visible = selRange.visible = !!v;
      if (!v) return;
      const range = rangeOf(v.info.k, v.lv);
      (selRing.material as THREE.ShaderMaterial).uniforms.uColor.value.setHex(v.color);
      const rm = (selRange.material as THREE.ShaderMaterial).uniforms;
      rm.uColor.value.setHex(v.color).lerp(WHITE, 0.35);
      rm.uRadius.value = range;
      selRange.scale.setScalar(range);
      selRange.position.set(v.x, 0.04, v.z);
      selRing.position.set(v.x, 0.05, v.z);
      selRing.scale.setScalar(1.15);
    },
    ghost(g) {
      if (!g) {
        ghostGroup.visible = false;
        ghostRange.visible = false;
        return;
      }
      if (ghostKind !== g.kind) {
        ghostGroup.clear();
        const m = ghostModel(g.kind);
        ghostGroup.add(m.root);
        ghostKind = g.kind;
        paintGhost(m, g.ok);
        ghostIsOk = g.ok;
      } else if (ghostIsOk !== g.ok) {
        paintGhost(ghostModel(g.kind), g.ok);
        ghostIsOk = g.ok;
      }
      ghostGroup.visible = true;
      ghostGroup.position.set(g.x, 0, g.z);
      ghostRange.visible = true;
      ghostRange.position.set(g.x, 0.04, g.z);
      ghostRange.scale.setScalar(g.range);
      const u = (ghostRange.material as THREE.ShaderMaterial).uniforms;
      u.uRadius.value = g.range;
      u.uColor.value.setHex(g.ok ? 0x9ff0c0 : 0xff6a5a);
    },
    pickTower(ray) {
      let best = Infinity;
      let id: number | null = null;
      for (const v of towers.values()) {
        const t = rayCylinder(ray, v.x, v.z, PICK_R, v.h);
        if (t < best) {
          best = t;
          id = v.info.id;
        }
      }
      return id;
    },
    update(dt, camera) {
      // Cull enemies outside the view (skinned meshes have frustum culling off); the margin keeps shadows cast from
      // just off screen.
      camera.updateMatrixWorld();
      projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projView);
      dt = Math.min(dt, 0.1);
      time += dt;
      frame++;
      for (const v of towers.values()) updateTower(v, dt);
      // Many enemies: animate half of them each frame (with twice the step) to halve mixer cost.
      const half = enemies.size > 220;
      let i = 0;
      // Crowds: only big enemies cast real shadows (everyone keeps the blob), which halves the shadow pass cost.
      const crowd = enemies.size > SHADOW_CROWD;
      for (const v of enemies.values()) {
        const want = !crowd || v.kind === 'brute' || v.kind === 'colossus';
        if (want !== v.shadow) {
          v.shadow = want;
          for (const m of v.meshes) m.castShadow = want;
        }
        const mixDt = half ? ((i + frame) & 1 ? dt * 2 : 0) : dt;
        const h = hOf(v.kind);
        cullSphere.center.set(v.x, h * 0.5, v.z);
        cullSphere.radius = h + 3;
        const vis = frustum.intersectsSphere(cullSphere);
        v.group.visible = vis;
        updateEnemy(v, dt, vis ? mixDt : 0);
        i++;
      }
      for (let k = dying.length - 1; k >= 0; k--) {
        if (updateDying(dying[k], dt)) {
          release(dying[k]);
          dying[k] = dying[dying.length - 1];
          dying.pop();
        }
      }
      // Instanced blobs + bars.
      const n = towers.size + enemies.size + dying.length;
      ensureCapacity(n);
      let b = 0;
      for (const v of towers.values()) setBlob(b++, v.x, v.z, 0.95, v.pop.scale.x);
      let nb = 0;
      const offs = bars.offs.array as Float32Array;
      const data = bars.data.array as Float32Array;
      for (const v of enemies.values()) {
        const r = ENEMIES[v.kind].radius * 1.25;
        setBlob(b++, v.x, v.z, r);
        if (v.hp < 0.995) {
          offs[nb * 3] = v.x;
          offs[nb * 3 + 1] = hOf(v.kind) + 0.25;
          offs[nb * 3 + 2] = v.z;
          data[nb * 2] = clamp(v.hp, 0, 1);
          data[nb * 2 + 1] = BAR_W[v.kind];
          nb++;
        }
      }
      for (const v of dying) setBlob(b++, v.x, v.z, ENEMIES[v.kind].radius * 1.25, v.group.scale.x);
      blobs.count = b;
      blobs.instanceMatrix.needsUpdate = true;
      bars.geom.instanceCount = nb;
      if (nb) {
        bars.offs.addUpdateRange(0, nb * 3);
        bars.data.addUpdateRange(0, nb * 2);
        bars.offs.needsUpdate = true;
        bars.data.needsUpdate = true;
      }
      // Selection + ghost animation.
      if (selRing.visible) {
        selT += dt;
        const u = (selRing.material as THREE.ShaderMaterial).uniforms;
        u.uTime.value = time;
        const s = selT < 0.3 ? popScale(selT / 0.3, 0.6) : 1;
        selRing.scale.setScalar(1.15 * s);
        const ru = (selRange.material as THREE.ShaderMaterial).uniforms;
        ru.uTime.value = time;
        ru.uAlpha.value = Math.min(1, selT / 0.2);
      }
      if (ghostGroup.visible) {
        ghostGroup.position.y = 0.05 + Math.sin(time * 3) * 0.04;
        const mt = ghostIsOk ? ghostOk : ghostBad;
        mt.opacity = 0.42 + Math.sin(time * 4) * 0.08;
        (ghostRange.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
      }
    },
    dispose() {
      for (const v of towers.values()) v.model.dispose();
      towers.clear();
      const all = [...enemies.values(), ...dying, ...[...pool.values()].flat()];
      for (const v of all) {
        v.model.dispose();
        for (const s of v.mats) if (!v.model.glow.includes(s.mat)) s.mat.dispose();
      }
      enemies.clear();
      dying.length = 0;
      pool.clear();
      for (const g of ghosts.values()) g.dispose();
      ghosts.clear();
      blobs.dispose();
      blobTex.dispose();
      blobMat.dispose();
      blobGeo.dispose();
      bars.geom.dispose();
      (bars.mesh.material as THREE.Material).dispose();
      discGeo.dispose();
      for (const m of [selRing, selRange, ghostRange]) (m.material as THREE.Material).dispose();
      ghostOk.dispose();
      ghostBad.dispose();
      root.removeFromParent();
    },
  };
  return units;
};

function rangeOf(k: TowerKind, lv: Level) {
  return TOWERS[k].levels[lv - 1].range;
}
