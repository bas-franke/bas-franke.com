// Pod model, built procedurally from a PodDesign to match the concept art: two big turbine engines out front (lathe
// profiled nacelles in banded livery, dark intakes ringed with teeth, a glowing intake ring, ribbed nozzles with
// white-hot cores, claws, a raked top fin and a side flap), glowing energy binders tying them to a small armoured
// cockpit that sits between the engines' tails, with a pilot under a glass canopy and an orange tail light.
//
// Draw calls per pod: 'high'/'medium' ~12 (each engine is its own group so it can vibrate, fins and flaps are hinged
// for steering), 'low' 3 (everything merged, no hinges). Geometry is cached per design + quality and shared by every
// pod of that design; the painted surface material is shared by all pods; glow and plume materials are per pod
// because their uniforms animate.

import * as THREE from 'three';
import type { PodDesign } from '../core/pods';
import type { PodAnim, PodVisual, Quality } from '../world/types';
import { along, blade, glow, lathe, merge, mirrorX, paint, sectionPoint, surface, trs, type Band, type Paint, type Section } from './build';
import { acquireShared, createGlowMaterial, createPlumeMaterial, releaseShared } from './materials';

/** Layout of a design in pod space (metres), shared by the geometry builder and the animation. */
interface Layout {
  L: number;
  R: number;
  /** Engine centre (right engine at +x). */
  xE: number;
  zE: number;
  /** Cockpit centre. */
  yC: number;
  zC: number;
  /** Cockpit half width / half height. */
  ca: number;
  cb: number;
  /** Top fin and side flap hinges in engine-local space. */
  fin: { pos: THREE.Vector3; angle: number };
  flap: { pos: THREE.Vector3; angle: number };
}

interface PodGeometry {
  layout: Layout;
  /** Separate parts for high/medium (right engine, local); for low everything is merged into `merged*`. */
  engine?: THREE.BufferGeometry;
  engineGlow?: THREE.BufferGeometry;
  fin?: THREE.BufferGeometry;
  flap?: THREE.BufferGeometry;
  cockpit?: THREE.BufferGeometry;
  cockpitGlow?: THREE.BufferGeometry;
  canopy?: THREE.BufferGeometry;
  merged?: THREE.BufferGeometry;
  mergedGlow?: THREE.BufferGeometry;
  plume: THREE.BufferGeometry;
  users: number;
}

const cache = new Map<string, PodGeometry>();

const SEGS: Record<Quality, number> = { high: 40, medium: 28, low: 18 };

function layoutOf(design: PodDesign): Layout {
  const { engineLength: L, engineRadius: R, engineSpread, cockpitLength: C, cockpitTrail: T } = design.shape;
  // The concept art has the cockpit sitting between the engines' tails (seen from the chase camera it is a little
  // further away than the nozzles), not far behind them, so the design's trail only nudges it back.
  const trail = 0.25 * L + 0.1 * T;
  const zE = -(trail + C / 2 - L / 2) / 2;
  const ca = 0.55 + 0.3 * R;
  return {
    L,
    R,
    xE: engineSpread / 2,
    zE,
    yC: 0.32,
    zC: zE + trail,
    ca,
    cb: ca * 0.84,
    fin: { pos: new THREE.Vector3(), angle: Math.PI * 0.42 },
    flap: { pos: new THREE.Vector3(), angle: -0.12 },
  };
}

/** Colours of a design as paints. */
function palette(design: PodDesign) {
  const { primary, secondary, accent } = design.livery;
  // Filmic tone mapping washes out bright saturated paint; push livery colours a little richer to compensate.
  const rich = (hex: string, metal: number, rough: number) => {
    const p = paint(hex, metal, rough);
    const hsl = { h: 0, s: 0, l: 0 };
    p.c.getHSL(hsl);
    p.c.setHSL(hsl.h, Math.min(1, hsl.s * 1.15), hsl.l * (hsl.l > 0.8 ? 0.94 : 0.85));
    return p;
  };
  return {
    P: rich(primary, 0.06, 0.5),
    S: rich(secondary, 0.06, 0.45),
    A: paint(accent, 0.55, 0.4),
    M: paint('#4a4c52', 0.85, 0.34),
    D: paint('#24252a', 0.75, 0.42),
    Dk: paint('#141418', 0.6, 0.55),
    helmet: paint('#e9e3d8', 0.1, 0.35),
    suit: paint('#5b4634', 0.0, 0.8),
    glass: paint('#14202a', 0.9, 0.08),
  };
}

