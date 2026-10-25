// Pod destruction model, shared by the simulation, the pod model, the effects, the HUD and the labs. A pod is a set of
// named parts, each with a place on the pod (pod space: metres, origin at the pod's centre at hover height, nose towards
// -Z, right +X, up +Y, the same frame as the model) and a health from 1 (intact) to 0 (broken). A hit is a contact
// point and the direction the force pushes in (both in pod space) plus its energy; it damages the parts near the point
// by how close they are and how squarely they face it, so a pod that scrapes the left wall loses its left flap and fin
// first, and one that noses into a rock loses its intakes and claws.
//
// Parts that break off detach (the model hands them to the debris system). Losing a critical part (an engine's nacelle
// or the cockpit hull) wrecks the pod. Pure data and maths: no three.js objects in the state, so the headless sim can
// run it.

import type { PodShape } from './pods';

export type Side = 'L' | 'R';

/** Every destructible part. Engine parts come in pairs (L = left engine, R = right engine). */
export type PartId =
  | 'intakeL' | 'intakeR'     // the intake ring and lip at the front of each engine
  | 'fanL' | 'fanR'           // the compressor fan spinning in the intake
  | 'clawsL' | 'clawsR'       // the claws/spikes round the intake
  | 'nacelleL' | 'nacelleR'   // the engine body (critical)
  | 'finL' | 'finR'           // the raked top fin
  | 'flapL' | 'flapR'         // the side flap (outboard)
  | 'nozzleL' | 'nozzleR'     // the ribbed nozzle at the back
  | 'petalsL' | 'petalsR'     // the ring of nozzle petals round the exhaust
  | 'armTopL' | 'armTopR'     // curved armour plates over the nacelle: top,
  | 'armOutL' | 'armOutR'     //   outboard side,
  | 'armInL' | 'armInR'       //   inboard side
  | 'armBellyL' | 'armBellyR' //   and belly
  | 'binderL' | 'binderR'     // the energy binders from the cockpit to each engine
  | 'binderMid'               // the binder between the two engines
  | 'cableL' | 'cableR'       // the steering cables from the cockpit nose to the engine tops
  | 'cockpitNose'             // the cockpit's nose cone
  | 'canopy'                  // the glass canopy over the pilot
  | 'canopyFrame'             // the canopy's rim and spine (the glass sits in it)
  | 'antenna'                 // the aerial behind the canopy
  | 'mountL' | 'mountR'       // the cockpit's side mounts the binders clamp onto
  | 'stabL' | 'stabR'         // the two little stabilisers on the cockpit's tail
  | 'tail'                    // tail grille and the orange tail light
  | 'hull';                   // the cockpit shell (critical)

export const PART_IDS: PartId[] = [
  'intakeL', 'intakeR', 'fanL', 'fanR', 'clawsL', 'clawsR', 'nacelleL', 'nacelleR', 'finL', 'finR', 'flapL', 'flapR',
  'nozzleL', 'nozzleR', 'petalsL', 'petalsR', 'armTopL', 'armTopR', 'armOutL', 'armOutR', 'armInL', 'armInR',
  'armBellyL', 'armBellyR', 'binderL', 'binderR', 'binderMid', 'cableL', 'cableR', 'cockpitNose', 'canopy',
  'canopyFrame', 'antenna', 'mountL', 'mountR', 'stabL', 'stabR', 'tail', 'hull',
];

export type PartGroup = 'engineL' | 'engineR' | 'cockpit' | 'binders';

export interface PartInfo {
  group: PartGroup;
  /** Display name (HUD, labs). */
  name: string;
  /** Losing it wrecks the pod. */
  critical: boolean;
  /** Breaks off as a loose piece of debris (binders and cables snap instead: they just stop being drawn). */
  detaches: boolean;
  /** How much punishment it takes: damage is divided by this (1 = average). */
  toughness: number;
  /**
   * When this part breaks, these go with it (a broken-off nacelle takes its fin, flap, intake, claws, nozzle and
   * armour). Only the parts sitting directly on it: the intake carries its fan, so the nacelle takes the fan too.
   */
  carries?: PartId[];
  /**
   * Parts lying over this one (a nacelle's armour plates): while they are on, a hit landing on them only reaches this
   * part in part (applyHit).
   */
  shieldedBy?: PartId[];
}

