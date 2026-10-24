// The Rockets map pool. Every map is built with rotational symmetry (quad or pair) so no spawn side is favoured.
// Heights are tuned to the movement in constants.ts: a plain jump clears about 2.3 m, a rocket jump well over 15 m.

import { v3 } from '../math.js';
import { MapBuilder as B, type MapData } from './map.js';

/** The original arena, scaled up: central platform, four corner towers on jump pads, ledges east and west. */
function foundry(): MapData {
  const half = 32;
  const b = new B().shell(half, 10);
  const platH = 3;
  b.block('platform', 0, 0, 9, 9, platH);
  b.pair((p) => p.stairs('z', -1, 0, 9 + B.run(0, platH), 5, 0, platH).spawn(0, platH, 5).pack(5, platH, 5));
  b.padUp(v3(0, platH, 0), 15);
  b.quad((p) => {
    p.block('tower', 23, 23, 4, 4, 6).padTo(v3(15, 0, 15), v3(23, 6, 23)).pack(23, 6, 23);
    p.block('pillar', 11.5, 11.5, 1.2, 1.2, 7);
    p.block('crate', 19, -7, 1, 1, 2).block('crate', 6, 22, 0.8, 0.8, 1.6);
    p.spawn(0, 0, 27).spawn(14, 0, 24);
  });
  b.pair((p) => {
    p.box('ledge', half - 3.5, 0, -12, half, 4, 12).stairs('z', -1, half - 1.75, 12 + B.run(0, 4), 3.5, 0, 4);
    p.pack(half - 1.7, 4, 0);
  });
  return b.build({ id: 'foundry', name: 'Foundry', half, skyColor: 0x0b0f1a, fogColor: 0x121a2b });
}

/** Floating islands over the void, joined by narrow bridges; fall off and you are gone. */
function skyway(): MapData {
  const half = 40;
  const b = new B().shell(half, 0, false);
  b.box('floor', -10, -1, -10, 10, 0, 10);
  b.block('platform', 0, 0, 3.5, 3.5, 2);
  b.pack(0, 2, 0);
  b.pair((p) => p.stairs('z', -1, 0, 3.5 + B.run(0, 2), 3, 0, 2).spawn(6, 0, 6));
  b.quad((p) => {
    p.box('platform', 10, -1, -1.2, 19, 0, 1.2).pack(14.5, 0, 0);
    p.box('floor', 19, -1, -7, 33, 0, 7).spawn(24, 0, 0).padUp(v3(30, 0, 0), 16);
    // Corner island, five metres up, climbed from the next island round and left by a pad back to the middle.
    p.box('platform', 21, 4, 21, 31, 5, 31).spawn(27, 5, 27).pack(28.5, 5, 28.5);
    p.stairs('x', 1, 7, 25, 4, 0, 5).box('platform', 7 + B.run(0, 5), 4, 23, 21, 5, 27);
    p.padTo(v3(23.5, 5, 23.5), v3(5, 0, 5), 2);
  });
  return b.build({ id: 'skyway', name: 'Skyway', half, skyColor: 0x1b2a4a, fogColor: 0x2a3b5e, tint: { floor: 0x2a3550, platform: 0x34405e } });
}

/** Two sandstone plateaus either side of a canyon, linked by high bridges. */
function canyon(): MapData {
  const half = 34;
  const b = new B().shell(half, 12);
  const top = 6;
  b.block('crate', 0, 0, 1.5, 1.5, 2.5);
  b.pair((p) => {
    p.box('ledge', 14, 0, -half, half, top, half);
    p.stairs('x', 1, 14 - B.run(0, top), 0, 4, 0, top).stairs('x', 1, 14 - B.run(0, top), 30, 3, 0, top);
    p.box('platform', -14, top - 0.5, 18, 14, top, 22).pack(0, top, 20);
    p.padTo(v3(8, 0, 10), v3(22, top, 10));
    p.block('tower', 26, 26, 4, 4, 11).padTo(v3(26, top, 16), v3(26, 11, 26)).spawn(26, 11, 26);
    p.block('crate', 20, -6, 1, 1, top + 2, top).block('crate', 28, -14, 1.2, 1.2, top + 2.4, top);
    p.block('pillar', 6, 26, 1, 1, 4.5);
    p.spawn(24, top, 0).spawn(26, top, -24).spawn(10, 0, 27).spawn(-6, 0, 10);
    p.pack(30, top, 0).pack(0, 0, -28);
  });
  return b.build({
    id: 'canyon',
    name: 'Canyon',
    half,
    skyColor: 0x2a1810,
    fogColor: 0x3a2416,
    tint: { floor: 0x3a2a1e, ledge: 0x5a3f2a, wall: 0x2e2016, platform: 0x4a3524 },
  });
}

