// The city around the Grand Meridian: towers across the plaza and along both side streets. Every mesh is outside the
// hotel's shadow box (`userData.noMoonShadow`), so it costs one draw per material and nothing in the shadow passes.

import * as THREE from 'three';
import type { Quality } from './api';

export interface SkylineOpts {
  /** z of the glass facade (the hotel's north face); the plaza and the city lie at z < facadeZ. */
  facadeZ: number;
  /** Extent of the hotel's walls. */
  ext: { minX: number; maxX: number; minZ: number; maxZ: number };
  quality: Quality;
}

export interface Skyline {
  group: THREE.Group;
  update(dt: number, time: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Painted city blocks for the backdrop: rows of windows, some lit. */
function facadeTexture(seed: number, warm: boolean): THREE.CanvasTexture {
  const r = seeded(seed);
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  const base = warm ? [196, 168, 132] : [120, 132, 140];
  g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  g.fillRect(0, 0, 256, 512);
  const cols = 6 + Math.floor(r() * 4);
  const rows = 22 + Math.floor(r() * 10);
  const cw = 256 / cols;
  const rh = 512 / rows;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const k = r();
      const glint = k > 0.93;
      g.fillStyle = glint ? 'rgb(255,236,190)' : k > 0.5 ? 'rgb(58,66,78)' : 'rgb(82,92,104)';
      g.fillRect(x * cw + cw * 0.18, y * rh + rh * 0.2, cw * 0.64, rh * 0.6);
    }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

export function buildSkyline(o: SkylineOpts): Skyline {
  const group = new THREE.Group();
  group.name = 'skyline';
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(d: T) => (disposables.push(d), d);
  const { facadeZ, ext } = o;

  const cityMats = [0, 1, 2, 3].map((k) => {
    const t = keep(facadeTexture(101 + k * 17, k % 2 === 0));
    return keep(new THREE.MeshStandardMaterial({ map: t, roughness: 0.55, metalness: 0.2, envMapIntensity: 0.6 }));
  });
  const cr = seeded(4242);
  // Two rows of towers: one beyond the facade and some to the sides.
  const blocks: { x: number; z: number; w: number; d: number; h: number }[] = [];
  for (let x = -70; x < 70; x += 14 + cr() * 8) blocks.push({ x, z: facadeZ - 38 - cr() * 20, w: 10 + cr() * 8, d: 10 + cr() * 8, h: 25 + cr() * 60 });
  for (let z = facadeZ - 20; z < ext.maxZ + 40; z += 18 + cr() * 10) {
    blocks.push({ x: ext.minX - 34 - cr() * 15, z, w: 12, d: 14, h: 18 + cr() * 40 });
    blocks.push({ x: ext.maxX + 34 + cr() * 15, z, w: 12, d: 14, h: 18 + cr() * 40 });
  }
  for (const b of blocks) {
    const g = keep(new THREE.BoxGeometry(b.w, b.h, b.d));
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let j = 0; j < uv.count; j++) uv.setXY(j, uv.getX(j) * (b.w / 16), uv.getY(j) * (b.h / 30));
    const m = new THREE.Mesh(g, cityMats[Math.floor(cr() * cityMats.length)]);
    m.position.set(b.x, b.h / 2 - 0.02, b.z);
    m.castShadow = false;
    m.receiveShadow = true;
    m.userData.noMoonShadow = true;
    group.add(m);
  }

  return {
    group,
    update() {},
    setQuality() {},
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