export const PARTS: Record<PartId, PartInfo> = {
  intakeL: { group: 'engineL', name: 'Left intake', critical: false, detaches: true, toughness: 0.9, carries: ['fanL'] },
  intakeR: { group: 'engineR', name: 'Right intake', critical: false, detaches: true, toughness: 0.9, carries: ['fanR'] },
  // A broken fan stays in its intake (a jammed hub and a couple of blade stubs): it does not come off on its own.
  fanL: { group: 'engineL', name: 'Left fan', critical: false, detaches: false, toughness: 0.7, shieldedBy: ['intakeL'] },
  fanR: { group: 'engineR', name: 'Right fan', critical: false, detaches: false, toughness: 0.7, shieldedBy: ['intakeR'] },
  clawsL: { group: 'engineL', name: 'Left claws', critical: false, detaches: true, toughness: 0.5 },
  clawsR: { group: 'engineR', name: 'Right claws', critical: false, detaches: true, toughness: 0.5 },
  nacelleL: {
    group: 'engineL', name: 'Left engine', critical: true, detaches: true, toughness: 1.6,
    carries: ['intakeL', 'clawsL', 'finL', 'flapL', 'nozzleL', 'armTopL', 'armOutL', 'armInL', 'armBellyL'],
    shieldedBy: ['armTopL', 'armOutL', 'armInL', 'armBellyL'],
  },
  nacelleR: {
    group: 'engineR', name: 'Right engine', critical: true, detaches: true, toughness: 1.6,
    carries: ['intakeR', 'clawsR', 'finR', 'flapR', 'nozzleR', 'armTopR', 'armOutR', 'armInR', 'armBellyR'],
    shieldedBy: ['armTopR', 'armOutR', 'armInR', 'armBellyR'],
  },
  finL: { group: 'engineL', name: 'Left fin', critical: false, detaches: true, toughness: 0.45 },
  finR: { group: 'engineR', name: 'Right fin', critical: false, detaches: true, toughness: 0.45 },
  flapL: { group: 'engineL', name: 'Left flap', critical: false, detaches: true, toughness: 0.5 },
  flapR: { group: 'engineR', name: 'Right flap', critical: false, detaches: true, toughness: 0.5 },
  nozzleL: { group: 'engineL', name: 'Left nozzle', critical: false, detaches: true, toughness: 0.9, carries: ['petalsL'] },
  nozzleR: { group: 'engineR', name: 'Right nozzle', critical: false, detaches: true, toughness: 0.9, carries: ['petalsR'] },
  petalsL: { group: 'engineL', name: 'Left nozzle petals', critical: false, detaches: true, toughness: 0.4 },
  petalsR: { group: 'engineR', name: 'Right nozzle petals', critical: false, detaches: true, toughness: 0.4 },
  // Armour goes long before the engine under it (about a third of its toughness) and soaks up what lands on it.
  armTopL: { group: 'engineL', name: 'Left top armour', critical: false, detaches: true, toughness: 0.55 },
  armTopR: { group: 'engineR', name: 'Right top armour', critical: false, detaches: true, toughness: 0.55 },
  armOutL: { group: 'engineL', name: 'Left side armour', critical: false, detaches: true, toughness: 0.55 },
  armOutR: { group: 'engineR', name: 'Right side armour', critical: false, detaches: true, toughness: 0.55 },
  armInL: { group: 'engineL', name: 'Left inner armour', critical: false, detaches: true, toughness: 0.55 },
  armInR: { group: 'engineR', name: 'Right inner armour', critical: false, detaches: true, toughness: 0.55 },
  armBellyL: { group: 'engineL', name: 'Left belly armour', critical: false, detaches: true, toughness: 0.6 },
  armBellyR: { group: 'engineR', name: 'Right belly armour', critical: false, detaches: true, toughness: 0.6 },
  binderL: { group: 'binders', name: 'Left binder', critical: false, detaches: false, toughness: 0.7 },
  binderR: { group: 'binders', name: 'Right binder', critical: false, detaches: false, toughness: 0.7 },
  binderMid: { group: 'binders', name: 'Centre binder', critical: false, detaches: false, toughness: 0.7 },
  cableL: { group: 'binders', name: 'Left cable', critical: false, detaches: false, toughness: 0.35 },
  cableR: { group: 'binders', name: 'Right cable', critical: false, detaches: false, toughness: 0.35 },
  cockpitNose: { group: 'cockpit', name: 'Cockpit nose', critical: false, detaches: true, toughness: 0.8 },
  canopy: { group: 'cockpit', name: 'Canopy', critical: false, detaches: true, toughness: 0.5 },
  canopyFrame: { group: 'cockpit', name: 'Canopy frame', critical: false, detaches: true, toughness: 0.75, carries: ['canopy'] },
  antenna: { group: 'cockpit', name: 'Antenna', critical: false, detaches: true, toughness: 0.3 },
  // A mount that tears off takes its binder (nothing holds it on the cockpit side any more).
  mountL: { group: 'cockpit', name: 'Left mount', critical: false, detaches: true, toughness: 1.0, carries: ['binderL'] },
  mountR: { group: 'cockpit', name: 'Right mount', critical: false, detaches: true, toughness: 1.0, carries: ['binderR'] },
  stabL: { group: 'cockpit', name: 'Left stabiliser', critical: false, detaches: true, toughness: 0.4 },
  stabR: { group: 'cockpit', name: 'Right stabiliser', critical: false, detaches: true, toughness: 0.4 },
  tail: { group: 'cockpit', name: 'Tail', critical: false, detaches: true, toughness: 0.7 },
  hull: {
    group: 'cockpit', name: 'Cockpit', critical: true, detaches: false, toughness: 1.8,
    carries: ['cockpitNose', 'canopyFrame', 'antenna', 'mountL', 'mountR', 'stabL', 'stabR', 'tail'],
  },
};

