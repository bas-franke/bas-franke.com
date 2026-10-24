// Builds the three.js scene for a Rockets arena from the server's box list, in a cel-shaded comic style: toon-lit
// surfaces in bright colours with hand-drawn textures per kind (tiles, bricks, metal plates, strata...), an ink hull
// around every box plus ink crease lines, hazard stripes on every drop, props on and behind the outer walls, and a
// themed sky. Everything is merged per material, so even the busiest map draws the arena in under forty calls; the
// biggest merged layers are then cut into a few spatial chunks so the camera can cull what it is not looking at.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MapBox, MapData } from '@shared/rockets/map';
import { INK, hullGeometry, inkLineMaterial, inkMaterial, toonRamp } from '../../engine/toon';
import { BASE_SURFACES, Bucket, type Surface, type Visible, at, buildProps, edgeHazards, themeOf } from './arenaDecor';
import { SUN_DIR, buildSky } from './arenaSky';
import { TEX_SIZE, type TexKey, arenaTexture, mulberry } from './arenaTextures';

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
/** Visual jump pads are this much wider than their trigger radius, so they read from across the map. */
const PAD_SCALE = 1.45;
const PACK_COLOR = 0x7cf4c9;

export interface ArenaView {
  group: THREE.Group;
  /**
   * One handle per jump pad. The client spins them by advancing `rotation.z`; the pads themselves are a single
   * instanced mesh that reads the first handle's angle to spin, bob and pulse every ring and beam on the GPU.
   */
  padRings: THREE.Mesh[];
  dispose(): void;
}

/** A toon material that picks a side texture or a top texture per face (attribute `aTop`), both in world metres. */
function surfaceMaterial(color: number, surface: Surface, tex: (k: TexKey) => THREE.Texture): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({ color, gradientMap: toonRamp(), map: tex(surface.side), vertexColors: true });
  const crate = surface.side === 'crate';
  const topMap = tex(surface.top);
  const sideScale = crate ? 1 : 1 / TEX_SIZE[surface.side];
  const topScale = crate ? 1 : 1 / TEX_SIZE[surface.top];
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.topMap = { value: topMap };
    shader.uniforms.sideScale = { value: sideScale };
    shader.uniforms.topScale = { value: topScale };
    shader.vertexShader = 'attribute float aTop;\nvarying float vTop;\n' + shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvTop = aTop;');
    shader.fragmentShader =
      'uniform sampler2D topMap;\nuniform float sideScale;\nuniform float topScale;\nvarying float vTop;\n' +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        `vec4 sampledDiffuseColor = mix(texture2D(map, vMapUv * sideScale), texture2D(topMap, vMapUv * topScale), vTop);
        diffuseColor *= sampledDiffuseColor;`,
      );
  };
  mat.customProgramCacheKey = () => 'arenaSurface';
  return mat;
}

/** Merged meshes under this many triangles stay whole: their draw call costs more than culling them would save. */
const CHUNK_TRIS = 1500;
const _p = new THREE.Vector3();

/**
 * Splits a big merged mesh into a grid of chunks over x and z (by triangle centre), so frustum culling can drop the
 * parts outside the view: one merged mesh has one bounding sphere and is drawn whole from anywhere. Up to 3 x 3
 * chunks, aiming at CHUNK_TRIS or more each. The chunks share the original vertex buffers (each has only its own
 * index and bounding sphere), so memory and uploads stay the same. Returns the mesh itself when it is not worth it.
 */
