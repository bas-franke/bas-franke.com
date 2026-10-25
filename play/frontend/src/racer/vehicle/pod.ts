// Pod model, built procedurally from a PodDesign to match the concept art: two big turbine engines out front (lathe
// profiled nacelles in banded livery, dark intakes ringed with teeth, a glowing intake ring, ribbed nozzles with
// white-hot cores, claws, a raked top fin and a side flap), glowing energy binders tying them to a small armoured
// cockpit that sits between the engines' tails, with a pilot under a glass canopy and an orange tail light.
//
// Every destructible part (core/damage.ts PartId) is its own object so it can be damaged, dented and broken off on
// its own: scorched plates appear near the parts that took damage, fins bend, flaps hang, intake rings and the tail
// light flicker, binders thin and flicker, cables droop, the canopy cracks, a hurt engine sags and its exhaust
// sputters. The nacelles' armour plates buckle outwards and then peel up from their leading edge, the intake fans
// lose and bend blades and spin down (a broken fan jams), the nozzle petals flare and drop out, the antenna bends back
// and the canopy frame skews. Broken parts are hidden, or handed to the debris system by breakOff. Under a part that
// can come off there is a dark filler (a gutted intake socket, a nozzle back plate, a nose bulkhead) so the pod stays
// closed.
//
// Draw calls per pod: 'high'/'medium' ~52 (per engine: nacelle, intake + ring, fan, claws, fin, flap, nozzle + glow,
// petals, four armour plates; the cockpit's shell, visor, nose, canopy frame, canopy, antenna + tip light, two mounts,
// two stabilisers, tail + light; three binders of clamps and beams; two cables; the plumes). The fans, petals and
// antenna cast no shadow (they are small, or inside the engine). 'low' ~8: each engine and the cockpit are one merged
// mesh + one glow mesh, so only the nacelles, the centre binder and the hull are separate parts; the other parts only
// show through scars and sputter there. Geometry is cached per design + quality and shared by every pod of that design
// (a dent, or a fan or petal ring losing pieces, clones the part's geometry for that pod only); the painted surface
// material is shared by all pods; glow and plume materials are per pod because their uniforms animate.

import * as THREE from 'three';
import { PART_IDS, PARTS, partAnchors, type PartId } from '../core/damage';
import type { PodDesign } from '../core/pods';
import type { PodAnim, PodVisual, Quality } from '../world/types';
import {
  along, blade, glow, lathe, merge, morphBy, paint, sectionPoint, shellPanel, surface, trs, unmorphed,
  type Band, type Paint, type PanelSpan, type Section,
} from './build';
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
  /**
   * Armour plates (engine-local): where each lies, its hinge (the middle of its trailing edge, where it stays bolted on
   * longest) and the axis it peels up about.
   */
  arm: Record<ArmKind, { span: PanelSpan; pos: THREE.Vector3; axis: THREE.Vector3 }>;
  /** The fan's hub (engine-local); the canopy frame's and the antenna's pivots (pod space). */
  fan: THREE.Vector3;
  frame: THREE.Vector3;
  antenna: THREE.Vector3;
}

type ArmKind = 'Top' | 'Out' | 'In' | 'Belly';
const ARM_KINDS: ArmKind[] = ['Top', 'Out', 'In', 'Belly'];

/** A part made of equal pieces that drop out one by one (fan blades, nozzle petals): `lead` vertices, then `n` x `per`. */
interface Spokes {
  lead: number;
  per: number;
  n: number;
}

/** A binder beam: unit cylinder glow (`thin` = the centre binder's) placed by `m`. */
interface Link {
  thin: boolean;
  m: THREE.Matrix4;
}

type BinderId = 'binderL' | 'binderR' | 'binderMid';

interface PodGeometry {
  layout: Layout;
  /**
   * Painted surfaces by name. Engine parts (nacelle, intake, claws, nozzle, fin, flap) are the right engine in
   * engine-local space (fin and flap relative to their hinges); the rest (hull, cockpitNose, stabL/R, tail, cableL/R
   * and the binders' clamps) are in pod space. On 'low' only `nacelle` (the whole engine) and `hull` (the cockpit,
   * canopy and clamps) exist.
   */
  surf: Partial<Record<string, THREE.BufferGeometry>>;
  /** Glow by name: intake, nozzle (engine-local), hull (visor), tail; on 'low' engine and hull hold everything. */
  glow: Partial<Record<string, THREE.BufferGeometry>>;
  canopy?: THREE.BufferGeometry;
  /** Binder beams (high/medium): shared unit cylinders and where each binder's beams go. */
  beam?: THREE.BufferGeometry;
  thinBeam?: THREE.BufferGeometry;
  links?: Record<BinderId, Link[]>;
  plume: THREE.BufferGeometry;
  /** How the fan and petal geometry is laid out (high/medium). */
  spokes: Partial<Record<'fan' | 'petals', Spokes>>;
  users: number;
}

const cache = new Map<string, PodGeometry>();

const SEGS: Record<Quality, number> = { high: 40, medium: 28, low: 18 };
/** Longest lathe profile step (m) on the dentable skins, by segment count; 'low' keeps its coarse rings. */
const DENT_STEP: Record<number, number> = { 40: 0.2, 28: 0.3 };

function layoutOf(design: PodDesign): Layout {
  const { engineLength: L, engineRadius: R, engineSpread, cockpitLength: C, cockpitTrail: T } = design.shape;
  // The concept art has the cockpit sitting between the engines' tails (seen from the chase camera it is a little
  // further away than the nozzles), not far behind them, so the design's trail only nudges it back.
  // Keep in step with core/damage.ts podLayout: the damage model places its part anchors with the same maths.
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
    arm: {} as Layout['arm'],
    fan: new THREE.Vector3(),
    frame: new THREE.Vector3(),
    antenna: new THREE.Vector3(),
  };
}

/**
 * How far (m) a buckled armour plate bows out at (u across, v along it, 0..1): a crumpled bulge over the middle and the
 * leading edge lifting into the airflow. The plate's morph target holds this; its scars ride out with it.
 */
function plateBulge(u: number, v: number): number {
  const bow = Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v * 1.15));
  const crumple = 0.7 + 0.3 * Math.sin(u * 9.7 + v * 5.3) * Math.sin(v * 7.1 - u * 3.3);
  return 0.1 * bow * crumple + 0.07 * (1 - v) * (1 - v);
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

/**
 * Right engine in engine-local space (nose at -z, outboard +x), split into its breakable parts: nacelle (the body,
 * mounts, pipes, rear spikes and the fillers left behind when the intake or nozzle comes off), intake (throat and lip),
 * fan (hub and blades, relative to its hub), claws (the teeth round the lip), nozzle, petals (the ring round the
 * exhaust), four armour plates (each relative to its hinge) and the hinged fin and flap.
 */
