// The Rockets map pool. Every map is built with rotational symmetry (quad or pair) so no spawn side is favoured.
// Heights are tuned to the movement in constants.ts: a plain jump clears about 2.3 m, a rocket jump well over 15 m.

import { v3 } from '../math.js';
import { MapBuilder as B, type MapData } from './map.js';

/**
 * The original arena, scaled up: a dais with a furnace in the middle, and a raised ring all the way round the walls,
 * ledges in the middle of each side climbing to gantries in the corners, each side marked by its own coloured chimney.
 */
function foundry(): MapData {
  const half = 32;
  const b = new B().shell(half, 10);
  // The same shapes in every quarter, each quarter in its own colour, so players can tell where they are.
  const marks = (kinds: MapData['boxes'][number]['kind'][], piece: (p: B) => void) => {
    const all = (kinds.length === 2 ? new B().pair(piece) : new B().quad(piece)).boxes;
    all.forEach((m, i) => b.box(kinds[Math.floor((i * kinds.length) / all.length)], m.min.x, m.min.y, m.min.z, m.max.x, m.max.y, m.max.z));
  };
  const platH = 3;
  const ring = 4;
  const gantry = 6;
  // The furnace blocks the views across the dais; its top and health pack are a rocket jump away.
  b.block('platform', 0, 0, 8, 8, platH).block('stair', 0, 0, 2.5, 2.5, 8).pack(0, 8, 0);
  b.pair((p) => p.stairs('z', -1, 0, 8 + B.run(0, platH), 5, 0, platH).pack(5, platH, 5));
  // Chimneys straddle the wall ledges: walk under the arch, but nobody sees along the whole ring.
  marks(['tower', 'pillar', 'crate', 'ledge'], (p) => p.box('tower', 25, 0, -1.5, 27, 15, 1.5).box('tower', 27, ring + 2.4, -1.5, half, 15, 1.5));
  b.quad((p) => {
    const steps = B.run(ring, gantry);
    p.box('platform', half - 5, 0, -10 - steps, half, ring, 10 + steps).stairs('x', 1, half - 5 - B.run(0, ring), 6, 3, 0, ring);
    p.stairs('z', 1, half - 2.5, 10, 5, ring, gantry).box('platform', half - 5, 0, 10 + steps, half, gantry, 22);
    p.stairs('z', -1, half - 2.5, -10, 5, ring, gantry).box('platform', half - 5, 0, -22, half, gantry, -10 - steps);
    p.box('platform', 22, 0, 22, half, gantry, half).padTo(v3(18, 0, 11), v3(26, gantry, 26));
    // Floor cover: pillars and a block on the gantry-to-gantry diagonal, a low wall in front of each dais staircase.
    p.block('stair', 11.5, 11.5, 1.2, 1.2, 9).block('stair', 16.2, 16.2, 1.4, 1.4, 2.2);
    p.block('stair', 0, 21, 3, 0.6, 2.2).pack(0, 0, 23.5);
    p.block('stair', 19, -6, 1, 1, 1.4);
    p.spawn(13.5, 0, 17.5).spawn(28, gantry, 28).spawn(29.5, ring, -6);
  });
  return b.build({ id: 'foundry', accent: 0x2ed8a0, name: 'Foundry', half, skyColor: 0x3f9be8, fogColor: 0x5aa0e0, tint: { stair: 0x56607a, wall: 0xa04a32 } });
}

