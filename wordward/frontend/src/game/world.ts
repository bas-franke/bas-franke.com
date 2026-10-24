// The stage, in a bright storybook style: a banded afternoon sky with a smiling sun and fluffy inked clouds, pastel
// mountains, rolling hills with round trees, and the candy-coloured castle the player defends. On the middle tower
// stands Bufnița, the owl guardian, who turns to face the current target and fires star beams from her staff.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { flat, hullGeometry, inkMaterial, toon } from './toon';

/** Height at which an enemy reaches the castle. */
export const IMPACT_Y = 3.4;

/** Outline thickness for everything chunky and cute (thicker than the default ink). */
export const THICK = 0.0068;

export const PAL = {
  skyTop: new THREE.Color(0x5ab8ff),
  skyMid: new THREE.Color(0x9fdcff),
  skyLow: new THREE.Color(0xfff0c9),
  cream: 0xfff1d6,
  creamDark: 0xf2d9b0,
  red: 0xff5a6e,
  blue: 0x4fa3ff,
  yellow: 0xffd23f,
  mint: 0x5fd6b0,
  grass: 0x7ed957,
  grassDark: 0x5cbf4f,
  hillFar: 0x9be37a,
  leaf: 0x46b85a,
  leafLight: 0x6fd36b,
  trunk: 0x9b6a43,
  window: 0x2d3a6b,
  beam: 0xff6fb5,
};

/** Adds a toon mesh with an ink hull to `parent`. */
export function inked(parent: THREE.Object3D, geo: THREE.BufferGeometry, color: number, ink: number | false = THICK): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, toon(color));
  if (ink !== false) mesh.add(new THREE.Mesh(hullGeometry(geo), inkMaterial(ink, 0.012)));
  parent.add(mesh);
  return mesh;
}

/** A flat shape with a slightly larger ink copy behind it: for things that face the camera (sun, flags, flames). */
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

function sky(scene: THREE.Scene) {
  const geo = new THREE.SphereGeometry(500, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: PAL.skyTop }, mid: { value: PAL.skyMid }, low: { value: PAL.skyLow } },
    vertexShader: `varying vec3 vPos; void main(){ vPos = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    // Hard bands instead of a smooth gradient, to match the cel-shaded look.
    fragmentShader: `
      uniform vec3 top; uniform vec3 mid; uniform vec3 low; varying vec3 vPos;
      void main(){
        float h = clamp(vPos.y * 2.4 + 0.05, 0.0, 1.0);
        float b = floor(h * 6.0) / 6.0;
        vec3 c = b < 0.5 ? mix(low, mid, b * 2.0) : mix(mid, top, (b - 0.5) * 2.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
}

/** A smiling sun with rays, facing the camera. */
function sun(scene: THREE.Scene) {
  const g = new THREE.Group();
  g.position.set(150, 105, -320);
  const rays = new THREE.Group();
  for (let i = 0; i < 12; i++) {
    const ray = new THREE.Shape();
    ray.moveTo(-3.5, 0);
    ray.lineTo(0, 12);
    ray.lineTo(3.5, 0);
    const r = flatInked(rays, new THREE.ShapeGeometry(ray), 0xffc53d, 1.15, 1);
    r.position.y = 25;
    const pivot = new THREE.Group();
    pivot.rotation.z = (i / 12) * Math.PI * 2;
    pivot.add(r);
    rays.add(pivot);
  }
  g.add(rays);
  flatInked(g, new THREE.CircleGeometry(22, 40), 0xffe066, 1.06, 1).position.z = 3;
  const face = new THREE.Group();
  face.position.z = 5;
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.CircleGeometry(2, 16), flat(0x5a3b1a));
    eye.scale.y = 1.4;
    eye.position.set(s * 7, 3, 0);
    face.add(eye);
    const cheek = new THREE.Mesh(new THREE.CircleGeometry(3.2, 16), flat(0xffa36b));
    cheek.position.set(s * 12, -3, 0);
    face.add(cheek);
  }
  const smile = new THREE.Mesh(new THREE.RingGeometry(5, 6.6, 24, 1, Math.PI * 1.15, Math.PI * 0.7), flat(0x5a3b1a));
  smile.position.y = 0;
  face.add(smile);
  g.add(face);
  scene.add(g);
  return rays;
}

