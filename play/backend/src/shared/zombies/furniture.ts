// Furniture as breakable chunks. Every piece of furniture is a handful of material parts (an upholstered seat, a
// marble top, a brass drum, a ceramic pot, a tree's canopy) cut into cells about 0.45 m across, so a burst takes out
// the corner it hits and the rest stays standing (or falls, once nothing connects it to the floor any more).
//
// Parts are boxes in the furniture's own frame, the frame decor.ts builds the stand-ins in: x across the width, y up,
// z through the depth with the back at +z. The holder turns by `yaw` like a three.js rotation.y; a cell's chunk is the
// axis-aligned bounds of the turned cell.

import type { Vec3 } from '../math.js';
import { FURNITURE_SIZE, type FurnitureDef, type FurnitureKind, type Mat } from './maps.js';

export interface FurniturePart {
  min: Vec3;
  max: Vec3;
  mat: Mat;
  /** Largest cell edge this part is cut into. */
  cell: number;
  /** What the part is, for the look of it breaking (decor.ts kills a lamp whose shade goes, and so on). */
  name: FurniturePartName;
}

export type FurniturePartName =
  | 'seat'
  | 'back'
  | 'arm'
  | 'body'
  | 'top'
  | 'leg'
  | 'pole'
  | 'shade'
  | 'pot'
  | 'trunk'
  | 'canopy'
  | 'vase'
  | 'flowers'
  | 'panel'
  | 'deck'
  | 'rail'
  | 'case'
  | 'cloth'
  | 'chair';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const P = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: Mat, name: FurniturePartName, cell = 0.45): FurniturePart => ({
  min: v(x0, y0, z0),
  max: v(x1, y1, z1),
  mat,
  cell,
  name,
});

/** The parts of one piece of furniture, in its own frame. */
export function furnitureParts(kind: FurnitureKind): FurniturePart[] {
  const s = FURNITURE_SIZE[kind];
  const hw = s.w / 2;
  const hd = s.d / 2;
  switch (kind) {
    case 'sofa':
    case 'armchair':
      return [
        P(-hw, hw, 0, 0.53, -hd, hd, 'fabric', 'seat'),
        P(-hw, hw, 0.53, s.h, hd - 0.22, hd, 'fabric', 'back'),
        P(-hw, -hw + 0.18, 0.53, 0.68, -hd, hd - 0.22, 'fabric', 'arm'),
        P(hw - 0.18, hw, 0.53, 0.68, -hd, hd - 0.22, 'fabric', 'arm'),
      ];
    case 'coffeeTable':
    case 'sideTable': {
      const r = hw * 0.94;
      const parts = [P(-r, r, 0, s.h - 0.03, -r, r, 'brass', 'body', 0.5), P(-hw, hw, s.h - 0.03, s.h, -hw, hw, 'marble', 'top', 0.5)];
      if (kind === 'sideTable') parts.push(P(-0.05, 0.05, s.h, s.h + 0.36, -0.05, 0.05, 'brass', 'pole'), P(-0.17, 0.17, s.h + 0.36, s.h + 0.56, -0.17, 0.17, 'fabric', 'shade'));
      return parts;
    }
    case 'floorLamp':
      return [P(-0.17, 0.17, 0, 0.04, -0.17, 0.17, 'brass', 'body'), P(-0.03, 0.03, 0.04, 1.35, -0.03, 0.03, 'brass', 'pole'), P(-0.26, 0.26, 1.35, 1.7, -0.26, 0.26, 'fabric', 'shade', 0.55)];
    case 'planter':
      return [
        // Matched to planterTree in props.glb: a low pot, branches from 0.66 m, leaves 1.25-2.05 m about 0.95 m out.
        P(-0.42, 0.42, 0, 0.66, -0.42, 0.42, 'ceramic', 'pot'),
        P(-0.05, 0.05, 0.66, 1.25, -0.05, 0.05, 'wood', 'trunk'),
        P(-0.95, 0.95, 1.25, 2.05, -0.95, 0.95, 'foliage', 'canopy', 0.6),
      ];
    case 'centerpiece':
      return [
        P(-0.6, 0.6, 0, 0.72, -0.6, 0.6, 'brass', 'body', 0.6),
        P(-0.8, 0.8, 0.72, 0.78, -0.8, 0.8, 'marble', 'top', 0.55),
        P(-0.16, 0.16, 0.78, 1.23, -0.16, 0.16, 'glass', 'vase'),
        P(-0.9, 0.9, 1.23, 2.75, -0.9, 0.9, 'foliage', 'flowers', 0.6),
      ];
    case 'stool':
      return [P(-0.2, 0.2, 0, 0.03, -0.2, 0.2, 'brass', 'body'), P(-0.03, 0.03, 0.03, 0.72, -0.03, 0.03, 'brass', 'pole'), P(-0.2, 0.2, 0.72, s.h, -0.2, 0.2, 'leather', 'seat')];
    case 'booth':
      return [
        P(-hw, hw, 0, 0.45, 0.1, hd - 0.025, 'leather', 'seat'),
        P(-hw, hw, 0.45, s.h, hd - 0.155, hd - 0.025, 'leather', 'back'),
        P(-hw - 0.05, hw + 0.05, 0, s.h, hd - 0.025, hd + 0.025, 'walnut', 'panel'),
        P(-0.05, 0.05, 0, 0.72, -0.3, -0.2, 'brass', 'pole'),
        P(-s.w * 0.3, s.w * 0.3, 0.72, 0.76, -0.55, 0.05, 'marble', 'top'),
      ];
    case 'diningTable': {
      const r = hw - 0.35;
      const parts = [P(-0.05, 0.05, 0, s.h - 0.3, -0.05, 0.05, 'brass', 'pole'), P(-r, r, s.h - 0.3, s.h, -r, r, 'fabric', 'cloth')];
      // Four chairs round the table (decor.ts puts them at these angles): a seat block with a walnut back outside it.
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        const cx = Math.cos(a) * (r + 0.3);
        const cz = Math.sin(a) * (r + 0.3);
        parts.push(P(cx - 0.22, cx + 0.22, 0, 0.5, cz - 0.22, cz + 0.22, 'fabric', 'chair', 0.5));
        const bx = cx + Math.cos(a) * 0.2;
        const bz = cz + Math.sin(a) * 0.2;
        parts.push(P(bx - 0.12, bx + 0.12, 0.5, 0.99, bz - 0.12, bz + 0.12, 'walnut', 'back', 0.5));
      }
      return parts;
    }
    case 'luggageCart':
      return [
        P(-0.5, 0.5, 0, 0.25, -0.275, 0.275, 'walnut', 'deck', 0.5),
        P(-0.51, -0.45, 0.25, 1.75, -0.03, 0.03, 'brass', 'rail', 0.5),
        P(0.45, 0.51, 0.25, 1.75, -0.03, 0.03, 'brass', 'rail', 0.5),
        P(-0.51, 0.51, 1.75, 1.8, -0.03, 0.03, 'brass', 'rail', 0.55),
        P(-0.46, 0.16, 0.25, 0.7, -0.13, 0.09, 'leather', 'case'),
        P(-0.05, 0.45, 0.7, 0.98, -0.13, 0.09, 'leather', 'case'),
        P(-0.38, -0.05, 0.7, 1.03, -0.13, 0.09, 'leather', 'case'),
      ];
  }
}

