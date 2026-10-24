// The creatures, in a chubby, big-eyed collectible-monster style. Each is built from primitives with toon shading and
// thick ink outlines, and has a little idle animation:
//   liliac     — a round bat fluffball, flutters down fast (short words)
//   pietroi    — a determined little rock riding a comet tail (medium words)
//   fantomiță  — a shy ghost with its tongue out, sways (long words)
//   zmeuț      — a baby dragon with stubby wings (the longest words)
//   pietricică — a pebble buddy; a sentence is a row of them
//   balaur     — the boss: a chubby winged dragon with one head per word
// Every creature can wear a bubble shield (see `makeBubble`), which carries the word in the language you read.

import * as THREE from 'three';
import { flat } from './toon';
import { cheeks, cuteEye, flatInked, inked } from './world';

export type Kind = 'meteor' | 'bat' | 'ghost' | 'zmeu' | 'rock' | 'head';

export interface Model {
  root: THREE.Group;
  /** Rough radius, for bubbles, effects and label placement. */
  radius: number;
  /** Main body colour, for the poof effect. */
  color: number;
  animate(dt: number, t: number): void;
  /** A quick squash when hit by a beam. */
  hit(): void;
}

/** Squash and stretch on hit, decaying over a fraction of a second, around the body's base scale. */
function squash(body: THREE.Object3D, base = 1) {
  let k = 0;
  return {
    hit() {
      k = 1;
    },
    step(dt: number) {
      if (k <= 0) return;
      k = Math.max(0, k - dt * 6);
      const s = 1 + Math.sin(k * Math.PI) * 0.18;
      body.scale.set(base * s, base / s, base * s);
    },
  };
}

function smile(parent: THREE.Object3D, y: number, z: number, w: number) {
  const m = new THREE.Mesh(new THREE.RingGeometry(w * 0.72, w, 18, 1, Math.PI * 1.12, Math.PI * 0.76), flat(0x1b1630));
  m.position.set(0, y + w, z);
  parent.add(m);
  return m;
}

function fang(parent: THREE.Object3D, x: number, y: number, z: number, s: number) {
  const f = new THREE.Mesh(new THREE.ConeGeometry(0.07 * s, 0.16 * s, 4), flat(0xffffff));
  f.rotation.x = Math.PI;
  f.position.set(x, y, z);
  parent.add(f);
}

export function makeBat(): Model {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const purple = 0x8b6cf0;
  inked(body, new THREE.SphereGeometry(0.72, 18, 14), purple);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10).scale(1, 0.9, 0.45), flat(0xd9ccff));
  belly.position.set(0, -0.22, 0.48);
  body.add(belly);
  for (const s of [-1, 1]) {
    inked(body, new THREE.ConeGeometry(0.24, 0.6, 10).rotateZ(-s * 0.35).translate(s * 0.38, 0.78, 0), purple);
    cuteEye(body, s * 0.25, 0.12, 0.6, 0.17);
  }
  cheeks(body, 0.48, -0.05, 0.56, 0.1);
  smile(body, -0.26, 0.69, 0.11);
  fang(body, 0.07, -0.2, 0.7, 1);
  // Wings: flat scalloped shapes with an ink copy behind.
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0.25);
  wingShape.quadraticCurveTo(0.9, 0.9, 1.6, 0.5);
  wingShape.quadraticCurveTo(1.45, 0.1, 1.5, -0.2);
  wingShape.quadraticCurveTo(1.15, -0.05, 1.0, -0.35);
  wingShape.quadraticCurveTo(0.7, -0.1, 0.5, -0.35);
  wingShape.quadraticCurveTo(0.3, -0.1, 0, -0.2);
  wingShape.lineTo(0, 0.25);
  const wingGeo = new THREE.ShapeGeometry(wingShape, 8);
  const wings: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.55, 0.05, -0.15);
    pivot.scale.x = s;
    flatInked(pivot, wingGeo, 0x6a4fd0, 1.1);
    body.add(pivot);
    wings.push(pivot);
  }
  const phase = Math.random() * 10;
  const sq = squash(body);
  return {
    root,
    radius: 0.9,
    color: purple,
    hit: sq.hit,
    animate(dt, t) {
      const flap = Math.sin(t * 13 + phase) * 0.7;
      wings[0].rotation.y = flap;
      wings[1].rotation.y = -flap;
      body.position.y = Math.sin(t * 13 + phase + 1) * 0.1;
      sq.step(dt);
    },
  };
}

