// Garden Sentinels models: the Blender-built GLBs in public/models/garden ({towers,enemies,kit}.glb), loaded once and
// cloned per use. Every getter works before (and without) the GLBs: hand-built primitive stand-ins use the same node
// and material naming as the GLBs (`Tower_<kind>_<lv>`, `_head`, `_muzzle<N>`, `Team`, `Glow*`, `Crystal*`, `Eyes`),
// so one instancing path serves both. A missing node or clip never throws; it is logged once and a primitive (or the
// bobbing fallback) takes over.
//
// Sharing: templates are cached per kind/level/piece; clones share geometry and every material except the ones an
// instance tints or pulses (Team, Glow* on towers; Crystal*, Eyes on enemies), which are cloned per instance.

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { EnemyKind } from '@shared/garden/enemies';
import type { Level, TowerKind } from '@shared/garden/towers';
import type { CreateModels, EnemyModel, GardenModels, KitName, TowerModel } from './api';

const BASE = '/models/garden/';
const loader = new GLTFLoader();

/** Diagnostics for the lab: which GLB nodes / clips resolved and which fell back to primitives. */
export interface ModelsReport {
  loaded: Record<'towers' | 'enemies' | 'kit', boolean>;
  found: string[];
  missing: string[];
}

function load(name: string): Promise<GLTF | null> {
  return loader.loadAsync(`${BASE}${name}.glb`).catch((err) => {
    console.warn(`Garden Sentinels: ${name}.glb not available; using primitives`, err?.message ?? err);
    return null;
  });
}

// ---- shared primitive materials -------------------------------------------------------------------------------------

