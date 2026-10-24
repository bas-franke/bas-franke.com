// The comic-book look for Ruckus: a bright theme per minigame, Blender models converted to toon materials with one
// merged ink hull, hand-drawn floor textures, and a banded sky with inked clouds floating below the arena.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MinigameId } from '@shared/ruckus/world';
import { INK, flat, hullGeometry, inkMaterial, toon, toonRamp } from '../../engine/toon';

/** Ink for Ruckus: thinner than Rockets' because the camera hangs 20 m above small pawns. */
export const rkInk = () => inkMaterial(0.0045, 0.02);

export interface Theme {
  /** Sky colours: overhead, horizon and the depths below the arena. */
  zenith: number;
  horizon: number;
  deep: number;
  /** Two floor tones, the platform side and the accent for rims, walls and bars. */
  floorA: number;
  floorB: number;
  side: number;
  accent: number;
}

export const THEMES: Record<MinigameId, Theme> = {
  hotpotato: { zenith: 0xff9a3c, horizon: 0xffd37a, deep: 0xff6f59, floorA: 0xffd66b, floorB: 0xffa94d, side: 0xe8573a, accent: 0xff4b2e },
  lava: { zenith: 0x3a1030, horizon: 0xff6a2a, deep: 0x5a0f14, floorA: 0x9fdcff, floorB: 0x6fc0f2, side: 0x4a6d8c, accent: 0xff4b2e },
  coins: { zenith: 0x3fa9ff, horizon: 0xbdeeff, deep: 0x6cc8ff, floorA: 0x9be15d, floorB: 0x78c94a, side: 0x8a5a34, accent: 0xffc928 },
  sweeper: { zenith: 0x6b5cff, horizon: 0xc6b8ff, deep: 0x8f7bff, floorA: 0xc9dcff, floorB: 0x8fb0ff, side: 0x3b5bdb, accent: 0xff3d6e },
  sumo: { zenith: 0xff5fa8, horizon: 0xffd0e6, deep: 0xff8fc8, floorA: 0xffd6e6, floorB: 0xff9ec4, side: 0xc2185b, accent: 0xff2e88 },
};

/** Brighter, flatter stand-ins for the Blender palette, by material name. */
const RECOLOR: Record<string, number> = {
  White: 0xffffff,
  Eye: 0xffffff,
  Pupil: INK,
  Dark: 0x3b3552,
  Steel: 0x9aa6bd,
  Bomb: 0x2b2738,
  Fuse: 0xd2a865,
  Gold: 0xffc928,
  Ruby: 0xff2e63,
};
const GLOWING = new Set(['Spark']);

/**
 * A toon copy of a Blender model: "Team" keeps its own (cloneable) material so `instantiate` can tint it, glowing
 * parts become unlit, the rest share cached toon materials, and every mesh contributes to one merged ink hull.
 */
export function toonModel(template: THREE.Group | null): THREE.Group | null {
  if (!template) return null;
  const root = template.clone(true);
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const hulls: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const convert = (mat: THREE.Material) => {
      const std = mat as THREE.MeshStandardMaterial;
      if (mat.name === 'Team') return new THREE.MeshToonMaterial({ name: 'Team', color: std.color, gradientMap: toonRamp() });
      const hex = RECOLOR[mat.name] ?? std.color?.getHex() ?? 0xffffff;
      return GLOWING.has(mat.name) ? flat(hex) : toon(hex);
    };
    m.material = Array.isArray(m.material) ? m.material.map(convert) : convert(m.material);
    m.castShadow = true;
    local.multiplyMatrices(toRoot, m.matrixWorld);
    hulls.push(hullGeometry(m.geometry).applyMatrix4(local));
  });
  const merged = hulls.length ? mergeGeometries(hulls, false) : null;
  for (const g of hulls) g.dispose();
  if (merged) root.add(new THREE.Mesh(merged, rkInk()));
  return root;
}

/** A toon primitive with its own ink hull, for placeholders and props. */
export function inked(geo: THREE.BufferGeometry, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, toon(color));
  mesh.castShadow = true;
  mesh.add(new THREE.Mesh(hullGeometry(geo), rkInk()));
  return mesh;
}

