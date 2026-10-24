// The stage: a long floor of mossy stone tiles with carved rune circles in an enchanted library courtyard at dusk, seen
// from high above and in front. The side walls, shelves and props come from library.ts; this file owns the floor, the
// lights and the two defenders at the bottom of the field: a little wizard with a green pointy hat, a knitted scarf
// and a candle, and his round cream-and-teal robot cannon, whose barrel follows the current target and fires.
//
// Coordinates: y is up, the floor is y = 0. Creatures walk from the far end (negative z) towards the defence line at
// z = LINE_Z; the defenders stand just in front of it (positive z, towards the camera).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildLibrary } from './library';
import { flat, hullGeometry, inkMaterial, toon } from './toon';

/** Game-logic distance (`Enemy.y`) at which a creature reaches the defence line. */
export const IMPACT_Y = 3.4;
/** World z of the defence line. */
export const LINE_Z = 0;
/** Half the width of the tiled field (the library walls stand just outside it). */
export const FIELD_HALF = 8;
/** Length of the field from the defence line to the far end. */
export const FIELD_LENGTH = 40;
/** How far in front of the line (towards the camera) the defenders reach; the camera keeps this above the word panel. */
export const DEFENDER_FRONT = 3.6;

/** World z for a game-logic distance to the line. */
export const fieldZ = (y: number) => LINE_Z - (y - IMPACT_Y);

/** Outline thickness for everything chunky and cute (thicker than the default ink). */
export const THICK = 0.0068;

export const PAL = {
  cream: 0xf3e8d0,
  creamDark: 0xe0cfae,
  red: 0xc9473f,
  blue: 0x4fa3ff,
  yellow: 0xffd23f,
  mint: 0x5fd6b0,
  teal: 0x2a8a9c,
  tealDark: 0x1c5a68,
  robe: 0x34594a,
  hat: 0x3e6b48,
  skin: 0xf0c49c,
  candle: 0xf6ecd2,
  flame: 0xffd36b,
  laser: 0x9cff6a,
};

/** Adds a toon mesh with an ink hull to `parent`. */
export function inked(parent: THREE.Object3D, geo: THREE.BufferGeometry, color: number, ink: number | false = THICK): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, toon(color));
  if (ink !== false) mesh.add(new THREE.Mesh(hullGeometry(geo), inkMaterial(ink, 0.012)));
  parent.add(mesh);
  return mesh;
}

/** A flat shape with a slightly larger ink copy behind it: for things that face the camera (flags, flames). */
export function flatInked(parent: THREE.Object3D, geo: THREE.BufferGeometry, color: number, inkScale = 1.08, gap = 0.02): THREE.Group {
  const g = new THREE.Group();
  const ink = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x16121c, side: THREE.DoubleSide }));
  ink.scale.setScalar(inkScale);
  ink.position.z = -gap;
  const face = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  g.add(ink, face);
  parent.add(g);
  return g;
}

/** Big glossy cartoon eye: black oval, two white highlights. */
export function cuteEye(parent: THREE.Object3D, x: number, y: number, z: number, r: number) {
  const eye = new THREE.Group();
  eye.position.set(x, y, z);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), flat(0x1b1630));
  ball.scale.set(0.82, 1.08, 0.5);
  eye.add(ball);
  const hi = new THREE.Mesh(new THREE.SphereGeometry(r * 0.34, 10, 8), flat(0xffffff));
  hi.position.set(-r * 0.25, r * 0.42, r * 0.38);
  const hi2 = new THREE.Mesh(new THREE.SphereGeometry(r * 0.16, 8, 6), flat(0xffffff));
  hi2.position.set(r * 0.28, -r * 0.3, r * 0.38);
  eye.add(hi, hi2);
  parent.add(eye);
  return eye;
}

/** Pink blush circles on a face. */
export function cheeks(parent: THREE.Object3D, x: number, y: number, z: number, r: number, color = 0xff8fb1) {
  for (const s of [-1, 1]) {
    const c = new THREE.Mesh(new THREE.CircleGeometry(r, 16), flat(color));
    c.position.set(s * x, y, z);
    c.lookAt(s * x * 3, y, z + 4);
    parent.add(c);
  }
}

export interface World {
  /** The robot's barrel (and the wizard's gaze) follow the current target. */
  aimAt(target: THREE.Vector3, dt: number): void;
  /** World position beams start from (the robot's muzzle). */
  muzzle(out: THREE.Vector3): THREE.Vector3;
  /** Defender reactions: a shot, a typo. */
  cast(): void;
  oops(): void;
  /** Visible damage: called with the fraction of health left. */
  setDamage(frac: number): void;
  update(dt: number, t: number): void;
}

