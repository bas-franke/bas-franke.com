// Lettered neon signs for the neon maps: "NEXUS / INDUSTRIES" over every billboard face, and a tall vertical
// katakana sign on the inner face of each tall chimney. All letters share one canvas texture (an atlas of the two
// signs), so the lot draws in a single unlit, additive call that the bloom picks up.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MapData } from '@shared/rockets/map';

type Disposable = { dispose(): void };

/** Atlas: the billboard lettering on the left 2/3, the vertical katakana on the right 1/3. */
function signAtlas(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1536;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.shadowColor = '#fff';
  g.shadowBlur = 18;
  // A slanted logo mark, then the word and the subtitle.
  g.save();
  g.translate(512, 170);
  g.transform(1, 0, -0.35, 1, 0, 0);
  g.fillRect(-150, -70, 70, 140);
  g.fillRect(-60, -70, 70, 140);
  g.restore();
  g.font = 'italic 900 150px "Arial Black", Impact, sans-serif';
  g.fillText('NEXUS', 560, 300);
  g.font = '700 54px Arial, sans-serif';
  g.fillText('I N D U S T R I E S', 512, 410);
  // Vertical katakana, one character per row.
  g.font = '900 104px "Yu Gothic", "Meiryo", "Hiragino Sans", "Noto Sans JP", sans-serif';
  ['ネ', 'ク', 'サ', 'ス'].forEach((ch, i) => g.fillText(ch, 1280, 70 + i * 124));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A plane facing +Z after `yaw`, showing the atlas region u0..u1 (full height). */
function plane(w: number, h: number, u0: number, u1: number, x: number, y: number, z: number, yaw: number) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * (u1 - u0));
  g.rotateY(yaw);
  g.translate(x, y, z);
  return g;
}

export function buildSigns(map: MapData, billboards: { x: number; y: number; z: number; yaw: number }[], disposables: Disposable[]): THREE.Object3D | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const s of billboards) parts.push(plane(6.2, 2.4, 0, 2 / 3, s.x, s.y, s.z, s.yaw));
  // Tall chimneys: a vertical sign on the face toward the middle of the map, high up.
  for (const b of map.boxes) {
    if (b.kind === 'clip' || b.kind === 'wall' || b.max.y - b.min.y < 12) continue;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    if (Math.hypot(cx, cz) < 10) continue;
    const alongX = Math.abs(cx) > Math.abs(cz);
    const side = alongX ? (cx > 0 ? b.min.x : b.max.x) : cz > 0 ? b.min.z : b.max.z;
    const out = alongX ? -Math.sign(cx) : -Math.sign(cz);
    const width = alongX ? b.max.z - b.min.z : b.max.x - b.min.x;
    if (width < 2) continue;
    const yaw = alongX ? (out > 0 ? Math.PI / 2 : -Math.PI / 2) : out > 0 ? 0 : Math.PI;
    const h = Math.min(6, (b.max.y - b.min.y) * 0.45);
    const y = b.max.y - 1 - h / 2;
    const x = alongX ? side + out * 0.06 : cx;
    const z = alongX ? cz : side + out * 0.06;
    // The katakana column is 170 px of the atlas wide (centred on x = 1280) and the full 512 px tall.
    parts.push(plane(h / 3, h, 1195 / 1536, 1365 / 1536, x, y, z, yaw));
  }
  if (!parts.length) return null;
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  const tex = signAtlas();
  // White letters, pushed past 1 so the bloom wraps them in a halo.
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.6, 1.5, 1.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  disposables.push(geo, mat, tex);
  return mesh;
}

/** "01".."04" in four cells of one canvas, white on clear, in a heavy stencil face. */
function numberAtlas(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.font = '900 200px "Arial Black", Impact, sans-serif';
  for (let i = 0; i < 4; i++) g.fillText(`0${i + 1}`, 128 + i * 256, 138);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Big block numbers painted on the sides of the neon maps' blocks: darker than the paint, lit like it. */
export function buildNumbers(spots: { x: number; y: number; z: number; yaw: number; size: number; n: number }[], gradientMap: THREE.Texture, disposables: Disposable[]): THREE.Object3D | null {
  if (!spots.length) return null;
  const parts = spots.map((s) => plane(s.size, s.size, (s.n - 1) / 4, s.n / 4, s.x, s.y, s.z, s.yaw));
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  const tex = numberAtlas();
  const mat = new THREE.MeshToonMaterial({ map: tex, color: 0x8a1a5c, gradientMap, transparent: true, alphaTest: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  disposables.push(geo, mat, tex);
  return mesh;
}