/** Where a part sits on a pod of a given shape: centre (pod space) and rough radius, metres. */
export interface PartAnchor {
  pos: [number, number, number];
  r: number;
  /** Long parts (the nacelles, the hull) are capsules: half the length of their core segment along Z. */
  len?: number;
}

/** Closest point of an anchor's core (its centre, or the segment of a capsule) to a point. */
function coreNear(a: PartAnchor, x: number, y: number, z: number): [number, number, number] {
  const len = a.len ?? 0;
  return [a.pos[0], a.pos[1], Math.max(a.pos[2] - len, Math.min(a.pos[2] + len, z))];
}

/**
 * The pod's layout, the same maths as the model's (vehicle/pod.ts layoutOf): engine centres at (±xE, 0, zE), each
 * L long and R in radius; the cockpit at (0, yC, zC) with half width ca and half height cb.
 */
export function podLayout(shape: PodShape) {
  const { engineLength: L, engineRadius: R, engineSpread, cockpitLength: C, cockpitTrail: T } = shape;
  const trail = 0.25 * L + 0.1 * T;
  const zE = -(trail + C / 2 - L / 2) / 2;
  const ca = 0.55 + 0.3 * R;
  return { L, R, C, xE: engineSpread / 2, zE, yC: 0.32, zC: zE + trail, ca, cb: ca * 0.84 };
}