/** Flat comic flames trailing upwards behind a falling creature. */
function flames(parent: THREE.Object3D, radius: number) {
  const g = new THREE.Group();
  const shape = (w: number, h: number) => {
    const f = new THREE.Shape();
    f.moveTo(-w, 0);
    f.quadraticCurveTo(-w * 1.05, h * 0.45, -w * 0.55, h * 0.62);
    f.quadraticCurveTo(-w * 0.45, h * 0.8, -w * 0.62, h * 0.88);
    f.quadraticCurveTo(-w * 0.1, h * 0.75, 0, h);
    f.quadraticCurveTo(w * 0.15, h * 0.7, w * 0.5, h * 0.72);
    f.quadraticCurveTo(w * 0.35, h * 0.55, w * 0.8, h * 0.4);
    f.quadraticCurveTo(w * 1.05, h * 0.2, w, 0);
    f.absarc(0, 0, w, 0, Math.PI, true);
    return new THREE.ShapeGeometry(f, 8);
  };
  const layers: [number, number, number][] = [
    [0x1b1630, 1.12, -0.8],
    [0xff7a45, 1, -0.75],
    [0xffb84d, 0.7, -0.7],
    [0xfff3a6, 0.42, -0.65],
  ];
  for (const [c, s, z] of layers) {
    const m = new THREE.Mesh(shape(radius * 0.9 * s, radius * 2.8 * s), flat(c));
    m.position.set(0, c === 0x1b1630 ? -radius * 0.06 : 0, z);
    g.add(m);
  }
  parent.add(g);
  return g;
}

export function makeMeteor(radius = 1.0): Model {
  const root = new THREE.Group();
  const trail = flames(root, radius);
  const body = new THREE.Group();
  root.add(body);
  const stone = 0xa69bd6;
  // A softly lumpy rock: an icosphere pushed out by a smooth function of direction.
  const geo = new THREE.IcosahedronGeometry(radius, 2);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const seed = Math.random() * 10;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    v.multiplyScalar(radius * (1 + 0.07 * Math.sin(v.x * 4 + seed) * Math.cos(v.y * 3 + seed)));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  inked(body, geo, stone);
  for (const [x, y, r] of [[0.55, 0.45, 0.16], [-0.6, -0.4, 0.12], [0.35, -0.65, 0.1]]) {
    const spot = new THREE.Mesh(new THREE.CircleGeometry(r * radius, 12), flat(0x8a7fc0));
    const d = new THREE.Vector3(x, y, 0.75).normalize().multiplyScalar(radius * 1.01);
    spot.position.copy(d);
    spot.lookAt(d.clone().multiplyScalar(2));
    body.add(spot);
  }
  const face = new THREE.Group();
  face.position.z = radius * 0.86;
  body.add(face);
  for (const s of [-1, 1]) {
    cuteEye(face, s * 0.3 * radius, 0.1 * radius, 0.05, 0.19 * radius);
    // Determined little eyebrows.
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.32 * radius, 0.07 * radius, 0.05), flat(0x1b1630));
    brow.position.set(s * 0.3 * radius, 0.4 * radius, 0.06);
    brow.rotation.z = -s * 0.35;
    face.add(brow);
  }
  cheeks(face, 0.55 * radius, -0.12 * radius, 0.02, 0.1 * radius);
  smile(face, -0.34 * radius, 0.06, 0.12 * radius);
  const phase = Math.random() * 10;
  const sq = squash(body);
  return {
    root,
    radius,
    color: stone,
    hit: sq.hit,
    animate(dt, t) {
      body.rotation.z = Math.sin(t * 2 + phase) * 0.15;
      const f = 1 + Math.sin(t * 22 + phase) * 0.08;
      trail.scale.set(f, 1 + Math.sin(t * 17 + phase) * 0.12, f);
      sq.step(dt);
    },
  };
}

