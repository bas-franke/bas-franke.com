// Set dressing for Last Light: everything that makes the room look lived-in and abandoned but never collides.
//
// - Decals from one canvas atlas (posters, a warning sign, a chalk tally, graffiti, blood smears, drag marks, stains,
//   soot, damp streaks, cobwebs, papers, leaves, a floor grate, a gauge face), drawn by one InstancedMesh.
// - Rubble and dust along the wall bases, glass shards under the windows (stained glass in the chapel).
// - Pipes, conduit and brackets along the walls, hanging cables, chains on hooks, a ventilation duct, racking
//   remains and pallets, a cross and altar candles, pipe manifolds with valves and gauges: per map.
// - Water drips from the ceiling into small puddles with ripples, a broken fluorescent tube that flickers, a red exit
//   sign.
// - The yard: grass tufts that sway in the wind, puddles, and a burning car wreck beyond the fence.
//
// Anything mounted on a wall remembers the chunk behind it: when that chunk breaks (breakChunk) it disappears with it.
// Lights that should show in the fog are returned as `glows` (point glows) and `lamps` (spot cones, see api.ts).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec3 } from '@shared/math';
import { type World, SILL_Y, WALL_T, WINDOW_TOP, forChunks } from '@shared/zombies/world';
import type { LampLight, Quality } from './api';

export interface Glow {
  pos: Vec3;
  color: THREE.Color;
  /** Current intensity in the fog's flash units (see post.ts). */
  intensity: number;
}

export interface DecorMats {
  steel: THREE.Material;
  iron: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
}

