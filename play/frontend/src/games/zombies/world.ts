// The hotel lobby as the player sees it. Chunk walls and props are one InstancedMesh per material with world-space
// box-projected PBR textures (travertine runs on across chunks, the marble floor across the whole room) and per-instance
// damage that grows cracks; glass chunks are a clear instanced material that crazes as it takes damage. Around them:
// the polished marble floor, a coffered ceiling, brass mullions, security shutters on locked wings, barricaded doors,
// lockers, brass pendant lamps, and outside a sunlit plaza with trees and city blocks under a golden-hour sky. The low
// sun (a shadow-casting DirectionalLight) pours through the glass facade. Furniture, the mezzanine galleries and the
// smaller dressing live in decor.ts. Models from models.ts replace the primitive stand-ins as soon as they load.
//
// post.ts reads `group.userData.envScene` (a warm lobby-like scene it turns into the reflection environment) and skips
// objects with `userData.noMoonShadow` in its own sun depth map. The `moon` / `moonDir` fields of the contract are the
// sun here.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ZB } from '@shared/zombies/constants';
import type { Mat } from '@shared/zombies/maps';
import { WEAPONS } from '@shared/zombies/weapons';
import { ARMOR_PRICE, NADE_PRICE } from '@shared/zombies/weapons';
import { type StationInfo, type World, SILL_Y, WALL_T, WINDOW_TOP } from '@shared/zombies/world';
import type { CreateWorldView, LampLight, Models, Quality, WorldView } from './api';
import { type Glow, buildDecor, mergeStatic } from './decor';
import { buildMotes } from './motes';
import { buildSkyline } from './skyline';
import { DEFAULT_SIZE, type SetName, type TexSet, texSet as rawTexSet } from './textures';

/** A street lamp outside: lights the plaza and throws shafts through the glass into the lobby. */
export interface StreetLight {
  /** Lamp head (light origin), world space. */
  pos: THREE.Vector3;
  /** Unit cone axis. */
  dir: THREE.Vector3;
  /** Linear colour; post.ts scales it by `level` and its own gain. */
  color: THREE.Color;
  /** cos of the outer / inner cone half-angles. */
  cosOuter: number;
  cosInner: number;
  /** Cone reach in metres. */
  range: number;
  /** The surface light. */
  light: THREE.SpotLight;
  /** Brightness 0..1 after flicker, updated every frame. */
  level: number;
  /** post.ts renders a shadow map for this one and draws shadowed shafts in the fog (only a few lamps). */
  shafts: boolean;
}

/** What post.ts reads beyond the WorldView contract. */
export interface WorldViewExt extends WorldView {
  /** Street lamps outside, the ones with `shafts` first. */
  streetLights: StreetLight[];
  /** Point glows for the fog (lamps, sconces). */
  glows: Glow[];
  /** Floor and outside texture sets: their roughness masks the floor reflections. */
  floorSet: TexSet;
  floorMeters: number;
  yardSet: TexSet;
  /** Dust in the air (sun shafts), 1 = normal. */
  dust: number;
  /** Kept for the contract: there is no lightning in the hotel. */
  lightning: number;
  onLightning?: (strength: number) => void;
}

/** Texture set per chunk material. Legacy materials map onto the hotel's, so any map dresses up as the lobby. */
const MAT_SET: Record<string, SetName> = {
  brick: 'travertine',
  plaster: 'travertine',
  concrete: 'travertine',
  wood: 'walnut',
  metal: 'brass',
  marble: 'marbleSlab',
  travertine: 'travertine',
  walnut: 'walnut',
};
const SUN_COLOR = new THREE.Color(1.0, 0.8, 0.56);

/** Shadow-casting lamps and shadow map sizes per quality. */
const QUALITY_SPEC: Record<Quality, { lampShadows: number; lampMap: number; sunMap: number; texScale: number }> = {
  low: { lampShadows: 0, lampMap: 512, sunMap: 2048, texScale: 0.5 },
  medium: { lampShadows: 1, lampMap: 512, sunMap: 4096, texScale: 1 },
  high: { lampShadows: 2, lampMap: 1024, sunMap: 4096, texScale: 1 },
};

// ---- box-projected material -----------------------------------------------------------------------------------------

