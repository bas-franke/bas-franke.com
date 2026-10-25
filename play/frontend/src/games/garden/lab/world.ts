// Garden world lab: renders a map's boards through world.ts + post.ts without the server.
//   /lab-garden-world.html?map=<id>&boards=<n>&q=<low|medium|high>&view=<all|0..5>&out=<b,b>&hp=<0..1>
// Drag = pan, right-drag = orbit, wheel = zoom, 1/2/3 = quality. Models come from ../models.ts when it exists,
// otherwise from /models/garden/kit.glb, otherwise from primitive stand-ins (all below).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Engine } from '../../../engine/engine';
import { G } from '@shared/garden/constants';
import { boardOrigin } from '@shared/garden/board';
import { GMAPS, type GMapDef, type GRoute } from '@shared/garden/maps';
import type { GardenModels, KitName, Quality } from '../api';
import { createWorldView } from '../world';
import { createPipeline } from '../post';

const params = new URLSearchParams(location.search);
const hud = document.getElementById('hud')!;

// ---- temporary map (until GMAPS has maps) ---------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function labMap(): GMapDef {
  const W = 30;
  const H = 18;
  const g: string[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => '.'));
  const set = (c: number, r: number, ch: string) => {
    if (r >= 0 && r < H && c >= 0 && c < W) g[r][c] = ch;
  };
  const get = (c: number, r: number) => g[r]?.[c];
  const routes: GRoute[] = [
    { entry: 0, half: 1, pts: [[2, 2], [14, 2], [14, 10], [17, 10]] },
    { entry: 1, half: 1, pts: [[2, 15], [10, 15], [10, 10], [17, 10]] },
    { entry: 2, half: 1, pts: [[28, 2], [25, 2], [25, 14], [15, 14], [15, 10], [17, 10]] },
  ];
  const rect = (c0: number, r0: number, c1: number, r1: number, ch: string) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) set(c, r, ch);
  };
  // Water first, paths over it become bridges.
  rect(6, 0, 7, 4, '~');
  rect(3, 5, 7, 10, '~');
  rect(4, 11, 5, 17, '~');
  rect(21, 6, 29, 7, '~');
  rect(12, 16, 22, 17, '~');
  rect(16, 15, 19, 15, '~');
  for (const rt of routes) {
    for (let i = 1; i < rt.pts.length; i++) {
      const [ax, ay] = rt.pts[i - 1];
      const [bx, by] = rt.pts[i];
      const c0 = Math.floor(Math.min(ax, bx) - rt.half);
      const c1 = Math.ceil(Math.max(ax, bx) + rt.half) - 1;
      const r0 = Math.floor(Math.min(ay, by) - rt.half);
      const r1 = Math.ceil(Math.max(ay, by) + rt.half) - 1;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) set(c, r, get(c, r) === '~' || get(c, r) === '=' ? '=' : '#');
    }
  }
  rect(0, 1, 1, 2, 'E');
  rect(0, 14, 1, 15, 'E');
  rect(28, 1, 29, 2, 'E');
  rect(17, 8, 20, 11, 'G');
  const rand = rng(7);
  const near = (c: number, r: number, chs: string) => {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (chs.includes(get(c + dc, r + dr) ?? '')) return true;
    return false;
  };
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      if (get(c, r) === '~' && rand() < 0.22 && !near(c, r, '#=')) set(c, r, 'o');
    }
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      if (get(c, r) !== '.') continue;
      const edge = r === 0 || r === H - 1 || c === 0 || c === W - 1;
      const x = rand();
      if (edge && x < 0.55) set(c, r, rand() < 0.2 ? 'f' : 'T');
      else if (near(c, r, '~o') && x < 0.12) set(c, r, 'R');
      else if (near(c, r, '#') && x < 0.07) set(c, r, 'l');
      else if (x < 0.035) set(c, r, 'T');
      else if (x < 0.05) set(c, r, 'f');
      else if (x < 0.056) set(c, r, 's');
    }
  rect(11, 5, 12, 6, 'f');
  rect(20, 3, 21, 3, 'T');
  return {
    id: 'lab',
    name: 'Lab Garden',
    blurb: 'temporary lab map',
    modes: ['coop', 'vs'],
    grid: g.map((row) => row.join('')),
    entries: [
      { x: 1, y: 2, facing: Math.PI / 2 },
      { x: 1, y: 15, facing: Math.PI / 2 },
      { x: 29, y: 2, facing: -Math.PI / 2 },
    ],
    goal: { x: 19, y: 10 },
    routes,
    mood: { warmth: 0.6, water: 0.5 },
  };
}