/** A name tag in the comic style: the player's colour in an inked speech-box, always drawn on top. */
export function comicLabel(text: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '800 52px "Space Grotesk", system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 56;
  const h = 84;
  canvas.width = w;
  canvas.height = h + 14;
  ctx.font = font;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 7;
  ctx.strokeStyle = inkCss;
  ctx.fillStyle = css(color);
  // Box with a little tail pointing down at the pawn.
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 8, 18);
  ctx.moveTo(w / 2 - 12, h - 5);
  ctx.lineTo(w / 2, h + 9);
  ctx.lineTo(w / 2 + 12, h - 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillRect(w / 2 - 10, h - 12, 20, 8);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = inkCss;
  ctx.fillText(text, w / 2, h / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, toneMapped: false }));
  sprite.renderOrder = 10;
  sprite.scale.set((0.62 * canvas.width) / canvas.height, 0.62, 1);
  return sprite;
}

const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;
const inkCss = css(INK);

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Top of the round platform: concentric bands with inked edges, a hazard ring at the rim and a bullseye. */
export function discTexture(t: Theme): THREE.CanvasTexture {
  return canvasTexture(1024, (ctx, s) => {
    const c = s / 2;
    const R = s / 2;
    const ring = (r: number, fill: string, line = 6) => {
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = line;
      ctx.strokeStyle = inkCss;
      ctx.stroke();
    };
    // Hazard ring: accent and white wedges.
    ctx.fillStyle = css(t.accent);
    ctx.fillRect(0, 0, s, s);
    const wedges = 48;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < wedges; i += 2) {
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, R, (i / wedges) * Math.PI * 2, ((i + 1) / wedges) * Math.PI * 2);
      ctx.fill();
    }
    ring(R * 0.9, css(t.floorA), 8);
    ring(R * 0.66, css(t.floorB));
    ring(R * 0.62, css(t.floorA), 4);
    ring(R * 0.36, css(t.floorB));
    ring(R * 0.12, css(t.accent));
    // A few hand-drawn scuffs so the floor reads as a surface, not a flat fill.
    ctx.strokeStyle = 'rgba(22,18,28,0.25)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    for (let i = 0; i < 26; i++) {
      const a = i * 2.39996;
      const r = R * (0.2 + ((i * 37) % 60) / 100);
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a + 1.3) * 18, y + Math.sin(a + 1.3) * 18);
      ctx.stroke();
    }
  });
}

/** Top of the walled square: a checkerboard of inked tiles. */
export function checkerTexture(t: Theme, cells = 8): THREE.CanvasTexture {
  return canvasTexture(1024, (ctx, s) => {
    const w = s / cells;
    for (let y = 0; y < cells; y++)
      for (let x = 0; x < cells; x++) {
        ctx.fillStyle = css((x + y) % 2 ? t.floorB : t.floorA);
        ctx.fillRect(x * w, y * w, w, w);
        // Highlight streak in the corner, comic-style.
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillRect(x * w + w * 0.12, y * w + w * 0.12, w * 0.22, w * 0.06);
      }
    ctx.strokeStyle = inkCss;
    ctx.lineWidth = 6;
    for (let i = 0; i <= cells; i++) {
      ctx.beginPath();
      ctx.moveTo(i * w, 0);
      ctx.lineTo(i * w, s);
      ctx.moveTo(0, i * w);
      ctx.lineTo(s, i * w);
      ctx.stroke();
    }
  });
}

/** One floor tile for the lava grid, tinted by the material colour: inked border and a highlight. */
export function tileTexture(): THREE.CanvasTexture {
  return canvasTexture(128, (ctx, s) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(22,18,28,0.18)';
    ctx.fillRect(0, s * 0.78, s, s * 0.22);
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.fillRect(s * 0.14, s * 0.14, s * 0.3, s * 0.07);
    ctx.strokeStyle = inkCss;
    ctx.lineWidth = 8;
    ctx.strokeRect(0, 0, s, s);
  });
}