export function makeRock(): Model {
  const m = makeMeteor(0.8);
  m.root.children[0].scale.setScalar(0.55);
  return m;
}

export function makeGhost(): Model {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  // Bell-shaped sheet with a wavy hem: a lathe profile (bottom to top so faces point outwards), hem rippled.
  const profile: THREE.Vector2[] = [new THREE.Vector2(1.08, -0.85), new THREE.Vector2(1.0, -0.4)];
  for (let i = 12; i >= 0; i--) {
    const a = (i / 12) * Math.PI * 0.5;
    profile.push(new THREE.Vector2(Math.sin(a) * 0.95 + 0.0001, 0.45 + Math.cos(a) * 0.95));
  }
  const geo = new THREE.LatheGeometry(profile, 24);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < -0.8) pos.setY(i, y + Math.sin(Math.atan2(pos.getZ(i), pos.getX(i)) * 6) * 0.18);
  }
  geo.computeVertexNormals();
  const white = 0xf2fbff;
  inked(body, geo, white);
  for (const s of [-1, 1]) cuteEye(body, s * 0.33, 0.62, 0.86, 0.2);
  cheeks(body, 0.6, 0.32, 0.86, 0.13);
  const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.13, 14), flat(0x1b1630));
  mouth.scale.y = 0.8;
  mouth.position.set(0, 0.28, 0.94);
  body.add(mouth);
  const tongue = new THREE.Mesh(new THREE.CircleGeometry(0.08, 12), flat(0xff6f91));
  tongue.position.set(0.03, 0.22, 0.95);
  body.add(tongue);
  const arms: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const arm = inked(body, new THREE.SphereGeometry(0.2, 10, 8).scale(1.4, 0.8, 0.8), white);
    arm.position.set(s * 0.98, 0.1, 0.25);
    arms.push(arm);
  }
  const phase = Math.random() * 10;
  const sq = squash(body);
  return {
    root,
    radius: 1.1,
    color: 0xbfe9ff,
    hit: sq.hit,
    animate(dt, t) {
      body.rotation.z = Math.sin(t * 2.2 + phase) * 0.15;
      arms[0].position.y = 0.1 + Math.sin(t * 4 + phase) * 0.15;
      arms[1].position.y = 0.1 - Math.sin(t * 4 + phase) * 0.15;
      body.position.y = Math.sin(t * 3 + phase) * 0.12;
      sq.step(dt);
    },
  };
}

/** A baby dragon head, used by the zmeuț and as each balaur head. */
function dragonHead(parent: THREE.Object3D, color: number, s = 1) {
  const head = new THREE.Group();
  parent.add(head);
  inked(head, new THREE.SphereGeometry(0.85 * s, 18, 14).scale(1.12, 0.95, 1), color);
  const snout = inked(head, new THREE.SphereGeometry(0.5 * s, 14, 10).scale(1.2, 0.8, 0.9), color);
  snout.position.set(0, -0.3 * s, 0.6 * s);
  for (const side of [-1, 1]) {
    inked(head, new THREE.ConeGeometry(0.16 * s, 0.5 * s, 8).rotateZ(-side * 0.4).translate(side * 0.5 * s, 0.85 * s, -0.1 * s), 0xfff1c9);
    cuteEye(head, side * 0.36 * s, 0.18 * s, 0.72 * s, 0.2 * s);
    const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.05 * s, 6, 4), flat(0x1b1630));
    nostril.position.set(side * 0.16 * s, -0.22 * s, 1.03 * s);
    head.add(nostril);
  }
  cheeks(head, 0.62 * s, -0.12 * s, 0.68 * s, 0.11 * s);
  smile(head, -0.5 * s, 0.98 * s, 0.12 * s);
  fang(head, 0.12 * s, -0.48 * s, 0.98 * s, s);
  // A little crest of soft spikes over the head.
  for (let i = 0; i < 3; i++) {
    const spike = new THREE.ConeGeometry(0.14 * s, 0.4 * s, 6).translate(0, 0.2 * s, 0).rotateX(-0.5 - i * 0.5);
    inked(head, spike.translate(0, 0.75 * s, -0.1 * s - i * 0.25 * s), 0xff7a8a);
  }
  return head;
}