// ---- stand-in models ------------------------------------------------------------------------------------------

type Part = { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 };

const mat = (color: number, o: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...o });
const M = {
  leaf: mat(0x5c9e3f, { name: 'Leaf' }),
  leafDark: mat(0x3f7f34, { name: 'LeafDark' }),
  leafLight: mat(0x86c255, { name: 'LeafLight' }),
  trunk: mat(0x7a5236),
  rock: mat(0x9a958c, { roughness: 0.95 }),
  moss: mat(0x6e9a45),
  cream: mat(0xf2e3cf, { roughness: 0.5, name: 'Ceramic' }),
  creamDark: mat(0xd8c4a8, { roughness: 0.6 }),
  metal: mat(0x8c8f96, { metalness: 0.7, roughness: 0.35 }),
  glow: mat(0xffc070, { emissive: 0xffa940, emissiveIntensity: 3, name: 'Glow' }),
  glowMint: mat(0x80fff0, { emissive: 0x4ee6d9, emissiveIntensity: 2.5, name: 'GlowMint' }),
  glowViolet: mat(0xc9a0ff, { emissive: 0xa869ff, emissiveIntensity: 2.5, name: 'GlowViolet' }),
  glass: mat(0xffd27a, { emissive: 0xffa940, emissiveIntensity: 1.4, roughness: 0.2, transparent: true, opacity: 0.85, name: 'GlowGlass' }),
  solar: mat(0x1d3b6e, { roughness: 0.25, metalness: 0.4 }),
  pad: mat(0x5fae45, { roughness: 0.6 }),
  pink: mat(0xff7eb6),
  yellow: mat(0xffd34d),
  violet: mat(0xb48cff),
  white: mat(0xfff6ea),
};

function at(geo: THREE.BufferGeometry, x: number, y: number, z: number, sx = 1, sy = sx, sz = sx, ry = 0) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(sx, sy, sz));
  return geo.clone().applyMatrix4(m);
}