function chunked(mesh: THREE.Mesh): THREE.Object3D {
  const geo = mesh.geometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const index = geo.index;
  const tris = (index ? index.count : pos.count) / 3;
  const cells = Math.min(3, Math.round(Math.sqrt(tris / CHUNK_TRIS)));
  if (cells < 2 || geo.groups.length || Array.isArray(mesh.material)) return mesh;
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox!;
  const sx = (max.x - min.x) / cells || 1;
  const sz = (max.z - min.z) / cells || 1;
  const lists: number[][] = Array.from({ length: cells * cells }, () => []);
  for (let t = 0; t < tris; t++) {
    const a = index ? index.getX(t * 3) : t * 3;
    const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const i = Math.min(cells - 1, Math.max(0, Math.floor((cx - min.x) / sx)));
    const j = Math.min(cells - 1, Math.max(0, Math.floor((cz - min.z) / sz)));
    lists[j * cells + i].push(a, b, c);
  }
  const group = new THREE.Group();
  group.name = mesh.name;
  group.position.copy(mesh.position);
  group.quaternion.copy(mesh.quaternion);
  group.scale.copy(mesh.scale);
  for (const list of lists) {
    if (!list.length) continue;
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, attr);
    g.setIndex(list);
    // The shared position buffer covers the whole mesh, so the chunk's own bounds are set here, not computed.
    const box = new THREE.Box3();
    for (const v of list) box.expandByPoint(_p.fromBufferAttribute(pos, v));
    const centre = box.getCenter(new THREE.Vector3());
    let r2 = 0;
    for (const v of list) r2 = Math.max(r2, centre.distanceToSquared(_p.fromBufferAttribute(pos, v)));
    g.boundingBox = box;
    g.boundingSphere = new THREE.Sphere(centre, Math.sqrt(r2));
    const part = new THREE.Mesh(g, mesh.material);
    part.castShadow = mesh.castShadow;
    part.receiveShadow = mesh.receiveShadow;
    part.renderOrder = mesh.renderOrder;
    part.onBeforeRender = mesh.onBeforeRender;
    group.add(part);
  }
  return group;
}

/** Replaces every big merged mesh under `root` with chunks (see chunked). */
function chunkAll(root: THREE.Object3D) {
  const big: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && m.frustumCulled) big.push(m);
  });
  for (const m of big) {
    const c = chunked(m);
    if (c === m || !m.parent) continue;
    m.parent.add(c);
    m.parent.remove(m);
  }
}

/** True for the one floor box that covers the whole map; it needs no outline. */
const isShellFloor = (b: MapBox, half: number) => b.kind === 'floor' && b.min.x <= -half && b.max.x >= half && b.min.z <= -half && b.max.z >= half;

