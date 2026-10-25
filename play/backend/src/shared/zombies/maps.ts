// Last Light maps: one closed room each, with barricaded windows, a few destructible props and a dark yard outside.
// Everything here is declarative; world.ts turns a map into chunks (the destructible pieces), solids and windows.
// Sizes must be multiples of 0.5 m (the chunk size) so walls, windows and the zombie nav grid line up.

import type { WeaponId } from './weapons.js';

export type Side = 'n' | 's' | 'e' | 'w';
export type Mat = 'brick' | 'plaster' | 'concrete' | 'wood' | 'metal';

export interface PropDef {
  kind: 'crate' | 'pillar' | 'lowwall' | 'pew' | 'altar' | 'tank' | 'table';
  x: number;
  z: number;
  /** 0: long side along x, 1: along z. */
  r?: 0 | 1;
  /** Stack height (crates) or length in metres (low walls, pews). */
  n?: number;
}

export type StationKind = 'weapon' | 'ammo' | 'nades' | 'armor';

export interface MapDef {
  id: string;
  name: string;
  blurb: string;
  /** Interior width (x), depth (z) and ceiling height. */
  w: number;
  d: number;
  h: number;
  wall: Mat;
  floor: 'concrete' | 'wood' | 'tile';
  windows: { side: Side; at: number }[];
  props: PropDef[];
  lamps: { x: number; z: number; flicker?: number }[];
  skylights?: { x: number; z: number; w: number; d: number }[];
  spawns: { x: number; z: number }[];
  /** Moonlight direction (towards the moon): yaw around y and elevation, radians. */
  moon: { yaw: number; elev: number };
  /** Emergency light colour for the lamps (0xRRGGBB); default warm tungsten. */
  lampColor?: number;
}

const ring = (n: number, r: number, cx = 0, cz = 0) =>
  Array.from({ length: n }, (_, i) => ({ x: cx + Math.round(Math.cos((i / n) * Math.PI * 2) * r * 2) / 2, z: cz + Math.round(Math.sin((i / n) * Math.PI * 2) * r * 2) / 2 }));

export const MAPS: MapDef[] = [
  {
    id: 'storage',
    name: 'Cold Storage',
    blurb: 'A gutted brick warehouse. Concrete pillars, crates and eight windows.',
    w: 24,
    d: 30,
    h: 5,
    wall: 'brick',
    floor: 'concrete',
    windows: [
      { side: 'n', at: -6 },
      { side: 'n', at: 6 },
      { side: 's', at: -6 },
      { side: 's', at: 6 },
      { side: 'e', at: -7 },
      { side: 'e', at: 7 },
      { side: 'w', at: -7 },
      { side: 'w', at: 7 },
    ],
    props: [
      { kind: 'pillar', x: -5, z: -8 },
      { kind: 'pillar', x: 5, z: -8 },
      { kind: 'pillar', x: -5, z: 0 },
      { kind: 'pillar', x: 5, z: 0 },
      { kind: 'pillar', x: -5, z: 8 },
      { kind: 'pillar', x: 5, z: 8 },
      { kind: 'crate', x: -8.5, z: -11, n: 2 },
      { kind: 'crate', x: -7.5, z: -11, n: 1 },
      { kind: 'crate', x: 8.5, z: 11, n: 1 },
      { kind: 'crate', x: 2, z: -4, n: 1 },
      { kind: 'crate', x: -2.5, z: 5, n: 2 },
      { kind: 'crate', x: 8.5, z: -3, n: 1 },
      { kind: 'lowwall', x: 0, z: 10.5, r: 0, n: 3 },
      { kind: 'lowwall', x: 0, z: -11, r: 0, n: 2 },
      { kind: 'table', x: -8.5, z: 4 },
    ],
    lamps: [{ x: 0, z: -9 }, { x: 0, z: 0, flicker: 0.6 }, { x: 0, z: 9 }, { x: -8, z: -3 }, { x: 8, z: 4, flicker: 1 }],
    skylights: [{ x: 7.5, z: -7.5, w: 2.5, d: 2.5 }],
    spawns: ring(10, 2),
    moon: { yaw: 0.6, elev: 0.42 },
  },
  {
    id: 'chapel',
    name: 'St. Agnes Chapel',
    blurb: 'A tall plaster nave with rows of wooden pews and an altar. Long sight lines, nowhere to hide.',
    w: 16,
    d: 30,
    h: 7,
    wall: 'plaster',
    floor: 'wood',
    windows: [
      { side: 'e', at: -9 },
      { side: 'e', at: -2 },
      { side: 'e', at: 5 },
      { side: 'w', at: -9 },
      { side: 'w', at: -2 },
      { side: 'w', at: 5 },
      { side: 's', at: -4 },
      { side: 's', at: 4 },
    ],
    props: [
      { kind: 'altar', x: 0, z: -12.5 },
      ...[-8, -5.5, -3, -0.5, 2, 4.5, 7].flatMap((z) => [
        { kind: 'pew' as const, x: -4.25, z, n: 3.5 },
        { kind: 'pew' as const, x: 4.25, z, n: 3.5 },
      ]),
    ],
    lamps: [{ x: 0, z: -9 }, { x: 0, z: -1, flicker: 0.8 }, { x: 0, z: 7 }, { x: 0, z: 12.5 }],
    spawns: ring(10, 1.5, 0, 11),
    moon: { yaw: -1.1, elev: 0.5 },
    lampColor: 0xffa860,
  },
  {
    id: 'station',
    name: 'Pumping Station',
    blurb: 'A low concrete bunker around two steel tanks. Tough walls, tight corners.',
    w: 22,
    d: 22,
    h: 4.5,
    wall: 'concrete',
    floor: 'tile',
    windows: [
      { side: 'n', at: -5 },
      { side: 'n', at: 5 },
      { side: 's', at: -5 },
      { side: 's', at: 5 },
      { side: 'e', at: -5 },
      { side: 'e', at: 5 },
      { side: 'w', at: -5 },
      { side: 'w', at: 5 },
    ],
    props: [
      { kind: 'tank', x: -4.5, z: -4.5 },
      { kind: 'tank', x: 4.5, z: 4.5 },
      { kind: 'lowwall', x: 0, z: -6.5, r: 0, n: 3 },
      { kind: 'lowwall', x: 0, z: 6.5, r: 0, n: 3 },
      { kind: 'lowwall', x: -6.5, z: 0, r: 1, n: 3 },
      { kind: 'lowwall', x: 6.5, z: 0, r: 1, n: 3 },
      { kind: 'crate', x: -6.5, z: 6.5, n: 2 },
      { kind: 'crate', x: 6.5, z: -6.5, n: 1 },
      { kind: 'pillar', x: -2, z: 2 },
      { kind: 'pillar', x: 2, z: -2 },
    ],
    lamps: [{ x: -5, z: -5 }, { x: 5, z: -5, flicker: 1 }, { x: -5, z: 5 }, { x: 5, z: 5 }, { x: 0, z: 0, flicker: 0.4 }],
    skylights: [{ x: -1.5, z: -1.5, w: 2, d: 2 }],
    spawns: ring(10, 1.5),
    moon: { yaw: 2.2, elev: 0.38 },
    lampColor: 0xd8e4ff,
  },
];

export const RANDOM_ZMAP = 'random';
export const zmapById = (id: string) => MAPS.find((m) => m.id === id);
export const ZMAP_LIST = MAPS.map(({ id, name, blurb }) => ({ id, name, blurb }));

/** What every map's lockers sell, in placement order. */
export type StationDef = { kind: StationKind; item?: WeaponId };