/** A fluffy cloud: a cluster of toon spheres with one ink hull per puff. */
function cloud(parent: THREE.Object3D, size: number) {
  const g = new THREE.Group();
  const puffs: [number, number, number][] = [[0, 0, 1], [1.1, -0.2, 0.75], [-1.1, -0.25, 0.7], [0.5, 0.45, 0.7], [-0.5, 0.35, 0.65]];
  for (const [x, y, r] of puffs) {
    const m = inked(g, new THREE.SphereGeometry(r * size, 14, 10), 0xffffff, 0.005);
    m.position.set(x * size, y * size, 0);
    m.scale.z = 0.6;
  }
  parent.add(g);
  return g;
}

/** Rounded pastel mountains as flat layered shapes with snow caps and an ink edge. */
function mountains(scene: THREE.Scene, z: number, height: number, color: number, seed: number) {
  const width = 1000;
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, -30);
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  let x = -width / 2;
  shape.lineTo(x, 0);
  const caps: [number, number, number][] = [];
  while (x < width / 2) {
    const w = 40 + rnd() * 50;
    const h = height * (0.55 + rnd() * 0.45);
    // A rounded peak: up, a soft top, down.
    shape.quadraticCurveTo(x + w * 0.3, h * 0.9, x + w * 0.5, h);
    shape.quadraticCurveTo(x + w * 0.7, h * 0.9, x + w, 0);
    caps.push([x + w * 0.5, h, w]);
    x += w;
  }
  shape.lineTo(width / 2, -30);
  const geo = new THREE.ShapeGeometry(shape, 12);
  const mesh = new THREE.Mesh(geo, flat(color));
  mesh.position.z = z;
  scene.add(mesh);
  const edge = new THREE.Mesh(geo, flat(0x2d3a6b));
  edge.scale.set(1.002, 1.025, 1);
  edge.position.set(0, 0.6, z - 3);
  scene.add(edge);
  for (const [cx, cy, w] of caps) {
    if (cy < height * 0.75) continue;
    const cap = new THREE.Shape();
    const cw = w * 0.2;
    cap.moveTo(cx - cw, cy - cw * 0.55);
    cap.quadraticCurveTo(cx - cw * 0.5, cy - cw * 0.05, cx, cy);
    cap.quadraticCurveTo(cx + cw * 0.5, cy - cw * 0.05, cx + cw, cy - cw * 0.55);
    cap.quadraticCurveTo(cx + cw * 0.5, cy - cw * 0.85, cx + cw * 0.1, cy - cw * 0.5);
    cap.quadraticCurveTo(cx - cw * 0.3, cy - cw * 0.9, cx - cw, cy - cw * 0.55);
    const m = new THREE.Mesh(new THREE.ShapeGeometry(cap, 8), flat(0xffffff));
    m.position.z = z + 3;
    scene.add(m);
  }
}

function tree(parent: THREE.Object3D, x: number, z: number, s: number, color: number) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  inked(g, new THREE.CylinderGeometry(0.25 * s, 0.35 * s, 1.4 * s, 8).translate(0, 0.7 * s, 0), PAL.trunk);
  inked(g, new THREE.SphereGeometry(1.1 * s, 14, 10).translate(0, 2.1 * s, 0), color);
  inked(g, new THREE.SphereGeometry(0.75 * s, 12, 8).translate(0.6 * s, 2.6 * s, 0.2 * s), color);
  parent.add(g);
}

export interface World {
  /** The owl's head, turned towards the current target. */
  aimAt(target: THREE.Vector3, dt: number): void;
  /** World position star beams start from. */
  muzzle(out: THREE.Vector3): THREE.Vector3;
  /** Owl reactions. */
  cast(): void;
  oops(): void;
  /** Visible damage: called with the fraction of health left. */
  setDamage(frac: number): void;
  update(dt: number, t: number): void;
}

