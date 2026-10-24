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
import { detectQuality } from './engine';
import { flat, flatVertexColorMaterial, hullGeometry, inkMaterial, toon, vertexColorMaterial } from './toon';

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

const bakeColor = new THREE.Color();
/**
 * Collects coloured geometry and bakes it into ONE vertex-coloured mesh (one draw call for a whole rigid part of a
 * character). `lit` = the soft toon surface with the warm rim (same look as `toon(color)`), else unlit like `flat()`.
 */
class Baker {
  constructor(private readonly lit = true) {}
  private parts: THREE.BufferGeometry[] = [];
  /** `shade(x, y, z)` (optional) scales the colour per vertex: knit ribs, stripes, soft gradients at no extra cost. */
  add(geo: THREE.BufferGeometry, color: number, shade?: (x: number, y: number, z: number) => number) {
    // Linear working-space colour, as a material's `color` would hold it.
    bakeColor.setHex(color);
    const pos = geo.attributes.position;
    const n = pos.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const m = shade ? shade(pos.getX(i), pos.getY(i), pos.getZ(i)) : 1;
      arr[i * 3] = bakeColor.r * m;
      arr[i * 3 + 1] = bakeColor.g * m;
      arr[i * 3 + 2] = bakeColor.b * m;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    this.parts.push(geo);
    return geo;
  }
  bake(parent: THREE.Object3D) {
    if (!this.parts.length) return;
    const geo = this.parts.length === 1 ? this.parts[0] : mergeGeometries(this.parts)!;
    if (geo !== this.parts[0]) for (const p of this.parts) p.dispose();
    parent.add(new THREE.Mesh(geo, this.lit ? vertexColorMaterial(true) : flatVertexColorMaterial()));
    this.parts = [];
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
/** Flagstone size: big square slabs, about a defender wide (some split in halves, some 1.5 long). */
const TILE = 2.1;

/** Floor texture resolution, texels per world unit: 40 on 'high' (1200×2320), 24 on 'low' (720×1392, 36% the memory). */
const FLOOR_PX = { high: 40, low: 24 } as const;

/** Where the defenders stand (world x, z): places them, and bakes their soft contact shadows into the floor. */
const WIZARD_AT = [-1.6, LINE_Z + 2.0] as const;
const ROBOT_AT = [1.5, LINE_Z + 1.9] as const;
/** The big carved rune circle in the middle of the field, and the fainter one around the defenders. */
const RUNE_Z = LINE_Z - 5.8;
const RUNE_R = 4.4;
const LOW_RUNE_Z = LINE_Z + 3.2;
const LOW_RUNE_R = 6.6;

/**
 * Paints the whole floor once into one canvas: big square slate flagstones (cool grey-green to blue-grey, each a
 * crazy-paving of slightly different patches), thin pale mortar joints with dark edges and moss tufts, carved rune
 * inlays (a big circle with an inner ring, diamond nodes and a star in the middle, long lines down the field, a
 * fainter ring around the defenders), warm lamplight pooling in from the shelves, contact shadows under the
 * defenders. The same canvas doubles as the bump map. Everything is drawn in 40-texels-per-unit coordinates and
 * scaled to `texels`, so both tiers paint the same floor. `candleGlow` bakes the wizard's candle light into the
 * stones (for the tier that has no real candle light).
 */
function floorTexture(texels: number, candleGlow: boolean): THREE.CanvasTexture {
  const PX = 40;
  const W = FLOOR_HALF * 2 * PX;
  const H = (FLOOR_NEAR - FLOOR_FAR) * PX;
  const k = texels / PX;
  const c = document.createElement('canvas');
  c.width = Math.round(W * k);
  c.height = Math.round(H * k);
  const g = c.getContext('2d')!;
  g.scale(k, k);
  const rnd = rng(1234);
  const X = (x: number) => (x + FLOOR_HALF) * PX;
  const Z = (z: number) => (z - FLOOR_FAR) * PX;
  const T = TILE * PX;

  // ---- flagstones
  const joints: [number, number, number, number][] = [];
  const stone = (x: number, y: number, w: number, h: number) => {
    joints.push([x, y, w, h]);
    // Slate: mostly cool blue-grey, some grey-green; the lamps bring the warmth.
    // A narrow cool range: grey-green (150) to blue-grey (205), never warm (the lamps add that).
    const hue = 150 + rnd() * 55;
    const sat = 6 + rnd() * 4;
    const lit = 48 + rnd() * 6;
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.fillStyle = `hsl(${hue} ${sat}% ${lit}%)`;
    g.fillRect(x, y, w, h);
    // Crazy paving: overlapping irregular patches, each a shade off, with a faint dark seam.
    const n = Math.round(((w * h) / (T * T)) * (8 + rnd() * 5));
    g.lineWidth = 1.1;
    for (let i = 0; i < n; i++) {
      const cx = x + rnd() * w;
      const cy = y + rnd() * h;
      const r = T * (0.16 + rnd() * 0.22);
      const sides = 5 + ((rnd() * 3) | 0);
      const rot = rnd() * Math.PI;
      g.beginPath();
      for (let s = 0; s < sides; s++) {
        const a = rot + (s / sides) * Math.PI * 2;
        const rr = r * (0.7 + rnd() * 0.45);
        const px = cx + Math.cos(a) * rr;
        const py = cy + Math.sin(a) * rr * (0.8 + rnd() * 0.4);
        if (s === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
      g.fillStyle = `hsl(${hue + (rnd() - 0.5) * 8} ${sat}% ${lit + (rnd() - 0.5) * 6}%)`;
      g.fill();
      g.strokeStyle = `rgba(22,26,26,${0.08 + rnd() * 0.1})`;
      g.stroke();
    }
    // Weathering: soft dark and light clouds, the odd lichen stain.
    for (let i = 0; i < 4; i++) {
      const bx = x + rnd() * w;
      const by = y + rnd() * h;
      const br = 12 + rnd() * 36;
      const grad = g.createRadialGradient(bx, by, 0, bx, by, br);
      const kind = rnd();
      grad.addColorStop(0, kind < 0.4 ? 'rgba(26,30,30,0.16)' : kind < 0.8 ? 'rgba(232,230,218,0.1)' : 'rgba(100,118,70,0.12)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x, y, w, h);
    }
    // Worn edges: a little darker towards the joints.
    g.strokeStyle = 'rgba(18,20,18,0.16)';
    g.lineWidth = 6;
    g.strokeRect(x, y, w, h);
    // A hairline crack now and then.
    if (rnd() < 0.15) {
      g.strokeStyle = 'rgba(15,18,16,0.4)';
      g.lineWidth = 1.1;
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
  // Rows aligned so a joint runs along the defence line and a stone is centred on the middle of the field; now and
  // then a row is shifted half a stone, or has a half or a long stone in it.
  const x0 = X(0) - T / 2 - Math.ceil(X(0) / T) * T;
  const y0 = Z(LINE_Z) - Math.ceil(Z(LINE_Z) / T) * T;
  for (let ty = y0; ty < H; ty += T) {
    let tx = x0 - (rnd() < 0.2 ? T / 2 : 0);
    while (tx < W) {
      const r = rnd();
      const w = r < 0.1 ? T / 2 : r < 0.2 ? T * 1.5 : T;
      if (rnd() < 0.1) {
        stone(tx, ty, w, T / 2);
        stone(tx, ty + T / 2, w, T / 2);
      } else stone(tx, ty, w, T);
      tx += w;
    }
  }
  // Mortar: a thin pale joint with dark edges.
  g.strokeStyle = 'rgba(30,30,26,0.75)';
  g.lineWidth = 3.4;
  for (const [x, y, w, h] of joints) g.strokeRect(x, y, w, h);
  g.strokeStyle = 'rgba(150,140,118,0.3)';
  g.lineWidth = 1;
  for (const [x, y, w, h] of joints) g.strokeRect(x, y, w, h);

  // ---- carved rune inlays: a pale band with dark edges
  const carve = (draw: () => void, strength = 1, width = 7) => {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = `rgba(26,24,20,${Math.min(1, 0.5 * strength)})`;
    g.lineWidth = width;
    draw();
    g.strokeStyle = `rgba(200,182,146,${Math.min(1, 0.42 * strength)})`;
    g.lineWidth = width * 0.55;
    draw();
  };
  const circle = (x: number, z: number, r: number) => () => {
    g.beginPath();
    g.arc(X(x), Z(z), r * PX, 0, Math.PI * 2);
    g.stroke();
  };
  const line = (ax: number, az: number, bx: number, bz: number) => () => {
    g.beginPath();
    g.moveTo(X(ax), Z(az));
    g.lineTo(X(bx), Z(bz));
    g.stroke();
  };
  /** A four-pointed star with concave sides (`pinch` 0 = a diamond), turned by `rot`. */
  const star4 = (x: number, z: number, r: number, pinch: number, rot = 0) => () => {
    const pt = (a: number, rr: number) => [X(x) + Math.sin(a) * rr * PX, Z(z) - Math.cos(a) * rr * PX];
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = rot + (i * Math.PI) / 2;
      const [px, py] = pt(a, r);
      const [qx, qy] = pt(a + Math.PI / 4, r * (0.7 - pinch) * Math.SQRT1_2);
      const [nx, ny] = pt(a + Math.PI / 2, r);
      if (i === 0) g.moveTo(px, py);
      g.quadraticCurveTo(qx, qy, nx, ny);
    }
    g.closePath();
    g.stroke();
  };
  // The big circle: outer ring, inner ring, a star in the middle, small circles on the diagonals, and a diamond node
  // on each axis with a small diamond inside, from which long lines run out across the field.
  carve(circle(0, RUNE_Z, RUNE_R), 1.25, 9);
  carve(circle(0, RUNE_Z, RUNE_R - 0.3), 0.8, 5);
  carve(circle(0, RUNE_Z, RUNE_R * 0.5), 1.1, 8);
  carve(star4(0, RUNE_Z, RUNE_R * 0.46, 0.3), 1);
  carve(star4(0, RUNE_Z, RUNE_R * 0.86, 0.38, Math.PI / 4), 0.7, 6);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    carve(circle(Math.sin(a) * RUNE_R * 0.74, RUNE_Z - Math.cos(a) * RUNE_R * 0.74, 0.32), 0.8, 6);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const nx = Math.sin(a) * RUNE_R;
    const nz = RUNE_Z - Math.cos(a) * RUNE_R;
    carve(star4(nx, nz, 0.95, 0.25), 1.2, 8);
    carve(star4(nx, nz, 0.26, 0), 1, 5);
  }
  // Lines out of the nodes: up the field, down to the defenders' ring, and across to the side lines.
  carve(line(0, RUNE_Z - RUNE_R - 0.95, 0, FLOOR_FAR + 6), 0.6);
  carve(line(0, RUNE_Z + RUNE_R + 0.95, 0, LOW_RUNE_Z - LOW_RUNE_R), 0.6);
  for (const s of [-1, 1]) {
    carve(line(s * (RUNE_R + 0.95), RUNE_Z, s * (FIELD_HALF - 1.6), RUNE_Z), 0.75);
    // Long lines down the length of the field.
    carve(line(s * (FIELD_HALF - 1.6), FLOOR_FAR + 4, s * (FIELD_HALF - 1.6), LINE_Z + 6), 0.45);
  }
  // A second circle far up the hall, and a fainter one around the defenders.
  const farZ = RUNE_Z - 17;
  carve(circle(0, farZ, RUNE_R * 0.9), 0.7, 7);
  carve(circle(0, farZ, RUNE_R * 0.45), 0.6);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    carve(star4(Math.sin(a) * RUNE_R * 0.9, farZ - Math.cos(a) * RUNE_R * 0.9, 0.8, 0.25), 0.65);
  }
  carve(circle(0, LOW_RUNE_Z, LOW_RUNE_R), 0.5, 7);
  carve(circle(0, LOW_RUNE_Z, LOW_RUNE_R - 0.35), 0.35, 5);

  // The defence line: a row of faintly glowing golden glyphs across the field.
  g.strokeStyle = 'rgba(240,196,110,0.26)';
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

  // ---- moss: tufts in the joints (mostly where they cross), thicker towards the walls
  const tuft = (x: number, y: number, size: number) => {
    const n = 3 + ((rnd() * 5) | 0);
    for (let i = 0; i < n; i++) {
      g.fillStyle = `hsla(${70 + rnd() * 28} ${32 + rnd() * 24}% ${24 + rnd() * 20}% / ${0.55 + rnd() * 0.4})`;
      g.beginPath();
      g.ellipse(x + (rnd() - 0.5) * size * 2.2, y + (rnd() - 0.5) * size * 2.2, 1.2 + rnd() * size * 0.6, 1 + rnd() * size * 0.45, rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  };
  for (const [x, y, w, h] of joints) {
    const edge = Math.min(1, Math.abs((x + w / 2) / PX - FLOOR_HALF) / FIELD_HALF);
    if (rnd() < 0.55 + edge * 0.45) tuft(x, y, 3 + rnd() * (3 + edge * 5));
    // A few along the edges.
    if (rnd() < 0.25 + edge * 0.5) tuft(x + rnd() * w, y, 2 + rnd() * 3);
    if (rnd() < 0.25 + edge * 0.5) tuft(x, y + rnd() * h, 2 + rnd() * 3);
  }
  // Thick moss creeping out from under the shelves.
  for (let i = 0; i < 1600; i++) {
    const s = rnd() < 0.5 ? -1 : 1;
    const x = s * (FIELD_HALF - 1.5 + Math.pow(rnd(), 0.7) * 8);
    const z = FLOOR_FAR + rnd() * (FLOOR_NEAR - FLOOR_FAR);
    tuft(X(x), Z(z), 2 + rnd() * 4);
  }

  // Grain: per-pixel noise so the stone does not look like flat vector shapes.
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 12;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  // ---- baked light
  // Contact shadows under the defenders, nudged away from the key light.
  for (const [x, z, r] of [
    [WIZARD_AT[0] + 0.2, WIZARD_AT[1] - 0.05, 1.25],
    [ROBOT_AT[0] + 0.2, ROBOT_AT[1] - 0.05, 1.15],
  ] as const) {
    const sh = g.createRadialGradient(X(x), Z(z), 0, X(x), Z(z), r * PX);
    sh.addColorStop(0, 'rgba(14,10,8,0.55)');
    sh.addColorStop(0.55, 'rgba(14,10,8,0.3)');
    sh.addColorStop(1, 'rgba(14,10,8,0)');
    g.fillStyle = sh;
    g.fillRect(X(x) - r * PX, Z(z) - r * PX, r * 2 * PX, r * 2 * PX);
  }
  // Warm lamplight pooling in from the lanterns on the shelves; the middle of the hall stays cooler.
  g.globalCompositeOperation = 'lighter';
  for (let z = LINE_Z + 6; z > FLOOR_FAR; z -= 5.5) {
    for (const s of [-1, 1]) {
      const x = s * (FIELD_HALF - 0.4);
      const zz = z + s * 1.6;
      const r = (4.2 + rnd() * 1.6) * PX;
      const pool = g.createRadialGradient(X(x), Z(zz), 0, X(x), Z(zz), r);
      pool.addColorStop(0, 'rgba(110,62,20,0.4)');
      pool.addColorStop(0.5, 'rgba(80,44,14,0.16)');
      pool.addColorStop(1, 'rgba(60,30,6,0)');
      g.fillStyle = pool;
      g.fillRect(X(x) - r, Z(zz) - r, r * 2, r * 2);
    }
  }
  g.globalCompositeOperation = 'source-over';
  for (const [cz, r, a] of [
    [LINE_Z - 8, FIELD_HALF * 1.6, 0.16],
    [LINE_Z - 24, FIELD_HALF * 1.3, 0.1],
  ] as const) {
    const pool = g.createRadialGradient(X(0), Z(cz), 0, X(0), Z(cz), r * PX);
    pool.addColorStop(0, `rgba(255,206,140,${a})`);
    pool.addColorStop(1, 'rgba(255,190,120,0)');
    g.fillStyle = pool;
    g.fillRect(0, 0, W, H);
  }
  // The wizard's candle, baked: a small warm pool by the defenders (the 'low' tier has no candle point light).
  if (candleGlow) {
    const cx = X(CANDLE_X);
    const cz = Z(CANDLE_Z);
    const candle = g.createRadialGradient(cx, cz, 0, cx, cz, 4.5 * PX);
    candle.addColorStop(0, 'rgba(255,170,80,0.34)');
    candle.addColorStop(0.4, 'rgba(255,160,72,0.14)');
    candle.addColorStop(1, 'rgba(255,150,60,0)');
    g.fillStyle = candle;
    g.fillRect(cx - 4.5 * PX, cz - 4.5 * PX, 9 * PX, 9 * PX);
  }
  // Dusk blue settles into the corners, away from the lamps.
  const dusk = g.createRadialGradient(X(0), Z(LINE_Z - 12), FIELD_HALF * 1.2 * PX, X(0), Z(LINE_Z - 12), FIELD_HALF * 2.6 * PX);
  dusk.addColorStop(0, 'rgba(40,48,90,0)');
  dusk.addColorStop(1, 'rgba(40,48,90,0.22)');
  g.fillStyle = dusk;
  g.fillRect(0, 0, W, H);

  // Darken under the shelves and towards the far end (a baked vignette).
  for (const s of [-1, 1]) {
    const xa = X(s * (FIELD_HALF - 1));
    const xb = X(s * FLOOR_HALF);
    const grad = g.createLinearGradient(xa, 0, xb, 0);
    grad.addColorStop(0, 'rgba(18,10,4,0)');
    grad.addColorStop(1, 'rgba(18,10,4,0.6)');
    g.fillStyle = grad;
    g.fillRect(Math.min(xa, xb), 0, Math.abs(xb - xa), H);
  }
  const far = g.createLinearGradient(0, 0, 0, Z(LINE_Z - FIELD_LENGTH + 10));
  far.addColorStop(0, 'rgba(12,8,4,0.5)');
  far.addColorStop(1, 'rgba(12,8,4,0)');
  g.fillStyle = far;
  g.fillRect(0, 0, W, Z(LINE_Z - FIELD_LENGTH + 10));

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Where the wizard's candle flame stands (world xz), for the baked candle pool. */
const CANDLE_X = -0.2;
const CANDLE_Z = LINE_Z + 2.4;

/**
 * The floor: one quad, Lambert-lit with the stone canvas as colour and bump map. On 'high' it is lit live (the candle
 * flickers on it). On 'low' (phones, where the floor is three quarters of the screen) its lighting is baked: `lights`
 * are static and the floor is flat, so on its first frame the lit floor (bump included) is rendered once from straight
 * above into a half-float texture, and from then on the floor draws unlit with that texture: the same pixels after
 * tone mapping and fog, for a fraction of the per-pixel work. Without half-float render targets it stays lit live.
 */
function buildFloor(scene: THREE.Scene, quality: 'high' | 'low', lights: THREE.Light[]) {
  const high = quality === 'high';
  const tex = floorTexture(FLOOR_PX[quality], !high);
  if (!high) tex.anisotropy = 4;
  const geo = new THREE.PlaneGeometry(FLOOR_HALF * 2, FLOOR_NEAR - FLOOR_FAR);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, (FLOOR_NEAR + FLOOR_FAR) / 2);
  const mat = new THREE.MeshLambertMaterial({ map: tex, bumpMap: tex, bumpScale: 0.45 });
  const floor = new THREE.Mesh(geo, mat);
  floor.name = 'floor';
  // Drawn after the other opaque things (default order 0): the walls, props, creatures and defenders standing on it
  // fill the depth buffer first, so the floor shades only the pixels that stay visible (measured 4-10% of the frame).
  floor.renderOrder = 1;
  scene.add(floor);
  if (!high) bakeFloorOnFirstFrame(floor, lights, tex.image.width, tex.image.height);
}

function bakeFloorOnFirstFrame(floor: THREE.Mesh, lights: THREE.Light[], w: number, h: number) {
  let baked: THREE.MeshBasicMaterial | null = null;
  floor.onBeforeRender = (renderer) => {
    floor.onBeforeRender = () => {};
    const ext = renderer.extensions;
    if (!ext.has('EXT_color_buffer_half_float') && !ext.has('EXT_color_buffer_float')) return;
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, depthBuffer: false });
    rt.texture.anisotropy = 4;
    const bake = new THREE.Scene();
    const copy = new THREE.Mesh(floor.geometry, floor.material);
    bake.add(copy);
    for (const l of lights) {
      const c = l.clone();
      bake.add(c);
      if (c instanceof THREE.DirectionalLight) bake.add(c.target);
    }
    // Straight down, screen up = far (-z): the render lands exactly on the plane's UVs.
    const halfZ = (FLOOR_NEAR - FLOOR_FAR) / 2;
    const cam = new THREE.OrthographicCamera(-FLOOR_HALF, FLOOR_HALF, halfZ, -halfZ, 1, 60);
    cam.position.set(0, 30, (FLOOR_NEAR + FLOOR_FAR) / 2);
    cam.up.set(0, 0, -1);
    cam.lookAt(0, 0, cam.position.z);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(bake, cam); // no tone mapping or fog into a render target: linear lit colour
    renderer.setRenderTarget(prev);
    baked = new THREE.MeshBasicMaterial({ map: rt.texture });
    baked.addEventListener('dispose', () => rt.dispose());
  };
  // Swap after this frame's draw (it already uses the lit material), then free the canvas texture.
  floor.onAfterRender = () => {
    if (!baked) return;
    const old = floor.material as THREE.MeshLambertMaterial;
    floor.material = baked;
    baked = null;
    old.map?.dispose();
    old.dispose();
    floor.onAfterRender = () => {};
  };
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

/** A lathe from a few profile points, smoothed and resampled into `rows` rows (so per-vertex knit rows show). */
function softLathe(profile: [number, number][], rows: number, segments: number) {
  const curve = new THREE.SplineCurve(profile.map(([r, y]) => new THREE.Vector2(r, y)));
  return new THREE.LatheGeometry(curve.getPoints(rows), segments);
}

/** Knit texture as a vertex shade: horizontal rows (`rowsPerUnit`) and vertical ribs (`ribs` around). */
const knit = (rowsPerUnit: number, ribs: number, depth = 0.1) => (x: number, y: number, z: number) =>
  1 - depth + depth * 0.5 * (Math.cos(y * rowsPerUnit * Math.PI * 2) + Math.cos(Math.atan2(x, z) * ribs));

/** Bends a cone-like geometry's tip over: sideways by `side` and down by `droop` at the top (height `h`). */
function bendTip(geo: THREE.BufferGeometry, h: number, side: number, droop: number, forward = 0) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = Math.max(0, p.getY(i) / h);
    p.setXYZ(i, p.getX(i) + side * Math.pow(t, 2.2), p.getY(i) - droop * Math.pow(t, 3), p.getZ(i) + forward * Math.pow(t, 2.2));
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * The little wizard, seen from behind: a big dark green knitted hat with a wide floppy brim and its tip bent over,
 * a thick cream knitted scarf whose striped, fringed tails hang down his back, a plump green robe, and a candle on a
 * stick raised at his side.
 */
function makeWizard(candleLight: boolean) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const ROBE = 0x3d5a44;
  const HAT = 0x26463f;
  const BRIM = 0x2e544b;
  const SCARF = 0xefe5cc;
  const SAGE = 0x7d9670;
  const b = new Baker();
  // Robe: a plump knitted bell, darker at the hem.
  const robeKnit = knit(9, 22, 0.2);
  b.add(
    softLathe([[0, 0], [0.8, 0.02], [0.9, 0.2], [0.87, 0.58], [0.76, 1.0], [0.58, 1.32], [0.3, 1.47], [0, 1.5]], 20, 32),
    ROBE,
    (x, y, z) => robeKnit(x, y, z) * (y < 0.14 ? 0.72 : 1),
  );
  // Scarf: a thick knitted cream ring with ribs, and two tails down his back (towards the camera), each with sage
  // stripes near the end and a fringe.
  b.add(new THREE.TorusGeometry(0.5, 0.25, 10, 28).rotateX(Math.PI / 2).scale(1, 0.8, 1).translate(0, 1.42, 0.04), SCARF, (x, _y, z) =>
    0.9 + 0.1 * Math.cos(Math.atan2(x, z) * 14),
  );
  const tail = (x: number, len: number, tilt: number, twist: number) => {
    const at = (geo: THREE.BufferGeometry) => geo.rotateX(-tilt).rotateZ(twist).translate(x, 1.38, 0.6);
    b.add(at(new THREE.BoxGeometry(0.4, len, 0.12, 1, 6, 1).translate(0, -len / 2, 0)), SCARF);
    for (const f of [0.62, 0.72, 0.84]) b.add(at(new THREE.BoxGeometry(0.41, 0.05, 0.13).translate(0, -len * f, 0)), SAGE);
    // Fringe: little tassels hanging off the end.
    for (let f = 0; f < 6; f++) {
      b.add(at(new THREE.CylinderGeometry(0.026, 0.016, 0.22, 4).translate(-0.16 + f * 0.064, -len - 0.1, 0)), SCARF);
    }
  };
  tail(0.17, 1.05, 0.6, 0.1);
  tail(-0.15, 0.8, 0.7, -0.06);
  // Left sleeve hanging, with a little satchel at the hip.
  b.add(new THREE.CapsuleGeometry(0.22, 0.45, 4, 10).rotateZ(0.3).translate(-0.74, 0.92, 0.05), ROBE, robeKnit);
  b.add(new THREE.BoxGeometry(0.34, 0.4, 0.16).rotateY(0.3).translate(-0.86, 0.55, -0.12), 0x6a4528);
  b.bake(body);

  const head = new THREE.Group();
  head.position.y = 1.62;
  body.add(head);
  const hb = new Baker();
  hb.add(new THREE.SphereGeometry(0.42, 16, 12).translate(0, 0.22, 0), PAL.skin);
  // White beard tufts peeking out at the sides of the face (front is -z).
  hb.add(new THREE.SphereGeometry(0.36, 12, 10).scale(1.25, 1.1, 0.8).translate(0, -0.08, -0.22), 0xf4efe6);
  for (const sx of [-1, 1]) hb.add(new THREE.SphereGeometry(0.16, 8, 6).translate(sx * 0.42, 0.04, -0.14), 0xf4efe6);
  // Hat: a wide floppy brim (wavy, drooping at the back and sides) and a tall knitted cone whose tip flops over to
  // his left and a little back.
  const brim = softLathe([[0.4, 0.06], [0.62, 0.04], [0.78, -0.04], [0.84, -0.1], [0.79, -0.15], [0.6, -0.07], [0.42, -0.02]], 10, 30);
  {
    const p = brim.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const a = Math.atan2(p.getX(i), p.getZ(i));
      const r = Math.hypot(p.getX(i), p.getZ(i));
      p.setY(i, p.getY(i) - Math.max(0, r - 0.55) * (0.1 + 0.1 * Math.sin(a * 3 + 1)));
    }
    brim.computeVertexNormals();
  }
  hb.add(brim.translate(0, 0.42, 0), BRIM, knit(14, 40, 0.22));
  const cone = softLathe([[0.6, 0], [0.5, 0.35], [0.34, 0.75], [0.17, 1.1], [0.05, 1.38], [0, 1.45]], 18, 24);
  hb.add(cone, HAT, knit(11, 26, 0.26));
  bendTip(cone, 1.45, -0.62, 0.5, 0.12);
  cone.translate(0, 0.42, 0);
  hb.bake(head);

  // Right arm with the candle (the side next to the robot).
  const arm = new THREE.Group();
  arm.position.set(0.66, 1.0, -0.05);
  body.add(arm);
  const ab = new Baker();
  ab.add(new THREE.CapsuleGeometry(0.2, 0.5, 4, 10).rotateZ(-1.1).translate(0.3, 0.1, 0), ROBE, robeKnit);
  ab.add(new THREE.SphereGeometry(0.15, 10, 8).translate(0.62, 0.26, 0), PAL.skin);
  // A tall wooden candle stick: the flame burns above the hat brim, out to the side.
  ab.add(new THREE.CylinderGeometry(0.045, 0.055, 1.4, 6).translate(0.66, 0.85, 0), 0x5a3a22);
  ab.add(new THREE.CylinderGeometry(0.2, 0.14, 0.07, 12).translate(0.66, 1.58, 0), 0xc99a4a);
  ab.add(new THREE.CylinderGeometry(0.09, 0.11, 0.28, 10).translate(0.66, 1.75, 0), PAL.candle);
  ab.bake(arm);
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8).scale(1, 1.8, 1), flat(0xfff2b0));
  flame.position.set(0.66, 1.98, 0);
  arm.add(flame);
  const halo = glow(0xff9d3a, 2.2);
  halo.position.copy(flame.position);
  arm.add(halo);
  // The candle's own light on 'high'; 'low' bakes it into the floor (one point light less in every lit shader).
  const light = candleLight ? new THREE.PointLight(0xffa850, 5, 8, 1.6) : null;
  if (light) {
    light.position.set(1.0, 2.6, 0.2);
    arm.add(light);
  }

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
      if (light) light.intensity = 4 * flick;
    },
  };
}