export interface Decor {
  group: THREE.Group;
  glows: Glow[];
  lamps: (LampLight & { update(time: number): void })[];
  breakChunk(i: number): void;
  update(dt: number, time: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

// ---- atlas ----------------------------------------------------------------------------------------------------------

const CELLS = 4;
enum Cell {
  PosterA = 0,
  PosterB,
  Warning,
  Tally,
  BloodWall,
  Drag,
  Stain,
  Soot,
  Web,
  Paper,
  News,
  LeafA,
  LeafB,
  Damp,
  Scrawl,
  Grate,
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let atlasCache: THREE.CanvasTexture | null = null;

/** The decal atlas: 4 x 4 cells of 256 px, drawn once per page. */
function atlas(): THREE.CanvasTexture {
  if (atlasCache) return atlasCache;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S * CELLS;
  const g = c.getContext('2d')!;
  const r = rng(1234);
  const cell = (i: number, draw: () => void) => {
    g.save();
    g.translate((i % CELLS) * S, Math.floor(i / CELLS) * S);
    g.beginPath();
    g.rect(0, 0, S, S);
    g.clip();
    draw();
    g.restore();
  };
  const grime = (n: number, a: number) => {
    for (let k = 0; k < n; k++) {
      g.fillStyle = `rgba(20,14,8,${r() * a})`;
      g.beginPath();
      g.arc(r() * S, r() * S, 1 + r() * 9, 0, Math.PI * 2);
      g.fill();
    }
  };
  // Torn paper outline, then content clipped to it.
  const torn = (x: number, y: number, w: number, h: number, fill: string) => {
    g.beginPath();
    const pts: [number, number][] = [];
    for (let k = 0; k <= 12; k++) pts.push([x + (w * k) / 12, y + r() * 6]);
    for (let k = 0; k <= 12; k++) pts.push([x + w - r() * 5, y + (h * k) / 12]);
    // A big tear off the bottom right corner.
    for (let k = 12; k >= 0; k--) pts.push([x + (w * k) / 12, y + h - r() * 7 - (k > 7 ? (k - 7) * 9 : 0)]);
    for (let k = 12; k >= 0; k--) pts.push([x + r() * 5, y + (h * k) / 12]);
    g.moveTo(pts[0][0], pts[0][1]);
    for (const [px, py] of pts) g.lineTo(px, py);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.save();
    g.clip();
  };
  cell(Cell.PosterA, () => {
    torn(26, 8, 204, 240, '#c9bfa6');
    g.fillStyle = '#2b2622';
    g.font = '700 30px Impact, sans-serif';
    g.textAlign = 'center';
    g.fillText('MISSING', 128, 46);
    g.fillStyle = '#6f6556';
    g.fillRect(64, 62, 128, 104);
    g.fillStyle = '#4a4239';
    g.beginPath();
    g.arc(128, 104, 26, 0, Math.PI * 2);
    g.fill();
    g.fillRect(92, 128, 72, 40);
    g.fillStyle = '#2b2622';
    g.font = '600 15px Georgia, serif';
    for (let k = 0; k < 4; k++) g.fillRect(52, 182 + k * 13, 152 - r() * 50, 4);
    grime(140, 0.25);
    g.restore();
  });
  cell(Cell.PosterB, () => {
    torn(18, 20, 220, 200, '#8f2e22');
    g.fillStyle = '#e6d7b6';
    g.font = '700 34px Impact, sans-serif';
    g.textAlign = 'center';
    g.fillText('CURFEW', 128, 70);
    g.font = '700 18px Impact, sans-serif';
    g.fillText('AFTER DARK', 128, 98);
    g.fillStyle = '#1b1210';
    g.fillRect(40, 116, 176, 3);
    for (let k = 0; k < 5; k++) g.fillRect(48, 132 + k * 14, 160 - r() * 60, 5);
    grime(200, 0.3);
    g.restore();
  });
  cell(Cell.Warning, () => {
    // A board with hand-painted letters, paint running.
    g.fillStyle = '#5a4a36';
    g.fillRect(6, 40, 244, 170);
    for (let k = 0; k < 4; k++) {
      g.fillStyle = `rgba(0,0,0,${0.15 + r() * 0.15})`;
      g.fillRect(6, 40 + k * 43, 244, 2);
    }
    g.fillStyle = '#d8d0c0';
    g.font = '700 40px "Comic Sans MS", Impact, sans-serif';
    g.textAlign = 'center';
    g.save();
    g.translate(128, 112);
    g.rotate(-0.05);
    g.fillText('DONT', 0, -14);
    g.fillText('OPEN', 0, 30);
    g.restore();
    g.fillStyle = '#9b1b12';
    g.font = '700 26px "Comic Sans MS", Impact, sans-serif';
    g.fillText('DEAD INSIDE', 128, 192);
    for (let k = 0; k < 9; k++) {
      g.fillStyle = 'rgba(216,208,192,0.8)';
      const x = 50 + r() * 160;
      g.fillRect(x, 120 + r() * 30, 2, 10 + r() * 30);
    }
    grime(60, 0.3);
  });
  cell(Cell.Tally, () => {
    // Chalk on a dark wall: tally marks and a day count.
    g.strokeStyle = 'rgba(225,220,210,0.85)';
    g.lineCap = 'round';
    g.lineWidth = 4;
    for (let grp = 0; grp < 6; grp++) {
      const x0 = 20 + (grp % 3) * 76;
      const y0 = 30 + Math.floor(grp / 3) * 90;
      for (let k = 0; k < 4; k++) {
        g.beginPath();
        g.moveTo(x0 + k * 12 + r() * 3, y0 + r() * 4);
        g.lineTo(x0 + k * 12 + r() * 4 - 2, y0 + 60 + r() * 4);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(x0 - 6, y0 + 44);
      g.lineTo(x0 + 50, y0 + 14);
      g.stroke();
    }
    g.fillStyle = 'rgba(225,220,210,0.85)';
    g.font = '600 30px "Comic Sans MS", cursive';
    g.fillText('DAY 31', 60, 236);
  });
  cell(Cell.BloodWall, () => {
    // Smeared hand prints running down.
    for (let k = 0; k < 3; k++) {
      const x = 50 + k * 70 + r() * 20;
      const y = 40 + r() * 30;
      g.fillStyle = 'rgba(70,6,4,0.9)';
      g.beginPath();
      g.ellipse(x, y, 20, 24, 0, 0, Math.PI * 2);
      g.fill();
      for (let f = 0; f < 4; f++) {
        g.beginPath();
        g.ellipse(x - 18 + f * 12, y - 28, 5, 13, 0, 0, Math.PI * 2);
        g.fill();
      }
      const grad = g.createLinearGradient(0, y, 0, y + 170);
      grad.addColorStop(0, 'rgba(70,6,4,0.8)');
      grad.addColorStop(1, 'rgba(70,6,4,0)');
      g.fillStyle = grad;
      g.fillRect(x - 15, y, 30, 170 + r() * 30);
      for (let d = 0; d < 3; d++) g.fillRect(x - 12 + r() * 24, y + 20, 3, 120 + r() * 80);
    }
  });
  cell(Cell.Drag, () => {
    // Two long smears with a darker core: something was dragged.
    for (const x of [90, 165]) {
      const grad = g.createLinearGradient(x - 22, 0, x + 22, 0);
      grad.addColorStop(0, 'rgba(60,8,5,0)');
      grad.addColorStop(0.5, 'rgba(60,8,5,0.85)');
      grad.addColorStop(1, 'rgba(60,8,5,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(x - 20, 0);
      for (let y = 0; y <= S; y += 16) g.lineTo(x - 18 + Math.sin(y * 0.04) * 6 + r() * 4, y);
      for (let y = S; y >= 0; y -= 16) g.lineTo(x + 18 + Math.sin(y * 0.04) * 6 - r() * 4, y);
      g.fill();
    }
    grime(80, 0.3);
  });
  cell(Cell.Stain, () => {
    for (let k = 0; k < 7; k++) {
      const grad = g.createRadialGradient(128 + (r() - 0.5) * 80, 128 + (r() - 0.5) * 80, 0, 128, 128, 60 + r() * 60);
      grad.addColorStop(0, `rgba(40,30,18,${0.3 + r() * 0.3})`);
      grad.addColorStop(1, 'rgba(40,30,18,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
    }
    // Tide rings.
    g.strokeStyle = 'rgba(30,22,12,0.4)';
    g.lineWidth = 3;
    g.beginPath();
    g.ellipse(128, 128, 100, 88, 0.3, 0, Math.PI * 2);
    g.stroke();
  });
  cell(Cell.Soot, () => {
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(8,6,4,0.85)');
    grad.addColorStop(0.5, 'rgba(8,6,4,0.45)');
    grad.addColorStop(1, 'rgba(8,6,4,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    grime(120, 0.2);
  });
  cell(Cell.Web, () => {
    // Radial threads anchored in one corner, sagging spiral.
    g.strokeStyle = 'rgba(230,230,225,0.55)';
    g.lineWidth = 1.2;
    const spokes = 9;
    for (let k = 0; k < spokes; k++) {
      const a = (k / (spokes - 1)) * (Math.PI / 2);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(Math.cos(a) * 250, Math.sin(a) * 250);
      g.stroke();
    }
    for (let ring = 1; ring < 14; ring++) {
      const rad = ring * 17 + r() * 4;
      g.beginPath();
      for (let k = 0; k < spokes; k++) {
        const a = (k / (spokes - 1)) * (Math.PI / 2);
        const sag = k > 0 ? 3 + ring * 0.4 : 0;
        const x = Math.cos(a) * rad - Math.cos(a - 0.1) * sag;
        const y = Math.sin(a) * rad - Math.sin(a - 0.1) * sag;
        if (k === 0) g.moveTo(x, y);
        else g.quadraticCurveTo(Math.cos(a - 0.09) * (rad - sag), Math.sin(a - 0.09) * (rad - sag), x, y);
      }
      g.stroke();
    }
    g.fillStyle = 'rgba(220,220,215,0.25)';
    for (let k = 0; k < 40; k++) g.fillRect(r() * 120, r() * 120, 2, 2);
  });
  cell(Cell.Paper, () => {
    g.fillStyle = '#7d766a';
    g.beginPath();
    g.moveTo(40, 30);
    g.lineTo(220, 44);
    g.lineTo(206, 230);
    g.lineTo(30, 214);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(40,40,60,0.6)';
    for (let k = 0; k < 10; k++) g.fillRect(56, 60 + k * 15, 120 - r() * 40, 3);
    grime(60, 0.35);
  });
  cell(Cell.News, () => {
    g.fillStyle = '#6e695f';
    g.fillRect(20, 26, 216, 204);
    g.fillStyle = '#1c1b1a';
    g.font = '700 26px Georgia, serif';
    g.fillText('OUTBREAK', 36, 60);
    for (let col = 0; col < 3; col++) for (let k = 0; k < 11; k++) g.fillRect(32 + col * 66, 80 + k * 13, 56, 3);
    grime(160, 0.4);
  });
  const leaf = (fill: string) => () => {
    g.fillStyle = fill;
    g.translate(128, 128);
    g.rotate(0.6);
    g.beginPath();
    g.moveTo(0, -100);
    g.quadraticCurveTo(70, -20, 0, 100);
    g.quadraticCurveTo(-70, -20, 0, -100);
    g.fill();
    g.strokeStyle = 'rgba(30,18,8,0.7)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, -95);
    g.lineTo(0, 110);
    g.stroke();
  };
  cell(Cell.LeafA, leaf('#5a3b1c'));
  cell(Cell.LeafB, leaf('#33281a'));
  cell(Cell.Damp, () => {
    for (let k = 0; k < 12; k++) {
      const x = 30 + r() * 196;
      const grad = g.createLinearGradient(0, 0, 0, S);
      grad.addColorStop(0, 'rgba(20,24,18,0.6)');
      grad.addColorStop(1, 'rgba(20,24,18,0)');
      g.fillStyle = grad;
      g.fillRect(x, 0, 6 + r() * 18, 120 + r() * 136);
    }
  });
  cell(Cell.Scrawl, () => {
    g.fillStyle = 'rgba(150,20,14,0.9)';
    g.font = '700 46px Impact, sans-serif';
    g.save();
    g.translate(18, 110);
    g.rotate(-0.06);
    g.fillText('NO WAY', 0, 0);
    g.fillText('OUT', 40, 60);
    g.restore();
    for (let k = 0; k < 12; k++) g.fillRect(24 + r() * 200, 110 + r() * 40, 3, 14 + r() * 50);
  });
  cell(Cell.Grate, () => {
    g.fillStyle = 'rgba(0,0,0,0.92)';
    g.fillRect(0, 0, S, S);
    g.fillStyle = '#4a4a46';
    for (let k = 0; k <= 16; k++) {
      g.fillRect(k * 16 - 2, 0, 4, S);
      g.fillRect(0, k * 16 - 2, S, 4);
    }
    grime(200, 0.4);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  atlasCache = tex;
  return tex;
}

// ---- builder --------------------------------------------------------------------------------------------------------

export function buildDecor(world: World, mats: DecorMats, quality: Quality): Decor {
  const def = world.def;
  const h = world.height;
  const hw = def.w / 2;
  const hd = def.d / 2;
  const group = new THREE.Group();
  group.name = 'decor';
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(d: T) => (disposables.push(d), d);
  const r = rng(def.id.length * 7919 + def.w * 31 + def.d);
  const glows: Glow[] = [];
  const lamps: Decor['lamps'] = [];
  const updaters: ((dt: number, time: number) => void)[] = [];
  /** Real lights that only high quality can afford (each one costs every lit pixel); the fog glow stays. */
  const highLights: THREE.Light[] = [];
  /** Things to hide when a chunk breaks: instance slots and whole objects. */
  const byChunk = new Map<number, (() => void)[]>();
  const onBreak = (chunk: number, fn: () => void) => {
    if (chunk < 0) return;
    const list = byChunk.get(chunk) ?? [];
    list.push(fn);
    byChunk.set(chunk, list);
  };
  /** The standing chunk containing point p (a hair inside a wall face), or -1. */
  const chunkAt = (p: Vec3) => {
    let found = -1;
    forChunks(world, { min: { x: p.x - 0.01, y: p.y - 0.01, z: p.z - 0.01 }, max: { x: p.x + 0.01, y: p.y + 0.01, z: p.z + 0.01 } }, (i) => {
      const c = world.chunks[i];
      if (world.alive[i] && p.x >= c.min.x && p.x <= c.max.x && p.y >= c.min.y && p.y <= c.max.y && p.z >= c.min.z && p.z <= c.max.z) {
        found = i;
        return true;
      }
    });
    return found;
  };
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);

  // Walls as inner faces: point on the face, inward normal, the along axis.
  interface Side {
    along: 'x' | 'z';
    fixed: number;
    inward: THREE.Vector3;
    len: number;
  }
  const sides: Side[] = [
    { along: 'x', fixed: -hd, inward: new THREE.Vector3(0, 0, 1), len: def.w },
    { along: 'x', fixed: hd, inward: new THREE.Vector3(0, 0, -1), len: def.w },
    { along: 'z', fixed: -hw, inward: new THREE.Vector3(1, 0, 0), len: def.d },
    { along: 'z', fixed: hw, inward: new THREE.Vector3(-1, 0, 0), len: def.d },
  ];
  const wallPoint = (s: Side, a: number, y: number, off = 0) =>
    s.along === 'x' ? new THREE.Vector3(a, y, s.fixed + s.inward.z * off) : new THREE.Vector3(s.fixed + s.inward.x * off, y, a);
  const nearWindow = (p: THREE.Vector3, margin: number) => world.windows.some((w) => Math.hypot(w.center.x - p.x, w.center.z - p.z) < w.width / 2 + margin);
  const nearLocker = (p: THREE.Vector3, margin: number) => world.stations.some((st) => Math.hypot(st.pos.x - p.x, st.pos.z - p.z) < 0.6 + margin);
  const behind = (s: Side, p: THREE.Vector3) => chunkAt({ x: p.x - s.inward.x * 0.05, y: p.y, z: p.z - s.inward.z * 0.05 });
  /** A free spot on a wall: away from windows and lockers. */
  const wallSpot = (y0: number, y1: number, margin = 1.2): { s: Side; p: THREE.Vector3 } => {
    for (let k = 0; k < 60; k++) {
      const s = sides[Math.floor(r() * 4)];
      const a = (r() - 0.5) * (s.len - 2);
      const p = wallPoint(s, a, y0 + r() * (y1 - y0), 0.004);
      if (!nearWindow(p, margin) && (p.y > 2.2 || !nearLocker(p, margin))) return { s, p };
    }
    const s = sides[0];
    return { s, p: wallPoint(s, 0, y0, 0.004) };
  };

  // ---- decals ----------------------------------------------------------------------------------------------------
  interface Decal {
    pos: THREE.Vector3;
    normal: THREE.Vector3;
    w: number;
    hgt: number;
    rot: number;
    cell: Cell;
    alpha: number;
    tint: number;
    chunk: number;
  }
  const decals: Decal[] = [];
  const wallDecal = (cell: Cell, w: number, hgt: number, y0: number, y1: number, alpha = 1, tint = 0xffffff, margin = 1.2) => {
    const { s, p } = wallSpot(y0, y1, margin);
    decals.push({ pos: p, normal: s.inward.clone(), w, hgt, rot: (r() - 0.5) * 0.12, cell, alpha, tint, chunk: behind(s, p) });
  };
  const floorDecal = (cell: Cell, x: number, z: number, w: number, hgt: number, alpha = 1, tint = 0xffffff, y = 0.004) => {
    decals.push({ pos: new THREE.Vector3(x, y, z), normal: new THREE.Vector3(0, 1, 0), w, hgt, rot: r() * Math.PI * 2, cell, alpha, tint, chunk: -1 });
  };
  const inRoom = () => new THREE.Vector3((r() - 0.5) * (def.w - 1.5), 0, (r() - 0.5) * (def.d - 1.5));
  const chapel = def.id === 'chapel';
  const station = def.id === 'station';
  const storage = def.id === 'storage';

  // Posters, notices, the sign, the tally, graffiti.
  for (let k = 0; k < (chapel ? 2 : 5); k++) wallDecal(k % 2 ? Cell.PosterB : Cell.PosterA, 0.48, 0.56, 1.4, 1.9);
  wallDecal(Cell.Warning, 0.95, 0.95, 1.6, 2.2);
  wallDecal(Cell.Tally, 0.9, 0.9, 1.1, 1.6);
  if (!chapel) wallDecal(Cell.Scrawl, 1.7, 1.7, 1.2, 1.8, 0.9);
  // Old blood on the walls and the floor near the windows.
  for (let k = 0; k < 4; k++) wallDecal(Cell.BloodWall, 0.7, 0.9, 0.7, 1.3, 0.85, 0xffffff, 0.4);
  for (const w of world.windows) {
    // Soot above, damp streaks below, a stain where the zombies climb in.
    const s = sides.find((x) => (x.along === 'x' ? Math.abs(w.center.z - x.fixed) < 1 : Math.abs(w.center.x - x.fixed) < 1))!;
    const a = s.along === 'x' ? w.center.x : w.center.z;
    const above = wallPoint(s, a, WINDOW_TOP + 0.45, 0.004);
    decals.push({ pos: above, normal: s.inward.clone(), w: 2.2, hgt: 1.0, rot: 0, cell: Cell.Soot, alpha: 0.55, tint: 0xffffff, chunk: behind(s, above) });
    const below = wallPoint(s, a, SILL_Y * 0.5, 0.004);
    decals.push({ pos: below, normal: s.inward.clone(), w: 1.7, hgt: 1.0, rot: Math.PI, cell: Cell.Damp, alpha: 0.7, tint: 0xffffff, chunk: behind(s, below) });
    if (r() < 0.6) floorDecal(Cell.Stain, w.inside.x + (r() - 0.5) * 0.5, w.inside.z + (r() - 0.5) * 0.5, 1.6, 1.6, 0.7, 0x5a1010);
  }
  for (let k = 0; k < 3; k++) {
    const p = inRoom();
    floorDecal(Cell.Drag, p.x, p.z, 0.9, 2.6, 0.85);
  }
  for (let k = 0; k < 9; k++) {
    const p = inRoom();
    floorDecal(Cell.Stain, p.x, p.z, 1 + r() * 1.6, 1 + r() * 1.6, 0.5 + r() * 0.4);
  }
  // Soot on the ceiling over every lamp.
  for (const L of world.lamps) decals.push({ pos: new THREE.Vector3(L.pos.x, h - 0.006, L.pos.z), normal: new THREE.Vector3(0, -1, 0), w: 2.2, hgt: 2.2, rot: r() * 6, cell: Cell.Soot, alpha: 0.8, tint: 0xffffff, chunk: -1 });
  // Cobwebs in the upper corners and over some windows.
  const corners: [number, number, number][] = [
    [-hw, -hd, 0],
    [hw, -hd, Math.PI / 2],
    [hw, hd, Math.PI],
    [-hw, hd, -Math.PI / 2],
  ];
  for (const [x, z, yaw] of corners) {
    // A plane across the corner, facing the room, top edge under the ceiling.
    const size = 1.4 + r() * 0.6;
    const d = new THREE.Vector3(Math.cos(yaw + Math.PI / 4), 0, -Math.sin(yaw + Math.PI / 4));
    const inward = new THREE.Vector3(-Math.sign(x), 0, -Math.sign(z)).normalize();
    const p = new THREE.Vector3(x, h - size * 0.35, z).addScaledVector(inward, size * 0.32);
    decals.push({ pos: p, normal: inward, w: size, hgt: size, rot: Math.PI * 0.75 + (Math.sign(x) * Math.sign(z) > 0 ? Math.PI / 2 : 0), cell: Cell.Web, alpha: 0.75, tint: 0xffffff, chunk: -1 });
    void d;
  }
  // Papers and leaves (more leaves near the windows and outside).
  const scraps = quality === 'low' ? 60 : 140;
  for (let k = 0; k < scraps; k++) {
    const p = inRoom();
    const cell = [Cell.Paper, Cell.News, Cell.LeafA, Cell.LeafB][Math.floor(r() * 4)];
    const s = cell === Cell.LeafA || cell === Cell.LeafB ? 0.09 + r() * 0.07 : 0.2 + r() * 0.12;
    floorDecal(cell, p.x, p.z, s, s * (cell === Cell.News ? 0.8 : 1), 0.95, 0xffffff, 0.003 + r() * 0.002);
  }
  for (const w of world.windows)
    for (let k = 0; k < 10; k++) {
      const s = 0.08 + r() * 0.08;
      floorDecal(r() < 0.5 ? Cell.LeafA : Cell.LeafB, w.inside.x + (r() - 0.5) * 2, w.inside.z + (r() - 0.5) * 2, s, s);
    }
  const b = world.bounds;
  for (let k = 0; k < (quality === 'low' ? 120 : 320); k++) {
    const x = b.minX + r() * (b.maxX - b.minX);
    const z = b.minZ + r() * (b.maxZ - b.minZ);
    if (Math.abs(x) < hw + 0.6 && Math.abs(z) < hd + 0.6) continue;
    const s = 0.09 + r() * 0.09;
    floorDecal(r() < 0.5 ? Cell.LeafA : Cell.LeafB, x, z, s, s, 0.9, 0xffffff, 0.002);
  }
  if (station) {
    // Floor grates in a row down the middle.
    for (const z of [-8, -3, 3, 8]) decals.push({ pos: new THREE.Vector3(0, 0.005, z), normal: new THREE.Vector3(0, 1, 0), w: 1.4, hgt: 1.0, rot: 0, cell: Cell.Grate, alpha: 1, tint: 0xffffff, chunk: -1 });
  }

  {
    const geo = keep(new THREE.PlaneGeometry(1, 1));
    const cellAttr = new Float32Array(decals.length * 3);
    const mat = keep(
      new THREE.MeshStandardMaterial({
        map: atlas(),
        transparent: true,
        depthWrite: false,
        roughness: 0.82,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        envMapIntensity: 0.3,
      }),
    );
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aCell;\nvarying float vDecalA;')
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
#ifdef USE_MAP
vMapUv = (uv + vec2(mod(aCell.x, ${CELLS}.0), ${CELLS - 1}.0 - floor(aCell.x / ${CELLS}.0))) / ${CELLS}.0;
#endif
vDecalA = aCell.y;`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDecalA;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vDecalA;\nif (diffuseColor.a < 0.02) discard;');
    };
    mat.customProgramCacheKey = () => 'zdecal';
    const mesh = new THREE.InstancedMesh(geo, mat, decals.length);
    mesh.name = 'decals';
    mesh.receiveShadow = true;
    mesh.userData.noMoonShadow = true;
    mesh.renderOrder = 1;
    const col = new THREE.Color();
    decals.forEach((d, i) => {
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.normal);
      const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), d.rot);
      q.multiply(spin);
      m4.compose(d.pos, q, sc.set(d.w, d.hgt, 1));
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, col.set(d.tint));
      cellAttr[i * 3] = d.cell;
      cellAttr[i * 3 + 1] = d.alpha;
      onBreak(d.chunk, () => {
        mesh.setMatrixAt(i, zero);
        mesh.instanceMatrix.needsUpdate = true;
      });
    });
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cellAttr, 3));
    mesh.computeBoundingSphere();
    group.add(mesh);
  }

  // ---- rubble and dust piles along the walls ------------------------------------------------------------------------
  let rubbleMesh: THREE.InstancedMesh | null = null;
  {
    const parts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 3; k++) {
      const g = new THREE.IcosahedronGeometry(1, 0);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      for (let j = 0; j < pos.count; j++) pos.setXYZ(j, pos.getX(j) * (0.7 + r() * 0.6), pos.getY(j) * (0.5 + r() * 0.5), pos.getZ(j) * (0.7 + r() * 0.6));
      g.computeVertexNormals();
      parts.push(g);
    }
    const rock = keep(parts[0]);
    for (const p of parts.slice(1)) p.dispose();
    const wallColor = { brick: 0x6a3a2c, plaster: 0xa49c8c, concrete: 0x77736a, wood: 0x5a4430, metal: 0x4a4a48 }[def.wall];
    const count = quality === 'low' ? 260 : 620;
    const mat = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 }));
    const mesh = new THREE.InstancedMesh(rock, mat, count);
    mesh.receiveShadow = true;
    mesh.castShadow = quality === 'high';
    rubbleMesh = mesh;
    const col = new THREE.Color();
    let n = 0;
    while (n < count) {
      // Clusters along wall bases, a few strays in the open.
      const s = sides[Math.floor(r() * 4)];
      const a = (r() - 0.5) * (s.len - 0.6);
      const off = r() < 0.85 ? 0.05 + Math.pow(r(), 2) * 0.7 : 1 + r() * 6;
      const p = wallPoint(s, a, 0, off);
      const cluster = 3 + Math.floor(r() * 6);
      for (let k = 0; k < cluster && n < count; k++, n++) {
        const size = 0.025 + Math.pow(r(), 3) * 0.13;
        v.set(p.x + (r() - 0.5) * 0.35, size * 0.25, p.z + (r() - 0.5) * 0.35);
        e.set(r() * 6, r() * 6, r() * 6);
        q.setFromEuler(e);
        m4.compose(v, q, sc.set(size, size, size));
        mesh.setMatrixAt(n, m4);
        mesh.setColorAt(n, col.set(r() < 0.75 ? wallColor : 0x5e5a52).multiplyScalar(0.6 + r() * 0.5));
      }
    }
    mesh.computeBoundingSphere();
    group.add(mesh);
    // Dust piles: flattened mounds in corners and under the windows.
    const mound = keep(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2));
    const piles = new THREE.InstancedMesh(mound, keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(wallColor).lerp(new THREE.Color(0x8a8070), 0.6), roughness: 1 })), 24);
    piles.receiveShadow = true;
    let pn = 0;
    for (const [x, z] of corners) {
      v.set(x - Math.sign(x) * 0.35, 0, z - Math.sign(z) * 0.35);
      m4.compose(v, q.identity(), sc.set(0.7, 0.12, 0.6));
      piles.setMatrixAt(pn++, m4);
    }
    for (const w of world.windows) {
      if (pn >= 24) break;
      v.set(w.inside.x - w.out.x * 0.2, 0, w.inside.z - w.out.z * 0.2);
      m4.compose(v, q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 3), sc.set(0.55, 0.06, 0.4));
      piles.setMatrixAt(pn++, m4);
    }
    piles.count = pn;
    piles.computeBoundingSphere();
    group.add(piles);
  }

  // ---- glass shards under the windows ---------------------------------------------------------------------------------
  {
    const shard = keep(new THREE.BufferGeometry());
    shard.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.3, 0.5, 0, -0.1, -0.1, 0, 0.5], 3));
    shard.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    const mat = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0.1, envMapIntensity: 2.2, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
    const per = 18;
    const mesh = new THREE.InstancedMesh(shard, mat, world.windows.length * per * 2);
    mesh.userData.noMoonShadow = true;
    const stained = [0x8a1a14, 0x1d3a8a, 0x2a7a2a, 0xb08a1a, 0x6a2a7a];
    const col = new THREE.Color();
    let n = 0;
    for (const w of world.windows)
      for (let side = -1; side <= 1; side += 2)
        for (let k = 0; k < per; k++) {
          // Inside and outside, spread below the opening.
          const d = 0.15 + Math.pow(r(), 1.5) * 1.6;
          const lat = (r() - 0.5) * (w.width + 0.6);
          v.set(w.center.x + w.out.x * side * (WALL_T / 2 + d) - w.out.z * lat, 0.004, w.center.z + w.out.z * side * (WALL_T / 2 + d) + w.out.x * lat);
          const s = 0.03 + r() * 0.08;
          m4.compose(v, q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), sc.set(s, 1, s));
          mesh.setMatrixAt(n, m4);
          mesh.setColorAt(n, chapel ? col.set(stained[Math.floor(r() * stained.length)]).multiplyScalar(1.6) : col.set(0x9fb4b0));
          n++;
        }
    mesh.count = n;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }

  // ---- pipes, conduit, brackets (not in the chapel) ------------------------------------------------------------------
  if (!chapel) {
    const pipeGeo = keep(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).rotateZ(Math.PI / 2));
    const runs: { y: number; off: number; r: number; mat: THREE.Material }[] = [
      { y: h - 0.55, off: 0.16, r: 0.065, mat: mats.iron },
      { y: h - 0.85, off: 0.06, r: 0.022, mat: mats.steel },
    ];
    for (const run of runs) {
      const slots: { m: THREE.Matrix4; chunk: number }[] = [];
      for (const s of sides) {
        // Not every wall: the big pipe runs along two of them, conduit along three.
        if (run.r > 0.05 && (s.along === 'z') === (def.w > def.d)) continue;
        for (let a = -s.len / 2 + 0.25; a < s.len / 2; a += 0.5) {
          const p = wallPoint(s, a, run.y, run.off + run.r);
          const yaw = s.along === 'x' ? 0 : Math.PI / 2;
          m4.compose(p, q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), sc.set(0.5, run.r, run.r));
          slots.push({ m: m4.clone(), chunk: behind(s, wallPoint(s, a, run.y, 0)) });
        }
      }
      // Above the lamps: their shadows would never land anywhere, so they cast none.
      const mesh = new THREE.InstancedMesh(pipeGeo, run.mat, slots.length);
      mesh.receiveShadow = true;
      slots.forEach((sl, i) => {
        mesh.setMatrixAt(i, sl.m);
        onBreak(sl.chunk, () => {
          mesh.setMatrixAt(i, zero);
          mesh.instanceMatrix.needsUpdate = true;
        });
      });
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    // Brackets every 1.5 m under the big pipe.
    const bracketGeo = keep(new THREE.BoxGeometry(0.05, 0.03, 0.26).translate(0, 0, 0.13));
    const bslots: { m: THREE.Matrix4; chunk: number }[] = [];
    for (const s of sides) {
      if ((s.along === 'z') === (def.w > def.d)) continue;
      for (let a = -s.len / 2 + 0.75; a < s.len / 2; a += 1.5) {
        const p = wallPoint(s, a, h - 0.55 - 0.08, 0);
        m4.compose(p, q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), s.inward), sc.set(1, 1, 1));
        bslots.push({ m: m4.clone(), chunk: behind(s, p) });
      }
    }
    const brackets = new THREE.InstancedMesh(bracketGeo, mats.iron, bslots.length);
    bslots.forEach((sl, i) => {
      brackets.setMatrixAt(i, sl.m);
      onBreak(sl.chunk, () => {
        brackets.setMatrixAt(i, zero);
        brackets.instanceMatrix.needsUpdate = true;
      });
    });
    brackets.computeBoundingSphere();
    group.add(brackets);
  }

  // ---- hanging cables -------------------------------------------------------------------------------------------------
  {
    const parts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 7; k++) {
      const x0 = (r() - 0.5) * (def.w - 2);
      const z0 = (r() - 0.5) * (def.d - 2);
      const len = 2 + r() * 4;
      const yaw = r() * 6.28;
      const x1 = x0 + Math.cos(yaw) * len;
      const z1 = z0 + Math.sin(yaw) * len;
      const sag = 0.4 + r() * 1.1;
      const pts: THREE.Vector3[] = [];
      for (let t = 0; t <= 1.0001; t += 0.1) pts.push(new THREE.Vector3(x0 + (x1 - x0) * t, h - 0.36 - sag * 4 * t * (1 - t), z0 + (z1 - z0) * t));
      // Some cables snapped: the far end hangs straight down.
      if (r() < 0.35) for (let t = 1; t <= 4; t++) pts.push(new THREE.Vector3(x1 + r() * 0.05, h - 0.36 - t * 0.3, z1));
      parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.012, 5, false));
    }
    const cables = new THREE.Mesh(keep(mergeGeometries(parts)), keep(new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.55 })));
    for (const p of parts) p.dispose();
    group.add(cables);
  }

  // ---- per map ----------------------------------------------------------------------------------------------------
  const rust = keep(new THREE.MeshStandardMaterial({ color: 0x6a3a1e, roughness: 0.75, metalness: 0.6 }));
  const paint = keep(new THREE.MeshStandardMaterial({ color: 0x8a4a12, roughness: 0.6, metalness: 0.5 }));
  if (storage) {
    // Chains with hooks hanging from the beams, swaying a little.
    const links: THREE.BufferGeometry[] = [];
    const n = 22;
    for (let k = 0; k < n; k++) {
      const t = new THREE.TorusGeometry(0.035, 0.008, 4, 8);
      if (k % 2) t.rotateY(Math.PI / 2);
      t.translate(0, -k * 0.055, 0);
      links.push(t);
    }
    const hook = new THREE.TorusGeometry(0.07, 0.014, 5, 10, Math.PI * 1.4).rotateZ(Math.PI * 0.8);
    hook.translate(0.05, -n * 0.055 - 0.06, 0);
    links.push(hook);
    const chainGeo = keep(mergeGeometries(links));
    for (const l of links) l.dispose();
    for (let k = 0; k < 6; k++) {
      const pivot = new THREE.Group();
      const z = -def.d / 2 + 1.5 + 3 * Math.floor(r() * (def.d / 3 - 1));
      pivot.position.set((r() - 0.5) * (def.w - 3), h - 0.36, z);
      const chain = new THREE.Mesh(chainGeo, mats.iron);
      chain.castShadow = true;
      chain.scale.y = 0.8 + r() * 0.8;
      pivot.add(chain);
      group.add(pivot);
      const seed = r() * 10;
      updaters.push((_dt, time) => {
        pivot.rotation.z = Math.sin(time * 0.9 + seed) * 0.03;
        pivot.rotation.x = Math.sin(time * 0.7 + seed * 2) * 0.025;
      });
    }
    // A ventilation duct along the room under the beams, one section hanging loose.
    {
      const parts: THREE.BufferGeometry[] = [];
      const z = def.d / 2 - 4;
      const x0 = -def.w / 2 + 1;
      const x1 = def.w / 2 - 5;
      parts.push(new THREE.BoxGeometry(x1 - x0, 0.42, 0.6).translate((x0 + x1) / 2, h - 0.62, z));
      for (let x = x0; x <= x1; x += 1.2) parts.push(new THREE.BoxGeometry(0.05, 0.48, 0.66).translate(x, h - 0.62, z));
      for (let x = x0 + 0.6; x <= x1; x += 2.4) parts.push(new THREE.BoxGeometry(0.03, 0.4, 0.03).translate(x, h - 0.25, z));
      const loose = new THREE.BoxGeometry(1.6, 0.42, 0.6).translate(0.8, 0, 0);
      loose.rotateZ(-0.55);
      loose.translate(x1, h - 0.62, z);
      parts.push(loose);
      const duct = new THREE.Mesh(keep(mergeGeometries(parts)), mats.steel);
      for (const p of parts) p.dispose();
      duct.receiveShadow = true;
      group.add(duct);
    }
    // Racking uprights and a beam bolted to two walls, pallets leaning on them.
    for (let k = 0; k < 2; k++) {
      const { s, p } = wallSpot(0, 0, 2);
      const along = s.along === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const parts: THREE.BufferGeometry[] = [];
      for (const d of [-1.1, 1.1]) parts.push(new THREE.BoxGeometry(0.08, 3.2, 0.08).translate(along.x * d, 1.6, along.z * d));
      for (const y of [0.9, 2.1, 3.1]) parts.push(new THREE.BoxGeometry(along.x ? 2.3 : 0.09, 0.12, along.z ? 2.3 : 0.09).translate(0, y, 0));
      // One beam dropped at one end.
      const fallen = new THREE.BoxGeometry(2.2, 0.12, 0.09);
      fallen.rotateZ(0.5);
      if (along.z) fallen.rotateY(Math.PI / 2);
      fallen.translate(along.x * 0.2, 1.4, along.z * 0.2);
      parts.push(fallen);
      const rack = new THREE.Mesh(keep(mergeGeometries(parts)), paint);
      for (const g of parts) g.dispose();
      rack.position.copy(p).addScaledVector(s.inward, 0.07);
      rack.castShadow = true;
      group.add(rack);
      // Pallet leaning against the wall beside it.
      const slats: THREE.BufferGeometry[] = [];
      for (let j = 0; j < 7; j++) slats.push(new THREE.BoxGeometry(0.1, 1.2, 0.02).translate(-0.5 + j * 0.166, 0, 0));
      for (const y of [-0.5, 0, 0.5]) slats.push(new THREE.BoxGeometry(1.1, 0.09, 0.1).translate(0, y, -0.06));
      const pallet = new THREE.Mesh(keep(mergeGeometries(slats)), mats.wood);
      for (const g of slats) g.dispose();
      pallet.position.copy(p).addScaledVector(along, 1.9).addScaledVector(s.inward, 0.25);
      pallet.position.y = 0.58;
      pallet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), s.inward);
      pallet.rotateX(-0.2);
      pallet.castShadow = true;
      group.add(pallet);
    }
  }
  if (station) {
    // Pipe manifolds: vertical pipes on two walls with a valve wheel and a gauge each.
    const gaugeTex = makeGaugeTexture();
    disposables.push(gaugeTex);
    const gaugeMat = keep(new THREE.MeshStandardMaterial({ map: gaugeTex, roughness: 0.3, metalness: 0.2, emissive: 0x111111, emissiveMap: gaugeTex }));
    for (let k = 0; k < 3; k++) {
      const { s, p } = wallSpot(0, 0, 1.6);
      const along = s.along === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const holder = new THREE.Group();
      holder.position.copy(p);
      group.add(holder);
      const chunk = behind(s, new THREE.Vector3(p.x, 1.2, p.z));
      for (const d of [-0.35, 0, 0.35]) {
        const pipe = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.07, 0.07, h, 12)), mats.iron);
        pipe.position.copy(along).multiplyScalar(d).addScaledVector(s.inward, 0.12);
        pipe.position.y = h / 2;
        pipe.castShadow = true;
        holder.add(pipe);
        for (const y of [0.3, h - 0.3]) {
          const flange = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.1, 0.1, 0.04, 12)), mats.iron);
          flange.position.copy(pipe.position);
          flange.position.y = y;
          holder.add(flange);
        }
      }
      const wheel = new THREE.Mesh(keep(new THREE.TorusGeometry(0.16, 0.018, 6, 18)), keep(new THREE.MeshStandardMaterial({ color: 0x7a1410, roughness: 0.6, metalness: 0.4 })));
      wheel.position.copy(s.inward).multiplyScalar(0.27);
      wheel.position.y = 1.25;
      wheel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), s.inward);
      wheel.castShadow = true;
      holder.add(wheel);
      const gauge = new THREE.Mesh(keep(new THREE.CircleGeometry(0.09, 20)), gaugeMat);
      gauge.position.copy(along).multiplyScalar(0.18).addScaledVector(s.inward, 0.2);
      gauge.position.y = 1.6;
      gauge.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), s.inward);
      holder.add(gauge);
      onBreak(chunk, () => (holder.visible = false));
    }
  }
  if (chapel) {
    // A wooden cross on the north wall over the altar.
    const s = sides[0];
    const p = wallPoint(s, 0, 3.6, 0.06);
    const cross = new THREE.Mesh(keep(mergeGeometries([new THREE.BoxGeometry(0.16, 1.8, 0.1), new THREE.BoxGeometry(1.0, 0.16, 0.1).translate(0, 0.35, 0)])), mats.wood);
    cross.position.copy(p);
    cross.rotation.z = 0.05;
    cross.castShadow = true;
    group.add(cross);
    onBreak(behind(s, wallPoint(s, 0, 3.6, 0)), () => (cross.visible = false));
    // Candles on the altar, with flames and one shared warm light.
    const altar = def.props.find((pr) => pr.kind === 'altar');
    if (altar) {
      const candleMat = keep(new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.6 }));
      const flameMat = keep(new THREE.MeshBasicMaterial({ color: 0xffb050, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      flameMat.color.multiplyScalar(4);
      const flames: { mesh: THREE.Mesh; seed: number }[] = [];
      const top = 1.0;
      for (let k = 0; k < 9; k++) {
        const x = altar.x + (r() - 0.5) * 1.7;
        const z = altar.z + (r() - 0.5) * 0.7;
        const hh = 0.08 + r() * 0.22;
        const candle = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.022, 0.025, hh, 8)), candleMat);
        candle.position.set(x, top + hh / 2, z);
        candle.castShadow = true;
        group.add(candle);
        const flame = new THREE.Mesh(keep(new THREE.ConeGeometry(0.012, 0.045, 6)), flameMat);
        flame.position.set(x, top + hh + 0.025, z);
        flame.userData.noMoonShadow = true;
        group.add(flame);
        const f = { mesh: flame, seed: r() * 10 };
        flames.push(f);
        const chunk = chunkAt({ x, y: top - 0.05, z });
        onBreak(chunk, () => {
          candle.visible = false;
          flame.visible = false;
          flames.splice(flames.indexOf(f), 1);
        });
      }
      const light = new THREE.PointLight(0xff9a40, 3, 6, 1.8);
      light.position.set(altar.x, top + 0.45, altar.z);
      group.add(light);
      const glow: Glow = { pos: { x: altar.x, y: top + 0.4, z: altar.z }, color: new THREE.Color(0xff9a40), intensity: 2 };
      glows.push(glow);
      updaters.push((_dt, time) => {
        let sum = 0;
        for (const f of flames) {
          const k = 0.8 + 0.25 * Math.sin(time * 13 + f.seed) * Math.sin(time * 7.3 + f.seed * 2);
          f.mesh.scale.set(1, k, 1);
          sum += k;
        }
        const level = flames.length ? sum / 9 : 0;
        light.intensity = 3.2 * level;
        glow.intensity = 2.2 * level;
      });
    }
  }

  // ---- drips --------------------------------------------------------------------------------------------------------
  {
    const dropGeo = keep(new THREE.SphereGeometry(0.008, 6, 4).scale(1, 2.2, 1));
    const dropMat = keep(new THREE.MeshStandardMaterial({ color: 0x9aa8b0, roughness: 0.05, metalness: 0, envMapIntensity: 2 }));
    const ringGeo = keep(new THREE.RingGeometry(0.85, 1, 24).rotateX(-Math.PI / 2));
    const puddleGeo = keep(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2));
    const puddleMat = keep(new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.02, metalness: 0, envMapIntensity: 1.6, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
    for (let k = 0; k < (chapel ? 2 : 4); k++) {
      const x = (r() - 0.5) * (def.w - 3);
      const z = (r() - 0.5) * (def.d - 3);
      const puddle = new THREE.Mesh(puddleGeo, puddleMat);
      puddle.position.set(x, 0.003, z);
      puddle.scale.set(0.35 + r() * 0.25, 1, 0.3 + r() * 0.2);
      puddle.userData.noMoonShadow = true;
      group.add(puddle);
      const drop = new THREE.Mesh(dropGeo, dropMat);
      drop.userData.noMoonShadow = true;
      group.add(drop);
      const ringMat = keep(new THREE.MeshStandardMaterial({ color: 0xb0b8c0, roughness: 0.1, transparent: true, opacity: 0, depthWrite: false }));
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(x, 0.006, z);
      ring.userData.noMoonShadow = true;
      group.add(ring);
      let t = r() * 3;
      let period = 1.5 + r() * 2.5;
      const fall = Math.sqrt((2 * (h - 0.4)) / 9.81);
      updaters.push((dt) => {
        t += dt;
        if (t > period) {
          t -= period;
          period = 1.5 + Math.random() * 2.5;
        }
        drop.visible = t < fall;
        drop.position.set(x, h - 0.4 - 0.5 * 9.81 * t * t, z);
        const rt = t - fall;
        if (rt >= 0 && rt < 0.9) {
          const k = rt / 0.9;
          ring.scale.setScalar(0.03 + k * 0.3);
          ringMat.opacity = (1 - k) * 0.45;
        } else ringMat.opacity = 0;
      });
    }
  }

  // ---- broken fluorescent tube ------------------------------------------------------------------------------------------
  if (!chapel) {
    const x = (r() - 0.5) * (def.w - 6);
    const z = (r() - 0.5) * (def.d - 6);
    const pivot = new THREE.Group();
    pivot.position.set(x, h - 0.35, z);
    group.add(pivot);
    // Hangs from one chain; the other end has come down.
    const housing = new THREE.Mesh(keep(new THREE.BoxGeometry(1.25, 0.06, 0.16).translate(0.62, 0, 0)), mats.steel);
    const tubeMat = keep(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xdcefff, emissiveIntensity: 6 }));
    const tube = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.016, 0.016, 1.15, 8).rotateZ(Math.PI / 2).translate(0.62, -0.045, 0)), tubeMat);
    tube.userData.noMoonShadow = true;
    const arm = new THREE.Group();
    arm.rotation.z = -0.62;
    arm.add(housing, tube);
    pivot.add(arm);
    const chainLine = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.006, 0.006, 0.35, 4).translate(0, 0.175, 0)), mats.iron);
    pivot.add(chainLine);
    housing.castShadow = true;
    const spot = new THREE.SpotLight(0xdcefff, 0, 11, 1.25, 0.9, 2);
    spot.position.set(0.5, -0.4, 0);
    spot.target.position.set(0.7, -3, 0);
    pivot.add(spot, spot.target);
    spot.layers.enableAll();
    const color = new THREE.Color(0x9fc6ff);
    const lamp: Decor['lamps'][number] = {
      pos: { x: x + 0.5, y: h - 0.75, z },
      light: spot,
      level: 0,
      color,
      update(time) {
        // Mostly dead, stuttering on in bursts with the classic starter flicker.
        const burst = Math.sin(time * 0.37) * Math.sin(time * 0.71 + 1.3);
        let level = 0;
        if (burst > 0.25) level = Math.random() < 0.55 ? 0.8 + Math.random() * 0.2 : 0.05;
        else if (Math.random() < 0.01) level = 1;
        lamp.level = level;
        spot.intensity = 26 * level;
        tubeMat.emissiveIntensity = 0.15 + 7 * level;
        pivot.rotation.x = Math.sin(time * 0.8) * 0.02;
      },
    };
    lamps.push(lamp);
  }

  // ---- exit sign --------------------------------------------------------------------------------------------------
  {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 96;
    const g = c.getContext('2d')!;
    g.fillStyle = '#100404';
    g.fillRect(0, 0, 256, 96);
    g.fillStyle = '#ff2a1c';
    g.font = '700 64px Impact, "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.fillText('EXIT', 128, 74);
    const tex = keep(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    const { s, p } = wallSpot(2.7, 2.75, 1.4);
    const sign = new THREE.Mesh(keep(new THREE.BoxGeometry(0.42, 0.16, 0.06)), [
      mats.steel,
      mats.steel,
      mats.steel,
      mats.steel,
      keep(new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 3, roughness: 0.4 })),
      mats.steel,
    ]);
    sign.position.copy(p).addScaledVector(s.inward, 0.035);
    sign.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), s.inward);
    group.add(sign);
    const red = new THREE.PointLight(0xff2a1c, 1.6, 4, 2);
    highLights.push(red);
    red.position.copy(p).addScaledVector(s.inward, 0.3);
    group.add(red);
    const glow: Glow = { pos: { x: red.position.x, y: red.position.y, z: red.position.z }, color: new THREE.Color(0xff2a1c), intensity: 1.2 };
    glows.push(glow);
    onBreak(behind(s, p), () => {
      sign.visible = false;
      red.intensity = 0;
      glow.intensity = 0;
    });
  }

  // ---- yard -------------------------------------------------------------------------------------------------------
  const windU = { value: 0 };
  {
    // Grass tufts: two crossed quads with a blade texture, swaying in the wind.
    const gc = document.createElement('canvas');
    gc.width = 128;
    gc.height = 128;
    const g = gc.getContext('2d')!;
    for (let k = 0; k < 26; k++) {
      const x = 10 + r() * 108;
      const top = 10 + r() * 70;
      g.strokeStyle = `rgb(${40 + r() * 30},${46 + r() * 30},${24 + r() * 14})`;
      g.lineWidth = 2 + r() * 2;
      g.beginPath();
      g.moveTo(64 + (x - 64) * 0.3, 128);
      g.quadraticCurveTo(x, 70, x + (r() - 0.5) * 30, top);
      g.stroke();
    }
    const tex = keep(new THREE.CanvasTexture(gc));
    tex.colorSpace = THREE.SRGBColorSpace;
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const tuft = keep(mergeGeometries([quad.clone(), quad.clone().rotateY(Math.PI / 2), quad.clone().rotateY(Math.PI / 4)]));
    quad.dispose();
    const mat = keep(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9 }));
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uWind = windU;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWind;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
float zPh = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.4;
float zW = sin(uWind * 1.7 + zPh) * 0.6 + sin(uWind * 3.1 + zPh * 1.9) * 0.4;
transformed.x += zW * 0.12 * position.y * position.y;
transformed.z += zW * 0.05 * position.y * position.y;
#endif`,
      );
    };
    mat.customProgramCacheKey = () => 'zgrass';
    const count = quality === 'low' ? 700 : 1800;
    const mesh = new THREE.InstancedMesh(tuft, mat, count);
    mesh.receiveShadow = true;
    mesh.userData.noMoonShadow = true;
    const col = new THREE.Color();
    let n = 0;
    for (let guard = 0; n < count && guard < count * 5; guard++) {
      const x = b.minX - 14 + r() * (b.maxX - b.minX + 28);
      const z = b.minZ - 14 + r() * (b.maxZ - b.minZ + 28);
      if (Math.abs(x) < hw + 1 && Math.abs(z) < hd + 1) continue;
      // Thicker near the walls and the fence, thin in the trampled middle of the yard.
      const dWall = Math.min(Math.abs(Math.abs(x) - hw), Math.abs(Math.abs(z) - hd));
      if (r() > 0.25 + Math.min(1, Math.abs(dWall - 4) / 4) * 0.75) continue;
      const s = 0.25 + r() * 0.45;
      m4.compose(v.set(x, 0, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), sc.set(s * (0.8 + r() * 0.6), s, s));
      mesh.setMatrixAt(n, m4);
      mesh.setColorAt(n, col.setRGB(0.5 + r() * 0.3, 0.55 + r() * 0.3, 0.4 + r() * 0.2));
      n++;
    }
    mesh.count = n;
    mesh.computeBoundingSphere();
    group.add(mesh);
    // Puddles in the mud that catch the moon.
    const puddleMat = keep(new THREE.MeshStandardMaterial({ color: 0x030405, roughness: 0.02, metalness: 0, envMapIntensity: 1.4, polygonOffset: true, polygonOffsetFactor: -1 }));
    for (let k = 0; k < 14; k++) {
      const x = b.minX + 1 + r() * (b.maxX - b.minX - 2);
      const z = b.minZ + 1 + r() * (b.maxZ - b.minZ - 2);
      if (Math.abs(x) < hw + 1.2 && Math.abs(z) < hd + 1.2) continue;
      const pg = new THREE.CircleGeometry(1, 18);
      const pos = pg.getAttribute('position') as THREE.BufferAttribute;
      for (let j = 1; j < pos.count; j++) {
        const k2 = 0.7 + r() * 0.4;
        pos.setXY(j, pos.getX(j) * k2, pos.getY(j) * k2);
      }
      pg.rotateX(-Math.PI / 2);
      const pm = new THREE.Mesh(keep(pg), puddleMat);
      pm.position.set(x, 0.002, z);
      pm.scale.set(0.5 + r() * 1.3, 1, 0.4 + r() * 0.9);
      pm.rotation.y = r() * 6;
      pm.receiveShadow = true;
      group.add(pm);
    }
  }

  // ---- a burning car wreck beyond the fence ---------------------------------------------------------------------------
  {
    const ang = def.moon.yaw + Math.PI + 0.5;
    const dist = Math.max(b.maxX, b.maxZ) + 9;
    const cx = Math.sin(ang) * dist;
    const cz = Math.cos(ang) * dist;
    const wreck = new THREE.Group();
    wreck.position.set(cx, 0, cz);
    wreck.rotation.y = ang + 0.4;
    group.add(wreck);
    const charred = keep(new THREE.MeshStandardMaterial({ color: 0x171310, roughness: 0.85, metalness: 0.5 }));
    const body = mergeGeometries([
      new THREE.BoxGeometry(1.8, 0.55, 4.2).translate(0, 0.62, 0),
      new THREE.BoxGeometry(1.6, 0.5, 2.0).translate(0, 1.12, -0.2),
      new THREE.BoxGeometry(1.7, 0.1, 1.2).translate(0.1, 0.92, 1.5).rotateZ(0.08),
    ]);
    const car = new THREE.Mesh(keep(body), charred);
    car.rotation.z = 0.12;
    car.castShadow = true;
    wreck.add(car);
    for (const [x, z] of [
      [-0.85, 1.3],
      [0.85, 1.3],
      [-0.85, -1.3],
    ]) {
      const wheel = new THREE.Mesh(keep(new THREE.TorusGeometry(0.3, 0.1, 6, 12).rotateY(Math.PI / 2)), charred);
      wheel.position.set(x, 0.32, z);
      wreck.add(wheel);
    }
    // Flames: a few crossed additive cards with a noise shader.
    const fireMat = keep(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uTime: windU },
        vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
uniform float uTime;
varying vec2 vUv;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 p = vUv * vec2(3.0, 2.0) - vec2(0.0, uTime * 2.2);
  float f = n(p * 2.0) * 0.6 + n(p * 4.3) * 0.4;
  float shape = (1.0 - abs(vUv.x - 0.5) * 2.0) * (1.0 - vUv.y);
  float k = smoothstep(0.35, 0.9, f * 0.6 + shape * 0.9 - vUv.y * 0.45);
  vec3 col = mix(vec3(1.0, 0.25, 0.03), vec3(1.0, 0.75, 0.3), k) * k * 6.0;
  gl_FragColor = vec4(col, k);
}`,
      }),
    );
    for (let k = 0; k < 3; k++) {
      const card = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.6, 2.2).translate(0, 1.1, 0)), fireMat);
      card.position.set((k - 1) * 0.35, 0.95, (k - 1) * 0.6);
      card.rotation.y = k * 1.05;
      card.userData.noMoonShadow = true;
      wreck.add(card);
    }
    const fire = new THREE.PointLight(0xff7a2a, 30, 22, 1.6);
    highLights.push(fire);
    fire.position.set(cx, 2, cz);
    group.add(fire);
    const glow: Glow = { pos: { x: cx, y: 2.2, z: cz }, color: new THREE.Color(0xff7a2a), intensity: 8 };
    glows.push(glow);
    updaters.push((_dt, time) => {
      const f = 0.75 + 0.15 * Math.sin(time * 9.1) * Math.sin(time * 5.3 + 1) + 0.1 * Math.sin(time * 17.7);
      fire.intensity = 34 * f;
      glow.intensity = 9 * f;
    });
  }

  const decor: Decor = {
    group,
    glows,
    lamps,
    breakChunk(i) {
      const list = byChunk.get(i);
      if (!list) return;
      byChunk.delete(i);
      for (const fn of list) fn();
    },
    update(dt, time) {
      windU.value = time;
      for (const u of updaters) u(dt, time);
      for (const L of lamps) L.update(time);
    },
    setQuality(q) {
      for (const l of highLights) l.visible = q === 'high';
      if (rubbleMesh) rubbleMesh.castShadow = q === 'high';
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
  decor.setQuality(quality);
  return decor;
}

function makeGaugeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d8d2c0';
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#222';
  g.lineWidth = 6;
  g.stroke();
  g.lineWidth = 2;
  for (let k = 0; k <= 10; k++) {
    const a = Math.PI * 0.75 + (k / 10) * Math.PI * 1.5;
    g.beginPath();
    g.moveTo(64 + Math.cos(a) * 44, 64 + Math.sin(a) * 44);
    g.lineTo(64 + Math.cos(a) * 54, 64 + Math.sin(a) * 54);
    g.stroke();
  }
  g.strokeStyle = '#9a1a12';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(64, 64);
  g.lineTo(64 + Math.cos(Math.PI * 2.1) * 46, 64 + Math.sin(Math.PI * 2.1) * 46);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
