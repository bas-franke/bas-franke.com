// The Last Light room as the player sees it: chunk walls and props (one InstancedMesh per material, world-space
// box-projected PBR textures so brickwork runs on across chunks, per-instance damage that grows cracks), floor and
// ceiling with beams and skylight holes, window frames with boards and broken glass, lockers with the gun for sale,
// hanging lamps (shadow-casting spot lights that flicker), the muddy yard with a fence and dead trees, a night sky
// and a cold moon. Models from models.ts replace the primitive stand-ins as soon as they have loaded.
//
// The pipeline (post.ts) reads `group.userData.envScene` to build a dark reflection environment, and skips objects
// with `userData.noMoonShadow` when it renders its own moon depth map.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ZB } from '@shared/zombies/constants';
import type { Mat } from '@shared/zombies/maps';
import { WEAPONS } from '@shared/zombies/weapons';
import { ARMOR_PRICE, NADE_PRICE } from '@shared/zombies/weapons';
import { type StationInfo, type World, SILL_Y, WALL_T, WINDOW_TOP } from '@shared/zombies/world';
import type { CreateWorldView, LampLight, Models, Quality, WorldView } from './api';
import { type Glow, buildDecor } from './decor';
import { DEFAULT_SIZE, type SetName, type TexSet, texSet as rawTexSet } from './textures';

/** What post.ts reads beyond the WorldView contract. */
export interface WorldViewExt extends WorldView {
  /** Point glows for the fog (fire, candles, the exit sign). */
  glows: Glow[];
  /** Floor and yard texture sets: their roughness masks the wet-floor reflections. */
  floorSet: TexSet;
  floorMeters: number;
  yardSet: TexSet;
  /** Extra dust in the air (the chapel's shafts), 1 = normal. */
  dust: number;
  /** 0..1 while a lightning flash lights the windows. */
  lightning: number;
  /** Set by the client to play thunder; strength 0..1, called at the first flash. */
  onLightning?: (strength: number) => void;
}

const MAT_SET: Record<Mat, SetName> = { brick: 'brick', plaster: 'plaster', concrete: 'concrete', wood: 'wood', metal: 'metal' };
const FLOOR_SET = { concrete: 'floorConcrete', wood: 'floorWood', tile: 'floorTile' } as const;

/** Shadow-casting lamps and shadow map sizes per quality. */
const QUALITY_SPEC: Record<Quality, { lampShadows: number; lampMap: number; moonMap: number; texScale: number }> = {
  low: { lampShadows: 1, lampMap: 512, moonMap: 1024, texScale: 0.5 },
  medium: { lampShadows: 3, lampMap: 512, moonMap: 2048, texScale: 1 },
  high: { lampShadows: 4, lampMap: 1024, moonMap: 2048, texScale: 1 },
};

// ---- box-projected material -----------------------------------------------------------------------------------------

interface ProjOpts {
  set: TexSet;
  color?: number;
  instanced?: boolean;
  /** Per-instance `aDamage` attribute drives cracks. */
  damage?: boolean;
  /** Steel: damage dents and scorches instead of cracking. */
  dents?: boolean;
  /** Damp at the floor, soot under the ceiling, large-scale tone variation. */
  grime?: boolean;
  ceiling?: number;
  env?: number;
  normalScale?: number;
}

const NOISE_GLSL = /* glsl */ `
float zHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 zHash2(vec2 p) { return vec2(zHash(p), zHash(p + 17.17)); }
float zNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(zHash(i), zHash(i + vec2(1, 0)), f.x), mix(zHash(i + vec2(0, 1)), zHash(i + vec2(1, 1)), f.x), f.y);
}
float zFbm(vec2 p) { return zNoise(p) * 0.5 + zNoise(p * 2.03 + 3.1) * 0.25 + zNoise(p * 4.1 + 7.7) * 0.125 + zNoise(p * 8.3 + 1.3) * 0.0625; }
// F2 - F1 of a cellular pattern: small along the cell edges, which become the cracks.
float zCellEdge(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  float d1 = 8.0; float d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = zHash2(i + g);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return d2 - d1;
}
`;

function projMaterial(o: ProjOpts): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: o.set.map,
    normalMap: o.set.normalMap,
    roughnessMap: o.set.orm,
    metalnessMap: o.set.orm,
    roughness: 1,
    metalness: 1,
    color: o.color ?? 0xffffff,
    envMapIntensity: o.env ?? 0.6,
  });
  m.normalScale.set(o.normalScale ?? 1, o.normalScale ?? 1);
  // The sharp textures arrive from the texture workers a moment after the placeholders.
  o.set.onUpgrade((s) => {
    m.map = s.map;
    m.normalMap = s.normalMap;
    m.roughnessMap = s.orm;
    m.metalnessMap = s.orm;
  });
  const scale = 1 / o.set.meters;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTexScale = { value: scale };
    sh.uniforms.uCeil = { value: o.ceiling ?? 4 };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTexScale;