interface ProjOpts {
  set: TexSet;
  color?: number;
  instanced?: boolean;
  /** Per-instance `aDamage` attribute drives cracks. */
  damage?: boolean;
  /** Metal: damage dents instead of cracking. */
  dents?: boolean;
  /** Large-scale tone variation and a little dirt at the foot of walls. */
  grime?: boolean;
  env?: number;
  normalScale?: number;
  /** Multiplies the texture's roughness. */
  rough?: number;
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

/** World-space UVs for the given vertex: one projection per dominant normal axis. */
const PROJ_VERTEX = (damage: boolean) => /* glsl */ `#include <fog_vertex>
{
  mat4 zm = modelMatrix;
  #ifdef USE_INSTANCING
  zm = modelMatrix * instanceMatrix;
  #endif
  vec4 zw = zm * vec4(position, 1.0);
  vec3 zn = normalize(mat3(zm) * normal);
  vZPos = zw.xyz;
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
  ${damage ? 'vZDamage = aDamage;' : ''}
}`;

function projMaterial(o: ProjOpts): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: o.set.map,
    normalMap: o.set.normalMap,
    roughnessMap: o.set.orm,
    metalnessMap: o.set.orm,
    roughness: o.rough ?? 1,
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
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTexScale;
varying vec3 vZPos;
varying vec2 vZUv;
${o.damage ? 'attribute float aDamage; varying float vZDamage;' : ''}`,
      )
      .replace('#include <fog_vertex>', PROJ_VERTEX(!!o.damage));
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vZPos;
varying vec2 vZUv;
${o.damage ? 'varying float vZDamage;' : ''}
${NOISE_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
float zCrack = 0.0;
${
  o.grime
    ? `diffuseColor.rgb *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.5, vZPos.y)) * (0.6 + 0.4 * zNoise(vZUv * 3.0));
  diffuseColor.rgb *= 0.9 + 0.2 * zFbm(vZUv * 0.35 + vZPos.y * 0.05);`
    : `diffuseColor.rgb *= 0.94 + 0.12 * zFbm(vZUv * 0.4);`
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
  diffuseColor.rgb *= 1.0 - 0.8 * zCrack;
  diffuseColor.rgb *= 1.0 - 0.25 * zd * zFbm(vZUv * 6.0);
  // Chipped stone shows its paler, dusty core.
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.58, 0.52) * (0.6 + 0.4 * zNoise(vZUv * 17.0)), zd * 0.3 * smoothstep(0.5, 0.8, zNoise(vZUv * 4.0 + 3.0)));
}`
    : ''
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 1.0, zCrack);`,
      );
  };
  m.customProgramCacheKey = () => `zproj-${o.damage ? 1 : 0}${o.grime ? 1 : 0}${o.instanced ? 1 : 0}${o.dents ? 1 : 0}`;
  return m;
}

/** Instanced glass: clear, reflective, a faint green edge tint; damage crazes it white and makes it less clear. */
function glassMaterial(): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xcfe0da,
    roughness: 0.03,
    metalness: 0,
    transparent: true,
    opacity: 0.16,
    envMapIntensity: 1.8,
    depthWrite: false,
    side: THREE.DoubleSide,
    specularIntensity: 1,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTexScale = { value: 1 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTexScale;\nvarying vec3 vZPos;\nvarying vec2 vZUv;\nattribute float aDamage; varying float vZDamage;`)
      .replace('#include <fog_vertex>', PROJ_VERTEX(true));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vZPos;\nvarying vec2 vZUv;\nvarying float vZDamage;\n${NOISE_GLSL}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