/** A stepped pyramid in the middle, staircases on all four faces, raised bunkers in the corners. */
function ziggurat(): MapData {
  const half = 34;
  const b = new B().shell(half, 10);
  b.block('platform', 0, 0, 12, 12, 2).block('platform', 0, 0, 8, 8, 4).block('platform', 0, 0, 4.5, 4.5, 6);
  b.pack(0, 6, 0);
  b.quad((p) => {
    p.stairs('z', -1, 0, 12 + B.run(0, 2), 4, 0, 2);
    p.stairs('z', -1, 0, 8 + B.run(2, 4), 4, 2, 4);
    p.stairs('z', -1, 0, 4.5 + B.run(4, 6), 3, 4, 6);
    p.pack(10, 2, 10);
    p.block('pillar', 22, 10, 1, 1, 6);
    p.box('ledge', 24, 0, 24, half, 3.5, half).stairs('x', 1, 24 - B.run(0, 3.5), 29, 4, 0, 3.5).pack(31, 3.5, 31);
    p.padTo(v3(19, 0, 19), v3(3, 6, 3), 1.8);
    p.spawn(29, 3.5, 29).spawn(0, 0, 26).spawn(28, 0, 10);
  });
  return b.build({ id: 'ziggurat', name: 'Ziggurat', half, skyColor: 0x14100a, fogColor: 0x221a10, tint: { platform: 0x4a4030, stair: 0x55493a, floor: 0x2a241a } });
}

/** A forest of spires of different heights, chained together by jump pads. */
function spires(): MapData {
  const half = 36;
  const b = new B().shell(half, 12);
  b.block('tower', 0, 0, 4, 4, 5).padUp(v3(0, 5, 0), 14);
  b.quad((p) => {
    p.stairs('z', -1, 0, 4 + B.run(0, 5), 3, 0, 5);
    p.block('tower', 10, 10, 2.5, 2.5, 3).stairs('z', -1, 10, 12.5 + B.run(0, 3), 2.5, 0, 3);
    p.block('tower', 24, 8, 2.5, 2.5, 7).padTo(v3(17, 0, 4), v3(24, 7, 8));
    p.block('tower', 24, 24, 3, 3, 10).padTo(v3(24, 7, 9.5), v3(24, 10, 24), 1.4, 1);
    p.block('tower', 8, 28, 2, 2, 5).padTo(v3(5, 0, 21), v3(8, 5, 28));
    p.spawn(16, 0, 16).spawn(30, 0, 0).spawn(24, 10, 24);
    p.pack(24, 10, 24).pack(0, 0, 22);
  });
  return b.build({ id: 'spires', name: 'Spires', half, skyColor: 0x0a1424, fogColor: 0x10223a, tint: { tower: 0x2a4060, floor: 0x16233a } });
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
  return b.build({ id: 'fortress', name: 'Fortress', half, skyColor: 0x101418, fogColor: 0x1a2028, tint: { ledge: 0x3a3f48, tower: 0x444a55, floor: 0x22262c } });
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
  return b.build({ id: 'pit', name: 'The Pit', half, skyColor: 0x1a0808, fogColor: 0x2a0c0c, tint: { floor: 0x2a1616, platform: 0x45222a } });
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
  return b.build({ id: 'twin', name: 'Twin Bases', half, skyColor: 0x081418, fogColor: 0x0e2026, tint: { ledge: 0x1f3a40, tower: 0x2a4650 } });
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
  return b.build({ id: 'downtown', name: 'Downtown', half, skyColor: 0x070a14, fogColor: 0x0c1220, tint: { tower: 0x252c3e, floor: 0x14182a } });
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
  return b.build({ id: 'orbit', name: 'Orbit', half, skyColor: 0x05030f, fogColor: 0x0c0820, tint: { platform: 0x2c2448, pillar: 0x3a3060 } });
}

export const MAPS: MapData[] = [foundry(), skyway(), canyon(), ziggurat(), spires(), fortress(), pit(), twinBases(), downtown(), orbit()];

/** What the room's map picker shows. */
export const MAP_LIST = MAPS.map((m) => ({ id: m.id, name: m.name }));

export const RANDOM_MAP = 'random';

export function mapById(id: string): MapData | undefined {
  return MAPS.find((m) => m.id === id);
}
