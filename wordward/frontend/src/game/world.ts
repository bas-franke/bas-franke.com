// The stage: a dusk sky over the Carpathians, and the citadel (cetatea) the player defends, with the laser tower in
// the middle. Everything is procedural low-poly geometry with toon materials and ink outlines.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { flat, hullGeometry, inkMaterial, toon } from './toon';

/** Height at which an enemy hits the citadel. */
export const IMPACT_Y = 3.2;

const PAL = {
  skyTop: new THREE.Color(0x140c2e),
  skyMid: new THREE.Color(0x4b2470),
  skyLow: new THREE.Color(0xff8a5c),
  stone: 0xe7d3a8,
  stoneDark: 0xb99c74,
  roof: 0xe0483a,
  roofAlt: 0x2f8f8a,
  wood: 0x7a4a2c,
  window: 0xffd36b,
  grass: 0x3d7a4f,
  grassFar: 0x2c5a48,
  laser: 0xff3d8b,
};

/** Adds a toon mesh and its ink hull to `parent`. */
export function inked(parent: THREE.Object3D, geo: THREE.BufferGeometry, color: number, ink = true): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, toon(color));
  if (ink) mesh.add(new THREE.Mesh(hullGeometry(geo), inkMaterial()));
  parent.add(mesh);
  return mesh;
}

function sky(scene: THREE.Scene) {
  const geo = new THREE.SphereGeometry(400, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { top: { value: PAL.skyTop }, mid: { value: PAL.skyMid }, low: { value: PAL.skyLow } },
    vertexShader: `varying vec3 vPos; void main(){ vPos = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    // Hard bands instead of a smooth gradient, to match the cel-shaded look.
    fragmentShader: `
      uniform vec3 top; uniform vec3 mid; uniform vec3 low; varying vec3 vPos;
      void main(){
        float h = clamp(vPos.y * 2.2 + 0.08, 0.0, 1.0);
        float b = floor(h * 7.0) / 7.0;
        vec3 c = b < 0.5 ? mix(low, mid, b * 2.0) : mix(mid, top, (b - 0.5) * 2.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geo, mat));

  // Stars: points scattered over the upper sky.
  const count = 600;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const y = 0.15 + Math.random() * 0.85;
    const r = Math.sqrt(1 - y * y);
    pos.set([Math.cos(theta) * r * 350, y * 350, Math.sin(theta) * r * 350 - 60], i * 3);
  }
  const stars = new THREE.BufferGeometry();
  stars.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(stars, new THREE.PointsMaterial({ color: 0xfff4d6, size: 1.6, sizeAttenuation: false })));

  // A big moon with an ink ring and two craters.
  const moon = new THREE.Group();
  moon.position.set(-70, 95, -260);
  inked(moon, new THREE.CircleGeometry(16, 40), 0xfff1c1, false).material = flat(0xfff1c1);
  const ring = new THREE.Mesh(new THREE.RingGeometry(16, 17.4, 40), flat(0x16121c));
  moon.add(ring);
  for (const [x, y, r] of [[-5, 4, 3.2], [6, -3, 2.2], [1, -8, 1.5]]) {
    const crater = new THREE.Mesh(new THREE.CircleGeometry(r, 20), flat(0xe8d49a));
    crater.position.set(x, y, 0.1);
    moon.add(crater);
  }
  scene.add(moon);
}

/** A jagged mountain range: one wide strip of triangles with snow caps, at a given depth. */
function range(scene: THREE.Scene, z: number, height: number, color: number, seed: number, snow: boolean) {
  const width = 900;
  const peaks = 22;
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, -20);
  const tops: [number, number][] = [];
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i <= peaks * 2; i++) {
    const x = -width / 2 + (i / (peaks * 2)) * width;
    const y = i % 2 === 0 ? height * (0.15 + rnd() * 0.25) : height * (0.6 + rnd() * 0.4);
    shape.lineTo(x, y);
    if (i % 2 === 1) tops.push([x, y]);
  }
  shape.lineTo(width / 2, -20);
  shape.lineTo(-width / 2, -20);
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), flat(color));
  mesh.position.z = z;
  scene.add(mesh);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.ShapeGeometry(shape)), new THREE.LineBasicMaterial({ color: 0x16121c }));
  edge.position.z = z + 0.1;
  scene.add(edge);
  if (snow) {
    for (const [x, y] of tops) {
      const cap = new THREE.Shape();
      const w = height * 0.16;
      cap.moveTo(x, y);
      cap.lineTo(x + w, y - w * 1.1);
      cap.lineTo(x + w * 0.3, y - w * 0.8);
      cap.lineTo(x - w * 0.2, y - w * 1.2);
      cap.lineTo(x - w, y - w * 1.0);
      cap.lineTo(x, y);
      const m = new THREE.Mesh(new THREE.ShapeGeometry(cap), flat(0xf3e9ff));
      m.position.z = z + 0.2;
      scene.add(m);
    }
  }
}

