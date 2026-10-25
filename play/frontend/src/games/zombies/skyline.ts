// The city around the Grand Meridian at night: dark towers across the plaza and along both side streets whose lit
// windows glow through the fog. The windows are not a texture: a world-space pattern in the facade shader (patched
// MeshStandardMaterial) picks per window lit/unlit with whole floors and tenant blocks clustered, warm tungsten vs cool
// fluorescent vs flickering TV blue, blinds, mullions, and an analytic box filter that fades into the average window
// coverage at distance so nothing shimmers. Emissive is linear HDR well above 1 so it survives the fog and blooms.
// On top: blinking red aviation lights and roof floods (camera-facing discs that write depth, so the fog dims them
// by their own distance), floodlit crowns, roof clutter and two neon signs (no brands).
// Every mesh is outside the hotel's shadow box (`userData.noMoonShadow`), no shadow casting; 4 draws (3 on low).

import * as THREE from 'three';
import type { Quality } from './api';

export interface SkylineOpts {
  /** z of the glass facade (the hotel's north face); the plaza and the city lie at z < facadeZ. */
  facadeZ: number;
  /** Extent of the hotel's walls. */
  ext: { minX: number; maxX: number; minZ: number; maxZ: number };
  quality: Quality;
}

export interface Skyline {
  group: THREE.Group;
  update(dt: number, time: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

/** Linear HDR gain of a fully lit window; aviation lights and neon scale from it. Tuned against the night fog. */
const WINDOW_GLOW = 16;

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

// Window kinds (aWin.w): 0 office ribbon glazing, 1 residential punched windows, 2 blank wall / roof,
// 3 floodlit crown, 4 shopfront podium.
const OFFICE = 0;
const HOME = 1;
const BLANK = 2;
const CROWN = 3;
const SHOP = 4;

/** Merged geometry builder: quads with world-space window coordinates. */
class Builder {
  pos: number[] = [];
  nor: number[] = [];
  face: number[] = [];
  win: number[] = [];
  idx: number[] = [];

  /** One wall quad. `a` is its bottom-left corner seen from outside, `rx/rz` the unit direction to the right. */
  wall(ax: number, az: number, rx: number, rz: number, len: number, y0: number, y1: number, nx: number, nz: number, base: number, seed: number, bayTarget: number, floorH: number, litRatio: number, kind: number) {
    const bay = len / Math.max(1, Math.round(len / bayTarget));
    const v = this.pos.length / 3;
    const corners = [
      [0, y0, 0],
      [len, y0, 0],
      [len, y1, 1],
      [0, y1, 1],
    ];
    for (const [u, y, t] of corners) {
      this.pos.push(ax + rx * u, y, az + rz * u);
      this.nor.push(nx, 0, nz);
      this.face.push(u, y - base, seed, t);
      this.win.push(bay, floorH, litRatio, kind);
    }
    this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }

  /** A box without a bottom; all four sides share the window parameters, the roof is blank. */
  box(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, base: number, seed: number, bay: number, floorH: number, lit: number, kind: number) {
    this.wall(x1, z0, -1, 0, x1 - x0, y0, y1, 0, -1, base, seed, bay, floorH, lit, kind);
    this.wall(x0, z1, 1, 0, x1 - x0, y0, y1, 0, 1, base, seed + 0.17, bay, floorH, lit, kind);
    this.wall(x1, z1, 0, -1, z1 - z0, y0, y1, 1, 0, base, seed + 0.31, bay, floorH, lit, kind);
    this.wall(x0, z0, 0, 1, z1 - z0, y0, y1, -1, 0, base, seed + 0.53, bay, floorH, lit, kind);
    const v = this.pos.length / 3;
    for (const [x, z] of [
      [x0, z0],
      [x0, z1],
      [x1, z1],
      [x1, z0],
    ]) {
      this.pos.push(x, y1, z);
      this.nor.push(0, 1, 0);
      this.face.push(x, z, seed, 0);
      this.win.push(1, 1, 0, BLANK);
    }
    this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aFace', new THREE.Float32BufferAttribute(this.face, 4));
    g.setAttribute('aWin', new THREE.Float32BufferAttribute(this.win, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const facadeHead = /* glsl */ `
uniform float skTime;
uniform float skGlow;
varying vec4 vFace;
varying vec4 vWin;
float skHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Coverage of the box [lo, hi] (per axis) over a pixel footprint of width fw centred on f: an analytic box filter.
vec2 skCover(vec2 f, vec2 fw, vec2 lo, vec2 hi) {
  return clamp((min(f + fw * 0.5, hi) - max(f - fw * 0.5, lo)) / fw, 0.0, 1.0);
}
`;

// Runs right after diffuseColor is set: decides wall vs glass and the window's emissive, used further down.
const facadeBody = /* glsl */ `
float skKind = vWin.w;
float skSeed = vFace.z;
float skGlass = 0.0;
vec3 skEmis = vec3(0.0);
vec3 skWall = vec3(0.028, 0.03, 0.035) * (0.6 + 0.8 * skHash(vec2(floor(skSeed), 3.1)));
if (skKind < 1.5 || skKind > 3.5) {
  bool office = skKind < 0.5;
  bool shop = skKind > 3.5;
  vec2 g = vec2(vFace.x / vWin.x, vFace.y / vWin.y);
  vec2 cell = floor(g);
  vec2 f = g - cell;
  vec2 fw = max(fwidth(g), vec2(1e-4));
  vec2 lo = office ? vec2(0.04, 0.24) : shop ? vec2(0.05, 0.06) : vec2(0.2, 0.3);
  vec2 hi = office ? vec2(0.96, 0.9) : shop ? vec2(0.95, 0.78) : vec2(0.8, 0.86);
  // Far away a window shrinks under a pixel: fade from the filtered shape to its average coverage.
  // Past ~40 m the fog smears everything anyway: drop the room detail too, so a window is one even glow (the fog's
  // bright-pass would otherwise punch holes where curtains and sash bars darken it).
  float dist = length(vViewPosition);
  float far = smoothstep(0.3, 0.8, max(fw.x, fw.y));
  float fd = max(far, smoothstep(35.0, 70.0, dist));
  vec2 cv = skCover(f, fw, lo, hi);
  float area = (hi.x - lo.x) * (hi.y - lo.y);
  float m = cv.x * cv.y;
  if (office) {
    // Thin mullion mid-bay in the ribbon glazing.
    float mul = skCover(vec2(f.x, 0.5), fw, vec2(0.49, 0.0), vec2(0.51, 1.0)).x;
    m *= 1.0 - mul;
    area *= 0.98;
  }
  m = mix(m, area, far);
  // Whole floors are lit or dark (the cleaners' floor, the late tenants), and tenant blocks of a few bays go dark.
  float fh = skHash(vec2(cell.y, skSeed * 13.7));
  float zone = skHash(vec2(floor(cell.x / 4.0) + cell.y * 17.0, skSeed * 5.3 + 5.0));
  float p = fh < vWin.z ? 0.8 : 0.07;
  p *= zone < 0.22 ? 0.25 : 1.0;
  if (shop) p = cell.y < 0.5 ? 0.25 : 0.05;
  float wh = skHash(cell + skSeed * 7.13);
  float lit = step(wh, p);
  float th = skHash(cell.yx * 1.7 + skSeed * 3.3 + 11.0);
  float coolShare = office ? 0.68 : 0.14;
  vec3 c = th < coolShare ? vec3(0.6, 0.8, 1.0) : vec3(1.0, 0.54, 0.22);
  if (!office && !shop && th > 0.92) {
    float tv = 0.6 + 0.4 * sin(skTime * (6.0 + 9.0 * wh) + wh * 50.0) * sin(skTime * (1.3 + 2.0 * th) + 4.0 * wh);
    c = vec3(0.28, 0.42, 1.0) * tv;
  }
  // Shops are closed at 2 am: a few lit displays and night lights, dim and mostly warm.
  if (shop) c = mix(vec3(0.16, 0.08, 0.025), vec3(0.03, 0.05, 0.08), step(0.85, th));
  float level = mix(0.4 + 0.9 * skHash(cell + skSeed + 2.7), 0.85, 0.6 * fd);
  // Blinds lowered from the top by a random amount; the room shows dimly through them.
  float wy = clamp((f.y - lo.y) / (hi.y - lo.y), 0.0, 1.0);
  float bl = skHash(cell * 1.31 + skSeed + 9.0);
  bl = bl < 0.45 ? 0.0 : (bl - 0.45) * 1.4;
  if (shop) bl = 0.0;
  float fy = fw.y / (hi.y - lo.y);
  float cover = smoothstep(1.0 - bl - fy - 0.01, 1.0 - bl + fy + 0.01, wy);
  float shade = mix(mix(1.0, 0.22, cover), 1.0 - 0.78 * bl, fd);
  // Inside the room: a lamp somewhere along the window (homes) or fluorescent strips under the ceiling (offices),
  // curtains drawn in from the sides, and the sash bars of a home window. All fade out at distance.
  float wx = clamp((f.x - lo.x) / (hi.x - lo.x), 0.0, 1.0);
  float room;
  if (office) room = 0.62 + 0.5 * smoothstep(0.55, 0.95, wy);
  else {
    float lampX = skHash(cell + skSeed * 2.9 + 4.0);
    room = 0.6 + 0.55 * (1.0 - smoothstep(0.0, 0.7, abs(wx - lampX))) + 0.2 * wy;
    float cur = skHash(cell * 0.77 + skSeed + 21.0);
    cur = cur < 0.4 ? 0.0 : 0.08 + (cur - 0.4) * 0.45;
    float fx = fw.x / (hi.x - lo.x) + 0.01;
    room *= 1.0 - 0.65 * (1.0 - smoothstep(cur - fx, cur + fx, wx) * smoothstep(cur - fx, cur + fx, 1.0 - wx));
    if (!shop) {
      vec2 wl = vec2(wx, wy);
      vec2 wfw = fw / (hi - lo);
      float bars = max(skCover(wl, wfw, vec2(0.485, 0.0), vec2(0.515, 1.0)).x, skCover(wl, wfw, vec2(0.0, 0.69), vec2(1.0, 0.72)).y);
      room *= 1.0 - 0.85 * bars;
    }
  }
  shade *= mix(room, 0.9, fd);
  // Close windows (the blocks across the plaza, a few metres of fog away) are held back so they do not blow out;
  // far ones get the full HDR gain to punch through the murk.
  float gain = skGlow * mix(0.25, 1.0, smoothstep(10.0, 60.0, dist));
  skEmis = c * (lit * level * shade * m * gain);
  // Dark windows still hint at a room behind the glass.
  skEmis += vec3(0.5, 0.6, 0.8) * ((1.0 - lit) * m * 0.004 * skGlow);
  skGlass = m;
} else if (skKind > 2.5) {
  // Floodlit crown: washed from below, warm or cool per building.
  vec3 cc = mix(vec3(1.0, 0.72, 0.42), vec3(0.62, 0.8, 1.0), step(0.5, skHash(vec2(floor(skSeed), 1.0))));
  // Clamped: MSAA edge samples extrapolate the varying past 1, and pow() of a negative is NaN (black specks).
  float up = clamp(1.0 - vFace.w, 0.0, 1.0);
  skEmis = cc * skGlow * 0.3 * (0.15 + 0.85 * up * up);
}
diffuseColor.rgb = mix(skWall, vec3(0.01, 0.012, 0.016), skGlass);
`;

function facadeMaterial(time: THREE.IUniform, glow: THREE.IUniform) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0, envMapIntensity: 0.35 });
  mat.onBeforeCompile = (s) => {
    s.uniforms.skTime = time;
    s.uniforms.skGlow = glow;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aFace;\nattribute vec4 aWin;\nvarying vec4 vFace;\nvarying vec4 vWin;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFace = aFace;\nvWin = aWin;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + facadeHead)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + facadeBody)
      // Wet, slightly sheened walls; the glass is nearly a mirror.
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.42 + 0.2 * skHash(vec2(skSeed, 8.0)), 0.07, skGlass);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += skEmis;');
  };
  mat.customProgramCacheKey = () => 'skyline-facade-1';
  return mat;
}