/** Floating islands over the void, joined by narrow bridges and pads; fall off and you are gone. */
function skyway(): MapData {
  const half = 40;
  const b = new B().shell(half, 0, false);
  // The same shapes in every quarter, each quarter in its own colour, so players can tell where they are.
  const marks = (kinds: MapData['boxes'][number]['kind'][], piece: (p: B) => void) => {
    const all = (kinds.length === 2 ? new B().pair(piece) : new B().quad(piece)).boxes;
    all.forEach((m, i) => b.box(kinds[Math.floor((i * kinds.length) / all.length)], m.min.x, m.min.y, m.min.z, m.max.x, m.max.y, m.max.z));
  };
  b.box('floor', -10, -1, -10, 10, 0, 10);
  // The hub's beacon breaks the corner-to-corner sightlines and is visible from every island.
  b.block('platform', 0, 0, 3.5, 3.5, 2).block('pillar', 0, 0, 1.2, 1.2, 9, 2);
  b.pair((p) => p.stairs('z', -1, 0, 3.5 + B.run(0, 2), 3, 0, 2).pack(2.6, 2, 2.6).spawn(-8, 0, 8));
  marks(['platform', 'ledge', 'tower', 'crate'], (p) => p.box('platform', 21, 4, 21, 31, 5, 31));
  b.quad((p) => {
    p.block('pillar', 6.5, 6.5, 0.7, 0.7, 3.5);
    p.box('platform', 10, -1, -1.2, 19, 0, 1.2).pack(14.5, 0, 0);
    // Side island: a wall to duck behind when you come off the bridge, and a pad up to the next corner island.
    p.box('floor', 19, -1, -7, 33, 0, 7).block('pillar', 23, 0, 0.6, 2.6, 3.5).spawn(29, 0, -4);
    p.padTo(v3(30, 0, 4), v3(26, 5, 24), 1.6);
    // Corner island, five metres up: stairs down to the next island round, a pad back to the hub.
    p.block('pillar', 22.5, 28, 1.2, 1, 6.8, 5).spawn(27, 5, 28).pack(29, 5, 24.5);
    p.stairs('x', 1, 7, 25, 4, 0, 5).box('platform', 7 + B.run(0, 5), 4, 23, 21, 5, 27);
    p.padTo(v3(23.5, 5, 23.5), v3(4, 0, 7.5), 2);
  });
  return b.build({
    id: 'skyway',
    accent: 0xff5ea8,
    name: 'Skyway',
    half,
    skyColor: 0x2f8cf0,
    fogColor: 0x2a7ad8,
    tint: { floor: 0x9ad06a, platform: 0xf2c14e, stair: 0xe8a840, pillar: 0xf4f0e8, crate: 0x4ad0e0 },
  });
}

/** Two sandstone plateaus either side of a canyon, linked by high bridges, rock columns and pads. */
function canyon(): MapData {
  const half = 34;
  const b = new B().shell(half, 12);
  // The same shapes on both sides, each side in its own colour, so players can tell where they are.
  const marks = (kinds: MapData['boxes'][number]['kind'][], piece: (p: B) => void) => {
    const all = (kinds.length === 2 ? new B().pair(piece) : new B().quad(piece)).boxes;
    all.forEach((m, i) => b.box(kinds[Math.floor((i * kinds.length) / all.length)], m.min.x, m.min.y, m.min.z, m.max.x, m.max.y, m.max.z));
  };
  const top = 6;
  b.block('crate', 0, 0, 1.5, 1.5, 2.2);
  marks(['tower', 'platform'], (p) => p.block('tower', 26, 26, 4, 4, 11));
  b.pair((p) => {
    p.box('ledge', 14, 0, -half, half, top, half);
    p.stairs('x', 1, 14 - B.run(0, top), 0, 4, 0, top).stairs('x', 1, 14 - B.run(0, top), half - 1.75, 3.5, 0, top);
    p.box('platform', -14, top - 0.5, 18, 14, top, 22).pack(0, top, 20);
    p.padTo(v3(8, 0, 10), v3(22, top, 10));
    // Up the tower, and from its top a cannon across the canyon to the far plateau.
    p.padTo(v3(26, top, 16), v3(26, 11, 26)).padTo(v3(23, 11, 23), v3(-24, top, 12), 5, 1);
    // The far end of the trench throws you up onto the plateau instead of leaving you in a corner.
    p.padTo(v3(-8, 0, 30), v3(-24, top, 28), 3);
    // Rock columns too tall to stand on break the long views along the plateau and down the trench.
    p.block('pillar', 24, 8, 1.8, 1.8, 14.5).block('pillar', 21, -20, 2, 2, 14.5).block('pillar', 6, 26, 1, 1, 14.5);
    p.block('crate', 20, -6, 1, 1, top + 1.8, top).block('crate', 29, -12, 1.2, 1.2, top + 2, top);
    p.block('crate', 3, 13, 1.8, 1.8, 2.2);
    p.spawn(24, top, 0).spawn(26, top, -24).spawn(10, 0, 27).spawn(-6, 0, 10).spawn(27, 11, 27);
    p.pack(30, top, 0).pack(0, 0, -28);
  });
  return b.build({
    id: 'canyon',
    accent: 0x3ec8ff,
    name: 'Canyon',
    half,
    skyColor: 0xff8a4a,
    fogColor: 0xe07838,
    tint: { floor: 0xe8b27a, ledge: 0xe8a050, wall: 0x9a3a2a, platform: 0xe0b040, stair: 0xf0c070, tower: 0xc8643c, crate: 0x6a9a4a, pillar: 0xa04a34 },
  });
}