/** Anchors of every part for a pod shape. */
export function partAnchors(shape: PodShape): Record<PartId, PartAnchor> {
  const { L, R, C, xE, zE, yC, zC, ca, cb } = podLayout(shape);
  const out = {} as Record<PartId, PartAnchor>;
  // The nacelle's section is squashed by the wedge (vehicle/pod.ts buildEngine); its armour lies over the skin from
  // 28 % to 49 % of its length.
  const sy = 1 - 0.28 * shape.wedge;
  const zArm = zE - 0.115 * L;
  for (const [s, k] of [[-1, 'L'], [1, 'R']] as const) {
    const x = s * xE;
    out[`intake${k}`] = { pos: [x, 0, zE - L / 2 + 0.05 * L], r: R * 0.95 };
    out[`fan${k}`] = { pos: [x, 0, zE - L / 2 + 0.12 * L], r: R * 0.5 };
    out[`petals${k}`] = { pos: [x, 0, zE + L / 2 + 0.02 * L], r: R * 0.7 };
    out[`armTop${k}`] = { pos: [x, R * 1.1 * sy, zArm], r: R * 0.4, len: 0.08 * L };
    out[`armOut${k}`] = { pos: [x + s * R * 1.1, 0, zArm], r: R * 0.4, len: 0.08 * L };
    out[`armIn${k}`] = { pos: [x - s * R * 1.1, 0, zArm], r: R * 0.32, len: 0.08 * L };
    out[`armBelly${k}`] = { pos: [x, -R * 1.1 * sy, zArm], r: R * 0.32, len: 0.08 * L };
    out[`mount${k}`] = { pos: [s * (ca + 0.12), yC, zC], r: 0.35 };
    out[`claws${k}`] = { pos: [x, -0.2 * R, zE - L / 2 - 0.05 * L], r: R * 0.8 };
    out[`nacelle${k}`] = { pos: [x, 0, zE], r: R * 1.05, len: L / 2 - R * 0.7 };
    out[`fin${k}`] = { pos: [x, R * 1.5, zE + 0.05 * L], r: R * 0.8 };
    out[`flap${k}`] = { pos: [x + s * R * 1.15, 0, zE + 0.1 * L], r: R * 0.7 };
    out[`nozzle${k}`] = { pos: [x, 0, zE + L / 2 - 0.08 * L], r: R * 0.95 };
    out[`binder${k}`] = { pos: [x / 2, yC * 0.5, (zE + zC) / 2], r: 0.6 };
    out[`cable${k}`] = { pos: [x / 2, R * 0.9, (zE - L / 4 + zC - C / 2) / 2], r: 0.4 };
    out[`stab${k}`] = { pos: [s * ca * 0.9, yC + cb * 0.3, zC + C * 0.4], r: 0.4 };
  }
  out.binderMid = { pos: [0, 0, zE - L * 0.15], r: 0.6 };
  out.cockpitNose = { pos: [0, yC, zC - C / 2], r: ca * 0.8 };
  out.canopy = { pos: [0, yC + cb * 0.8, zC - C * 0.05], r: ca * 0.6 };
  out.canopyFrame = { pos: [0, yC + cb * 0.68, zC - C * 0.12], r: ca * 0.62 };
  out.antenna = { pos: [0, yC + cb + 0.45, zC + C * 0.32], r: 0.3 };
  out.tail = { pos: [0, yC, zC + C / 2], r: ca * 0.7 };
  out.hull = { pos: [0, yC, zC], r: ca * 1.1, len: Math.max(0, C / 2 - ca) };
  return out;
}

export type HitKind = 'wall' | 'rock' | 'pod' | 'landing' | 'ground';

/** One contact, in pod space. */
export interface Hit {
  /** Where the pod was touched. */
  point: [number, number, number];
  /** Unit direction the force pushes the pod (into it, away from what it hit). */
  dir: [number, number, number];
  /** Strength, roughly 0 (a brush) .. 1 (a hard crash) .. 2 (a wreck's first impact). */
  energy: number;
  kind: HitKind;
}

/** Health of every part (1 = intact, 0 = broken) and which have broken. */
export interface PodDamage {
  health: Record<PartId, number>;
  broken: Set<PartId>;
}

export function newPodDamage(): PodDamage {
  const health = {} as Record<PartId, number>;
  for (const id of PART_IDS) health[id] = 1;
  return { health, broken: new Set() };
}

/** What one hit did to one part. */
export interface PartHit {
  part: PartId;
  /** Damage taken by this hit, and health after it. */
  amount: number;
  health: number;
  /** It broke with this hit (parts it carries are listed as broken too). */
  broke: boolean;
}

/** Damage scale and falloff distance (m) of a hit: a part takes K * energy² * exp(-gap / FALLOFF) / toughness. */
const HIT_K = 1;
const FALLOFF = 1.1;
/** Most of a hit an intact plate keeps off the part under it, and how fast that fades as the hit lands off the plate. */
const SHIELD = 0.45;
const SHIELD_FALLOFF = 0.5;