function buildEngine(design: PodDesign, lay: Layout, segs: number, pal: ReturnType<typeof palette>, glowCol: THREE.Color) {
  const { L, R } = lay;
  const w = design.shape.wedge;
  const sec: Section = { n: 2 + 2.6 * w, sx: 1, sy: 1 - 0.28 * w };
  const Z = (f: number) => -L / 2 + f * L;
  const { P, S, M, D, Dk } = pal;
  const hull = panels(P, D, 1);
  // Intake throat from deep inside out to the lip, and the lip.
  const intakeBands: Band[] = [
    { pts: [[Z(0.13), 0.42 * R], [Z(0.07), 0.66 * R], [Z(0.015), 0.8 * R], [Z(0), 0.84 * R]], paint: Dk },
    { pts: [[Z(0), 0.84 * R], [Z(-0.012), 0.88 * R], [Z(-0.006), 0.93 * R], [Z(0.012), 0.95 * R]], paint: M },
  ];
  // The banded nacelle back to the nozzle. Behind the throat sits a dark socket and behind the nozzle a back plate,
  // both hidden while those parts are on and closing the nacelle once they are gone.
  const nacelleBands: Band[] = [
    { pts: [[Z(0.012), 0.95 * R], [Z(0.06), 1.0 * R], [Z(0.15), 1.04 * R]], paint: hull },
    { pts: [[Z(0.15), 1.04 * R], [Z(0.155), 1.07 * R], [Z(0.265), 1.07 * R], [Z(0.27), 1.04 * R]], paint: S },
    { pts: [[Z(0.27), 1.04 * R], [Z(0.4), 1.035 * R], [Z(0.5), 1.02 * R]], paint: hull },
    { pts: [[Z(0.5), 1.02 * R], [Z(0.505), 0.95 * R], [Z(0.565), 0.95 * R], [Z(0.57), 1.02 * R]], paint: D },
    { pts: [[Z(0.57), 1.02 * R], [Z(0.575), 1.06 * R], [Z(0.74), 1.06 * R], [Z(0.745), 1.02 * R]], paint: S },
    { pts: [[Z(0.745), 1.02 * R], [Z(0.83), 1.0 * R]], paint: hull },
    { pts: [[Z(0.15), 0.42 * R], [Z(0.09), 0.66 * R], [Z(0.035), 0.8 * R], [Z(0.016), 0.93 * R], [Z(0.012), 0.95 * R]], paint: Dk },
    { pts: [[Z(0.826), 0.995 * R], [Z(0.826), 0]], paint: D },
  ];
  // Ribbed nozzle housing: each rib its own band so the steps stay crisp.
  const nozzleBands: Band[] = [];
  let z0 = 0.83;
  for (let k = 0; k < 4; k++) {
    const p = k % 2 ? M : D;
    nozzleBands.push({ pts: [[Z(z0), 1.0 * R], [Z(z0 + 0.004), 0.95 * R]], paint: p });
    nozzleBands.push({ pts: [[Z(z0 + 0.004), 0.95 * R], [Z(z0 + 0.018), 0.95 * R]], paint: p });
    nozzleBands.push({ pts: [[Z(z0 + 0.018), 0.95 * R], [Z(z0 + 0.022), 1.0 * R]], paint: p });
    z0 += 0.022;
  }
  nozzleBands.push({ pts: [[Z(z0), 1.0 * R], [Z(0.95), 0.97 * R], [Z(1.0), 0.88 * R]], paint: M });
  nozzleBands.push({ pts: [[Z(1.0), 0.88 * R], [Z(1.0), 0.75 * R]], paint: D });
  nozzleBands.push({ pts: [[Z(1.0), 0.75 * R], [Z(0.96), 0.69 * R], [Z(0.9), 0.64 * R]], paint: Dk });
  // The nacelle's skin gets extra rings (high/medium) so dents in it come out round, not as long creased facets.
  const nacelle: THREE.BufferGeometry[] = [lathe(nacelleBands, segs, sec, DENT_STEP[segs] ?? 0)];
  const intake: THREE.BufferGeometry[] = [lathe(intakeBands, segs, sec)];
  const claws: THREE.BufferGeometry[] = [];

  const radial = (a: number) => new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
  const onSurface = (a: number, r: number, z: number) => {
    const [x, y] = sectionPoint(a, r, sec);
    return new THREE.Vector3(x, y, z);
  };
  const back = new THREE.Vector3(0, 0, 1);

  // Fan: a spinner and swept blades deep in the intake, about its hub (the part spins); the dark disk behind them
  // stays with the nacelle. The blades are stored in a scrambled order so dropping the last few from the draw range
  // knocks out blades all round the fan, and a morph target bends them back and round.
  lay.fan.set(0, 0, Z(0.12));
  const fanParts: THREE.BufferGeometry[] = [];
  const hub = new THREE.ConeGeometry(0.27 * R, 0.16 * L, Math.max(8, segs / 2), 1);
  fanParts.push(surface(hub, M, trs(0, 0, -0.01 * L, -Math.PI / 2, 0, 0)));
  hub.dispose();
  const disk = new THREE.CircleGeometry(0.5 * R, Math.max(8, segs / 2));
  nacelle.push(surface(disk, Dk, trs(0, 0, Z(0.135), 0, Math.PI, 0)));
  disk.dispose();
  const bladeBox = new THREE.BoxGeometry(0.12 * R, 0.42 * R, 0.02 * L);
  const blades = segs >= 28 ? 14 : 8;
  const fanLead = fanParts[0].attributes.position.count;
  for (let n = 0; n < blades; n++) {
    const i = (n * 5) % blades;
    const m = new THREE.Matrix4()
      .makeRotationZ((i / blades) * Math.PI * 2)
      .multiply(trs(0, 0.47 * R, 0))
      .multiply(new THREE.Matrix4().makeRotationY(0.6));
    fanParts.push(surface(bladeBox, i % 2 ? M : D, m));
  }
  const fanPer = fanParts[1].attributes.position.count;
  bladeBox.dispose();
  const bendDir = new THREE.Vector3();
  const fan = morphBy(merge(fanParts), fanLead, fanPer, (q, piece) => {
    if (piece < 0) return bendDir.set(0, 0, 0);
    const r = Math.hypot(q.x, q.y);
    const k = Math.max(0, r - 0.26 * R) * (0.6 + 0.5 * Math.abs(Math.sin(piece * 2.9 + 0.7)));
    return bendDir.set((-q.y / r) * k * 0.6, (q.x / r) * k * 0.6, k * 0.5);
  });

  // Teeth around the intake lip, pointing forwards (the "claws" part).
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
    claws.push(surface(geo, i % 2 ? M : D, m));
    geo.dispose();
  }

  // Big claws raking back past the nozzle (the concept art's spikes), on the outer and lower side: part of the
  // nacelle's armour (the damage model's claws are the teeth round the intake).
  const clawAngles: Record<number, number[]> = { 2: [-0.5, -2.6], 3: [0.35, -0.9, -2.3], 4: [0.45, -0.6, -1.75, -2.75] };
  for (const a of clawAngles[design.shape.fins] ?? clawAngles[3]) {
    const { geo, m } = blade(
      [[0, 0], [0.14 * L, 0.16 * R], [0.3 * L, 0.27 * R], [0.47 * L, 0.5 * R], [0.37 * L, 0.22 * R], [0.33 * L, -0.02 * R], [0.05 * L, -0.04 * R]],
      0.1 + 0.04 * R,
      back,
      radial(a),
      onSurface(a, 0.98 * R, Z(0.6)),
    );
    nacelle.push(surface(geo, (c) => (c.y > 0.3 * R ? S : D), m));
    geo.dispose();
  }

  // Binder mounts on the inboard side and pipes along the belly.
  const mountBox = new THREE.BoxGeometry(0.34 * R, 0.4 * R, 0.17 * L);
  for (const [a, f] of [
    [Math.PI * 0.86, 0.32],
    [Math.PI * 1.15, 0.66],
  ]) {
    const p = onSurface(a, 1.02 * R, Z(f));
    nacelle.push(surface(mountBox, D, trs(p.x, p.y, p.z, 0, 0, a), 0.5));
  }
  const pipe = new THREE.CylinderGeometry(0.05 + 0.02 * R, 0.05 + 0.02 * R, 0.62 * L, 6);
  for (const a of [-Math.PI * 0.38, -Math.PI * 0.62]) {
    const p = onSurface(a, 1.06 * R, Z(0.49));
    nacelle.push(surface(pipe, M, trs(p.x, p.y, p.z, Math.PI / 2, 0, 0)));
  }
  pipe.dispose();
  // Armour: curved plates lying over the skin from 28 % to 49 % of its length (between the front livery band and the
  // groove), on top, outboard, inboard (narrow, clear of the binder mount) and on the belly (between the pipes). Dark
  // trim round a livery plate with a stripe down the middle. Each is built about its hinge (the middle of its trailing
  // edge): the airflow gets under a loose plate's leading edge and folds it back about the skin's tangent there.
  const armSpans: Record<ArmKind, [number, number]> = {
    Top: [Math.PI * 0.5, Math.PI * 0.17],
    Out: [0, Math.PI * 0.15],
    In: [Math.PI, Math.PI * 0.072],
    Belly: [-Math.PI * 0.5, Math.PI * 0.082],
  };
  const armour = {} as Record<ArmKind, THREE.BufferGeometry>;
  const na = segs >= 40 ? 8 : 6;
  const nz = segs >= 40 ? 6 : 4;
  for (const kind of ARM_KINDS) {
    const [mid, half] = armSpans[kind];
    const span: PanelSpan = { a0: mid - half, a1: mid + half, z0: Z(0.28), z1: Z(0.49), r: 1.05 * R };
    const plateP = (u: number, v: number) => (u < 0.12 || u > 0.88 || v < 0.1 || v > 0.9 ? D : Math.abs(u - 0.5) < 0.14 ? P : S);
    const g = shellPanel(sec, span, 0.05 + 0.02 * R, kind === 'In' || kind === 'Belly' ? Math.max(3, na - 3) : na, nz, plateP, plateBulge);
    const pos = onSurface(mid, span.r, span.z1);
    const [x0, y0] = sectionPoint(mid - 0.01, 1, sec);
    const [x1, y1] = sectionPoint(mid + 0.01, 1, sec);
    g.translate(-pos.x, -pos.y, -pos.z);
    armour[kind] = g;
    lay.arm[kind] = { span, pos, axis: new THREE.Vector3(x1 - x0, y1 - y0, 0).normalize() };
  }

  // Hinges for the top fin and side flap (animated separately at high quality).
  lay.fin.pos.copy(onSurface(lay.fin.angle, 0.97 * R, Z(0.58)));
  lay.flap.pos.copy(onSurface(lay.flap.angle, 0.98 * R, Z(0.56)));
  const fin = blade([[0, 0], [0.3 * L, 0], [0.4 * L, 0.95 * R], [0.22 * L, 1.0 * R]], 0.07, back, radial(lay.fin.angle), new THREE.Vector3());
  const finGeo = surface(fin.geo, (c) => (c.y > 0.66 * R ? S : c.y > 0.58 * R ? D : M), fin.m);
  fin.geo.dispose();
  const flap = blade([[0, 0], [0.32 * L, 0], [0.38 * L, 0.5 * R], [0.14 * L, 0.55 * R]], 0.06, back, radial(lay.flap.angle), new THREE.Vector3());
  const flapGeo = surface(flap.geo, (c) => (c.y > 0.36 * R ? S : P), flap.m);
  flap.geo.dispose();

  // Glow: intake ring (on the intake), nozzle core disk and the bright nozzle rim (on the nozzle).
  const ringIn = new THREE.TorusGeometry(0.8 * R, 0.035 * R, 6, segs);
  const intakeGlow = glow(ringIn, glowCol, 3, trs(0, 0, Z(0.02), 0, 0, 0, sec.sx, sec.sy, 1));
  ringIn.dispose();
  const nozzleGlow: THREE.BufferGeometry[] = [];
  const core = new THREE.CircleGeometry(0.66 * R, segs);
  nozzleGlow.push(glow(core, glowCol, 2, trs(0, 0, Z(0.905), 0, 0, 0, sec.sx, sec.sy, 1)));
  core.dispose();
  const rim = new THREE.TorusGeometry(0.76 * R, 0.05 * R, 6, segs);
  nozzleGlow.push(glow(rim, glowCol, 4, trs(0, 0, Z(0.998), 0, 0, 0, sec.sx, sec.sy, 1)));
  rim.dispose();

  // Nozzle petals: a ring of overlapping leaves round the exhaust converging past the nozzle's end, in a scrambled order
  // (like the fan's blades) so they drop out all round it; a morph target flares them open.
  const petalParts: THREE.BufferGeometry[] = [];
  const petals = segs >= 40 ? 14 : 10;
  const pz0 = Z(0.985);
  const pLen = Math.hypot(0.075 * L, 0.15 * R);
  for (let n = 0; n < petals; n++) {
    const a = (((n * 3) % petals) / petals) * Math.PI * 2;
    const base = onSurface(a, 0.88 * R, pz0);
    const tip = onSurface(a, 0.73 * R, Z(1.06));
    const { geo, m } = blade(
      [[0, -0.2 * R], [pLen, -0.13 * R], [pLen, 0.13 * R], [0, 0.2 * R]],
      0.035,
      tip.clone().sub(base),
      new THREE.Vector3(-Math.sin(a), Math.cos(a), 0),
      base,
    );
    petalParts.push(surface(geo, (c) => (c.distanceTo(tip) < 0.3 * pLen ? D : M), m));
    geo.dispose();
  }
  const petalPer = petalParts[0].attributes.position.count;
  const flare = new THREE.Vector3();
  const petalGeo = morphBy(merge(petalParts), 0, petalPer, (q, piece) => {
    const r = Math.hypot(q.x, q.y) || 1;
    const k = Math.max(0, q.z - pz0) * (0.9 + 0.6 * Math.abs(Math.sin(piece * 1.7 + 0.4)));
    return flare.set((q.x / r) * k * 0.7, (q.y / r) * k * 0.7, -k * 0.2);
  });

  return {
    surf: {
      nacelle: merge(nacelle), intake: merge(intake), fan, claws: merge(claws), nozzle: lathe(nozzleBands, segs, sec), petals: petalGeo,
      fin: finGeo, flap: flapGeo, armTop: armour.Top, armOut: armour.Out, armIn: armour.In, armBelly: armour.Belly,
    },
    glow: { intake: intakeGlow, nozzle: merge(nozzleGlow) },
    spokes: { fan: { lead: fanLead, per: fanPer, n: blades }, petals: { lead: 0, per: petalPer, n: petals } } as PodGeometry['spokes'],
    sec,
  };
}