// ---- helpers ------------------------------------------------------------------------------------------------------

/** Seeded random numbers, so the floor looks the same every visit. */
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

/** Collects geometry per colour and bakes it into one mesh per colour (few draw calls for a whole character). */
class Baker {
  constructor(private readonly material: (color: number) => THREE.Material = toon) {}
  private parts = new Map<number, THREE.BufferGeometry[]>();
  add(geo: THREE.BufferGeometry, color: number) {
    let list = this.parts.get(color);
    if (!list) this.parts.set(color, (list = []));
    list.push(geo);
    return geo;
  }
  bake(parent: THREE.Object3D) {
    for (const [color, list] of this.parts) {
      const geo = list.length === 1 ? list[0] : mergeGeometries(list);
      parent.add(new THREE.Mesh(geo, this.material(color)));
    }
    this.parts.clear();
  }
}

let glowTex: THREE.Texture | null = null;
/** A soft round glow for additive sprites (candle flame, muzzle). */
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

function glow(color: number, size: number) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
  );
  s.scale.setScalar(size);
  return s;
}

// ---- floor --------------------------------------------------------------------------------------------------------

/** The defenders are modelled at about creature size and drawn a little bigger. */
const DEFENDER_SCALE = 1.05;
const FLOOR_HALF = FIELD_HALF + 7;
const FLOOR_NEAR = LINE_Z + 14;
const FLOOR_FAR = LINE_Z - FIELD_LENGTH - 4;
const TILE = 1.6;

/**
 * Paints the whole floor once into one canvas: irregular grey-green flagstones with mortar joints full of moss, faint
 * carved rune circles, a row of golden glyphs along the defence line, darker edges under the shelves. The same canvas
 * doubles as the bump map, so joints and carvings sink in under the low warm light.
 */