/** Painted hull with slightly varied panels so big areas don't read as one flat colour. */
function panels(base: Paint, under: Paint, seed: number) {
  const cache = new Map<number, Paint>();
  return (angle: number, z: number): Paint => {
    if (angle < -Math.PI * 0.3 && angle > -Math.PI * 0.7) return under;
    const sector = Math.floor((angle + Math.PI) / (Math.PI / 4));
    const row = Math.floor(z / 0.9);
    const key = sector * 1000 + row;
    let p = cache.get(key);
    if (!p) {
      const h = Math.sin((sector * 12.9898 + row * 78.233 + seed) * 43758.5453);
      const k = 0.9 + 0.1 * (h - Math.floor(h));
      p = { c: base.c.clone().multiplyScalar(k), metal: base.metal, rough: base.rough };
      cache.set(key, p);
    }
    return p;
  };
}

/** Right engine in engine-local space (nose at -z, outboard +x). Returns the painted surface and its glow parts. */
function buildEngine(design: PodDesign, lay: Layout, segs: number, pal: ReturnType<typeof palette>, glowCol: THREE.Color) {
  const { L, R } = lay;
  const w = design.shape.wedge;
  const sec: Section = { n: 2 + 2.6 * w, sx: 1, sy: 1 - 0.28 * w };
  const Z = (f: number) => -L / 2 + f * L;
  const { P, S, M, D, Dk } = pal;
  const hull = panels(P, D, 1);
  const bands: Band[] = [
    // Intake throat from deep inside out to the lip, the lip, then the banded nacelle back to the nozzle.
    { pts: [[Z(0.13), 0.42 * R], [Z(0.07), 0.66 * R], [Z(0.015), 0.8 * R], [Z(0), 0.84 * R]], paint: Dk },
    { pts: [[Z(0), 0.84 * R], [Z(-0.012), 0.88 * R], [Z(-0.006), 0.93 * R], [Z(0.012), 0.95 * R]], paint: M },
    { pts: [[Z(0.012), 0.95 * R], [Z(0.06), 1.0 * R], [Z(0.15), 1.04 * R]], paint: hull },
    { pts: [[Z(0.15), 1.04 * R], [Z(0.155), 1.07 * R], [Z(0.265), 1.07 * R], [Z(0.27), 1.04 * R]], paint: S },
    { pts: [[Z(0.27), 1.04 * R], [Z(0.4), 1.035 * R], [Z(0.5), 1.02 * R]], paint: hull },
    { pts: [[Z(0.5), 1.02 * R], [Z(0.505), 0.95 * R], [Z(0.565), 0.95 * R], [Z(0.57), 1.02 * R]], paint: D },
    { pts: [[Z(0.57), 1.02 * R], [Z(0.575), 1.06 * R], [Z(0.74), 1.06 * R], [Z(0.745), 1.02 * R]], paint: S },
    { pts: [[Z(0.745), 1.02 * R], [Z(0.83), 1.0 * R]], paint: hull },
  ];
  // Ribbed nozzle housing: each rib its own band so the steps stay crisp.
  let z0 = 0.83;
  for (let k = 0; k < 4; k++) {
    const p = k % 2 ? M : D;
    bands.push({ pts: [[Z(z0), 1.0 * R], [Z(z0 + 0.004), 0.95 * R]], paint: p });
    bands.push({ pts: [[Z(z0 + 0.004), 0.95 * R], [Z(z0 + 0.018), 0.95 * R]], paint: p });
    bands.push({ pts: [[Z(z0 + 0.018), 0.95 * R], [Z(z0 + 0.022), 1.0 * R]], paint: p });
    z0 += 0.022;
  }
  bands.push({ pts: [[Z(z0), 1.0 * R], [Z(0.95), 0.97 * R], [Z(1.0), 0.88 * R]], paint: M });
  bands.push({ pts: [[Z(1.0), 0.88 * R], [Z(1.0), 0.75 * R]], paint: D });
  bands.push({ pts: [[Z(1.0), 0.75 * R], [Z(0.96), 0.69 * R], [Z(0.9), 0.64 * R]], paint: Dk });
  const parts: THREE.BufferGeometry[] = [lathe(bands, segs, sec)];

  const radial = (a: number) => new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
  const onSurface = (a: number, r: number, z: number) => {
    const [x, y] = sectionPoint(a, r, sec);
    return new THREE.Vector3(x, y, z);
  };
  const back = new THREE.Vector3(0, 0, 1);

  // Fan: a spinner and swept blades deep in the intake.
  const hub = new THREE.ConeGeometry(0.27 * R, 0.16 * L, Math.max(8, segs / 2), 1);
  parts.push(surface(hub, M, trs(0, 0, Z(0.11), -Math.PI / 2, 0, 0)));
  hub.dispose();
  const disk = new THREE.CircleGeometry(0.5 * R, Math.max(8, segs / 2));
  parts.push(surface(disk, Dk, trs(0, 0, Z(0.135), 0, Math.PI, 0)));
  disk.dispose();
  const bladeBox = new THREE.BoxGeometry(0.12 * R, 0.42 * R, 0.02 * L);
  const blades = segs >= 28 ? 14 : 8;
  for (let i = 0; i < blades; i++) {
    const m = new THREE.Matrix4()
      .makeRotationZ((i / blades) * Math.PI * 2)
      .multiply(trs(0, 0.47 * R, Z(0.12)))
      .multiply(new THREE.Matrix4().makeRotationY(0.6));
    parts.push(surface(bladeBox, i % 2 ? M : D, m));
  }
  bladeBox.dispose();

  // Teeth around the intake lip, pointing forwards.
  const teeth = design.shape.fins * 2 + 1;
  for (let i = 0; i < teeth; i++) {
    const a = Math.PI / 2 + ((i + 0.5) / teeth) * Math.PI * 2;
    const { geo, m } = blade(
      [[0.1 * L, 0], [0.03 * L, 0.11 * R], [-0.09 * L, 0.17 * R], [-0.01 * L, -0.03 * R]],
      0.1 + 0.05 * R,
      back,
      radial(a),
      onSurface(a, 0.97 * R, Z(0)),
    );
    parts.push(surface(geo, i % 2 ? M : D, m));
    geo.dispose();
  }

  // Big claws raking back past the nozzle (the concept art's spikes), on the outer and lower side.
  const clawAngles: Record<number, number[]> = { 2: [-0.5, -2.6], 3: [0.35, -0.9, -2.3], 4: [0.45, -0.6, -1.75, -2.75] };
  for (const a of clawAngles[design.shape.fins] ?? clawAngles[3]) {
    const { geo, m } = blade(
      [[0, 0], [0.14 * L, 0.16 * R], [0.3 * L, 0.27 * R], [0.47 * L, 0.5 * R], [0.37 * L, 0.22 * R], [0.33 * L, -0.02 * R], [0.05 * L, -0.04 * R]],
      0.1 + 0.04 * R,
      back,
      radial(a),
      onSurface(a, 0.98 * R, Z(0.6)),
    );
    parts.push(surface(geo, (c) => (c.y > 0.3 * R ? S : D), m));
    geo.dispose();
  }

  // Binder mounts on the inboard side and pipes along the belly.
  const mountBox = new THREE.BoxGeometry(0.34 * R, 0.4 * R, 0.17 * L);
  for (const [a, f] of [
    [Math.PI * 0.86, 0.32],
    [Math.PI * 1.15, 0.66],
  ]) {
    const p = onSurface(a, 1.02 * R, Z(f));
    parts.push(surface(mountBox, D, trs(p.x, p.y, p.z, 0, 0, a), 0.5));
  }
  const pipe = new THREE.CylinderGeometry(0.05 + 0.02 * R, 0.05 + 0.02 * R, 0.62 * L, 6);
  for (const a of [-Math.PI * 0.38, -Math.PI * 0.62]) {
    const p = onSurface(a, 1.06 * R, Z(0.49));
    parts.push(surface(pipe, M, trs(p.x, p.y, p.z, Math.PI / 2, 0, 0)));
  }
  pipe.dispose();
  // Armour plates bolted on the top front and outboard side.
  const plate = new THREE.BoxGeometry(0.55 * R, 0.08, 0.2 * L);
  for (const a of [Math.PI * 0.5, Math.PI * 0.12]) {
    const p = onSurface(a, 1.08 * R, Z(0.4));
    parts.push(surface(plate, (c) => (Math.abs(c.x) > 0.18 * R ? S : P), trs(p.x, p.y, p.z, 0, 0, a - Math.PI / 2), 0.5));
  }
  plate.dispose();

  // Hinges for the top fin and side flap (animated separately at high quality).
  lay.fin.pos.copy(onSurface(lay.fin.angle, 0.97 * R, Z(0.58)));
  lay.flap.pos.copy(onSurface(lay.flap.angle, 0.98 * R, Z(0.56)));
  const fin = blade([[0, 0], [0.3 * L, 0], [0.4 * L, 0.95 * R], [0.22 * L, 1.0 * R]], 0.07, back, radial(lay.fin.angle), new THREE.Vector3());
  const finGeo = surface(fin.geo, (c) => (c.y > 0.66 * R ? S : c.y > 0.58 * R ? D : M), fin.m);
  fin.geo.dispose();
  const flap = blade([[0, 0], [0.32 * L, 0], [0.38 * L, 0.5 * R], [0.14 * L, 0.55 * R]], 0.06, back, radial(lay.flap.angle), new THREE.Vector3());
  const flapGeo = surface(flap.geo, (c) => (c.y > 0.36 * R ? S : P), flap.m);
  flap.geo.dispose();

  // Glow: intake ring, nozzle core disk and the bright nozzle rim.
  const glows: THREE.BufferGeometry[] = [];
  const ringIn = new THREE.TorusGeometry(0.8 * R, 0.035 * R, 6, segs);
  glows.push(glow(ringIn, glowCol, 3, trs(0, 0, Z(0.02), 0, 0, 0, sec.sx, sec.sy, 1)));
  ringIn.dispose();
  const core = new THREE.CircleGeometry(0.66 * R, segs);
  glows.push(glow(core, glowCol, 2, trs(0, 0, Z(0.905), 0, 0, 0, sec.sx, sec.sy, 1)));
  core.dispose();
  const rim = new THREE.TorusGeometry(0.76 * R, 0.05 * R, 6, segs);
  glows.push(glow(rim, glowCol, 4, trs(0, 0, Z(0.998), 0, 0, 0, sec.sx, sec.sy, 1)));
  rim.dispose();

  return { surface: merge(parts), glow: merge(glows), fin: finGeo, flap: flapGeo, sec };
}