/** A stepped pyramid in the middle, staircases on all four faces, raised terraces in the corners. */
function ziggurat(): MapData {
  const half = 34;
  const b = new B().shell(half, 10);
  // The same shapes in every quarter, each quarter in its own colour, so players can tell where they are.
  const marks = (kinds: MapData['boxes'][number]['kind'][], piece: (p: B) => void) => {
    const all = (kinds.length === 2 ? new B().pair(piece) : new B().quad(piece)).boxes;
    all.forEach((m, i) => b.box(kinds[Math.floor((i * kinds.length) / all.length)], m.min.x, m.min.y, m.min.z, m.max.x, m.max.y, m.max.z));
  };
  b.block('platform', 0, 0, 12, 12, 2).block('platform', 0, 0, 8, 8, 4).block('platform', 0, 0, 4.5, 4.5, 6);
  // A capstone on the summit: holding the top means picking a side instead of seeing the whole arena.
  b.block('stair', 0, 0, 1.4, 1.4, 8.5, 6);
  // Each quarter's terrace, obelisk and low wall share a colour.
  marks(['ledge', 'tower', 'crate', 'pillar'], (p) => {
    p.box('ledge', 24, 0, 24, half, 3.5, half);
    p.block('ledge', 13.5, 19.5, 1.3, 1.3, 3.2).block('ledge', 0, 20, 3, 0.7, 2.2);
  });
  b.quad((p) => {
    p.stairs('z', -1, 0, 12 + B.run(0, 2), 4, 0, 2);
    p.stairs('z', -1, 0, 8 + B.run(2, 4), 4, 2, 4);
    p.stairs('z', -1, 0, 4.5 + B.run(4, 6), 3, 4, 6);
    p.pack(6.3, 4, 6.3);
    p.block('pillar', 22, 10, 1, 1, 6);
    // Terrace steps run along both walls, so the corner is a loop rather than a dead end.
    p.stairs('x', 1, 24 - B.run(0, 3.5), half - 1.75, 3.5, 0, 3.5).stairs('z', 1, half - 1.75, 24 - B.run(0, 3.5), 3.5, 0, 3.5);
    p.pack(31, 3.5, 27);
    p.padTo(v3(19, 0, 19), v3(3, 6, 3), 1.8);
    p.spawn(27, 3.5, 31).spawn(0, 0, 26).spawn(26, 0, 12);
  });
  return b.build({ id: 'ziggurat', accent: 0x3ec8ff, name: 'Ziggurat', half, skyColor: 0x4ab8e8, fogColor: 0x3ea0d0, tint: { platform: 0xe8884a, stair: 0xf0c060, floor: 0xd8c08a, wall: 0x3a7a8a, ledge: 0x5ab070, pillar: 0xe85d5d, tower: 0x6a7ae0, crate: 0xf0d040 } });
}

/** A forest of spires of different heights, chained together by jump pads around a central needle. */
function spires(): MapData {
  const half = 36;
  const b = new B().shell(half, 12);
  // The same shapes in every quarter, each quarter in its own colour, so players can tell where they are.
  const marks = (kinds: MapData['boxes'][number]['kind'][], piece: (p: B) => void) => {
    const all = (kinds.length === 2 ? new B().pair(piece) : new B().quad(piece)).boxes;
    all.forEach((m, i) => b.box(kinds[Math.floor((i * kinds.length) / all.length)], m.min.x, m.min.y, m.min.z, m.max.x, m.max.y, m.max.z));
  };
  // The needle blocks the diagonals between the tall spires; the plinth corners are cannons out to them.
  b.block('tower', 0, 0, 4, 4, 5).block('stair', 0, 0, 1.5, 1.5, 14.5, 5);
  marks(['ledge', 'crate', 'platform', 'pillar'], (p) => p.block('tower', 24, 24, 3, 3, 10).block('tower', 24, 8, 2.5, 2.5, 7));
  b.quad((p) => {
    p.stairs('z', -1, 0, 4 + B.run(0, 5), 3, 0, 5);
    p.padTo(v3(2.9, 5, 2.9), v3(23, 10, 23), 2, 0.8);
    p.block('tower', 10, 10, 2.5, 2.5, 3).stairs('z', -1, 10, 12.5 + B.run(0, 3), 2.5, 0, 3);
    p.padTo(v3(17, 0, 4), v3(24, 7, 8));
    p.padTo(v3(24, 7, 9.5), v3(24, 10, 24), 1.4, 1);
    p.block('tower', 8, 28, 2, 2, 5).padTo(v3(5, 0, 21), v3(8, 5, 28));
    // A half wall to spawn behind at the edge.
    p.block('stair', 28, 1, 0.5, 2, 1.9);
    p.spawn(16, 0, 16).spawn(31, 0, 0).spawn(24, 10, 24);
    p.pack(24, 10, 24).pack(0, 0, 22);
  });
  return b.build({ id: 'spires', accent: 0xffb020, name: 'Spires', half, skyColor: 0x7ac8ff, fogColor: 0x60b0e8, tint: { tower: 0x6a9ae8, floor: 0xd8d0c4, stair: 0xf2a040, wall: 0x5a4ab0, ledge: 0xe86a8a, crate: 0x5ac88a, platform: 0xf2c14e, pillar: 0xf4f0e8 } });
}