function standIn(name: KitName): Part[] {
  const r = rng(name.length * 977 + name.charCodeAt(0) * 13 + name.charCodeAt(name.length - 1));
  const by = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const add = (m: THREE.Material, g: THREE.BufferGeometry) => {
    const list = by.get(m) ?? [];
    list.push(g.index ? g.toNonIndexed() : g);
    by.set(m, list);
  };
  const ball = new THREE.IcosahedronGeometry(1, 1);
  const rockG = new THREE.DodecahedronGeometry(1, 0);
  switch (name) {
    case 'rock_a':
    case 'rock_b':
    case 'rock_c': {
      const n = name === 'rock_a' ? 1 : name === 'rock_b' ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const s = 0.35 + r() * 0.35;
        add(M.rock, at(rockG, (r() - 0.5) * 0.9, s * 0.4, (r() - 0.5) * 0.9, s * 1.2, s * 0.8, s, r() * 6));
      }
      break;
    }
    case 'bush_a':
    case 'bush_b':
      for (let i = 0; i < 4; i++) {
        const s = 0.35 + r() * 0.25;
        add(i % 2 ? M.leaf : M.leafDark, at(ball, (r() - 0.5) * 0.7, s * 0.8, (r() - 0.5) * 0.7, s));
      }
      if (name === 'bush_b') for (let i = 0; i < 5; i++) add(M.pink, at(ball, (r() - 0.5) * 0.8, 0.6 + r() * 0.3, (r() - 0.5) * 0.8, 0.07));
      break;
    case 'fern':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const g = new THREE.ConeGeometry(0.12, 0.7, 4).rotateZ(-1.0).rotateY(a);
        add(M.leafLight, at(g, Math.cos(a) * 0.2, 0.25, -Math.sin(a) * 0.2));
      }
      break;
    case 'tree_a':
    case 'tree_b':
      add(M.trunk, at(new THREE.CylinderGeometry(0.12, 0.18, 2, 6), 0, 1, 0));
      for (let i = 0; i < 4; i++) {
        const s = 0.7 + r() * 0.4;
        add(i % 2 ? M.leaf : M.leafDark, at(ball, (r() - 0.5) * 1.0, 2.2 + r() * 0.8, (r() - 0.5) * 1.0, s));
      }
      break;
    case 'flowers_a':
    case 'flowers_b':
    case 'flowers_c': {
      const c = name === 'flowers_a' ? M.pink : name === 'flowers_b' ? M.yellow : M.violet;
      for (let i = 0; i < 4; i++) add(M.leaf, at(ball, (r() - 0.5) * 0.7, 0.15, (r() - 0.5) * 0.7, 0.22, 0.16, 0.22));
      for (let i = 0; i < 9; i++) add(i % 3 ? c : M.white, at(ball, (r() - 0.5) * 0.8, 0.3 + r() * 0.1, (r() - 0.5) * 0.8, 0.07));
      break;
    }
    case 'grass_tuft':
      for (let i = 0; i < 5; i++) add(M.leafLight, at(new THREE.ConeGeometry(0.03, 0.3, 3), (r() - 0.5) * 0.2, 0.15, (r() - 0.5) * 0.2));
      break;
    case 'reeds':
      for (let i = 0; i < 7; i++) add(M.leaf, at(new THREE.CylinderGeometry(0.015, 0.02, 0.9, 3), (r() - 0.5) * 0.3, 0.45, (r() - 0.5) * 0.3));
      break;
    case 'lilypad':
      add(M.pad, new THREE.CylinderGeometry(0.35, 0.35, 0.03, 12, 1, false, 0.3, Math.PI * 2 - 0.6).translate(0, 0.015, 0));
      break;
    case 'lamp':
      add(M.cream, new THREE.CylinderGeometry(0.18, 0.25, 0.25, 10).translate(0, 0.12, 0));
      add(M.metal, new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6).translate(0, 0.7, 0));
      add(M.glow, new THREE.CylinderGeometry(0.13, 0.13, 0.3, 10).translate(0, 1.3, 0));
      add(M.cream, new THREE.CylinderGeometry(0.06, 0.16, 0.1, 10).translate(0, 1.5, 0));
      break;
    case 'solar':
      add(M.cream, new THREE.CylinderGeometry(0.1, 0.12, 0.6, 6).translate(0, 0.3, 0));
      add(M.solar, new THREE.BoxGeometry(1.3, 0.05, 0.9).rotateX(-0.5).translate(0, 0.7, 0));
      break;
    case 'bridge':
      add(M.cream, new THREE.BoxGeometry(3.6, 0.25, 4.2).translate(0, 0.12, 0));
      add(M.creamDark, new THREE.BoxGeometry(0.2, 0.5, 4.2).translate(1.8, 0.45, 0));
      add(M.creamDark, new THREE.BoxGeometry(0.2, 0.5, 4.2).translate(-1.8, 0.45, 0));
      break;
    case 'portal': {
      add(M.cream, new THREE.TorusGeometry(1.5, 0.5, 8, 16, Math.PI).translate(0, 0.3, 0));
      add(M.creamDark, new THREE.BoxGeometry(4, 0.2, 3).translate(0, 0.1, 0.3));
      add(M.glowViolet, new THREE.CircleGeometry(1.1, 16, 0, Math.PI).translate(0, 0.3, -0.05));
      break;
    }
    case 'greenhouse':
      add(M.cream, new THREE.CylinderGeometry(3.8, 3.9, 0.5, 32).translate(0, 0.25, 0));
      add(M.glass, new THREE.SphereGeometry(3.1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.5, 0));
      add(M.cream, new THREE.TorusGeometry(3.15, 0.12, 6, 32).rotateX(Math.PI / 2).translate(0, 0.55, 0));
      add(M.cream, new THREE.BoxGeometry(1.4, 1.6, 1.2).translate(0, 0.8, -3.4));
      add(M.glow, new THREE.BoxGeometry(0.9, 1.2, 0.1).translate(0, 0.7, -4.0));
      break;
    case 'path_stone':
      add(M.creamDark, new THREE.BoxGeometry(0.5, 0.12, 0.35).translate(0, 0.06, 0));
      break;
    case 'pebble':
      add(M.rock, at(rockG, 0, 0.04, 0, 0.1, 0.06, 0.08));
      break;
  }
  return [...by].map(([material, gs]) => ({ geometry: mergeGeometries(gs)!, material, matrix: new THREE.Matrix4() }));
}