type Std = THREE.MeshStandardMaterial;
const matCache = new Map<string, Std>();
function mat(name: string, color: number, o: Partial<THREE.MeshStandardMaterialParameters> = {}): Std {
  let m = matCache.get(name);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, flatShading: true, ...o });
    m.name = name;
    matCache.set(name, m);
  }
  return m;
}
const glowMat = (name: string, color: number, emissive: number, intensity: number, o: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  mat(name, color, { emissive, emissiveIntensity: intensity, roughness: 0.4, flatShading: false, ...o });

const M = {
  stone: () => mat('p_stone', 0xd9c9aa, { roughness: 0.9 }),
  stoneDark: () => mat('p_stoneDark', 0xa8967a, { roughness: 0.95 }),
  shell: () => mat('p_shell', 0xe8e0d0, { roughness: 0.45, metalness: 0.15, flatShading: false }),
  metal: () => mat('p_metal', 0xaeb3ba, { roughness: 0.4, metalness: 0.35, flatShading: false }),
  copper: () => mat('p_copper', 0xd08440, { roughness: 0.4, metalness: 0.45, flatShading: false }),
  gold: () => mat('p_gold', 0xf0c050, { roughness: 0.3, metalness: 0.55, flatShading: false }),
  leaf: () => mat('p_leaf', 0x5e9c3a, { roughness: 0.85 }),
  leafDark: () => mat('p_leafDark', 0x3d7a2c, { roughness: 0.9 }),
  stem: () => mat('p_stem', 0x6aa848, { roughness: 0.7, flatShading: false }),
  team: () => mat('Team', 0xffffff, { roughness: 0.5, metalness: 0.2, flatShading: false }),
  dark: () => mat('p_dark', 0x2b2a30, { roughness: 0.6 }),
  wood: () => mat('p_wood', 0x9a6e44, { roughness: 0.85 }),
  bark: () => mat('p_bark', 0x7a5638, { roughness: 0.95 }),
  glass: () => mat('p_glass', 0xcfeee8, { roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.35, flatShading: false, depthWrite: false }),
  water: () => mat('p_lily', 0x4f9a4a, { roughness: 0.6 }),
};

// ---- primitive geometry cache --------------------------------------------------------------------------------------

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g as T;
}
const G_ = {
  cyl: (rt: number, rb: number, h: number, s = 16) => geo(`cyl${rt},${rb},${h},${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s)),
  sphere: (r: number, w = 16, h = 12) => geo(`sph${r},${w},${h}`, () => new THREE.SphereGeometry(r, w, h)),
  dome: (r: number) => geo(`dome${r}`, () => new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)),
  box: (x: number, y: number, z: number) => geo(`box${x},${y},${z}`, () => new THREE.BoxGeometry(x, y, z)),
  torus: (r: number, t: number, s = 32) => geo(`tor${r},${t},${s}`, () => new THREE.TorusGeometry(r, t, 8, s)),
  cone: (r: number, h: number, s = 6) => geo(`cone${r},${h},${s}`, () => new THREE.ConeGeometry(r, h, s)),
  ico: (r: number, d = 0) => geo(`ico${r},${d}`, () => new THREE.IcosahedronGeometry(r, d)),
  dodeca: (r: number) => geo(`dod${r}`, () => new THREE.DodecahedronGeometry(r, 0)),
  octa: (r: number) => geo(`oct${r}`, () => new THREE.OctahedronGeometry(r, 0)),
};

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, parent?: THREE.Object3D, name = '') {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  if (name) o.name = name;
  parent?.add(o);
  return o;
}

function prepareShadows(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mm = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
    m.castShadow = !mm.transparent;
    m.receiveShadow = true;
  });
}

/**
 * Merges a primitive's meshes per material under each pivot (the root and any `_head`), so a stand-in costs a handful
 * of draw calls instead of dozens. Empties (muzzles) and groups stay where they are.
 */
function bake(root: THREE.Object3D, collapse = false): THREE.Object3D {
  root.updateMatrixWorld(true);
  const isPivot = (o: THREE.Object3D) => o === root || /_(head|wing[LR])$/.test(o.name);
  const buckets = new Map<THREE.Object3D, Map<THREE.Material, THREE.BufferGeometry[]>>();
  const meshes: THREE.Mesh[] = [];
  const inv = new THREE.Matrix4();
  const rel = new THREE.Matrix4();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    let p: THREE.Object3D = m.parent!;
    while (!isPivot(p)) p = p.parent!;
    inv.copy(p.matrixWorld).invert();
    rel.multiplyMatrices(inv, m.matrixWorld);
    const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(rel);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    let byMat = buckets.get(p);
    if (!byMat) buckets.set(p, (byMat = new Map()));
    let mat = m.material as THREE.Material;
    if (collapse && !mat.transparent && !/^(Glow|Team|Crystal|Eyes)/.test(mat.name)) {
      // Plain opaque parts share one vertex-coloured material.
      const c = (mat as Std).color;
      const n = g.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      mat = vcMat();
    }
    let list = byMat.get(mat);
    if (!list) byMat.set(mat, (list = []));
    list.push(g);
    meshes.push(m);
  });
  for (const m of meshes) m.removeFromParent();
  for (const [p, byMat] of buckets)
    for (const [mat, list] of byMat) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      p.add(new THREE.Mesh(merged, mat));
    }
  return root;
}

const vcMat = () => mat('p_vc', 0xffffff, { vertexColors: true, roughness: 0.65 });

// ---- primitive towers ----------------------------------------------------------------------------------------------

function towerBase(root: THREE.Object3D, lv: Level) {
  // Stone plinth with a team-coloured band, a moss rim and little bushes; Masterwork adds gold trim.
  mesh(G_.cyl(0.82, 0.88, 0.32, 14), M.stone(), 0, 0.16, 0, root);
  mesh(G_.cyl(0.7, 0.74, 0.08, 14), M.stoneDark(), 0, 0.36, 0, root);
  mesh(G_.cyl(0.885, 0.885, 0.06, 28), M.team(), 0, 0.24, 0, root);
  const bushes = 5 + lv;
  for (let i = 0; i < bushes; i++) {
    const a = (i / bushes) * Math.PI * 2 + 0.4;
    const b = mesh(G_.ico(0.16 + (i % 3) * 0.03, 0), i % 2 ? M.leaf() : M.leafDark(), Math.cos(a) * 0.84, 0.12, Math.sin(a) * 0.84, root);
    b.scale.set(1.2, 0.8, 1.2);
  }
  if (lv === 3) {
    const t = mesh(G_.torus(0.76, 0.035), M.gold(), 0, 0.4, 0, root);
    t.rotation.x = Math.PI / 2;
  }
  if (lv >= 2) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      mesh(G_.box(0.12, 0.2, 0.12), lv === 3 ? M.gold() : M.copper(), Math.cos(a) * 0.62, 0.46, Math.sin(a) * 0.62, root);
    }
  }
}

function buildTower(kind: TowerKind, lv: Level): THREE.Object3D {
  const name = `Tower_${kind}_${lv}`;
  const root = new THREE.Group();
  root.name = name;
  towerBase(root, lv);
  const s = 1 + (lv - 1) * 0.1;
  const trim = lv === 3 ? M.gold() : M.copper();
  const top = new THREE.Group();
  top.scale.setScalar(s);
  top.position.y = 0.4;
  root.add(top);
  const muzzle = (parent: THREE.Object3D, n: number, x: number, y: number, z: number) => {
    const o = new THREE.Object3D();
    o.name = n === 0 ? `${name}_muzzle` : `${name}_muzzle${n + 1}`;
    o.position.set(x, y, z);
    parent.add(o);
  };
  switch (kind) {
    case 'laser': {
      mesh(G_.cyl(0.26, 0.34, 0.36, 12), M.metal(), 0, 0.18, 0, top);
      const head = new THREE.Group();
      head.name = `${name}_head`;
      head.position.y = 0.62;
      top.add(head);
      const body = mesh(G_.sphere(0.3), M.shell(), 0, 0, 0, head);
      body.scale.set(0.95, 0.85, 1.1);
      const len = 0.5 + lv * 0.08;
      const barrel = mesh(G_.cyl(0.085, 0.11, len, 12), M.metal(), 0, 0.02, -0.25 - len / 2, head);
      barrel.rotation.x = Math.PI / 2;
      const ring = mesh(G_.torus(0.1, 0.035, 16), trim, 0, 0.02, -0.28, head);
      void ring;
      const tip = mesh(G_.torus(0.085, 0.04, 16), glowMat('Glow_laser', 0xffc070, 0xff8a20, 2.6), 0, 0.02, -0.25 - len, head);
      void tip;
      for (const sx of [-1, 1]) {
        const ear = mesh(G_.cyl(0.16, 0.16, 0.08, 16), trim, sx * 0.3, 0, 0, head);
        ear.rotation.z = Math.PI / 2;
        const core = mesh(G_.cyl(0.09, 0.09, 0.09, 12), glowMat('Glow_laser', 0, 0, 0), sx * 0.31, 0, 0, head);
        core.rotation.z = Math.PI / 2;
      }
      if (lv === 3) {
        const fin = mesh(G_.box(0.05, 0.22, 0.34), M.gold(), 0, 0.28, 0.02, head);
        void fin;
      }
      muzzle(head, 0, 0, 0.02, -0.3 - len);
      break;
    }
    case 'shield': {
      mesh(G_.cyl(0.3, 0.38, 0.2, 12), M.metal(), 0, 0.1, 0, top);
      mesh(G_.torus(0.55, 0.05, 32), trim, 0, 0.22, 0, top).rotation.x = Math.PI / 2;
      const dome = mesh(G_.dome(0.55), glowMat('Glow_shield', 0xffd070, 0xffa030, 1.5, { transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide }), 0, 0.2, 0, top);
      void dome;
      // Ribs over the dome.
      for (let i = 0; i < 3; i++) {
        const r = mesh(G_.torus(0.555, 0.018, 24), trim, 0, 0.2, 0, top);
        r.rotation.y = (i / 3) * Math.PI;
        r.scale.set(1, 1, 1);
      }
      mesh(G_.sphere(0.13), glowMat('Glow_core', 0x9dff9d, 0x40ff60, 2.2), 0, 0.42, 0, top);
      mesh(G_.cyl(0.04, 0.06, 0.2, 8), M.metal(), 0, 0.3, 0, top);
      if (lv >= 2) mesh(G_.torus(0.45, 0.03, 32), trim, 0, 0.5, 0, top).rotation.x = Math.PI / 2;
      muzzle(top, 0, 0, 0.42, 0);
      break;
    }
    case 'slow': {
      mesh(G_.cyl(0.32, 0.36, 0.14, 12), M.stoneDark(), 0, 0.07, 0, top);
      mesh(G_.cyl(0.04, 0.06, 0.6, 8), M.stem(), 0, 0.42, 0, top);
      for (const sx of [-1, 1]) {
        const lf = mesh(G_.sphere(0.12, 10, 6), M.leaf(), sx * 0.13, 0.3, 0, top);
        lf.scale.set(1.4, 0.25, 0.6);
        lf.rotation.z = sx * 0.5;
      }
      const flower = new THREE.Group();
      flower.position.y = 0.74;
      flower.rotation.x = -0.12;
      top.add(flower);
      const petals = 6 + (lv - 1) * 2;
      const petalMat = glowMat('Glow_petal', 0xa8f4ee, 0x40d8d0, 0.7);
      for (let i = 0; i < petals; i++) {
        const a = (i / petals) * Math.PI * 2;
        const p = new THREE.Group();
        p.rotation.y = a;
        flower.add(p);
        const pm = mesh(G_.sphere(0.2, 12, 8), petalMat, 0.24, 0.06, 0, p);
        pm.scale.set(1.25, 0.22, 0.6);
        pm.rotation.z = 0.35;
      }
      if (lv === 3) {
        for (let i = 0; i < petals; i++) {
          const a = ((i + 0.5) / petals) * Math.PI * 2;
          const p = new THREE.Group();
          p.rotation.y = a;
          flower.add(p);
          const pm = mesh(G_.sphere(0.13, 10, 6), petalMat, 0.15, 0.12, 0, p);
          pm.scale.set(1.2, 0.25, 0.6);
          pm.rotation.z = 0.6;
        }
      }
      mesh(G_.sphere(0.1), glowMat('Glow_pollen', 0xfff07a, 0xffd040, 1.8), 0, 0.1, 0, flower);
      muzzle(flower, 0, 0, 0.12, 0);
      break;
    }
    case 'missile': {
      mesh(G_.cyl(0.24, 0.34, 0.3, 12), M.metal(), 0, 0.15, 0, top);
      const head = new THREE.Group();
      head.name = `${name}_head`;
      head.position.y = 0.58;
      top.add(head);
      mesh(G_.box(0.5, 0.34, 0.46), M.shell(), 0, 0, 0, head);
      mesh(G_.box(0.52, 0.06, 0.48), trim, 0, 0.12, 0, head);
      const tubes = new THREE.Group();
      tubes.rotation.x = 0.3;
      head.add(tubes);
      const n = lv + 1;
      const cols = n <= 2 ? n : 2;
      for (let i = 0; i < n; i++) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const x = (c - (cols - 1) / 2) * 0.42;
        const y = 0.02 + r * 0.24 - (n > 2 ? 0.1 : 0);
        const t = mesh(G_.cyl(0.12, 0.12, 0.5, 12), M.copper(), x, y, -0.12, tubes);
        t.rotation.x = Math.PI / 2;
        const cap = mesh(G_.cyl(0.08, 0.08, 0.02, 12), glowMat('Glow_missile', 0xffb060, 0xff7020, 2.2), x, y, -0.38, tubes);
        cap.rotation.x = Math.PI / 2;
        muzzle(tubes, i, x, y, -0.42);
      }
      break;
    }
    case 'beacon': {
      mesh(G_.cyl(0.24, 0.34, 0.24, 12), M.metal(), 0, 0.12, 0, top);
      mesh(G_.cyl(0.08, 0.12, 0.3, 8), trim, 0, 0.36, 0, top);
      const egg = mesh(G_.sphere(0.28, 16, 12), glowMat('Glow_beacon', 0x5fe0a8, 0x20c070, 1.1, { roughness: 0.15, metalness: 0.1 }), 0, 0.8, 0, top);
      egg.scale.set(1, 1.5, 1);
      const r1 = mesh(G_.torus(0.46, 0.025, 40), M.gold(), 0, 0.8, 0, top);
      r1.rotation.set(Math.PI / 2 + 0.35, 0, 0.2);
      if (lv >= 2) {
        const r2 = mesh(G_.torus(0.4, 0.022, 40), M.gold(), 0, 0.8, 0, top);
        r2.rotation.set(Math.PI / 2 - 0.4, 0, -0.5);
      }
      mesh(G_.cone(0.06, 0.2, 6), M.gold(), 0, 1.32, 0, top);
      if (lv === 3) mesh(G_.sphere(0.06), glowMat('Glow_beacon_tip', 0xc8ffd8, 0x60ff90, 2.5), 0, 1.46, 0, top);
      muzzle(top, 0, 0, 0.8, 0);
      break;
    }
    case 'sprinkler': {
      // Brass standpipe with a water tank head and a stubby mortar barrel tilted up (twin barrels at Masterwork).
      mesh(G_.cyl(0.26, 0.34, 0.26, 12), M.metal(), 0, 0.13, 0, top);
      mesh(G_.cyl(0.07, 0.07, 0.3, 8), trim, 0, 0.38, 0, top);
      const head = new THREE.Group();
      head.name = `${name}_head`;
      head.position.y = 0.66;
      top.add(head);
      const tank = mesh(G_.sphere(0.3, 16, 12), glowMat('Glow_water', 0x7fd0ff, 0x2a90e0, 0.9, { roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.8 }), 0, 0.02, 0.12, head);
      tank.scale.set(1, 0.85, 1);
      mesh(G_.torus(0.3, 0.035, 24), trim, 0, 0.02, 0.12, head).rotation.x = Math.PI / 2;
      mesh(G_.cyl(0.1, 0.12, 0.08, 10), M.shell(), 0, 0.27, 0.12, head);
      const barrels = new THREE.Group();
      barrels.rotation.x = 0.55; // aims up and forward (-Z)
      barrels.position.set(0, 0.06, -0.08);
      head.add(barrels);
      const n = lv === 3 ? 2 : 1;
      const len = 0.42 + lv * 0.05;
      for (let i = 0; i < n; i++) {
        const x = n === 1 ? 0 : (i - 0.5) * 0.26;
        const b = mesh(G_.cyl(0.11, 0.14, len, 12), M.copper(), x, 0, -len / 2, barrels);
        b.rotation.x = Math.PI / 2;
        mesh(G_.torus(0.11, 0.03, 16), lv === 3 ? M.gold() : M.shell(), x, 0, -len, barrels);
        const cap = mesh(G_.cyl(0.085, 0.085, 0.02, 12), glowMat('Glow_water', 0, 0, 0), x, 0, -len + 0.02, barrels);
        cap.rotation.x = Math.PI / 2;
        muzzle(barrels, i, x, 0, -len - 0.04);
      }
      if (lv >= 2) {
        // Spray nozzles around the plinth.
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + 0.5;
          mesh(G_.cyl(0.03, 0.05, 0.16, 6), trim, Math.cos(a) * 0.3, 0.32, Math.sin(a) * 0.3, top);
        }
      }
      break;
    }
  }
  return root;
}

// ---- primitive enemies ---------------------------------------------------------------------------------------------

interface EnemyLook {
  h: number;
  body: number;
  belly: number;
  crystal: number;
  glow: number;
  spikes: number;
  long: number;
}
const LOOKS: Record<EnemyKind, EnemyLook> = {
  runner: { h: 0.8, body: 0xe8782a, belly: 0xf6d0a0, crystal: 0xffb030, glow: 0xff8a10, spikes: 5, long: 1.15 },
  skitter: { h: 0.5, body: 0x2a9a90, belly: 0xbfe8d8, crystal: 0x70f0e0, glow: 0x30d8d0, spikes: 4, long: 1.1 },
  disruptor: { h: 0.9, body: 0x6a3ab0, belly: 0xd0b8f0, crystal: 0xb070ff, glow: 0x9a40ff, spikes: 6, long: 1 },
  brute: { h: 1.8, body: 0x1f5f66, belly: 0x5a8a88, crystal: 0x7ff4ee, glow: 0x30d8e0, spikes: 7, long: 1.05 },
  colossus: { h: 3, body: 0x2a3a6a, belly: 0x6a7ab0, crystal: 0xd8a8ff, glow: 0x8a70ff, spikes: 9, long: 1 },
  // Stand-ins with their own builders below (buildMoth / buildBloomkin); colours only.
  moth: { h: 0.7, body: 0x6a5a8a, belly: 0xe8dcc0, crystal: 0xfff0a0, glow: 0xffd860, spikes: 0, long: 1 },
  bloomkin: { h: 1.1, body: 0x4f8a3a, belly: 0xc8e8a0, crystal: 0xff9ad0, glow: 0xff70b8, spikes: 0, long: 1 },
};

/** Glow Moth stand-in: origin at the body centre (it flies), wings on `_wingL` / `_wingR` pivots for the flap. */
function buildMoth(): THREE.Object3D {
  const L = LOOKS.moth;
  const root = new THREE.Group();
  root.name = 'Enemy_moth';
  const body = mat('p_e_moth', L.body, { roughness: 0.8 });
  const fuzz = mat('p_eb_moth', L.belly, { roughness: 0.95 });
  const glow = glowMat('Crystal_moth', L.crystal, L.glow, 1.4, { roughness: 0.3 });
  const wingMat = glowMat('Crystal_mothwing', 0xfff4d8, 0xffc860, 0.55, { roughness: 0.5, side: THREE.DoubleSide });
  const eyes = glowMat('Eyes', 0xffffff, 0xfff4d0, 1.2);
  // Body along -Z (head forward), glowing abdomen at the back.
  const thorax = mesh(G_.sphere(0.14, 12, 8), fuzz, 0, 0, -0.04, root);
  thorax.scale.set(1, 0.95, 1.1);
  const abdomen = mesh(G_.sphere(0.13, 12, 8), glow, 0, -0.02, 0.2, root);
  abdomen.scale.set(0.85, 0.8, 1.5);
  mesh(G_.sphere(0.1, 10, 8), body, 0, 0.02, -0.2, root);
  for (const sx of [-1, 1]) {
    mesh(G_.sphere(0.035, 8, 6), eyes, sx * 0.06, 0.05, -0.27, root);
    const ant = mesh(G_.cyl(0.008, 0.012, 0.22, 4), body, sx * 0.05, 0.14, -0.3, root);
    ant.rotation.set(-0.7, 0, -sx * 0.4);
    mesh(G_.sphere(0.025, 6, 4), glow, sx * 0.1, 0.22, -0.38, root);
  }
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? -1 : 1;
    const pivot = new THREE.Group();
    pivot.name = `Enemy_moth_wing${side}`;
    pivot.position.set(sx * 0.08, 0.06, -0.02);
    root.add(pivot);
    // Fore and hind wing: flat discs swept back.
    const fore = mesh(G_.sphere(0.3, 12, 6), wingMat, sx * 0.3, 0, -0.06, pivot);
    fore.scale.set(1, 0.04, 0.62);
    fore.rotation.y = sx * 0.35;
    const hind = mesh(G_.sphere(0.2, 10, 6), wingMat, sx * 0.2, -0.01, 0.2, pivot);
    hind.scale.set(1, 0.04, 0.8);
    hind.rotation.y = -sx * 0.4;
    mesh(G_.sphere(0.05, 8, 6), glow, sx * 0.36, 0.015, -0.06, pivot).scale.set(1, 0.3, 1);
  }
  return root;
}

/** Bloomkin stand-in: a waddling flower bulb with a glowing petal crown (the healer). */
function buildBloomkin(): THREE.Object3D {
  const L = LOOKS.bloomkin;
  const root = new THREE.Group();
  root.name = 'Enemy_bloomkin';
  const body = mat('p_e_bloomkin', L.body, { roughness: 0.6 });
  const belly = mat('p_eb_bloomkin', L.belly, { roughness: 0.6 });
  const petal = glowMat('Crystal_bloomkin', L.crystal, L.glow, 0.8, { roughness: 0.35, flatShading: true });
  const core = glowMat('Crystal_bloomcore', 0xfff2a0, 0xffd040, 1.6);
  const eyes = glowMat('Eyes', 0xffffff, 0xfff4d0, 1.2);
  const leg = M.dark();
  const bulb = mesh(G_.sphere(0.36, 14, 10), body, 0, 0.42, 0, root);
  bulb.scale.set(1, 0.95, 1);
  const bel = mesh(G_.sphere(0.3, 12, 8), belly, 0, 0.38, -0.1, root);
  bel.scale.set(0.85, 0.85, 0.8);
  for (const sx of [-1, 1]) {
    mesh(G_.sphere(0.05, 8, 6), eyes, sx * 0.12, 0.52, -0.3, root);
    const l = mesh(G_.cyl(0.05, 0.07, 0.24, 6), leg, sx * 0.16, 0.1, 0, root);
    l.rotation.z = sx * 0.12;
    const arm = mesh(G_.sphere(0.12, 8, 6), body, sx * 0.36, 0.42, -0.02, root);
    arm.scale.set(0.5, 1.2, 0.35);
    arm.rotation.z = sx * 0.6;
  }
  mesh(G_.cyl(0.04, 0.06, 0.2, 6), M.stem(), 0, 0.84, 0, root);
  const crown = new THREE.Group();
  crown.position.y = 0.94;
  root.add(crown);
  for (let i = 0; i < 7; i++) {
    const p = new THREE.Group();
    p.rotation.y = (i / 7) * Math.PI * 2;
    crown.add(p);
    const pm = mesh(G_.sphere(0.16, 10, 6), petal, 0.17, 0.05, 0, p);
    pm.scale.set(1.3, 0.25, 0.65);
    pm.rotation.z = 0.5;
  }
  mesh(G_.sphere(0.09, 10, 8), core, 0, 0.08, 0, crown);
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1;
    const lf = mesh(G_.sphere(0.12, 8, 4), M.leaf(), Math.cos(a) * 0.3, 0.72, Math.sin(a) * 0.3, root);
    lf.scale.set(1.3, 0.2, 0.6);
    lf.rotation.y = -a;
  }
  return root;
}

function buildEnemy(kind: EnemyKind): THREE.Object3D {
  if (kind === 'moth') return buildMoth();
  if (kind === 'bloomkin') return buildBloomkin();
  const L = LOOKS[kind];
  const root = new THREE.Group();
  root.name = `Enemy_${kind}`;
  const s = L.h / 0.8; // designed at runner size
  const body = mat(`p_e_${kind}`, L.body, { roughness: 0.55 });
  const belly = mat(`p_eb_${kind}`, L.belly, { roughness: 0.6 });
  const crystal = glowMat(`Crystal_${kind}`, L.crystal, L.glow, 0.6, { roughness: 0.2, flatShading: true });
  const eyes = glowMat('Eyes', 0xffffff, 0xfff4d0, 1.2);
  const leg = M.dark();
  const g = new THREE.Group();
  g.scale.setScalar(s);
  root.add(g);
  // Torso + head (faces -Z).
  const torso = mesh(G_.sphere(0.2, 12, 8), body, 0, 0.36, 0.02, g);
  torso.scale.set(1.05, 0.95, 1.6 * L.long);
  const bel = mesh(G_.sphere(0.17, 10, 6), belly, 0, 0.31, -0.02, g);
  bel.scale.set(0.9, 0.7, 1.4 * L.long);
  const head = mesh(G_.sphere(0.16, 12, 8), body, 0, 0.46, -0.3 * L.long, g);
  head.scale.set(1, 0.9, 1.05);
  mesh(G_.cone(0.08, 0.16, 5), belly, 0, 0.42, -0.45 * L.long, g).rotation.x = -Math.PI / 2;
  for (const sx of [-1, 1]) {
    mesh(G_.sphere(0.04, 8, 6), eyes, sx * 0.075, 0.5, -0.43 * L.long, g);
    const ear = mesh(G_.cone(0.05, 0.2, 4), crystal, sx * 0.1, 0.62, -0.26 * L.long, g);
    ear.rotation.set(-0.3, 0, -sx * 0.4);
  }
  // Legs.
  for (const sz of [-1, 1])
    for (const sx of [-1, 1]) {
      const l = mesh(G_.cone(0.05, 0.3, 5), leg, sx * 0.14, 0.15, sz * 0.17 * L.long, g);
      l.rotation.x = Math.PI;
      l.rotation.z = sx * 0.15;
    }
  // Crystal spikes along the back, swept back.
  for (let i = 0; i < L.spikes; i++) {
    const t = i / Math.max(1, L.spikes - 1);
    const z = (-0.15 + t * 0.4) * L.long;
    const hgt = (0.32 - Math.abs(t - 0.35) * 0.3) * (kind === 'brute' || kind === 'colossus' ? 1.3 : 1);
    const side = i % 2 ? 1 : -1;
    const sp = mesh(G_.cone(0.06, 1, 5), crystal, side * 0.05, 0.5 + hgt * 0.35, z, g);
    sp.scale.set(1, hgt, 1);
    sp.rotation.set(0.6, 0, side * 0.25);
  }
  // Tail.
  const tail = mesh(G_.cone(0.06, 0.3, 5), crystal, 0, 0.42, 0.42 * L.long, g);
  tail.rotation.x = Math.PI / 2 + 0.6;
  if (kind === 'disruptor') mesh(G_.octa(0.08), glowMat('Crystal_orb', 0xe0b0ff, 0xb060ff, 2), 0, 0.95, -0.05, g);
  if (kind === 'colossus' || kind === 'brute') {
    for (const sx of [-1, 1]) {
      const sh = mesh(G_.octa(0.12), crystal, sx * 0.22, 0.5, -0.1, g);
      sh.scale.set(0.8, 1.6, 0.8);
      sh.rotation.z = -sx * 0.6;
    }
  }
  return root;
}

// ---- primitive kit -------------------------------------------------------------------------------------------------

function buildKit(name: KitName): THREE.Object3D {
  const root = new THREE.Group();
  root.name = `Kit_${name}`;
  const rock = mat('p_rock', 0xa9a294, { roughness: 0.95 });
  const rockL = mat('p_rockL', 0xc4bcac, { roughness: 0.95 });
  switch (name) {
    case 'rock_a':
    case 'rock_b':
    case 'rock_c': {
      const n = name === 'rock_a' ? 1 : name === 'rock_b' ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const r = mesh(G_.dodeca(0.55 - i * 0.12), i % 2 ? rockL : rock, i * 0.45 - 0.3, 0.25 - i * 0.04, (i % 2) * 0.35 - 0.1, root);
        r.scale.set(1.2, 0.75, 1);
        r.rotation.set(0.3 * i, i * 1.3, 0.1);
      }
      break;
    }
    case 'bush_a':
    case 'bush_b': {
      const big = name === 'bush_b';
      for (let i = 0; i < 4; i++) {
        const a = i * 1.7;
        const r = (big ? 0.45 : 0.35) - i * 0.04;
        mesh(G_.ico(r, 1), i % 2 ? M.leaf() : M.leafDark(), Math.cos(a) * 0.25, r * 0.85 + (i === 0 ? 0.1 : 0), Math.sin(a) * 0.25, root);
      }
      if (big) for (let i = 0; i < 5; i++) mesh(G_.sphere(0.05, 6, 4), mat('p_berry', 0xf2a0c0), Math.cos(i * 1.3) * 0.4, 0.6, Math.sin(i * 1.3) * 0.4, root);
      break;
    }
    case 'fern': {
      for (let i = 0; i < 7; i++) {
        const p = new THREE.Group();
        p.rotation.y = (i / 7) * Math.PI * 2;
        root.add(p);
        const f = mesh(G_.sphere(0.25, 8, 4), M.leaf(), 0.25, 0.2, 0, p);
        f.scale.set(1.4, 0.12, 0.35);
        f.rotation.z = 0.5;
      }
      break;
    }
    case 'tree_a':
    case 'tree_b': {
      const b = name === 'tree_b';
      mesh(G_.cyl(0.12, 0.18, 1.6, 8), M.bark(), 0, 0.8, 0, root);
      if (b) {
        for (let i = 0; i < 3; i++) mesh(G_.cone(1 - i * 0.22, 1.1, 8), M.leafDark(), 0, 1.5 + i * 0.6, 0, root);
      } else {
        mesh(G_.ico(1, 1), M.leaf(), 0, 2.1, 0, root);
        mesh(G_.ico(0.7, 1), M.leafDark(), 0.5, 1.8, 0.3, root);
        mesh(G_.ico(0.6, 1), M.leaf(), -0.5, 2.4, -0.2, root);
      }
      break;
    }
    case 'flowers_a':
    case 'flowers_b':
    case 'flowers_c': {
      const col = name === 'flowers_a' ? 0xf8f0f0 : name === 'flowers_b' ? 0xffc040 : 0xe880b0;
      const fm = mat(`p_fl_${name}`, col, { roughness: 0.6 });
      for (let i = 0; i < 7; i++) {
        const a = i * 2.4;
        const r = 0.15 + (i % 3) * 0.15;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        mesh(G_.cyl(0.015, 0.015, 0.3, 4), M.stem(), x, 0.15, z, root);
        mesh(G_.sphere(0.07, 8, 6), fm, x, 0.32, z, root).scale.set(1, 0.5, 1);
      }
      break;
    }
    case 'grass_tuft': {
      for (let i = 0; i < 6; i++) {
        const c = mesh(G_.cone(0.04, 0.35, 3), i % 2 ? M.leaf() : M.stem(), Math.cos(i) * 0.08, 0.17, Math.sin(i * 2) * 0.08, root);
        c.rotation.set(Math.sin(i) * 0.3, 0, Math.cos(i) * 0.3);
      }
      break;
    }
    case 'reeds': {
      for (let i = 0; i < 6; i++) {
        const x = Math.cos(i * 2.1) * 0.15;
        const z = Math.sin(i * 2.1) * 0.15;
        mesh(G_.cyl(0.015, 0.02, 1, 4), M.stem(), x, 0.5, z, root);
        if (i % 2) mesh(G_.cyl(0.035, 0.035, 0.18, 6), M.bark(), x, 0.95, z, root);
      }
      break;
    }
    case 'lilypad': {
      mesh(G_.cyl(0.35, 0.35, 0.02, 14), M.water(), 0, 0.01, 0, root);
      mesh(G_.sphere(0.07, 8, 6), mat('p_lilyflower', 0xf8c8e0), 0.1, 0.05, 0.05, root);
      break;
    }
    case 'lamp': {
      mesh(G_.cyl(0.14, 0.18, 0.12, 8), M.stoneDark(), 0, 0.06, 0, root);
      mesh(G_.cyl(0.035, 0.045, 1.3, 8), M.copper(), 0, 0.7, 0, root);
      mesh(G_.sphere(0.13), glowMat('Glow_lamp', 0xfff0c0, 0xffc060, 2.2), 0, 1.45, 0, root);
      mesh(G_.cone(0.18, 0.12, 8), M.copper(), 0, 1.6, 0, root);
      break;
    }
    case 'solar': {
      mesh(G_.cyl(0.04, 0.05, 0.6, 6), M.metal(), 0, 0.3, 0, root);
      const p = mesh(G_.box(1.2, 0.04, 0.8), mat('p_solar', 0x2a4a7a, { roughness: 0.2, metalness: 0.5 }), 0, 0.65, 0, root);
      p.rotation.x = -0.45;
      break;
    }
    case 'bridge': {
      // 2 x 2 cells: 4 m long along -Z, 3 m wide.
      for (let i = 0; i < 9; i++) mesh(G_.box(3, 0.08, 0.4), M.wood(), 0, 0.25 + Math.sin((i / 8) * Math.PI) * 0.15, -1.8 + i * 0.45, root);
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 3; i++) mesh(G_.cyl(0.05, 0.05, 0.6, 6), M.wood(), sx * 1.45, 0.55 + (i === 1 ? 0.15 : 0), -1.6 + i * 1.6, root);
        mesh(G_.box(0.06, 0.06, 4), M.wood(), sx * 1.45, 0.82, 0, root);
      }
      break;
    }
    case 'portal': {
      // 2 x 2 cells; opens towards -Z (Blender +Y).
      mesh(G_.cyl(1.6, 1.8, 0.2, 16), M.stone(), 0, 0.1, 0, root);
      const arch = mesh(G_.torus(1.2, 0.22, 24), M.stoneDark(), 0, 1.3, 0, root);
      void arch;
      const swirl = mesh(G_.cyl(1.05, 1.05, 0.05, 32), glowMat('Glow_portal', 0xc8a0ff, 0x9a50ff, 1.8, { transparent: true, opacity: 0.8 }), 0, 1.3, 0, root);
      swirl.rotation.x = Math.PI / 2;
      for (let i = 0; i < 5; i++) {
        const a = Math.PI * (0.1 + i * 0.2);
        const c = mesh(G_.octa(0.15), glowMat('Glow_portalgem', 0xe8c8ff, 0xb070ff, 2), Math.cos(a) * 1.25, 1.3 + Math.sin(a) * 1.25, 0, root);
        c.scale.set(0.7, 1.3, 0.7);
      }
      break;
    }
    case 'greenhouse': {
      // 4 x 4 cells (8 m); door towards -Z.
      mesh(G_.box(6.6, 0.3, 6.6), M.stone(), 0, 0.15, 0, root);
      mesh(G_.box(6, 2.4, 6), M.glass(), 0, 1.5, 0, root);
      const roof = mesh(G_.cone(4.4, 1.8, 4), M.glass(), 0, 3.6, 0, root);
      roof.rotation.y = Math.PI / 4;
      for (const x of [-3, 3])
        for (const z of [-3, 3]) mesh(G_.box(0.12, 2.6, 0.12), M.shell(), x, 1.5, z, root);
      for (const z of [-3, 3]) mesh(G_.box(6.1, 0.12, 0.12), M.shell(), 0, 2.75, z, root);
      for (const x of [-3, 3]) mesh(G_.box(0.12, 0.12, 6.1), M.shell(), x, 2.75, 0, root);
      mesh(G_.box(1.4, 2, 0.1), M.wood(), 0, 1.3, -3.02, root);
      mesh(G_.sphere(0.6, 12, 8), glowMat('Glow_core_gh', 0xb8ffc8, 0x40ff80, 1.5), 0, 1.3, 0, root);
      for (let i = 0; i < 6; i++) mesh(G_.ico(0.5, 1), M.leaf(), Math.cos(i) * 2, 0.7, Math.sin(i) * 2, root);
      break;
    }
    case 'path_stone': {
      const s = mesh(G_.cyl(0.42, 0.45, 0.08, 7), rockL, 0, 0.03, 0, root);
      s.scale.set(1, 1, 0.8);
      break;
    }
    case 'pebble': {
      mesh(G_.dodeca(0.1), rock, 0, 0.05, 0, root).scale.set(1.3, 0.6, 1);
      break;
    }
  }
  return root;
}

// ---- the models object ---------------------------------------------------------------------------------------------

const TOWER_GLOW = /^Glow/;
const TOWER_TEAM = /^Team/;
/** Enemy emissives: `Crystal` (crystals and eyes, palette-mapped). `Eyes` is accepted for older builds / primitives. */
const ENEMY_GLOW = /^(Crystal|Eyes)/;

/** Root positioned at the origin, detached, world matrices current. */
function normalize(src: THREE.Object3D, skinned: boolean): THREE.Object3D {
  const root = skinned ? cloneSkinned(src) : src.clone(true);
  root.position.set(0, 0, 0);
  root.updateMatrixWorld(true);
  prepareShadows(root);
  if (skinned)
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
    });
  return root;
}

function findByName(root: THREE.Object3D, exact: string, loose: RegExp): THREE.Object3D | null {
  let hit: THREE.Object3D | null = root.getObjectByName(exact) ?? null;
  if (!hit)
    root.traverse((o) => {
      if (!hit && o !== root && loose.test(o.name)) hit = o;
    });
  return hit;
}

/** Swaps materials matching `test` for per-instance clones; returns the clones. */
function ownMaterials(root: THREE.Object3D, test: RegExp, onClone?: (m: Std) => void): Std[] {
  const map = new Map<THREE.Material, Std>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const swap = (src: THREE.Material) => {
      if (!test.test(src.name)) return src;
      let c = map.get(src);
      if (!c) {
        c = (src as Std).clone();
        c.userData.src = src;
        map.set(src, c);
        onClone?.(c);
      }
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
  });
  return [...map.values()];
}

export const createModels: CreateModels = () => {
  let towersG: GLTF | null = null;
  let enemiesG: GLTF | null = null;
  let kitG: GLTF | null = null;
  const report: ModelsReport = { loaded: { towers: false, enemies: false, kit: false }, found: [], missing: [] };
  const noted = new Set<string>();
  const note = (what: string, ok: boolean) => {
    if (noted.has(what)) return;
    noted.add(what);
    (ok ? report.found : report.missing).push(what);
    if (!ok) console.warn(`Garden Sentinels models: missing ${what}; using a stand-in`);
  };

  const ready = Promise.all([load('towers'), load('enemies'), load('kit')]).then(([t, e, k]) => {
    towersG = t;
    enemiesG = e;
    kitG = k;
    report.loaded = { towers: !!t, enemies: !!e, kit: !!k };
  });

  // Template caches: GLB-backed and primitive ones apart, so calls before `ready` do not pin primitives forever.
  const towerTpl = new Map<string, THREE.Object3D>();
  const enemyTpl = new Map<string, { root: THREE.Object3D; clips: Partial<Record<'walk' | 'idle' | 'die' | 'cast', THREE.AnimationClip>> }>();
  const kitTpl = new Map<string, THREE.Object3D>();
  const kitPartsCache = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }[]>();

  function towerTemplate(kind: TowerKind, lv: Level) {
    const name = `Tower_${kind}_${lv}`;
    const key = (towersG ? 'g:' : 'p:') + name;
    let t = towerTpl.get(key);
    if (!t) {
      const src = towersG?.scene.getObjectByName(name);
      if (towersG) note(`node ${name}`, !!src);
      t = src ? normalize(src, false) : normalize(bake(buildTower(kind, lv)), false);
      towerTpl.set(key, t);
    }
    return t;
  }

  function enemyTemplate(kind: EnemyKind) {
    const key = (enemiesG ? 'g:' : 'p:') + kind;
    let t = enemyTpl.get(key);
    if (!t) {
      const name = `Enemy_${kind}`;
      const src = enemiesG?.scene.getObjectByName(name);
      if (enemiesG) note(`node ${name}`, !!src);
      const clips: Partial<Record<'walk' | 'idle' | 'die' | 'cast', THREE.AnimationClip>> = {};
      if (src && enemiesG) {
        const want: ['walk' | 'idle' | 'die' | 'cast', string][] = [
          ['walk', `${kind}_walk`],
          ['idle', `${kind}_idle`],
          ['die', `${kind}_die`],
        ];
        // Any `<kind>_cast` clip maps to the cast action (disruptor, bloomkin); only casters are expected to have one.
        const castName = `${kind}_cast`;
        if (kind === 'disruptor' || kind === 'bloomkin' || enemiesG.animations.some((a) => a.name.startsWith(castName))) want.push(['cast', castName]);
        for (const [slot, clipName] of want) {
          const c = enemiesG.animations.find((a) => a.name === clipName) ?? enemiesG.animations.find((a) => a.name.startsWith(clipName));
          note(`clip ${clipName}`, !!c);
          if (c) clips[slot] = c;
        }
      }
      t = { root: src ? normalize(src, true) : normalize(bake(buildEnemy(kind), true), false), clips };
      enemyTpl.set(key, t);
    }
    return t;
  }

  function kitTemplate(name: KitName) {
    const key = (kitG ? 'g:' : 'p:') + name;
    let t = kitTpl.get(key);
    if (!t) {
      const n = `Kit_${name}`;
      const src = kitG?.scene.getObjectByName(n);
      if (kitG) note(`node ${n}`, !!src);
      t = src ? normalize(src, false) : normalize(bake(buildKit(name), true), false);
      kitTpl.set(key, t);
    }
    return t;
  }

  const models: GardenModels & { report: ModelsReport } = {
    ready,
    report,

    tower(kind, lv, color): TowerModel {
      const tpl = towerTemplate(kind, lv);
      const root = tpl.clone(true);
      const name = tpl.name;
      const team = ownMaterials(root, TOWER_TEAM, (m) => {
        // Keep a little of the authored shading: tint towards the owner's colour.
        m.color.setHex(color);
      });
      const glow = ownMaterials(root, TOWER_GLOW);
      const head = findByName(root, `${name}_head`, /_head$/);
      const muzzles: THREE.Object3D[] = [];
      root.traverse((o) => {
        if (/_muzzle\d*$/.test(o.name)) muzzles.push(o);
      });
      const idx = (o: THREE.Object3D) => Number(/_muzzle(\d*)$/.exec(o.name)?.[1] || '1');
      muzzles.sort((a, b) => idx(a) - idx(b));
      if (!muzzles.length) {
        // Laser and missile need one; others get a point above the tower for zaps / auras.
        const m = new THREE.Object3D();
        m.name = `${name}_muzzle`;
        if (head) {
          m.position.set(0, 0, -0.5);
          head.add(m);
        } else {
          m.position.set(0, 1, 0);
          root.add(m);
        }
        muzzles.push(m);
        if (towersG && (kind === 'laser' || kind === 'missile' || kind === 'sprinkler')) note(`${name}_muzzle`, false);
      }
      if (towersG && (kind === 'laser' || kind === 'missile' || kind === 'sprinkler')) note(`${name}_head`, !!head);
      return {
        root,
        head,
        muzzles,
        glow,
        dispose() {
          for (const m of team) m.dispose();
          for (const m of glow) m.dispose();
          root.removeFromParent();
        },
      };
    },

    enemy(kind): EnemyModel {
      const tpl = enemyTemplate(kind);
      const skinned = !!enemiesG && tpl.root.getObjectByProperty('isSkinnedMesh', true) != null;
      const root = skinned ? cloneSkinned(tpl.root) : tpl.root.clone(true);
      if (skinned) {
        // SkeletonUtils gives every skinned mesh its own Skeleton; meshes on the same bones share one, so the renderer
        // uploads one bone texture per enemy instead of one per mesh.
        const shared = new Map<string, THREE.Skeleton>();
        root.traverse((o) => {
          const sm = o as THREE.SkinnedMesh;
          if (!sm.isSkinnedMesh) return;
          const key = sm.skeleton.bones.map((b) => b.uuid).join();
          const s = shared.get(key);
          if (s) {
            sm.skeleton.dispose();
            sm.skeleton = s;
          } else shared.set(key, sm.skeleton);
        });
      }
      const glow = ownMaterials(root, ENEMY_GLOW);
      const mixer = new THREE.AnimationMixer(root);
      const actions: EnemyModel['actions'] = {};
      for (const slot of ['walk', 'idle', 'die', 'cast'] as const) {
        const clip = tpl.clips[slot];
        if (!clip) continue;
        const a = mixer.clipAction(clip);
        if (slot === 'die' || slot === 'cast') {
          a.setLoop(THREE.LoopOnce, 1);
          a.clampWhenFinished = slot === 'die';
        }
        actions[slot] = a;
      }
      return {
        root,
        mixer,
        actions,
        glow,
        dispose() {
          mixer.stopAllAction();
          mixer.uncacheRoot(root);
          for (const m of glow) m.dispose();
          root.removeFromParent();
        },
      };
    },

    kit(name) {
      return kitTemplate(name).clone(true);
    },

    kitParts(name) {
      const key = (kitG ? 'g:' : 'p:') + name;
      let parts = kitPartsCache.get(key);
      if (!parts) {
        const tpl = kitTemplate(name);
        tpl.updateMatrixWorld(true);
        parts = [];
        const list = parts;
        tpl.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const material = Array.isArray(m.material) ? m.material[0] : m.material;
          list.push({ geometry: m.geometry, material, matrix: m.matrixWorld.clone() });
        });
        kitPartsCache.set(key, parts);
      }
      return parts;
    },
  };
  return models;
};