/** Cockpit radius profile along its length (fraction 0 = nose .. 1 = back), as the shell's lathe is shaped. */
const COCKPIT_PROFILE: [number, number][] = [
  [0, 0], [0.015, 0.3], [0.07, 0.6], [0.18, 0.84], [0.32, 0.97], [0.5, 1.0], [0.7, 0.98], [0.88, 0.86], [0.96, 0.66], [1.0, 0.48],
];

function cockpitRadius(f: number): number {
  return profileAt(COCKPIT_PROFILE, f);
}

/** Nacelle skin radius (in engine radii) along its length (fraction 0 = intake lip .. 1 = nozzle end), as built. */
const ENGINE_PROFILE: [number, number][] = [
  [0, 0.93], [0.06, 1.0], [0.15, 1.04], [0.155, 1.07], [0.265, 1.07], [0.27, 1.04], [0.5, 1.02], [0.505, 0.95], [0.565, 0.95],
  [0.57, 1.02], [0.575, 1.06], [0.74, 1.06], [0.745, 1.02], [0.83, 1.0], [0.95, 0.97], [1.0, 0.88],
];

function engineRadius(f: number): number {
  return profileAt(ENGINE_PROFILE, f);
}

function profileAt(profile: [number, number][], f: number): number {
  if (f <= profile[0][0]) return profile[0][1];
  for (let i = 1; i < profile.length; i++) {
    const [f1, r1] = profile[i];
    if (f <= f1) {
      const [f0, r0] = profile[i - 1];
      return r0 + ((r1 - r0) * (f - f0)) / (f1 - f0);
    }
  }
  return profile[profile.length - 1][1];
}

function cockpitSection(design: PodDesign, lay: Layout): Section {
  return { n: 2.4 + 1.4 * design.shape.wedge, sx: lay.ca, sy: lay.cb };
}

/**
 * Cockpit shell, nose, canopy, pilot, stabilisers, tail, side mounts, binders and cables in pod space, as separate
 * parts; the canopy frame and the antenna about their pivots (the canopy glass in pod space, it hangs in the frame).
 */
