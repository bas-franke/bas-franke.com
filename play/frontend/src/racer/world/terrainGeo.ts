// Geometry accumulator for the terrain: grids of vertices (rows x columns) with normals from their neighbours, plus the
// two per-vertex attributes the terrain shader reads (aRock: 1 rock, 0 sand; aShade: baked occlusion). Pieces added to
// one builder end up in one merged BufferGeometry, i.e. one draw call per chunk.

import * as THREE from 'three';

export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  rock: number[] = [];
  shade: number[] = [];
  idx: number[] = [];

  get vertexCount() {
    return this.pos.length / 3;
  }

  /**
   * Adds a grid: `p` holds cols * rows xyz triples, column-major (p[(i * rows + j) * 3]). Normals are
   * cross(d/dcol, d/drow) * flip, falling back to `fallback` where the grid is degenerate, unless `normals` (same
   * layout as `p`) are given.
   */
  addGrid(p: Float32Array | number[], cols: number, rows: number, flip: 1 | -1, rock: number | ArrayLike<number>, shade: number | ArrayLike<number>, fallback?: THREE.Vector3, normals?: ArrayLike<number>) {
    const base = this.vertexCount;
    const at = (i: number, j: number) => (i * rows + j) * 3;
    for (let i = 0; i < cols; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(cols - 1, i + 1);
      for (let j = 0; j < rows; j++) {
        const j0 = Math.max(0, j - 1);
        const j1 = Math.min(rows - 1, j + 1);
        const a = at(i0, j);
        const b = at(i1, j);
        const c = at(i, j0);
        const d = at(i, j1);
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[d] - p[c], vy = p[d + 1] - p[c + 1], vz = p[d + 2] - p[c + 2];
        const k = at(i, j);
        if (normals) {
          this.pos.push(p[k], p[k + 1], p[k + 2]);
          this.nrm.push(normals[k], normals[k + 1], normals[k + 2]);
          const q = i * rows + j;
          this.rock.push(typeof rock === 'number' ? rock : rock[q]);
          this.shade.push(typeof shade === 'number' ? shade : shade[q]);
          continue;
        }
        let nx = (uy * vz - uz * vy) * flip;
        let ny = (uz * vx - ux * vz) * flip;
        let nz = (ux * vy - uy * vx) * flip;
        const l = Math.hypot(nx, ny, nz);
        if (l < 1e-6) {
          nx = fallback?.x ?? 0;
          ny = fallback?.y ?? 1;
          nz = fallback?.z ?? 0;
        } else {
          nx /= l;
          ny /= l;
          nz /= l;
        }
        this.pos.push(p[k], p[k + 1], p[k + 2]);
        this.nrm.push(nx, ny, nz);
        const q = i * rows + j;
        this.rock.push(typeof rock === 'number' ? rock : rock[q]);
        this.shade.push(typeof shade === 'number' ? shade : shade[q]);
      }
    }
    for (let i = 0; i < cols - 1; i++) {
      for (let j = 0; j < rows - 1; j++) {
        const v00 = base + i * rows + j;
        const v10 = v00 + rows;
        const v01 = v00 + 1;
        const v11 = v10 + 1;
        if (flip > 0) this.idx.push(v00, v10, v11, v00, v11, v01);
        else this.idx.push(v00, v11, v10, v00, v01, v11);
      }
    }
  }

  toGeometry(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aRock', new THREE.Float32BufferAttribute(this.rock, 1));
    g.setAttribute('aShade', new THREE.Float32BufferAttribute(this.shade, 1));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