varying vec3 vZPos;
varying vec3 vZNrm;
varying vec2 vZUv;
${o.damage ? 'attribute float aDamage; varying float vZDamage;' : ''}`,
      )
      .replace(
        '#include <fog_vertex>',
        `#include <fog_vertex>
{
  mat4 zm = modelMatrix;
  #ifdef USE_INSTANCING
  zm = modelMatrix * instanceMatrix;
  #endif
  vec4 zw = zm * vec4(position, 1.0);
  vec3 zn = normalize(mat3(zm) * normal);
  vZPos = zw.xyz;
  vZNrm = zn;
  // Side faces get an offset, so a corner shows a seam instead of a mirror image.
  vec2 zuv = abs(zn.x) > 0.5 ? zw.zy + vec2(13.7, 5.3) : abs(zn.y) > 0.5 ? zw.xz : zw.xy;
  vZUv = zuv;
  zuv *= uTexScale;
  #ifdef USE_MAP
  vMapUv = zuv;
  #endif
  #ifdef USE_NORMALMAP
  vNormalMapUv = zuv;
  #endif
  #ifdef USE_ROUGHNESSMAP
  vRoughnessMapUv = zuv;
  #endif
  #ifdef USE_METALNESSMAP
  vMetalnessMapUv = zuv;
  #endif
  ${o.damage ? 'vZDamage = aDamage;' : ''}
}`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uCeil;
varying vec3 vZPos;
varying vec3 vZNrm;
varying vec2 vZUv;
${o.damage ? 'varying float vZDamage;' : ''}
${NOISE_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
float zLow = 1.0 - smoothstep(0.0, 1.2, vZPos.y);
float zCrack = 0.0;
${
  o.grime
    ? `diffuseColor.rgb *= 1.0 - 0.38 * zLow * (0.6 + 0.4 * zNoise(vZUv * 3.0));
  diffuseColor.rgb *= 1.0 - 0.5 * smoothstep(uCeil - 1.6, uCeil, vZPos.y) * (0.5 + 0.5 * zFbm(vZUv * 1.3));
  diffuseColor.rgb *= 0.8 + 0.4 * zFbm(vZUv * 0.45 + vZPos.y * 0.07);`
    : `diffuseColor.rgb *= 0.88 + 0.24 * zFbm(vZUv * 0.4);`
}
${
  o.damage
    ? `if (vZDamage > 0.001) {
  float zd = vZDamage;
  float edge = zCellEdge(vZUv * 7.0 + zFbm(vZUv * 5.0) * 0.6);
  float mask = smoothstep(1.05 - zd * 1.2, 1.25 - zd * 1.2, zFbm(vZUv * 2.2 + 9.0));
  ${
    o.dents
      ? 'zCrack = smoothstep(0.55, 0.9, zNoise(vZUv * 9.0)) * mask * 0.6;'
      : `zCrack = (1.0 - smoothstep(0.0, 0.025 + 0.06 * zd, edge)) * mask;
  float fine = (1.0 - smoothstep(0.0, 0.03, zCellEdge(vZUv * 23.0))) * mask * zd;
  zCrack = max(zCrack, fine * 0.7);`
  }
  diffuseColor.rgb *= 1.0 - 0.85 * zCrack;
  diffuseColor.rgb *= 1.0 - 0.3 * zd * zFbm(vZUv * 6.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.3, 0.27) * dot(diffuseColor.rgb, vec3(0.33)) * 2.4, zd * 0.25 * zNoise(vZUv * 13.0));
}`
    : ''
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
${o.grime ? 'roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.55, zLow * 0.6);' : ''}
roughnessFactor = mix(roughnessFactor, 1.0, zCrack);`,
      );
  };
  m.customProgramCacheKey = () => `zproj-${o.damage ? 1 : 0}${o.grime ? 1 : 0}${o.instanced ? 1 : 0}${o.dents ? 1 : 0}`;
  return m;
}

// ---- helpers ----------------------------------------------------------------------------------------------------

const box = (sx: number, sy: number, sz: number) => new THREE.BoxGeometry(sx, sy, sz);