function buildCockpit(design: PodDesign, lay: Layout, segs: number, pal: ReturnType<typeof palette>, glowCol: THREE.Color, sec: Section) {
  const { P, S, M, D, Dk, helmet, suit } = pal;
  const C = design.shape.cockpitLength;
  const { ca: a, cb: b, yC, zC } = lay;
  const cs = cockpitSection(design, lay);
  const Z = (f: number) => zC - C / 2 + f * C;
  const shell = (ang: number, z: number): Paint => {
    if (Math.sin(ang) < -0.35) return D;
    if (Math.abs(ang - Math.PI / 2) < 0.3) return S;
    if ((Math.abs(ang) < 0.22 || Math.abs(Math.abs(ang) - Math.PI) < 0.22) && z < Z(0.62) && z > Z(0.2)) return S;
    return P;
  };
  const cseg = Math.max(12, Math.round(segs * 0.8));
  const parts: THREE.BufferGeometry[] = [];
  // The shell from the nose's base back, with a dark bulkhead where the nose cone sits (closing it once the nose is
  // gone), and the nose cone itself.
  const body = lathe(
    [
      { pts: [[Z(0.18), 0.84], [Z(0.32), 0.97], [Z(0.5), 1.0], [Z(0.7), 0.98]], paint: shell },
      { pts: [[Z(0.7), 0.98], [Z(0.705), 0.92], [Z(0.76), 0.92], [Z(0.765), 0.97]], paint: D },
      { pts: [[Z(0.765), 0.97], [Z(0.88), 0.86], [Z(0.96), 0.66], [Z(1.0), 0.48]], paint: shell },
      { pts: [[Z(1.0), 0.48], [Z(1.0) + 0.05 * C, 0.3], [Z(1.0) + 0.07 * C, 0.0]], paint: D },
      { pts: [[Z(0.185), 0], [Z(0.185), 0.83]], paint: Dk },
    ],
    cseg,
    cs,
    DENT_STEP[segs] ?? 0,
  );
  body.translate(0, yC, 0);
  parts.push(body);
  const nose = lathe([{ pts: [[Z(0), 0], [Z(0.015), 0.3], [Z(0.07), 0.6], [Z(0.18), 0.84]], paint: shell }], cseg, cs);
  nose.translate(0, yC, 0);

  // Canopy frame (its rim and a spine over the top, the glass sits in it), pilot (helmet + shoulders), keel, side mounts.
  const canZ = Z(0.38);
  const canY = yC + 0.68 * b;
  lay.frame.set(0, canY, canZ);
  const frame: THREE.BufferGeometry[] = [];
  const rimG = new THREE.TorusGeometry(1, 0.07, 4, cseg);
  frame.push(surface(rimG, M, trs(0, canY, canZ, Math.PI / 2, 0, 0, 0.5 * a, 0.3 * C, 1)));
  rimG.dispose();
  const spineG = new THREE.TorusGeometry(1, 0.05, 4, Math.max(8, cseg / 2), Math.PI);
  frame.push(surface(spineG, D, trs(0, canY, canZ, 0, Math.PI / 2, 0, 0.3 * C * 1.03, 0.62 * b * 1.05, 1)));
  spineG.dispose();
  const frameGeo = merge(frame).translate(0, -canY, -canZ);
  const head = new THREE.SphereGeometry(0.19, 12, 8);
  parts.push(surface(head, helmet, trs(0, canY + 0.26, canZ + 0.05)));
  head.dispose();
  const shoulders = new THREE.BoxGeometry(0.5, 0.22, 0.3);
  parts.push(surface(shoulders, suit, trs(0, canY + 0.04, canZ + 0.1)));
  shoulders.dispose();
  const keel = new THREE.BoxGeometry(0.55 * a, 0.3 * b, 0.5 * C);
  parts.push(surface(keel, Dk, trs(0, yC - 0.88 * b, Z(0.55)), 0.5));
  keel.dispose();
  // The side mounts the binders clamp onto (each takes its binder's cockpit-end clamps, added below).
  const mounts: THREE.BufferGeometry[][] = [[], []];
  const mount = new THREE.BoxGeometry(0.3, 0.5, 0.5);
  for (const s of [-1, 1]) mounts[s < 0 ? 0 : 1].push(surface(mount, D, trs(s * (a + 0.08), yC, Z(0.5)), 0.5));
  mount.dispose();
  // Antenna: a whip behind the canopy, off to the left, about its foot (the part leans back and bends), with a red
  // tip light.
  const rA = cockpitRadius(0.82);
  let th = Math.PI / 2;
  while (th > 0.3 && sectionPoint(th, rA, cs)[0] < 0.3 * a) th -= 0.01;
  const [axA, ayA] = sectionPoint(th, rA, cs);
  lay.antenna.set(-axA, yC + ayA, Z(0.82));
  const antParts: THREE.BufferGeometry[] = [];
  const foot = new THREE.BoxGeometry(0.14, 0.1, 0.22);
  antParts.push(surface(foot, D, trs(0, 0.02, 0)));
  foot.dispose();
  const mast = new THREE.CylinderGeometry(0.012, 0.024, 1.05, 5);
  antParts.push(surface(mast, M, trs(0, 0.55, 0)));
  mast.dispose();
  const antenna = merge(antParts);
  const tipG = new THREE.SphereGeometry(0.045, 6, 4);
  const antennaGlow = glow(tipG, new THREE.Color('#ff3020').multiplyScalar(2), 0, trs(0, 1.09, 0));
  tipG.dispose();
  // Tail grille and two little stabilisers.
  const slat = new THREE.BoxGeometry(0.75 * a, 0.05, 0.1);
  const tailParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) tailParts.push(surface(slat, M, trs(0, yC - (0.05 + i * 0.13) * b, Z(1.0) + 0.06 * C - 0.02 * i)));
  slat.dispose();
  const stabs: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const { geo, m } = blade(
      [[0, 0], [0.32 * C, 0], [0.42 * C, 0.42], [0.22 * C, 0.4]],
      0.05,
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(s * 0.55, 0.83, 0),
      new THREE.Vector3(s * 0.45 * a, yC + 0.75 * b, Z(0.6)),
    );
    stabs.push(surface(geo, (c) => (c.y > 0.28 ? S : D), m));
    geo.dispose();
  }

  // Binders: two per side from the cockpit mounts to the engines' inboard mounts, and one between the engines. The
  // cockpit end's clamp stays on its mount when a binder snaps; the engine end's clamp goes with the binder.
  const binderCol = new THREE.Color('#4feaff').lerp(glowCol, 0.3);
  const L = lay.L;
  const R = lay.R;
  const engZ = (f: number) => lay.zE - L / 2 + f * L;
  const engPt = (s: number, ang: number, f: number) => {
    const [x, y] = sectionPoint(ang, 1.18 * R, sec);
    return new THREE.Vector3(s * (lay.xE + x), y, engZ(f));
  };
  const beamCyl = new THREE.CylinderGeometry(0.11, 0.11, 1, 8, 1, true);
  const thinCyl = new THREE.CylinderGeometry(0.05, 0.05, 1, 6, 1, true);
  const clamp = new THREE.CylinderGeometry(0.17, 0.17, 1, 8);
  const links: Record<BinderId, Link[]> = { binderL: [], binderR: [], binderMid: [] };
  const clamps: Record<BinderId, THREE.BufferGeometry[]> = { binderL: [], binderR: [], binderMid: [] };
  const link = (id: BinderId, p: THREE.Vector3, q: THREE.Vector3) => {
    const d = q.clone().sub(p).normalize();
    links[id].push({ thin: id === 'binderMid', m: along(p.clone().addScaledVector(d, 0.12), q.clone().addScaledVector(d, -0.12)) });
    (id === 'binderMid' ? clamps[id] : mounts[id === 'binderL' ? 0 : 1]).push(surface(clamp, D, along(p.clone().addScaledVector(d, -0.05), p.clone().addScaledVector(d, 0.3))));
    clamps[id].push(surface(clamp, D, along(q.clone().addScaledVector(d, -0.3), q.clone().addScaledVector(d, 0.05))));
  };
  for (const [s, id] of [[-1, 'binderL'], [1, 'binderR']] as const) {
    link(id, new THREE.Vector3(s * (a + 0.2), yC + 0.14, Z(0.42)), engPt(s, Math.PI * 0.86, 0.32));
    link(id, new THREE.Vector3(s * (a + 0.2), yC - 0.16, Z(0.6)), engPt(s, Math.PI * 1.15, 0.66));
  }
  link('binderMid', engPt(-1, Math.PI - 0.06, 0.2), engPt(1, Math.PI - 0.06, 0.2));
  const beam = glow(beamCyl, binderCol, 1);
  const thinBeam = glow(thinCyl, binderCol, 1);
  beamCyl.dispose();
  thinCyl.dispose();
  clamp.dispose();

  // Steering cables from the cockpit nose to the engine tops, sagging a little; a morph target holds them sagging
  // far lower, for a cable that is coming loose.
  const cables: THREE.BufferGeometry[] = [];
  if (segs >= 28) {
    for (const s of [-1, 1]) {
      const p = new THREE.Vector3(s * 0.22, yC + 0.55 * b, Z(0.08));
      const q = engPt(s, Math.PI * 0.62, 0.42);
      const tubeAt = (sag: number) => {
        const mid = p.clone().add(q).multiplyScalar(0.5).add(new THREE.Vector3(0, -sag, 0));
        const tube = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(p, mid, q), 12, 0.03, 4, false);
        const g = surface(tube, Dk, undefined, 0.2);
        tube.dispose();
        return g;
      };
      const g = tubeAt(0.35);
      const loose = tubeAt(1.3);
      g.morphAttributes.position = [loose.attributes.position];
      g.morphAttributes.normal = [loose.attributes.normal];
      loose.dispose();
      cables.push(g);
    }
  }

  // Orange tail light and the pilot's visor.
  const orange = new THREE.Color('#ff6a1f');
  // Tail light: a slit across the top of the dark back plate, under the white dome.
  const tailLight = new THREE.BoxGeometry(0.5 * a, 0.09, 0.12);
  const tailGlow = glow(tailLight, orange, 0, trs(0, yC + 0.36 * b, Z(1.0) + 0.03 * C));
  tailLight.dispose();
  const visor = new THREE.BoxGeometry(0.26, 0.07, 0.06);
  const visorGlow = glow(visor, new THREE.Color('#ff9a40'), 0, trs(0, canY + 0.26, canZ - 0.13));
  visor.dispose();

  const canopy = new THREE.SphereGeometry(1, cseg, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  canopy.applyMatrix4(trs(0, canY, canZ, 0, 0, 0, 0.5 * a, 0.62 * b, 0.3 * C));
  const surf: Record<string, THREE.BufferGeometry> = {
    hull: merge(parts),
    cockpitNose: nose,
    stabL: stabs[0],
    stabR: stabs[1],
    tail: merge(tailParts),
    binderL: merge(clamps.binderL),
    binderR: merge(clamps.binderR),
    binderMid: merge(clamps.binderMid),
    canopyFrame: frameGeo,
    antenna,
    mountL: merge(mounts[0]),
    mountR: merge(mounts[1]),
  };
  if (cables.length) [surf.cableL, surf.cableR] = cables;
  return { surf, glow: { hull: visorGlow, tail: tailGlow, antenna: antennaGlow }, canopy, beam, thinBeam, links };
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
    // One mesh per engine (fin and flap baked at their hinges, and its side's binders, so they go when it goes), the
    // centre binder on its own (it goes when either engine does) and one for the cockpit (the canopy as glossy dark
    // paint): only the nacelles, the centre binder and the hull are separate parts.
    const e = eng.surf;
    const at = (g: THREE.BufferGeometry, p: THREE.Vector3) => g.translate(p.x, p.y, p.z);
    // Parts with a morph target (armour, fan, petals) lose it to merge with the rest.
    const flat = (g: THREE.BufferGeometry, p?: THREE.Vector3) => {
      const f = unmorphed(g);
      g.dispose();
      return p ? at(f, p) : f;
    };
    const local = new THREE.Matrix4().makeTranslation(-lay.xE, 0, -lay.zE);
    const beams = ck.links.binderR.map((l) => ck.beam.clone().applyMatrix4(local.clone().multiply(l.m)));
    const mid = ck.links.binderMid.map((l) => ck.thinBeam.clone().applyMatrix4(l.m));
    const c = ck.surf;
    const armour = ARM_KINDS.map((k) => flat(e[`arm${k}`], lay.arm[k].pos));
    pg = {
      layout: lay,
      surf: {
        nacelle: merge([
          e.nacelle, e.intake, flat(e.fan, lay.fan), e.claws, e.nozzle, flat(e.petals), at(e.fin, lay.fin.pos), at(e.flap, lay.flap.pos),
          ...armour, c.binderR.applyMatrix4(local),
        ]),
        hull: merge([
          c.hull, c.cockpitNose, c.stabL, c.stabR, c.tail, surface(ck.canopy, pal.glass), at(c.canopyFrame, lay.frame),
          at(c.antenna.rotateX(ANTENNA_LEAN), lay.antenna), c.mountL, c.mountR,
        ]),
        binderMid: c.binderMid,
      },
      glow: {
        engine: merge([eng.glow.intake, eng.glow.nozzle, ...beams]),
        hull: merge([ck.glow.hull, ck.glow.tail, at(ck.glow.antenna.rotateX(ANTENNA_LEAN), lay.antenna)]),
        binderMid: merge(mid),
      },
      plume,
      spokes: {},
      users: 1,
    };
    for (const g of [ck.canopy, ck.beam, ck.thinBeam, c.binderL]) g.dispose();
  } else {
    pg = {
      layout: lay,
      surf: { ...eng.surf, ...ck.surf },
      glow: { ...eng.glow, ...ck.glow },
      canopy: ck.canopy,
      beam: ck.beam,
      thinBeam: ck.thinBeam,
      links: ck.links,
      plume,
      spokes: eng.spokes,
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
  for (const g of [...Object.values(pg.surf), ...Object.values(pg.glow), pg.canopy, pg.beam, pg.thinBeam, pg.plume]) g?.dispose();
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

type Disposable = { dispose(): void };

interface Scar {
  mesh: THREE.Mesh;
  /** Index into PodAnim.damage (left engine, right engine, cockpit) for pods without per-part health. */
  group: number;
  /** Shown once the damage near it passes this. */
  at: number;
  /** The parts whose damage shows here, weighted by how close they are. */
  near: [PartId, number][];
  /** On a buckling plate: the normal it lifts along, how far at full buckle, how far it is lifted now, the plate. */
  lift?: { n: THREE.Vector3; k: number; done: number; part: PartId };
}

/**
 * Builds a pod. Besides the PodVisual contract: an object returned by breakOff carries `userData.dispose()` (frees the
 * per-pod geometry and material clones that went with it; shared geometry stays with the pod cache) and
 * `userData.glowMaterial` (its own copy of the glow material, or null, so its lights can be faded or killed).
 */
export function createPod(design: PodDesign, quality: Quality = 'high'): PodVisual {
  const pg = getGeometry(design, quality);
  const shared = acquireShared();
  const lay = pg.layout;
  const root = new THREE.Group();
  root.name = `pod:${design.id}`;
  const glowMat = createGlowMaterial();
  const plumeMat = createPlumeMaterial(...exhaustColours(design.livery.glow));
  const parts: Partial<Record<PartId, THREE.Object3D>> = {};
  /** Painted meshes a dent can deform, with the part they belong to. */
  const skins: { part: PartId; mesh: THREE.Mesh }[] = [];
  /** Per-pod clones (dented geometry, the cracked canopy), freed in dispose unless they broke off with a part. */
  const owned = new Set<Disposable>();
  const solid = (g: THREE.BufferGeometry, part?: PartId, m: THREE.Material = shared.surface) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (part) skins.push({ part, mesh });
    return mesh;
  };
  const lit = (g: THREE.BufferGeometry) => new THREE.Mesh(g, glowMat);
  /** A part: a group holding its painted surface and (optionally) its glow. Null when this quality has no such part. */
  const piece = (id: PartId, parent: THREE.Object3D, key: string, glowKey?: string) => {
    const s = pg.surf[key];
    if (!s) return null;
    const grp = new THREE.Group();
    grp.name = id;
    const mesh = solid(s, id);
    grp.add(mesh);
    const gg = glowKey ? pg.glow[glowKey] : undefined;
    const light = gg ? lit(gg) : null;
    if (light) grp.add(light);
    parent.add(grp);
    parts[id] = grp;
    return { grp, mesh, light };
  };
  /** Lights that flicker as their part fails. */
  const flickers: { obj: THREE.Object3D; part: PartId; k: number }[] = [];

  // Engines: each its own group (it vibrates and sags on its binders), with its parts as children.
  const engines: THREE.Group[] = [];
  const fins: (THREE.Object3D | undefined)[] = [];
  const flaps: (THREE.Object3D | undefined)[] = [];
  type Piece = { grp: THREE.Group; mesh: THREE.Mesh };
  const fans: (Piece | undefined)[] = [];
  const petalRings: (Piece | undefined)[] = [];
  const plates: (Piece & { part: PartId; axis: THREE.Vector3; k: number })[] = [];
  for (const [i, s] of [[0, -1], [1, 1]] as const) {
    const k = SIDES[i];
    const g = new THREE.Group();
    g.name = `nacelle${k}`;
    g.position.set(s * lay.xE, 0, lay.zE);
    // The left engine is the right one mirrored; three flips the face winding for negative scale.
    g.scale.x = s;
    g.add(solid(pg.surf.nacelle!, `nacelle${k}`));
    if (pg.glow.engine) g.add(lit(pg.glow.engine));
    parts[`nacelle${k}`] = g;
    const intake = piece(`intake${k}`, g, 'intake', 'intake');
    if (intake?.light) flickers.push({ obj: intake.light, part: `intake${k}`, k: 1 + i * 3 });
    // The fan sits in the intake and the petals on the nozzle, so they leave with them.
    const fan = piece(`fan${k}`, intake?.grp ?? g, 'fan');
    if (fan) {
      fan.grp.position.copy(lay.fan);
      fan.mesh.castShadow = false;
      fans[i] = fan;
    }
    piece(`claws${k}`, g, 'claws');
    const nozzle = piece(`nozzle${k}`, g, 'nozzle', 'nozzle');
    const ring = piece(`petals${k}`, nozzle?.grp ?? g, 'petals');
    if (ring) {
      ring.mesh.castShadow = false;
      petalRings[i] = ring;
    }
    for (const kind of ARM_KINDS) {
      const plate = piece(`arm${kind}${k}`, g, `arm${kind}`);
      if (!plate) continue;
      plate.grp.position.copy(lay.arm[kind].pos);
      plates.push({ part: `arm${kind}${k}`, grp: plate.grp, mesh: plate.mesh, axis: lay.arm[kind].axis, k: plates.length });
    }
    const fin = piece(`fin${k}`, g, 'fin');
    fin?.grp.position.copy(lay.fin.pos);
    fins.push(fin?.grp);
    const flap = piece(`flap${k}`, g, 'flap');
    flap?.grp.position.copy(lay.flap.pos);
    flaps.push(flap?.grp);
    engines.push(g);
    root.add(g);
  }

  // Cockpit: the hull group (pod space, at the origin) carries the nose, canopy, stabilisers and tail.
  const cockpit = new THREE.Group();
  cockpit.name = 'hull';
  cockpit.add(solid(pg.surf.hull!, 'hull'));
  if (pg.glow.hull) cockpit.add(lit(pg.glow.hull));
  parts.hull = cockpit;
  root.add(cockpit);
  piece('cockpitNose', cockpit, 'cockpitNose');
  piece('stabL', cockpit, 'stabL');
  piece('stabR', cockpit, 'stabR');
  piece('mountL', cockpit, 'mountL');
  piece('mountR', cockpit, 'mountR');
  const tail = piece('tail', cockpit, 'tail', 'tail');
  if (tail?.light) flickers.push({ obj: tail.light, part: 'tail', k: 7 });
  const antenna = piece('antenna', cockpit, 'antenna', 'antenna');
  if (antenna) {
    antenna.grp.position.copy(lay.antenna);
    antenna.grp.rotation.x = ANTENNA_LEAN;
    antenna.mesh.castShadow = false;
  }
  // The glass hangs in its frame (pod space under the frame's pivot), so it goes when the frame goes.
  const frame = piece('canopyFrame', cockpit, 'canopyFrame');
  frame?.grp.position.copy(lay.frame);
  let canopy: THREE.Mesh | null = null;
  if (pg.canopy) {
    const grp = new THREE.Group();
    grp.name = 'canopy';
    canopy = new THREE.Mesh(pg.canopy, shared.glass);
    canopy.renderOrder = 1;
    grp.add(canopy);
    if (frame) grp.position.copy(lay.frame).negate();
    (frame?.grp ?? cockpit).add(grp);
    parts.canopy = grp;
  }

  // Binders (their engine-end clamps and glowing beams; each beam its own mesh so it can thin) and cables.
  const beams: { obj: THREE.Mesh; part: BinderId; scale: THREE.Vector3 }[] = [];
  if (pg.links) {
    for (const id of BINDERS) {
      const grp = new THREE.Group();
      grp.name = id;
      grp.add(solid(pg.surf[id]!));
      for (const l of pg.links[id]) {
        const m = lit(l.thin ? pg.thinBeam! : pg.beam!);
        l.m.decompose(m.position, m.quaternion, m.scale);
        grp.add(m);
        beams.push({ obj: m, part: id, scale: m.scale.clone() });
        flickers.push({ obj: m, part: id, k: 2.3 * beams.length });
      }
      root.add(grp);
      parts[id] = grp;
    }
  } else piece('binderMid', root, 'binderMid', 'binderMid');
  const cables: Partial<Record<'cableL' | 'cableR', THREE.Mesh>> = {};
  for (const id of ['cableL', 'cableR'] as const) {
    const g = pg.surf[id];
    if (!g) continue;
    const grp = new THREE.Group();
    grp.name = id;
    cables[id] = solid(g);
    grp.add(cables[id]);
    root.add(grp);
    parts[id] = grp;
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

  // Damage: scars (flat scorch marks and bare-metal scrapes lying on the skin, scrapes running fore and aft) on the
  // parts, each shown once the damage of the parts near it passes its threshold, and the points smoke rises from.
  const anchors = partAnchors(design.shape);
  const damagePoints: THREE.Object3D[] = [];
  const scars: Scar[] = [];
  const scarGeo = scarGeometry();
  const nrm = new THREE.Vector3();
  const podPos = new THREE.Vector3();
  const fore = new THREE.Vector3();
  const across = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  /** A scar at `pos` (on the skin) facing `normal`, `len` long fore and aft and `wid` across. */
  const addScar = (parent: THREE.Object3D, group: number, k: number, pos: THREE.Vector3, normal: THREE.Vector3, len: number, wid: number, own: PartId) => {
    const mesh = new THREE.Mesh(scarGeo, scarMaterial(len > 2.5 * wid));
    normal.normalize();
    fore.set(0, 0, 1).addScaledVector(normal, -normal.z);
    if (fore.lengthSq() < 1e-4) fore.set(1, 0, 0);
    fore.normalize();
    across.crossVectors(normal, fore);
    mesh.quaternion.setFromRotationMatrix(basis.makeBasis(fore, across, normal));
    // Lifted a hair off the skin (and drawn with a polygon offset) so it never flickers into it.
    mesh.position.copy(pos).addScaledVector(normal, 0.012);
    mesh.scale.set(len / 2, wid / 2, 1);
    mesh.visible = false;
    parent.add(mesh);
    const near: [PartId, number][] = [];
    for (const id of PART_IDS) {
      if (PARTS[id].group !== PARTS[own].group) continue;
      const an = anchors[id];
      const dist = Math.max(0, Math.hypot(an.pos[0] - podPos.x, an.pos[1] - podPos.y, an.pos[2] - podPos.z) - an.r);
      const w = id === own ? 1 : Math.exp(-dist / 0.8);
      if (w > 0.2) near.push([id, w]);
    }
    scars.push({ mesh, group, at: 0.08 + (0.82 * k) / SCARS, near });
  };
  /** A scar's size [length, width]: mostly small scorch marks, some long thin scrapes. */
  const scarSize = (scale: number): [number, number] =>
    Math.random() < 0.35
      ? [scale * (0.45 + Math.random() * 0.5), scale * (0.04 + Math.random() * 0.04)]
      : [scale * (0.12 + Math.random() * 0.2), scale * (0.1 + Math.random() * 0.14)];
  // The nacelle's cross-section (as buildEngine shapes it), so scars sit on its skin.
  const w = design.shape.wedge;
  const engSec: Section = { n: 2 + 2.6 * w, sx: 1, sy: 1 - 0.28 * w };
  for (const [i, s] of [[0, -1], [1, 1]] as const) {
    const g = engines[i];
    const k = SIDES[i];
    for (let n = 0; n < SCARS; n++) {
      // Mostly on the top and sides and towards the back, where the chase camera sees them; engine-local, on the
      // nacelle or (past the nozzle's first rib) on the nozzle, on the highest skin under its length so it never
      // sinks into a raised band.
      const a = -0.2 * Math.PI + Math.random() * 1.4 * Math.PI;
      const f = 0.03 + Math.random() * 0.92;
      const [len, wid] = scarSize(lay.R);
      const half = len / 2 / lay.L;
      const r = Math.max(engineRadius(f - half), engineRadius(f), engineRadius(f + half));
      const [sx, sy] = sectionPoint(a, lay.R * r, engSec);
      const z = (f - 0.5) * lay.L;
      const own: PartId = f > 0.83 ? `nozzle${k}` : `nacelle${k}`;
      podPos.set(s * (sx + lay.xE), sy, z + lay.zE);
      nrm.set(Math.cos(a) / engSec.sx, Math.sin(a) / engSec.sy, 0);
      addScar(parts[own] ?? g, i, n, new THREE.Vector3(sx, sy, z), nrm, len, wid, own);
    }
    // A few on each armour plate's outside, riding with it as it buckles out (lifted by its bulge) and peels.
    for (const kind of ARM_KINDS) {
      const id: PartId = `arm${kind}${k}`;
      const plate = parts[id];
      if (!plate) continue;
      const { span, pos } = lay.arm[kind];
      for (let n = 0; n < 3; n++) {
        const u = 0.2 + Math.random() * 0.6;
        const v = 0.2 + Math.random() * 0.6;
        const a = span.a0 + (span.a1 - span.a0) * u;
        const [sx, sy] = sectionPoint(a, span.r + 0.05 + 0.02 * lay.R, engSec);
        const z = span.z0 + (span.z1 - span.z0) * v;
        const [len, wid] = scarSize(lay.R * 0.6);
        podPos.set(s * (sx + lay.xE), sy, z + lay.zE);
        nrm.set(Math.cos(a) / engSec.sx, Math.sin(a) / engSec.sy, 0);
        addScar(plate, i, n * 5 + 2, new THREE.Vector3(sx - pos.x, sy - pos.y, z - pos.z), nrm, Math.min(len, 0.5 * (span.z1 - span.z0)), wid, id);
        scars[scars.length - 1].lift = { n: nrm.clone(), k: plateBulge(u, v), done: 0, part: id };
      }
    }
    const anchor = new THREE.Object3D();
    anchor.position.set(0, lay.R * 0.75, -lay.L * 0.1);
    g.add(anchor);
    damagePoints.push(anchor);
  }
  const C = design.shape.cockpitLength;
  const cs = cockpitSection(design, lay);
  for (let n = 0; n < SCARS; n++) {
    const a = 0.1 * Math.PI + Math.random() * 0.8 * Math.PI;
    const f = 0.1 + Math.random() * 0.85;
    const r = cockpitRadius(f);
    const [sx, sy] = sectionPoint(a, r, cs);
    const pos = new THREE.Vector3(sx, lay.yC + sy, lay.zC - C / 2 + f * C);
    // Tilt the mark with the shell's slope towards the nose and tail.
    const slope = (cockpitRadius(Math.min(1, f + 0.03)) - cockpitRadius(Math.max(0, f - 0.03))) / (0.06 * C);
    nrm.set(Math.cos(a) / lay.ca, Math.sin(a) / lay.cb, -slope);
    const own: PartId = f < 0.18 ? 'cockpitNose' : f > 0.96 ? 'tail' : 'hull';
    podPos.copy(pos);
    addScar(parts[own] ?? cockpit, COCKPIT_PART, n, pos, nrm, ...scarSize(lay.ca * 0.9 * Math.max(0.5, r)), own);
  }
  const cockpitSmoke = new THREE.Object3D();
  cockpitSmoke.position.set(0, lay.yC + lay.cb, lay.zC);
  root.add(cockpitSmoke);
  damagePoints.push(cockpitSmoke);

  // Per-part damage (null until setPartHealth is first called: the pod then falls back on PodAnim.damage).
  let partHealth: Readonly<Record<PartId, number>> | null = null;
  let partBroken: ReadonlySet<PartId> = new Set();
  /** When each part was first seen broken (setPartHealth call count), to tell which carried parts break with it. */
  const brokeAt = new Map<PartId, number>();
  let calls = 0;
  const detached = new Set<PartId>();
  let crackedGlass: THREE.MeshStandardMaterial | null = null;
  const hp = (id: PartId) => (partHealth ? (partBroken.has(id) ? 0 : partHealth[id]) : 1);
  const bendSign = Math.random() < 0.5 ? -1 : 1;
  /** How far a plate has buckled (its morph influence), 0..1. */
  const buckle = (id: PartId) => Math.min(1, (1 - hp(id)) * 1.25);
  /** This pod's own copy of a mesh's shared geometry (for a dent, or for drawing a fan or petal ring short). */
  const ownGeometry = (mesh: THREE.Mesh) => {
    if (owned.has(mesh.geometry)) return mesh.geometry;
    const g = mesh.geometry.clone();
    if (!g.boundingSphere) g.computeBoundingSphere();
    DENT_CAP.set(g, Math.min(0.3, 0.28 * g.boundingSphere!.radius));
    mesh.geometry = g;
    owned.add(g);
    return g;
  };
  /** A fan's or petal ring's pieces drop out below health `from` (down to `keep` at 0) and bend (its morph target). */
  const spokes = (ring: Piece | undefined, part: PartId, sp: Spokes | undefined, from: number, keep: number) => {
    if (!ring || !sp || detached.has(part)) return;
    const h = hp(part);
    if (ring.mesh.morphTargetInfluences) ring.mesh.morphTargetInfluences[0] = Math.min(1, (1 - h) * 1.2);
    const lost = Math.round((sp.n - keep) * Math.max(0, (from - h) / from));
    if (!lost && !owned.has(ring.mesh.geometry)) return;
    ownGeometry(ring.mesh).setDrawRange(0, sp.lead + (sp.n - lost) * sp.per);
  };

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
    damagePoints,
    parts,
    setPartHealth(health, broken) {
      partHealth = health;
      partBroken = broken;
      calls++;
      for (const id of broken) if (!brokeAt.has(id)) brokeAt.set(id, calls);
      for (const id of PART_IDS) {
        const o = parts[id];
        // The hull is the wreck itself: it stays (scarred all over) when it breaks.
        if (!o || id === 'hull') continue;
        // A broken fan stays jammed in its intake.
        let show = !broken.has(id) || id === 'fanL' || id === 'fanR';
        // Binders and cables have nothing to hold once the engine (or, for a cable, the nose) at their end is gone.
        if (id === 'binderL' || id === 'cableL') show &&= !broken.has('nacelleL');
        if (id === 'binderR' || id === 'cableR') show &&= !broken.has('nacelleR');
        if (id === 'binderMid') show &&= !broken.has('nacelleL') && !broken.has('nacelleR');
        if (id === 'cableL' || id === 'cableR') show &&= !broken.has('cockpitNose');
        o.visible = show;
      }
      for (const sc of scars) {
        let d = 0;
        for (const [id, w] of sc.near) d = Math.max(d, (1 - hp(id)) * w);
        sc.mesh.visible = d > sc.at;
      }
      // Binders thin as they weaken, cables come loose and droop.
      for (const b of beams) {
        const k = 0.4 + 0.6 * hp(b.part);
        b.obj.scale.set(b.scale.x * k, b.scale.y, b.scale.z * k);
      }
      for (const [id, m] of Object.entries(cables) as ['cableL' | 'cableR', THREE.Mesh][]) {
        if (m.morphTargetInfluences) m.morphTargetInfluences[0] = Math.min(1, (1 - hp(id)) * 1.4);
      }
      // Armour buckles out as it weakens (its morph target); the scars on it ride out with it.
      for (const pl of plates) {
        if (pl.mesh.morphTargetInfluences) pl.mesh.morphTargetInfluences[0] = buckle(pl.part);
      }
      for (const sc of scars) {
        const l = sc.lift;
        if (!l) continue;
        const to = l.k * buckle(l.part);
        sc.mesh.position.addScaledVector(l.n, to - l.done);
        l.done = to;
      }
      // Fans lose and bend blades, petal rings flare and drop petals (a broken fan keeps a couple of stubs).
      for (let i = 0; i < 2; i++) {
        spokes(fans[i], `fan${SIDES[i]}`, pg.spokes.fan, 0.85, 2);
        spokes(petalRings[i], `petals${SIDES[i]}`, pg.spokes.petals, 0.75, 2);
      }
      // A battered canopy frame skews (the glass with it).
      if (frame && !detached.has('canopyFrame')) {
        const k = 1 - hp('canopyFrame');
        frame.grp.rotation.set(-k * 0.1, 0, bendSign * k * 0.12);
      }
      // A cracking canopy frosts over and turns milky (this pod's own copy of the glass).
      const hc = hp('canopy');
      if (canopy && !detached.has('canopy') && hc < 0.97) {
        if (!crackedGlass) {
          crackedGlass = shared.glass.clone();
          owned.add(crackedGlass);
          canopy.material = crackedGlass;
        }
        const k = 1 - hc;
        crackedGlass.color.copy(shared.glass.color).lerp(CRACKED, 0.75 * k);
        crackedGlass.roughness = 0.06 + 0.55 * k;
        crackedGlass.opacity = 0.55 + 0.35 * k;
      }
    },
    breakOff(id) {
      // A broken fan stays jammed in its intake.
      if (id === 'fanL' || id === 'fanR') return null;
      const o = parts[id];
      if (!PARTS[id].detaches) {
        // Binders and cables snap: they just stop being drawn. The hull never goes: it is the wreck.
        if (o && id !== 'hull') o.visible = false;
        return null;
      }
      if (!o || detached.has(id)) return null;
      // The smoke points stay with the pod.
      for (const p of damagePoints) {
        let q: THREE.Object3D | null = p.parent;
        while (q && q !== o) q = q.parent;
        if (q) root.attach(p);
      }
      o.updateWorldMatrix(true, false);
      o.matrixWorld.decompose(o.position, o.quaternion, o.scale);
      o.removeFromParent();
      o.visible = true;
      detached.add(id);
      delete parts[id];
      // Carried parts (and what they carry) that broke before this one were already gone (hidden); the rest come off
      // with it. A fan stays in its intake even if it broke first; a carried part that is not on this one (a mount's
      // binder) just snaps.
      const ref = brokeAt.get(id) ?? Infinity;
      const stack = [...(PARTS[id].carries ?? [])];
      while (stack.length) {
        const c = stack.pop()!;
        stack.push(...(PARTS[c].carries ?? []));
        const co = parts[c];
        if (!co) continue;
        let q: THREE.Object3D | null = co.parent;
        while (q && q !== o) q = q.parent;
        if (!q) {
          co.visible = false;
          continue;
        }
        co.visible = c === 'fanL' || c === 'fanR' || !((brokeAt.get(c) ?? Infinity) < ref);
        detached.add(c);
        delete parts[c];
      }
      // Its lights get their own material (the pod's keeps animating with the pod); per-pod clones go with it.
      let ownGlow: THREE.ShaderMaterial | null = null;
      const take: Disposable[] = [];
      o.traverse((c) => {
        if (!(c instanceof THREE.Mesh)) return;
        if (c.material === glowMat) c.material = ownGlow ??= glowMat.clone();
        if (owned.delete(c.geometry)) take.push(c.geometry);
        if (owned.delete(c.material as THREE.Material)) take.push(c.material as THREE.Material);
      });
      if (ownGlow) take.push(ownGlow);
      o.userData.glowMaterial = ownGlow;
      o.userData.dispose = () => {
        for (const r of take) r.dispose();
      };
      return o;
    },
    dent(point, dir, depth) {
      if (!(depth > 0)) return;
      const r = Math.min(1.7, 1.2 + depth * 1.2);
      const d = Math.min(depth, 0.35);
      for (const { part, mesh } of skins) {
        if (detached.has(part) || partBroken.has(part)) continue;
        const toPod = podMatrix(mesh, root, _m);
        if (!toPod) continue;
        const geo = mesh.geometry;
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        const bs = geo.boundingSphere!;
        if (_v.copy(bs.center).applyMatrix4(toPod).distanceTo(point) > bs.radius * toPod.getMaxScaleOnAxis() + r + 0.5) continue;
        _inv.copy(toPod).invert();
        _p.copy(point).applyMatrix4(_inv);
        _d.copy(dir).transformDirection(_inv);
        // The first dent on a part gives this pod its own copy of the shared geometry.
        deform(ownGeometry(mesh), _p, _d, d, r);
      }
      // Scars ride in with the skin they sit on.
      for (const sc of scars) {
        const m = podMatrix(sc.mesh, root, _m);
        if (!m) continue;
        const dist = _v.setFromMatrixPosition(m).distanceTo(point);
        if (dist >= r) continue;
        const f = (1 - (dist / r) ** 2) ** 2;
        const done = (sc.mesh.userData.dent as number | undefined) ?? 0;
        const step = Math.min(d * f, 0.3 - done);
        if (step <= 0) continue;
        sc.mesh.userData.dent = done + step;
        _inv.copy(podMatrix(sc.mesh.parent!, root, _m)!).invert();
        sc.mesh.position.addScaledVector(_d.copy(dir).transformDirection(_inv), step);
      }
    },
    update(anim: PodAnim) {
      const { dt, time } = anim;
      const k = 1 - Math.exp(-dt * 6);
      thr += (anim.throttle - thr) * k;
      steer += (anim.steer - steer) * (1 - Math.exp(-dt * 8));
      boost += ((anim.boosting ? 1 : 0) - boost) * (1 - Math.exp(-dt * (anim.boosting ? 8 : 3)));
      surge += ((anim.surge > 0 ? 1 : 0) - surge) * (1 - Math.exp(-dt * 6));
      const sp = Math.min(1.4, Math.max(0, anim.speed01));
      const t = time + seed;
      const dmg = anim.damage ?? NO_DAMAGE;
      const dead = anim.wrecked ? 1 : 0;
      const power = (0.35 + 0.65 * thr + 0.6 * boost + 0.35 * surge) * (1 - dead);
      const flick = 1 + 0.05 * Math.sin(t * 41) + 0.03 * Math.sin(t * 67);
      const len = lay.L * (0.45 + 0.75 * thr + 0.3 * sp) * (1 + 0.85 * boost + 0.45 * surge) * flick * (1 - 0.95 * dead);
      // A badly hurt engine sputters: its flame drops out in short, irregular gaps. Per part, its health is the
      // intake's, nozzle's and nacelle's; a lost nozzle leaves a ragged, coughing flame and a lost engine none
      // (and its fan's and petals': a jammed fan or a ring with petals gone coughs harder).
      const out = (i: number) => {
        const s = SIDES[i];
        if (detached.has(`nacelle${s}`) || partBroken.has(`nacelle${s}`)) return 0;
        let d = dmg[i] ?? 0;
        if (partHealth) {
          d = 1 - (0.25 * hp(`intake${s}`) + 0.35 * hp(`nozzle${s}`) + 0.25 * hp(`nacelle${s}`) + 0.15 * hp(`fan${s}`));
          d = Math.min(1, d + 0.1 * (1 - hp(`petals${s}`)));
          if (partBroken.has(`nozzle${s}`) || detached.has(`nozzle${s}`)) d = Math.max(d, 0.75);
          // A jammed fan chokes the engine: it coughs all the time.
          else if (partBroken.has(`fan${s}`)) d = Math.max(d, 0.65);
        }
        const cough = d > 0.4 && Math.sin(t * 23 + i * 5) * Math.sin(t * 7.3 + i * 2) > 0.75 - d * 0.6 ? 0.35 : 1;
        return (1 - 0.3 * d) * cough;
      };
      const oL = out(0);
      const oR = out(1);
      pu.uTime.value = t;
      pu.uLen.value.set(len * (1 - steer * 0.08) * oL, len * (1 + steer * 0.08) * oR);
      pu.uPower.value.set(power * oL, power * oR);
      pu.uHalo.value = lay.R * (2.2 + 1.2 * boost + 0.5 * surge);
      pu.uBoost.value = boost;
      gu.uTime.value = t;
      gu.uPulse.value = 0.5 + 0.5 * Math.sin(t * (4 + 9 * sp));
      gu.uPower.value = power;
      gu.uBoost.value = Math.max(boost, surge * 0.7);

      // Engines shake against their binders at speed, each on its own rhythm. A damaged engine shakes harder and
      // sags nose-down; a weak or snapped binder lets it hang lower and swing more.
      const amp = (0.006 + 0.022 * sp + 0.02 * boost) * (1 - dead);
      engines.forEach((g, i) => {
        const side = SIDES[i];
        if (detached.has(`nacelle${side}`)) return;
        const s = i ? 1 : -1;
        const d = partHealth
          ? Math.max(1 - hp(`nacelle${side}`), 0.5 * (1 - hp(`intake${side}`)), 0.5 * (1 - hp(`nozzle${side}`)), 0.4 * (1 - hp(`fan${side}`)))
          : (dmg[i] ?? 0);
        const hang = partHealth ? (partBroken.has(`binder${side}`) ? 1 : 0.4 * (1 - hp(`binder${side}`))) + (partBroken.has('binderMid') ? 0.3 : 0) : 0;
        const a = amp * (1 + 3 * d + 4 * hang);
        const ph = t * (57 + i * 6) + i * 2;
        g.position.set(
          s * lay.xE + Math.sin(ph) * a,
          Math.sin(ph * 1.31 + 1) * a - d * lay.R * 0.12 - hang * lay.R * 0.22,
          lay.zE + Math.sin(ph * 0.7) * a * 0.5,
        );
        g.rotation.z = Math.sin(ph * 0.53) * a * 0.25 + s * (d * 0.06 + hang * 0.1);
        g.rotation.x = -d * 0.07 - hang * 0.05 - dead * 0.12;
      });
      // Top fins lean into the turn and bend as they are battered; side flaps act as spoilers (inner one up) and
      // air brakes off throttle, and hang loose as they are torn.
      const brake = (1 - thr) * 0.35;
      for (let i = 0; i < 2; i++) {
        const side = SIDES[i];
        const fin = fins[i];
        if (fin && !detached.has(`fin${side}`)) {
          const bend = partHealth ? 1 - hp(`fin${side}`) : 0;
          fin.rotation.z = (i ? -1 : 1) * steer * 0.32 * (1 - 0.7 * bend) + bendSign * bend * 0.55;
          fin.rotation.x = bend * 0.4;
          if (!partHealth) fin.visible = (dmg[i] ?? 0) < 0.55;
        }
        const flap = flaps[i];
        if (flap && !detached.has(`flap${side}`)) {
          const inner = i ? steer : -steer;
          const rz = 0.1 + brake + Math.max(0, inner) * 0.55 - Math.max(0, -inner) * 0.15;
          const hang = partHealth ? 1 - hp(`flap${side}`) : (dmg[i] ?? 0) > 0.75 ? 1 : 0;
          flap.rotation.z = rz * (1 - hang) + hang * (1.1 + Math.sin(t * 9 + i) * 0.12);
        }
      }
      // Fans spin with the engine's power, slower and wobbling on a bent shaft as they are hurt; a broken one is jammed.
      for (let i = 0; i < 2; i++) {
        const f = fans[i];
        const id: PartId = `fan${SIDES[i]}`;
        if (!f || detached.has(id)) continue;
        const h = hp(id);
        const jam = h < 0.15;
        if (!jam) f.grp.rotation.z = (f.grp.rotation.z + dt * (6 + 40 * power) * (0.3 + 0.7 * h)) % (Math.PI * 2);
        const wob = jam ? 0 : (1 - h) * 0.07;
        f.grp.rotation.x = Math.sin(t * 31 + i) * wob;
        f.grp.rotation.y = Math.sin(t * 27 + i * 2) * wob + (jam ? 0.12 : 0);
      }
      // Badly hurt armour folds back from its leading edge into the airflow, and flutters there.
      for (const pl of plates) {
        if (detached.has(pl.part)) continue;
        const h = hp(pl.part);
        const peel = h >= 0.5 ? 0 : ((0.5 - h) / 0.5) ** 1.3;
        pl.grp.quaternion.setFromAxisAngle(pl.axis, -peel * (0.4 + Math.sin(t * (19 + 3 * pl.k)) * 0.06 * (0.3 + sp)));
      }
      // The antenna leans back, whips in the airflow at speed and bends further back (and over) as it is hit; its tip
      // light blinks.
      if (antenna && !detached.has('antenna')) {
        const bend = 1 - hp('antenna');
        antenna.grp.rotation.x = ANTENNA_LEAN + bend * 0.9 + sp * 0.2 + Math.sin(t * 13) * 0.03 * (0.5 + sp) * (1 + 2 * bend);
        antenna.grp.rotation.z = bendSign * bend * 0.45;
        if (antenna.light) antenna.light.visible = t % 1.3 < 0.18 && glowing(hp('antenna'), t, 11);
      }
      if (partHealth) {
        for (const f of flickers) if (!detached.has(f.part)) f.obj.visible = glowing(hp(f.part), t, f.k);
      } else for (const sc of scars) sc.mesh.visible = (dmg[sc.group] ?? 0) > sc.at;
    },
    dispose() {
      glowMat.dispose();
      plumeMat.dispose();
      for (const r of owned) r.dispose();
      owned.clear();
      releaseGeometry(design, quality);
      releaseShared();
    },
  };
}

const SIDES = ['L', 'R'] as const;
/** How far the antenna leans back at rest (radians). */
const ANTENNA_LEAN = 0.22;
const BINDERS: BinderId[] = ['binderL', 'binderR', 'binderMid'];
const SCARS = 16;
const COCKPIT_PART = 2;
const NO_DAMAGE = [0, 0, 0] as const;
const CRACKED = new THREE.Color('#a9b3b8');
let scarGeo: THREE.BufferGeometry | null = null;
const scarMats: THREE.Material[] = [];

/** A flat ragged blotch about 2 x 2 (local z is its normal), shared by every pod (never disposed: it is tiny). */
function scarGeometry() {
  if (scarGeo) return scarGeo;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2;
    const r = 0.72 + 0.28 * Math.abs(Math.sin(i * 2.7 + 1.3)) * (i % 2 ? 1 : 0.6);
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return (scarGeo = new THREE.ShapeGeometry(new THREE.Shape(pts)));
}

/** Soot-black scorch, or (a scrape) paint worn through to bright bare metal. Shared, never disposed. */
function scarMaterial(scrape: boolean) {
  return (scarMats[scrape ? 1 : 0] ??= new THREE.MeshStandardMaterial({
    color: scrape ? '#a59f96' : '#17110e',
    roughness: scrape ? 0.38 : 0.95,
    metalness: scrape ? 0.85 : 0.15,
    emissive: scrape ? '#000000' : '#2a0c03',
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }));
}

/** Whether a failing light is lit this frame: steady above 60% health, dead below 8%, cutting out more as it weakens. */
function glowing(h: number, t: number, k: number): boolean {
  if (h >= 0.6) return true;
  if (h <= 0.08) return false;
  const x = Math.sin(t * 29 + k * 7) * Math.sin(t * 13.7 + k * 3) + 0.3 * Math.sin(t * 71 + k);
  return x < -1.3 + 4 * h;
}

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** The transform from an object's space to the pod root's (null if it is not under the root). */
function podMatrix(obj: THREE.Object3D, root: THREE.Object3D, out: THREE.Matrix4): THREE.Matrix4 | null {
  out.identity();
  for (let o: THREE.Object3D | null = obj; o !== root; o = o.parent) {
    if (!o) return null;
    o.updateMatrix();
    out.premultiply(o.matrix);
  }
  return out;
}

/** Deepest a dent may push a part's skin (by its size, so a small part never folds through itself). */
const DENT_CAP = new WeakMap<THREE.BufferGeometry, number>();
/** How far each vertex has been pushed in so far, and how scuffed it is (0..1). */
const DENT_SUM = new WeakMap<THREE.BufferGeometry, Float32Array>();
const DENT_SCUFF = new WeakMap<THREE.BufferGeometry, Float32Array>();
/** The paint colours before any scuffing. */
const DENT_PAINT = new WeakMap<THREE.BufferGeometry, Float32Array>();

/**
 * Pushes the vertices of a (non-indexed, surface layout) geometry within `r` of `p` along `d`, by up to `depth` at the
 * centre, never past the part's cap in total, darkens the paint there (scuffed, scorched metal) and re-shades it.
 * Small dents are pushed a little deeper than asked and get a tight crease in the middle so a light knock still
 * reads; big ones are a smooth, wide bowl.
 */
function deform(g: THREE.BufferGeometry, p: THREE.Vector3, d: THREE.Vector3, depth: number, r: number) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute | undefined;
  const col = g.attributes.color as THREE.BufferAttribute | undefined;
  if (g.index || !nor) return;
  const n = pos.count;
  let sum = DENT_SUM.get(g);
  if (!sum) DENT_SUM.set(g, (sum = new Float32Array(n)));
  let scuff = DENT_SCUFF.get(g);
  if (!scuff) DENT_SCUFF.set(g, (scuff = new Float32Array(n)));
  let paint = DENT_PAINT.get(g);
  if (!paint && col) DENT_PAINT.set(g, (paint = (col.array as Float32Array).slice()));
  const cap = DENT_CAP.get(g) ?? 0.25;
  const push = depth + 0.09 * Math.max(0, 1 - depth / 0.3);
  const crease = 0.55 * Math.max(0, 1 - depth / 0.4);
  // The contact point may sit a little off the skin (the sim's hull is simpler than the model): measure from the
  // nearest skin instead, so the dent's middle lands on the skin, up to half a metre away.
  let near = Infinity;
  for (let i = 0; i < n; i++) near = Math.min(near, Math.hypot(pos.getX(i) - p.x, pos.getY(i) - p.y, pos.getZ(i) - p.z));
  const off = Math.min(near, 0.5);
  const w = new Float32Array(n);
  let moved = false;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const dist = Math.hypot(x - p.x, y - p.y, z - p.z) - off;
    if (dist >= r) continue;
    const bowl = (1 - (dist / r) ** 2) ** 2;
    const pit = Math.max(0, 1 - dist / (0.4 * r)) ** 2;
    const f = (1 - crease) * bowl + crease * pit;
    if (paint && col) {
      // Scuffed and scorched towards a burnt dark brown, most in the middle.
      scuff[i] = Math.min(1, scuff[i] + (1.4 + 4 * push) * Math.max(0, 1 - dist / (0.5 * r)) ** 1.5);
      const k = 0.92 * scuff[i];
      col.setXYZ(i, paint[i * 3] + (0.045 - paint[i * 3]) * k, paint[i * 3 + 1] + (0.03 - paint[i * 3 + 1]) * k, paint[i * 3 + 2] + (0.022 - paint[i * 3 + 2]) * k);
    }
    // A smooth ripple so it reads as crumpled metal rather than a perfect bowl. It depends only on the position, so
    // the copies of a vertex in neighbouring faces move together and the skin never tears.
    const crumple = 0.8 + 0.4 * (0.5 + 0.5 * Math.sin(x * 5.3 + z * 3.1) * Math.sin(y * 6.1 - z * 4.7));
    const step = Math.min(push * f * crumple, cap - sum[i]);
    if (step <= 0) continue;
    pos.setXYZ(i, x + d.x * step, y + d.y * step, z + d.z * step);
    sum[i] += step;
    w[i] = f;
    moved = true;
  }
  if (col) col.needsUpdate = true;
  if (!moved) return;
  pos.needsUpdate = true;
  renormal(pos, nor, w);
  g.computeBoundingSphere();
}