/** Small lamps as camera-facing discs: they write depth (so the fog treats them as far-away surfaces) and never get
 *  thinner than ~3 px, so a red light 150 m away still reads (and blooms) instead of flickering in and out. */
const lampVert = /* glsl */ `
attribute vec2 aCorner;
attribute vec4 aLight; // radius, phase, kind, gain
attribute vec3 aColor;
uniform float skTime;
uniform float skGlow;
varying vec2 vC;
varying vec3 vCol;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float r = max(aLight.x, -mv.z * 0.0042);
  // Grown to stay visible: spread the same energy over the larger disc.
  float spread = (aLight.x * aLight.x) / (r * r);
  mv.xy += aCorner * r;
  vC = aCorner;
  float on = 1.0;
  if (aLight.z < 0.5) {
    // Aviation light: a 1.5 s cycle, about half a second on with soft edges (incandescent warm-up).
    float t = fract(skTime / 1.5 + aLight.y);
    on = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.32, 0.45, t));
    on = 0.03 + 0.97 * on;
  }
  vCol = aColor * aLight.w * skGlow * on * mix(1.0, spread, 0.85);
  gl_Position = projectionMatrix * mv;
}`;

const lampFrag = /* glsl */ `
varying vec2 vC;
varying vec3 vCol;
void main() {
  float r = length(vC);
  if (r > 1.0) discard;
  float core = 1.0 - smoothstep(0.35, 1.0, r);
  gl_FragColor = vec4(vCol * (0.25 + 0.75 * core), 1.0);
}`;