/** Cockpit, canopy, pilot, binders and cables in pod space. */
function buildCockpit(design: PodDesign, lay: Layout, segs: number, pal: ReturnType<typeof palette>, glowCol: THREE.Color, sec: Section) {
  const { P, S, M, D, Dk, helmet, suit } = pal;
  const C = design.shape.cockpitLength;
  const { ca: a, cb: b, yC, zC } = lay;
  const cs: Section = { n: 2.4 + 1.4 * design.shape.wedge, sx: a, sy: b };
  const Z = (f: number) => zC - C / 2 + f * C;
  const shell = (ang: number, z: number): Paint => {
    if (Math.sin(ang) < -0.35) return D;
    if (Math.abs(ang - Math.PI / 2) < 0.3) return S;
    if ((Math.abs(ang) < 0.22 || Math.abs(Math.abs(ang) - Math.PI) < 0.22) && z < Z(0.62) && z > Z(0.2)) return S;
    return P;
  };
  const cseg = Math.max(12, Math.round(segs * 0.8));
  const parts: THREE.BufferGeometry[] = [];
  const body = lathe(
    [
      { pts: [[Z(0), 0], [Z(0.015), 0.3], [Z(0.07), 0.6], [Z(0.18), 0.84], [Z(0.32), 0.97], [Z(0.5), 1.0], [Z(0.7), 0.98]], paint: shell },
      { pts: [[Z(0.7), 0.98], [Z(0.705), 0.92], [Z(0.76), 0.92], [Z(0.765), 0.97]], paint: D },
      { pts: [[Z(0.765), 0.97], [Z(0.88), 0.86], [Z(0.96), 0.66], [Z(1.0), 0.48]], paint: shell },
      { pts: [[Z(1.0), 0.48], [Z(1.0) + 0.05 * C, 0.3], [Z(1.0) + 0.07 * C, 0.0]], paint: D },
    ],
    cseg,
    cs,
  );
  body.translate(0, yC, 0);
  parts.push(body);

  // Canopy rim, pilot (helmet + shoulders), keel, side mounts, tail grille and two little stabilisers.
  const canZ = Z(0.38);
  const canY = yC + 0.68 * b;
  const rimG = new THREE.TorusGeometry(1, 0.07, 4, cseg);
  parts.push(surface(rimG, M, trs(0, canY, canZ, Math.PI / 2, 0, 0, 0.5 * a, 0.3 * C, 1)));
  rimG.dispose();
  const head = new THREE.SphereGeometry(0.19, 12, 8);
  parts.push(surface(head, helmet, trs(0, canY + 0.26, canZ + 0.05)));
  head.dispose();
  const shoulders = new THREE.BoxGeometry(0.5, 0.22, 0.3);
  parts.push(surface(shoulders, suit, trs(0, canY + 0.04, canZ + 0.1)));
  shoulders.dispose();
  const keel = new THREE.BoxGeometry(0.55 * a, 0.3 * b, 0.5 * C);
  parts.push(surface(keel, Dk, trs(0, yC - 0.88 * b, Z(0.55)), 0.5));
  keel.dispose();
  const mount = new THREE.BoxGeometry(0.3, 0.5, 0.5);
  for (const s of [-1, 1]) parts.push(surface(mount, D, trs(s * (a + 0.08), yC, Z(0.5)), 0.5));
  mount.dispose();
  const slat = new THREE.BoxGeometry(0.75 * a, 0.05, 0.1);
  for (let i = 0; i < 3; i++) parts.push(surface(slat, M, trs(0, yC - (0.05 + i * 0.13) * b, Z(1.0) + 0.06 * C - 0.02 * i)));
  slat.dispose();
  for (const s of [-1, 1]) {
    const { geo, m } = blade(
      [[0, 0], [0.32 * C, 0], [0.42 * C, 0.42], [0.22 * C, 0.4]],
      0.05,
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(s * 0.55, 0.83, 0),
      new THREE.Vector3(s * 0.45 * a, yC + 0.75 * b, Z(0.6)),
    );
    parts.push(surface(geo, (c) => (c.y > 0.28 ? S : D), m));
    geo.dispose();
  }

  // Binders: two per side from the cockpit mounts to the engines' inboard mounts, and one between the engines.
  const glows: THREE.BufferGeometry[] = [];
  const binderCol = new THREE.Color('#4feaff').lerp(glowCol, 0.3);
  const L = lay.L;
  const R = lay.R;
  const engZ = (f: number) => lay.zE - L / 2 + f * L;
  const engPt = (s: number, ang: number, f: number) => {
    const [x, y] = sectionPoint(ang, 1.18 * R, sec);
    return new THREE.Vector3(s * (lay.xE + x), y, engZ(f));
  };
  const beam = new THREE.CylinderGeometry(0.11, 0.11, 1, 8, 1, true);
  const thin = new THREE.CylinderGeometry(0.05, 0.05, 1, 6, 1, true);
  const clamp = new THREE.CylinderGeometry(0.17, 0.17, 1, 8);
  const links: [THREE.Vector3, THREE.Vector3, THREE.BufferGeometry][] = [];
  for (const s of [-1, 1]) {
    links.push([new THREE.Vector3(s * (a + 0.2), yC + 0.14, Z(0.42)), engPt(s, Math.PI * 0.86, 0.32), beam]);
    links.push([new THREE.Vector3(s * (a + 0.2), yC - 0.16, Z(0.6)), engPt(s, Math.PI * 1.15, 0.66), beam]);
  }
  links.push([engPt(-1, Math.PI - 0.06, 0.2), engPt(1, Math.PI - 0.06, 0.2), thin]);
  for (const [p, q, g] of links) {
    const d = q.clone().sub(p).normalize();
    glows.push(glow(g, binderCol, 1, along(p.clone().addScaledVector(d, 0.12), q.clone().addScaledVector(d, -0.12))));
    parts.push(surface(clamp, D, along(p.clone().addScaledVector(d, -0.05), p.clone().addScaledVector(d, 0.3))));
    parts.push(surface(clamp, D, along(q.clone().addScaledVector(d, -0.3), q.clone().addScaledVector(d, 0.05))));
  }
  beam.dispose();
  thin.dispose();
  clamp.dispose();

  // Steering cables from the cockpit nose to the engine tops, sagging a little.
  if (segs >= 28) {
    for (const s of [-1, 1]) {
      const p = new THREE.Vector3(s * 0.22, yC + 0.55 * b, Z(0.08));
      const q = engPt(s, Math.PI * 0.62, 0.42);
      const mid = p.clone().add(q).multiplyScalar(0.5).add(new THREE.Vector3(0, -0.35, 0));
      const tube = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(p, mid, q), 12, 0.03, 4, false);
      parts.push(surface(tube, Dk, undefined, 0.2));
      tube.dispose();
    }
  }

  // Orange tail light and the pilot's visor.
  const orange = new THREE.Color('#ff6a1f');
  // Tail light: a slit across the top of the dark back plate, under the white dome.
  const tail = new THREE.BoxGeometry(0.5 * a, 0.09, 0.12);
  glows.push(glow(tail, orange, 0, trs(0, yC + 0.36 * b, Z(1.0) + 0.03 * C)));
  tail.dispose();
  const visor = new THREE.BoxGeometry(0.26, 0.07, 0.06);
  glows.push(glow(visor, new THREE.Color('#ff9a40'), 0, trs(0, canY + 0.26, canZ - 0.13)));
  visor.dispose();

  const canopy = new THREE.SphereGeometry(1, cseg, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  canopy.applyMatrix4(trs(0, canY, canZ, 0, 0, 0, 0.5 * a, 0.62 * b, 0.3 * C));
  return { surface: merge(parts), glow: merge(glows), canopy };
}