export function buildWorld(scene: THREE.Scene): World {
  scene.fog = new THREE.Fog(0xc9ecff, 260, 900);
  sky(scene);
  const rays = sun(scene);
  mountains(scene, -300, 90, 0xc3b5ff, 7);
  mountains(scene, -220, 55, 0xa3d8f0, 31);

  // Clouds drift slowly across the back.
  const clouds: THREE.Group[] = [];
  for (let i = 0; i < 9; i++) {
    const c = cloud(scene, 3 + (i % 3) * 1.5);
    c.position.set(-160 + i * 40 + Math.random() * 20, 45 + Math.random() * 40, -120 - Math.random() * 60);
    clouds.push(c);
  }

  scene.add(new THREE.HemisphereLight(0xdff3ff, 0x8a7a5a, 1.5));
  const sunLight = new THREE.DirectionalLight(0xfff2d6, 2.6);
  sunLight.position.set(25, 40, 45);
  scene.add(sunLight);

  // Ground and rolling hills.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 300), toon(PAL.grass));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, -100);
  scene.add(ground);
  let s = 77;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 16; i++) {
    const r = 18 + rnd() * 22;
    const hill = inked(scene, new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), i % 2 ? PAL.hillFar : PAL.grassDark, 0.004);
    hill.scale.y = 0.35 + rnd() * 0.25;
    hill.position.set(-260 + i * 34 + rnd() * 10, 0, -70 - rnd() * 60);
    for (let k = 0; k < 3; k++) tree(scene, hill.position.x + (rnd() - 0.5) * r, hill.position.z + r * 0.3, 2.4 + rnd(), rnd() > 0.5 ? PAL.leaf : PAL.leafLight);
  }
  for (let i = 0; i < 30; i++) {
    const x = -90 + rnd() * 180;
    if (Math.abs(x) < 10) continue;
    tree(scene, x, -14 - rnd() * 30, 0.9 + rnd() * 0.8, rnd() > 0.5 ? PAL.leaf : PAL.leafLight);
  }

  const city = new THREE.Group();
  scene.add(city);

  // Front wall: cream stone with rounded merlons, across the whole screen.
  const wallParts: THREE.BufferGeometry[] = [new THREE.BoxGeometry(170, 2.6, 1.8).translate(0, 1.3, 1)];
  for (let x = -85; x <= 85; x += 1.7) wallParts.push(new THREE.CapsuleGeometry(0.42, 0.35, 4, 8).translate(x, 3.0, 1));
  inked(city, mergeGeometries(wallParts), PAL.cream);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(170, 0.35, 1.85), toon(PAL.creamDark));
  stripe.position.set(0, 0.5, 1);
  city.add(stripe);

  // Round towers with candy roofs and waving flags.
  const roofColors = [PAL.red, PAL.blue, PAL.yellow, PAL.mint];
  const flags: THREE.Object3D[] = [];
  for (let x = -76; x <= 76; x += 11) {
    if (Math.abs(x) < 5) continue;
    const tw = new THREE.Group();
    tw.position.set(x, 0, 1.3);
    const color = roofColors[Math.abs(Math.round(x / 11)) % roofColors.length];
    inked(tw, new THREE.CylinderGeometry(1.45, 1.6, 4.6, 14).translate(0, 2.3, 0), PAL.cream);
    inked(tw, new THREE.ConeGeometry(2.05, 2.8, 14).translate(0, 6.0, 0), color);
    const win = new THREE.Mesh(new THREE.CircleGeometry(0.42, 16), flat(PAL.window));
    win.position.set(0, 3.1, 1.62);
    tw.add(win);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 6), flat(0x5a3b1a));
    pole.position.y = 8.0;
    tw.add(pole);
    const flagShape = new THREE.Shape();
    flagShape.moveTo(0, 0);
    flagShape.lineTo(1.2, -0.25);
    flagShape.lineTo(0, -0.6);
    const flag = flatInked(tw, new THREE.ShapeGeometry(flagShape), roofColors[(Math.abs(Math.round(x / 11)) + 1) % 4], 1.12);
    flag.position.set(0.05, 8.6, 0);
    flags.push(flag);
    city.add(tw);
  }

  // Cottages behind the wall: rounded boxes with chunky roofs and round windows.
  const houses: THREE.Group[] = [];
  for (let x = -82; x <= 82; x += 2.8 + rnd() * 1.2) {
    const h = 1.8 + rnd() * 1.6;
    const w = 2 + rnd() * 0.9;
    const d = 2 + rnd();
    const house = new THREE.Group();
    house.position.set(x, 0, -2.6 - rnd() * 5);
    inked(house, new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), rnd() > 0.5 ? 0xfff6e6 : 0xffe3c2);
    const roof = new THREE.CylinderGeometry(0.01, w * 0.8, 1.4 + rnd() * 0.6, 4, 1);
    roof.rotateY(Math.PI / 4);
    roof.scale(1, 1, d / w);
    roof.translate(0, h + 0.75, 0);
    inked(house, roof, roofColors[(rnd() * 4) | 0]);
    const win = new THREE.Mesh(new THREE.CircleGeometry(0.28, 12), flat(PAL.window));
    win.position.set(0, h * 0.6, d / 2 + 0.01);
    house.add(win);
    city.add(house);
    houses.push(house);
  }

  // The keep in the middle, with the owl on top.
  const keep = new THREE.Group();
  keep.position.set(0, 0, 2.4);
  inked(keep, new THREE.CylinderGeometry(2.3, 2.6, 5.2, 18).translate(0, 2.6, 0), PAL.cream);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.42, 0.22, 8, 24), toon(PAL.blue));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 5.2;
  keep.add(ring);
  const crown: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    crown.push(new THREE.CapsuleGeometry(0.32, 0.3, 4, 8).translate(Math.cos(a) * 2.25, 5.75, Math.sin(a) * 2.25));
  }
  inked(keep, mergeGeometries(crown), PAL.cream);
  const door = new THREE.Mesh(new THREE.CircleGeometry(0.85, 20, 0, Math.PI), flat(0x8a5a3c));
  door.position.set(0, 0.9, 2.61);
  keep.add(door);
  scene.add(keep);

  const owl = makeOwl();
  owl.root.position.set(0, 5.5, 0);
  keep.add(owl.root);

  // Smoke puffs over cottages, shown as health drops (no flames: it is a friendly castle).
  const smokes: THREE.Group[] = [];
  const near = houses.filter((h) => Math.abs(h.position.x) < 30).sort(() => rnd() - 0.5);
  for (const house of near) {
    const p = new THREE.Group();
    p.position.set(house.position.x, 4.5, house.position.z + 1);
    for (let i = 0; i < 3; i++) {
      const puff = inked(p, new THREE.SphereGeometry(0.45 + i * 0.12, 10, 8), 0x9a95b8, 0.004);
      puff.position.set(Math.sin(i * 2) * 0.3, i * 0.7, 0);
    }
    p.visible = false;
    scene.add(p);
    smokes.push(p);
  }

  return {
    aimAt: owl.aimAt,
    muzzle: owl.muzzle,
    cast: owl.cast,
    oops: owl.oops,
    setDamage(frac) {
      const n = Math.round((1 - frac) * smokes.length);
      smokes.forEach((f, i) => (f.visible = i < n));
    },
    update(dt, t) {
      rays.rotation.z = t * 0.08;
      for (const c of clouds) {
        c.position.x += dt * 1.2;
        if (c.position.x > 220) c.position.x = -220;
      }
      flags.forEach((f, i) => (f.rotation.y = Math.sin(t * 3 + i) * 0.4));
      smokes.forEach((p, i) => {
        if (!p.visible) return;
        p.children.forEach((c, k) => {
          const ph = (t * 0.6 + k / 3 + i * 0.37) % 1;
          c.position.y = ph * 2.4;
          c.scale.setScalar(0.6 + ph * 0.9);
        });
      });
      owl.update(dt, t);
    },
  };
}