class Lamps {
  pos: number[] = [];
  corner: number[] = [];
  light: number[] = [];
  color: number[] = [];
  idx: number[] = [];
  add(x: number, y: number, z: number, radius: number, phase: number, kind: number, gain: number, c: [number, number, number]) {
    const v = this.pos.length / 3;
    for (const [cx, cy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      this.pos.push(x, y, z);
      this.corner.push(cx, cy);
      this.light.push(radius, phase, kind, gain);
      this.color.push(...c);
    }
    this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(this.corner, 2));
    g.setAttribute('aLight', new THREE.Float32BufferAttribute(this.light, 4));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.color, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    // The discs grow with distance; pad the bounds so they are not culled at the frustum edge.
    g.boundingSphere!.radius += 4;
    return g;
  }
}

/** Two neon signs in one atlas: "DINER" (pink, horizontal) and a vertical "BAR" blade (cyan). */
function neonTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 512, 512);
  g.lineJoin = g.lineCap = 'round';
  const tube = (draw: () => void, col: string) => {
    g.shadowColor = col;
    g.shadowBlur = 18;
    g.strokeStyle = col;
    g.lineWidth = 9;
    draw();
    g.shadowBlur = 6;
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    draw();
    g.shadowBlur = 0;
  };
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Letters as filled glyphs with a tube-coloured glow: an outline stroke of a bold face reads as scribbles at range.
  const glyphs = (draw: () => void, col: string) => {
    g.shadowColor = col;
    g.shadowBlur = 22;
    g.fillStyle = col;
    draw();
    g.shadowBlur = 4;
    g.fillStyle = '#ffd9ec';
    draw();
    g.shadowBlur = 0;
  };
  g.font = 'bold 104px Arial, sans-serif';
  glyphs(() => g.fillText('DINER', 256, 84), '#ff3d8b');
  tube(() => g.strokeRect(20, 18, 472, 124), '#ff3d8b');
  g.font = 'bold 92px Arial, sans-serif';
  glyphs(() => {
    g.fillText('B', 256, 225);
    g.fillText('A', 256, 335);
    g.fillText('R', 256, 445);
  }, '#38e6ff');
  tube(() => g.strokeRect(186, 168, 140, 330), '#38e6ff');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