/** Exhaust plumes (outer + hot core cones) and nozzle halos for both engines, in pod space. */
function buildPlume(lay: Layout, sec: Section, segs: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const kind: number[] = [];
  const eng: number[] = [];
  const idx: number[] = [];
  const radial = Math.max(10, Math.round(segs * 0.5));
  const rings = 10;
  const { R, L } = lay;
  for (const [e, s] of [
    [0, -1],
    [1, 1],
  ]) {
    const cx = s * lay.xE;
    const cz = lay.zE + L / 2 - 0.08 * L;
    const cones: [number, (t: number) => number][] = [
      [0, (t) => R * (0.7 + 0.12 * Math.sin(Math.min(1, t * 3) * Math.PI * 0.5) - 0.3 * t)],
      [1, (t) => R * 0.42 * (1 - 0.65 * t)],
    ];
    for (const [k, rad] of cones) {
      const base = pos.length / 3;
      for (let j = 0; j <= rings; j++) {
        const t = j / rings;
        for (let i = 0; i <= radial; i++) {
          const a = (i / radial) * Math.PI * 2;
          const [x, y] = sectionPoint(a, rad(t), sec);
          pos.push(cx + x, y, cz);
          nrm.push(Math.cos(a), Math.sin(a), 0);
          uv.push(i / radial, t);
          kind.push(k);
          eng.push(e);
        }
      }
      for (let j = 0; j < rings; j++) {
        for (let i = 0; i < radial; i++) {
          const a = base + j * (radial + 1) + i;
          const b = a + radial + 1;
          idx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }
    const base = pos.length / 3;
    for (const [u, v] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]) {
      pos.push(cx, 0, lay.zE + L / 2 + 0.25);
      nrm.push(0, 0, 1);
      uv.push(u, v);
      kind.push(2);
      eng.push(e);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
  g.setAttribute('aEngine', new THREE.Float32BufferAttribute(eng, 1));
  g.setIndex(idx);
  // The shader stretches plumes far behind the pod: give it bounds that cover the longest boost plume.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, lay.zE + L / 2 + 10), lay.xE + 14);
  return g;
}

function getGeometry(design: PodDesign, quality: Quality): PodGeometry {
  const key = `${design.id}:${quality}`;
  let pg = cache.get(key);
  if (pg) {
    pg.users++;
    return pg;
  }
  const lay = layoutOf(design);
  const segs = SEGS[quality];
  const pal = palette(design);
  const glowCol = nozzleColour(design.livery.glow);
  const eng = buildEngine(design, lay, segs, pal, glowCol);
  const ck = buildCockpit(design, lay, segs, pal, new THREE.Color(design.livery.glow), eng.sec);
  const plume = buildPlume(lay, eng.sec, segs);
  if (quality === 'low') {
    // Bake both engines, the fins and flaps into one mesh; the canopy becomes glossy dark paint.
    const place = (g: THREE.BufferGeometry, m: THREE.Matrix4) => g.clone().applyMatrix4(m);
    const right = new THREE.Matrix4().makeTranslation(lay.xE, 0, lay.zE);
    const finM = right.clone().multiply(new THREE.Matrix4().makeTranslation(lay.fin.pos.x, lay.fin.pos.y, lay.fin.pos.z));
    const flapM = right.clone().multiply(new THREE.Matrix4().makeTranslation(lay.flap.pos.x, lay.flap.pos.y, lay.flap.pos.z));
    const rEngine = merge([place(eng.surface, right), place(eng.fin, finM), place(eng.flap, flapM)]);
    const canopy = surface(ck.canopy, pal.glass);
    const merged = merge([mirrorX(rEngine), rEngine, ck.surface, canopy]);
    const rGlow = place(eng.glow, right);
    const mergedGlow = merge([mirrorX(rGlow), rGlow, ck.glow]);
    for (const g of [eng.surface, eng.fin, eng.flap, ck.canopy, eng.glow]) g.dispose();
    pg = { layout: lay, merged, mergedGlow, plume, users: 1 };
  } else {
    pg = {
      layout: lay,
      engine: eng.surface,
      engineGlow: eng.glow,
      fin: eng.fin,
      flap: eng.flap,
      cockpit: ck.surface,
      cockpitGlow: ck.glow,
      canopy: ck.canopy,
      plume,
      users: 1,
    };
  }
  cache.set(key, pg);
  return pg;
}

function releaseGeometry(design: PodDesign, quality: Quality) {
  const key = `${design.id}:${quality}`;
  const pg = cache.get(key);
  if (!pg || --pg.users > 0) return;
  for (const g of [pg.engine, pg.engineGlow, pg.fin, pg.flap, pg.cockpit, pg.cockpitGlow, pg.canopy, pg.merged, pg.mergedGlow, pg.plume]) g?.dispose();
  cache.delete(key);
}

/** Engine fire colour: cool glows lean a little bluer than the binders (cyan binders, azure nozzles in the art). */
function nozzleColour(glowHex: string): THREE.Color {
  const c = new THREE.Color(glowHex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  if (hsl.h > 0.42 && hsl.h < 0.62) c.setHSL(hsl.h + 0.045, Math.min(1, hsl.s * 1.1), hsl.l * 0.95);
  return c;
}

/** Exhaust colours from the livery glow: a white-hot core, the glow colour, and a tail shifted towards violet (cool
 *  glows) or red (warm glows), like the blue-to-violet plumes in the concept art. */
function exhaustColours(glowHex: string): [THREE.Color, THREE.Color, THREE.Color] {
  const mid = nozzleColour(glowHex);
  const hsl = { h: 0, s: 0, l: 0 };
  mid.getHSL(hsl);
  const warm = hsl.h < 0.2 || hsl.h > 0.9;
  const tail = new THREE.Color().setHSL((hsl.h + (warm ? -0.05 : 0.16) + 1) % 1, Math.min(1, hsl.s * 1.05), hsl.l * 0.85);
  const core = mid.clone().lerp(new THREE.Color('#ffffff'), 0.65);
  return [core, mid, tail];
}

export function createPod(design: PodDesign, quality: Quality = 'high'): PodVisual {
  const pg = getGeometry(design, quality);
  const shared = acquireShared();
  const lay = pg.layout;
  const root = new THREE.Group();
  root.name = `pod:${design.id}`;
  const glowMat = createGlowMaterial();
  const plumeMat = createPlumeMaterial(...exhaustColours(design.livery.glow));
  const solid = (g: THREE.BufferGeometry, m: THREE.Material = shared.surface) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  const engines: THREE.Group[] = [];
  const fins: THREE.Object3D[] = [];
  const flaps: THREE.Object3D[] = [];
  if (pg.merged) {
    root.add(solid(pg.merged));
    root.add(new THREE.Mesh(pg.mergedGlow, glowMat));
  } else {
    for (const s of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(s * lay.xE, 0, lay.zE);
      // The left engine is the right one mirrored; three flips the face winding for negative scale.
      g.scale.x = s;
      g.add(solid(pg.engine!));
      g.add(new THREE.Mesh(pg.engineGlow!, glowMat));
      const fin = new THREE.Group();
      fin.position.copy(lay.fin.pos);
      fin.add(solid(pg.fin!));
      const flap = new THREE.Group();
      flap.position.copy(lay.flap.pos);
      flap.add(solid(pg.flap!));
      g.add(fin, flap);
      fins.push(fin);
      flaps.push(flap);
      engines.push(g);
      root.add(g);
    }
    root.add(solid(pg.cockpit!));
    root.add(new THREE.Mesh(pg.cockpitGlow!, glowMat));
    const canopy = new THREE.Mesh(pg.canopy!, shared.glass);
    canopy.renderOrder = 1;
    root.add(canopy);
  }
  const plume = new THREE.Mesh(pg.plume, plumeMat);
  plume.renderOrder = 2;
  root.add(plume);

  const nozzles: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const n = new THREE.Object3D();
    n.name = 'nozzle';
    n.position.set(s * lay.xE, 0, lay.zE + lay.L / 2);
    root.add(n);
    nozzles.push(n);
  }

  // Smoothed animation state.
  let thr = 0;
  let boost = 0;
  let surge = 0;
  let steer = 0;
  const seed = Math.random() * 100;
  const gu = glowMat.uniforms;
  const pu = plumeMat.uniforms;

  return {
    object: root,
    nozzles,
    update(anim: PodAnim) {
      const { dt, time } = anim;
      const k = 1 - Math.exp(-dt * 6);
      thr += (anim.throttle - thr) * k;
      steer += (anim.steer - steer) * (1 - Math.exp(-dt * 8));
      boost += ((anim.boosting ? 1 : 0) - boost) * (1 - Math.exp(-dt * (anim.boosting ? 8 : 3)));
      surge += ((anim.surge > 0 ? 1 : 0) - surge) * (1 - Math.exp(-dt * 6));
      const sp = Math.min(1.4, Math.max(0, anim.speed01));
      const t = time + seed;
      const power = 0.35 + 0.65 * thr + 0.6 * boost + 0.35 * surge;
      const flick = 1 + 0.05 * Math.sin(t * 41) + 0.03 * Math.sin(t * 67);
      const len = lay.L * (0.45 + 0.75 * thr + 0.3 * sp) * (1 + 0.85 * boost + 0.45 * surge) * flick;
      pu.uTime.value = t;
      pu.uLen.value.set(len * (1 - steer * 0.08), len * (1 + steer * 0.08));
      pu.uPower.value.set(power, power);
      pu.uHalo.value = lay.R * (2.2 + 1.2 * boost + 0.5 * surge);
      pu.uBoost.value = boost;
      gu.uTime.value = t;
      gu.uPulse.value = 0.5 + 0.5 * Math.sin(t * (4 + 9 * sp));
      gu.uPower.value = power;
      gu.uBoost.value = Math.max(boost, surge * 0.7);

      if (engines.length) {
        // Engines shake against their binders at speed, each on its own rhythm.
        const amp = 0.006 + 0.022 * sp + 0.02 * boost;
        engines.forEach((g, i) => {
          const s = i ? 1 : -1;
          const ph = t * (57 + i * 6) + i * 2;
          g.position.set(s * lay.xE + Math.sin(ph) * amp, Math.sin(ph * 1.31 + 1) * amp, lay.zE + Math.sin(ph * 0.7) * amp * 0.5);
          g.rotation.z = Math.sin(ph * 0.53) * amp * 0.25;
        });
        // Top fins lean into the turn; side flaps act as spoilers (inner one up) and air brakes off throttle.
        const brake = (1 - thr) * 0.35;
        fins[0].rotation.z = steer * 0.32;
        fins[1].rotation.z = -steer * 0.32;
        flaps[0].rotation.z = 0.1 + brake + Math.max(0, -steer) * 0.55 - Math.max(0, steer) * 0.15;
        flaps[1].rotation.z = 0.1 + brake + Math.max(0, steer) * 0.55 - Math.max(0, -steer) * 0.15;
      }
    },
    dispose() {
      glowMat.dispose();
      plumeMat.dispose();
      releaseGeometry(design, quality);
      releaseShared();
    },
  };
}