export interface FurnitureCell {
  /** World-space bounds of the turned cell. */
  min: Vec3;
  max: Vec3;
  mat: Mat;
  name: FurniturePartName;
  /** Index of the part in furnitureParts(kind). */
  part: number;
}

/** The cells of a placed piece of furniture, in world space. */
export function furnitureCells(f: FurnitureDef): FurnitureCell[] {
  const c = Math.cos(f.yaw);
  const sn = Math.sin(f.yaw);
  const out: FurnitureCell[] = [];
  furnitureParts(f.kind).forEach((p, pi) => {
    const nx = Math.max(1, Math.ceil((p.max.x - p.min.x) / p.cell - 1e-6));
    const ny = Math.max(1, Math.ceil((p.max.y - p.min.y) / p.cell - 1e-6));
    const nz = Math.max(1, Math.ceil((p.max.z - p.min.z) / p.cell - 1e-6));
    const sx = (p.max.x - p.min.x) / nx;
    const sy = (p.max.y - p.min.y) / ny;
    const sz = (p.max.z - p.min.z) / nz;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++)
        for (let k = 0; k < nz; k++) {
          const x0 = p.min.x + i * sx;
          const z0 = p.min.z + k * sz;
          const y0 = p.min.y + j * sy;
          // Turn the cell's corners (three.js rotation.y: x' = x cos + z sin, z' = -x sin + z cos) and box them.
          let ax = Infinity;
          let bx = -Infinity;
          let az = Infinity;
          let bz = -Infinity;
          for (const [lx, lz] of [
            [x0, z0],
            [x0 + sx, z0],
            [x0, z0 + sz],
            [x0 + sx, z0 + sz],
          ]) {
            const wx = f.x + lx * c + lz * sn;
            const wz = f.z - lx * sn + lz * c;
            ax = Math.min(ax, wx);
            bx = Math.max(bx, wx);
            az = Math.min(az, wz);
            bz = Math.max(bz, wz);
          }
          // Round off float noise so cells that meet in the local frame still touch (neighbours) after turning.
          const r = (x: number) => Math.round(x * 1e4) / 1e4;
          out.push({ min: v(r(ax), r(y0), r(az)), max: v(r(bx), r(y0 + sy), r(bz)), mat: p.mat, name: p.name, part: pi });
        }
  });
  return out;
}