interface Lot {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  tier: 'low' | 'tower' | 'far';
}

export function buildSkyline(o: SkylineOpts): Skyline {
  const group = new THREE.Group();
  group.name = 'skyline';
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(d: T) => (disposables.push(d), d);
  const { facadeZ, ext } = o;
  const time: THREE.IUniform = { value: 0 };
  const glow: THREE.IUniform = { value: WINDOW_GLOW };

  const r = seeded(4242);
  const lots: Lot[] = [];
  // Mid-ground: a row of low blocks across the plaza with an avenue straight ahead of the entrance.
  for (let x = -78; x < 78; ) {
    const w = 10 + r() * 9;
    const d = 12 + r() * 6;
    let bw = w;
    if (x + w > -7 && x < 7) {
      // Trim the block at the avenue's kerb, or jump over the avenue when too little is left.
      bw = -7 - x;
      if (bw < 8) {
        x = 7;
        continue;
      }
    }
    lots.push({ x: x + bw / 2, z: facadeZ - 28 - d / 2, w: bw, d, h: 10 + r() * 16, tier: 'low' });
    x += w + 2.5 + r() * 3;
  }
  // Towers behind it, then a far row of taller ones.
  for (let x = -92; x < 92; x += 17 + r() * 9) lots.push({ x, z: facadeZ - 62 - r() * 14, w: 9 + r() * 9, d: 10 + r() * 8, h: 38 + r() * 75, tier: 'tower' });
  for (let x = -150; x < 150; x += 24 + r() * 12) lots.push({ x, z: facadeZ - 112 - r() * 30, w: 14 + r() * 10, d: 14 + r() * 10, h: 60 + r() * 110, tier: 'far' });
  // Side streets: close low blocks across the street from the hotel's flanks, towers behind them.
  for (const side of [-1, 1]) {
    for (let z = facadeZ - 22; z < ext.maxZ + 50; ) {
      const d = 12 + r() * 7;
      const w = 12 + r() * 6;
      const x0 = side > 0 ? ext.maxX + 11 : ext.minX - 11 - w;
      lots.push({ x: x0 + w / 2, z: z + d / 2, w, d, h: 12 + r() * 22, tier: 'low' });
      z += d + 2.5 + r() * 3;
    }
    for (let z = facadeZ - 30; z < ext.maxZ + 70; z += 22 + r() * 10) {
      const w = 12 + r() * 8;
      lots.push({ x: side * (ext.maxX + 38 + r() * 12 + w / 2), z, w, d: 12 + r() * 8, h: 30 + r() * 70, tier: 'tower' });
    }
  }

  const walls = new Builder();
  const clutter = new Builder();
  const lamps = new Lamps();
  const RED: [number, number, number] = [1, 0.06, 0.02];
  const WARM: [number, number, number] = [1, 0.75, 0.45];
  let seed = 1;
  for (const L of lots) {
    seed++;
    const office = L.tier !== 'low' ? r() < 0.65 : r() < 0.2;
    const kind = office ? OFFICE : HOME;
    const floorH = office ? 3.8 + r() * 0.4 : 3.0 + r() * 0.4;
    const bay = office ? 1.6 + r() * 0.6 : 2.6 + r() * 0.8;
    const lit = office ? 0.15 + r() * 0.25 : 0.3 + r() * 0.3;
    let x0 = L.x - L.w / 2;
    let x1 = L.x + L.w / 2;
    let z0 = L.z - L.d / 2;
    let z1 = L.z + L.d / 2;
    let y = 0;
    let base = 0;
    // Shopfront podium: the closer blocks and some towers stand on a lit ground floor, a bit wider than the shaft.
    if (L.tier === 'low' || r() < 0.5) {
      const ph = L.tier === 'low' ? 4.5 : 4.5 + Math.floor(r() * 2) * 4.5;
      const grow = L.tier === 'low' ? 0 : 1 + r() * 2;
      walls.box(x0 - grow, x1 + grow, z0 - grow, z1 + grow, 0, ph, 0, seed, 3.2, 4.5, 0, SHOP);
      y = base = ph;
    }
    // Shaft with up to two setbacks; slender towers rise without.
    const steps = L.tier === 'low' || L.w < 11 ? 0 : r() < 0.35 ? 2 : r() < 0.6 ? 1 : 0;
    const top = L.h;
    let segTop = steps ? y + (top - y) * (0.55 + r() * 0.15) : top;
    for (let s = 0; s <= steps; s++) {
      // Snap to whole floors so the window grid never gets cut mid-window at a setback.
      segTop = Math.max(y + floorH, base + Math.round((segTop - base) / floorH) * floorH);
      walls.box(x0, x1, z0, z1, y, segTop, base, seed, bay, floorH, lit, kind);
      y = segTop;
      const k = 0.72 + r() * 0.14;
      const cx = (x0 + x1) / 2 + (r() - 0.5) * (x1 - x0) * 0.15;
      const cz = (z0 + z1) / 2 + (r() - 0.5) * (z1 - z0) * 0.15;
      const hw = ((x1 - x0) * k) / 2;
      const hd = ((z1 - z0) * k) / 2;
      if (s < steps) {
        // Roof lights at the corners of each setback terrace.
        if (y > 40) for (const [lx, lz] of [[x0, z0], [x1, z1]]) lamps.add(lx, y + 0.3, lz, 0.25, 0, 1, 0.9, RED);
        x0 = cx - hw;
        x1 = cx + hw;
        z0 = cz - hd;
        z1 = cz + hd;
        segTop = y + (top - y) * (0.5 + r() * 0.2);
      }
    }
    const crowned = L.tier !== 'low' && r() < 0.3;
    if (crowned) {
      const ch = 4 + r() * 4;
      const inset = 0.4;
      walls.box(x0 + inset, x1 - inset, z0 + inset, z1 - inset, y, y + ch, y, seed, 4, ch, 0, CROWN);
      // The floods themselves, along the crown's foot.
      const n = Math.max(2, Math.round((x1 - x0) / 5));
      for (let i = 0; i <= n; i++) lamps.add(x0 + ((x1 - x0) * i) / n, y + 0.2, z1 + 0.15, 0.15, 0, 2, 0.45, WARM);
      y += ch;
    }
    // Roof clutter: plant rooms, water tanks, and masts on the tall ones.
    const nb = 1 + Math.floor(r() * 3);
    for (let i = 0; i < nb; i++) {
      const bw = 1.5 + r() * 4;
      const bd = 1.5 + r() * 4;
      const bx = x0 + 0.5 + r() * Math.max(0.1, x1 - x0 - bw - 1);
      const bz = z0 + 0.5 + r() * Math.max(0.1, z1 - z0 - bd - 1);
      clutter.box(bx, bx + bw, bz, bz + bd, y, y + 1.2 + r() * 2.5, y, seed + i * 0.01, 4, 4, 0, BLANK);
    }
    // Aviation lights: every building over ~40 m, corners synchronised per building, plus a mast on the tallest.
    if (y > 40) {
      const ph = r();
      lamps.add(x0, y + 0.4, z0, 0.4, ph, 0, 6, RED);
      lamps.add(x1, y + 0.4, z1, 0.4, ph, 0, 6, RED);
      lamps.add(x0, y + 0.4, z1, 0.4, ph, 0, 6, RED);
      if (y > 85) {
        const mh = 8 + r() * 10;
        const mx = (x0 + x1) / 2;
        const mz = (z0 + z1) / 2;
        clutter.box(mx - 0.2, mx + 0.2, mz - 0.2, mz + 0.2, y, y + mh, y, seed, 1, 1, 0, BLANK);
        lamps.add(mx, y + mh + 0.3, mz, 0.5, ph + 0.5, 0, 7, RED);
        lamps.add(mx, y + mh * 0.55, mz - 0.25, 0.25, 0, 1, 0.8, RED);
      }
    }
  }

  const facadeMat = keep(facadeMaterial(time, glow));
  const wallMesh = new THREE.Mesh(keep(walls.build()), facadeMat);
  const clutterMesh = new THREE.Mesh(keep(clutter.build()), facadeMat);
  const lampMat = keep(new THREE.ShaderMaterial({ uniforms: { skTime: time, skGlow: glow }, vertexShader: lampVert, fragmentShader: lampFrag }));
  const lampMesh = new THREE.Mesh(keep(lamps.build()), lampMat);

  // Neon: "DINER" over a shopfront of the nearest low block left of the avenue, a "BAR" blade on the east side street.
  const neonMat = keep(new THREE.MeshBasicMaterial({ map: keep(neonTexture()), vertexColors: true }));
  const neonGeo = (() => {
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const quad = (pts: number[][], uvs: number[][]) => {
      const v = pos.length / 3;
      for (let i = 0; i < 4; i++) {
        pos.push(...pts[i]);
        uv.push(...uvs[i]);
        col.push(1, 1, 1);
      }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    };
    const diner = lots.filter((l) => l.tier === 'low' && l.z < facadeZ - 20 && l.x < -6).sort((a, b) => b.x - a.x)[0];
    if (diner) {
      const z = diner.z + diner.d / 2 + 0.05;
      const w = Math.min(7, diner.w - 1);
      const y = 5.4;
      quad(
        [
          [diner.x - w / 2, y, z],
          [diner.x + w / 2, y, z],
          [diner.x + w / 2, y + w * 0.3, z],
          [diner.x - w / 2, y + w * 0.3, z],
        ],
        [
          [0, 1 - 160 / 512],
          [1, 1 - 160 / 512],
          [1, 1],
          [0, 1],
        ],
      );
    }
    const bar = lots.filter((l) => l.tier === 'low' && l.x > ext.maxX).sort((a, b) => a.z - b.z)[0];
    if (bar) {
      const x = bar.x - bar.w / 2 - 0.9;
      const z = bar.z + bar.d / 2 - 2;
      for (const s of [1, -1]) {
        // Double-sided blade sticking out of the wall: one face toward each end of the street.
        const a = s > 0 ? [x + 0.8, z] : [x - 0.8, z];
        const b = s > 0 ? [x - 0.8, z] : [x + 0.8, z];
        quad(
          [
            [a[0], 4.5, a[1] + 0.02 * s],
            [b[0], 4.5, b[1] + 0.02 * s],
            [b[0], 8.3, b[1] + 0.02 * s],
            [a[0], 8.3, a[1] + 0.02 * s],
          ],
          [
            [180 / 512, 1 - 505 / 512],
            [332 / 512, 1 - 505 / 512],
            [332 / 512, 1 - 162 / 512],
            [180 / 512, 1 - 162 / 512],
          ],
        );
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  })();
  keep(neonGeo);
  const neonMesh = new THREE.Mesh(neonGeo, neonMat);
  const neonCol = neonGeo.getAttribute('color') as THREE.BufferAttribute;

  for (const m of [wallMesh, clutterMesh, lampMesh, neonMesh]) {
    m.castShadow = false;
    m.receiveShadow = false;
    m.userData.noMoonShadow = true;
    group.add(m);
  }
  wallMesh.receiveShadow = true;

  const applyQuality = (q: Quality) => {
    clutterMesh.visible = q !== 'low';
  };
  applyQuality(o.quality);

  // Neon flicker: the DINER sign stutters now and then, the blade hums steadily.
  const NEON_GAIN = 8;
  let stutter = 0;
  let nextStutter = 3;
  return {
    group,
    update(dt, t) {
      time.value = t;
      nextStutter -= dt;
      if (nextStutter <= 0) {
        stutter = 0.5 + Math.random() * 0.6;
        nextStutter = 4 + Math.random() * 9;
      }
      stutter = Math.max(0, stutter - dt);
      const diner = stutter > 0 ? (Math.sin(t * 61) * Math.sin(t * 23) > 0.1 ? 1 : 0.06) : 1;
      for (let i = 0; i < neonCol.count; i++) {
        const k = (i < 4 && neonCol.count > 8 ? diner : 1) * NEON_GAIN * (0.96 + 0.04 * Math.sin(t * 120 + i));
        neonCol.setXYZ(i, k, k, k);
      }
      neonCol.needsUpdate = true;
    },
    setQuality(q) {
      applyQuality(q);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