export function makeZmeu(): Model {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const green = 0x5fd68a;
  inked(body, new THREE.SphereGeometry(0.85, 18, 14).scale(1, 1.05, 0.9).translate(0, -0.55, 0), green);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 10).scale(1, 1.1, 0.45), flat(0xfff1b3));
  belly.position.set(0, -0.6, 0.55);
  body.add(belly);
  const head = dragonHead(body, green);
  head.position.y = 0.55;
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0);
  wingShape.quadraticCurveTo(0.5, 0.9, 1.1, 0.7);
  wingShape.quadraticCurveTo(0.9, 0.3, 1.0, -0.1);
  wingShape.quadraticCurveTo(0.6, 0.0, 0, -0.3);
  const wings: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.6, -0.3, -0.3);
    pivot.scale.x = s;
    flatInked(pivot, new THREE.ShapeGeometry(wingShape, 8), 0x3fb8a0, 1.1);
    body.add(pivot);
    wings.push(pivot);
    const foot = inked(body, new THREE.SphereGeometry(0.22, 10, 8).scale(1.2, 0.8, 1), green);
    foot.position.set(s * 0.4, -1.35, 0.2);
  }
  const phase = Math.random() * 10;
  const sq = squash(body);
  return {
    root,
    radius: 1.4,
    color: green,
    hit: sq.hit,
    animate(dt, t) {
      const flap = Math.sin(t * 6 + phase) * 0.5;
      wings[0].rotation.y = flap;
      wings[1].rotation.y = -flap;
      head.rotation.z = Math.sin(t * 1.6 + phase) * 0.12;
      sq.step(dt);
    },
  };
}

/** A balaur head: a dragon head on its own, swaying on the end of its neck. */
export function makeHead(): Model {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const head = dragonHead(body, 0x5fd68a, 1.05);
  const phase = Math.random() * 10;
  const sq = squash(body);
  return {
    root,
    radius: 1.0,
    color: 0x5fd68a,
    hit: sq.hit,
    animate(dt, t) {
      head.rotation.z = Math.sin(t * 1.8 + phase) * 0.15;
      head.rotation.y = Math.sin(t * 1.1 + phase) * 0.2;
      sq.step(dt);
    },
  };
}

export function makeModel(kind: Kind): Model {
  switch (kind) {
    case 'bat':
      return makeBat();
    case 'ghost':
      return makeGhost();
    case 'zmeu':
      return makeZmeu();
    case 'rock':
      return makeRock();
    case 'head':
      return makeHead();
    default:
      return makeMeteor();
  }
}

/** The balaur's body: chubby belly, wings, a curly tail and a neck up to each head position (x, y relative to it). */
export function makeBalaurBody(heads: { x: number; y: number }[]): Model {
  const root = new THREE.Group();
  const green = 0x5fd68a;
  const span = Math.max(3.5, Math.max(...heads.map((h) => Math.abs(h.x))) * 0.7);
  inked(root, new THREE.SphereGeometry(1, 22, 16).scale(span * 0.55, 1.8, 1.4), green);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12).scale(span * 0.42, 1.35, 0.55), flat(0xfff1b3));
  belly.position.set(0, -0.25, 1.0);
  root.add(belly);
  for (const h of heads) {
    const from = new THREE.Vector3(h.x * 0.3, 0.9, 0.2);
    const to = new THREE.Vector3(h.x, h.y - 0.8, 0);
    for (let i = 0; i <= 6; i++) {
      const k = i / 6;
      const p = from.clone().lerp(to, k);
      p.y += Math.sin(k * Math.PI) * 0.5;
      inked(root, new THREE.SphereGeometry(0.55 - k * 0.1, 12, 8), green).position.copy(p);
    }
  }
  const wings: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(span * 0.5, 2.8, span * 1.0, 2.2);
    shape.quadraticCurveTo(span * 0.85, 1.0, span * 1.0, -0.2);
    shape.quadraticCurveTo(span * 0.7, 0.2, span * 0.55, -0.6);
    shape.quadraticCurveTo(span * 0.3, -0.2, 0, -0.6);
    const pivot = new THREE.Group();
    pivot.position.set(s * span * 0.35, 0.6, -0.6);
    pivot.scale.x = s;
    flatInked(pivot, new THREE.ShapeGeometry(shape, 8), 0x3fb8a0, 1.05);
    root.add(pivot);
    wings.push(pivot);
    inked(root, new THREE.SphereGeometry(0.4, 10, 8).scale(1.3, 0.8, 1), green).position.set(s * span * 0.3, -1.8, 0.4);
  }
  const tail = new THREE.Group();
  root.add(tail);
  for (let i = 0; i < 8; i++) {
    inked(tail, new THREE.SphereGeometry(0.45 - i * 0.04, 10, 8), green).position.set(Math.sin(i * 0.7) * 1.1, -1.5 - i * 0.4, -0.4);
  }
  const tip = inked(tail, new THREE.ConeGeometry(0.3, 0.7, 4), 0xff7a8a);
  tip.position.set(Math.sin(8 * 0.7) * 1.1, -1.5 - 8 * 0.4, -0.4);
  tip.rotation.z = Math.PI;
  return {
    root,
    radius: span,
    color: green,
    hit() {},
    animate(_dt, t) {
      const flap = Math.sin(t * 3.2) * 0.4;
      wings[0].rotation.z = -flap;
      wings[1].rotation.z = flap;
      tail.rotation.z = Math.sin(t * 1.7) * 0.15;
    },
  };
}