/**
 * New normals for the moved vertices (weight w > 0): the average of the faces that share the vertex's position and
 * lie within 60 degrees of its own face (so hard edges stay hard), blended in by the weight so the dent's rim stays
 * as smooth as the skin around it.
 */
function renormal(pos: THREE.BufferAttribute, nor: THREE.BufferAttribute, w: Float32Array) {
  const n = pos.count;
  const fn = new Float32Array(n);
  const keys: string[] = new Array(n);
  const faces = new Map<string, number[]>();
  const key = (i: number) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  for (let i = 0; i < n; i += 3) {
    if (!(w[i] || w[i + 1] || w[i + 2])) continue;
    _a.fromBufferAttribute(pos, i);
    _b.fromBufferAttribute(pos, i + 1).sub(_a);
    _c.fromBufferAttribute(pos, i + 2).sub(_a);
    _b.cross(_c);
    fn[i] = _b.x;
    fn[i + 1] = _b.y;
    fn[i + 2] = _b.z;
    for (let k = i; k < i + 3; k++) {
      const kk = (keys[k] = key(k));
      let list = faces.get(kk);
      if (!list) faces.set(kk, (list = []));
      list.push(i);
    }
  }
  for (let i = 0; i < n; i++) {
    if (!w[i]) continue;
    const t = i - (i % 3);
    _a.set(fn[t], fn[t + 1], fn[t + 2]);
    if (_a.lengthSq() < 1e-14) continue;
    _a.normalize();
    _b.set(0, 0, 0);
    for (const f of faces.get(keys[i])!) {
      _c.set(fn[f], fn[f + 1], fn[f + 2]);
      const l = _c.length();
      if (l > 0 && _c.dot(_a) > 0.5 * l) _b.add(_c);
    }
    if (_b.lengthSq() < 1e-14) continue;
    _b.normalize();
    _c.fromBufferAttribute(nor, i).lerp(_b, Math.min(1, w[i] * 2)).normalize();
    nor.setXYZ(i, _c.x, _c.y, _c.z);
  }
  nor.needsUpdate = true;
}