/**
 * The robot cannon: a round cream body with a teal lower half and a gold trim, a cute face up front, little ear
 * knobs, a teal drum with a brass coil on its right side, cream feet and wheels, and a teal barrel with brass rings.
 */
function makeRobot() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const CREAM = 0xf6f1e6;
  const TEAL = 0x1f7f8a;
  const TEAL_DARK = 0x175560;
  const BRASS = 0xd6a74c;
  const BRASS_DARK = 0x8a6230;
  const b = new Baker();
  // Body, softly shaded darker towards the bottom.
  b.add(new THREE.SphereGeometry(0.8, 24, 18).scale(1, 0.94, 1).translate(0, 1.0, 0), CREAM, (_x, y) => 0.86 + 0.14 * Math.min(1, Math.max(0, (y - 0.5) / 0.9)));
  // Teal lower half: the bottom of a slightly larger sphere, with a gold trim along its edge.
  b.add(new THREE.SphereGeometry(0.83, 24, 9, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.58).scale(1, 0.94, 1).translate(0, 1.0, 0), TEAL);
  b.add(new THREE.TorusGeometry(0.805, 0.035, 6, 32).rotateX(Math.PI / 2).translate(0, 1.185, 0), BRASS);
  // Ear knobs on top.
  for (const sx of [-1, 1]) {
    b.add(new THREE.SphereGeometry(0.15, 10, 8).translate(sx * 0.5, 1.6, -0.12), CREAM);
    b.add(new THREE.CylinderGeometry(0.06, 0.08, 0.1, 8).translate(sx * 0.47, 1.52, -0.11), TEAL_DARK);
  }
  // A little dial on the left; a big teal drum with a brass coil on the right (like a scroll of laser wire).
  b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 14).rotateZ(Math.PI / 2).translate(-0.8, 1.0, 0), TEAL);
  b.add(new THREE.CylinderGeometry(0.11, 0.11, 0.18, 10).rotateZ(Math.PI / 2).translate(-0.84, 1.0, 0), BRASS);
  b.add(new THREE.CylinderGeometry(0.46, 0.46, 0.32, 20).rotateZ(Math.PI / 2).translate(0.84, 0.98, 0.05), TEAL);
  b.add(new THREE.CylinderGeometry(0.38, 0.38, 0.04, 20).rotateZ(Math.PI / 2).translate(1.01, 0.98, 0.05), BRASS);
  for (const r of [0.3, 0.2, 0.1]) b.add(new THREE.TorusGeometry(r, 0.035, 5, 18).rotateY(Math.PI / 2).translate(1.03, 0.98, 0.05), BRASS_DARK);
  b.add(new THREE.TorusGeometry(0.46, 0.035, 5, 24).rotateY(Math.PI / 2).translate(1.0, 0.98, 0.05), BRASS);
  // Round cream feet with dark soles peeking out in front, small dark wheels behind.
  for (const sx of [-1, 1]) {
    b.add(new THREE.SphereGeometry(0.21, 12, 8).scale(1, 0.8, 1.05).translate(sx * 0.42, 0.22, 0.56), CREAM);
    b.add(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 12).translate(sx * 0.42, 0.04, 0.56), 0x3b3a40);
    b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 14).rotateZ(Math.PI / 2).translate(sx * 0.5, 0.2, -0.42), 0x3b3a40);
  }
  // Turret base.
  b.add(new THREE.CylinderGeometry(0.28, 0.36, 0.2, 16).translate(0, 1.74, 0), TEAL);
  b.add(new THREE.TorusGeometry(0.3, 0.035, 5, 18).rotateX(Math.PI / 2).translate(0, 1.82, 0), BRASS);
  b.bake(body);
  // Face (towards the camera, +z), high on the front so it reads from above.
  const FACE_A = 0.55;
  const face = new THREE.Group();
  face.position.set(0, 1.0 + Math.sin(FACE_A) * 0.72, Math.cos(FACE_A) * 0.73);
  face.rotation.x = -FACE_A;
  body.add(face);
  // Eyes, mouth and blush baked into one unlit mesh (like `cuteEye`, without its six draw calls).
  const fb = new Baker(false);
  const er = 0.1;
  for (const s of [-1, 1]) {
    const ex = s * 0.22;
    fb.add(new THREE.SphereGeometry(er, 12, 10).scale(0.82, 1.08, 0.5).translate(ex, 0.06, 0.02), 0x1b1630);
    fb.add(new THREE.SphereGeometry(er * 0.34, 8, 6).translate(ex - er * 0.25, 0.06 + er * 0.42, 0.02 + er * 0.38), 0xffffff);
    fb.add(new THREE.SphereGeometry(er * 0.16, 6, 4).translate(ex + er * 0.28, 0.06 - er * 0.3, 0.02 + er * 0.38), 0xffffff);
    fb.add(new THREE.CircleGeometry(0.075, 12).rotateY(s * 0.45).translate(s * 0.38, -0.08, -0.04), 0xffa0b0);
  }
  fb.add(new THREE.RingGeometry(0.05, 0.08, 12, 1, Math.PI * 1.1, Math.PI * 0.8).translate(0, -0.08, 0.06), 0x1b1630);
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
  const along = (geo: THREE.BufferGeometry, z: number) => geo.rotateX(Math.PI / 2).translate(0, 0.08, z);
  tb.add(new THREE.SphereGeometry(0.24, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), TEAL);
  tb.add(along(new THREE.CylinderGeometry(0.14, 0.16, 1.0, 14), -0.55), TEAL);
  tb.add(along(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 14), -0.26), CREAM);
  tb.add(along(new THREE.CylinderGeometry(0.205, 0.205, 0.04, 14), -0.18), BRASS);
  tb.add(along(new THREE.CylinderGeometry(0.205, 0.205, 0.04, 14), -0.34), BRASS);
  tb.add(along(new THREE.CylinderGeometry(0.17, 0.17, 0.08, 14), -0.7), TEAL_DARK);
  tb.add(along(new THREE.CylinderGeometry(0.18, 0.18, 0.1, 14), -0.86), BRASS);
  tb.add(along(new THREE.CylinderGeometry(0.21, 0.17, 0.24, 14), -1.06), TEAL);
  tb.bake(barrel);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.13, 14), flat(0xc8ff9a));
  lens.position.set(0, 0.08, -1.19);
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

  // Dusk lamplight: a warm hemisphere, one warm key light from the upper left, the hall's lamp pool, and on 'high' the
  // wizard's candle (a point light; baked into the floor on 'low'). Four lights at most: each one is a loop iteration
  // in every lit fragment.
  const hemi = new THREE.HemisphereLight(0xd2d8e4, 0x2a2c44, 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffcc8c, 1.6);
  key.position.set(-14, 26, 12);
  key.target.position.set(0, 0, LINE_Z - 12);
  scene.add(key, key.target);
  // A big warm lamp pool over the middle of the hall (the one extra light; the shelves fake theirs).
  const pool = new THREE.PointLight(0xffc47a, 20, 30, 1.4);
  pool.position.set(0, 9, LINE_Z - 9);
  scene.add(pool);

  const quality = detectQuality();
  buildFloor(scene, quality, [hemi, key, pool]);
  const cracks = buildCracks(scene);
  const library = buildLibrary(scene, { length: FIELD_LENGTH, width: FIELD_HALF * 2, lineZ: LINE_Z });

  const wizard = makeWizard(quality === 'high');
  // Faces -z, towards the creatures: we see his back, like the player standing behind him.
  wizard.root.position.set(WIZARD_AT[0], 0, WIZARD_AT[1]);
  wizard.root.name = 'wizard';
  wizard.root.scale.setScalar(DEFENDER_SCALE);
  // Leaning back a touch and turned a little towards the robot, so the camera sees his scarf, beard and candle.
  wizard.root.rotation.set(-0.22, -0.3, 0, 'YXZ');
  scene.add(wizard.root);
  const robot = makeRobot();
  robot.root.position.set(ROBOT_AT[0], 0, ROBOT_AT[1]);
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