export function buildArena(map: MapData): ArenaView {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const accent = map.accent ?? DEFAULT_ACCENT;
  const theme = themeOf(map);
  const seed = map.id.length * 101 + map.half;
  const textures = new Map<TexKey, THREE.Texture>();
  const tex = (k: TexKey) => {
    let t = textures.get(k);
    if (!t) textures.set(k, (t = arenaTexture(k, seed)));
    return t;
  };
  const rand = mulberry(seed);

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
    geo.translate((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const normal = geo.attributes.normal as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const top = new Float32Array(pos.count);
    // Small crates get one picture per face; big boxes painted as crates tile it every 2.5 m.
    const crateTile = b.kind === 'crate' && Math.max(sx, sy, sz) > 3 ? 2.5 : 0;
    // A little brightness jitter per box so neighbouring blocks of one kind don't merge into a single slab.
    const jitter = 0.95 + rand() * 0.08;
    for (let i = 0; i < pos.count; i++) {
      const nx = Math.abs(normal.getX(i));
      const ny = normal.getY(i);
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      // World-metre uvs, so textures line up across neighbouring boxes; crates keep one picture per face.
      if (b.kind !== 'crate' || crateTile) {
        const k = crateTile ? 1 / crateTile : 1;
        if (Math.abs(ny) > 0.5) uv.setXY(i, x * k, z * k);
        else if (nx > 0.5) uv.setXY(i, z * k, y * k);
        else uv.setXY(i, x * k, y * k);
      }
      // Undersides go dark and sides darken toward their foot: bridges and stairs read clearly from below.
      const k = ny > 0.5 ? 1 : ny < -0.5 ? 0.42 : y > b.min.y + 0.01 ? 1 : sy < 1.2 ? 0.7 : 0.8;
      colors.set([k * jitter, k * jitter, k * jitter], i * 3);
      top[i] = ny > 0.5 ? 1 : 0;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aTop', new THREE.BufferAttribute(top, 1));
    if (!isShellFloor(b, map.half)) {
      hulls.push(hullGeometry(geo));
      if (b.kind !== 'wall') creases.push(new THREE.EdgesGeometry(geo));
    }
    let list = byKind.get(b.kind);
    if (!list) byKind.set(b.kind, (list = []));
    list.push(geo);
  }

  for (const [kind, list] of byKind) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (!merged) continue;
    const mat = surfaceMaterial(map.tint?.[kind] ?? PALETTE[kind], theme.surfaces[kind] ?? BASE_SURFACES[kind], tex);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = kind !== 'floor' && kind !== 'wall';
    group.add(mesh);
    disposables.push(merged, mat);
  }
  const crease = mergeGeometries(creases, false);
  for (const g of creases) g.dispose();
  if (crease) {
    group.add(new THREE.LineSegments(crease, inkLineMaterial()));
    disposables.push(crease);
  }

  // ---- decoration buckets: toon props, unlit glow, additive fades, ink decals ----
  const solid = new Bucket();
  const glow = new Bucket();
  const fade = new Bucket();
  const decal = new Bucket();
  buildProps(map, theme, { solid, glow, fade });
  const hazards = edgeHazards(map, fade);
  if (hazards.stripes) {
    const mat = new THREE.MeshToonMaterial({ color: 0xffffff, map: tex('hazard'), gradientMap: toonRamp(), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(hazards.stripes, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(hazards.stripes, mat);
  }

  // ---- jump pads: a wide disc with a bright rim and an inner well, a beam of light, and a spinning arrow ring ----
  const spin = { value: 0 };
  const padRings: THREE.Mesh[] = [];
  for (const pad of map.pads) {
    const r = pad.radius * PAD_SCALE;
    const { x, y, z } = pad.pos;
    solid.add(at(new THREE.CylinderGeometry(r, r * 1.08, 0.16, 18), x, y + 0.08, z), accent);
    glow.add(at(new THREE.TorusGeometry(r * 0.95, 0.08, 3, 24).rotateX(Math.PI / 2), x, y + 0.17, z), 0xffffff);
    glow.add(at(new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.02, 18), x, y + 0.165, z), new THREE.Color(accent).multiplyScalar(0.55));
    const beamH = 3.2;
    fade.add(at(new THREE.CylinderGeometry(r * 0.8, r * 0.9, beamH, 18, 1, true), x, y + beamH / 2 + 0.1, z), accent, (_x, by) => (by < y + 0.2 ? 0.32 : 0));
    padRings.push(new THREE.Mesh());
  }
  if (map.pads.length) {
    const ring = new THREE.TorusGeometry(1, 0.07, 4, 6).rotateX(Math.PI / 2);
    const arrows: THREE.BufferGeometry[] = [ring];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      arrows.push(new THREE.ConeGeometry(0.16, 0.34, 4).translate(Math.cos(a), 0.12, Math.sin(a)));
    }
    const ringGeo = mergeGeometries(arrows, false);
    for (const g of arrows) g.dispose();
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    ringMat.onBeforeCompile = (shader) => {
      shader.uniforms.spin = spin;
      shader.vertexShader = 'uniform float spin;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float padPulse = sin(spin * 2.2 + float(gl_InstanceID) * 1.7);
        float ca = cos(spin);
        float sa = sin(spin);
        transformed.xz = mat2(ca, -sa, sa, ca) * transformed.xz * (1.0 + 0.1 * padPulse);
        transformed.y += 0.14 * (0.5 + 0.5 * padPulse);`,
      );
    };
    ringMat.customProgramCacheKey = () => 'padRing';
    const rings = new THREE.InstancedMesh(ringGeo, ringMat, map.pads.length);
    const m = new THREE.Matrix4();
    map.pads.forEach((pad, i) => {
      const k = pad.radius * PAD_SCALE * 0.7;
      rings.setMatrixAt(i, m.makeScale(k, k, k).setPosition(pad.pos.x, pad.pos.y + 0.3, pad.pos.z));
    });
    rings.frustumCulled = false;
    rings.onBeforeRender = () => {
      spin.value = padRings[0].rotation.z;
    };
    group.add(rings);
    disposables.push(ringGeo, ringMat);
  }

  // ---- health pack beacons: a ring on the floor and a soft beam, so pickups read from range ----
  for (const p of map.packs) {
    glow.add(at(new THREE.TorusGeometry(0.8, 0.06, 3, 20).rotateX(Math.PI / 2), p.x, p.y + 0.04, p.z), PACK_COLOR);
    fade.add(at(new THREE.CylinderGeometry(0.55, 0.65, 2.4, 14, 1, true), p.x, p.y + 1.2, p.z), PACK_COLOR, (_x, by) => (by < p.y + 0.1 ? 0.3 : 0));
  }

  // ---- spawn markers: inked hexagons on the floor ----
  for (const sp of map.spawns) decal.add(at(new THREE.RingGeometry(0.5, 0.6, 6).rotateX(-Math.PI / 2), sp.pos.x, sp.pos.y + 0.02, sp.pos.z), INK, 0.25);

  const solidGeo = solid.build();
  if (solidGeo) {
    const mat = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: toonRamp() });
    const mesh = new THREE.Mesh(solidGeo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
    hulls.push(hullGeometry(solidGeo));
    disposables.push(solidGeo, mat);
  }
  const hull = mergeGeometries(hulls, false);
  for (const g of hulls) g.dispose();
  if (hull) {
    group.add(new THREE.Mesh(hull, inkMaterial()));
    disposables.push(hull);
  }
  const glowGeo = glow.build();
  if (glowGeo) {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    group.add(new THREE.Mesh(glowGeo, mat));
    disposables.push(glowGeo, mat);
  }
  const fadeGeo = fade.build();
  if (fadeGeo) {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.spin = spin;
      shader.fragmentShader = 'uniform float spin;\n' + shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= 0.7 + 0.3 * sin(spin * 2.2);');
    };
    mat.customProgramCacheKey = () => 'arenaFade';
    const mesh = new THREE.Mesh(fadeGeo, mat);
    mesh.renderOrder = 2;
    group.add(mesh);
    disposables.push(fadeGeo, mat);
  }
  const decalGeo = decal.build();
  if (decalGeo) {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    group.add(new THREE.Mesh(decalGeo, mat));
    disposables.push(decalGeo, mat);
  }

  group.add(buildSky(map, theme, disposables));
  for (const t of textures.values()) disposables.push(t);
  chunkAll(group);

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

export function addArenaLights(scene: THREE.Scene, map: MapData) {
  scene.background = new THREE.Color(map.fogColor);
  // Light haze only: comic art keeps the far side readable.
  scene.fog = new THREE.Fog(map.fogColor, map.half * 1.6, Math.max(120, map.half * 5.5));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a6a, 1.6));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  sun.position.copy(SUN_DIR).multiplyScalar(Math.hypot(18, 30, 12));
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const half = map.half + 4;
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  // Depth range fitted to the map's boxes (plus room for players and rockets above the top), for depth precision.
  // The bias is a fraction of that range, so it is scaled to keep the same distance in metres as the old fixed fit.
  const dist = sun.position.length();
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of map.boxes) {
    if (b.kind === 'clip') continue;
    lo = Math.min(lo, b.min.y);
    hi = Math.max(hi, b.max.y);
  }
  if (lo > hi) lo = hi = 0;
  let nearest = Infinity;
  let farthest = -Infinity;
  for (const x of [-half, half])
    for (const y of [lo - 1, hi + 4])
      for (const z of [-half, half]) {
        const depth = dist - (x * SUN_DIR.x + y * SUN_DIR.y + z * SUN_DIR.z);
        nearest = Math.min(nearest, depth);
        farthest = Math.max(farthest, depth);
      }
  // May be negative on big maps (corners closer to the sun than the light sits): fine for an orthographic camera.
  sun.shadow.camera.near = nearest - 1;
  sun.shadow.camera.far = farthest + 1;
  const range = sun.shadow.camera.far - sun.shadow.camera.near;
  sun.shadow.bias = -0.0005 * ((40 + map.half * 3 - 1) / range);
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);
}