export interface World {
  /** The laser head, rotated towards the current target. */
  head: THREE.Object3D;
  /** World position lasers start from. */
  muzzle(out: THREE.Vector3): THREE.Vector3;
  /** Visible damage: called with the fraction of health left. */
  setDamage(frac: number): void;
  update(dt: number, t: number): void;
}

export function buildWorld(scene: THREE.Scene): World {
  scene.fog = new THREE.Fog(0x4b2470, 120, 420);
  sky(scene);
  range(scene, -230, 75, 0x3a2160, 7, true);
  range(scene, -160, 42, 0x2a1a4a, 31, true);
  range(scene, -100, 20, 0x1f2a48, 77, false);

  // Lights: a warm key from the low sun on the right, cool fill from the sky.
  scene.add(new THREE.HemisphereLight(0x9aa8ff, 0x3a2140, 1.4));
  const sun = new THREE.DirectionalLight(0xffd2a8, 2.4);
  sun.position.set(30, 40, 40);
  scene.add(sun);

  // Ground: a big hill under the citadel and darker fields behind it.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 140), toon(PAL.grass));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, -30);
  scene.add(ground);
  const far = new THREE.Mesh(new THREE.PlaneGeometry(900, 200), toon(PAL.grassFar));
  far.rotation.x = -Math.PI / 2;
  far.position.set(0, -0.05, -180);
  scene.add(far);

  const city = new THREE.Group();
  scene.add(city);

  // The front wall: crenellated, running across the whole screen width.
  const wallParts: THREE.BufferGeometry[] = [];
  const wall = new THREE.BoxGeometry(160, 2.6, 1.6);
  wall.translate(0, 1.3, 1);
  wallParts.push(wall);
  for (let x = -80; x <= 80; x += 1.6) {
    const merlon = new THREE.BoxGeometry(0.8, 0.7, 1.6);
    merlon.translate(x, 2.95, 1);
    wallParts.push(merlon);
  }
  inked(city, mergeGeometries(wallParts), PAL.stone);

  // Wall towers every so often, round with conical roofs.
  for (let x = -72; x <= 72; x += 12) {
    if (Math.abs(x) < 4) continue;
    const tower = new THREE.Group();
    tower.position.set(x, 0, 1.2);
    inked(tower, new THREE.CylinderGeometry(1.4, 1.6, 4.4, 10).translate(0, 2.2, 0), PAL.stoneDark);
    inked(tower, new THREE.ConeGeometry(1.9, 2.6, 10).translate(0, 5.7, 0), x % 24 === 0 ? PAL.roofAlt : PAL.roof);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.7), flat(PAL.window));
    win.position.set(0, 3.2, 1.62);
    tower.add(win);
    city.add(tower);
  }

  // Houses behind the wall: boxes with steep gable roofs and lit windows. Seeded so the skyline is always the same.
  let s = 4242;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const houses: THREE.Mesh[] = [];
  for (let x = -78; x <= 78; x += 2.6 + rnd() * 1.4) {
    const h = 1.8 + rnd() * 1.8;
    const w = 2 + rnd() * 1.1;
    const d = 2 + rnd() * 1.2;
    const z = -2.4 - rnd() * 5;
    const house = new THREE.Group();
    house.position.set(x, 0, z);
    houses.push(inked(house, new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), rnd() > 0.5 ? PAL.stone : 0xf2e6c9));
    const roof = new THREE.CylinderGeometry(0.01, w * 0.78, 1.3 + rnd() * 0.8, 4, 1);
    roof.rotateY(Math.PI / 4);
    roof.scale(1, 1, d / w);
    roof.translate(0, h + 0.75, 0);
    inked(house, roof, rnd() > 0.25 ? PAL.roof : PAL.roofAlt);
    for (let i = 0; i < 2; i++) {
      if (rnd() < 0.35) continue;
      const win = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.55), flat(PAL.window));
      win.position.set((i - 0.5) * w * 0.45, h * (0.45 + rnd() * 0.3), d / 2 + 0.01);
      house.add(win);
    }
    city.add(house);
  }

  // Church spires and the keep, for a recognisable Transylvanian skyline.
  for (const [x, z, h] of [[-22, -7, 5.5], [26, -8, 6.5], [-48, -6, 5], [52, -7, 6]] as const) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    inked(g, new THREE.BoxGeometry(2.4, h, 2.4).translate(0, h / 2, 0), PAL.stone);
    inked(g, new THREE.ConeGeometry(1.9, 3.4, 4).rotateY(Math.PI / 4).translate(0, h + 1.7, 0), PAL.roofAlt);
    const clock = new THREE.Mesh(new THREE.CircleGeometry(0.6, 16), flat(0xfff1c1));
    clock.position.set(0, h - 1.4, 1.21);
    g.add(clock);
    city.add(g);
  }

  // The laser tower in the middle of the wall.
  const tower = new THREE.Group();
  tower.position.set(0, 0, 2.2);
  inked(tower, new THREE.CylinderGeometry(2.1, 2.5, 5, 12).translate(0, 2.5, 0), PAL.stoneDark);
  const crown: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    crown.push(new THREE.BoxGeometry(0.6, 0.7, 0.5).rotateY(-a).translate(Math.cos(a) * 2.2, 5.35, Math.sin(a) * 2.2));
  }
  inked(tower, mergeGeometries(crown), PAL.stoneDark);
  const door = new THREE.Mesh(new THREE.CircleGeometry(0.8, 16, 0, Math.PI), flat(0x3a2140));
  door.position.set(0, 0.9, 2.51);
  tower.add(door);
  scene.add(tower);

  // Turret: a swivelling base with a chunky barrel and a glowing crystal.
  const head = new THREE.Group();
  head.position.set(0, 5.9, 0);
  tower.add(head);
  inked(head, new THREE.SphereGeometry(1.2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), 0x5b6b8c);
  const barrel = new THREE.Group();
  barrel.position.y = 0.6;
  head.add(barrel);
  inked(barrel, new THREE.CylinderGeometry(0.38, 0.5, 2.6, 10).translate(0, 1.3, 0), 0x8a9bbd);
  inked(barrel, new THREE.CylinderGeometry(0.58, 0.58, 0.5, 10).translate(0, 2.4, 0), 0x5b6b8c);
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.42), flat(PAL.laser));
  crystal.position.y = 2.95;
  crystal.add(new THREE.Mesh(hullGeometry(new THREE.OctahedronGeometry(0.42)), inkMaterial()));
  barrel.add(crystal);

  // Fires on damaged houses: little flat-coloured flames that appear as health drops.
  const fires: THREE.Group[] = [];
  const fireOrder = houses.filter((h) => Math.abs(h.parent!.position.x) < 30).sort(() => rnd() - 0.5);
  for (const house of fireOrder) {
    const f = new THREE.Group();
    const p = house.parent!.position;
    const top = (house.geometry as THREE.BoxGeometry).parameters.height;
    f.position.set(p.x, top + 0.4, p.z + 1.2);
    for (const [c, sc, y] of [[0xff5a2a, 1, 0], [0xffc53d, 0.6, 0.15]] as const) {
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.7 * sc, 2 * sc, 7).translate(0, sc, 0), flat(c));
      flame.position.y = y;
      f.add(flame);
    }
    f.visible = false;
    scene.add(f);
    fires.push(f);
  }

  const tmp = new THREE.Vector3();
  return {
    head,
    muzzle(out) {
      return crystal.getWorldPosition(out);
    },
    setDamage(frac) {
      const burning = Math.round((1 - frac) * fires.length);
      fires.forEach((f, i) => (f.visible = i < burning));
    },
    update(_dt, t) {
      crystal.rotation.y = t * 2;
      for (let i = 0; i < fires.length; i++) {
        const f = fires[i];
        if (!f.visible) continue;
        tmp.set(1 + Math.sin(t * 13 + i) * 0.12, 1 + Math.sin(t * 17 + i * 2) * 0.2, 1);
        f.scale.copy(tmp);
      }
    },
  };
}