function floorTexture(): THREE.CanvasTexture {
  const PX = 40;
  const W = FLOOR_HALF * 2 * PX;
  const H = (FLOOR_NEAR - FLOOR_FAR) * PX;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const rnd = rng(1234);
  const X = (x: number) => (x + FLOOR_HALF) * PX;
  const Z = (z: number) => (z - FLOOR_FAR) * PX;

  // Mortar.
  g.fillStyle = '#34372e';
  g.fillRect(0, 0, W, H);

  // Flagstones: a regular grid with jittered gaps, some tiles split in two, each a slightly different grey-green.
  const stone = (x: number, y: number, w: number, h: number) => {
    const inset = 1.1 + rnd() * 1.1;
    // Weathered grey-green stone, warmed by the lamplight.
    // Grey-green to blue-grey slate; the lamps and the colour grade bring the warmth.
    const hue = 90 + rnd() * 110;
    const sat = 5 + rnd() * 7;
    const lit = 46 + rnd() * 10;
    const r = 4 + rnd() * 6;
    g.save();
    // A slightly wonky rounded quad, so the stones look hand-cut.
    const j = () => (rnd() - 0.5) * 3.5;
    const pts = [
      [x + inset + j(), y + inset + j()],
      [x + w - inset + j(), y + inset + j()],
      [x + w - inset + j(), y + h - inset + j()],
      [x + inset + j(), y + h - inset + j()],
    ];
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % 4];
      const [px, py] = pts[(i + 3) % 4];
      const la = Math.hypot(ax - px, ay - py);
      const lb = Math.hypot(bx - ax, by - ay);
      const sx = ax + ((px - ax) / la) * r;
      const sy = ay + ((py - ay) / la) * r;
      const ex = ax + ((bx - ax) / lb) * r;
      const ey = ay + ((by - ay) / lb) * r;
      if (i === 0) g.moveTo(sx, sy);
      else g.lineTo(sx, sy);
      g.quadraticCurveTo(ax, ay, ex, ey);
    }
    g.closePath();
    g.fillStyle = `hsl(${hue} ${sat}% ${lit}%)`;
    g.fill();
    g.clip();
    // Weathering blotches.
    for (let i = 0; i < 4; i++) {
      const bx = x + rnd() * w;
      const by = y + rnd() * h;
      const br = 10 + rnd() * 30;
      const grad = g.createRadialGradient(bx, by, 0, bx, by, br);
      const dark = rnd() > 0.5;
      grad.addColorStop(0, dark ? 'rgba(30,34,24,0.16)' : 'rgba(230,228,210,0.1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x, y, w, h);
    }
    // Bevel: a light top-left lip, a dark bottom-right one.
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(235,235,210,0.16)';
    g.beginPath();
    g.moveTo(x + inset + 2, y + h - inset - r);
    g.lineTo(x + inset + 2, y + inset + 2);
    g.lineTo(x + w - inset - r, y + inset + 2);
    g.stroke();
    g.strokeStyle = 'rgba(10,14,8,0.2)';
    g.beginPath();
    g.moveTo(x + w - inset - 2, y + inset + r);
    g.lineTo(x + w - inset - 2, y + h - inset - 2);
    g.lineTo(x + inset + r, y + h - inset - 2);
    g.stroke();
    // A hairline crack now and then.
    if (rnd() < 0.18) {
      g.strokeStyle = 'rgba(15,20,12,0.45)';
      g.lineWidth = 1.2;
      g.beginPath();
      let cx = x + rnd() * w;
      let cy = y;
      g.moveTo(cx, cy);
      while (cy < y + h) {
        cx += (rnd() - 0.5) * 14;
        cy += 6 + rnd() * 10;
        g.lineTo(cx, cy);
      }
      g.stroke();
    }
    g.restore();
  };
  const T = TILE * PX;
  for (let ty = 0; ty < H; ty += T) {
    for (let tx = 0; tx < W; tx += T) {
      const k = rnd();
      if (k < 0.12) {
        stone(tx, ty, T / 2, T);
        stone(tx + T / 2, ty, T / 2, T);
      } else if (k < 0.22) {
        stone(tx, ty, T, T / 2);
        stone(tx, ty + T / 2, T, T / 2);
      } else stone(tx, ty, T, T);
    }
  }

  // Carved runes: double rings, a star, small circles at the points, and border lines along the field edges.
  const carve = (draw: () => void, width: number) => {
    g.lineCap = 'round';
    g.save();
    g.translate(1.5, 1.5);
    g.strokeStyle = 'rgba(225,225,200,0.2)';
    g.lineWidth = width;
    draw();
    g.restore();
    g.strokeStyle = 'rgba(22,26,20,0.5)';
    g.lineWidth = width;
    draw();
  };
  const circle = (x: number, z: number, r: number) => () => {
    g.beginPath();
    g.arc(X(x), Z(z), r * PX, 0, Math.PI * 2);
    g.stroke();
  };
  const star = (x: number, z: number, r: number, points: number, inner: number, rot = 0) => () => {
    g.beginPath();
    for (let i = 0; i <= points * 2; i++) {
      const a = rot + (i / (points * 2)) * Math.PI * 2;
      const rr = (i % 2 ? inner : r) * PX;
      const px = X(x) + Math.sin(a) * rr;
      const py = Z(z) - Math.cos(a) * rr;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
  };
  const sigil = (x: number, z: number, r: number) => {
    carve(circle(x, z, r), 3);
    carve(circle(x, z, r * 0.92), 2);
    carve(star(x, z, r * 0.9, 4, r * 0.38), 2.5);
    carve(star(x, z, r * 0.55, 4, r * 0.24, Math.PI / 4), 2);
    carve(circle(x, z, r * 0.3), 2);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      carve(circle(x + Math.sin(a) * r, z - Math.cos(a) * r, r * 0.11), 2);
    }
  };
  sigil(0, LINE_Z - 13, 7.2);
  sigil(0, LINE_Z - 31, 5.6);
  carve(circle(0, LINE_Z + 3.5, 4.2), 2.5);
  carve(circle(0, LINE_Z + 3.5, 3.8), 2);
  for (const s of [-1, 1]) {
    carve(() => {
      g.beginPath();
      g.moveTo(X(s * (FIELD_HALF - 0.6)), Z(FLOOR_FAR));
      g.lineTo(X(s * (FIELD_HALF - 0.6)), Z(FLOOR_NEAR));
      g.stroke();
    }, 2.5);
    carve(circle(s * 5, LINE_Z - 22, 1.6), 2);
    carve(star(s * 5, LINE_Z - 22, 1.4, 4, 0.5), 2);
  }

  // The defence line: a row of faintly glowing golden glyphs across the field.
  g.strokeStyle = 'rgba(240,196,110,0.32)';
  g.lineWidth = 2;
  for (let x = -FIELD_HALF + 1; x <= FIELD_HALF - 1; x += 1.25) {
    const cx = X(x);
    const cy = Z(LINE_Z);
    g.beginPath();
    g.moveTo(cx - 9, cy);
    g.lineTo(cx, cy - 9);
    g.lineTo(cx + 9, cy);
    g.lineTo(cx, cy + 9);
    g.closePath();
    g.stroke();
  }

  // Moss: clumps along the joints, thicker towards the walls, plus tiny leaves of lighter green.
  for (let i = 0; i < 4200; i++) {
    const side = rnd() < 0.55;
    const x = side ? (rnd() < 0.5 ? -1 : 1) * (FIELD_HALF - 3 + rnd() * 10) : (rnd() * 2 - 1) * FLOOR_HALF;
    const z = FLOOR_FAR + rnd() * (FLOOR_NEAR - FLOOR_FAR);
    // Snap to the nearest joint, so moss grows in the mortar.
    const alongX = rnd() < 0.5;
    const jx = alongX ? X(x) : Math.round(X(x) / T) * T + (rnd() - 0.5) * 6;
    const jy = alongX ? Math.round(Z(z) / T) * T + (rnd() - 0.5) * 6 : Z(z);
    const r = 1.5 + rnd() * (side ? 6 : 3);
    g.fillStyle = `hsla(${80 + rnd() * 25} ${28 + rnd() * 22}% ${26 + rnd() * 16}% / ${0.5 + rnd() * 0.4})`;
    g.beginPath();
    g.ellipse(jx, jy, r * (alongX ? 1.8 : 0.8), r * (alongX ? 0.8 : 1.8), 0, 0, Math.PI * 2);
    g.fill();
  }

  // Grain: per-pixel noise so the stone does not look like flat vector shapes.
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 14;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n * 0.8;
  }
  g.putImageData(img, 0, 0);

  // A soft pool of warm lamplight down the middle of the hall.
  for (const [cz, r, a] of [
    [LINE_Z - 9, FIELD_HALF * 1.9, 0.36],
    [LINE_Z - 24, FIELD_HALF * 1.5, 0.18],
  ] as const) {
    const pool = g.createRadialGradient(X(0), Z(cz), 0, X(0), Z(cz), r * PX);
    pool.addColorStop(0, `rgba(255,196,112,${a})`);
    pool.addColorStop(0.55, `rgba(255,180,96,${a * 0.45})`);
    pool.addColorStop(1, 'rgba(255,170,90,0)');
    g.fillStyle = pool;
    g.fillRect(0, 0, W, H);
  }
  // Dusk blue settles into the corners, away from the lamps.
  const dusk = g.createRadialGradient(X(0), Z(LINE_Z - 12), FIELD_HALF * 1.2 * PX, X(0), Z(LINE_Z - 12), FIELD_HALF * 2.6 * PX);
  dusk.addColorStop(0, 'rgba(40,48,90,0)');
  dusk.addColorStop(1, 'rgba(40,48,90,0.22)');
  g.fillStyle = dusk;
  g.fillRect(0, 0, W, H);

  // Darken under the shelves and towards the far end (a baked vignette).
  for (const s of [-1, 1]) {
    const x0 = X(s * (FIELD_HALF - 2));
    const x1 = X(s * FLOOR_HALF);
    const grad = g.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, 'rgba(18,10,4,0)');
    grad.addColorStop(1, 'rgba(18,10,4,0.6)');
    g.fillStyle = grad;
    g.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), H);
  }
  const far = g.createLinearGradient(0, 0, 0, Z(LINE_Z - FIELD_LENGTH + 10));
  far.addColorStop(0, 'rgba(12,8,4,0.6)');
  far.addColorStop(1, 'rgba(12,8,4,0)');
  g.fillStyle = far;
  g.fillRect(0, 0, W, Z(LINE_Z - FIELD_LENGTH + 10));

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function buildFloor(scene: THREE.Scene) {
  const tex = floorTexture();
  const geo = new THREE.PlaneGeometry(FLOOR_HALF * 2, FLOOR_NEAR - FLOOR_FAR);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, (FLOOR_NEAR + FLOOR_FAR) / 2);
  const mat = new THREE.MeshLambertMaterial({ map: tex, bumpMap: tex, bumpScale: 0.7 });
  const floor = new THREE.Mesh(geo, mat);
  floor.name = 'floor';
  floor.renderOrder = -1;
  scene.add(floor);
}