function meshAt(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function plaque(lines: string[], accent: string): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1a1c1a';
  g.fillRect(0, 0, 512, 160);
  // Scuffed edge and screws.
  g.strokeStyle = '#3a3c38';
  g.lineWidth = 8;
  g.strokeRect(6, 6, 500, 148);
  g.fillStyle = '#5a5a52';
  for (const [x, y] of [
    [20, 20],
    [492, 20],
    [20, 140],
    [492, 140],
  ]) {
    g.beginPath();
    g.arc(x, y, 6, 0, Math.PI * 2);
    g.fill();
  }
  g.textAlign = 'center';
  g.fillStyle = accent;
  g.font = '700 54px "Space Grotesk", Impact, sans-serif';
  g.fillText(lines[0], 256, 70);
  g.fillStyle = '#d8c9a0';
  g.font = '600 40px "JetBrains Mono", monospace';
  g.fillText(lines[1] ?? '', 256, 128);
  // Grime.
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.25})`;
    g.fillRect(Math.random() * 512, Math.random() * 160, 2 + Math.random() * 5, 1 + Math.random() * 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.6, metalness: 0.3 });
  return new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.24), mat);
}

function stationText(st: StationInfo): [string, string, string] {
  switch (st.kind) {
    case 'weapon': {
      const w = WEAPONS[st.item!];
      return [w.name.toUpperCase(), `${w.price}  ·  AMMO ${w.ammoPrice}`, w.era === 'modern' ? '#9fd3ff' : '#ffcf7a'];
    }
    case 'ammo':
      return ['AMMO CACHE', 'REFILL ALL', '#a8ff9a'];
    case 'nades':
      return ['FRAG GRENADES', `${NADE_PRICE}`, '#ffb070'];
    case 'armor':
      return ['BODY ARMOR', `${ARMOR_PRICE}`, '#c8b8ff'];
  }
}

// ---- the view -------------------------------------------------------------------------------------------------------

export const createWorldView: CreateWorldView = (scene, world, models, quality) => {
  const def = world.def;
  const group = new THREE.Group();
  group.name = 'world';
  scene.add(group);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(d: T) => (disposables.push(d), d);
  const h = world.height;
  const lampColor = new THREE.Color(def.lampColor ?? 0xffb46b);
  // Low quality builds half-resolution textures (four times faster to generate, a quarter of the memory).
  const texSet = (n: SetName) => rawTexSet(n, Math.round(DEFAULT_SIZE(n) * QUALITY_SPEC[quality].texScale));

  // Materials (shared).
  const chunkMats = new Map<Mat, THREE.MeshStandardMaterial>();
  const chunkMat = (m: Mat) => {
    let mat = chunkMats.get(m);
    if (!mat) {
      mat = keep(projMaterial({ set: texSet(MAT_SET[m]), instanced: true, damage: true, dents: m === 'metal', grime: true, ceiling: h, env: m === 'metal' ? 1 : 0.5 }));
      chunkMats.set(m, mat);
    }
    return mat;
  };
  const concrete = keep(projMaterial({ set: texSet('concrete'), grime: true, ceiling: h, env: 0.4 }));
  const ceilingMat = keep(projMaterial({ set: texSet('concrete'), color: 0x6a665f, env: 0.2 }));
  const steel = keep(projMaterial({ set: texSet('metal'), color: 0x8a8a84, env: 0.9 }));
  const floorSet = texSet(FLOOR_SET[def.floor]);
  const yardSet = texSet('mud');
  const floorMat = keep(projMaterial({ set: floorSet, grime: false, env: 1.0 }));
  const mudMat = keep(projMaterial({ set: yardSet, env: 0.8 }));
  const woodSet = texSet('wood');
  const woodMat = keep(new THREE.MeshStandardMaterial({ map: woodSet.map, normalMap: woodSet.normalMap, roughnessMap: woodSet.orm, roughness: 1, metalness: 0, envMapIntensity: 0.4 }));
  woodSet.onUpgrade((st) => {
    woodMat.map = st.map;
    woodMat.normalMap = st.normalMap;
    woodMat.roughnessMap = st.orm;
  });
  const ironMat = keep(new THREE.MeshStandardMaterial({ color: 0x2a2522, roughness: 0.55, metalness: 0.85 }));
  const glassMat = keep(new THREE.MeshStandardMaterial({ color: 0x9fb4b0, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.22, side: THREE.DoubleSide, envMapIntensity: 1.6, depthWrite: false }));
  const barkMat = keep(new THREE.MeshStandardMaterial({ color: 0x1c1915, roughness: 0.95 }));

  // ---- chunks ------------------------------------------------------------------------------------------------
  const byMat = new Map<Mat, number[]>();
  world.chunks.forEach((c, i) => {
    const list = byMat.get(c.mat) ?? [];
    list.push(i);
    byMat.set(c.mat, list);
  });
  const unitBox = keep(box(1, 1, 1));
  const slot = new Int32Array(world.chunks.length);
  const meshOf: THREE.InstancedMesh[] = new Array(world.chunks.length);
  const damageAttr = new Map<THREE.InstancedMesh, THREE.InstancedBufferAttribute>();
  const visualDamage = new Float32Array(world.chunks.length);
  const m4 = new THREE.Matrix4();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const [mat, list] of byMat) {
    const geo = unitBox.clone();
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(list.length), 1);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aDamage', attr);
    keep(geo);
    const mesh = new THREE.InstancedMesh(geo, chunkMat(mat), list.length);
    mesh.name = `chunks-${mat}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    list.forEach((ci, k) => {
      const c = world.chunks[ci];
      m4.makeScale(c.max.x - c.min.x, c.max.y - c.min.y, c.max.z - c.min.z);
      m4.setPosition((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2);
      mesh.setMatrixAt(k, world.alive[ci] ? m4 : hidden);
      slot[ci] = k;
      meshOf[ci] = mesh;
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    damageAttr.set(mesh, attr);
    group.add(mesh);
  }
  const writeDamage = (i: number, d: number) => {
    if (d <= visualDamage[i]) return;
    visualDamage[i] = d;
    const mesh = meshOf[i];
    const attr = damageAttr.get(mesh)!;
    attr.setX(slot[i], Math.min(1, d));
    attr.needsUpdate = true;
  };

  // ---- floor, yard, ceiling, beams, posts -----------------------------------------------------------------------
  const iw = def.w + WALL_T * 2;
  const id = def.d + WALL_T * 2;
  const floorGeo = keep(new THREE.PlaneGeometry(iw, id).rotateX(-Math.PI / 2));
  const floor = meshAt(floorGeo, floorMat, 0, 0, 0, false);
  floor.name = 'floor';
  group.add(floor);
  const b = world.bounds;
  const yardGeo = keep(new THREE.PlaneGeometry(b.maxX - b.minX + 120, b.maxZ - b.minZ + 120, 1, 1).rotateX(-Math.PI / 2));
  const yard = meshAt(yardGeo, mudMat, 0, -0.01, 0, false);
  group.add(yard);
  for (const s of world.solids) {
    if (s.kind !== 'ceiling' && s.kind !== 'post') continue;
    const g = keep(box(s.max.x - s.min.x, s.max.y - s.min.y, s.max.z - s.min.z));
    group.add(meshAt(g, s.kind === 'ceiling' ? ceilingMat : concrete, (s.min.x + s.max.x) / 2, (s.min.y + s.max.y) / 2, (s.min.z + s.max.z) / 2));
  }
  {
    // Steel I-beams under the ceiling every 3 m, plus a roof slab top so the moon cannot leak through the gaps.
    const parts: THREE.BufferGeometry[] = [];
    const span = def.w + WALL_T * 2;
    for (let z = -def.d / 2 + 1.5; z < def.d / 2 - 0.5; z += 3) {
      // Hung a few centimetres under the slab so the top flange never z-fights with it.
      parts.push(box(span, 0.025, 0.18).translate(0, h - 0.34, z));
      parts.push(box(span, 0.28, 0.014).translate(0, h - 0.19, z));
      parts.push(box(span, 0.025, 0.18).translate(0, h - 0.0525, z));
    }
    if (parts.length) {
      const beams = meshAt(keep(mergeGeometries(parts)), steel, 0, 0, 0);
      group.add(beams);
      for (const p of parts) p.dispose();
    }
  }
  // Skylight frames and a few glass shards left in them.
  const rnd = seeded(def.id.length * 977 + def.w * 13);
  for (const s of def.skylights ?? []) {
    const parts: THREE.BufferGeometry[] = [];
    const t = 0.08;
    parts.push(box(s.w + t * 2, 0.12, t).translate(s.x, h - 0.06, s.z - s.d / 2 - t / 2));
    parts.push(box(s.w + t * 2, 0.12, t).translate(s.x, h - 0.06, s.z + s.d / 2 + t / 2));
    parts.push(box(t, 0.12, s.d).translate(s.x - s.w / 2 - t / 2, h - 0.06, s.z));
    parts.push(box(t, 0.12, s.d).translate(s.x + s.w / 2 + t / 2, h - 0.06, s.z));
    parts.push(box(s.w, 0.05, 0.05).translate(s.x, h + 0.3, s.z));
    parts.push(box(0.05, 0.05, s.d).translate(s.x, h + 0.3, s.z));
    group.add(meshAt(keep(mergeGeometries(parts)), ironMat, 0, 0, 0));
    for (const p of parts) p.dispose();
    for (let k = 0; k < 5; k++) {
      const shard = new THREE.BufferGeometry();
      const ex = s.x + (rnd() - 0.5) * s.w;
      const ez = rnd() < 0.5 ? s.z - s.d / 2 : s.z + s.d / 2;
      const w = 0.2 + rnd() * 0.4;
      shard.setAttribute('position', new THREE.Float32BufferAttribute([ex - w, h + 0.3, ez, ex + w, h + 0.3, ez, ex + (rnd() - 0.5) * w, h + 0.3, ez + (ez < s.z ? 1 : -1) * (0.2 + rnd() * 0.5)], 3));
      shard.computeVertexNormals();
      const m = new THREE.Mesh(keep(shard), glassMat);
      m.userData.noMoonShadow = true;
      group.add(m);
    }
  }

  // ---- windows: frames, boards, glass ---------------------------------------------------------------------------
  const boardMeshes: THREE.Object3D[][] = [];
  const boardHolders: THREE.Group[] = [];
  const nailGeo = keep(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 6).rotateX(Math.PI / 2));
  const frameMat = woodMat;
  for (const w of world.windows) {
    const holder = new THREE.Group();
    // Local frame: x along the wall, y up, z out of the room; origin at the inside face, sill height.
    const out = new THREE.Vector3(w.out.x, 0, w.out.z);
    const along = new THREE.Vector3(-out.z, 0, out.x);
    const basis = new THREE.Matrix4().makeBasis(along, new THREE.Vector3(0, 1, 0), out);
    holder.quaternion.setFromRotationMatrix(basis);
    holder.position.set(w.center.x - out.x * (WALL_T / 2), 0, w.center.z - out.z * (WALL_T / 2));
    group.add(holder);
    boardHolders.push(holder);
    const half = w.width / 2;
    const fparts: THREE.BufferGeometry[] = [];
    fparts.push(box(w.width + 0.24, 0.06, WALL_T + 0.08).translate(0, SILL_Y + 0.03, out.length() * 0 + WALL_T / 2 - 0.02));
    fparts.push(box(0.1, WINDOW_TOP - SILL_Y, 0.08).translate(-half - 0.03, (SILL_Y + WINDOW_TOP) / 2, -0.03));
    fparts.push(box(0.1, WINDOW_TOP - SILL_Y, 0.08).translate(half + 0.03, (SILL_Y + WINDOW_TOP) / 2, -0.03));
    fparts.push(box(w.width + 0.26, 0.1, 0.08).translate(0, WINDOW_TOP + 0.02, -0.03));
    // Outer frame with a muntin cross, mostly glassless.
    fparts.push(box(0.05, WINDOW_TOP - SILL_Y, 0.05).translate(0, (SILL_Y + WINDOW_TOP) / 2, WALL_T - 0.06));
    fparts.push(box(w.width, 0.05, 0.05).translate(0, (SILL_Y + WINDOW_TOP) / 2 + 0.1, WALL_T - 0.06));
    const frame = new THREE.Mesh(keep(mergeGeometries(fparts)), frameMat);
    for (const p of fparts) p.dispose();
    frame.castShadow = true;
    frame.receiveShadow = true;
    holder.add(frame);
    // Broken glass in the corners of the panes.
    const r = seeded(w.i * 7919 + 3);
    for (let k = 0; k < 4; k++) {
      const cx = k % 2 ? half - 0.02 : -half + 0.02;
      const cy = k < 2 ? SILL_Y + 0.03 : WINDOW_TOP - 0.02;
      const sx = k % 2 ? -1 : 1;
      const sy = k < 2 ? 1 : -1;
      const pts = [cx, cy, 0, cx + sx * (0.15 + r() * 0.35), cy, 0, cx, cy + sy * (0.15 + r() * 0.45), 0];
      if (r() < 0.6) pts.push(cx + sx * (0.1 + r() * 0.2), cy + sy * (0.1 + r() * 0.2), 0, cx + sx * (0.2 + r() * 0.3), cy + sy * 0.02, 0, cx + sx * 0.02, cy + sy * (0.2 + r() * 0.3), 0);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      g.translate(0, 0, WALL_T - 0.08);
      g.computeVertexNormals();
      const m = new THREE.Mesh(keep(g), glassMat);
      m.userData.noMoonShadow = true;
      holder.add(m);
    }
    // Six boards nailed across the inside at uneven angles.
    const boards: THREE.Object3D[] = [];
    for (let k = 0; k < ZB.boardsPerWindow; k++) {
      const len = w.width + 0.35 + r() * 0.25;
      const g = box(len, 0.16 + r() * 0.04, 0.035);
      // One plank of the wood texture along the board.
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      const plank = Math.floor(r() * 8);
      const shift = r();
      for (let j = 0; j < uv.count; j++) uv.setXY(j, uv.getX(j) * len * 0.6 + shift, (plank + 0.12 + uv.getY(j) * 0.76) / 8);
      const board = new THREE.Mesh(keep(g), woodMat);
      board.castShadow = true;
      board.receiveShadow = true;
      const y = SILL_Y + 0.18 + k * ((WINDOW_TOP - SILL_Y - 0.3) / (ZB.boardsPerWindow - 1));
      board.position.set((r() - 0.5) * 0.12, y, -0.035 - (k % 2) * 0.035);
      board.rotation.z = (r() - 0.5) * 0.55;
      for (const end of [-1, 1])
        for (const dy of [-0.04, 0.04]) {
          const nail = new THREE.Mesh(nailGeo, ironMat);
          nail.position.set(end * (len / 2 - 0.09), dy, -0.02);
          board.add(nail);
        }
      holder.add(board);
      boards.push(board);
    }
    boardMeshes.push(boards);
  }

  // ---- lockers ------------------------------------------------------------------------------------------------
  const lockerGroups: THREE.Group[] = [];
  const lockerFallbacks: THREE.Object3D[] = [];
  const lockerBody = keep(projMaterial({ set: texSet('metal'), color: 0x6f7a70, env: 1.0 }));
  for (const st of world.stations) {
    const g = new THREE.Group();
    const f = st.facing;
    g.position.set(st.pos.x - f.x * 0.3, 0, st.pos.z - f.z * 0.3);
    g.rotation.y = Math.atan2(-f.x, -f.z);
    group.add(g);
    lockerGroups.push(g);
    // Stand-in cabinet until the model loads: body, door seam, vents.
    const fb = new THREE.Group();
    const body = new THREE.Mesh(keep(box(1, 2, 0.5)), lockerBody);
    body.position.y = 1;
    body.castShadow = body.receiveShadow = true;
    fb.add(body);
    const seam = new THREE.Mesh(keep(box(0.012, 1.9, 0.01)), ironMat);
    seam.position.set(0, 1, -0.255);
    fb.add(seam);
    g.add(fb);
    lockerFallbacks.push(fb);
    const [title, price, accent] = stationText(st);
    const p = plaque([title, price], accent);
    p.position.set(0, 1.78, -0.262);
    p.rotation.y = Math.PI;
    g.add(p);
    disposables.push(p.geometry, p.material as THREE.Material, (p.material as THREE.MeshStandardMaterial).map!);
    // A dim strip light over the plaque (no real light: bloom sells it).
    const strip = new THREE.Mesh(keep(box(0.7, 0.02, 0.03)), keep(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(accent), emissiveIntensity: 2.2 })));
    strip.position.set(0, 1.94, -0.27);
    g.add(strip);
  }

  // ---- lamps --------------------------------------------------------------------------------------------------
  const lamps: (LampLight & { bulb: THREE.MeshStandardMaterial; base: number; flicker: number; seed: number; holder: THREE.Group; fallback: THREE.Object3D; bounce: THREE.PointLight })[] = [];
  const shadeMat = keep(new THREE.MeshStandardMaterial({ color: 0x2f3430, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide }));
  const cableMat = keep(new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.8 }));
  for (const l of world.lamps) {
    const holder = new THREE.Group();
    holder.position.set(l.pos.x, l.pos.y, l.pos.z);
    group.add(holder);
    const cableLen = h - l.pos.y;
    const cable = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.006, 0.006, cableLen, 5)), cableMat);
    cable.position.y = cableLen / 2;
    holder.add(cable);
    const bulb = keep(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: lampColor.clone(), emissiveIntensity: 12 }));
    const fb = new THREE.Group();
    const shade = new THREE.Mesh(keep(new THREE.ConeGeometry(0.26, 0.2, 24, 1, true)), shadeMat);
    shade.position.y = 0.06;
    shade.castShadow = true;
    fb.add(shade);
    const bulbMesh = new THREE.Mesh(keep(new THREE.SphereGeometry(0.045, 12, 8)), bulb);
    bulbMesh.userData.noMoonShadow = true;
    fb.add(bulbMesh);
    holder.add(fb);
    const spot = new THREE.SpotLight(lampColor, 0, 20, 0.95, 0.8, 2);
    spot.position.set(0, -0.02, 0);
    spot.target.position.set(0, -1, 0);
    holder.add(spot, spot.target);
    spot.layers.enableAll();
    spot.shadow.bias = -0.0006;
    spot.shadow.normalBias = 0.025;
    spot.shadow.camera.near = 0.1;
    spot.shadow.camera.far = 14;
    // Light bounced off the floor under the lamp: lifts the walls, pillars and ceiling around the pool.
    const bounce = new THREE.PointLight(lampColor.clone().lerp(new THREE.Color(0x8a7a6a), 0.4), 0, 11, 1.6);
    bounce.position.set(l.pos.x, 0.35, l.pos.z);
    bounce.layers.enableAll();
    group.add(bounce);
    lamps.push({ pos: { ...l.pos }, light: spot, level: 1, color: lampColor.clone(), bulb, base: 150, flicker: l.flicker, seed: lamps.length * 13.7, holder, fallback: fb, bounce });
  }

  // ---- moon, ambient, sky ----------------------------------------------------------------------------------------
  const moonDir = new THREE.Vector3(Math.sin(def.moon.yaw) * Math.cos(def.moon.elev), Math.sin(def.moon.elev), Math.cos(def.moon.yaw) * Math.cos(def.moon.elev)).normalize();
  const moon = new THREE.DirectionalLight(0x8ea6ff, 3);
  moon.position.copy(moonDir).multiplyScalar(70);
  moon.target.position.set(0, 0, 0);
  moon.castShadow = true;
  // The whole map plus its height, seen from a tilted light, needs some margin.
  const ext = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 2;
  const sc = moon.shadow.camera;
  sc.left = -ext;
  sc.right = ext;
  sc.top = ext;
  sc.bottom = -ext;
  sc.near = 10;
  sc.far = 150;
  moon.shadow.bias = -0.0005;
  moon.shadow.normalBias = 0.05;
  moon.layers.enableAll();
  scene.add(moon, moon.target);
  const hemi = new THREE.HemisphereLight(0x223047, 0x2a1d12, 2.5);
  hemi.layers.enableAll();
  scene.add(hemi);

  const skyMat = keep(
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uMoon: { value: moonDir }, uFlash: { value: 0 }, uCity: { value: new THREE.Vector3(-moonDir.x, 0, -moonDir.z).normalize() } },
      vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: /* glsl */ `
uniform vec3 uMoon;
uniform vec3 uCity;
uniform float uFlash;
varying vec3 vDir;
float h(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -0.2, 1.0);
  vec3 col = mix(vec3(0.020, 0.026, 0.040), vec3(0.004, 0.006, 0.012), smoothstep(0.0, 0.7, up));
  col += vec3(0.03, 0.035, 0.04) * (1.0 - smoothstep(-0.05, 0.25, up));
  float m = dot(d, uMoon);
  col += vec3(0.35, 0.42, 0.6) * pow(max(m, 0.0), 40.0) * 0.25 + vec3(0.2, 0.25, 0.4) * pow(max(m, 0.0), 6.0) * 0.06;
  col += vec3(4.0, 4.2, 4.6) * smoothstep(0.99945, 0.9997, m);
  vec3 sp = floor(d * 420.0);
  float s = h(sp);
  col += vec3(0.6, 0.65, 0.8) * step(0.9985, s) * smoothstep(0.05, 0.3, up) * (0.4 + 0.6 * h(sp + 3.0)) * (1.0 - uFlash);
  // A town burning somewhere far off: a dull orange glow low over one horizon.
  vec3 hz = normalize(vec3(d.x, 0.0, d.z) + 1e-5);
  float city = pow(max(dot(hz, uCity), 0.0), 3.0) * (1.0 - smoothstep(-0.02, 0.22, up));
  col += vec3(0.16, 0.06, 0.018) * city;
  // Lightning lights the clouds.
  col += vec3(0.45, 0.5, 0.75) * uFlash * (0.25 + 0.75 * smoothstep(-0.1, 0.6, up));
  gl_FragColor = vec4(col, 1.0);
}`,
    }),
  );
  const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(100, 32, 16)), skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.userData.noMoonShadow = true;
  sky.onBeforeRender = (_r, _s, cam) => sky.position.copy(cam.position);
  scene.add(sky);

  // ---- yard: fence ring and dead trees ---------------------------------------------------------------------------
  const yardGroup = new THREE.Group();
  group.add(yardGroup);
  const fenceSpots: { x: number; z: number; yaw: number }[] = [];
  const step = 2.5;
  const edges: [number, number, number, number, number][] = [
    [b.minX, b.minZ, 1, 0, b.maxX - b.minX],
    [b.maxX, b.minZ, 0, 1, b.maxZ - b.minZ],
    [b.maxX, b.maxZ, -1, 0, b.maxX - b.minX],
    [b.minX, b.maxZ, 0, -1, b.maxZ - b.minZ],
  ];
  for (const [x0, z0, dx, dz, len] of edges)
    for (let a = 0; a < len - 0.1; a += step) fenceSpots.push({ x: x0 + dx * (a + step / 2), z: z0 + dz * (a + step / 2), yaw: Math.atan2(-dx, -dz) + Math.PI / 2 });
  const fenceFallback = new THREE.Group();
  {
    const posts: THREE.BufferGeometry[] = [];
    const wires: THREE.BufferGeometry[] = [];
    for (const s of fenceSpots) {
      const lean = (rnd() - 0.5) * 0.12;
      const p = new THREE.CylinderGeometry(0.05, 0.06, 1.9, 6);
      p.rotateZ(lean);
      p.translate(s.x, 0.95, s.z);
      posts.push(p);
      for (const y of [0.5, 1.0, 1.5]) {
        const w = new THREE.BoxGeometry(step, 0.012, 0.012);
        w.rotateY(s.yaw - Math.PI / 2);
        w.translate(s.x, y + (rnd() - 0.5) * 0.08, s.z);
        wires.push(w);
      }
    }
    const pm = new THREE.Mesh(keep(mergeGeometries(posts)), barkMat);
    pm.castShadow = true;
    fenceFallback.add(pm);
    fenceFallback.add(new THREE.Mesh(keep(mergeGeometries(wires)), ironMat));
    for (const g of [...posts, ...wires]) g.dispose();
  }
  yardGroup.add(fenceFallback);
  // Trees: a few in the yard corners and a ragged line beyond the fence that the fog swallows.
  const treeSpots: { x: number; z: number; s: number; yaw: number }[] = [];
  const hw = def.w / 2;
  const hd = def.d / 2;
  for (let k = 0; k < 4; k++) {
    const sx = k % 2 ? 1 : -1;
    const sz = k < 2 ? 1 : -1;
    treeSpots.push({ x: sx * (hw + 6 + rnd() * 1.5), z: sz * (hd + 6 + rnd() * 1.5), s: 0.9 + rnd() * 0.4, yaw: rnd() * 6.28 });
  }
  for (let k = 0; k < 26; k++) {
    const a = rnd() * Math.PI * 2;
    const rx = (b.maxX - b.minX) / 2 + 3 + rnd() * 16;
    const rz = (b.maxZ - b.minZ) / 2 + 3 + rnd() * 16;
    treeSpots.push({ x: Math.cos(a) * rx, z: Math.sin(a) * rz, s: 0.9 + rnd() * 0.8, yaw: rnd() * 6.28 });
  }
  const treeFallback = new THREE.Group();
  {
    const parts: THREE.BufferGeometry[] = [];
    const branch = (base: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number) => {
      const g = new THREE.CylinderGeometry(r * 0.6, r, len, 5, 1);
      g.translate(0, len / 2, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      g.applyQuaternion(q);
      g.translate(base.x, base.y, base.z);
      parts.push(g);
      if (depth <= 0) return;
      const tip = base.clone().addScaledVector(dir, len);
      const n = depth > 2 ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const nd = dir.clone().add(new THREE.Vector3((rnd() - 0.5) * 1.6, rnd() * 0.5, (rnd() - 0.5) * 1.6)).normalize();
        branch(tip.clone().addScaledVector(dir, -len * rnd() * 0.3), nd, len * (0.55 + rnd() * 0.2), r * 0.55, depth - 1);
      }
    };
    for (const t of treeSpots) branch(new THREE.Vector3(t.x, -0.2, t.z), new THREE.Vector3((rnd() - 0.5) * 0.2, 1, (rnd() - 0.5) * 0.2).normalize(), 2.6 * t.s, 0.16 * t.s, 4);
    const tm = new THREE.Mesh(keep(mergeGeometries(parts)), barkMat);
    tm.castShadow = true;
    treeFallback.add(tm);
    for (const g of parts) g.dispose();
  }
  yardGroup.add(treeFallback);

  // ---- set dressing ----------------------------------------------------------------------------------------------
  const decor = buildDecor(world, { steel, iron: ironMat, wood: woodMat }, quality);
  group.add(decor.group);
  const allLamps: LampLight[] = [...lamps, ...decor.lamps];

  // ---- lightning ---------------------------------------------------------------------------------------------------
  let nextBolt = 20 + rnd() * 25;
  let boltAt = -99;
  let boltPower = 1;
  const PULSES: [number, number, number][] = [
    [0, 0.07, 1],
    [0.13, 0.05, 0.55],
    [0.36, 0.17, 0.9],
  ];

  // ---- reflection environment: a dark room with a few warm and cold glows (post.ts turns it into a PMREM) -------
  const envScene = new THREE.Scene();
  {
    const shell = new THREE.Mesh(new THREE.BoxGeometry(30, 10, 30), new THREE.MeshBasicMaterial({ color: 0x07080a, side: THREE.BackSide }));
    envScene.add(shell);
    const warm = new THREE.MeshBasicMaterial({ color: lampColor.clone().multiplyScalar(3) });
    for (const x of [-6, 0, 6]) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), warm);
      p.position.set(x, 4, x * 0.5);
      envScene.add(p);
    }
    const cold = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3a4a70) });
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), cold);
      p.position.set(Math.sin(a) * 14.5, 2, Math.cos(a) * 14.5);
      p.lookAt(0, 2, 0);
      envScene.add(p);
    }
  }
  group.userData.envScene = envScene;

  // ---- models arrive ---------------------------------------------------------------------------------------------
  let disposed = false;
  models.ready
    .then(() => {
      if (disposed) return;
      // Lockers and what they sell.
      world.stations.forEach((st, i) => {
        try {
          const locker = models.prop('locker');
          locker.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) m.castShadow = m.receiveShadow = true;
          });
          lockerGroups[i].remove(lockerFallbacks[i]);
          lockerGroups[i].add(locker);
        } catch {
          /* keep the stand-in */
        }
        try {
          let item: THREE.Object3D | null = null;
          if (st.kind === 'weapon' && st.item) item = models.weapon(st.item).root;
          else if (st.kind === 'nades') {
            item = new THREE.Group();
            for (let k = 0; k < 4; k++) {
              const n = models.prop('nade');
              n.position.set(-0.27 + k * 0.18, 0, 0);
              item.add(n);
            }
          }
          if (item) {
            // Mounted on the door at chest height, barrel along the wall, slightly tilted.
            item.position.set(0, 1.3, -0.33);
            if (st.kind === 'weapon') {
              item.rotation.set(0, Math.PI / 2, 0.12);
            }
            item.traverse((o) => {
              const m = o as THREE.Mesh;
              if (m.isMesh) m.castShadow = true;
            });
            lockerGroups[i].add(item);
          }
        } catch {
          /* no model for it */
        }
      });
      for (const L of lamps) {
        try {
          const lamp = models.prop('lamp');
          lamp.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            const mat = m.material as THREE.MeshStandardMaterial;
            if (mat.name === 'Bulb') {
              m.material = L.bulb;
              m.userData.noMoonShadow = true;
            } else m.castShadow = true;
          });
          L.holder.remove(L.fallback);
          L.holder.add(lamp);
        } catch {
          /* keep the stand-in */
        }
      }
      for (const [k, w] of world.windows.entries()) {
        try {
          const probe = models.prop('board');
          const bb = new THREE.Box3().setFromObject(probe);
          const size = bb.getSize(new THREE.Vector3());
          if (size.x < 0.3) continue;
          boardMeshes[k].forEach((old, j) => {
            const nb = j === 0 ? probe : models.prop('board');
            nb.position.copy(old.position);
            nb.rotation.copy(old.rotation);
            nb.scale.setScalar((w.width + 0.4) / size.x);
            nb.visible = old.visible;
            nb.traverse((o) => {
              const m = o as THREE.Mesh;
              if (m.isMesh) m.castShadow = m.receiveShadow = true;
            });
            boardHolders[k].remove(old);
            boardHolders[k].add(nb);
            boardMeshes[k][j] = nb;
          });
        } catch {
          /* keep the planks */
        }
      }
      try {
        const fence = new THREE.Group();
        for (const s of fenceSpots) {
          const f = models.prop('fence');
          f.position.set(s.x, 0, s.z);
          f.rotation.y = s.yaw;
          fence.add(f);
        }
        yardGroup.remove(fenceFallback);
        yardGroup.add(fence);
      } catch {
        /* keep the posts */
      }
      try {
        const trees = new THREE.Group();
        for (const t of treeSpots) {
          const tr = models.prop('tree');
          tr.position.set(t.x, 0, t.z);
          tr.rotation.y = t.yaw;
          tr.scale.setScalar(t.s);
          tr.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) m.castShadow = true;
          });
          trees.add(tr);
        }
        yardGroup.remove(treeFallback);
        yardGroup.add(trees);
      } catch {
        /* keep the procedural trees */
      }
    })
    .catch(() => {
      /* models failed: the stand-ins stay */
    });

  // ---- quality ------------------------------------------------------------------------------------------------------
  const applyQuality = (q: Quality) => {
    const spec = QUALITY_SPEC[q];
    lamps.forEach((L, i) => {
      L.light.castShadow = i < spec.lampShadows;
      if (L.light.shadow.mapSize.x !== spec.lampMap) {
        L.light.shadow.mapSize.set(spec.lampMap, spec.lampMap);
        L.light.shadow.map?.dispose();
        L.light.shadow.map = null;
      }
      L.light.userData.shadowCaster = i < spec.lampShadows;
    });
    if (moon.shadow.mapSize.x !== spec.moonMap) {
      moon.shadow.mapSize.set(spec.moonMap, spec.moonMap);
      moon.shadow.map?.dispose();
      moon.shadow.map = null;
    }
    moon.userData.shadowCaster = true;
  };
  applyQuality(quality);

  // ---- the interface ------------------------------------------------------------------------------------------------
  const view: WorldViewExt = {
    group,
    lamps: allLamps,
    moonDir,
    moon,
    glows: decor.glows,
    floorSet,
    floorMeters: floorSet.meters,
    yardSet,
    dust: def.id === 'chapel' ? 1.7 : 1,
    lightning: 0,
    setChunkHp(i, hp) {
      const c = world.chunks[i];
      if (!c || c.hard || !meshOf[i]) return;
      writeDamage(i, 1 - Math.max(0, hp) / c.maxHp);
    },
    breakChunk(i) {
      const mesh = meshOf[i];
      if (!mesh) return;
      mesh.setMatrixAt(slot[i], hidden);
      mesh.instanceMatrix.needsUpdate = true;
      decor.breakChunk(i);
      // The neighbours look chipped where it tore away.
      for (const j of world.chunks[i].nb) if (world.alive[j] !== 0 && !world.chunks[j].hard) writeDamage(j, Math.max(visualDamage[j], 0.3 + visualDamage[j] * 0.5));
    },
    setBoards(window, n) {
      const list = boardMeshes[window];
      if (!list) return;
      list.forEach((m, k) => (m.visible = k < n));
    },
    update(dt, time) {
      for (const L of lamps) {
        let level = 1;
        if (L.flicker > 0) {
          const t = time * 7 + L.seed;
          // Mostly steady, with nervous dips and now and then a dead second.
          const n = Math.sin(t * 1.7) * Math.sin(t * 2.9 + 1.3) * Math.sin(t * 0.37);
          const buzz = 0.5 + 0.5 * Math.sin(time * 120 + L.seed);
          if (n > 0.55 - L.flicker * 0.2) level = 0.05 + 0.15 * buzz;
          else if (n > 0.3) level = 0.6 + 0.4 * buzz;
          const off = Math.sin(time * 0.21 + L.seed * 3) > 0.985 - L.flicker * 0.02;
          if (off) level = 0.02;
        } else level = 0.96 + 0.04 * Math.sin(time * 3.1 + L.seed);
        L.level = level;
        L.light.intensity = L.base * level;
        L.bounce.intensity = 12 * level;
        L.bulb.emissiveIntensity = 12 * level + 0.2;
        // A slow sway on the cable.
        L.holder.rotation.z = Math.sin(time * 0.6 + L.seed) * 0.012;
        L.holder.rotation.x = Math.sin(time * 0.47 + L.seed * 2) * 0.012;
      }
      decor.update(dt, time);
      // Lightning: a stutter of flashes through the windows every minute or so.
      if (time > nextBolt) {
        boltAt = time;
        boltPower = 0.6 + rnd() * 0.4;
        nextBolt = time + 40 + Math.random() * 50;
        view.onLightning?.(boltPower);
      }
      let flash = 0;
      for (const [at, len, amp] of PULSES) {
        const t = time - boltAt - at;
        if (t >= 0 && t < len + 0.25) flash = Math.max(flash, amp * (t < len ? 1 : Math.exp(-(t - len) * 14)));
      }
      flash *= boltPower;
      view.lightning = flash;
      moon.intensity = 3 * (1 + flash * 7);
      hemi.intensity = 2.5 * (1 + flash * 1.2);
      skyMat.uniforms.uFlash.value = flash;
    },
    setQuality(q) {
      applyQuality(q);
      decor.setQuality(q);
    },
    dispose() {
      disposed = true;
      decor.dispose();
      scene.remove(group, moon, moon.target, hemi, sky);
      moon.shadow.map?.dispose();
      for (const L of lamps) L.light.shadow.map?.dispose();
      for (const d of disposables) d.dispose();
      envScene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
      });
    },
  };
  return view;
};

export type { Glow };