function labModels(): GardenModels {
  const parts = new Map<KitName, Part[]>();
  let gltfRoot: THREE.Object3D | null = null;
  const ready = new GLTFLoader()
    .loadAsync('/models/garden/kit.glb')
    .then((g) => {
      gltfRoot = g.scene;
      gltfRoot.updateMatrixWorld(true);
    })
    .catch(() => console.info('kit.glb not found: primitive stand-ins'));
  const fromGltf = (name: KitName): Part[] | null => {
    const root = gltfRoot?.getObjectByName(`Kit_${name}`);
    if (!root) return null;
    const inv = root.matrixWorld.clone().invert();
    const out: Part[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (mats.length === 1) out.push({ geometry: m.geometry, material: mats[0], matrix: inv.clone().multiply(m.matrixWorld) });
      else
        m.geometry.groups.forEach((gr) => {
          const g = m.geometry.clone();
          g.clearGroups();
          g.setDrawRange(gr.start, gr.count);
          out.push({ geometry: g, material: mats[gr.materialIndex ?? 0], matrix: inv.clone().multiply(m.matrixWorld) });
        });
    });
    return out;
  };
  const kitParts = (name: KitName) => {
    let p = parts.get(name);
    if (!p) {
      p = fromGltf(name) ?? standIn(name);
      parts.set(name, p);
    }
    return p;
  };
  return {
    ready,
    tower: () => {
      throw new Error('lab: no towers');
    },
    enemy: () => {
      throw new Error('lab: no enemies');
    },
    kit(name) {
      const g = new THREE.Group();
      for (const p of kitParts(name)) {
        const m = new THREE.Mesh(p.geometry, p.material);
        m.applyMatrix4(p.matrix);
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      }
      return g;
    },
    kitParts,
  };
}

async function loadModels(): Promise<GardenModels> {
  const mods = import.meta.glob('../models.ts');
  const load = mods['../models.ts'];
  if (load && !params.has('standin')) {
    try {
      const mod = (await load()) as { createModels?: () => GardenModels };
      if (mod.createModels) return mod.createModels();
    } catch (e) {
      console.warn('models.ts failed, using lab stand-ins', e);
    }
  }
  return labModels();
}

// ---- scene ----------------------------------------------------------------------------------------------------