/** Cracks in the stones by the defence line, revealed one by one as health drops (one draw call, via drawRange). */
function buildCracks(scene: THREE.Scene) {
  const rnd = rng(99);
  const pos: number[] = [];
  const ends: number[] = [0];
  const N = 9;
  for (let k = 0; k < N; k++) {
    let x = (k / (N - 1) - 0.5) * 2 * (FIELD_HALF - 2.5) + (rnd() - 0.5) * 1.5;
    let z = LINE_Z - 0.6 + rnd() * 0.6;
    let dir = -Math.PI / 2 + (rnd() - 0.5) * 1.2;
    const segs = 6 + ((rnd() * 4) | 0);
    for (let i = 0; i < segs; i++) {
      const len = 0.25 + rnd() * 0.35;
      const w = 0.07 * (1 - i / segs) + 0.015;
      dir += (rnd() - 0.5) * 1.1;
      const nx = x + Math.cos(dir) * len;
      const nz = z + Math.sin(dir) * len;
      const px = -Math.sin(dir) * w;
      const pz = Math.cos(dir) * w;
      const y = 0.012;
      pos.push(x + px, y, z + pz, x - px, y, z - pz, nx, y, nz);
      pos.push(x + px, y, z + pz, nx, y, nz, nx + px * 0.5, y, nz + pz * 0.5);
      x = nx;
      z = nz;
    }
    ends.push(pos.length / 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x120e0a, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  mesh.frustumCulled = false;
  scene.add(mesh);
  return (frac: number) => geo.setDrawRange(0, ends[Math.round((1 - Math.max(0, Math.min(1, frac))) * N)]);
}

// ---- defenders ----------------------------------------------------------------------------------------------------

/** The little wizard, seen mostly from behind: pointy green hat, cream scarf, dark green robe, a candle in his hand. */
function makeWizard() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const b = new Baker();
  // Robe: a chubby bell.
  const robe = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.0, 0.0),
      new THREE.Vector2(0.86, 0.0),
      new THREE.Vector2(0.92, 0.12),
      new THREE.Vector2(0.86, 0.55),
      new THREE.Vector2(0.76, 1.05),
      new THREE.Vector2(0.64, 1.34),
      new THREE.Vector2(0.0, 1.48),
    ],
    20,
  );
  b.add(robe, PAL.robe);
  // Robe hem trim and a belt.
  b.add(new THREE.TorusGeometry(0.88, 0.06, 6, 24).rotateX(Math.PI / 2).translate(0, 0.08, 0), 0x6b5536);
  b.add(new THREE.TorusGeometry(0.73, 0.06, 6, 24).rotateX(Math.PI / 2).translate(0, 0.82, 0), 0x6b5536);
  // Scarf: a thick knitted cream ring with knit ridges, and two long tails down his back (towards the camera),
  // each ending in a fringe, so it reads from above past the hat brim.
  const SCARF = 0xe8dabb;
  const KNIT = 0xb89c70;
  b.add(new THREE.TorusGeometry(0.44, 0.21, 10, 22).rotateX(Math.PI / 2).scale(1, 0.85, 1).translate(0, 1.44, 0), SCARF);
  // Knit ribs around the ring.
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    b.add(new THREE.TorusGeometry(0.2, 0.025, 4, 10).rotateY(a + Math.PI / 2).translate(Math.sin(a) * 0.44, 1.44, Math.cos(a) * 0.44), KNIT);
  }
  const tail = (x: number, len: number, tilt: number, twist: number) => {
    const at = (geo: THREE.BufferGeometry) => geo.rotateX(-tilt).rotateZ(twist).translate(x, 1.36, 0.55);
    b.add(at(new THREE.BoxGeometry(0.36, len, 0.12).translate(0, -len / 2, 0)), SCARF);
    for (let k = 1; k < 4; k++) b.add(at(new THREE.BoxGeometry(0.37, 0.05, 0.13).translate(0, (-len * k) / 4, 0)), KNIT);
    // Fringe: little tassels hanging off the end.
    for (let f = 0; f < 5; f++) {
      b.add(at(new THREE.CylinderGeometry(0.025, 0.018, 0.2, 4).translate(-0.14 + f * 0.07, -len - 0.09, 0)), SCARF);
    }
  };
  tail(0.18, 1.0, 0.32, 0.12);
  tail(-0.12, 0.72, 0.42, -0.08);
  // Sleeves: the left arm hangs, the right one holds the candle forward.
  b.add(new THREE.CapsuleGeometry(0.2, 0.45, 4, 10).rotateZ(0.35).translate(-0.72, 0.95, 0.05), PAL.robe);
  b.bake(body);

  const head = new THREE.Group();
  head.position.y = 1.62;
  body.add(head);
  const hb = new Baker();
  hb.add(new THREE.SphereGeometry(0.42, 16, 12).translate(0, 0.22, 0), PAL.skin);
  // White beard peeking out at the sides of the face (front is -z).
  hb.add(new THREE.SphereGeometry(0.36, 12, 10).scale(1.25, 1.1, 0.8).translate(0, -0.08, -0.22), 0xf4efe6);
  // Beard tufts and a nose poking out at the sides, so a bit of face shows past the brim.
  for (const sx of [-1, 1]) hb.add(new THREE.SphereGeometry(0.17, 8, 6).translate(sx * 0.4, 0.04, -0.12), 0xf4efe6);
  hb.add(new THREE.SphereGeometry(0.1, 8, 6).translate(0, 0.2, -0.43), 0xe9a982);
  // Hat: a wide floppy brim, a band, a tall cone with a bent tip leaning back.
  // Hat: a soft knitted cone with a rolled brim, its floppy tip bent over to one side.
  hb.add(new THREE.TorusGeometry(0.54, 0.12, 8, 22).rotateX(Math.PI / 2).translate(0, 0.4, 0), 0x355c3e);
  hb.add(new THREE.ConeGeometry(0.6, 1.0, 18, 1, true).translate(0, 0.9, 0), PAL.hat);
  hb.add(new THREE.ConeGeometry(0.27, 0.6, 12).translate(0, 0.28, 0).rotateZ(1.0).rotateX(0.25).translate(0, 1.28, 0.04), PAL.hat);
  hb.add(new THREE.SphereGeometry(0.08, 8, 6).translate(-0.55, 1.5, 0.15), PAL.hat);
  hb.bake(head);

  // Right arm with the candle (the side next to the robot).
  const arm = new THREE.Group();
  arm.position.set(0.66, 1.0, -0.05);
  body.add(arm);
  const ab = new Baker();
  ab.add(new THREE.CapsuleGeometry(0.19, 0.5, 4, 10).rotateZ(-1.1).translate(0.3, 0.1, 0), PAL.robe);
  ab.add(new THREE.SphereGeometry(0.15, 10, 8).translate(0.62, 0.26, 0), PAL.skin);
  // A tall wooden candle stick: the flame burns above the hat brim, out to the side.
  ab.add(new THREE.CylinderGeometry(0.045, 0.05, 1.4, 6).translate(0.66, 0.85, 0), 0x6b4a2e);
  ab.add(new THREE.CylinderGeometry(0.2, 0.15, 0.07, 12).translate(0.66, 1.58, 0), 0xc99a4a);
  ab.add(new THREE.CylinderGeometry(0.1, 0.12, 0.3, 10).translate(0.66, 1.76, 0), PAL.candle);
  ab.bake(arm);
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8).scale(1, 1.8, 1), flat(0xfff2b0));
  flame.position.set(0.66, 2.0, 0);
  arm.add(flame);
  const halo = glow(0xff9d3a, 2.2);
  halo.position.copy(flame.position);
  arm.add(halo);
  const light = new THREE.PointLight(0xffa850, 5, 8, 1.6);
  light.position.set(1.0, 2.6, 0.2);
  arm.add(light);

  let castT = 0;
  let oopsT = 0;
  let look = 0;
  let base = 1;
  return {
    root,
    look(yaw: number, dt: number) {
      look += (Math.max(-0.7, Math.min(0.7, yaw)) - look) * Math.min(1, dt * 6);
    },
    cast() {
      castT = 0.22;
    },
    oops() {
      oopsT = 0.5;
    },
    setDamage(frac: number) {
      base = 0.55 + 0.45 * frac;
    },
    update(dt: number, t: number) {
      castT = Math.max(0, castT - dt);
      oopsT = Math.max(0, oopsT - dt);
      head.rotation.y = look + (oopsT > 0 ? Math.sin(oopsT * 30) * 0.35 : 0);
      head.rotation.z = Math.sin(t * 1.3) * 0.04;
      arm.rotation.z = 0.15 + castT * 2.2;
      const breathe = 1 + Math.sin(t * 2.2) * 0.018;
      body.scale.set(1 / Math.sqrt(breathe), breathe, 1 / Math.sqrt(breathe));
      const flick = base * (1 + Math.sin(t * 17) * 0.06 + Math.sin(t * 7.3) * 0.08) + castT * 2.5;
      flame.scale.set(0.8 + flick * 0.2, flick, 0.8 + flick * 0.2);
      halo.scale.setScalar(1.5 + flick * 0.8);
      light.intensity = 4 * flick;
    },
  };
}