/** Bufnița, the owl guardian: round body, big eyes, ear tufts, and a staff with a star-shaped crystal. */
function makeOwl() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const brown = 0xb07a4f;
  inked(body, new THREE.SphereGeometry(1.25, 20, 14).scale(1, 1.08, 0.95).translate(0, 1.2, 0), brown);
  const belly = inked(body, new THREE.SphereGeometry(0.9, 16, 12).scale(1, 1.05, 0.5).translate(0, 1.0, 0.72), 0xffe7c2, false);
  belly.renderOrder = 1;
  for (const s of [-1, 1]) {
    const wing = inked(body, new THREE.SphereGeometry(0.55, 12, 10).scale(0.55, 1.2, 0.8), 0x8f5e3a);
    wing.position.set(s * 1.2, 1.15, 0);
    wing.rotation.z = s * 0.25;
    const foot = inked(body, new THREE.SphereGeometry(0.22, 8, 6).scale(1.3, 0.6, 1), 0xffa53d);
    foot.position.set(s * 0.45, 0.05, 0.5);
  }
  const head = new THREE.Group();
  head.position.y = 2.55;
  body.add(head);
  inked(head, new THREE.SphereGeometry(1.0, 20, 14).scale(1.15, 0.92, 1), brown);
  const mask = new THREE.Mesh(new THREE.SphereGeometry(0.95, 18, 12).scale(1.08, 0.82, 0.55), toon(0xffe7c2));
  mask.position.set(0, -0.05, 0.5);
  head.add(mask);
  for (const s of [-1, 1]) {
    inked(head, new THREE.ConeGeometry(0.26, 0.7, 8).rotateZ(-s * 0.45).translate(s * 0.8, 0.85, 0), 0x8f5e3a);
    const rim = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), flat(0xffffff));
    rim.position.set(s * 0.42, 0.05, 1.03);
    head.add(rim);
    cuteEye(head, s * 0.42, 0.05, 1.05, 0.3);
  }
  const beak = inked(head, new THREE.ConeGeometry(0.16, 0.36, 8).rotateX(Math.PI).translate(0, -0.3, 1.02), 0xffa53d);
  beak.rotation.x = -0.25;
  cheeks(head, 0.75, -0.3, 0.9, 0.16);

  // The staff, held in front, with a star crystal on top.
  const staff = new THREE.Group();
  staff.position.set(1.05, 0.9, 0.6);
  body.add(staff);
  inked(staff, new THREE.CylinderGeometry(0.08, 0.1, 2.6, 8).translate(0, 1.0, 0), 0x6b4a8a);
  const starShape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 ? 0.2 : 0.45;
    if (i === 0) starShape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else starShape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const star = inked(staff, new THREE.ExtrudeGeometry(starShape, { depth: 0.18, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 1 }).translate(0, 0, -0.09), PAL.yellow);
  star.position.y = 2.5;
  const tip = new THREE.Object3D();
  tip.position.set(0, 2.5, 0.3);
  staff.add(tip);

  const target = new THREE.Vector3(0, 30, 0);
  const local = new THREE.Vector3();
  let yaw = 0;
  let pitch = 0;
  let castT = 0;
  let oopsT = 0;
  return {
    root,
    aimAt(p: THREE.Vector3, dt: number) {
      target.lerp(p, Math.min(1, dt * 12));
    },
    muzzle(out: THREE.Vector3) {
      return tip.getWorldPosition(out);
    },
    cast() {
      castT = 0.18;
    },
    oops() {
      oopsT = 0.45;
    },
    update(dt: number, t: number) {
      local.copy(target);
      root.worldToLocal(local);
      local.y -= 2.5;
      const wantYaw = Math.atan2(local.x, Math.max(1, local.y)) * 0.9;
      const wantPitch = -Math.atan2(local.y, 12) * 0.25;
      yaw += (wantYaw - yaw) * Math.min(1, dt * 10);
      pitch += (wantPitch - pitch) * Math.min(1, dt * 10);
      // The head turns towards the target; the staff points at it.
      head.rotation.z = -yaw * 0.6 + (oopsT > 0 ? Math.sin(oopsT * 40) * 0.25 : 0);
      head.rotation.x = pitch;
      staff.rotation.z = -yaw * 1.1 - 0.15;
      castT = Math.max(0, castT - dt);
      oopsT = Math.max(0, oopsT - dt);
      star.rotation.y = t * 2.5;
      const sq = castT > 0 ? 1 + castT * 0.8 : 1;
      body.scale.set(1 / Math.sqrt(sq), sq * (1 + Math.sin(t * 2.4) * 0.02), 1 / Math.sqrt(sq));
      star.scale.setScalar(1 + castT * 3);
    },
  };
}
