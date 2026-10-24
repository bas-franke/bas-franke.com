// Shared plumbing for the speed effects: instanced quad geometry, a ring-buffer allocator that uploads only the
// instances written this frame, GLSL snippets for fog (normal and additive) and the procedural dust-puff atlas.

import * as THREE from 'three';
import type { Quality } from '../world/types';

/** Scales particle budgets and emission rates per quality level. */
export function qualityScale(q: Quality): number {
  return q === 'high' ? 1 : q === 'medium' ? 0.6 : 0.28;
}

/** Instanced unit quad (corners at ±1 in xy). Every instance attribute starts zeroed (= dead particles). */
export function quadGeometry(count: number, attrs: Record<string, number>): {
  geo: THREE.InstancedBufferGeometry;
  attr: Record<string, THREE.InstancedBufferAttribute>;
} {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const attr: Record<string, THREE.InstancedBufferAttribute> = {};
  for (const [name, size] of Object.entries(attrs)) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    attr[name] = a;
  }
  geo.instanceCount = count;
  return { geo, attr };
}

/** Hands out instance slots round-robin and uploads only the dirty span on flush. */
export class InstanceRing {
  private head = 0;
  private lo = Infinity;
  private hi = -1;
  private readonly list: THREE.InstancedBufferAttribute[];

  constructor(readonly count: number, attrs: Record<string, THREE.InstancedBufferAttribute>) {
    this.list = Object.values(attrs);
  }

  next(): number {
    const i = this.head;
    this.head = (i + 1) % this.count;
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;
    return i;
  }

  flush() {
    if (this.hi < 0) return;
    for (const a of this.list) {
      a.clearUpdateRanges();
      a.addUpdateRange(this.lo * a.itemSize, (this.hi - this.lo + 1) * a.itemSize);
      a.needsUpdate = true;
    }
    this.lo = Infinity;
    this.hi = -1;
  }
}

/** Fog factor for additive materials: they fade to nothing in the haze instead of to the haze colour. */
export const ADDITIVE_FOG = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float fogF = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor.a *= 1.0 - fogF;
#endif
`;

export function fxMaterial(opts: {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, THREE.IUniform>;
  additive?: boolean;
  side?: THREE.Side;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: opts.vertexShader,
    fragmentShader: opts.fragmentShader,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, opts.uniforms]),
    transparent: true,
    depthWrite: false,
    fog: true,
    side: opts.side ?? THREE.FrontSide,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

export function linear(hex: string): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

/**
 * 2x2 atlas of cauliflower dust puffs, 128 px cells. R = density, G/B = density gradient (0.5 = flat) so the shader can
 * light the lumps of each puff from the sun, which is what makes the clouds read as painted volumes, not blobs.
 */
export function puffAtlas(): THREE.DataTexture {
  const C = 128;
  const W = C * 2;
  const data = new Uint8Array(W * W * 4);
  const dens = new Float32Array(C * C);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let cell = 0; cell < 4; cell++) {
    const blobs: [number, number, number, number][] = [];
    const n = 9 + cell * 2;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * 0.24;
      blobs.push([Math.cos(a) * r, Math.sin(a) * r * 0.85 + 0.02, 0.09 + rnd() * 0.13, 0.6 + rnd() * 0.5]);
    }
    blobs.push([0, 0, 0.26, 0.8]);
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const u = (x + 0.5) / C - 0.5;
        const v = (y + 0.5) / C - 0.5;
        let d = 0;
        for (const [bx, by, br, bw] of blobs) {
          const q = ((u - bx) ** 2 + (v - by) ** 2) / (br * br);
          d += bw * Math.exp(-q * 2.2);
        }
        // Wispy edge noise, then a hard window so nothing reaches the cell border.
        const w = Math.max(0, 1 - Math.hypot(u, v) / 0.5);
        const noise = 0.75 + 0.25 * Math.sin(u * 37 + cell * 3) * Math.sin(v * 41 - cell);
        dens[y * C + x] = Math.min(1, d * 0.75 * noise) * Math.min(1, w * 2.5);
      }
    }
    const ox = (cell % 2) * C;
    const oy = Math.floor(cell / 2) * C;
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const d = dens[y * C + x];
        const gx = dens[y * C + Math.min(C - 1, x + 1)] - dens[y * C + Math.max(0, x - 1)];
        const gy = dens[Math.min(C - 1, y + 1) * C + x] - dens[Math.max(0, y - 1) * C + x];
        const i = ((oy + y) * W + ox + x) * 4;
        data[i] = Math.round(d * 255);
        data[i + 1] = Math.round(THREE.MathUtils.clamp(0.5 + gx * 6, 0, 1) * 255);
        data[i + 2] = Math.round(THREE.MathUtils.clamp(0.5 + gy * 6, 0, 1) * 255);
        data[i + 3] = 255;
      }
    }
  }
  const tex = new THREE.DataTexture(data, W, W, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