/** The robot cannon: a round cream body with a teal belly on little wheels, a face, and a teal barrel on top. */
function makeRobot() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const b = new Baker();
  b.add(new THREE.SphereGeometry(0.8, 22, 16).scale(1, 0.92, 1).translate(0, 1.0, 0), PAL.cream);
  // Teal belly: the lower part of a slightly larger sphere.
  b.add(new THREE.SphereGeometry(0.83, 22, 8, 0, Math.PI * 2, Math.PI * 0.62, Math.PI * 0.38).scale(1, 0.92, 1).translate(0, 1.0, 0), PAL.teal);
  b.add(new THREE.TorusGeometry(0.8, 0.05, 6, 28).rotateX(Math.PI / 2).translate(0, 0.72, 0), PAL.tealDark);
  // Side dials (like little ears).
  // A little ear on the left, a big teal drum with a brass coil on the right (like a scroll of laser wire).
  b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 14).rotateZ(Math.PI / 2).translate(-0.8, 1.05, 0), PAL.teal);
  b.add(new THREE.CylinderGeometry(0.11, 0.11, 0.18, 10).rotateZ(Math.PI / 2).translate(-0.84, 1.05, 0), 0xe7b04a);
  b.add(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 18).rotateZ(Math.PI / 2).translate(0.86, 0.98, 0.05), PAL.teal);
  for (const r of [0.3, 0.2, 0.1]) b.add(new THREE.TorusGeometry(r, 0.045, 5, 18).rotateY(Math.PI / 2).translate(1.02, 0.98, 0.05), 0xe2a948);
  // Little round feet instead of plain wheels peeking out front and back.
  for (const sx of [-1, 1]) b.add(new THREE.SphereGeometry(0.2, 10, 8).scale(1, 0.8, 1).translate(sx * 0.42, 0.22, 0.55), PAL.cream);
  // Wheels.
  for (const sx of [-1, 1]) {
    for (const sz of [-1]) b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 14).rotateZ(Math.PI / 2).translate(sx * 0.5, 0.2, sz * 0.42), 0x3b3a40);
  }
  // Turret base.
  b.add(new THREE.CylinderGeometry(0.26, 0.34, 0.18, 16).translate(0, 1.76, 0), PAL.teal);
  b.bake(body);
  // Face (towards the camera, +z).
  const face = new THREE.Group();
  face.position.set(0, 1.0 + Math.sin(0.5) * 0.72, Math.cos(0.5) * 0.72);
  face.rotation.x = -0.5;
  body.add(face);
  // Eyes, mouth and blush baked into three unlit meshes (like `cuteEye`, without its six draw calls).
  const fb = new Baker(flat);
  const er = 0.11;
  for (const s of [-1, 1]) {
    const ex = s * 0.24;
    fb.add(new THREE.SphereGeometry(er, 12, 10).scale(0.82, 1.08, 0.5).translate(ex, 0.08, 0.02), 0x1b1630);
    fb.add(new THREE.SphereGeometry(er * 0.34, 8, 6).translate(ex - er * 0.25, 0.08 + er * 0.42, 0.02 + er * 0.38), 0xffffff);
    fb.add(new THREE.SphereGeometry(er * 0.16, 6, 4).translate(ex + er * 0.28, 0.08 - er * 0.3, 0.02 + er * 0.38), 0xffffff);
    fb.add(new THREE.CircleGeometry(0.07, 12).rotateY(s * 0.5).translate(s * 0.4, -0.06, -0.05), 0xff9bb0);
  }
  fb.add(new THREE.RingGeometry(0.05, 0.075, 12, 1, Math.PI * 1.1, Math.PI * 0.8).translate(0, -0.08, 0.06), 0x1b1630);
  fb.bake(face);

  // Turret: yaw pivot, then a pitch pivot holding the barrel (pointing along -z, towards the field).
  const yaw = new THREE.Group();
  yaw.position.set(0, 1.9, 0);
  body.add(yaw);
  const pitch = new THREE.Group();
  yaw.add(pitch);
  const barrel = new THREE.Group();
  pitch.add(barrel);
  const tb = new Baker();
  tb.add(new THREE.SphereGeometry(0.22, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), PAL.teal);
  tb.add(new THREE.CylinderGeometry(0.12, 0.14, 1.0, 14).rotateX(Math.PI / 2).translate(0, 0.08, -0.55), PAL.cream);
  tb.add(new THREE.CylinderGeometry(0.18, 0.18, 0.12, 14).rotateX(Math.PI / 2).translate(0, 0.08, -0.3), PAL.teal);
  tb.add(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 14).rotateX(Math.PI / 2).translate(0, 0.08, -0.82), 0xe2a948);
  tb.add(new THREE.CylinderGeometry(0.2, 0.16, 0.24, 14).rotateX(Math.PI / 2).translate(0, 0.08, -1.06), PAL.teal);
  tb.bake(barrel);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.12, 14), flat(0xc8ff9a));
  lens.position.set(0, 0.08, -1.2);
  lens.rotation.y = Math.PI;
  barrel.add(lens);
  const tip = new THREE.Object3D();
  tip.position.set(0, 0.08, -1.25);
  barrel.add(tip);
  const flash = glow(PAL.laser, 0.9);
  flash.position.copy(tip.position);
  barrel.add(flash);

  const pivotWorld = new THREE.Vector3();
  const target = new THREE.Vector3(0, 1, -20);
  let yawA = 0;
  let pitchA = 0.25;
  let castT = 0;
  let oopsT = 0;
  return {
    root,
    yaw: () => yawA,
    aimAt(p: THREE.Vector3, dt: number) {
      target.lerp(p, Math.min(1, dt * 14));
    },
    muzzle(out: THREE.Vector3) {
      return tip.getWorldPosition(out);
    },
    cast() {
      castT = 0.16;
    },
    oops() {
      oopsT = 0.45;
    },
    update(dt: number, t: number) {
      // Root and body never rotate, so the pivot's world position is the root position plus its local offset.
      pivotWorld.copy(yaw.position).multiplyScalar(root.scale.x).add(root.position);
      const dx = target.x - pivotWorld.x;
      const dz = target.z - pivotWorld.z;
      const dy = target.y - pivotWorld.y;
      const wantYaw = Math.atan2(-dx, -dz);
      const wantPitch = Math.max(0.08, Math.atan2(dy, Math.hypot(dx, dz)) + 0.12);
      yawA += (wantYaw - yawA) * Math.min(1, dt * 12);
      pitchA += (wantPitch - pitchA) * Math.min(1, dt * 12);
      yaw.rotation.y = yawA;
      pitch.rotation.x = pitchA;
      castT = Math.max(0, castT - dt);
      oopsT = Math.max(0, oopsT - dt);
      barrel.position.z = castT * 1.2;
      flash.scale.setScalar(0.5 + castT * 9 + Math.sin(t * 6) * 0.08);
      body.position.y = Math.abs(Math.sin(t * 3.2)) * 0.03 + castT * 0.1;
      body.rotation.z = oopsT > 0 ? Math.sin(oopsT * 28) * 0.12 : 0;
    },
  };
}

