// Set dressing for the hotel lobby: everything that makes it read as a grand hotel but never breaks (except what is
// mounted on breakable chunks, which goes with them). It is 2 am and the power is failing: most fixtures are dead, a
// few burn low and a handful stutter (`failing`), so the street light through the facade dominates the room.
//
// - Mezzanine galleries along the atrium's side walls (two levels: travertine slabs with a warm LED lip, glass
//   balustrades with brass handrails, upper-floor doorways), a coffered ceiling with recessed downlights.
// - Furniture from the map (sofas, armchairs, brass drum tables, floor lamps, planters, the centrepiece, stools, booths,
//   dining tables, a luggage cart): props.glb models when they exist, detailed primitive stand-ins otherwise.
// - Brass sconces on the columns and walls, the reception desk's underglow, flowers, desk lamps and a brass sign, a lit
//   bottle wall behind the bar, brass elevator doors, the revolving door, transoms across the glass facade.
//
// Lights that should show in the fog are returned as `glows` (a dead fixture's glow stays at 0). A handful of them are
// also real PointLights (budget per quality, the flickering ones first); the rest only glow and bloom.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec3 } from '@shared/math';
import { FURNITURE_SIZE, type FurnitureDef, type MapDef, type Mat, type WallDef } from '@shared/zombies/maps';
import { furnitureParts } from '@shared/zombies/furniture';
import { type World, forChunks } from '@shared/zombies/world';
import type { LampLight, Models, Quality } from './api';
import type { SetName, TexSet } from './textures';

export interface Glow {
  pos: Vec3;
  color: THREE.Color;
  /** Current intensity in the fog's flash units (see post.ts). */
  intensity: number;
}

export interface DecorMats {
  brass: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  travertine: THREE.MeshStandardMaterial;
  ceiling: THREE.MeshStandardMaterial;
  glass: THREE.Material;
  leaf: THREE.MeshStandardMaterial;
  bark: THREE.MeshStandardMaterial;
  texSet: (n: SetName) => TexSet;
}

export interface Decor {
  group: THREE.Group;
  glows: Glow[];
  lamps: (LampLight & { update(time: number): void })[];
  breakChunk(i: number): void;
  /** Health of a damaged furniture chunk (world.ts forwards them; walls show their own damage). */
  setChunkHp(i: number, hp: number): void;
  update(dt: number, time: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

const WARM = new THREE.Color(1.0, 0.72, 0.42);
/** Real point lights for sconces and lamps, per quality; the rest are glow-only. */
const POINT_BUDGET: Record<Quality, number> = { low: 0, medium: 6, high: 12 };

const box = (sx: number, sy: number, sz: number) => new THREE.BoxGeometry(sx, sy, sz);

/**
 * Brightness 0..1 of a failing lamp at `time`. `fail` 0 = a steady faint hum, 1 = dying: buzzing stutters (fast
 * drops to near-off) and now and then an outage of a second or two. Deterministic per `seed`, so every client agrees.
 */
export function failing(time: number, seed: number, fail: number): number {
  const hum = 0.97 + 0.03 * Math.sin(time * 2.1 + seed);
  if (fail <= 0) return hum;
  const out = Math.sin(time * 0.53 + seed * 0.7) + 0.6 * Math.sin(time * 0.91 + seed * 1.3);
  if (out > 1.58 - fail * 0.62) return 0.03;
  const buzz = Math.sin(time * 9 + seed) * Math.sin(time * 13.7 + seed * 2);
  if (buzz > 0.95 - fail * 0.45) return Math.sin(time * 61 + seed * 3) > 0 ? 0.12 : 0.55;
  return hum;
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

/** A material built from a texture set with plain mesh UVs (furniture), upgraded when the sharp set arrives. */
function setMaterial(set: TexSet, params: THREE.MeshStandardMaterialParameters, repeat = 1): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: set.map, normalMap: set.normalMap, roughnessMap: set.orm, metalnessMap: set.orm, roughness: 1, metalness: 1, ...params });
  const apply = (s: TexSet) => {
    for (const t of [s.map, s.normalMap, s.orm]) t.repeat.set(repeat, repeat);
    m.map = s.map;
    m.normalMap = s.normalMap;
    m.roughnessMap = s.orm;
    m.metalnessMap = s.orm;
    m.needsUpdate = true;
  };
  apply(set);
  set.onUpgrade(apply);
  return m;
}

/** The point on the inside face of a wall, `a` along it, `y` up, pushed `off` metres into the room. */
function wallPoint(w: WallDef, a: number, y: number, off: number): THREE.Vector3 {
  const f = w.fixed - w.out * off;
  return w.along === 'x' ? new THREE.Vector3(a, y, f) : new THREE.Vector3(f, y, a);
}


/**
 * Merges every static mesh under `root` that shares a material (and shadow flags) into one mesh, in place, to cut
 * draw calls. Skips instanced and skinned meshes, hidden ones, and anything under an object marked
 * `userData.noMerge` (things that are hidden later, like decor mounted on breakable chunks or window boards).
 */
export function mergeStatic(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const buckets = new Map<string, { mat: THREE.Material; mesh: THREE.Mesh; list: THREE.Mesh[] }>();
  const visit = (o: THREE.Object3D) => {
    if (o.userData.noMerge || !o.visible) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh && !Array.isArray(m.material) && m.geometry.getAttribute('position')) {
      const key = `${m.material.uuid}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}|${m.userData.noMoonShadow ? 1 : 0}|${m.renderOrder}`;
      const b = buckets.get(key);
      if (b) b.list.push(m);
      else buckets.set(key, { mat: m.material, mesh: m, list: [m] });
    }
    for (const c of o.children) visit(c);
  };
  for (const c of root.children) visit(c);
  const tmp = new THREE.Matrix4();
  for (const b of buckets.values()) {
    if (b.list.length < 2) continue;
    const geos: THREE.BufferGeometry[] = [];
    for (const m of b.list) {
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
      g.morphAttributes = {};
      g.applyMatrix4(tmp.multiplyMatrices(inv, m.matrixWorld));
      geos.push(g);
    }
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const out = new THREE.Mesh(merged, b.mat);
    out.castShadow = b.mesh.castShadow;
    out.receiveShadow = b.mesh.receiveShadow;
    out.renderOrder = b.mesh.renderOrder;
    out.userData.noMoonShadow = b.mesh.userData.noMoonShadow;
    out.userData.merged = true;
    // Cut-away furniture's shadow materials (a bucket shares one material, so one pair).
    out.customDepthMaterial = b.mesh.customDepthMaterial;
    out.customDistanceMaterial = b.mesh.customDistanceMaterial;
    root.add(out);
    for (const m of b.list) m.removeFromParent();
  }
}

// ---- furniture cut-away -------------------------------------------------------------------------------------------
// Furniture is chunks (furniture.ts), but drawn as whole models; where a chunk is gone, the fragment shader throws the
// model away inside that cell. The cells live in a float texture (in each piece's own frame, so a turned sofa is cut
// along its own seams), a coarse floor grid says which pieces can reach a point, and a per-piece row says where its
// cells start, how it is turned and whether it is touched at all (untouched pieces cost two texel fetches).
// - The cut edge is the union of dead cells' distance fields, roughened with value noise (±5 cm), with a charred /
//   frayed band outside it. Cut materials render both sides; a back face seen through a hole is the inside: foam in
//   upholstery, raw wood, soil in the pot, bright brass. Foliage and glass just vanish.
// - Damaged cells (setChunkHp) wear: darker, scuffed, frayed fabric, dull brass, crazed glass.
// - Shadows: every cut mesh gets a depth / distance material that discards the same way. (post.ts's own fog-shaft
//   depth passes use an override material and still see the whole piece.)

const CUT_MAT: Partial<Record<Mat, number>> = { fabric: 0, leather: 1, brass: 2, marble: 3, ceramic: 4, wood: 5, walnut: 6, foliage: 7, glass: 8 };
const CUT_W = 1024;
const GRID_CELL = 0.5;

const CUT_HEAD = /* glsl */ `
uniform highp sampler2D cutGrid;
uniform highp sampler2D cutFurn;
uniform highp sampler2D cutCells;
uniform vec3 cutGridInfo;
varying vec3 vCutW;
float cutD = 1e3;
float cutWear = 0.0;
float cutMat = -1.0;
float cutAct = 0.0;
float cutScuff = 0.0;
float cutHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float cutNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(cutHash(i), cutHash(i + vec3(1, 0, 0)), f.x), mix(cutHash(i + vec3(0, 1, 0)), cutHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(cutHash(i + vec3(0, 0, 1)), cutHash(i + vec3(1, 0, 1)), f.x), mix(cutHash(i + vec3(0, 1, 1)), cutHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float cutBox(vec3 p, vec3 a, vec3 b) {
  vec3 q = abs(p - (a + b) * 0.5) - (b - a) * 0.5;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
// Distance to the dead cells (cutD), wear of the cell we are in, material of the nearest live cell.
void cutEval(vec3 w) {
  ivec2 gs = textureSize(cutGrid, 0);
  ivec2 g = ivec2(floor((w.xz - cutGridInfo.xy) * cutGridInfo.z));
  if (g.x < 0 || g.y < 0 || g.x >= gs.x || g.y >= gs.y) return;
  vec4 ids = texelFetch(cutGrid, g, 0);
  float nearAlive = 1e3;
  for (int k = 0; k < 4; k++) {
    float id = ids[k];
    if (id < 0.5) break;
    int fi = int(id) - 1;
    vec4 info = texelFetch(cutFurn, ivec2(fi, 1), 0);
    if (info.z < 0.5) continue;
    cutAct = max(cutAct, info.z);
    vec4 pose = texelFetch(cutFurn, ivec2(fi, 0), 0);
    vec2 d = w.xz - pose.xy;
    vec3 lp = vec3(d.x * pose.z - d.y * pose.w, w.y, d.x * pose.w + d.y * pose.z);
    int s = int(info.x);
    int n = int(info.y);
    for (int c = 0; c < 48; c++) {
      if (c >= n) break;
      int t = (s + c) * 2;
      vec4 a = texelFetch(cutCells, ivec2(t & ${CUT_W - 1}, t >> ${Math.log2(CUT_W)}), 0);
      vec4 b = texelFetch(cutCells, ivec2((t + 1) & ${CUT_W - 1}, (t + 1) >> ${Math.log2(CUT_W)}), 0);
      float sd = cutBox(lp, a.xyz, b.xyz);
      if (a.w > 0.5 || info.z > 1.5) cutD = min(cutD, sd);
      else {
        if (sd < nearAlive) {
          nearAlive = sd;
          cutMat = floor(b.w);
        }
        float dm = fract(b.w);
        if (dm > 0.0) cutWear = max(cutWear, dm * (1.0 - smoothstep(0.0, 0.03, sd)));
      }
    }
  }
}
`;

const CUT_VERT = /* glsl */ `#include <project_vertex>
{
  vec4 cutP = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  cutP = instanceMatrix * cutP;
#endif
  vCutW = (modelMatrix * cutP).xyz;
}`;

// Shared start of every cut fragment shader: evaluate, discard, and decide inside / band.
const CUT_FRAG_MAIN = /* glsl */ `#include <clipping_planes_fragment>
cutEval(vCutW);
float cutN1 = cutAct > 0.5 ? cutNoise(vCutW * 9.0) * 0.65 + cutNoise(vCutW * 27.0) * 0.35 : 0.5;
float cutEdge = cutD + (cutN1 - 0.5) * 0.14;
if (cutAct > 1.5 && cutD < 0.1) discard;
if (cutEdge < 0.0) discard;
int cutM = int(cutMat + 0.5);
// A back face of a shot piece is its inside (glTF upholstery is double-sided too); leaves and glass have none.
// Facing by the vertex normal, not the winding: some glTF meshes are wound inside out.
#ifdef FLAT_SHADED
bool cutBackish = !gl_FrontFacing;
#else
bool cutBackish = dot(vNormal, vViewPosition) < 0.0;
#endif
bool cutIn = cutBackish && cutAct > 0.5 && cutM < 7;
#ifdef CUT_SINGLE
if (!gl_FrontFacing && !cutIn) discard;
#endif
float cutBand = cutAct > 0.5 ? 1.0 - smoothstep(0.0, 0.03 + cutN1 * 0.04, cutEdge) : 0.0;
`;