/** A walled keep with battlements, corner turrets and bunkers in the yard. */
function fortress(): MapData {
  const half = 36;
  const b = new B().shell(half, 10);
  const wallH = 5;
  b.block('platform', 0, 0, 3, 3, 1.5).pack(0, 1.5, 0);
  b.quad((p) => {
    // One side of the keep: two wall segments with a doorway between, and a staircase up to the battlements.
    p.box('ledge', 2, 0, 10.5, 12, wallH, 12).box('ledge', -12, 0, 10.5, -2, wallH, 12);
    p.stairs('z', 1, -7, 10.5 - B.run(0, wallH), 3, 0, wallH);
    p.stairs('z', -1, 0, 3 + B.run(0, 1.5), 2, 0, 1.5);
    p.block('tower', 12, 12, 2.5, 2.5, 8).padTo(v3(18, 0, 18), v3(12, 8, 12)).pack(12, 8, 12);
    p.box('ledge', 23, 0, 23, 33, 3, 33).stairs('x', 1, 23 - B.run(0, 3), 28, 3, 0, 3);
    p.block('crate', 22, 4, 1, 1, 2).block('crate', 14, 26, 0.8, 0.8, 1.6);
    p.spawn(28, 3, 28).spawn(27, 0, -2).spawn(4, 0, -8);
    p.pack(30, 0, 10);
  });
  return b.build({ id: 'fortress', accent: 0xffd23a, name: 'Fortress', half, skyColor: 0x5aa8e0, fogColor: 0xdcecf4, tint: { ledge: 0xb8b0a0, tower: 0xa09888, floor: 0x86c060, wall: 0x9a9284, stair: 0xc8bfae, platform: 0xc84a3a } });
}

/** A ring of floor around a bottomless pit, an island in the middle and a raised walkway all the way round. */
function pit(): MapData {
  const half = 32;
  const b = new B().shell(half, 10, false);
  b.box('platform', -3.5, 2, -3.5, 3.5, 3, 3.5).pack(0, 3, 0);
  b.quad((p) => {
    p.box('floor', 9, -1, -half, half, 0, 9);
    p.padTo(v3(12, 0, 0), v3(0, 3, 0), 1.6);
    p.padTo(v3(2.2, 3, 2.2), v3(16, 0, 16), 1.6, 0.8);
    p.block('platform', 24, 24, 4, 4, 5).box('platform', -20, 4.5, 27, 20, 5, half);
    p.stairs('x', 1, 20 - B.run(0, 5), 21.5, 3, 0, 5);
    p.block('crate', 16, -6, 1, 1, 2);
    p.spawn(22, 0, -10).spawn(24, 5, 24).spawn(20, 0, 0);
    p.pack(0, 5, 29.5);
  });
  return b.build({ id: 'pit', accent: 0xffe03a, name: 'The Pit', half, skyColor: 0xe8483a, fogColor: 0xffb88a, tint: { floor: 0x8a5a4a, platform: 0x6a3a5a, wall: 0x5a3442, stair: 0x9a6a5a, crate: 0xffa020 } });
}

