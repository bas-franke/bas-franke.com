// The hotel lobby as the player sees it. Chunk walls and props are one InstancedMesh per material with world-space
// box-projected PBR textures (travertine runs on across chunks, the marble floor across the whole room) and per-instance
// damage that grows cracks; glass chunks are a clear instanced material that crazes as it takes damage. Around them:
// the polished marble floor, a coffered ceiling, brass mullions, security shutters on locked wings, barricaded doors,
// lockers, brass pendant lamps and chandeliers (mostly failing: one is dark, the others burn low and stutter), and
// outside a wet plaza at about 2 am under a dark, fog-coloured sky with the city's orange glow low on the horizon.
// Sodium street lights (tapered poles, cobra heads with HDR lenses) and two brass lanterns by the revolving door are
// the main light: the lamps across the plaza aim at the glass, so their light falls through the facade and the
// mullions throw long shadows over the marble (those lamps cast three.js shadows on medium/high, and post.ts draws
// shadowed fog shafts for them). The DirectionalLight is a faint cold moon. Furniture, the mezzanine galleries and
// the smaller dressing live in decor.ts. Models from models.ts replace the primitive stand-ins as soon as they load.
//
// post.ts reads `group.userData.envScene` (a dark night lobby it turns into the reflection environment) and skips
// objects with `userData.noMoonShadow` in its own depth map along `moonDir`.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ZB } from '@shared/zombies/constants';
import type { Mat } from '@shared/zombies/maps';
import { AMMO_CRATE_PRICE, WEAPONS } from '@shared/zombies/weapons';
import { ARMOR_PRICE, NADE_PRICE } from '@shared/zombies/weapons';
import { type StationInfo, type World, SILL_Y, WALL_T, WINDOW_TOP } from '@shared/zombies/world';
import type { CreateWorldView, LampLight, Models, Quality, WorldView } from './api';
import { type Glow, buildDecor, failing, mergeStatic } from './decor';
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
/** Faint moonlight through the city haze, warmed to match the amber grade: just enough to model the silhouettes outside. */
const MOON_COLOR = new THREE.Color(1.0, 0.78, 0.55);
const MOON_INTENSITY = 0.16;
/** Fill: the city's amber glow from above, near-black marble below (the target grade has no cold tones). */
const HEMI_SKY = 0x5c4630;
const HEMI_GROUND = 0x0c0907;
const HEMI_INTENSITY = 0.3;
/** High-pressure sodium, a deep amber, and the hotel lanterns' warmer white. */
const SODIUM = new THREE.Color(1.0, 0.5, 0.17);
const LANTERN = new THREE.Color(1.0, 0.7, 0.4);
/** Floor: albedo lift and the gold veins' self-glow (linear, before exposure). */
const FLOOR_LIFT = 1.4;
const FLOOR_GLOW = 0.5;
/** Travertine walls toned down to a warm taupe: the target's lobby is dark, its light comes from slots and strips. */
const TRAV_TONE = 0x8a7c6c;
/** The three shaft-casting mast lamps outside the facade. */
const MAST_INTENSITY = 12000;
/** Window/door boards' warm self-glow through the grain (0: tried 1.6, no visible gain in the refshot). */
const BOARD_GLOW = 0;
/** The columns' light slots (linear emission). */
const SLOT_COLOR = new THREE.Color(1.0, 0.62, 0.3).multiplyScalar(2.5);

/**
 * Shadow-casting lamps and shadow map sizes per quality. The hotel's own lamps are failing, so their shadow budget went
 * to the street lights with shafts (the mullion shadows on the marble); the dim moon gets a smaller map.
 */
