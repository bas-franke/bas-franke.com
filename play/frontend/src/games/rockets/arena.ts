// Builds the three.js scene for a Rockets arena from the server's box list, in a cel-shaded comic style: toon-lit
// surfaces in bright colours, an ink hull around every box plus ink crease lines, a hand-drawn tile floor and a sky
// with puffy low-poly clouds. Boxes are merged into one mesh per kind, so even the busiest map draws in a couple of
// dozen calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BoxKind, MapData } from '@shared/rockets/map';
import { INK, flat, hullGeometry, inkMaterial, toonRamp } from '../../engine/toon';

type Visible = Exclude<BoxKind, 'clip'>;

/** Square tiles with inked grout and a few speckles, tinted by the material colour. */
function tileTexture(cells: number, grout: number, speckle: boolean): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  const step = size / cells;
  // Alternate tiles a touch darker, like a printed checker.
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      if ((i + j) % 2) {
        ctx.fillStyle = 'rgba(0,0,0,0.06)';
        ctx.fillRect(i * step, j * step, step, step);
      }
    }
  }
  if (speckle) {
    for (let i = 0; i < 160; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.08})`;
      ctx.beginPath();
      ctx.arc(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.strokeStyle = 'rgba(22,18,28,0.75)';
  ctx.lineWidth = grout;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Comic defaults; maps override per kind through `tint`. */
const PALETTE: Record<Visible, number> = {
  floor: 0xe6d6ae,
  wall: 0x7d93c4,
  platform: 0xf2c14e,
  stair: 0xe8b04a,
  pillar: 0x5ec2e6,
  crate: 0xd9733b,
  ledge: 0xe85d5d,
  tower: 0x8d6bd9,
};

const DEFAULT_ACCENT = 0x3ee0b0;

export interface ArenaView {
  group: THREE.Group;
  padRings: THREE.Mesh[];
  dispose(): void;
}

export function buildArena(map: MapData): ArenaView {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const accent = map.accent ?? DEFAULT_ACCENT;
  const floorTex = tileTexture(2, 5, true);
  const wallTex = tileTexture(2, 3, false);
  disposables.push(floorTex, wallTex);

  // ---- surfaces, merged per kind, plus one ink hull and one set of crease lines for everything ----
  const byKind = new Map<Visible, THREE.BufferGeometry[]>();
  const hulls: THREE.BufferGeometry[] = [];
  const creases: THREE.BufferGeometry[] = [];
  for (const b of map.boxes) {
    if (b.kind === 'clip') continue;
    const sx = b.max.x - b.min.x;
    const sy = b.max.y - b.min.y;
    const sz = b.max.z - b.min.z;
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    // Scale texture coordinates by world size so tiles stay square: 4 m tiles on floors, 2 m on everything else.
    const tile = b.kind === 'floor' ? 4 : 2;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const normal = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const nx = Math.abs(normal.getX(i));
      const ny = Math.abs(normal.getY(i));
      const w = ny > 0.5 ? sx : nx > 0.5 ? sz : sx;
      const h = ny > 0.5 ? sz : sy;
      uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * h) / tile);
    }
    geo.translate((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    if (b.kind !== 'floor') hulls.push(hullGeometry(geo));
    if (b.kind !== 'floor' && b.kind !== 'wall') creases.push(new THREE.EdgesGeometry(geo));
    let list = byKind.get(b.kind);
    if (!list) byKind.set(b.kind, (list = []));
    list.push(geo);
  }

  for (const [kind, list] of byKind) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (!merged) continue;
    const mat = new THREE.MeshToonMaterial({ color: map.tint?.[kind] ?? PALETTE[kind], gradientMap: toonRamp() });
    if (kind === 'floor') mat.map = floorTex;
    else if (kind !== 'crate' && kind !== 'pillar') mat.map = wallTex;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = kind !== 'floor' && kind !== 'wall';
    group.add(mesh);
    disposables.push(merged, mat);
  }
  const hull = mergeGeometries(hulls, false);
  for (const g of hulls) g.dispose();
  if (hull) {
    group.add(new THREE.Mesh(hull, inkMaterial()));
    disposables.push(hull);
  }
  const crease = mergeGeometries(creases, false);
  for (const g of creases) g.dispose();
  if (crease) {
    const mat = new THREE.LineBasicMaterial({ color: INK });
    group.add(new THREE.LineSegments(crease, mat));
    disposables.push(crease, mat);
  }

  // ---- jump pads: a chunky disc with an arrow ring the client spins ----
  const padRings: THREE.Mesh[] = [];
  const padMat = new THREE.MeshToonMaterial({ color: accent, gradientMap: toonRamp() });
  const ringMat = flat(0xffffff);
  const ringGeo = new THREE.TorusGeometry(1, 0.07, 4, 6);
  disposables.push(padMat, ringGeo);
  for (const pad of map.pads) {
    const geo = new THREE.CylinderGeometry(pad.radius, pad.radius * 1.12, 0.16, 10);
    const disc = new THREE.Mesh(geo, padMat);
    disc.position.set(pad.pos.x, pad.pos.y + 0.08, pad.pos.z);
    disc.receiveShadow = true;
    group.add(disc);
    const outline = new THREE.Mesh(hullGeometry(geo), inkMaterial());
    outline.position.copy(disc.position);
    group.add(outline);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.scale.setScalar(pad.radius * 0.7);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(pad.pos.x, pad.pos.y + 0.22, pad.pos.z);
    group.add(ring);
    padRings.push(ring);
  }

  // ---- spawn markers: inked hexagons on the floor ----
  const spawnMat = new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false });
  const spawnGeo = new THREE.RingGeometry(0.5, 0.6, 6);
  disposables.push(spawnMat, spawnGeo);
  for (const s of map.spawns) {
    const ring = new THREE.Mesh(spawnGeo, spawnMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(s.pos.x, s.pos.y + 0.02, s.pos.z);
    group.add(ring);
  }

  group.add(buildSky(map, disposables));

  return {
    group,
    padRings,
    dispose: () => {
      for (const d of disposables) d.dispose();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && !disposables.includes(m.geometry)) m.geometry.dispose();
      });
    },
  };
}

/** A gradient dome (horizon to zenith) with a ring of puffy inked clouds; unaffected by fog. */
function buildSky(map: MapData, disposables: { dispose(): void }[]): THREE.Group {
  const sky = new THREE.Group();
  const radius = 230;
  const domeGeo = new THREE.SphereGeometry(radius, 24, 12);
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { zenith: { value: new THREE.Color(map.skyColor) }, horizon: { value: new THREE.Color(map.fogColor) }, radius: { value: radius } },
    vertexShader: /* glsl */ `
      varying float vH;
      uniform float radius;
      void main() {
        vH = position.y / radius;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vH;
      uniform vec3 zenith;
      uniform vec3 horizon;
      void main() {
        // Banded rather than smooth, like a printed gradient.
        float t = floor(smoothstep(-0.02, 0.6, vH) * 6.0) / 6.0;
        gl_FragColor = vec4(mix(horizon, zenith, t), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  sky.add(dome);
  disposables.push(domeGeo, domeMat);

  // Clouds: clusters of flattened icosahedra, toon-lit, with an ink hull, drawn without fog so they stay crisp.
  const cloudMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp(), fog: false });
  const cloudInk = inkMaterial(0.0016, 0.2, false);
  const puffs: THREE.BufferGeometry[] = [];
  const hulls: THREE.BufferGeometry[] = [];
  const rand = mulberry(map.id.length * 7919 + map.half);
  const count = 14;
  for (let c = 0; c < count; c++) {
    const a = (c / count) * Math.PI * 2 + rand() * 0.3;
    const dist = 150 + rand() * 40;
    const cx = Math.cos(a) * dist;
    const cz = Math.sin(a) * dist;
    const cy = 30 + rand() * 45;
    const blobs = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < blobs; i++) {
      const r = 7 + rand() * 6;
      const geo = new THREE.IcosahedronGeometry(r, 1);
      geo.scale(1, 0.6, 1);
      geo.translate(cx + (i - blobs / 2) * r * 0.9, cy + rand() * 3, cz + (rand() - 0.5) * 6);
      hulls.push(hullGeometry(geo));
      puffs.push(geo);
    }
  }
  const cloudGeo = mergeGeometries(puffs, false);
  const cloudHull = mergeGeometries(hulls, false);
  for (const g of [...puffs, ...hulls]) g.dispose();
  if (cloudGeo && cloudHull) {
    sky.add(new THREE.Mesh(cloudGeo, cloudMat), new THREE.Mesh(cloudHull, cloudInk));
    disposables.push(cloudGeo, cloudHull, cloudMat);
  }
  return sky;
}

/** Small seeded PRNG so a map's clouds look the same for everyone. */
function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function addArenaLights(scene: THREE.Scene, map: MapData) {
  scene.background = new THREE.Color(map.fogColor);
  // Light haze only: comic art keeps the far side readable.
  scene.fog = new THREE.Fog(map.fogColor, map.half * 1.6, Math.max(120, map.half * 5.5));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a6a, 1.6));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  sun.position.set(18, 30, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const half = map.half + 4;
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 40 + map.half * 3;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);
}