/** Two raised bases facing each other, a long bridge between them and towers either side. */
function twinBases(): MapData {
  const half = 36;
  const b = new B().shell(half, 10);
  const baseH = 4;
  b.pair((p) => {
    p.box('ledge', -12, 0, 22, 12, baseH, half);
    p.stairs('z', 1, 8, 22 - B.run(0, baseH), 3, 0, baseH).stairs('z', 1, -8, 22 - B.run(0, baseH), 3, 0, baseH);
    p.box('platform', -2, baseH - 0.5, 0, 2, baseH, 22).pack(0, baseH, 10);
    p.block('tower', 0, 30, 2.5, 2.5, 8).padTo(v3(5, baseH, 26), v3(0, 8, 30));
    p.padTo(v3(8, 0, 4), v3(0, baseH, 4)).padTo(v3(-8, 0, 8), v3(0, baseH, 8));
    p.block('tower', 20, 10, 3.5, 3.5, 6).stairs('x', -1, 23.5 + B.run(0, 6), 10, 3, 0, 6);
    p.block('tower', -20, 10, 3.5, 3.5, 6).stairs('x', 1, -23.5 - B.run(0, 6), 10, 3, 0, 6);
    p.block('crate', 12, -2, 1, 1, 2).block('crate', -14, 24, 1, 1, 1.8);
    p.spawn(6, baseH, 30).spawn(-6, baseH, 30).spawn(14, 0, 20).spawn(-24, 0, 24).spawn(20, 6, 10);
    p.pack(-20, 6, 10).pack(28, 0, 28);
  });
  return b.build({ id: 'twin', accent: 0xff5ea8, name: 'Twin Bases', half, skyColor: 0x38c0d0, fogColor: 0xdaf6f0, tint: { ledge: 0xe86a4a, tower: 0x4a8ad8, floor: 0xd8e0c8, platform: 0xf2c14e } });
}

/** City blocks: streets at ground level, rooftops of every height, pads up to the tallest. */
function downtown(): MapData {
  const half = 38;
  const b = new B().shell(half, 14);
  b.pack(0, 0, 0);
  b.quad((p) => {
    p.block('tower', 9, 9, 4, 4, 4).stairs('x', 1, 5 - B.run(0, 4), 9, 3, 0, 4).pack(9, 4, 9);
    p.block('tower', 9, 25, 4, 4, 2.5).stairs('x', 1, 5 - B.run(0, 2.5), 25, 3, 0, 2.5);
    p.box('tower', 20, 0, 5, 30, 7, 13).padTo(v3(15, 0, 9), v3(25, 7, 9), 2);
    p.block('tower', 25, 25, 5, 5, 10).padTo(v3(25, 7, 11.5), v3(25, 10, 25), 1.4, 1).pack(25, 10, 25);
    p.block('crate', 16.5, 30, 1, 1, 2);
    p.spawn(16.5, 0, 16.5).spawn(33, 0, 17).spawn(17, 0, 34);
  });
  return b.build({ id: 'downtown', accent: 0x3ee0b0, name: 'Downtown', half, skyColor: 0x3a4ea8, fogColor: 0xf0a0b8, tint: { tower: 0xd06ab8, floor: 0x7a7e92, stair: 0xf2c14e, crate: 0x5ec2e6, wall: 0x5a5e88 } });
}

/** Rings of floating platforms over the void, linked only by jump pads. Rocket jumps welcome. */
function orbit(): MapData {
  const half = 40;
  const b = new B().shell(half, 0, false);
  b.box('platform', -6, -1, -6, 6, 0, 6).block('pillar', 0, 0, 1.2, 1.2, 5);
  b.quad((p) => {
    p.block('platform', 16, 0, 3, 3, 3, 2).block('platform', 11.3, 11.3, 3, 3, 3, 2);
    p.block('platform', 28, 0, 3.5, 3.5, 6, 5).block('platform', 19.8, 19.8, 3.5, 3.5, 6, 5);
    p.padTo(v3(4.5, 0, 0), v3(16, 3, 0)).padTo(v3(3.2, 0, 3.2), v3(11.3, 3, 11.3));
    p.padTo(v3(17.5, 3, 0), v3(28, 6, 0), 1.4, 1).padTo(v3(12.4, 3, 12.4), v3(19.8, 6, 19.8), 1.4, 1);
    p.padTo(v3(30.5, 6, 0), v3(-3, 0, -3), 2.5, 0.9).padTo(v3(22, 6, 22), v3(3, 0, -3), 2.5, 0.9);
    p.spawn(14.5, 3, 0).spawn(18.5, 6, 18.5);
    p.pack(27, 6, 2.5);
  });
  return b.build({ id: 'orbit', accent: 0x3ee0b0, name: 'Orbit', half, skyColor: 0x4a2ab0, fogColor: 0xd0b8ff, tint: { platform: 0xf2c14e, pillar: 0xff6ab0 } });
}

export const MAPS: MapData[] = [foundry(), skyway(), canyon(), ziggurat(), spires(), fortress(), pit(), twinBases(), downtown(), orbit()];

/** What the room's map picker shows. */
export const MAP_LIST = MAPS.map((m) => ({ id: m.id, name: m.name }));

export const RANDOM_MAP = 'random';

export function mapById(id: string): MapData | undefined {
  return MAPS.find((m) => m.id === id);
}