// A faint smudge layer keeps the glass readable as a surface.
diffuseColor.a *= 0.75 + 0.5 * zFbm(vZUv * 1.3);
if (vZDamage > 0.001) {
  float zd = vZDamage;
  float web = 1.0 - smoothstep(0.0, 0.02 + 0.03 * zd, zCellEdge(vZUv * 4.0 + zFbm(vZUv * 3.0)));
  float fine = 1.0 - smoothstep(0.0, 0.02, zCellEdge(vZUv * 13.0));
  float mask = smoothstep(1.0 - zd * 1.3, 1.2 - zd * 1.3, zFbm(vZUv * 1.7 + 5.0));
  float c = max(web, fine * zd) * mask;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92), c);
  diffuseColor.a = mix(diffuseColor.a, 0.75, c);
  diffuseColor.a += zd * 0.15;
}`,
      );
  };
  m.customProgramCacheKey = () => 'zglass';
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

/** A brass-framed price plaque for a locker. */
function plaque(lines: string[], accent: string): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 160);
  grad.addColorStop(0, '#1b1916');
  grad.addColorStop(1, '#0f0e0c');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 160);
  g.strokeStyle = '#b8924e';
  g.lineWidth = 6;
  g.strokeRect(5, 5, 502, 150);
  g.textAlign = 'center';
  g.fillStyle = accent;
  g.font = '700 50px "Space Grotesk", Impact, sans-serif';
  g.fillText(lines[0], 256, 70);
  g.fillStyle = '#e9d8b0';
  g.font = '600 38px "JetBrains Mono", monospace';
  g.fillText(lines[1] ?? '', 256, 126);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.45, metalness: 0.2 });
  return new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.24), mat);
}

function stationText(st: StationInfo): [string, string, string] {
  switch (st.kind) {
    case 'weapon': {
      const w = WEAPONS[st.item!];
      return [w.name.toUpperCase(), `${w.price}  ·  AMMO ${w.ammoPrice}`, w.era === 'modern' ? '#a9d8ff' : '#ffd48a'];
    }
    case 'ammo':
      return ['AMMO CACHE', 'REFILL ALL', '#b8ffaa'];
    case 'nades':
      return ['FRAG GRENADES', `${NADE_PRICE}`, '#ffbf80'];
    case 'armor':
      return ['BODY ARMOR', `${ARMOR_PRICE}`, '#d4c6ff'];
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
  const lampColor = new THREE.Color(def.lampColor ?? 0xffc078);
  // Low quality builds half-resolution textures (four times faster to generate, a quarter of the memory).
  const texSet = (n: SetName) => rawTexSet(n, Math.round(DEFAULT_SIZE(n) * QUALITY_SPEC[quality].texScale));
  const rnd = seeded(def.id.length * 977 + def.w * 13);

  // Extent of the building (the chunk walls), for the floor, the ceiling cover and the sun's shadow box.
  const ext = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const c of world.chunks) {
    ext.minX = Math.min(ext.minX, c.min.x);
    ext.maxX = Math.max(ext.maxX, c.max.x);
    ext.minZ = Math.min(ext.minZ, c.min.z);
    ext.maxZ = Math.max(ext.maxZ, c.max.z);
  }
  if (!Number.isFinite(ext.minX)) Object.assign(ext, world.interior);

  // ---- materials ------------------------------------------------------------------------------------------------
  const chunkMats = new Map<string, THREE.Material>();
  const glass = keep(glassMaterial());
  const chunkMat = (m: Mat | string) => {
    let mat = chunkMats.get(m);
    if (!mat) {
      if (m === 'glass') mat = glass;
      else {
        const set = MAT_SET[m] ?? 'travertine';
        mat = keep(
          projMaterial({
            set: texSet(set),
            instanced: true,
            damage: true,
            dents: set === 'brass',
            grime: set === 'travertine',
            env: set === 'brass' ? 1.2 : set === 'marbleSlab' ? 1.1 : set === 'walnut' ? 0.8 : 0.45,
          }),
        );
      }
      chunkMats.set(m, mat);
    }
    return mat;
  };
  const floorSet = texSet('marbleFloor');
  const yardSet = texSet('plaza');
  const travSet = texSet('travertine');
  const brassSet = texSet('brass');
  const floorMat = keep(projMaterial({ set: floorSet, env: 1.25 }));
  const plazaMat = keep(projMaterial({ set: yardSet, env: 0.5 }));
  const travMat = keep(projMaterial({ set: travSet, env: 0.45, grime: true }));
  const ceilingMat = keep(projMaterial({ set: travSet, color: 0xf2eadc, env: 0.25, normalScale: 0.4 }));
  // Light bouncing off the floor and walls keeps the coffers from going black.
  ceilingMat.emissive.set(0x3a2a18);
  ceilingMat.emissiveIntensity = 0.6;
  const brass = keep(projMaterial({ set: brassSet, env: 1.3 }));
  const steel = keep(new THREE.MeshStandardMaterial({ color: 0x8c8f92, roughness: 0.38, metalness: 0.9, envMapIntensity: 1 }));
  const darkSteel = keep(new THREE.MeshStandardMaterial({ color: 0x2c2d2f, roughness: 0.45, metalness: 0.8 }));
  const plyMat = (() => {
    const s = texSet('wood');
    const m = keep(new THREE.MeshStandardMaterial({ map: s.map, normalMap: s.normalMap, roughnessMap: s.orm, roughness: 1, metalness: 0, color: 0xd8c2a0, envMapIntensity: 0.3 }));
    s.onUpgrade((st) => {
      m.map = st.map;
      m.normalMap = st.normalMap;
      m.roughnessMap = st.orm;
    });
    return m;
  })();
  const nailMat = keep(new THREE.MeshStandardMaterial({ color: 0x3a3632, roughness: 0.5, metalness: 0.85 }));

  // ---- chunks ------------------------------------------------------------------------------------------------
  // What a chunk looks like. Gameplay keeps its material (health); the lower atrium walls are dressed in walnut
  // panelling, the wall behind reception in black marble, the lounge in walnut.
  const looks = (c: (typeof world.chunks)[number]): string => {
    if (c.mat === 'glass' || !c.wall) return c.mat;
    const part = (c as { part?: string }).part ?? '';
    const cz = (c.min.z + c.max.z) / 2;
    if (part === 'atriumWest' && c.max.y <= 5.4 && cz > -11.5 && cz < 3.5) return 'marble';
    if ((part === 'atriumWest' || part === 'atriumEast') && c.max.y <= 4.6) return 'walnut';
    if (part === 'south' && c.max.y <= 3.6) return 'walnut';
    if (part.startsWith('lounge') && c.max.y <= 3.1) return 'walnut';
    return c.mat;
  };
  const byMat = new Map<string, number[]>();
  world.chunks.forEach((c, i) => {
    const key = looks(c);
    const list = byMat.get(key) ?? [];
    list.push(i);
    byMat.set(key, list);
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
    const isGlass = mat === 'glass';
    mesh.castShadow = !isGlass;
    mesh.receiveShadow = !isGlass;
    if (isGlass) {
      mesh.userData.noMoonShadow = true;
      mesh.renderOrder = 2;
    }
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

  // ---- floor, plaza, solids ---------------------------------------------------------------------------------------
  {
    // One marble floor plate per zone and per passage between them (no marble out on the plaza).
    const rects: { minX: number; maxX: number; minZ: number; maxZ: number }[] = world.zones?.length ? world.zones.map((z) => z.rect) : [world.interior];
    for (const z of world.zones ?? []) if (z.passage) rects.push({ minX: z.passage.min.x - 0.6, maxX: z.passage.max.x + 0.6, minZ: z.passage.min.z, maxZ: z.passage.max.z });
    const plates = rects.map((r) => new THREE.PlaneGeometry(r.maxX - r.minX + 0.02, r.maxZ - r.minZ + 0.02).rotateX(-Math.PI / 2).translate((r.minX + r.maxX) / 2, 0, (r.minZ + r.maxZ) / 2));
    const floor = meshAt(keep(mergeGeometries(plates)), floorMat, 0, 0, 0, false);
    for (const g of plates) g.dispose();
    floor.name = 'floor';
    group.add(floor);
    // The plaza runs out under the city backdrop; a hole would show under the building, so it simply sits lower.
    const plaza = meshAt(keep(new THREE.PlaneGeometry(260, 260).rotateX(-Math.PI / 2)), plazaMat, 0, -0.012, 0, false);
    plaza.name = 'plaza';
    group.add(plaza);
  }
  const shutters: THREE.Object3D[] = [];
  for (const s of world.solids) {
    const kind = s.kind as string;
    const sx = s.max.x - s.min.x;
    const sy = s.max.y - s.min.y;
    const sz = s.max.z - s.min.z;
    const cx = (s.min.x + s.max.x) / 2;
    const cy = (s.min.y + s.max.y) / 2;
    const cz = (s.min.z + s.max.z) / 2;
    if (kind === 'ceiling') group.add(meshAt(keep(box(sx, sy, sz)), ceilingMat, cx, cy, cz));
    else if (kind === 'post' || kind === 'sill' || kind === 'column') group.add(meshAt(keep(box(sx, sy, sz)), travMat, cx, cy, cz));
    else if (kind === 'mullion' || kind === 'frame' || kind === 'rail') group.add(meshAt(keep(box(sx, sy, sz)), brass, cx, cy, cz));
    else if (kind === 'shutter') {
      // A rolled-down security shutter: slats in a steel frame with a brass head box.
      const g = new THREE.Group();
      g.position.set(cx, s.min.y, cz);
      const along = sx >= sz ? 'x' : 'z';
      const width = along === 'x' ? sx : sz;
      const depth = Math.max(0.06, Math.min(sx, sz));
      const parts: THREE.BufferGeometry[] = [];
      for (let y = 0.04; y < sy - 0.35; y += 0.11) {
        const sl = box(along === 'x' ? width - 0.12 : depth * 0.5, 0.085, along === 'x' ? depth * 0.5 : width - 0.12);
        sl.translate(0, y + 0.04, 0);
        parts.push(sl);
      }
      const slats = new THREE.Mesh(keep(mergeGeometries(parts)), steel);
      for (const p of parts) p.dispose();
      slats.castShadow = slats.receiveShadow = true;
      g.add(slats);
      const head = new THREE.Mesh(keep(box(along === 'x' ? width : depth * 1.6, 0.35, along === 'x' ? depth * 1.6 : width)), brass);
      head.position.y = sy - 0.17;
      head.castShadow = true;
      g.add(head);
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(keep(box(along === 'x' ? 0.08 : depth, sy, along === 'x' ? depth : 0.08)), darkSteel);
        rail.position.set(along === 'x' ? (side * width) / 2 : 0, sy / 2, along === 'x' ? 0 : (side * width) / 2);
        g.add(rail);
      }
      group.add(g);
      shutters.push(g);
      g.userData.size = { width, height: sy, alongX: along === 'x' };
    }
    // floor, bound, clip, locker: nothing to draw (lockers get their own models).
  }

  // Open wings: the shutter is rolled up into its brass head box over the passage.
  for (const z of world.zones ?? []) {
    if (!z.open || !z.passage) continue;
    const p = z.passage;
    const sx = p.max.x - p.min.x;
    const sz = p.max.z - p.min.z;
    const head = meshAt(keep(box(Math.max(sx, 0.3), 0.35, Math.max(sz, 0.3))), brass, (p.min.x + p.max.x) / 2, p.max.y - 0.17, (p.min.z + p.max.z) / 2);
    group.add(head);
  }

  // ---- doors and windows: frames and plywood boards ----------------------------------------------------------------
  const boardMeshes: THREE.Object3D[][] = [];
  const boardHolders: THREE.Group[] = [];
  const nailGeo = keep(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 6).rotateX(Math.PI / 2));
  for (const w of world.windows) {
    const holder = new THREE.Group();
    // Local frame: x along the wall, y up, z out of the room; origin at the inside face, floor height.
    const out = new THREE.Vector3(w.out.x, 0, w.out.z);
    const along = new THREE.Vector3(-out.z, 0, out.x);
    holder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(along, new THREE.Vector3(0, 1, 0), out));
    holder.position.set(w.center.x - out.x * (WALL_T / 2), 0, w.center.z - out.z * (WALL_T / 2));
    group.add(holder);
    boardHolders.push(holder);
    holder.userData.noMerge = true;
    const half = w.width / 2;
    const sill = w.center.y ?? SILL_Y;
    const top = (w as { top?: number }).top ?? WINDOW_TOP;
    // Brass frame around the opening.
    const fparts: THREE.BufferGeometry[] = [];
    fparts.push(box(0.07, top - sill + 0.1, 0.1).translate(-half - 0.035, (sill + top) / 2, WALL_T / 2));
    fparts.push(box(0.07, top - sill + 0.1, 0.1).translate(half + 0.035, (sill + top) / 2, WALL_T / 2));
    fparts.push(box(w.width + 0.14, 0.07, 0.1).translate(0, top + 0.035, WALL_T / 2));
    if (sill > 0.05) fparts.push(box(w.width + 0.14, 0.05, WALL_T + 0.06).translate(0, sill + 0.025, WALL_T / 2));
    const frame = new THREE.Mesh(keep(mergeGeometries(fparts)), brass);
    for (const p of fparts) p.dispose();
    frame.castShadow = frame.receiveShadow = true;
    holder.add(frame);
    // Six plywood planks and boards nailed across the inside at uneven angles.
    const r = seeded(w.i * 7919 + 3);
    const boards: THREE.Object3D[] = [];
    for (let k = 0; k < ZB.boardsPerWindow; k++) {
      const len = w.width + 0.35 + r() * 0.25;
      const g = box(len, 0.18 + r() * 0.05, 0.03);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      const plank = Math.floor(r() * 8);
      const shift = r();
      for (let j = 0; j < uv.count; j++) uv.setXY(j, uv.getX(j) * len * 0.6 + shift, (plank + 0.12 + uv.getY(j) * 0.76) / 8);
      const board = new THREE.Mesh(keep(g), plyMat);
      board.castShadow = board.receiveShadow = true;
      const y = sill + 0.25 + k * ((top - sill - 0.5) / (ZB.boardsPerWindow - 1));
      board.position.set((r() - 0.5) * 0.12, y, -0.035 - (k % 2) * 0.03);
      board.rotation.z = (r() - 0.5) * 0.5;
      for (const end of [-1, 1])
        for (const dy of [-0.045, 0.045]) {
          const nail = new THREE.Mesh(nailGeo, nailMat);
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
  const lockerBody = keep(new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.45, metalness: 0.7 }));
  for (const st of world.stations) {
    const g = new THREE.Group();
    const f = st.facing;
    g.position.set(st.pos.x - f.x * 0.3, 0, st.pos.z - f.z * 0.3);
    g.rotation.y = Math.atan2(-f.x, -f.z);
    group.add(g);
    lockerGroups.push(g);
    const fb = new THREE.Group();
    const body = new THREE.Mesh(keep(box(1, 2, 0.5)), lockerBody);
    body.position.y = 1;
    body.castShadow = body.receiveShadow = true;
    fb.add(body);
    g.add(fb);
    lockerFallbacks.push(fb);
    const [title, price, accent] = stationText(st);
    const p = plaque([title, price], accent);
    p.position.set(0, 1.78, -0.262);
    p.rotation.y = Math.PI;
    g.add(p);
    disposables.push(p.geometry, p.material as THREE.Material, (p.material as THREE.MeshStandardMaterial).map!);
  }

  // ---- pendant lamps (the map's lamps) -------------------------------------------------------------------------
  type Lamp = LampLight & { bulb: THREE.MeshStandardMaterial; base: number; flicker: number; seed: number; holder: THREE.Group; fallback: THREE.Object3D; pendant: boolean };
  const lamps: Lamp[] = [];
  for (const l of world.lamps) {
    const holder = new THREE.Group();
    const zone = world.zones?.find((z) => z.id === l.zone);
    const ceil = zone?.h ?? h;
    const chandelier = l.kind === 'chandelier';
    const y = Math.min(l.pos.y, ceil - 0.8);
    holder.position.set(l.pos.x, y, l.pos.z);
    group.add(holder);
    const bulb = keep(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: lampColor.clone(), emissiveIntensity: 9 }));
    const fb = new THREE.Group();
    // A cluster of brass rods of different lengths, each ending in a glowing glass cylinder.
    const rod = keep(new THREE.CylinderGeometry(0.012, 0.012, 1, 6));
    const tube = keep(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 12));
    // Chandeliers: a wide ring of brass rods with glowing glass tubes at staggered heights; pendants: a small cluster.
    const r = seeded(lamps.length * 31 + 7);
    const count = chandelier ? 36 : 7;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + r() * 0.3;
      const rr = chandelier ? 0.6 + (k % 3) * 0.45 + r() * 0.15 : 0.18 + r() * 0.22;
      const len = ceil - y + (chandelier ? 0.4 + r() * 1.8 : 0.3 + r() * 1.2);
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const drop = chandelier ? r() * 2.2 : r() * 1.2;
      const rm = new THREE.Mesh(rod, brass);
      rm.scale.y = len - drop;
      rm.position.set(x, drop + (len - drop) / 2, z);
      fb.add(rm);
      const t = new THREE.Mesh(tube, bulb);
      t.position.set(x, drop - 0.1, z);
      t.userData.noMoonShadow = true;
      fb.add(t);
    }
    holder.add(fb);
    const spot = new THREE.SpotLight(lampColor, 0, chandelier ? 22 : 12, chandelier ? 1.0 : 0.85, 0.85, 2);
    spot.position.set(0, -0.3, 0);
    spot.target.position.set(0, -1, 0);
    holder.add(spot, spot.target);
    spot.layers.enableAll();
    spot.shadow.bias = -0.0006;
    spot.shadow.normalBias = 0.025;
    spot.shadow.camera.near = 0.2;
    spot.shadow.camera.far = 14;
    // Lamps in a closed wing burn low: the wing is seen only through the shutter slats.
    const lit = !zone || zone.open ? 1 : 0.12;
    lamps.push({ pos: { x: l.pos.x, y: y - 0.3, z: l.pos.z }, light: spot, level: 1, color: lampColor.clone(), bulb, base: (chandelier ? 220 : 70) * lit, flicker: l.flicker * 0.3, seed: lamps.length * 13.7, holder, fallback: fb, pendant: !chandelier });
  }

  // ---- the sun, sky light, sky ---------------------------------------------------------------------------------
  // Golden hour: low in the north-north-east, so it streams through the facade (z = min) deep into the lobby.
  const sunYaw = def.moon?.yaw ?? 0.35;
  const sunElev = Math.min(0.5, Math.max(0.24, def.moon?.elev ?? 0.32));
  const facadeZ = ext.minZ;
  const moonDir = new THREE.Vector3(Math.sin(sunYaw) * Math.cos(sunElev), Math.sin(sunElev), -Math.cos(sunYaw) * Math.cos(sunElev)).normalize();
  const moon = new THREE.DirectionalLight(SUN_COLOR, 4.6);
  moon.position.copy(moonDir).multiplyScalar(80);
  moon.target.position.set((ext.minX + ext.maxX) / 2, 0, (ext.minZ + ext.maxZ) / 2);
  moon.position.add(moon.target.position);
  moon.castShadow = true;
  {
    const half = Math.max(ext.maxX - ext.minX, ext.maxZ - ext.minZ) / 2 + 6;
    const sc = moon.shadow.camera;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.near = 20;
    sc.far = 170;
  }
  moon.shadow.bias = -0.0003;
  moon.shadow.normalBias = 0.04;
  moon.layers.enableAll();
  scene.add(moon, moon.target);
  // Warm skylight from above, warm bounce from the floor: shadows stay golden-brown and readable.
  const hemi = new THREE.HemisphereLight(0xffe3c0, 0xa07a52, 1.35);
  hemi.layers.enableAll();
  scene.add(hemi);

  const skyMat = keep(
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uSun: { value: moonDir } },
      vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: /* glsl */ `