const CUT_COLOR = /* glsl */ `#include <color_fragment>
if (cutAct > 0.5) {
  if (cutIn) {
    // The inside: foam, raw brass, pale stone, soil, raw wood.
    vec3 ic = cutM <= 1 ? vec3(0.78, 0.62, 0.22) : cutM == 2 ? vec3(0.5, 0.36, 0.2) : cutM == 3 ? vec3(0.62, 0.6, 0.56) : cutM == 4 ? vec3(0.035, 0.022, 0.012) : cutM <= 6 ? vec3(0.6, 0.38, 0.18) : vec3(0.3);
    diffuseColor.rgb = ic * (0.7 + 0.6 * cutN1);
  } else {
    float fib = cutNoise(vCutW * vec3(70.0, 18.0, 70.0));
    // Fabric frays into pale foam fibres and dark threads; pottery shows its biscuit; brass is torn bright; wood
    // and stone char.
    vec3 bc = cutM <= 1 ? mix(diffuseColor.rgb * 0.25, vec3(0.75, 0.6, 0.25), step(0.55, fib) * smoothstep(0.6, 1.0, cutBand))
      : cutM == 4 ? vec3(0.6, 0.45, 0.3) : cutM == 2 ? vec3(0.9, 0.68, 0.38) : cutM == 3 ? vec3(0.5, 0.48, 0.45) : cutM == 7 ? vec3(0.12, 0.08, 0.03) : vec3(0.025, 0.018, 0.012);
    diffuseColor.rgb = mix(diffuseColor.rgb, bc, cutBand * 0.9);
    if (cutWear > 0.0) {
      if (cutM == 2) diffuseColor.rgb *= 1.0 - 0.3 * cutWear;
      float wn = cutNoise(vCutW * 31.0) * 0.65 + cutNoise(vCutW * 97.0) * 0.35;
      float wr = cutWear * smoothstep(0.62 - cutWear * 0.5, 0.9 - cutWear * 0.5, wn);
      cutScuff = wr;
      diffuseColor.rgb *= 1.0 - (cutM <= 1 ? 0.75 : cutM == 2 ? 0.5 : 0.6) * wr;
      if (cutM == 8) {
        // Crazing: thin bright lines along the noise's level sets.
        float cr = 1.0 - smoothstep(0.0, 0.035, abs(cutNoise(vCutW * 26.0) - 0.5));
        diffuseColor.rgb += vec3(0.6) * cr * cutWear;
        diffuseColor.a = max(diffuseColor.a, cr * cutWear);
      }
    }
  }
}`;

const CUT_PBR = /* glsl */ `#include <metalnessmap_fragment>
if (cutAct > 0.5) {
  if (cutIn) {
    roughnessFactor = cutM == 2 ? 0.55 : 0.95;
    metalnessFactor = cutM == 2 ? 1.0 : 0.0;
  } else {
    roughnessFactor = mix(roughnessFactor, cutM == 2 ? 0.3 : 1.0, cutBand);
    if (cutM == 2) {
      // Dull brass: a rougher, darker metal, never a painted look.
      roughnessFactor = mix(roughnessFactor, 0.55, min(1.0, cutWear * 0.25 + cutScuff));
    } else {
      metalnessFactor *= 1.0 - cutBand;
      roughnessFactor = mix(roughnessFactor, 1.0, cutWear * 0.6);
    }
  }
}`;

const CUT_EMIT = /* glsl */ `#include <emissivemap_fragment>
if (cutAct > 0.5) totalEmissiveRadiance *= cutIn ? 0.15 : 1.0 - cutBand;`;

const CUT_DEPTH_MAIN = /* glsl */ `#include <clipping_planes_fragment>
cutEval(vCutW);
if (cutAct > 0.5) {
  if (cutAct > 1.5 && cutD < 0.1) discard;
  if (cutD + (cutNoise(vCutW * 9.0) * 0.65 + cutNoise(vCutW * 27.0) * 0.35 - 0.5) * 0.14 < 0.0) discard;
}`;

interface FurnitureCut {
  /** Swaps every mesh under `root` to its cut material (plus shadow materials). */
  apply(root: THREE.Object3D): void;
  /** The cut version of a material, for swapping a lamp's shade or bulb later. */
  of(m: THREE.Material): THREE.Material;
  breakChunk(i: number): void;
  setChunkHp(i: number, hp: number): void;
  update(): void;
  dispose(): void;
}

function furnitureCut(world: World): FurnitureCut {
  const pieces = world.furniture;
  const nF = Math.max(1, pieces.length);
  const nCells = pieces.reduce((s, f) => s + (f.c1 - f.c0), 0);
  const rows = Math.max(1, Math.ceil((nCells * 2) / CUT_W));
  const cells = new Float32Array(CUT_W * rows * 4);
  const furn = new Float32Array(nF * 2 * 4);
  const slotOf = new Int32Array(world.chunks.length).fill(-1);
  let start = 0;
  pieces.forEach((f, fi) => {
    furn.set([f.x, f.z, Math.cos(f.yaw), Math.sin(f.yaw)], fi * 4);
    // The same cells as furniture.ts's furnitureCells, but in the piece's own frame. Faces on a part's outside
    // reach a little further, so a model that bulges past the part box still goes with its cell; foliage
    // reaches a lot further sideways and up (leaf cards stick out of the canopy).
    const local: { min: number[]; max: number[]; mat: number }[] = [];
    for (const p of furnitureParts(f.kind)) {
      const n = [p.max.x - p.min.x, p.max.y - p.min.y, p.max.z - p.min.z].map((len) => Math.max(1, Math.ceil(len / p.cell - 1e-6)));
      const sz = [(p.max.x - p.min.x) / n[0], (p.max.y - p.min.y) / n[1], (p.max.z - p.min.z) / n[2]];
      const lo = [p.min.x, p.min.y, p.min.z];
      const leafy = p.mat === 'foliage';
      const out = leafy ? 0.32 : 0.05;
      for (let i = 0; i < n[0]; i++)
        for (let j = 0; j < n[1]; j++)
          for (let k = 0; k < n[2]; k++) {
            const idx = [i, j, k];
            const mn = idx.map((q, a) => lo[a] + q * sz[a] - (q === 0 ? (a === 1 ? (leafy ? 0 : 0.03) : out) : 0));
            const mx = idx.map((q, a) => lo[a] + (q + 1) * sz[a] + (q === n[a] - 1 ? out : 0));
            local.push({ min: mn, max: mx, mat: CUT_MAT[p.mat] ?? 9 });
          }
    }
    const count = f.c1 - f.c0;
    if (local.length !== count) {
      console.warn(`[decor] furniture ${fi} (${f.kind}): ${local.length} cells, ${count} chunks; not cut`);
      furn.set([start, 0, 0, 0], (nF + fi) * 4);
      return;
    }
    local.forEach((c, k) => {
      const o = (start + k) * 8;
      cells.set([c.min[0], c.min[1], c.min[2], 0, c.max[0], c.max[1], c.max[2], c.mat], o);
      slotOf[f.c0 + k] = start + k;
    });
    furn.set([start, count, 0, 0], (nF + fi) * 4);
    start += count;
  });
  const cellTex = new THREE.DataTexture(cells, CUT_W, rows, THREE.RGBAFormat, THREE.FloatType);
  const furnTex = new THREE.DataTexture(furn, nF, 2, THREE.RGBAFormat, THREE.FloatType);
  // Floor grid: up to four pieces (index + 1) whose reach overlaps each 0.5 m square.
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  // Each piece's reach: its chunks (foliage can stand well past the footprint) plus the cells' padding and noise.
  const reach = pieces.map((f) => {
    const r = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
    for (let i = f.c0; i < f.c1; i++) {
      const c = world.chunks[i];
      r.minX = Math.min(r.minX, c.min.x - 0.45);
      r.minZ = Math.min(r.minZ, c.min.z - 0.45);
      r.maxX = Math.max(r.maxX, c.max.x + 0.45);
      r.maxZ = Math.max(r.maxZ, c.max.z + 0.45);
    }
    if (f.c1 <= f.c0) Object.assign(r, { minX: f.box.min.x, minZ: f.box.min.z, maxX: f.box.max.x, maxZ: f.box.max.z });
    return r;
  });
  for (const r of reach) {
    x0 = Math.min(x0, r.minX);
    z0 = Math.min(z0, r.minZ);
    x1 = Math.max(x1, r.maxX);
    z1 = Math.max(z1, r.maxZ);
  }
  if (!pieces.length) x0 = z0 = x1 = z1 = 0;
  const gw = Math.max(1, Math.ceil((x1 - x0) / GRID_CELL));
  const gh = Math.max(1, Math.ceil((z1 - z0) / GRID_CELL));
  const grid = new Float32Array(gw * gh * 4);
  reach.forEach((r, fi) => {
    const a0 = Math.max(0, Math.floor((r.minX - x0) / GRID_CELL));
    const a1 = Math.min(gw - 1, Math.floor((r.maxX - x0) / GRID_CELL));
    const b0 = Math.max(0, Math.floor((r.minZ - z0) / GRID_CELL));
    const b1 = Math.min(gh - 1, Math.floor((r.maxZ - z0) / GRID_CELL));
    for (let b = b0; b <= b1; b++)
      for (let a = a0; a <= a1; a++) {
        const o = (b * gw + a) * 4;
        for (let k = 0; k < 4; k++)
          if (grid[o + k] === 0) {
            grid[o + k] = fi + 1;
            break;
          }
      }
  });
  const gridTex = new THREE.DataTexture(grid, gw, gh, THREE.RGBAFormat, THREE.FloatType);
  for (const t of [cellTex, furnTex, gridTex]) t.needsUpdate = true;
  const uniforms = {
    cutGrid: { value: gridTex },
    cutFurn: { value: furnTex },
    cutCells: { value: cellTex },
    cutGridInfo: { value: new THREE.Vector3(x0, z0, 1 / GRID_CELL) },
  };
  const patch = (m: THREE.Material, depth: boolean) => {
    const prev = m.onBeforeCompile;
    const prevKey = m.customProgramCacheKey.bind(m);
    m.onBeforeCompile = (sh, r) => {
      prev.call(m, sh, r);
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = 'varying vec3 vCutW;\n' + sh.vertexShader.replace('#include <project_vertex>', CUT_VERT);
      let fs = CUT_HEAD + sh.fragmentShader;
      if (depth) fs = fs.replace('#include <clipping_planes_fragment>', CUT_DEPTH_MAIN);
      else
        fs = fs
          .replace('#include <clipping_planes_fragment>', CUT_FRAG_MAIN)
          .replace('#include <color_fragment>', CUT_COLOR)
          .replace('#include <metalnessmap_fragment>', CUT_PBR)
          .replace('#include <emissivemap_fragment>', CUT_EMIT);
      sh.fragmentShader = fs;
    };
    m.customProgramCacheKey = () => `cut${depth ? 'd' : ''}|${m.defines?.CUT_SINGLE !== undefined ? 1 : 0}|${prevKey()}`;
  };
  const made: THREE.Material[] = [];
  const cutOf = new Map<THREE.Material, THREE.Material>();
  const shadowOf = new Map<THREE.Material, [THREE.MeshDepthMaterial, THREE.MeshDistanceMaterial]>();
  const of = (m: THREE.Material): THREE.Material => {
    if (m.userData.cut) return m;
    const known = cutOf.get(m);
    if (known) return known;
    // A stuttering fixture's own material is patched in place (update() drives it); everything else is cloned so
    // the same material elsewhere in the lobby stays a plain one.
    const c = m.userData.ownFixture ? m : m.clone();
    if (c !== m) {
      // clone() drops shader patches (projMaterial's world-projected UVs): carry them over.
      c.onBeforeCompile = m.onBeforeCompile;
      c.customProgramCacheKey = m.customProgramCacheKey;
      made.push(c);
    }
    c.userData.cut = true;
    if (c.side === THREE.FrontSide) {
      c.defines = { ...(c.defines ?? {}), CUT_SINGLE: '' };
      c.side = THREE.DoubleSide;
      // Shadows stay as before: a FrontSide material casts with its back faces.
      c.shadowSide = THREE.BackSide;
    }
    patch(c, false);
    c.needsUpdate = true;
    cutOf.set(m, c);
    const d = new THREE.MeshDepthMaterial();
    const dist = new THREE.MeshDistanceMaterial();
    patch(d, true);
    patch(dist, true);
    made.push(d, dist);
    shadowOf.set(c, [d, dist]);
    return c;
  };
  const apply = (root: THREE.Object3D) =>
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      mesh.material = of(mesh.material);
      const sh = shadowOf.get(mesh.material);
      if (sh) [mesh.customDepthMaterial, mesh.customDistanceMaterial] = sh;
    });
  let dirty = false;
  const touch = (fi: number) => {
    const f = pieces[fi];
    const o = (nF + fi) * 4;
    let all = true;
    for (let i = f.c0; i < f.c1 && all; i++) if (slotOf[i] >= 0 && cells[slotOf[i] * 8 + 3] < 0.5) all = false;
    furn[o + 2] = all ? 2 : 1;
    dirty = true;
  };
  return {
    apply,
    of,
    breakChunk(i) {
      const s = slotOf[i];
      const fi = world.chunks[i]?.furn;
      if (s < 0 || fi === undefined) return;
      cells[s * 8 + 3] = 1;
      touch(fi);
    },
    setChunkHp(i, hp) {
      const s = slotOf[i];
      const c = world.chunks[i];
      if (s < 0 || c?.furn === undefined) return;
      const dmg = Math.min(0.99, Math.max(0, 1 - hp / c.maxHp));
      const o = s * 8 + 7;
      cells[o] = Math.floor(cells[o]) + dmg;
      touch(c.furn);
    },
    update() {
      if (!dirty) return;
      dirty = false;
      cellTex.needsUpdate = true;
      furnTex.needsUpdate = true;
    },
    dispose() {
      for (const m of made) m.dispose();
      for (const t of [cellTex, furnTex, gridTex]) t.dispose();
    },
  };
}

