// Last Light map: the Grand Meridian Hotel lobby. One map; how much of it is open depends on the party size:
// the two-storey atrium always, the lounge bar from 4 players, the restaurant from 7 (see zonesFor). Closed wings are
// sealed by a security shutter in the passage to the atrium.
//
// Everything here is declarative; world.ts turns it into chunks (the destructible pieces), solids, entrances and lockers.
// Coordinates in metres, y up, yaw 0 looks down -Z; -Z is north, where the glass facade faces the plaza. Walls and
// entrances sit on the 0.5 m chunk grid so the zombie nav cells line up with them.

import type { WeaponId } from './weapons.js';

export type Side = 'n' | 's' | 'e' | 'w';
export type Mat = 'brick' | 'plaster' | 'concrete' | 'wood' | 'metal' | 'marble' | 'travertine' | 'walnut' | 'glass';
export type ZoneId = 'atrium' | 'lounge' | 'restaurant';
export type StationKind = 'weapon' | 'ammo' | 'nades' | 'armor' | 'crate';

export interface RectDef {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ZoneDef {
  id: ZoneId;
  name: string;
  /** Floor area inside the walls. */
  rect: RectDef;
  /** Ceiling height. */
  h: number;
  /** Players (humans + bots) at match start needed to open it. */
  minPlayers: number;
}

/** One straight wall. `fixed` is the coordinate of its inner face; it extends `thick` metres in direction `out`. */
export interface WallDef {
  id: string;
  zone: ZoneId;
  along: 'x' | 'z';
  fixed: number;
  out: 1 | -1;
  thick: number;
  a0: number;
  a1: number;
  h: number;
  mat: Mat;
}

/** A gap in a wall: a passage into a wing (shutter when the wing is closed) or an alcove filled by a solid. */
export interface OpeningDef {
  wall: string;
  a0: number;
  a1: number;
  /** Top of the gap. */
  y1: number;
  /** passage: open when `zone` is open, else a shutter fills it. elevator: always filled (brass doors). */
  kind: 'passage' | 'elevator';
  zone?: ZoneId;
}

/** Where zombies break in: a boarded doorway (`door`, from the floor) or a boarded window (1 m sill). */
export interface EntranceDef {
  zone: ZoneId;
  wall: string;
  /** Centre along the wall; must be a chunk column centre (x.25 or x.75). */
  at: number;
  door: boolean;
  /** What it looks like, for the renderer. */
  look: 'revolving' | 'glassDoor' | 'serviceDoor' | 'window';
}

/** Breakable architecture built from chunks. */
export interface PropDef {
  kind: 'column' | 'desk' | 'bar';
  x: number;
  z: number;
  /** column: side length; desk/bar: long side in metres. */
  n?: number;
  /** 0: long side along x, 1: along z. */
  r?: 0 | 1;
  zone: ZoneId;
}

/** Furniture: an unbreakable collision box; the renderer puts the matching model (props.glb) on it. */
export type FurnitureKind =
  | 'sofa'
  | 'armchair'
  | 'coffeeTable'
  | 'sideTable'
  | 'floorLamp'
  | 'planter'
  | 'centerpiece'
  | 'stool'
  | 'booth'
  | 'diningTable'
  | 'luggageCart';

export interface FurnitureDef {
  kind: FurnitureKind;
  x: number;
  z: number;
  /** Direction the front faces (yaw convention of shared/math). */
  yaw: number;
  zone: ZoneId;
}

/** Footprint (width along the furniture's own x, depth along its own z) and height of each furniture kind. */
export const FURNITURE_SIZE: Record<FurnitureKind, { w: number; d: number; h: number }> = {
  sofa: { w: 2.2, d: 0.9, h: 0.85 },
  armchair: { w: 0.85, d: 0.85, h: 0.85 },
  coffeeTable: { w: 1.0, d: 1.0, h: 0.45 },
  sideTable: { w: 0.7, d: 0.7, h: 0.6 },
  floorLamp: { w: 0.4, d: 0.4, h: 1.7 },
  planter: { w: 1.0, d: 1.0, h: 0.9 },
  centerpiece: { w: 1.6, d: 1.6, h: 0.8 },
  stool: { w: 0.45, d: 0.45, h: 0.8 },
  booth: { w: 2.0, d: 1.4, h: 1.2 },
  diningTable: { w: 1.8, d: 1.8, h: 0.78 },
  luggageCart: { w: 1.1, d: 0.6, h: 1.8 },
};

export interface StationSpot {
  zone: ZoneId;
  x: number;
  z: number;
  /** The way the locker's front faces (into the room). */
  facing: Side;
}

export interface LampDef {
  x: number;
  z: number;
  /** Height of the light; default ceiling - 0.95. */
  y?: number;
  flicker?: number;
  zone?: ZoneId;
  kind?: 'chandelier' | 'pendant';
}

export interface MapDef {
  id: string;
  name: string;
  blurb: string;
  /** Bounding interior of the main room (the atrium): width (x), depth (z) and ceiling height. Kept for older code. */
  w: number;
  d: number;
  h: number;
  /** Main wall material and floor finish. */
  wall: Mat;
  floor: 'concrete' | 'wood' | 'tile' | 'marble';
  zones: ZoneDef[];
  walls: WallDef[];
  openings: OpeningDef[];
  entrances: EntranceDef[];
  /** Unbreakable posts at outer corners: [minX, maxX, minZ, maxZ, height]. */
  posts: [number, number, number, number, number][];
  /** Brass mullions in the glass facade (x positions on wall `facade`). */
  mullions: { wall: string; at: number[] };
  /** Mezzanine balconies along these walls (visual only, not walkable): depth and height. */
  mezzanine: { wall: string; depth: number; y: number }[];
  props: PropDef[];
  furniture: FurnitureDef[];
  stations: StationSpot[];
  /** Free-standing ammo crate (cheap full refill), on the floor in the open. */
  ammoCrate?: { x: number; z: number };
  /** Weapon lockers that move into a wing when it is open (the rest stay in the atrium). */
  wingItems: Partial<Record<ZoneId, WeaponId[]>>;
  lamps: LampDef[];
  spawns: { x: number; z: number }[];
  /** Direction towards the sun (golden hour), radians. Named `moon` for the older render code. */
  moon: { yaw: number; elev: number };
  lampColor?: number;
  skylights?: { x: number; z: number; w: number; d: number }[];
  /** Old-style rectangle maps only; unused by the hotel. */
  windows?: { side: Side; at: number }[];
}

const ring = (n: number, r: number, cx = 0, cz = 0) =>
  Array.from({ length: n }, (_, i) => ({ x: cx + Math.round(Math.cos((i / n) * Math.PI * 2) * r * 2) / 2, z: cz + Math.round(Math.sin((i / n) * Math.PI * 2) * r * 2) / 2 }));

const W = Math.PI / 2;
/** Yaw that faces each direction. */
export const FACE: Record<Side, number> = { n: 0, s: Math.PI, w: W, e: -W };

/** Lounge-style seating: a sofa against the wall side, two armchairs opposite, a table between. */
function seating(cx: number, cz: number, sofaFaces: Side, zone: ZoneId): FurnitureDef[] {
  const toward = sofaFaces === 'w' ? -1 : 1; // sofa on the +x side faces west
  const sofaX = cx - toward * 1.8;
  const chairX = cx + toward * 1.7;
  const chairYaw = sofaFaces === 'w' ? FACE.e : FACE.w;
  return [
    { kind: 'sofa', x: sofaX, z: cz, yaw: FACE[sofaFaces], zone },
    { kind: 'coffeeTable', x: cx, z: cz, yaw: 0, zone },
    { kind: 'armchair', x: chairX, z: cz - 1.0, yaw: chairYaw, zone },
    { kind: 'armchair', x: chairX, z: cz + 1.0, yaw: chairYaw, zone },
    { kind: 'floorLamp', x: sofaX, z: cz - 1.6, yaw: 0, zone },
  ];
}

export const HOTEL: MapDef = {
  id: 'hotel',
  name: 'Grand Meridian Hotel',
  blurb: 'A two-storey marble lobby behind a wall of glass. The lounge bar opens for 4+ players, the restaurant for 7+.',
  w: 24,
  d: 36,
  h: 12,
  wall: 'travertine',
  floor: 'marble',
  zones: [
    { id: 'atrium', name: 'Lobby', rect: { minX: -12, maxX: 12, minZ: -18, maxZ: 18 }, h: 12, minPlayers: 0 },
    { id: 'lounge', name: 'Lounge bar', rect: { minX: 12.5, maxX: 24.5, minZ: -10, maxZ: 10 }, h: 5, minPlayers: 4 },
    { id: 'restaurant', name: 'Restaurant', rect: { minX: -24.5, maxX: -12.5, minZ: -10, maxZ: 10 }, h: 5, minPlayers: 7 },
  ],
  walls: [
    // Atrium. The facade is glass between brass mullions; the side walls are shared with the wings.
    { id: 'facade', zone: 'atrium', along: 'x', fixed: -18, out: -1, thick: 0.2, a0: -12, a1: 12, h: 12, mat: 'glass' },
    { id: 'south', zone: 'atrium', along: 'x', fixed: 18, out: 1, thick: 0.4, a0: -12, a1: 12, h: 12, mat: 'travertine' },
    { id: 'atriumWest', zone: 'atrium', along: 'z', fixed: -12, out: -1, thick: 0.5, a0: -18, a1: 18, h: 12, mat: 'travertine' },
    { id: 'atriumEast', zone: 'atrium', along: 'z', fixed: 12, out: 1, thick: 0.5, a0: -18, a1: 18, h: 12, mat: 'travertine' },
    // Lounge bar (east wing).
    { id: 'loungeNorth', zone: 'lounge', along: 'x', fixed: -10, out: -1, thick: 0.4, a0: 12.5, a1: 24.5, h: 5, mat: 'travertine' },
    { id: 'loungeSouth', zone: 'lounge', along: 'x', fixed: 10, out: 1, thick: 0.4, a0: 12.5, a1: 24.5, h: 5, mat: 'travertine' },
    { id: 'loungeEast', zone: 'lounge', along: 'z', fixed: 24.5, out: 1, thick: 0.4, a0: -10, a1: 10, h: 5, mat: 'walnut' },
    // Restaurant (west wing).
    { id: 'restNorth', zone: 'restaurant', along: 'x', fixed: -10, out: -1, thick: 0.4, a0: -24.5, a1: -12.5, h: 5, mat: 'travertine' },
    { id: 'restSouth', zone: 'restaurant', along: 'x', fixed: 10, out: 1, thick: 0.4, a0: -24.5, a1: -12.5, h: 5, mat: 'travertine' },
    { id: 'restWest', zone: 'restaurant', along: 'z', fixed: -24.5, out: -1, thick: 0.4, a0: -10, a1: 10, h: 5, mat: 'walnut' },
  ],
  openings: [
    { wall: 'atriumEast', a0: -3, a1: 3, y1: 4, kind: 'passage', zone: 'lounge' },
    { wall: 'atriumWest', a0: -3, a1: 3, y1: 4, kind: 'passage', zone: 'restaurant' },
    { wall: 'south', a0: -4.5, a1: 4.5, y1: 3, kind: 'elevator' },
  ],
  entrances: [
    { zone: 'atrium', wall: 'facade', at: 0.25, door: true, look: 'revolving' },
    { zone: 'atrium', wall: 'facade', at: -4.75, door: true, look: 'glassDoor' },
    { zone: 'atrium', wall: 'facade', at: 4.75, door: true, look: 'glassDoor' },
    { zone: 'atrium', wall: 'south', at: -8.75, door: true, look: 'serviceDoor' },
    { zone: 'atrium', wall: 'south', at: 8.75, door: true, look: 'serviceDoor' },
    { zone: 'lounge', wall: 'loungeEast', at: -3.75, door: false, look: 'window' },
    { zone: 'lounge', wall: 'loungeEast', at: 3.75, door: false, look: 'window' },
    { zone: 'restaurant', wall: 'restWest', at: -3.75, door: false, look: 'window' },
    { zone: 'restaurant', wall: 'restWest', at: 3.75, door: false, look: 'window' },
  ],
  posts: [
    [-12.5, -12, -18.2, -18, 12],
    [12, 12.5, -18.2, -18, 12],
    [-12.5, -12, 18, 18.4, 12],
    [12, 12.5, 18, 18.4, 12],
    [24.5, 24.9, -10.4, -10, 5],
    [24.5, 24.9, 10, 10.4, 5],
    [-24.9, -24.5, -10.4, -10, 5],
    [-24.9, -24.5, 10, 10.4, 5],
  ],
  mullions: { wall: 'facade', at: [-9, -6, -3, 3, 6, 9] },
  mezzanine: [
    { wall: 'atriumWest', depth: 3, y: 5 },
    { wall: 'atriumEast', depth: 3, y: 5 },
  ],
  props: [
    ...[-12, -4, 4, 12].flatMap((z) => [
      { kind: 'column' as const, x: -6, z, n: 1.2, zone: 'atrium' as const },
      { kind: 'column' as const, x: 6, z, n: 1.2, zone: 'atrium' as const },
    ]),
    { kind: 'desk', x: -9.5, z: -4, n: 12, r: 1, zone: 'atrium' },
    { kind: 'bar', x: 18.5, z: -8, n: 7, r: 0, zone: 'lounge' },
  ],
  furniture: [
    ...seating(8.6, -8, 'w', 'atrium'),
    ...seating(8.6, 8, 'w', 'atrium'),
    ...seating(-8.6, 9, 'e', 'atrium'),
    { kind: 'centerpiece', x: 0, z: -8, yaw: 0, zone: 'atrium' },
    { kind: 'planter', x: -2.5, z: -16.3, yaw: 0, zone: 'atrium' },
    { kind: 'planter', x: 2.5, z: -16.3, yaw: 0, zone: 'atrium' },
    { kind: 'planter', x: -10.5, z: -16.3, yaw: 0, zone: 'atrium' },
    { kind: 'planter', x: 10.5, z: -16.3, yaw: 0, zone: 'atrium' },
    { kind: 'luggageCart', x: 3, z: 14, yaw: 0.6, zone: 'atrium' },
    ...[15.5, 16.7, 17.9, 19.1, 20.3, 21.5].map((x) => ({ kind: 'stool' as const, x, z: -6.9, yaw: FACE.n, zone: 'lounge' as const })),
    { kind: 'booth', x: 15.5, z: 8.6, yaw: FACE.n, zone: 'lounge' },
    { kind: 'booth', x: 20.5, z: 8.6, yaw: FACE.n, zone: 'lounge' },
    { kind: 'sideTable', x: 16, z: 0, yaw: 0, zone: 'lounge' },
    { kind: 'sideTable', x: 20, z: 0, yaw: 0, zone: 'lounge' },
    { kind: 'diningTable', x: -21, z: -6, yaw: 0, zone: 'restaurant' },
    { kind: 'diningTable', x: -16.5, z: -6, yaw: 0, zone: 'restaurant' },
    { kind: 'diningTable', x: -16.5, z: 0, yaw: 0, zone: 'restaurant' },
    { kind: 'diningTable', x: -21, z: 6.2, yaw: 0, zone: 'restaurant' },
    { kind: 'diningTable', x: -16.5, z: 6.2, yaw: 0, zone: 'restaurant' },
  ],
  stations: [
    { zone: 'atrium', x: -11.25, z: 17.45, facing: 'n' },
    { zone: 'atrium', x: -6.25, z: 17.45, facing: 'n' },
    { zone: 'atrium', x: 6.25, z: 17.45, facing: 'n' },
    { zone: 'atrium', x: 11.25, z: 17.45, facing: 'n' },
    { zone: 'atrium', x: 11.45, z: -15.5, facing: 'w' },
    { zone: 'atrium', x: 11.45, z: -12.5, facing: 'w' },
    { zone: 'atrium', x: 11.45, z: -5, facing: 'w' },
    { zone: 'atrium', x: 11.45, z: 5, facing: 'w' },
    { zone: 'atrium', x: 11.45, z: 12.5, facing: 'w' },
    { zone: 'atrium', x: 11.45, z: 15.5, facing: 'w' },
    { zone: 'atrium', x: -11.45, z: -15.5, facing: 'e' },
    { zone: 'atrium', x: -11.45, z: -12.5, facing: 'e' },
    { zone: 'atrium', x: -11.45, z: 5, facing: 'e' },
    { zone: 'atrium', x: -11.45, z: 12.5, facing: 'e' },
    { zone: 'atrium', x: -11.45, z: 15.5, facing: 'e' },
    { zone: 'lounge', x: 23.95, z: 0, facing: 'w' },
    { zone: 'lounge', x: 18, z: 9.45, facing: 'n' },
    { zone: 'restaurant', x: -23.95, z: 0, facing: 'e' },
    { zone: 'restaurant', x: -18, z: 9.45, facing: 'n' },
  ],
  wingItems: { lounge: ['m249', 'barrett'], restaurant: ['ak12', 'benelli'] },
  lamps: [
    { x: 0, z: -10, y: 8, kind: 'chandelier', zone: 'atrium' },
    { x: 0, z: 0, y: 8, kind: 'chandelier', zone: 'atrium' },
    { x: 0, z: 10, y: 8, kind: 'chandelier', zone: 'atrium', flicker: 0.3 },
    { x: 16, z: -3, y: 4, kind: 'pendant', zone: 'lounge' },
    { x: 21, z: 3, y: 4, kind: 'pendant', zone: 'lounge', flicker: 0.6 },
    { x: -16.5, z: -3, y: 4, kind: 'pendant', zone: 'restaurant' },
    { x: -21, z: 3, y: 4, kind: 'pendant', zone: 'restaurant' },
  ],
  spawns: ring(10, 2, 0, 3),
  ammoCrate: { x: 0, z: -1.5 },
  moon: { yaw: 0.45, elev: 0.3 },
  lampColor: 0xffc27a,
};

export const MAPS: MapDef[] = [HOTEL];

/** The zones open for a party of `players` (humans + bots) at match start. */
export function zonesFor(players: number, def: MapDef = HOTEL): ZoneId[] {
  return def.zones.filter((z) => players >= z.minPlayers).map((z) => z.id);
}

export const RANDOM_ZMAP = 'random';
/** There is one map; any id (including 'random') resolves to it. */
export const zmapById = (id: string) => MAPS.find((m) => m.id === id) ?? HOTEL;
export const ZMAP_LIST = MAPS.map(({ id, name, blurb }) => ({ id, name, blurb }));

/** What every map's lockers sell, in placement order. */
export type StationDef = { kind: StationKind; item?: WeaponId };