uniform vec3 uSun;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -0.2, 1.0);
  // Golden horizon fading into a pale blue zenith.
  vec3 col = mix(vec3(1.25, 0.95, 0.65), vec3(0.36, 0.56, 0.92), smoothstep(-0.02, 0.45, up));
  col = mix(col, vec3(0.9, 0.75, 0.6), 1.0 - smoothstep(-0.2, 0.02, up));
  float s = max(dot(d, uSun), 0.0);
  col += vec3(2.4, 1.6, 0.8) * pow(s, 8.0) * 0.6 + vec3(3.0, 2.2, 1.3) * pow(s, 64.0);
  col += vec3(40.0, 32.0, 22.0) * smoothstep(0.9993, 0.9996, s);
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

  // ---- outside: the city (skyline.ts), street lamps, street trees ----------------------------------------------
  const outside = new THREE.Group();
  group.add(outside);
  const skyline = buildSkyline({ facadeZ, ext, quality });
  outside.add(skyline.group);
  const streetLights: StreetLight[] = [];
  // Sodium street lights across the plaza, aimed back at the glass so their light falls into the lobby.
  for (const [x, shafts] of [
    [-7.5, true],
    [1.5, true],
    [9, true],
    [-17, false],
    [17, false],
  ] as const) {
    const pos = new THREE.Vector3(x, 6.8, facadeZ - 7);
    const aim = new THREE.Vector3(x * 0.6, 0, facadeZ + 9);
    const dir = aim.clone().sub(pos).normalize();
    const outer = 0.95;
    const inner = 0.45;
    const range = 40;
    const color = new THREE.Color(1.0, 0.62, 0.3);
    const light = new THREE.SpotLight(color, 900, range, outer, 1 - inner / outer, 2);
    light.position.copy(pos);
    light.target.position.copy(aim);
    light.layers.enableAll();
    scene.add(light, light.target);
    streetLights.push({ pos, dir, color, cosOuter: Math.cos(outer), cosInner: Math.cos(inner), range, light, level: 1, shafts });
  }
  const motes = buildMotes({ interior: world.interior, ceiling: h, streetLights, quality });
  group.add(motes.group);
  // Street trees in front of the facade and along the sides: canopies of leaf cards that throw dappled shadows.
  const treeSpots: { x: number; z: number; s: number; yaw: number }[] = [];
  for (let x = ext.minX - 4; x <= ext.maxX + 4; x += 6.5 + rnd() * 2) treeSpots.push({ x: x + (rnd() - 0.5), z: facadeZ - 6 - rnd() * 3, s: 0.9 + rnd() * 0.35, yaw: rnd() * 6.28 });
  for (let x = ext.minX + 2; x <= ext.maxX - 2; x += 9 + rnd() * 3) treeSpots.push({ x, z: facadeZ - 16 - rnd() * 4, s: 1 + rnd() * 0.4, yaw: rnd() * 6.28 });
  const leafTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const lr = seeded(77);
    for (let k = 0; k < 160; k++) {
      const x = lr() * 256;
      const y = lr() * 256;
      const a = lr() * Math.PI * 2;
      const len = 10 + lr() * 14;
      const hue = 78 + lr() * 34;
      g.fillStyle = `hsl(${hue}, ${45 + lr() * 25}%, ${18 + lr() * 20}%)`;
      g.beginPath();
      g.ellipse(x, y, len, len * 0.42, a, 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return keep(t);
  })();
  const leafMat = keep(new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.75, color: 0xc8e090, emissive: 0x1a2a06, emissiveIntensity: 0.35 }));
  const barkMat = keep(new THREE.MeshStandardMaterial({ color: 0x3a2f24, roughness: 0.9 }));
  const treeFallback = new THREE.Group();
  {
    const trunks: THREE.BufferGeometry[] = [];
    const cards: THREE.BufferGeometry[] = [];
    for (const t of treeSpots) {
      const ht = 7 * t.s;
      const tr = new THREE.CylinderGeometry(0.12 * t.s, 0.2 * t.s, ht * 0.6, 7);
      tr.translate(t.x, ht * 0.3, t.z);
      trunks.push(tr);
      for (let k = 0; k < 44; k++) {
        const card = new THREE.PlaneGeometry(1.8 * t.s, 1.8 * t.s);
        card.rotateY(rnd() * Math.PI);
        card.rotateX((rnd() - 0.5) * 0.9);
        const a = rnd() * Math.PI * 2;
        const rr = rnd() * 1.8 * t.s;
        card.translate(t.x + Math.cos(a) * rr, ht * (0.62 + rnd() * 0.35), t.z + Math.sin(a) * rr);
        cards.push(card);
      }
    }
    const tm = new THREE.Mesh(keep(mergeGeometries(trunks)), barkMat);
    tm.castShadow = true;
    const cm = new THREE.Mesh(keep(mergeGeometries(cards)), leafMat);
    cm.castShadow = true;
    cm.receiveShadow = true;
    for (const g of [...trunks, ...cards]) g.dispose();
    treeFallback.add(tm, cm);
  }
  outside.add(treeFallback);

  // ---- set dressing: galleries, ceiling coffers, furniture, plants, sconces -------------------------------------
  const decor = buildDecor(world, { brass, steel, travertine: travMat, ceiling: ceilingMat, glass, leaf: leafMat, bark: barkMat, texSet }, quality, models);
  group.add(decor.group);
  // decor.ts merges its own meshes.
  decor.group.userData.noMerge = true;
  const allLamps: LampLight[] = [...lamps, ...decor.lamps];

  // ---- reflection environment: a warm, sunlit lobby (post.ts turns it into a PMREM) -------------------------------
  const envScene = new THREE.Scene();
  {
    const shell = new THREE.Mesh(new THREE.BoxGeometry(40, 14, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.42, 0.34, 0.24), side: THREE.BackSide }));
    shell.position.y = 6;
    envScene.add(shell);
    const floorDark = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0a0806 }));
    floorDark.position.y = -0.9;
    envScene.add(floorDark);
    // The facade: a wall of bright golden daylight.
    const day = new THREE.Mesh(new THREE.PlaneGeometry(30, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.5, 1.6) }));
    day.position.set(0, 6, -19.5);
    envScene.add(day);
    const warm = new THREE.MeshBasicMaterial({ color: lampColor.clone().multiplyScalar(6) });
    for (const [x, z] of [
      [-8, -6],
      [8, -2],
      [-6, 8],
      [6, 10],
      [0, 2],
    ]) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), warm);
      p.position.set(x, 4 + (x % 3), z);
      envScene.add(p);
    }
    const bright = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.3, 0.9) });
    for (const x of [-12, 12]) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(30, 0.4), bright);
      strip.position.set(x * 0.98, 4.6, 0);
      strip.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2;
      envScene.add(strip);
    }
  }
  group.userData.envScene = envScene;

  // ---- models arrive ---------------------------------------------------------------------------------------------
  let disposed = false;
  /** A props.glb model, or null when models.ts only has a generic stand-in for that name. */
  const prop = (name: string): THREE.Object3D | null => {
    try {
      const m = models.prop(name as never);
      return m.name === name ? m : null;
    } catch {
      return null;
    }
  };
  models.ready
    .then(() => {
      if (disposed) return;
      for (const g of shutters) {
        const m = prop('securityShutter');
        if (!m) break;
        const sz = g.userData.size as { width: number; height: number; alongX: boolean };
        m.scale.set(sz.width / 6.2, sz.height / 4.4, 1);
        m.rotation.y = sz.alongX ? 0 : Math.PI / 2;
        m.traverse((o) => {
          const mm = o as THREE.Mesh;
          if (mm.isMesh) mm.castShadow = mm.receiveShadow = true;
        });
        g.clear();
        g.add(m);
      }
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
            item.position.set(0, 1.3, -0.33);
            if (st.kind === 'weapon') item.rotation.set(0, Math.PI / 2, 0.12);
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
        if (!L.pendant) continue;
        try {
          const lamp = prop('pendant');
          if (!lamp) continue;
          lamp.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            const mat = m.material as THREE.MeshStandardMaterial;
            if (mat.name === 'Bulb' || mat.name === 'Shade') {
              m.material = L.bulb;
              m.userData.noMoonShadow = true;
            } else m.castShadow = true;
          });
          L.holder.remove(L.fallback);
          L.holder.add(lamp);
        } catch {
          /* keep the rod cluster */
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
    })
    .catch(() => {
      /* models failed: the stand-ins stay */
    })
    .finally(() => {
      if (!disposed) mergeStatic(group);
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
    if (moon.shadow.mapSize.x !== spec.sunMap) {
      moon.shadow.mapSize.set(spec.sunMap, spec.sunMap);
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
    streetLights,
    glows: decor.glows,
    floorSet,
    floorMeters: floorSet.meters,
    yardSet,
    dust: 1.0,
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
        let level = 0.97 + 0.03 * Math.sin(time * 2.1 + L.seed);
        if (L.flicker > 0) {
          const n = Math.sin(time * 9 + L.seed) * Math.sin(time * 13.7 + L.seed * 2);
          if (n > 0.92 - L.flicker * 0.2) level *= 0.55;
        }
        L.level = level;
        L.light.intensity = L.base * level;
        L.bulb.emissiveIntensity = (L.base > 30 ? 9 : 2) * level;
      }
      decor.update(dt, time);
      skyline.update(dt, time);
      motes.update(dt, time);
    },
    setQuality(q) {
      applyQuality(q);
      decor.setQuality(q);
      skyline.setQuality(q);
      motes.setQuality(q);
    },
    dispose() {
      disposed = true;
      decor.dispose();
      skyline.dispose();
      motes.dispose();
      scene.remove(group, moon, moon.target, hemi, sky);
      for (const S of streetLights) scene.remove(S.light, S.light.target);
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
  // Shutters are part of the group (locked wings); keep the list reachable for the lab.
  group.userData.shutters = shutters;
  return view;
};

export type { Glow };