async function main() {
  const def = GMAPS.find((m) => m.id === params.get('map')) ?? GMAPS[0] ?? labMap();
  const boards = Math.max(1, Math.min(6, Number(params.get('boards') ?? 1)));
  let quality = (params.get('q') as Quality) || 'high';
  const origins = Array.from({ length: boards }, (_, b) => boardOrigin(def, b, boards));
  const engine = new Engine(document.getElementById('app')!, { fov: 35, near: 1, far: 900 });
  const models = await loadModels();
  await models.ready;
  const world = createWorldView(engine.scene, def, origins, models, quality);
  const pipe = createPipeline(engine.renderer, engine.scene, engine.camera, quality);
  engine.renderHook = () => pipe.render(1 / 60);
  for (const b of (params.get('out') ?? '').split(',').filter(Boolean)) world.setOut(Number(b));
  if (params.has('hp')) world.setHealth(0, Number(params.get('hp')));

  // Camera: target on the ground, yaw/pitch/distance.
  const W = def.grid[0].length * G.cell;
  const H = def.grid.length * G.cell;
  const view = params.get('view') ?? (boards > 1 ? 'all' : '0');
  const target = new THREE.Vector3();
  let dist: number;
  if (view === 'all') {
    const bd = world.bounds;
    target.set((bd.minX + bd.maxX) / 2, 0, (bd.minZ + bd.maxZ) / 2);
    dist = Math.max(bd.maxX - bd.minX, (bd.maxZ - bd.minZ) * 1.6) * 1.15;
  } else {
    const o = origins[Number(view)] ?? origins[0];
    target.set(o.x, 0, o.z);
    dist = Math.max(W, H * 1.6) * 1.3;
  }
  dist = Number(params.get('dist') ?? dist);
  if (params.has('tx')) target.x = Number(params.get('tx'));
  if (params.has('tz')) target.z = Number(params.get('tz'));
  let yaw = Number(params.get('yaw') ?? 0);
  let pitch = (Number(params.get('pitch') ?? 55) * Math.PI) / 180;
  const cam = engine.camera;
  const place = () => {
    const h = Math.cos(pitch) * dist;
    cam.position.set(target.x + Math.sin(yaw) * h, Math.sin(pitch) * dist, target.z + Math.cos(yaw) * h);
    cam.lookAt(target);
    pipe.setFocus(target, dist);
  };
  place();
  const el = engine.renderer.domElement;
  let drag = -1;
  let lx = 0;
  let ly = 0;
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    drag = e.button;
    lx = e.clientX;
    ly = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointerup', () => (drag = -1));
  el.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const dx = e.clientX - lx;
    const dy = e.clientY - ly;
    lx = e.clientX;
    ly = e.clientY;
    if (drag === 0) {
      const k = dist * 0.0012;
      target.x += (-dx * Math.cos(yaw) - dy * Math.sin(yaw)) * k;
      target.z += (dx * Math.sin(yaw) - dy * Math.cos(yaw)) * k;
    } else {
      yaw -= dx * 0.005;
      pitch = Math.min(1.45, Math.max(0.35, pitch + dy * 0.004));
    }
    place();
  });
  el.addEventListener('wheel', (e) => {
    dist = Math.min(400, Math.max(8, dist * Math.exp(e.deltaY * 0.001)));
    place();
  });
  addEventListener('keydown', (e) => {
    const q = ({ Digit1: 'low', Digit2: 'medium', Digit3: 'high' } as Record<string, Quality>)[e.code];
    if (q) {
      quality = q;
      world.setQuality(q);
      pipe.setQuality(q);
    }
  });
  addEventListener('resize', () => pipe.setSize(innerWidth, innerHeight));

  let hudAt = 0;
  engine.start((dt, now) => {
    world.update(dt, now);
    if (now - hudAt > 0.4) {
      hudAt = now;
      const s = engine.stats;
      hud.textContent = `${def.name} (${def.id})  boards ${boards}  q ${quality}\n${engine.fps.toFixed(0)} fps  ${s.calls} calls  ${(s.triangles / 1000).toFixed(0)}k tris  ratio ${s.ratio}`;
    }
  });
  (window as unknown as { __lab: unknown }).__lab = { world, pipe, engine };
}

main().catch((e) => {
  hud.textContent = String(e?.stack ?? e);
  console.error(e);
});