/** Molten lava: posterised flowing bands with dark crust, unlit and fog-free. Drive `uniforms.time`. */
export function lavaMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: false,
    uniforms: { time: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vP;
      uniform float time;
      void main() {
        vec2 p = vP * 0.22;
        float n = sin(p.x * 1.7 + time * 0.6) + sin(p.y * 2.1 - time * 0.45) + sin((p.x + p.y) * 1.3 + time * 0.8)
          + 0.6 * sin(length(p) * 2.6 - time * 1.2);
        float t = floor((n * 0.25 + 0.5) * 4.0) / 4.0;
        vec3 crust = vec3(0.6, 0.07, 0.1);
        vec3 red = vec3(0.95, 0.18, 0.06);
        vec3 orange = vec3(1.0, 0.5, 0.08);
        vec3 yellow = vec3(1.0, 0.85, 0.3);
        vec3 col = t < 0.25 ? crust : t < 0.5 ? red : t < 0.75 ? orange : yellow;
        // Ink line at the crust edge.
        float edge = abs(n * 0.25 + 0.5 - 0.25);
        if (edge < 0.025) col = vec3(0.008, 0.006, 0.012);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

/** Banded sky dome with screen-space halftone dots in its lower half, plus a ring of inked clouds below the arena. */
export function buildBackdrop(t: Theme, clouds: boolean): { group: THREE.Group; clouds: THREE.Group | null; dispose(): void } {
  const group = new THREE.Group();
  const own: { dispose(): void }[] = [];
  const radius = 160;
  const domeGeo = new THREE.SphereGeometry(radius, 24, 16);
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: new THREE.Color(t.zenith) },
      horizon: { value: new THREE.Color(t.horizon) },
      deep: { value: new THREE.Color(t.deep) },
      radius: { value: radius },
    },
    vertexShader: /* glsl */ `
      varying float vH;
      uniform float radius;
      void main() {
        vH = position.y / radius;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vH;
      uniform vec3 zenith;
      uniform vec3 horizon;
      uniform vec3 deep;
      void main() {
        vec3 col;
        float dots = 0.0;
        if (vH >= 0.0) col = mix(horizon, zenith, floor(smoothstep(0.0, 0.6, vH) * 5.0) / 5.0);
        else {
          float t = floor(smoothstep(0.0, -0.8, vH) * 5.0) / 5.0;
          col = mix(horizon, deep, t);
          dots = t;
        }
        // Halftone: dot size grows with depth, like a printed shadow.
        vec2 g = mod(gl_FragCoord.xy, 12.0) - 6.0;
        if (length(g) < dots * 3.6) col *= 0.86;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);
  own.push(domeGeo, domeMat);

  let cloudGroup: THREE.Group | null = null;
  if (clouds) {
    cloudGroup = new THREE.Group();
    const cloudMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp(), fog: false, toneMapped: false });
    const cloudInk = inkMaterial(0.0016, 0.08, false);
    const puffs: THREE.BufferGeometry[] = [];
    const hulls: THREE.BufferGeometry[] = [];
    let seed = 1234567;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let c = 0; c < 18; c++) {
      const a = (c / 18) * Math.PI * 2 + rand() * 0.4;
      const dist = 26 + rand() * 50;
      const cx = Math.cos(a) * dist;
      const cz = Math.sin(a) * dist;
      const cy = -14 - rand() * 22;
      const blobs = 3 + Math.floor(rand() * 3);
      for (let i = 0; i < blobs; i++) {
        const r = 3 + rand() * 3;
        const geo = new THREE.IcosahedronGeometry(r, 1);
        geo.scale(1, 0.6, 1);
        geo.translate(cx + (i - blobs / 2) * r * 0.9, cy + rand() * 2, cz + (rand() - 0.5) * 4);
        hulls.push(hullGeometry(geo));
        puffs.push(geo);
      }
    }
    const cloudGeo = mergeGeometries(puffs, false);
    const cloudHull = mergeGeometries(hulls, false);
    for (const g of [...puffs, ...hulls]) g.dispose();
    if (cloudGeo && cloudHull) {
      cloudGroup.add(new THREE.Mesh(cloudGeo, cloudMat), new THREE.Mesh(cloudHull, cloudInk));
      own.push(cloudGeo, cloudHull, cloudMat);
    }
    group.add(cloudGroup);
  }
  return {
    group,
    clouds: cloudGroup,
    dispose: () => {
      for (const d of own) d.dispose();
    },
  };
}