// ---- world --------------------------------------------------------------------------------------------------------

export function buildWorld(scene: THREE.Scene): World {
  scene.background = new THREE.Color(0x150f0a);
  scene.fog = new THREE.Fog(0x1c140d, 75, 190);

  // Dusk lamplight: a warm hemisphere, one warm key light from the upper left, the wizard's candle (a point light).
  scene.add(new THREE.HemisphereLight(0xd2d8e4, 0x2a2c44, 0.9));
  const key = new THREE.DirectionalLight(0xffcc8c, 1.6);
  key.position.set(-14, 26, 12);
  key.target.position.set(0, 0, LINE_Z - 12);
  scene.add(key, key.target);
  // A big warm lamp pool over the middle of the hall (the one extra light; the shelves fake theirs).
  const pool = new THREE.PointLight(0xffc47a, 20, 30, 1.4);
  pool.position.set(0, 9, LINE_Z - 9);
  scene.add(pool);

  buildFloor(scene);
  const cracks = buildCracks(scene);
  const library = buildLibrary(scene, { length: FIELD_LENGTH, width: FIELD_HALF * 2, lineZ: LINE_Z });

  const wizard = makeWizard();
  // Faces -z, towards the creatures: we see his back, like the player standing behind him.
  wizard.root.position.set(-1.6, 0, LINE_Z + 2.0);
  wizard.root.name = 'wizard';
  wizard.root.scale.setScalar(DEFENDER_SCALE);
  // Leaning back a touch and turned a little towards the robot, so the camera sees his scarf, beard and candle.
  wizard.root.rotation.set(-0.22, -0.3, 0, 'YXZ');
  scene.add(wizard.root);
  const robot = makeRobot();
  robot.root.position.set(1.5, 0, LINE_Z + 1.9);
  robot.root.name = 'robot';
  robot.root.scale.setScalar(DEFENDER_SCALE);
  scene.add(robot.root);

  return {
    aimAt: robot.aimAt,
    muzzle: robot.muzzle,
    cast() {
      robot.cast();
      wizard.cast();
    },
    oops() {
      robot.oops();
      wizard.oops();
    },
    setDamage(frac) {
      cracks(frac);
      wizard.setDamage(frac);
    },
    update(dt, t) {
      robot.update(dt, t);
      wizard.look(robot.yaw(), dt);
      wizard.update(dt, t);
      library.update(dt, t);
    },
  };
}