/**
 * Applies a hit: each part takes damage by the gap between the contact point and the part's surface (falling off over
 * about a metre, so a hit on one engine's flap barely reaches the other engine), divided by its toughness. Damage grows
 * with the square of the energy, so brushes and scrapes only chip the parts they touch while a hard crash breaks
 * them. Parts deeper along the push than the contact (shielded by what is in front of them) take a little less, and a
 * part under armour (`shieldedBy`) takes up to 45 % less while the plate the hit landed on is still on, by how close to
 * the plate it landed and how much of the plate is left. A part that reaches 0 breaks and takes the parts it carries
 * with it. Returns what changed, most damaged first.
 *
 * Contract: deterministic given its inputs; never revives a broken part.
 */
export function applyHit(dmg: PodDamage, anchors: Record<PartId, PartAnchor>, hit: Hit): PartHit[] {
  const out: PartHit[] = [];
  const [px, py, pz] = hit.point;
  const [dx, dy, dz] = hit.dir;
  const e2 = hit.energy * hit.energy * HIT_K;
  const gapOf = (a: PartAnchor) => {
    const [cx, cy, cz] = coreNear(a, px, py, pz);
    return Math.max(0, Math.hypot(cx - px, cy - py, cz - pz) - a.r);
  };
  // Shields as they were before this hit (a plate that breaks with it still took the blow for what is under it).
  const shield = (id: PartId) => {
    let k = 0;
    for (const c of PARTS[id].shieldedBy ?? []) {
      if (!dmg.broken.has(c)) k = Math.max(k, dmg.health[c] * Math.exp(-gapOf(anchors[c]) / SHIELD_FALLOFF));
    }
    return k;
  };
  for (const id of PART_IDS) {
    if (dmg.broken.has(id)) continue;
    const a = anchors[id];
    const [cx, cy, cz] = coreNear(a, px, py, pz);
    const ox = cx - px;
    const oy = cy - py;
    const oz = cz - pz;
    const gap = Math.max(0, Math.hypot(ox, oy, oz) - a.r);
    const depth = Math.max(0, ox * dx + oy * dy + oz * dz - a.r);
    const covered = PARTS[id].shieldedBy ? 1 - SHIELD * shield(id) : 1;
    const amount = (e2 * Math.exp(-gap / FALLOFF) * (1 - 0.3 * Math.min(1, depth / 3)) * covered) / PARTS[id].toughness;
    if (amount < 0.005) continue;
    const health = Math.max(0, dmg.health[id] - amount);
    dmg.health[id] = health;
    out.push({ part: id, amount, health, broke: false });
  }
  for (const h of out) {
    if (h.health > 0 || dmg.broken.has(h.part)) continue;
    h.broke = true;
    breakPart(dmg, h.part, out);
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/**
 * The hits of a pod meeting a flat surface (the ground on a landing or a wreck's bounce, a wall a wreck slides into):
 * `toward` is the unit direction to the surface in pod space (for the ground, the world's down rotated into the pod).
 * The parts reaching furthest that way touch it: the deepest takes most of the energy and the ones nearly as deep
 * share in it, so a flat landing lands on both engines, a pod on its back on its fins and canopy, one on its side on
 * that side's flap. Broken parts (when `dmg` is given) are gone and let the next ones down take it. The energies are
 * split so their squares add up to energy², the same total damage as one hit.
 */
export function contactHits(
  anchors: Record<PartId, PartAnchor>,
  toward: [number, number, number],
  energy: number,
  kind: HitKind,
  dmg?: PodDamage,
): Hit[] {
  const [tx, ty, tz] = toward;
  const BAND = 1.1;
  const reach = (a: PartAnchor) => a.pos[0] * tx + a.pos[1] * ty + a.pos[2] * tz + (a.len ?? 0) * Math.abs(tz) + a.r;
  // A broken hull is still there (it does not come off); everything else that broke is gone.
  const there = (id: PartId) => !dmg?.broken.has(id) || id === 'hull';
  let deepest = -Infinity;
  for (const id of PART_IDS) if (there(id)) deepest = Math.max(deepest, reach(anchors[id]));
  const cands = PART_IDS.filter((id) => there(id) && reach(anchors[id]) >= deepest - BAND)
    .map((id) => ({ id, d: reach(anchors[id]) }))
    .sort((p, q) => q.d - p.d);
  const picked: { point: [number, number, number]; w: number }[] = [];
  for (const { id, d } of cands) {
    if (picked.length >= 4) break;
    const a = anchors[id];
    const zc = a.pos[2] + (a.len ?? 0) * Math.sign(tz);
    const point: [number, number, number] = [a.pos[0] + tx * a.r, a.pos[1] + ty * a.r, zc + tz * a.r];
    // Parts touching at nearly the same place are one contact.
    if (picked.some((p) => Math.hypot(p.point[0] - point[0], p.point[1] - point[1], p.point[2] - point[2]) < 1.6)) continue;
    picked.push({ point, w: Math.max(0.15, 1 - (deepest - d) / BAND) });
  }
  const sum = picked.reduce((t, p) => t + p.w, 0);
  return picked.map((p) => ({ point: p.point, dir: [-tx, -ty, -tz], energy: energy * Math.sqrt(p.w / sum), kind }));
}

/**
 * A vector given in the track frame (x right across the course, y up, z back along it, so -z points down the course
 * like a pod's nose) in the space of a pod turned by yaw (about up, + = nose left), pitch (about its right, + = nose up)
 * and roll (about its length, + = right side up), applied in that order, the same as three.js's Euler 'YXZ'
 * (the wreck tumble) and the knife-edge roll (roll = -knife * PI / 2) of the renderer.
 */
export function toPodSpace(x: number, y: number, z: number, yaw: number, pitch = 0, roll = 0): [number, number, number] {
  // Undo the yaw, then the pitch, then the roll (the transpose of Ry * Rx * Rz).
  let c = Math.cos(yaw);
  let s = Math.sin(yaw);
  const x1 = x * c - z * s;
  const z1 = x * s + z * c;
  c = Math.cos(pitch);
  s = Math.sin(pitch);
  const y2 = y * c + z1 * s;
  const z2 = -y * s + z1 * c;
  c = Math.cos(roll);
  s = Math.sin(roll);
  return [x1 * c + y2 * s, -x1 * s + y2 * c, z2];
}

function breakPart(dmg: PodDamage, id: PartId, out: PartHit[]) {
  dmg.broken.add(id);
  dmg.health[id] = 0;
  for (const c of PARTS[id].carries ?? []) {
    if (dmg.broken.has(c)) continue;
    const h = out.find((o) => o.part === c);
    if (h) {
      h.health = 0;
      h.broke = true;
    } else out.push({ part: c, amount: dmg.health[c], health: 0, broke: true });
    breakPart(dmg, c, out);
  }
}

/** A head-on crash: the cockpit and the engine on the struck side break outright (with everything they carry). */
export function shatter(dmg: PodDamage, side: number): PartHit[] {
  const out: PartHit[] = [];
  for (const id of ['hull', side < 0 ? 'nacelleL' : 'nacelleR'] as PartId[]) {
    if (dmg.broken.has(id)) continue;
    out.push({ part: id, amount: dmg.health[id], health: 0, broke: true });
    breakPart(dmg, id, out);
  }
  return out;
}

/** True once a critical part has broken. */
export function isWrecked(dmg: PodDamage): boolean {
  return PART_IDS.some((id) => PARTS[id].critical && dmg.broken.has(id));
}

/**
 * The old three-number summary (left engine, right engine, cockpit, 0 = fine .. 1 = gone) that the smoke, the scars
 * and the HUD bars use: the worst of each group's parts, weighted towards its critical part.
 */
export function damageSummary(dmg: PodDamage): [number, number, number] {
  const group = (g: PartGroup, core: PartId) => {
    let worst = 0;
    for (const id of PART_IDS) if (PARTS[id].group === g) worst = Math.max(worst, (1 - dmg.health[id]) * (id === core ? 1 : 0.6));
    return Math.min(1, worst);
  };
  return [group('engineL', 'nacelleL'), group('engineR', 'nacelleR'), group('cockpit', 'hull')];
}