export function buildDecor(world: World, mats: DecorMats, quality: Quality, models: Models): Decor {
  const def = world.def as MapDef;
  const group = new THREE.Group();
  group.name = 'decor';
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(d: T) => (disposables.push(d), d);
  const glows: Glow[] = [];
  const rnd = seeded(9091);
  const walls = new Map((def.walls ?? []).map((w) => [w.id, w]));

  // ---- materials ---------------------------------------------------------------------------------------------
  const fabric = keep(setMaterial(mats.texSet('fabric'), { color: 0xeae2d4, envMapIntensity: 0.3 }, 3));
  const fabricDark = keep(setMaterial(mats.texSet('fabric'), { color: 0x2a2e36, envMapIntensity: 0.3 }, 3));
  const leather = keep(setMaterial(mats.texSet('leather'), { color: 0xffffff, envMapIntensity: 0.6 }, 3));
  const marble = keep(setMaterial(mats.texSet('marbleSlab'), { envMapIntensity: 1.1 }, 1));
  const walnut = keep(setMaterial(mats.texSet('walnut'), { envMapIntensity: 0.8 }, 1));
  // Fixtures come in three states: lit (burning low on failing power), dead, and stuttering (own material clones).
  const shadeMat = keep(new THREE.MeshStandardMaterial({ color: 0xf3e6cc, roughness: 0.8, emissive: WARM.clone(), emissiveIntensity: 0.45, side: THREE.DoubleSide }));
  const shadeDead = keep(new THREE.MeshStandardMaterial({ color: 0x8a8070, roughness: 0.85, side: THREE.DoubleSide }));
  const lampGlow = keep(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: WARM.clone(), emissiveIntensity: 2.6 }));
  const glowDead = keep(new THREE.MeshStandardMaterial({ color: 0x1a1612, roughness: 0.3, emissive: WARM.clone(), emissiveIntensity: 0.03 }));
  const ledMat = keep(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1.0, 0.68, 0.36), emissiveIntensity: 0.6 }));
  const ledDead = keep(new THREE.MeshStandardMaterial({ color: 0x14110e, roughness: 0.4, emissive: new THREE.Color(1.0, 0.68, 0.36), emissiveIntensity: 0.04 }));
  const downlight = keep(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1, 0.86, 0.66), emissiveIntensity: 1.8 }));
  const downDead = keep(new THREE.MeshStandardMaterial({ color: 0x1c1a17, roughness: 0.3, emissive: new THREE.Color(1, 0.86, 0.66), emissiveIntensity: 0.02 }));
  const darkMat = keep(new THREE.MeshStandardMaterial({ color: 0x0b0a09, roughness: 0.6 }));
  const potMat = keep(new THREE.MeshStandardMaterial({ color: 0x14130f, roughness: 0.35, metalness: 0.2, envMapIntensity: 0.8 }));
  const soilMat = keep(new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 1 }));
  const petal = keep(new THREE.MeshStandardMaterial({ color: 0xfbf6ec, roughness: 0.65 }));
  const stem = keep(new THREE.MeshStandardMaterial({ color: 0x4d6b2c, roughness: 0.7 }));
  const vase = keep(new THREE.MeshPhysicalMaterial({ color: 0xe8f0ec, roughness: 0.05, transmission: 0.6, transparent: true, opacity: 0.45, envMapIntensity: 1.5 }));
  const cloth = keep(new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.85 }));
  const lacquer = keep(new THREE.MeshStandardMaterial({ color: 0x0d0b09, roughness: 0.14, metalness: 0.35, envMapIntensity: 1.4 }));
  const bottleMats = [0x3d5a2a, 0x6a3a14, 0x8a6a30, 0x2c3a44, 0xb0b8a0].map((c) =>
    keep(new THREE.MeshStandardMaterial({ color: c, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.85, emissive: new THREE.Color(c).multiplyScalar(0.05) })),
  );

  // Point lights from a shared pool; the flickering candidates get one first, then the strongest.
  type Fix = { mat: THREE.MeshStandardMaterial; matBase: number; glow: Glow; glowBase: number; seed: number; fail: number; light: THREE.PointLight | null; power: number };
  type Cand = { pos: THREE.Vector3; color: THREE.Color; power: number; range: number; fix?: Fix; light?: THREE.PointLight; out?: boolean };
  const pointCandidates: Cand[] = [];
  /** What the last fixture() lit, so a furniture lamp can be put out when it is shot to pieces. */
  type LampRef = { glow: Glow | null; fix: Fix | null; cand: Cand | null };
  let lastLamp: LampRef = { glow: null, fix: null, cand: null };
  const flickers: Fix[] = [];
  const addGlow = (pos: THREE.Vector3, color: THREE.Color, intensity: number, light = 0, range = 6) => {
    const glow: Glow = { pos: { x: pos.x, y: pos.y, z: pos.z }, color: color.clone(), intensity };
    glows.push(glow);
    if (light > 0) pointCandidates.push({ pos: pos.clone(), color: color.clone(), power: light, range });
    return glow;
  };
  // Which fixtures still work: a fixed draw per fixture, independent of the furniture's random stream.
  const fixRnd = seeded(4242);
  type FixState = 'lit' | 'dead' | 'flicker';
  const pickState = (pLit: number, pFlicker: number): FixState => {
    const r = fixRnd();
    return r < pFlicker ? 'flicker' : r < pFlicker + pLit ? 'lit' : 'dead';
  };
  /**
   * A light fixture in the given state: lit ones glow at `lit` x their nominal strength, dead ones not at all, and
   * stuttering ones get their own material clone and are driven by `failing` in update. Returns the material to use.
   */
  const fixture = (state: FixState, mat: THREE.MeshStandardMaterial, dead: THREE.MeshStandardMaterial, pos: THREE.Vector3, color: THREE.Color, glowI: number, light = 0, range = 6, lit = 0.5) => {
    const n0 = pointCandidates.length;
    lastLamp = { glow: null, fix: null, cand: null };
    if (state === 'dead') return dead;
    if (state === 'lit') {
      lastLamp.glow = addGlow(pos, color, glowI * lit, light * lit, range);
      lastLamp.cand = pointCandidates.length > n0 ? pointCandidates[n0] : null;
      return mat;
    }
    const own = keep(mat.clone());
    own.userData.ownFixture = true;
    own.emissiveIntensity = mat.emissiveIntensity * 1.6;
    const glow = addGlow(pos, color, glowI, light, range);
    const fix: Fix = { mat: own, matBase: own.emissiveIntensity, glow, glowBase: glowI, seed: flickers.length * 5.17 + 0.3, fail: 0.55 + fixRnd() * 0.45, light: null, power: light };
    if (light > 0) pointCandidates[pointCandidates.length - 1].fix = fix;
    flickers.push(fix);
    lastLamp = { glow, fix, cand: pointCandidates.length > n0 ? pointCandidates[n0] : null };
    return own;
  };

  // Decor mounted on chunks: chunk index -> objects to hide when it breaks.
  const onChunk = new Map<number, THREE.Object3D[]>();
  const mount = (o: THREE.Object3D, p: THREE.Vector3) => {
    o.userData.noMerge = true;
    const probe = { min: { x: p.x - 0.3, y: p.y - 0.05, z: p.z - 0.3 }, max: { x: p.x + 0.3, y: p.y + 0.05, z: p.z + 0.3 } };
    let best = -1;
    let bestD = Infinity;
    forChunks(world, probe, (i) => {
      const c = world.chunks[i];
      if (c.furn !== undefined) return;
      const dx = Math.max(c.min.x - p.x, 0, p.x - c.max.x);
      const dy = Math.max(c.min.y - p.y, 0, p.y - c.max.y);
      const dz = Math.max(c.min.z - p.z, 0, p.z - c.max.z);
      const d = dx + dy + dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0 && bestD < 0.35) {
      const list = onChunk.get(best) ?? [];
      list.push(o);
      onChunk.set(best, list);
    }
  };

  // ---- mezzanine galleries -------------------------------------------------------------------------------------
  const atrium = def.zones?.find((z) => z.id === 'atrium')?.rect ?? world.interior;
  const atriumH = def.zones?.find((z) => z.id === 'atrium')?.h ?? world.height;
  // Railing runs, swapped for props_arch's glassRailing segments once the models load.
  const railRuns: { w: WallDef; a0: number; a1: number; top: number; off: number; prims: THREE.Object3D[] }[] = [];
  for (const m of def.mezzanine ?? []) {
    const w = walls.get(m.wall);
    if (!w) continue;
    const levels = atriumH >= 11 ? [m.y, m.y + 3.6] : [m.y];
    // Stop short of the facade and the south wall.
    const a0 = Math.max(w.a0, w.along === 'z' ? atrium.minZ : atrium.minX) + 0.25;
    const a1 = Math.min(w.a1, w.along === 'z' ? atrium.maxZ : atrium.maxX) - 0.25;
    const len = a1 - a0;
    const mid = (a0 + a1) / 2;
    const depth = m.depth;
    for (const [li, y] of levels.entries()) {
      // The walkable-looking slab matches the map's mezzanine solid (top at y + 0.35), with a deeper fascia.
      const slabT = 0.5;
      const top = y + 0.35;
      const center = wallPoint(w, mid, top - slabT / 2, depth / 2);
      const sx = w.along === 'x' ? len : depth;
      const sz = w.along === 'x' ? depth : len;
      const slab = new THREE.Mesh(keep(box(sx, slabT, sz)), mats.travertine);
      slab.position.copy(center);
      slab.castShadow = slab.receiveShadow = true;
      group.add(slab);
      // Fascia: a taller travertine band with a brass reveal and a warm LED strip under its lip.
      const lip = wallPoint(w, mid, top - slabT - 0.03, depth - 0.02);
      const led = new THREE.Mesh(keep(box(w.along === 'x' ? len : 0.04, 0.025, w.along === 'x' ? 0.04 : len)), li === 0 ? ledMat : ledDead);
      led.position.copy(lip);
      led.userData.noMoonShadow = true;
      group.add(led);
      const trim = new THREE.Mesh(keep(box(w.along === 'x' ? len : 0.03, 0.05, w.along === 'x' ? 0.03 : len)), mats.brass);
      trim.position.copy(wallPoint(w, mid, top - 0.12, depth + 0.005));
      group.add(trim);
      // Recessed downlights in the soffit.
      const dl = keep(new THREE.CircleGeometry(0.07, 16).rotateX(Math.PI / 2));
      for (let a = a0 + 1.5; a < a1 - 1; a += 3) {
        const p = wallPoint(w, a, top - slabT - 0.002, depth * 0.55);
        const d = new THREE.Mesh(dl, fixture(pickState(0.2, 0.08), downlight, downDead, p.clone().add(new THREE.Vector3(0, -0.15, 0)), WARM, 1.2, li === 0 ? 3 : 0, 5));
        d.position.copy(p);
        d.userData.noMoonShadow = true;
        group.add(d);
      }
      // Glass balustrade with brass posts and handrail.
      const railH = 1.08;
      const glassPanel = new THREE.Mesh(keep(box(w.along === 'x' ? len : 0.02, railH - 0.1, w.along === 'x' ? 0.02 : len)), mats.glass);
      glassPanel.position.copy(wallPoint(w, mid, top + (railH - 0.1) / 2, depth - 0.06));
      glassPanel.userData.noMoonShadow = true;
      glassPanel.renderOrder = 2;
      group.add(glassPanel);
      const hand = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.03, 0.03, len, 10).rotateZ(Math.PI / 2)), mats.brass);
      if (w.along === 'z') hand.rotation.y = Math.PI / 2;
      hand.position.copy(wallPoint(w, mid, top + railH, depth - 0.06));
      hand.castShadow = true;
      group.add(hand);
      const posts: THREE.BufferGeometry[] = [];
      for (let a = a0; a <= a1 + 0.01; a += 1.5) {
        const p = wallPoint(w, a, top + railH / 2, depth - 0.06);
        posts.push(new THREE.CylinderGeometry(0.018, 0.018, railH, 8).translate(p.x, p.y, p.z));
      }
      const pm = new THREE.Mesh(keep(mergeGeometries(posts)), mats.brass);
      for (const p of posts) p.dispose();
      pm.castShadow = true;
      group.add(pm);
      railRuns.push({ w, a0, a1, top, off: depth - 0.06, prims: [glassPanel, hand, pm] });
      // Upper-floor doorways: dark recesses in brass frames, with a warm wall light between them.
      for (let a = a0 + 2; a < a1 - 1.5; a += 4.5) {
        const door = new THREE.Mesh(keep(box(w.along === 'x' ? 1.1 : 0.04, 2.3, w.along === 'x' ? 0.04 : 1.1)), walnut);
        door.position.copy(wallPoint(w, a, top + 1.15, 0.02));
        group.add(door);
        const fr = new THREE.Mesh(keep(box(w.along === 'x' ? 1.24 : 0.05, 2.42, w.along === 'x' ? 0.05 : 1.24)), mats.brass);
        fr.position.copy(wallPoint(w, a, top + 1.2, 0.0));
        group.add(fr);
        const sp = wallPoint(w, a + 2.25, top + 1.8, 0.05);
        const sc = new THREE.Mesh(keep(box(w.along === 'x' ? 0.08 : 0.06, 0.38, w.along === 'x' ? 0.06 : 0.08)), fixture(pickState(0.25, 0.1), lampGlow, glowDead, sp, WARM, 0.8));
        sc.position.copy(sp);
        sc.userData.noMoonShadow = true;
        group.add(sc);
      }
    }
  }

  // ---- coffered ceiling with downlights (atrium) ------------------------------------------------------------------
  {
    const parts: THREE.BufferGeometry[] = [];
    const y = atriumH - 0.25;
    const cw = atrium.maxX - atrium.minX;
    const cd = atrium.maxZ - atrium.minZ;
    for (let x = atrium.minX + 3; x < atrium.maxX - 0.5; x += 3) parts.push(box(0.35, 0.5, cd).translate(x, y, (atrium.minZ + atrium.maxZ) / 2));
    for (let z = atrium.minZ + 3; z < atrium.maxZ - 0.5; z += 3) parts.push(box(cw, 0.5, 0.35).translate((atrium.minX + atrium.maxX) / 2, y, z));
    const coffers = new THREE.Mesh(keep(mergeGeometries(parts)), mats.ceiling);
    for (const p of parts) p.dispose();
    coffers.castShadow = true;
    coffers.receiveShadow = true;
    group.add(coffers);
    const dl = keep(new THREE.CircleGeometry(0.11, 16).rotateX(Math.PI / 2));
    for (let x = atrium.minX + 1.5; x < atrium.maxX; x += 3)
      for (let z = atrium.minZ + 1.5; z < atrium.maxZ; z += 3) {
        // Nearly all dead; the odd one still burns.
        const d = new THREE.Mesh(dl, fixRnd() < 0.12 ? downlight : downDead);
        d.position.set(x, atriumH - 0.01, z);
        d.userData.noMoonShadow = true;
        group.add(d);
      }
  }

  // ---- furniture ------------------------------------------------------------------------------------------------
  const furnitureFallback = (f: FurnitureDef): THREE.Group => {
    const g = new THREE.Group();
    const s = FURNITURE_SIZE[f.kind];
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, shadow = true) => {
      const m = new THREE.Mesh(keep(geo), mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    const legs = (w: number, d: number, hgt: number) => {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.CylinderGeometry(0.018, 0.014, hgt, 6), mats.brass, sx * (w / 2 - 0.06), hgt / 2, sz * (d / 2 - 0.06));
    };
    switch (f.kind) {
      case 'sofa':
      case 'armchair': {
        // Low brass legs, a plinth seat, a deep back and rounded arms; loose cushions on the sofa.
        const w = s.w;
        const d = s.d;
        legs(w - 0.1, d - 0.1, 0.12);
        add(new THREE.BoxGeometry(w, 0.3, d), fabric, 0, 0.27, 0);
        add(new THREE.BoxGeometry(w, 0.48, 0.22), fabric, 0, 0.6, d / 2 - 0.11);
        for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.18, 0.28, d), fabric, sx * (w / 2 - 0.09), 0.54, 0);
        const seats = f.kind === 'sofa' ? 3 : 1;
        const sw = (w - 0.36) / seats;
        for (let k = 0; k < seats; k++) {
          add(new THREE.BoxGeometry(sw - 0.02, 0.12, d - 0.3), fabric, -w / 2 + 0.18 + sw * (k + 0.5), 0.47, -0.08);
          if (f.kind === 'sofa' && k !== 1) add(new THREE.BoxGeometry(0.42, 0.4, 0.12), k === 0 ? fabricDark : fabric, -w / 2 + 0.18 + sw * (k + 0.5), 0.7, d / 2 - 0.3).rotation.x = -0.25;
        }
        break;
      }
      case 'coffeeTable':
      case 'sideTable': {
        // A brushed brass drum with a black marble top; a table lamp on the side tables.
        const r = s.w / 2;
        add(new THREE.CylinderGeometry(r * 0.94, r * 0.94, s.h - 0.03, 40, 1, true), mats.brass, 0, (s.h - 0.03) / 2, 0);
        add(new THREE.CylinderGeometry(r, r, 0.03, 40), marble, 0, s.h - 0.015, 0);
        if (f.kind === 'sideTable') {
          add(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 8), mats.brass, 0, s.h + 0.21, 0);
          const p = new THREE.Vector3(f.x, s.h + 0.4, f.z);
          const state = pickState(0.3, 0.1);
          g.userData.lit = { glow: fixture(state, lampGlow, glowDead, p, WARM, 1.6, 1.4, 4), shade: state === 'dead' ? shadeDead : shadeMat };
          g.userData.lamp = lastLamp;
          const sh = add(new THREE.CylinderGeometry(0.14, 0.17, 0.2, 24, 1, true), g.userData.lit.shade, 0, s.h + 0.46, 0, false);
          sh.userData.noMoonShadow = true;
        } else {
          // A brass tray and a small bowl of flowers.
          add(new THREE.CylinderGeometry(0.18, 0.15, 0.03, 24), mats.brass, 0.15, s.h + 0.015, 0.1);
          for (let k = 0; k < 7; k++) add(new THREE.SphereGeometry(0.035, 8, 6), petal, -0.15 + (rnd() - 0.5) * 0.12, s.h + 0.12 + rnd() * 0.05, -0.1 + (rnd() - 0.5) * 0.12, false);
        }
        break;
      }
      case 'floorLamp': {
        add(new THREE.CylinderGeometry(0.16, 0.18, 0.03, 24), mats.brass, 0, 0.015, 0);
        add(new THREE.CylinderGeometry(0.014, 0.014, 1.4, 8), mats.brass, 0, 0.72, 0);
        // Floor lamps are the lobby's last working lights: most still on, low.
        const p = new THREE.Vector3(f.x, 1.45, f.z);
        const state = pickState(0.6, 0.2);
        g.userData.lit = { glow: fixture(state, lampGlow, glowDead, p, WARM, 2.2, 2.2, 5, 0.6), shade: state === 'dead' ? shadeDead : shadeMat };
        g.userData.lamp = lastLamp;
        const sh = add(new THREE.CylinderGeometry(0.22, 0.26, 0.34, 28, 1, true), g.userData.lit.shade, 0, 1.52, 0, false);
        sh.userData.noMoonShadow = true;
        break;
      }
      case 'planter': {
        // A tall black ceramic pot with a small olive tree.
        add(new THREE.CylinderGeometry(0.42, 0.34, 0.85, 28), potMat, 0, 0.425, 0);
        add(new THREE.CylinderGeometry(0.4, 0.4, 0.02, 28), soilMat, 0, 0.84, 0, false);
        // The outer planters hold string-light trees (built separately).
        if (Math.abs(f.x) > 8) break;
        add(new THREE.CylinderGeometry(0.035, 0.05, 1.6, 7), mats.bark, 0, 1.6, 0);
        const cards: THREE.BufferGeometry[] = [];
        for (let k = 0; k < 22; k++) {
          const c = new THREE.PlaneGeometry(0.8, 0.8);
          c.rotateY(rnd() * Math.PI);
          c.rotateX((rnd() - 0.5) * 0.9);
          const a = rnd() * Math.PI * 2;
          const rr = rnd() * 0.55;
          c.translate(Math.cos(a) * rr, 2.1 + rnd() * 0.9, Math.sin(a) * rr);
          cards.push(c);
        }
        const leaves = add(mergeGeometries(cards), mats.leaf, 0, 0, 0);
        for (const c of cards) c.dispose();
        leaves.receiveShadow = true;
        break;
      }
      case 'centerpiece': {
        // A round pedestal table in black lacquer, its drum flaring out to the floor, under a black top with a gold
        // rim; a big white arrangement in a glass vase.
        const drum: THREE.Vector2[] = [];
        for (let k = 0; k <= 14; k++) {
          const t = k / 14;
          // Wide foot curving up into a slimmer waist, then straight up under the top.
          drum.push(new THREE.Vector2(0.44 + 0.2 * Math.pow(1 - Math.min(1, t / 0.75), 2.2), 0.7 * t));
        }
        drum.unshift(new THREE.Vector2(0, 0));
        drum.push(new THREE.Vector2(0, 0.7));
        add(new THREE.LatheGeometry(drum, 48), lacquer, 0, 0, 0);
        add(new THREE.CylinderGeometry(0.66, 0.66, 0.025, 48), mats.brass, 0, 0.0125, 0);
        add(new THREE.CylinderGeometry(0.82, 0.8, 0.07, 56), lacquer, 0, 0.735, 0);
        add(new THREE.TorusGeometry(0.815, 0.016, 8, 72).rotateX(Math.PI / 2), mats.brass, 0, 0.77, 0, false);
        add(new THREE.TorusGeometry(0.8, 0.012, 8, 72).rotateX(Math.PI / 2), mats.brass, 0, 0.7, 0, false);
        add(new THREE.CylinderGeometry(0.16, 0.12, 0.45, 24), vase, 0, 1.0, 0, false).userData.bouquet = true;
        const stems: THREE.BufferGeometry[] = [];
        const blooms: THREE.BufferGeometry[] = [];
        for (let k = 0; k < 40; k++) {
          const a = rnd() * Math.PI * 2;
          const tilt = 0.15 + rnd() * 0.55;
          const len = 0.6 + rnd() * 0.6;
          const dir = new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
          const st = new THREE.CylinderGeometry(0.006, 0.006, len, 4);
          st.translate(0, len / 2, 0);
          st.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
          st.translate(0, 1.0, 0);
          stems.push(st);
          const tip = dir.multiplyScalar(len).add(new THREE.Vector3(0, 1.0, 0));
          for (let j = 0; j < 4; j++) blooms.push(new THREE.IcosahedronGeometry(0.035 + rnd() * 0.025, 0).translate(tip.x + (rnd() - 0.5) * 0.08, tip.y - j * 0.06, tip.z + (rnd() - 0.5) * 0.08));
        }
        add(mergeGeometries(stems), stem, 0, 0, 0, false).userData.bouquet = true;
        add(mergeGeometries(blooms), petal, 0, 0, 0).userData.bouquet = true;
        for (const gg of [...stems, ...blooms]) gg.dispose();
        break;
      }
      case 'stool': {
        add(new THREE.CylinderGeometry(0.2, 0.22, 0.02, 24), mats.brass, 0, 0.01, 0);
        add(new THREE.CylinderGeometry(0.025, 0.025, 0.72, 8), mats.brass, 0, 0.37, 0);
        add(new THREE.CylinderGeometry(0.2, 0.19, 0.08, 24), leather, 0, 0.76, 0);
        add(new THREE.TorusGeometry(0.16, 0.01, 6, 24).rotateX(Math.PI / 2), mats.brass, 0, 0.3, 0);
        break;
      }
      case 'booth': {
        add(new THREE.BoxGeometry(s.w, 0.45, 0.6), leather, 0, 0.225, s.d / 2 - 0.3);
        add(new THREE.BoxGeometry(s.w, 0.75, 0.15), leather, 0, 0.82, s.d / 2 - 0.08);
        add(new THREE.BoxGeometry(s.w + 0.1, 1.2, 0.05), walnut, 0, 0.6, s.d / 2);
        add(new THREE.BoxGeometry(s.w * 0.6, 0.04, 0.6), marble, 0, 0.74, -s.d / 2 + 0.45);
        add(new THREE.CylinderGeometry(0.03, 0.03, 0.72, 8), mats.brass, 0, 0.36, -s.d / 2 + 0.45);
        break;
      }
      case 'diningTable': {
        const r = s.w / 2 - 0.35;
        add(new THREE.CylinderGeometry(r, r, 0.04, 40), cloth, 0, s.h, 0);
        add(new THREE.CylinderGeometry(r + 0.01, r - 0.02, 0.28, 40, 1, true), cloth, 0, s.h - 0.15, 0);
        add(new THREE.CylinderGeometry(0.05, 0.05, s.h - 0.3, 8), mats.brass, 0, (s.h - 0.3) / 2, 0);
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + 0.4;
          const cx = Math.cos(a) * (r + 0.3);
          const cz = Math.sin(a) * (r + 0.3);
          const chair = new THREE.Group();
          chair.position.set(cx, 0, cz);
          chair.rotation.y = Math.atan2(cx, cz);
          const seat = new THREE.Mesh(keep(new THREE.BoxGeometry(0.44, 0.08, 0.44)), fabric);
          seat.position.y = 0.46;
          const back = new THREE.Mesh(keep(new THREE.BoxGeometry(0.44, 0.5, 0.06)), walnut);
          back.position.set(0, 0.74, 0.2);
          for (const m of [seat, back]) m.castShadow = m.receiveShadow = true;
          chair.add(seat, back);
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
            const l = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.015, 0.015, 0.44, 6)), mats.brass);
            l.position.set(sx * 0.19, 0.22, sz * 0.19);
            chair.add(l);
          }
          g.add(chair);
        }
        add(new THREE.CylinderGeometry(0.05, 0.04, 0.16, 16), vase, 0, s.h + 0.08, 0, false);
        break;
      }
      case 'luggageCart': {
        // A brass bellhop cart: deck, two uprights, an arched top rail, suitcases.
        add(new THREE.BoxGeometry(1.0, 0.06, 0.55), walnut, 0, 0.22, 0);
        for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.02, 0.02, 1.55, 8), mats.brass, sx * 0.48, 1.0, 0);
        add(new THREE.TorusGeometry(0.48, 0.02, 8, 24, Math.PI), mats.brass, 0, 1.77, 0);
        for (const [x, y, w2, h2, c] of [
          [-0.15, 0.48, 0.62, 0.45, 0x5a3a24],
          [0.2, 0.83, 0.5, 0.3, 0x22252a],
          [-0.2, 0.86, 0.36, 0.34, 0x7a6248],
        ] as const)
          add(new THREE.BoxGeometry(w2, h2, 0.22), keep(new THREE.MeshStandardMaterial({ color: c, roughness: 0.55 })), x, y, -0.02);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 12).rotateZ(Math.PI / 2), darkMat, sx * 0.42, 0.06, sz * 0.22);
        break;
      }
    }
    return g;
  };
  // Furniture is cut away where its chunks break (furnitureCut above); a lamp goes out once its shade is gone or its
  // pole is shot through.
  const cut = furnitureCut(world);
  const gone = new Uint8Array(world.chunks.length);
  type Slot = { def: FurnitureDef; holder: THREE.Group; fallback: THREE.Group; shade: number[]; dark: boolean };
  const furnitureSlots: Slot[] = [];
  /** Cut materials on a slot's meshes; its lamp's shade and bulb stay separate meshes so they can go dark alone. */
  const cutSlot = (slot: Slot) => {
    cut.apply(slot.holder);
    const lit = slot.fallback.userData.lit as { glow: THREE.Material; shade: THREE.Material } | undefined;
    if (!lit) return;
    const lampMats = [cut.of(lit.glow), cut.of(lit.shade)];
    slot.holder.traverse((o) => {
      if (lampMats.includes((o as THREE.Mesh).material as THREE.Material)) o.userData.noMerge = true;
    });
  };
  const killLamp = (slot: Slot) => {
    const lit = slot.fallback.userData.lit as { glow: THREE.Material; shade: THREE.Material } | undefined;
    if (!lit || slot.dark) return;
    slot.dark = true;
    const ref = slot.fallback.userData.lamp as LampRef | undefined;
    if (ref?.glow) ref.glow.intensity = 0;
    if (ref?.fix) {
      const k = flickers.indexOf(ref.fix);
      if (k >= 0) flickers.splice(k, 1);
      ref.fix.mat.emissiveIntensity = ref.fix.matBase * 0.02;
    }
    if (ref?.cand) {
      ref.cand.out = true;
      if (ref.cand.light) ref.cand.light.intensity = 0;
    }
    const glowC = cut.of(lit.glow);
    const shadeC = cut.of(lit.shade);
    slot.holder.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.material === glowC) m.material = glowDead;
      else if (m.material === shadeC) m.material = shadeDead;
      else return;
      cut.apply(m);
    });
  };
  for (const [fi, f] of (def.furniture ?? []).entries()) {
    const holder = new THREE.Group();
    holder.position.set(f.x, 0, f.z);
    // Furniture yaw: the front faces `yaw`; models face -Z at yaw 0 (glTF front), stand-ins were built with the back at +z.
    holder.rotation.y = f.yaw;
    const fb = furnitureFallback(f);
    holder.add(fb);
    group.add(holder);
    const info = world.furniture[fi];
    const shade: number[] = [];
    if (info && (f.kind === 'sideTable' || f.kind === 'floorLamp')) {
      const parts = furnitureParts(f.kind);
      for (let i = info.c0; i < info.c1; i++) if (parts[world.chunks[i].furnPart ?? 0]?.name === 'shade') shade.push(i);
    }
    const slot: Slot = { def: f, holder, fallback: fb, shade, dark: false };
    cutSlot(slot);
    furnitureSlots.push(slot);
  }

  // ---- string-light trees: the outer planters by the facade hold bare twig trees wound with warm fairy lights ------
  const lightTreeAt = (f: FurnitureDef) => f.kind === 'planter' && Math.abs(f.x) > 8;
  {
    const twigs: THREE.BufferGeometry[] = [];
    const bulbs: THREE.Vector3[] = [];
    const tr = seeded(5150);
    const up = new THREE.Vector3(0, 1, 0);
    const branch = (p: THREE.Vector3, d: THREE.Vector3, len: number, r0: number, depth: number) => {
      const end = p.clone().addScaledVector(d, len);
      const g = new THREE.CylinderGeometry(r0 * 0.7, r0, len, 5, 1, true);
      g.translate(0, len / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d));
      g.translate(p.x, p.y, p.z);
      twigs.push(g);
      // Bulbs strung along the outer branches.
      if (depth >= 2) for (let t = 0.25; t <= 1.001; t += 0.3 + tr() * 0.15) bulbs.push(p.clone().addScaledVector(d, len * t).add(new THREE.Vector3((tr() - 0.5) * 0.04, (tr() - 0.5) * 0.04, (tr() - 0.5) * 0.04)));
      if (depth >= 3) return;
      const n = depth === 0 ? 4 : 3;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + tr() * 1.2;
        const spread = (depth === 0 ? 0.5 : 0.45) + tr() * 0.25;
        const nd = d.clone().multiplyScalar(Math.cos(spread)).add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(Math.sin(spread))).normalize();
        nd.y = Math.max(nd.y, 0.35);
        branch(end, nd.normalize(), len * (0.62 + tr() * 0.18), r0 * 0.6, depth + 1);
      }
    };
    // Sized to the planter's furniture chunks: trunk to ~2 m, the lit crown 2-3 m.
    branch(new THREE.Vector3(0, 0.84, 0), up.clone(), 0.9, 0.05, 0);
    const twigGeo = keep(mergeGeometries(twigs));
    for (const g of twigs) g.dispose();
    const bulbGeo = keep(new THREE.SphereGeometry(0.022, 6, 4));
    // Linear HDR well above 1 so the bulbs bloom; tiny, so they stay points of light.
    const bulbMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.62, 0.28).multiplyScalar(7) }));
    const m4 = new THREE.Matrix4();
    for (const [fi, f] of (def.furniture ?? []).entries()) {
      if (!lightTreeAt(f)) continue;
      const tree = new THREE.Group();
      tree.position.set(f.x, 0, f.z);
      tree.rotation.y = f.x * 1.7;
      const tw = new THREE.Mesh(twigGeo, mats.bark);
      tw.castShadow = true;
      const lights = new THREE.InstancedMesh(bulbGeo, bulbMat, bulbs.length);
      bulbs.forEach((b, k) => lights.setMatrixAt(k, m4.makeTranslation(b.x, b.y, b.z)));
      lights.userData.noMoonShadow = true;
      tree.add(tw, lights);
      tree.userData.noMerge = true;
      group.add(tree);
      // A warm halo in the fog and a little real light on the glass and floor nearby.
      const glowAt = new THREE.Vector3(f.x, 1.7, f.z);
      addGlow(glowAt, WARM, 0.9, 0.8, 4);
      // The tree comes down with any of its planter's chunks above the pot.
      const info = world.furniture[fi];
      if (info)
        for (let i = info.c0; i < info.c1; i++)
          if (world.chunks[i].max.y > 0.95) {
            const list = onChunk.get(i) ?? [];
            list.push(tree);
            onChunk.set(i, list);
          }
    }
  }

  // ---- columns: brass sconces on the faces towards the aisle and the walls ----------------------------------------
  const sconces: THREE.Group[] = [];
  const sconce = (p: THREE.Vector3, normal: THREE.Vector3) => {
    const g = new THREE.Group();
    sconces.push(g);
    g.position.copy(p);
    g.rotation.y = Math.atan2(normal.x, normal.z);
    const plate = new THREE.Mesh(keep(box(0.12, 0.62, 0.02)), mats.brass);
    plate.position.z = 0.01;
    plate.castShadow = true;
    g.add(plate);
    // A third still burn, a few stutter, the rest are dead.
    const glowMat = fixture(pickState(0.3, 0.14), lampGlow, glowDead, p.clone().addScaledVector(normal, 0.25), WARM, 1.4, 1.6, 5);
    g.userData.lit = { glow: glowMat, shade: glowMat === glowDead ? shadeDead : shadeMat };
    const tube = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 14)), glowMat);
    tube.position.z = 0.07;
    tube.userData.noMoonShadow = true;
    g.add(tube);
    for (const y of [-0.27, 0.27]) {
      const cap = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 14)), mats.brass);
      cap.position.set(0, y, 0.07);
      g.add(cap);
    }
    group.add(g);
    mount(g, p.clone().addScaledVector(normal, -0.1));
  };
  for (const pr of def.props ?? []) {
    if (pr.kind !== 'column') continue;
    const half = (pr.n ?? 1.2) / 2;
    // Faces towards the centre aisle and the side walls.
    for (const sx of [-1, 1]) sconce(new THREE.Vector3(pr.x + sx * (half + 0.005), 2.7, pr.z), new THREE.Vector3(sx, 0, 0));
  }
  // Wall sconces between the lockers on the atrium's long walls, under the galleries.
  for (const id of ['atriumWest', 'atriumEast']) {
    const w = walls.get(id);
    if (!w) continue;
    for (const a of [-14, -9, 0, 9, 14]) {
      const p = wallPoint(w, a, 2.6, 0.005);
      sconce(p, new THREE.Vector3(w.along === 'z' ? -w.out : 0, 0, w.along === 'x' ? -w.out : 0));
    }
  }

  // ---- reception desk and bar dressing ----------------------------------------------------------------------------
  const chunkBox = (cx: number, cz: number, rx: number, rz: number) => {
    const b = new THREE.Box3();
    for (const c of world.chunks)
      if (!c.wall && c.furn === undefined && Math.abs((c.min.x + c.max.x) / 2 - cx) < rx && Math.abs((c.min.z + c.max.z) / 2 - cz) < rz)
        b.union(new THREE.Box3(new THREE.Vector3(c.min.x, c.min.y, c.min.z), new THREE.Vector3(c.max.x, c.max.y, c.max.z)));
    return b.isEmpty() ? null : b;
  };
  let deskTop: { at: (t: number, side?: number) => THREE.Vector3; inward: number; yaw: number; placeholders: THREE.Object3D[] } | null = null;
  // Counter faces for props_arch's deskTrim: centre, outward normal, direction along the face, length, stand-ins.
  const counterFaces: { c: THREE.Vector3; n: THREE.Vector3; along: THREE.Vector3; len: number; prims: THREE.Object3D[] }[] = [];
  for (const pr of def.props ?? []) {
    if (pr.kind !== 'desk' && pr.kind !== 'bar') continue;
    const n = pr.n ?? 6;
    const b = chunkBox(pr.x, pr.z, pr.r === 1 ? 1.6 : n / 2 + 0.3, pr.r === 1 ? n / 2 + 0.3 : 1.6);
    if (!b) continue;
    const size = b.getSize(new THREE.Vector3());
    const c = b.getCenter(new THREE.Vector3());
    // Warm underglow along the foot of the counter (both long faces) and a brass kick line.
    const alongX = size.x >= size.z;
    const len = alongX ? size.x : size.z;
    for (const side of [-1, 1]) {
      const off = (alongX ? size.z : size.x) / 2 + 0.02;
      const strip = new THREE.Mesh(keep(box(alongX ? len : 0.03, 0.025, alongX ? 0.03 : len)), ledMat);
      strip.position.set(c.x + (alongX ? 0 : side * off), 0.06, c.z + (alongX ? side * off : 0));
      strip.userData.noMoonShadow = true;
      group.add(strip);
      const kick = new THREE.Mesh(keep(box(alongX ? len : 0.02, 0.04, alongX ? 0.02 : len)), mats.brass);
      kick.position.set(strip.position.x, b.max.y - 0.06, strip.position.z);
      group.add(kick);
      const half = (alongX ? size.z : size.x) / 2;
      counterFaces.push({
        c: new THREE.Vector3(c.x + (alongX ? 0 : side * half), 0, c.z + (alongX ? side * half : 0)),
        n: new THREE.Vector3(alongX ? 0 : side, 0, alongX ? side : 0),
        along: new THREE.Vector3(alongX ? 1 : 0, 0, alongX ? 0 : 1),
        len,
        prims: [strip, kick],
      });
    }
    for (let k = -1; k <= 1; k++) addGlow(new THREE.Vector3(c.x + (alongX ? (k * len) / 3 : size.x / 2 + 0.2), 0.15, c.z + (alongX ? size.z / 2 + 0.2 : (k * len) / 3)), WARM, 0.15);
    const top = b.max.y;
    const at = (t: number, side = 0) => new THREE.Vector3(c.x + (alongX ? t * len : side), top, c.z + (alongX ? side : t * len));
    if (pr.kind === 'desk') {
      // Brass dome desk lamps, monitors, a bell, and a huge white arrangement at the end of the desk.
      for (const t of [-0.32, 0.05, 0.38]) {
        const p = at(t);
        const lamp = new THREE.Group();
        lamp.position.copy(p);
        const stemM = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 8)), mats.brass);
        stemM.position.y = 0.21;
        const dome = new THREE.Mesh(keep(new THREE.SphereGeometry(0.17, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2)), mats.brass);
        dome.position.y = 0.42;
        dome.castShadow = true;
        // One desk lamp left on (the night porter's), one stuttering, one dead.
        const st: FixState = t < 0 ? 'lit' : t < 0.2 ? 'flicker' : 'dead';
        const glowDisc = new THREE.Mesh(keep(new THREE.CircleGeometry(0.15, 20).rotateX(Math.PI / 2)), fixture(st, lampGlow, glowDead, p.clone().add(new THREE.Vector3(0, 0.35, 0)), WARM, 1.6, 1.2, 4, 0.8));
        glowDisc.position.y = 0.415;
        glowDisc.userData.noMoonShadow = true;
        lamp.add(stemM, dome, glowDisc);
        group.add(lamp);
        mount(lamp, p.clone().add(new THREE.Vector3(0, -0.1, 0)));
      }
      // Staff stand on the wall side of the desk; their screens face them.
      const wallSide = walls.get('atriumWest');
      const inward = wallSide ? (alongX ? Math.sign(wallSide.fixed - c.z) : Math.sign(wallSide.fixed - c.x)) : -1;
      const placeholders: THREE.Object3D[] = [];
      for (const t of [-0.15, 0.22]) {
        const mon = new THREE.Mesh(keep(box(alongX ? 0.5 : 0.04, 0.32, alongX ? 0.04 : 0.5)), darkMat);
        mon.position.copy(at(t, inward * 0.15)).add(new THREE.Vector3(0, 0.28, 0));
        group.add(mon);
        mount(mon, at(t).add(new THREE.Vector3(0, -0.1, 0)));
        placeholders.push(mon);
      }
      const bell = new THREE.Mesh(keep(new THREE.SphereGeometry(0.05, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)), mats.brass);
      bell.position.copy(at(0.12));
      group.add(bell);
      placeholders.push(bell);
      // The model's front (-Z) turned to face the staff side.
      const yaw = alongX ? (inward < 0 ? 0 : Math.PI) : inward < 0 ? Math.PI / 2 : -Math.PI / 2;
      deskTop = { at, inward, yaw, placeholders };
      // Flowers: tall white stems in a glass vase.
      const fp = at(-0.44);
      const arr = new THREE.Group();
      arr.position.copy(fp);
      const v = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.11, 0.09, 0.5, 20)), vase);
      v.position.y = 0.25;
      arr.add(v);
      const blooms: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 30; k++) {
        const a = rnd() * Math.PI * 2;
        const tilt = rnd() * 0.5;
        const len2 = 0.5 + rnd() * 0.5;
        const tip = new THREE.Vector3(Math.cos(a) * Math.sin(tilt) * len2, 0.5 + Math.cos(tilt) * len2, Math.sin(a) * Math.sin(tilt) * len2);
        for (let j = 0; j < 5; j++) blooms.push(new THREE.IcosahedronGeometry(0.03 + rnd() * 0.02, 0).translate(tip.x * (1 - j * 0.05), tip.y - j * 0.07, tip.z * (1 - j * 0.05)));
      }
      const bm = new THREE.Mesh(keep(mergeGeometries(blooms)), petal);
      for (const gg of blooms) gg.dispose();
      bm.castShadow = true;
      arr.add(bm);
      group.add(arr);
      mount(arr, fp.clone().add(new THREE.Vector3(0, -0.1, 0)));
      // The hotel's name in brass letters on the wall behind the desk.
      const wall = walls.get('atriumWest');
      if (wall) {
        const cv = document.createElement('canvas');
        cv.width = 1024;
        cv.height = 160;
        const g = cv.getContext('2d')!;
        g.clearRect(0, 0, 1024, 160);
        g.fillStyle = '#ffffff';
        g.textAlign = 'center';
        g.font = '500 92px "Cormorant Garamond", Georgia, "Times New Roman", serif';
        g.fillText('G R A N D   M E R I D I A N', 512, 110);
        const tex = keep(new THREE.CanvasTexture(cv));
        tex.colorSpace = THREE.SRGBColorSpace;
        const signMat = keep(new THREE.MeshStandardMaterial({ map: tex, transparent: true, color: 0xe6bd72, metalness: 1, roughness: 0.25, emissive: 0x5a3a12, emissiveMap: tex, emissiveIntensity: 0.18 }));
        const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(5.5, 0.86)), signMat);
        sign.position.copy(wallPoint(wall, c.z, 3.6, 0.03));
        sign.rotation.y = wall.out < 0 ? Math.PI / 2 : -Math.PI / 2;
        group.add(sign);
        mount(sign, wallPoint(wall, c.z, 3.6, -0.1));
      }
    } else {
      // Bar: a lit wall of bottles on glass shelves behind the counter, brass foot rail in front.
      const wall = walls.get('loungeNorth');
      if (wall) {
        const shelfLen = Math.min(8, len);
        for (const y of [1.2, 1.6, 2.0, 2.4]) {
          const shelf = new THREE.Mesh(keep(box(shelfLen, 0.025, 0.3)), mats.glass);
          shelf.position.copy(wallPoint(wall, c.x, y, 0.15));
          shelf.renderOrder = 2;
          group.add(shelf);
          const led = new THREE.Mesh(keep(box(shelfLen, 0.015, 0.02)), ledMat);
          led.position.copy(wallPoint(wall, c.x, y - 0.02, 0.02));
          group.add(led);
          for (let x = -shelfLen / 2 + 0.1; x < shelfLen / 2 - 0.05; x += 0.11 + rnd() * 0.05) {
            const bh = 0.24 + rnd() * 0.12;
            const bottle = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.035, 0.038, bh, 10)), bottleMats[Math.floor(rnd() * bottleMats.length)]);
            bottle.position.copy(wallPoint(wall, c.x + x, y + bh / 2 + 0.013, 0.15));
            group.add(bottle);
          }
          addGlow(wallPoint(wall, c.x, y, 0.4), WARM, 0.25);
        }
      }
      const rail = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.025, 0.025, len, 10).rotateZ(Math.PI / 2)), mats.brass);
      if (!alongX) rail.rotation.y = Math.PI / 2;
      rail.position.set(c.x + (alongX ? 0 : size.x / 2 + 0.25), 0.22, c.z + (alongX ? size.z / 2 + 0.25 : 0));
      group.add(rail);
    }
  }

  // ---- elevators, revolving door, entrance frames, facade transoms --------------------------------------------------
  const elevators: { g: THREE.Group; pos: THREE.Vector3; yaw: number; width: number }[] = [];
  let revolving: { g: THREE.Group; pos: THREE.Vector3; yaw: number } | null = null;
  for (const o of def.openings ?? []) {
    if (o.kind !== 'elevator') continue;
    const w = walls.get(o.wall);
    if (!w) continue;
    const width = o.a1 - o.a0;
    const n = Math.max(1, Math.round(width / 3));
    const cw = width / n;
    for (let k = 0; k < n; k++) {
      const a = o.a0 + cw * (k + 0.5);
      const eg = new THREE.Group();
      group.add(eg);
      elevators.push({ g: eg, pos: wallPoint(w, a, 0, 0.13), yaw: Math.atan2(-(w.along === 'z' ? -w.out : 0), -(w.along === 'x' ? -w.out : 0)), width: cw });
      const surround = new THREE.Mesh(keep(box(w.along === 'x' ? cw - 0.1 : 0.12, o.y1, w.along === 'x' ? 0.12 : cw - 0.1)), walnut);
      surround.position.copy(wallPoint(w, a, o.y1 / 2, 0.02));
      eg.add(surround);
      for (const half of [-1, 1]) {
        const door = new THREE.Mesh(keep(box(w.along === 'x' ? cw / 2 - 0.3 : 0.05, o.y1 - 0.5, w.along === 'x' ? 0.05 : cw / 2 - 0.3)), mats.brass);
        door.position.copy(wallPoint(w, a + half * (cw / 4 - 0.12), (o.y1 - 0.5) / 2 + 0.02, 0.1));
        door.castShadow = true;
        eg.add(door);
      }
      const ind = new THREE.Mesh(keep(box(w.along === 'x' ? 0.5 : 0.03, 0.08, w.along === 'x' ? 0.03 : 0.5)), ledMat);
      ind.position.copy(wallPoint(w, a, o.y1 - 0.2, 0.1));
      group.add(ind);
      addGlow(wallPoint(w, a, o.y1 - 0.3, 0.4), WARM, 0.2);
    }
  }
  const facade = walls.get('facade');
  for (const e of def.entrances ?? []) {
    const w = walls.get(e.wall);
    if (!w) continue;
    if (e.look === 'revolving') {
      // A brass drum outside the facade: canopy, base ring, glass drum walls, four glass wings.
      const c = wallPoint(w, e.at, 0, -1.55);
      const r = 1.45;
      const g = new THREE.Group();
      g.position.copy(c);
      const canopy = new THREE.Mesh(keep(new THREE.CylinderGeometry(r + 0.1, r + 0.1, 0.3, 48)), mats.brass);
      canopy.position.y = 2.65;
      canopy.castShadow = true;
      const ring = new THREE.Mesh(keep(new THREE.CylinderGeometry(r + 0.1, r + 0.1, 0.04, 48)), mats.brass);
      ring.position.y = 0.02;
      const drum = new THREE.Mesh(keep(new THREE.CylinderGeometry(r, r, 2.5, 48, 1, true, Math.PI * 0.15, Math.PI * 0.7)), mats.glass);
      drum.position.y = 1.25;
      drum.userData.noMoonShadow = true;
      const drum2 = drum.clone();
      drum2.rotation.y = Math.PI;
      const axle = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.06, 0.06, 2.5, 12)), mats.brass);
      axle.position.y = 1.25;
      g.add(canopy, ring, drum, drum2, axle);
      for (let k = 0; k < 4; k++) {
        const wing = new THREE.Mesh(keep(box(r - 0.08, 2.3, 0.025)), mats.glass);
        wing.position.set(Math.cos((k * Math.PI) / 2 + 0.3) * (r / 2), 1.2, Math.sin((k * Math.PI) / 2 + 0.3) * (r / 2));
        wing.rotation.y = -((k * Math.PI) / 2 + 0.3);
        wing.userData.noMoonShadow = true;
        const frame = new THREE.Mesh(keep(box(r - 0.08, 0.05, 0.05)), mats.brass);
        frame.position.copy(wing.position).setY(2.33);
        frame.rotation.y = wing.rotation.y;
        g.add(wing, frame);
      }
      group.add(g);
      revolving = { g, pos: wallPoint(w, e.at, 0, -2.2), yaw: Math.atan2(-(w.along === 'z' ? -w.out : 0), -(w.along === 'x' ? -w.out : 0)) };
    }
  }
  if (facade) buildFacadeDress(facade);

  // ---- the facade: a slim dark window grid and the boarded-up gate behind the security bars ------------------------
  function buildFacadeDress(facade: WallDef) {
    const ax = facade.along === 'x';
    const len = facade.a1 - facade.a0;
    const grid: THREE.BufferGeometry[] = [];
    const piece = (a: number, y: number, along: number, h: number, off: number, d: number) => {
      const p = wallPoint(facade, a, y, off);
      grid.push(box(ax ? along : d, h, ax ? d : along).translate(p.x, p.y, p.z));
    };
    // Slim brass transoms every 3 m (square panes between the 3 m mullions), on the inside face of the glass so they
    // stay crisp in front of the misty panes, with a twin outside.
    for (let y = 3; y < facade.h - 0.5; y += 3) {
      piece((facade.a0 + facade.a1) / 2, y, len, 0.06, 0.03, 0.05);
      piece((facade.a0 + facade.a1) / 2, y, len, 0.06, -(facade.thick + 0.05), 0.05);
    }
    const gridMesh = new THREE.Mesh(keep(mergeGeometries(grid)), mats.brass);
    for (const g of grid) g.dispose();
    gridMesh.castShadow = true;
    group.add(gridMesh);

    // The gate: weathered planks nailed up inside the glass in front of the bars (which rise above them), framed into
    // panels with rails, stiles and an X brace, gaps between the planks letting the street light through. Only where
    // the bars run (never across an entrance). A warm emissive through the grain stands in for the lobby's bounce
    // light, so the boards read as lit wood rather than a silhouette against the glare.
    const woodSet = mats.texSet('wood');
    const wood = keep(setMaterial(woodSet, { color: 0xa47c52, envMapIntensity: 0.25, metalness: 0, emissive: new THREE.Color(0.8, 0.45, 0.2), emissiveIntensity: 2.8 }));
    const darkWood = keep(setMaterial(woodSet, { color: 0x6a4c30, envMapIntensity: 0.2, metalness: 0, emissive: new THREE.Color(0.8, 0.45, 0.2), emissiveIntensity: 2.1 }));
    for (const m of [wood, darkWood]) m.emissiveMap = m.map;
    woodSet.onUpgrade((s) => {
      for (const m of [wood, darkWood]) m.emissiveMap = s.map;
    });
    const planks: THREE.BufferGeometry[] = [];
    const braces: THREE.BufferGeometry[] = [];
    const r = seeded(7331);
    const plank = (list: THREE.BufferGeometry[], lenP: number, h: number, t: number, rotZ: number, a: number, y: number, off: number) => {
      const g = box(lenP, h, t);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      const row = Math.floor(r() * 8);
      const shift = r();
      for (let j = 0; j < uv.count; j++) uv.setXY(j, uv.getX(j) * lenP * 0.6 + shift, (row + 0.12 + uv.getY(j) * 0.76) / 8);
      g.rotateZ(rotZ);
      // Local x runs along the wall; turn it onto the wall's axis.
      if (!ax) g.rotateY(Math.PI / 2);
      const p = wallPoint(facade, a, y, off);
      g.translate(p.x, p.y, p.z);
      list.push(g);
    };
    const bars = world.solids.filter((s) => (s.kind as string) === 'bars' && (s.max.x - s.min.x > s.max.z - s.min.z) === ax && (ax ? Math.abs((s.min.z + s.max.z) / 2 - facade.fixed) < 0.6 : Math.abs((s.min.x + s.max.x) / 2 - facade.fixed) < 0.6));
    const H = 2.5;
    const backOff = 0.04;
    for (const b of bars) {
      const s0 = ax ? b.min.x : b.min.z;
      const s1 = ax ? b.max.x : b.max.z;
      const runLen = s1 - s0;
      if (runLen < 0.6) continue;
      const n = Math.max(1, Math.round(runLen / 2.4));
      const pw = runLen / n;
      for (let k = 0; k < n; k++) {
        const c = s0 + pw * (k + 0.5);
        // Horizontal boards, a hand's width apart now and then.
        for (let y = 0.12; y < H - 0.1; ) {
          const h = 0.19 + r() * 0.06;
          plank(planks, pw - 0.04, h, 0.03, (r() - 0.5) * 0.015, c + (r() - 0.5) * 0.03, y + h / 2, backOff);
          y += h + (r() < 0.3 ? 0.04 + r() * 0.05 : 0.012);
        }
        // Rails top and bottom, a stile each side, one X brace across the whole panel.
        for (const y of [0.2, H - 0.1]) plank(braces, pw - 0.06, 0.17, 0.045, 0, c, y, backOff + 0.04);
        for (const sx of [-1, 1]) plank(braces, H, 0.15, 0.045, Math.PI / 2, c + sx * (pw / 2 - 0.1), H / 2, backOff + 0.04);
        const w = pw - 0.36;
        const h = H - 0.5;
        const l = Math.hypot(w, h);
        const ang = Math.atan2(h, w);
        plank(braces, l, 0.16, 0.04, ang, c, (0.2 + H - 0.1) / 2, backOff + 0.08);
        plank(braces, l, 0.16, 0.04, -ang, c, (0.2 + H - 0.1) / 2, backOff + 0.12);
      }
    }
    if (planks.length) {
      const pm = new THREE.Mesh(keep(mergeGeometries(planks)), wood);
      const bm = new THREE.Mesh(keep(mergeGeometries(braces)), darkWood);
      for (const g of [...planks, ...braces]) g.dispose();
      for (const m of [pm, bm]) {
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      }
    }
  }

  // ---- real lights from the strongest glow candidates ------------------------------------------------------------
  const points: THREE.PointLight[] = [];
  pointCandidates.sort((a, b) => (b.fix ? 10 : 0) + b.power - ((a.fix ? 10 : 0) + a.power));
  const rebuildPoints = (q: Quality) => {
    for (const p of points) group.remove(p);
    points.length = 0;
    for (const f of flickers) f.light = null;
    for (const c of pointCandidates.filter((c) => !c.out).slice(0, POINT_BUDGET[q])) {
      const p = new THREE.PointLight(c.color, c.power * 3, c.range, 2);
      p.position.copy(c.pos);
      p.layers.enableAll();
      group.add(p);
      points.push(p);
      if (c.fix) c.fix.light = p;
      c.light = p;
    }
  };
  rebuildPoints(quality);

  // ---- models arrive -------------------------------------------------------------------------------------------
  let disposed = false;
  // ---- props_arch: brass reveals on the columns, desk trims, glass railings ---------------------------------------
  // Hundreds of small pieces, so each part of each model becomes one InstancedMesh; a piece mounted on a breakable
  // chunk collapses to zero scale when that chunk breaks.
  const instHide = new Map<number, { mesh: THREE.InstancedMesh; idx: number }[]>();
  const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
  const instance = (model: THREE.Object3D, places: { m: THREE.Matrix4; chunk: number }[], glowMat?: THREE.Material) => {
    if (!places.length) return;
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      const src = o as THREE.Mesh;
      if (!src.isMesh) return;
      const local = src.matrixWorld.clone();
      let mat = src.material as THREE.MeshStandardMaterial;
      const glows = mat.name === 'DeskGlow';
      if (glows && glowMat) mat = glowMat as THREE.MeshStandardMaterial;
      const im = new THREE.InstancedMesh(src.geometry, mat, places.length);
      im.castShadow = !glows && !mat.transparent;
      im.receiveShadow = !glows;
      if (glows || mat.transparent) im.userData.noMoonShadow = true;
      if (mat.transparent) im.renderOrder = 2;
      im.userData.noMerge = true;
      const tmp = new THREE.Matrix4();
      places.forEach((pl, k) => {
        im.setMatrixAt(k, tmp.multiplyMatrices(pl.m, local));
        if (pl.chunk < 0) return;
        const list = instHide.get(pl.chunk) ?? [];
        list.push({ mesh: im, idx: k });
        instHide.set(pl.chunk, list);
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      group.add(im);
    });
  };
  /** The chunk whose box contains `p`, or -1. */
  const chunkAt = (p: THREE.Vector3) => {
    let found = -1;
    const probe = { min: { x: p.x - 0.01, y: p.y - 0.01, z: p.z - 0.01 }, max: { x: p.x + 0.01, y: p.y + 0.01, z: p.z + 0.01 } };
    forChunks(world, probe, (i) => {
      const c = world.chunks[i];
      if (p.x >= c.min.x && p.x <= c.max.x && p.y >= c.min.y && p.y <= c.max.y && p.z >= c.min.z && p.z <= c.max.z) {
        found = i;
        return true;
      }
    });
    return found;
  };
  /** A placement matrix; `yaw` turns the model's +Z (its back) towards (sin yaw, cos yaw). */
  const placeAt = (x: number, y: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(sx, sy, sz));
  const placeArch = (prop: (name: string) => THREE.Object3D | null) => {
    // Columns: brass corner angles and a centre seam on every face, row by row so each piece falls with its chunk,
    // and a brass base band round the foot (panel 8 of the props sheet).
    const reveal = prop('brassReveal');
    if (reveal) {
      const corners: { m: THREE.Matrix4; chunk: number }[] = [];
      const seams: { m: THREE.Matrix4; chunk: number }[] = [];
      const bands: { m: THREE.Matrix4; chunk: number }[] = [];
      for (const pr of def.props ?? []) {
        if (pr.kind !== 'column') continue;
        const half = (pr.n ?? 1.2) / 2;
        const rows = new Map<number, number>();
        for (const c of world.chunks)
          if (c.part === 'column' && Math.abs((c.min.x + c.max.x) / 2 - pr.x) < half && Math.abs((c.min.z + c.max.z) / 2 - pr.z) < half) rows.set(c.min.y, c.max.y);
        for (const [y0, y1] of rows) {
          const ym = (y0 + y1) / 2;
          for (const [sx, sz] of [
            [1, 1],
            [1, -1],
            [-1, -1],
            [-1, 1],
          ] as const) {
            // The model's corner faces +X / +Z; turn it to face (sx, sz).
            const yaw = sx > 0 ? (sz > 0 ? 0 : Math.PI / 2) : sz > 0 ? -Math.PI / 2 : Math.PI;
            const inside = new THREE.Vector3(pr.x + sx * (half - 0.1), ym, pr.z + sz * (half - 0.1));
            corners.push({ m: placeAt(pr.x + sx * half, y0, pr.z + sz * half, yaw, 1, y1 - y0, 1), chunk: chunkAt(inside) });
          }
          for (const [nx, nz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const yaw = Math.atan2(nx, nz);
            const behind = new THREE.Vector3(pr.x + nx * (half - 0.1) + nz * 0.05, ym, pr.z + nz * (half - 0.1) + nx * 0.05);
            seams.push({ m: placeAt(pr.x + nx * (half + 0.004), ym, pr.z + nz * (half + 0.004), yaw, 1, y1 - y0, 1), chunk: chunkAt(behind) });
            if (y0 < 0.01) bands.push({ m: placeAt(pr.x + nx * (half + 0.006), 0.05, pr.z + nz * (half + 0.006), yaw, half * 2 + 0.024, 1, 1), chunk: chunkAt(behind) });
          }
        }
      }
      instance(reveal, corners);
      instance(new THREE.Mesh(keep(box(0.024, 1, 0.008)), mats.brass), seams);
      instance(new THREE.Mesh(keep(box(1, 0.1, 0.012)), mats.brass), bands);
    }
    // Reception desk and bar: a deskTrim every metre along both long faces (replacing the stand-in strips; panel 7).
    const trim = prop('deskTrim');
    if (trim && counterFaces.length) {
      const places: { m: THREE.Matrix4; chunk: number }[] = [];
      for (const f of counterFaces) {
        const count = Math.max(1, Math.round(f.len));
        const seg = f.len / count;
        // The trim's back (+Z) goes against the counter, its front faces out along the face normal.
        const yaw = Math.atan2(-f.n.x, -f.n.z);
        for (let k = 0; k < count; k++) {
          const p = f.c.clone().addScaledVector(f.along, -f.len / 2 + (k + 0.5) * seg);
          places.push({ m: placeAt(p.x, 0, p.z, yaw, seg, 1, 1), chunk: chunkAt(p.clone().addScaledVector(f.n, -0.15).setY(0.25)) });
        }
        for (const o of f.prims) o.visible = false;
      }
      instance(trim, places, ledMat);
    }
    // Mezzanine balustrades: 2 m glassRailing segments along each run, stretched to fit (panel 15).
    const rail = prop('glassRailing');
    if (rail && railRuns.length) {
      const places: { m: THREE.Matrix4; chunk: number }[] = [];
      for (const r of railRuns) {
        const len = r.a1 - r.a0;
        const count = Math.max(1, Math.round(len / 2));
        const seg = len / count;
        // Back (+Z) towards the wall: the gallery behind, the atrium in front.
        const yaw = r.w.along === 'z' ? Math.atan2(r.w.out, 0) : Math.atan2(0, r.w.out);
        for (let k = 0; k < count; k++) {
          const p = wallPoint(r.w, r.a0 + (k + 0.5) * seg, r.top, r.off);
          places.push({ m: placeAt(p.x, p.y, p.z, yaw, seg / 2, 1, 1), chunk: -1 });
        }
        for (const o of r.prims) o.visible = false;
      }
      instance(rail, places);
    }
  };

  let wings: THREE.Object3D | null = null;
  void models.ready.then(() => {
    if (disposed) return;
    /** A props.glb model, or null when only models.ts's generic stand-in exists. */
    const prop = (name: string): THREE.Object3D | null => {
      try {
        const m = models.prop(name as never);
        if (m.name !== name) return null;
        m.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) mesh.castShadow = mesh.receiveShadow = true;
        });
        return m;
      } catch {
        return null;
      }
    };
    /** Lamp shades and bulbs glow; the props carry materials named Shade / Bulb / SconceGlow. */
    // The model's bulb and shade take the stand-in's fixture state (lit, dead or its own stuttering material).
    const lightUp = (m: THREE.Object3D, lit?: { glow: THREE.Material; shade: THREE.Material }) =>
      m.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const name = (mesh.material as THREE.Material).name;
        if (name === 'Bulb' || name === 'SconceGlow') {
          mesh.material = lit?.glow ?? lampGlow;
          mesh.castShadow = false;
          mesh.userData.noMoonShadow = true;
        } else if (name === 'Shade') {
          mesh.material = lit?.shade ?? shadeMat;
          mesh.castShadow = false;
        }
      });
    const swap = (holder: THREE.Object3D, fallback: THREE.Object3D, parts: (THREE.Object3D | null)[]) => {
      if (parts.some((p) => !p)) return false;
      holder.remove(fallback);
      for (const p of parts) holder.add(p!);
      return true;
    };
    for (const slot of furnitureSlots) {
      const f = slot.def;
      const s = FURNITURE_SIZE[f.kind];
      switch (f.kind) {
        case 'sofa':
        case 'armchair':
        case 'coffeeTable':
        case 'booth':
        case 'luggageCart':
        case 'floorLamp': {
          const m = prop(f.kind);
          if (m) lightUp(m, slot.fallback.userData.lit);
          swap(slot.holder, slot.fallback, [m]);
          break;
        }
        case 'sideTable': {
          const t = prop('brassTable');
          const l = prop('tableLamp');
          if (t && l) {
            const top = new THREE.Box3().setFromObject(t).max.y;
            l.position.y = top;
            lightUp(l, slot.fallback.userData.lit);
          }
          swap(slot.holder, slot.fallback, [t, l]);
          break;
        }
        case 'planter': {
          const m = prop('planterTree');
          // A light tree keeps only the pot and soil.
          if (m && lightTreeAt(f)) m.traverse((o) => /leaves|branches/.test(o.name) && (o.visible = false));
          swap(slot.holder, slot.fallback, [m]);
          break;
        }
        case 'stool': {
          swap(slot.holder, slot.fallback, [prop('barStool')]);
          break;
        }
        case 'centerpiece': {
          // The round marble-and-brass table of the stand-in stays; real flowers replace the primitive bouquet.
          const fl = prop('flowers');
          if (fl) {
            fl.position.y = 0.78;
            fl.scale.setScalar(1.6);
            slot.fallback.children.forEach((c) => c.userData.bouquet && (c.visible = false));
            // Pale blossoms catch the light from every side (thin petals glow through): a soft emissive through their
            // own texture keeps the arrangement bright against the backlit facade.
            fl.traverse((o) => {
              const mesh = o as THREE.Mesh;
              if (!mesh.isMesh || !/blossoms|leaves/.test(mesh.name)) return;
              const m = keep((mesh.material as THREE.MeshStandardMaterial).clone());
              m.emissive = /blossoms/.test(mesh.name) ? new THREE.Color(1, 0.86, 0.68) : new THREE.Color(0.7, 0.85, 0.45);
              m.emissiveMap = m.map;
              m.emissiveIntensity = /blossoms/.test(mesh.name) ? 0.5 : 0.22;
              mesh.material = m;
            });
            slot.holder.add(fl);
          }
          break;
        }
        case 'diningTable': {
          const t = prop('diningTable');
          const chairs: (THREE.Object3D | null)[] = [];
          for (let k = 0; k < 4; k++) {
            const c = prop('diningChair');
            if (c) {
              const a = (k / 4) * Math.PI * 2 + 0.4;
              const r = s.w / 2 - 0.05;
              c.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
              // Chairs face the table (their front, -Z, points to the centre).
              c.rotation.y = Math.atan2(Math.cos(a), Math.sin(a));
            }
            chairs.push(c);
          }
          swap(slot.holder, slot.fallback, [t, ...chairs]);
          break;
        }
      }
    }
    // Sconces: the model's wall plate replaces the stand-in's (origin on the plate, sticking out along -Z).
    for (const g of sconces) {
      const m = prop('sconce');
      if (!m) break;
      lightUp(m, g.userData.lit);
      m.rotation.y = Math.PI;
      g.clear();
      g.add(m);
    }
    for (const e of elevators) {
      const m = prop('elevatorDoors');
      if (!m) break;
      m.position.copy(e.pos);
      m.rotation.y = e.yaw;
      m.scale.setScalar(Math.min(1, (e.width - 0.2) / 2.7));
      e.g.clear();
      e.g.add(m);
    }
    if (revolving) {
      const m = prop('revolvingDoor');
      if (m) {
        m.position.copy(revolving.pos);
        m.rotation.y = revolving.yaw;
        revolving.g.removeFromParent();
        group.add(m);
        wings = m.getObjectByName('revolvingDoor_wings') ?? null;
        if (wings) wings.userData.noMerge = true;
      }
    }
    // Reception extras on the desk: a bell and two computers.
    if (deskTop) {
      const bell = prop('receptionBell');
      if (bell) {
        bell.position.copy(deskTop.at(0.12));
        group.add(bell);
        mount(bell, deskTop.at(0.12).add(new THREE.Vector3(0, -0.1, 0)));
      }
      for (const t of [-0.15, 0.22]) {
        const pc = prop('computer');
        if (!pc) break;
        pc.position.copy(deskTop.at(t, deskTop.inward * 0.15));
        pc.rotation.y = deskTop.yaw;
        group.add(pc);
        mount(pc, deskTop.at(t).add(new THREE.Vector3(0, -0.1, 0)));
      }
      for (const m of deskTop.placeholders) m.visible = false;
    }
    placeArch(prop);
    for (const slot of furnitureSlots) {
      cutSlot(slot);
      if (slot.dark) {
        slot.dark = false;
        killLamp(slot);
      }
    }
    mergeStatic(group);
  });

  return {
    group,
    glows,
    lamps: [],
    setChunkHp(i, hp) {
      cut.setChunkHp(i, hp);
    },
    breakChunk(i) {
      const c = world.chunks[i];
      if (c?.furn !== undefined && !gone[i]) {
        gone[i] = 1;
        cut.breakChunk(i);
        const slot = furnitureSlots[c.furn];
        const kind = slot?.def.kind;
        if (slot && (kind === 'sideTable' || kind === 'floorLamp')) {
          const name = furnitureParts(kind)[c.furnPart ?? 0]?.name;
          if (name === 'pole' || (slot.shade.length && slot.shade.every((j) => gone[j]))) killLamp(slot);
        }
      }
      const inst = instHide.get(i);
      if (inst) {
        for (const { mesh, idx } of inst) {
          mesh.setMatrixAt(idx, zeroM);
          mesh.instanceMatrix.needsUpdate = true;
        }
        instHide.delete(i);
      }
      const list = onChunk.get(i);
      if (!list) return;
      for (const o of list) o.visible = false;
      onChunk.delete(i);
    },
    update(dt, time) {
      cut.update();
      if (wings) wings.rotation.y += dt * 0.25;
      for (const f of flickers) {
        const l = failing(time, f.seed, f.fail);
        f.mat.emissiveIntensity = f.matBase * (0.02 + 0.98 * l);
        f.glow.intensity = f.glowBase * l;
        if (f.light) f.light.intensity = f.power * 3 * l;
      }
    },
    setQuality(q) {
      rebuildPoints(q);
    },
    dispose() {
      disposed = true;
      cut.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