// ---- bubble shield ---------------------------------------------------------------------------------------------

const bubbleGeo = new THREE.SphereGeometry(1, 28, 20);
bubbleGeo.userData.shared = true;
let bubbleMat: THREE.ShaderMaterial | null = null;

/**
 * Soapy bubble: clear in the middle, a bright rim, a faint rainbow sheen, in hard bands like the toon shading, and
 * an ink line at the silhouette. (An inverted-hull outline would show through the transparent skin as a dark disc.)
 */
function bubbleMaterial() {
  if (!bubbleMat) {
    bubbleMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { time: { value: 0 } },
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float time; varying vec3 vN; varying vec3 vV;
        void main() {
          float f = 1.0 - max(dot(vN, vV), 0.0);
          float band = f > 0.7 ? 0.8 : f > 0.42 ? 0.38 : 0.12;
          vec3 sheen = 0.5 + 0.5 * cos(6.28 * (f * 0.8 + time * 0.1 + vec3(0.0, 0.33, 0.67)));
          vec3 c = mix(vec3(0.55, 0.9, 1.0), sheen, 0.3);
          if (f > 0.93) { c = vec3(0.18, 0.23, 0.42); band = 1.0; }
          gl_FragColor = vec4(c, band);
        }`,
    });
  }
  return bubbleMat;
}

export function tickBubbles(t: number) {
  if (bubbleMat) bubbleMat.uniforms.time.value = t;
}

export interface Bubble {
  root: THREE.Group;
  /** Wobble after a letter hits it. */
  hit(): void;
  update(dt: number, t: number): void;
}

/** A shield bubble of radius `r` (stretched to half-width `w` for a sentence convoy), with an ink rim and a glare. */
export function makeBubble(r: number, w = r): Bubble {
  const root = new THREE.Group();
  const shell = new THREE.Group();
  shell.scale.set(w, r, r * 0.9);
  root.add(shell);
  const skin = new THREE.Mesh(bubbleGeo, bubbleMaterial());
  skin.renderOrder = 5;
  shell.add(skin);
  const glare = new THREE.Mesh(
    new THREE.CircleGeometry(1, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  glare.scale.set(0.22 * Math.min(1, r / w) * 1.6, 0.12, 1);
  glare.rotation.z = 0.7;
  glare.position.set(-0.55, 0.55, 0.75);
  glare.renderOrder = 6;
  shell.add(glare);
  let wobble = 0;
  const phase = Math.random() * 10;
  return {
    root,
    hit() {
      wobble = 1;
    },
    update(dt, t) {
      wobble = Math.max(0, wobble - dt * 4);
      const k = Math.sin(t * 30) * wobble * 0.08;
      const breathe = Math.sin(t * 2 + phase) * 0.02;
      root.scale.set(1 + k + breathe, 1 - k + breathe, 1);
    },
  };
}