const QUALITY_SPEC: Record<Quality, { lampShadows: number; lampMap: number; streetShadows: number; streetMap: number; sunMap: number; texScale: number }> = {
  low: { lampShadows: 0, lampMap: 512, streetShadows: 0, streetMap: 512, sunMap: 1024, texScale: 0.5 },
  medium: { lampShadows: 0, lampMap: 512, streetShadows: 3, streetMap: 512, sunMap: 2048, texScale: 1 },
  high: { lampShadows: 0, lampMap: 1024, streetShadows: 3, streetMap: 1024, sunMap: 2048, texScale: 1 },
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
  /** Emission colour (linear) for the set's glow mask (ORM red channel): the floor's gold veins. */
  glow?: THREE.Color;
  /**
   * Column cladding: per-instance `aCol` (the column's centre x, z) puts two vertical light slots near the corners of
   * every face, burning this colour (linear).
   */
  slots?: THREE.Color;
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
const PROJ_VERTEX = (damage: boolean, slots = false) => /* glsl */ `#include <fog_vertex>
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
  ${slots ? 'vec2 zc = zw.xz - aCol; vZAlong = abs(zn.x) > 0.5 ? zc.y : abs(zn.z) > 0.5 ? zc.x : 99.0;' : ''}
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
    if (o.glow) sh.uniforms.uGlow = { value: o.glow };
    if (o.slots) sh.uniforms.uSlot = { value: o.slots };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTexScale;
varying vec3 vZPos;
varying vec2 vZUv;
${o.damage ? 'attribute float aDamage; varying float vZDamage;' : ''}
${o.slots ? 'attribute vec2 aCol; varying float vZAlong;' : ''}`,
      )
      .replace('#include <fog_vertex>', PROJ_VERTEX(!!o.damage, !!o.slots));
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vZPos;
varying vec2 vZUv;
${o.damage ? 'varying float vZDamage;' : ''}
${o.glow ? 'uniform vec3 uGlow;' : ''}
${o.slots ? 'uniform vec3 uSlot; varying float vZAlong;' : ''}
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
    if (o.glow)
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
#ifdef USE_ROUGHNESSMAP
totalEmissiveRadiance += uGlow * texture2D(roughnessMap, vRoughnessMapUv).r * (1.0 - zCrack);
#endif`,
      );
    if (o.slots)
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
// Light slots: a dark recessed channel with a glowing strip in it, 12 cm in from each corner.
float zSlotD = abs(abs(vZAlong) - 0.47);
float zSlot = 1.0 - smoothstep(0.009, 0.014, zSlotD);
float zRecess = 1.0 - smoothstep(0.022, 0.03, zSlotD);
diffuseColor.rgb *= 1.0 - 0.85 * zRecess;`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
totalEmissiveRadiance += uSlot * zSlot * (1.0 - zCrack) * (0.85 + 0.15 * zNoise(vec2(vZPos.y * 3.0, vZAlong * 9.0)));`,
        );
  };
  m.customProgramCacheKey = () => `zproj-${o.damage ? 1 : 0}${o.grime ? 1 : 0}${o.instanced ? 1 : 0}${o.dents ? 1 : 0}${o.glow ? 1 : 0}${o.slots ? 1 : 0}`;
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
    case 'crate':
      return ['AMMO PACK', `${AMMO_CRATE_PRICE}`, '#b8ffaa'];
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
      else if (m === 'column') mat = keep(projMaterial({ set: texSet('woodPanel'), instanced: true, damage: true, env: 0.7, slots: SLOT_COLOR }));
      else {
        const set = MAT_SET[m] ?? 'travertine';
        mat = keep(
          projMaterial({
            set: texSet(set),
            instanced: true,
            damage: true,
            dents: set === 'brass',
            grime: set === 'travertine',
            color: set === 'travertine' ? TRAV_TONE : undefined,
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
  // Black marble with glowing gold veins; the mirror finish comes from post.ts's SSR (env reflection on low).
  const floorMat = keep(projMaterial({ set: floorSet, env: 1.25, glow: new THREE.Color(1.0, 0.76, 0.42).multiplyScalar(FLOOR_GLOW) }));
  floorMat.color.setScalar(FLOOR_LIFT);
  // Wet paving after rain: darker and glossy, so lamp pools and lit windows smear across it (not a mirror).
  const plazaMat = keep(projMaterial({ set: yardSet, env: 0.9, rough: 0.5, color: 0x9a948c }));
  const travMat = keep(projMaterial({ set: travSet, env: 0.45, grime: true, color: TRAV_TONE }));
  const ceilingMat = keep(projMaterial({ set: travSet, color: 0xf2eadc, env: 0.25, normalScale: 0.4 }));
  // A trace of street light bounced off the floor keeps the coffers from going pure black.
  ceilingMat.emissive.set(0x2a1a0e);
  ceilingMat.emissiveIntensity = 0.12;
  const brass = keep(projMaterial({ set: brassSet, env: 1.3 }));
  const steel = keep(new THREE.MeshStandardMaterial({ color: 0x8c8f92, roughness: 0.38, metalness: 0.9, envMapIntensity: 1 }));
  const darkSteel = keep(new THREE.MeshStandardMaterial({ color: 0x2c2d2f, roughness: 0.45, metalness: 0.8 }));
  const plyMat = (() => {
    const s = texSet('wood');
    // The boards glow warm through their grain, as if backlit by the street light pouring in around them.
    const m = keep(new THREE.MeshStandardMaterial({ map: s.map, normalMap: s.normalMap, roughnessMap: s.orm, roughness: 1, metalness: 0, color: 0xd8c2a0, envMapIntensity: 0.3, emissiveMap: s.map, emissive: new THREE.Color(1.0, 0.62, 0.32), emissiveIntensity: BOARD_GLOW }));
    s.onUpgrade((st) => {
      m.map = st.map;
      m.emissiveMap = st.map;
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
    const part = (c as { part?: string }).part ?? '';
    if (part === 'column') return 'column';
    if (c.mat === 'glass' || !c.wall) return c.mat;
    const cz = (c.min.z + c.max.z) / 2;
    if (part === 'atriumWest' && c.max.y <= 5.4 && cz > -11.5 && cz < 3.5) return 'marble';
    if ((part === 'atriumWest' || part === 'atriumEast') && c.max.y <= 4.6) return 'walnut';
    if (part === 'south' && c.max.y <= 3.6) return 'walnut';
    if (part.startsWith('lounge') && c.max.y <= 3.1) return 'walnut';
    return c.mat;
  };
  const byMat = new Map<string, number[]>();
  world.chunks.forEach((c, i) => {
    // Furniture chunks are drawn by decor.ts (its models, cut away where the chunks are gone).
    if (c.furn !== undefined) return;
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
    if (mat === 'column') {
      // Each chunk's column centre, for the light slots.
      const cols = def.props.filter((p) => p.kind === 'column');
      const ac = new Float32Array(list.length * 2);
      list.forEach((ci, k) => {
        const c = world.chunks[ci];
        const x = (c.min.x + c.max.x) / 2;
        const z = (c.min.z + c.max.z) / 2;
        let best = cols[0];
        let bd = Infinity;
        for (const p of cols) {
          const d = (p.x - x) ** 2 + (p.z - z) ** 2;
          if (d < bd) [bd, best] = [d, p];
        }
        ac[k * 2] = best?.x ?? x;
        ac[k * 2 + 1] = best?.z ?? z;
      });
      geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(ac, 2));
    }
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
    if (d <= visualDamage[i] || !meshOf[i]) return;
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
    // along x up = out keeps the basis right-handed; the other sign is a mirror and the quaternion comes out wrong.
    const along = new THREE.Vector3(out.z, 0, -out.x);
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
  const crateMat = keep(new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 0.7, metalness: 0.15 }));
  const crateLidMat = keep(new THREE.MeshStandardMaterial({ color: 0x3a412a, roughness: 0.6, metalness: 0.3 }));

  // ---- security bars -------------------------------------------------------------------------------------------
  // Brass bars outside every exterior wall on the ground floor (world.ts barRuns): rods every 14 cm between a
  // bottom, middle and top rail. One instanced mesh for all rods, one for all rails.
  {
    const runs = world.solids.filter((s) => s.kind === 'bars');
    const brass = keep(new THREE.MeshStandardMaterial({ color: 0xc8a050, roughness: 0.28, metalness: 1 }));
    const rodGeo = keep(new THREE.CylinderGeometry(0.016, 0.016, 1, 8));
    const railGeo = keep(new THREE.BoxGeometry(1, 0.05, 0.05));
    let rodsN = 0;
    for (const r of runs) rodsN += Math.ceil(Math.max(r.max.x - r.min.x, r.max.z - r.min.z) / 0.14) + 1;
    const rods = new THREE.InstancedMesh(rodGeo, brass, Math.max(1, rodsN));
    const rails = new THREE.InstancedMesh(railGeo, brass, Math.max(1, runs.length * 3));
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const yAxis = new THREE.Vector3(0, 1, 0);
    let ri = 0;
    let li = 0;
    for (const r of runs) {
      const alongX = r.max.x - r.min.x > r.max.z - r.min.z;
      const len = alongX ? r.max.x - r.min.x : r.max.z - r.min.z;
      const cx = (r.min.x + r.max.x) / 2;
      const cz = (r.min.z + r.max.z) / 2;
      const h = r.max.y - r.min.y;
      const n = Math.ceil(len / 0.14);
      for (let k = 0; k <= n; k++) {
        const a = (alongX ? r.min.x : r.min.z) + (len * k) / n;
        m4.compose(new THREE.Vector3(alongX ? a : cx, h / 2, alongX ? cz : a), q.identity(), new THREE.Vector3(1, h, 1));
        rods.setMatrixAt(ri++, m4);
      }
      q.setFromAxisAngle(yAxis, alongX ? 0 : Math.PI / 2);
      for (const y of [0.08, h * 0.5, h - 0.04]) {
        m4.compose(new THREE.Vector3(cx, y, cz), q, new THREE.Vector3(len, 1, 1));
        rails.setMatrixAt(li++, m4);
      }
    }
    rods.count = ri;
    rails.count = li;
    for (const im of [rods, rails]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.userData.noMerge = true;
      group.add(im);
    }
  }
  for (const st of world.stations) {
    const g = new THREE.Group();
    const f = st.facing;
    if (st.kind === 'crate') {
      // The ammo crate: an olive ammo box with a lid, rope handles and a lit plaque on top.
      g.position.set(st.pos.x, 0, st.pos.z);
      group.add(g);
      lockerGroups.push(g);
      lockerFallbacks.push(g);
      const crate = new THREE.Mesh(keep(box(1, 0.6, 0.6)), crateMat);
      crate.position.y = 0.3;
      const lid = new THREE.Mesh(keep(box(1.04, 0.08, 0.64)), crateLidMat);
      lid.position.y = 0.64;
      for (const m of [crate, lid]) {
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      }
      for (const sx of [-0.53, 0.53]) {
        const handle = new THREE.Mesh(keep(box(0.04, 0.06, 0.26)), crateLidMat);
        handle.position.set(sx, 0.45, 0);
        g.add(handle);
      }
      const [title, price, accent] = stationText(st);
      const p = plaque([title, price], accent);
      p.position.set(0, 0.685, 0);
      p.rotation.x = -Math.PI / 2;
      g.add(p);
      disposables.push(p.geometry, p.material as THREE.Material, (p.material as THREE.MeshStandardMaterial).map!);
      continue;
    }
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
  // Night with failing power: `dim` scales the lamp's nominal output (the fog sees it through `level`), `fail` how
  // badly it stutters. The first chandelier (nearest the glass) is dead so the street light owns the front of the room.
  type Lamp = LampLight & { bulb: THREE.MeshStandardMaterial; base: number; bulbBase: number; dim: number; flicker: number; seed: number; holder: THREE.Group; fallback: THREE.Object3D; pendant: boolean };
  const lamps: Lamp[] = [];
  let chandeliers = 0;
  let pendants = 0;
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
    // [dim, fail]: chandeliers dead / a low ember / stuttering; pendants mostly low, one dead, flicker from the map.
    const k = chandelier ? chandeliers++ : pendants++;
    const [dim, fail] = chandelier ? ([[0, 0], [0.05, 0.25], [0.09, 0.85]] as const)[k % 3] : k === 3 ? [0, 0] : [0.3, Math.max(0.15, l.flicker)];
    const base = (chandelier ? 220 : 70) * lit * dim;
    // A dead lamp has no light at all (cheaper than one at zero).
    spot.visible = base > 0;
    lamps.push({ pos: { x: l.pos.x, y: y - 0.3, z: l.pos.z }, light: spot, level: dim * lit, color: lampColor.clone(), bulb, base, bulbBase: dim > 0 ? (chandelier ? 1.2 : 2.2) * Math.sqrt(lit) : 0.03, dim: dim * lit, flicker: fail, seed: lamps.length * 13.7, holder, fallback: fb, pendant: !chandelier });
  }

  // ---- the moon, sky light, sky --------------------------------------------------------------------------------
  // 2 am: a faint cold moon high behind the fog (still in the north, so its weak shadows fall into the room).
  const sunYaw = def.moon?.yaw ?? 0.35;
  const sunElev = 0.85;
  const facadeZ = ext.minZ;
  const moonDir = new THREE.Vector3(Math.sin(sunYaw) * Math.cos(sunElev), Math.sin(sunElev), -Math.cos(sunYaw) * Math.cos(sunElev)).normalize();
  const moon = new THREE.DirectionalLight(MOON_COLOR, MOON_INTENSITY);
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
  // A dim cold sky above, near-black wet ground below: shadows stay blue-grey and readable, never warm.
  const hemi = new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY);
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
float sHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float sNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -0.2, 1.0);
  // Overcast night: the fog's blue-grey near the horizon fading to almost black overhead.
  vec3 col = mix(vec3(0.05, 0.056, 0.066), vec3(0.008, 0.01, 0.016), smoothstep(0.0, 0.6, up));
  // The city's sodium glow lit from below on the low cloud, patchy along the horizon.
  vec2 hz = normalize(d.xz + vec2(1e-4));
  float glowAmt = 0.6 + 0.4 * sNoise(hz * 3.0 + 5.0) + 0.25 * sNoise(hz * 9.0 + 1.7);
  col += vec3(0.32, 0.14, 0.045) * exp(-max(up, 0.0) * 7.0) * glowAmt;
  // Where the moon sits, the cloud is a touch paler (no disc).
  col += vec3(0.02, 0.025, 0.035) * pow(max(dot(d, uSun), 0.0), 6.0);
  col = mix(col, vec3(0.05, 0.04, 0.035), 1.0 - smoothstep(-0.2, 0.0, up));
  // Dither: the dark gradient would band.
  col += (sHash(gl_FragCoord.xy) - 0.5) * 0.004;
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
  /** Per street light: nominal intensity, lens material and HDR strength, flicker seed and how badly it is failing. */
  const streetFx: { base: number; lens: THREE.MeshStandardMaterial; lensBase: number; seed: number; fail: number }[] = [];
  // Painted cast iron for the poles and housings; brass trim on the hotel's lanterns.
  const poleMat = keep(new THREE.MeshStandardMaterial({ color: 0x1d2023, roughness: 0.42, metalness: 0.65, envMapIntensity: 0.8 }));
  const poleParts: THREE.BufferGeometry[] = [];
  const brassParts: THREE.BufferGeometry[] = [];
  const lensMat = (color: THREE.Color, strength: number) => keep(new THREE.MeshStandardMaterial({ color: 0x0a0806, roughness: 0.25, emissive: color.clone(), emissiveIntensity: strength }));
  const lensParts = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>();
  const addLens = (mat: THREE.MeshStandardMaterial, g: THREE.BufferGeometry) => {
    const list = lensParts.get(mat) ?? [];
    list.push(g);
    lensParts.set(mat, list);
  };
  /**
   * A cobra-head street light: plinth, tapered pole, a swan-neck arm reaching `reach` m towards `yaw` (0 = +z, the
   * hotel), a flattened housing with a glowing drop lens. `head` is the lens centre; returns nothing, the light is
   * placed by the caller there.
   */
  const cobra = (head: THREE.Vector3, yaw: number, lens: THREE.MeshStandardMaterial, reach = 1.5) => {
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const base = head.clone().addScaledVector(fwd, -reach).setY(0);
    const hy = head.y;
    const local: THREE.BufferGeometry[] = [];
    local.push(new THREE.CylinderGeometry(0.19, 0.24, 0.5, 16).translate(0, 0.25, 0));
    local.push(new THREE.CylinderGeometry(0.13, 0.17, 0.4, 16).translate(0, 0.7, 0));
    local.push(new THREE.TorusGeometry(0.135, 0.02, 6, 20).rotateX(Math.PI / 2).translate(0, 0.9, 0));
    local.push(new THREE.CylinderGeometry(0.06, 0.115, hy - 0.5, 16).translate(0, 0.9 + (hy - 0.5) / 2, 0));
    local.push(new THREE.SphereGeometry(0.075, 12, 8).translate(0, hy + 0.42, 0));
    const neck = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, hy - 0.2, 0), new THREE.Vector3(0, hy + 0.55, reach * 0.4), new THREE.Vector3(0, hy + 0.16, reach - 0.35));
    local.push(new THREE.TubeGeometry(neck, 16, 0.04, 8));
    // Housing: a long flattened shell, nose slightly down, with a small cooling fin on top.
    local.push(new THREE.SphereGeometry(1, 28, 14).scale(0.25, 0.12, 0.56).rotateX(0.06).translate(0, hy + 0.14, reach));
    local.push(new THREE.BoxGeometry(0.03, 0.05, 0.5).translate(0, hy + 0.27, reach - 0.05));
    const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(base);
    for (const g of local) poleParts.push(g.applyMatrix4(m));
    // The drop lens: the lower half of an ellipsoid hanging just below the housing's rim.
    addLens(lens, new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).scale(0.2, 0.08, 0.44).rotateX(0.06).translate(0, hy + 0.08, reach).applyMatrix4(m));
  };
  /** An ornamental hotel lantern on a short fluted post: brass-trimmed iron, a frosted glowing body, a pyramid roof. */
  const lantern = (x: number, z: number, lens: THREE.MeshStandardMaterial) => {
    const parts: THREE.BufferGeometry[] = [];
    const brassBits: THREE.BufferGeometry[] = [];
    parts.push(new THREE.CylinderGeometry(0.2, 0.27, 0.6, 8).translate(0, 0.3, 0));
    brassBits.push(new THREE.CylinderGeometry(0.215, 0.215, 0.05, 8).translate(0, 0.62, 0));
    parts.push(new THREE.CylinderGeometry(0.075, 0.1, 0.4, 12).translate(0, 0.85, 0));
    // Fluting: the post is a ring of thin staves around a core.
    parts.push(new THREE.CylinderGeometry(0.045, 0.06, 2.0, 12).translate(0, 2.05, 0));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      parts.push(new THREE.CylinderGeometry(0.012, 0.016, 1.9, 5).translate(Math.cos(a) * 0.055, 2.05, Math.sin(a) * 0.055));
    }
    brassBits.push(new THREE.SphereGeometry(0.09, 14, 10).translate(0, 3.05, 0));
    brassBits.push(new THREE.CylinderGeometry(0.2, 0.12, 0.08, 4, 1).rotateY(Math.PI / 4).translate(0, 3.12, 0));
    // Body: four frosted panes (one glowing tapered block) with iron corner posts.
    addLens(lens, new THREE.CylinderGeometry(0.2, 0.15, 0.5, 4, 1).rotateY(Math.PI / 4).translate(x, 3.41, z));
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k / 4) * Math.PI * 2;
      parts.push(new THREE.CylinderGeometry(0.016, 0.016, 0.56, 5).translate(Math.cos(a) * 0.18, 3.41, Math.sin(a) * 0.18));
    }
    brassBits.push(new THREE.CylinderGeometry(0.27, 0.27, 0.04, 4, 1).rotateY(Math.PI / 4).translate(0, 3.68, 0));
    parts.push(new THREE.ConeGeometry(0.3, 0.32, 4, 1).rotateY(Math.PI / 4).translate(0, 3.86, 0));
    brassBits.push(new THREE.SphereGeometry(0.04, 10, 8).translate(0, 4.05, 0));
    brassBits.push(new THREE.ConeGeometry(0.025, 0.14, 8).translate(0, 4.14, 0));
    for (const g of parts) poleParts.push(g.translate(x, 0, z));
    for (const g of brassBits) brassParts.push(g.translate(x, 0, z));
  };
  /** A real street light: SpotLight + its fixture. `fail` 0..1: how badly the sodium lamp is dying. */
  const street = (o: { pos: THREE.Vector3; aim: THREE.Vector3; color: THREE.Color; intensity: number; outer: number; inner: number; range: number; shafts: boolean; fail?: number; lens: number; fixture: (lens: THREE.MeshStandardMaterial) => void }) => {
    const dir = o.aim.clone().sub(o.pos).normalize();
    const light = new THREE.SpotLight(o.color, o.intensity, o.range, o.outer, 1 - o.inner / o.outer, 2);
    light.position.copy(o.pos);
    light.target.position.copy(o.aim);
    light.layers.enableAll();
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.03;
    light.shadow.camera.near = 0.5;
    light.shadow.camera.far = o.range;
    scene.add(light, light.target);
    const lens = lensMat(o.color, o.lens);
    o.fixture(lens);
    streetFx.push({ base: o.intensity, lens, lensBase: o.lens, seed: streetLights.length * 7.31 + 1.7, fail: o.fail ?? 0 });
    streetLights.push({ pos: o.pos.clone(), dir, color: o.color.clone(), cosOuter: Math.cos(o.outer), cosInner: Math.cos(o.inner), range: o.range, light, level: 1, shafts: o.shafts });
  };
  // Three tall masts 10 m out from the glass carry the lamps with shafts: aimed low and long at the middle of the lobby,
  // their light rakes in through the glass at ~17 degrees, so the mullions and transoms stripe it into long diagonal
  // beams across the marble. A plaza row 7 m out lights the plaza's ends (the east one is failing). Shafts ones first.
  const rowZ = facadeZ - 7;
  const lampHeight = 7.2;
  const mastZ = facadeZ - 10;
  const mastHeight = 9.5;
  for (const x of [-7.5, 1.5, 9]) {
    const pos = new THREE.Vector3(x, mastHeight, mastZ);
    street({ pos, aim: new THREE.Vector3(x * 0.45, 0, facadeZ + 21), color: SODIUM, intensity: MAST_INTENSITY, outer: 0.45, inner: 0.16, range: 60, shafts: true, lens: 60, fixture: (l) => cobra(pos.clone(), 0, l, 1.8) });
  }
  for (const [x, fail] of [
    [-17, 0],
    [17, 1],
  ] as const) {
    const pos = new THREE.Vector3(x, lampHeight, rowZ);
    street({ pos, aim: new THREE.Vector3(x, 0, rowZ + 3), color: SODIUM, intensity: 700, outer: 0.95, inner: 0.4, range: 22, shafts: false, fail, lens: 60, fixture: (l) => cobra(pos.clone(), 0, l) });
  }
  // The hotel's two lanterns flanking the revolving door: warm white, aimed down onto the steps.
  const door = (def.entrances ?? []).find((e) => e.look === 'revolving');
  const doorX = door?.at ?? 0;
  for (const side of [-1, 1]) {
    const x = doorX + side * 2.45;
    const z = facadeZ - 1.25;
    const pos = new THREE.Vector3(x, 3.3, z);
    street({ pos, aim: new THREE.Vector3(x + side * 0.6, 0, z - 1.2), color: LANTERN, intensity: 40, outer: 1.25, inner: 0.6, range: 12, shafts: false, fail: side > 0 ? 0.12 : 0, lens: 14, fixture: (l) => lantern(x, z, l) });
  }
  // Emissive-only lamps further off (no light, just a lens to glow and bloom through the fog): the row continues
  // along the street, and a row on the far side of the plaza faces back at the hotel.
  {
    const far = lensMat(SODIUM, 60);
    for (const x of [-37, -27, 27, 37]) cobra(new THREE.Vector3(x, lampHeight, rowZ), 0, far);
    for (const x of [-15, -3, 9, 21]) cobra(new THREE.Vector3(x, lampHeight, facadeZ - 24), Math.PI, far);
  }
  {
    const pm = new THREE.Mesh(keep(mergeGeometries(poleParts, false)), poleMat);
    pm.castShadow = pm.receiveShadow = true;
    pm.name = 'streetPoles';
    outside.add(pm);
    const bm = new THREE.Mesh(keep(mergeGeometries(brassParts, false)), brass);
    bm.castShadow = true;
    outside.add(bm);
    for (const [mat, list] of lensParts) {
      const lm = new THREE.Mesh(keep(mergeGeometries(list, false)), mat);
      lm.userData.noMoonShadow = true;
      outside.add(lm);
      for (const g of list) g.dispose();
    }
    for (const g of [...poleParts, ...brassParts]) g.dispose();
  }
  const motes = buildMotes({ interior: world.interior, ceiling: h, streetLights, quality });
  group.add(motes.group);
  // Street trees in front of the facade and along the sides: canopies of leaf cards that throw dappled shadows.
  const treeSpots: { x: number; z: number; s: number; yaw: number }[] = [];
  for (let x = ext.minX - 4; x <= ext.maxX + 4; x += 6.5 + rnd() * 2) treeSpots.push({ x: x + (rnd() - 0.5), z: facadeZ - 6 - rnd() * 3, s: 0.9 + rnd() * 0.35, yaw: rnd() * 6.28 });
  for (let x = ext.minX + 2; x <= ext.maxX - 2; x += 9 + rnd() * 3) treeSpots.push({ x, z: facadeZ - 16 - rnd() * 4, s: 1 + rnd() * 0.4, yaw: rnd() * 6.28 });
  // No canopy around a lamp head (or between a shafts lamp and the glass).
  for (let i = treeSpots.length - 1; i >= 0; i--) {
    const t = treeSpots[i];
    const nearLamp = streetLights.some((S) => Math.abs(S.pos.x - t.x) < (S.shafts ? 4.5 : 3) && t.z > S.pos.z - 3.5 && S.pos.y > 5);
    const nearFar = Math.abs(t.z - (facadeZ - 24)) < 3 && [-15, -3, 9, 21].some((x) => Math.abs(x - t.x) < 3);
    if (nearLamp || nearFar) treeSpots.splice(i, 1);
  }
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
  // Night: the canopies are dark silhouettes, picked out only where a lamp catches them (no fake leaf glow).
  const leafMat = keep(new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8, color: 0x8a9a70 }));
  const barkMat = keep(new THREE.MeshStandardMaterial({ color: 0x241e18, roughness: 0.75 }));
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

  // ---- reflection environment: the lobby at night (post.ts turns it into a PMREM) ---------------------------------
  const envScene = new THREE.Scene();
  {
    const shell = new THREE.Mesh(new THREE.BoxGeometry(40, 14, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.022, 0.021, 0.022), side: THREE.BackSide }));
    shell.position.y = 6;
    envScene.add(shell);
    const floorDark = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x030303 }));
    floorDark.position.y = -0.9;
    envScene.add(floorDark);
    // The facade: foggy night glass lit dull orange by the street lights, brighter low down where the lamps are.
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(30, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.17, 0.07) }));
    glow.position.set(0, 6, -19.5);
    envScene.add(glow);
    // The columns' light slots and the galleries' LED strips: the warm streaks the floor mirrors where SSR is off.
    const strip = new THREE.MeshBasicMaterial({ color: SLOT_COLOR.clone().multiplyScalar(0.5) });
    for (const p of def.props) {
      if (p.kind !== 'column') continue;
      for (const sx of [-0.47, 0.47]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 11, 0.05), strip);
        bar.position.set(p.x + sx, 6, p.z + 0.62);
        envScene.add(bar);
      }
    }
    for (const m of def.mezzanine ?? []) {
      const w = def.walls.find((x) => x.id === m.wall);
      if (!w || w.along !== 'z') continue;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, w.a1 - w.a0), strip);
      bar.position.set(w.fixed - w.out * m.depth, m.y - 0.1, (w.a0 + w.a1) / 2);
      envScene.add(bar);
    }
    const lampsMat = new THREE.MeshBasicMaterial({ color: SODIUM.clone().multiplyScalar(5) });
    for (const x of [-7.5, 1.5, 9]) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), lampsMat);
      p.position.set(x, 9.5, -19.4);
      envScene.add(p);
    }
    // A couple of the hotel's lamps still burning.
    const warm = new THREE.MeshBasicMaterial({ color: lampColor.clone().multiplyScalar(1.6) });
    for (const [x, z] of [
      [8, -2],
      [-6, 8],
      [6, 10],
    ]) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), warm);
      p.position.set(x, 3 + (x % 3), z);
      envScene.add(p);
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
        if (st.kind === 'crate') return;
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
    // The plaza lamps with shafts throw the mullion shadows into the lobby.
    let n = 0;
    for (const S of streetLights) {
      const on = S.shafts && n++ < spec.streetShadows;
      S.light.castShadow = on;
      S.light.userData.shadowCaster = on;
      if (S.light.shadow.mapSize.x !== spec.streetMap) {
        S.light.shadow.mapSize.set(spec.streetMap, spec.streetMap);
        S.light.shadow.map?.dispose();
        S.light.shadow.map = null;
      }
    }
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
      if (c?.furn !== undefined) decor.setChunkHp(i, hp);
      if (!c || c.hard || !meshOf[i]) return;
      writeDamage(i, 1 - Math.max(0, hp) / c.maxHp);
    },
    breakChunk(i) {
      decor.breakChunk(i);
      const mesh = meshOf[i];
      if (!mesh) return;
      mesh.setMatrixAt(slot[i], hidden);
      mesh.instanceMatrix.needsUpdate = true;
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
        const f = failing(time, L.seed, L.flicker);
        L.level = L.dim * f;
        L.light.intensity = L.base * f;
        L.bulb.emissiveIntensity = L.bulbBase * (L.dim > 0 ? f : 1);
      }
      streetLights.forEach((S, i) => {
        const fx = streetFx[i];
        // Sodium hums; the failing one cuts out, restrikes dull red-orange and slowly warms back up.
        const f = fx.fail > 0 ? failing(time, fx.seed, fx.fail) : 0.985 + 0.015 * Math.sin(time * 1.3 + fx.seed);
        S.level += (f - S.level) * Math.min(1, dt * (f < S.level ? 30 : 4));
        S.light.intensity = fx.base * S.level;
        fx.lens.emissiveIntensity = fx.lensBase * (0.04 + 0.96 * S.level);
      });
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
      for (const S of streetLights) {
        scene.remove(S.light, S.light.target);
        S.light.shadow.map?.dispose();
      }
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
