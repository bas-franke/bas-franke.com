// Pod materials. One shared "surface" material paints every hull and metal part of every pod: colour, metalness and
// roughness come from vertex attributes, and a tiling canvas texture adds grime, scuffs, chipped paint, panel lines and
// rivets (with a matching bump map). Glow (binders, intake and nozzle rings) and exhaust plumes are small shaders with
// per-pod uniforms so each pod can pulse and flare on its own; they share compiled programs.

import * as THREE from 'three';

let shared: { surface: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial; textures: THREE.Texture[]; users: number } | null = null;

/** Deterministic random for the texture so every load looks the same. */
function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Grime/detail map (multiplied over the vertex colour) and its bump map, drawn together so they line up. */
function makeDetailTextures(): [THREE.Texture, THREE.Texture] {
  const S = 512;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    return [c, c.getContext('2d')!] as const;
  };
  const [cc, col] = mk();
  const [bc, bump] = mk();
  col.fillStyle = '#ffffff';
  col.fillRect(0, 0, S, S);
  bump.fillStyle = 'rgb(128,128,128)';
  bump.fillRect(0, 0, S, S);
  const r = rand(7);
  // Everything is drawn at the 9 wrapped offsets so the texture tiles.
  const wrap = (draw: (dx: number, dy: number) => void) => {
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) draw(dx, dy);
  };

  // Soft grime: dust and oil in big blotches, heavier towards the "bottom" of each tile row.
  for (let i = 0; i < 260; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = 8 + r() * 46;
    const a = 0.06 + r() * 0.14;
    const warm = r() < 0.7;
    wrap((dx, dy) => {
      const g = col.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
      g.addColorStop(0, warm ? `rgba(120,78,45,${a})` : `rgba(60,52,48,${a})`);
      g.addColorStop(1, 'rgba(120,78,45,0)');
      col.fillStyle = g;
      col.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
    });
  }
  // Dust streaks along the direction of travel (v).
  for (let i = 0; i < 120; i++) {
    const x = r() * S;
    const y = r() * S;
    const len = 20 + r() * 90;
    const a = 0.05 + r() * 0.1;
    wrap((dx, dy) => {
      col.strokeStyle = `rgba(110,72,40,${a})`;
      col.lineWidth = 1 + r() * 3;
      col.beginPath();
      col.moveTo(x + dx, y + dy);
      col.lineTo(x + dx + (r() - 0.5) * 4, y + dy + len);
      col.stroke();
    });
  }
  // Panel lines: rows every 128 px, staggered vertical seams, rivets along the seams.
  const rows = 4;
  for (let row = 0; row < rows; row++) {
    const y = row * (S / rows);
    wrap((dx, dy) => {
      col.fillStyle = 'rgba(35,26,22,0.6)';
      col.fillRect(dx, y + dy - 1, S, 2);
      bump.fillStyle = 'rgb(40,40,40)';
      bump.fillRect(dx, y + dy - 1.5, S, 3);
    });
    const seams = 2 + Math.floor(r() * 3);
    for (let k = 0; k < seams; k++) {
      const x = r() * S;
      wrap((dx, dy) => {
        col.fillStyle = 'rgba(35,26,22,0.55)';
        col.fillRect(x + dx - 1, y + dy, 2, S / rows);
        bump.fillStyle = 'rgb(40,40,40)';
        bump.fillRect(x + dx - 1.5, y + dy, 3, S / rows);
      });
      for (let ry = 8; ry < S / rows; ry += 14) {
        wrap((dx, dy) => {
          col.fillStyle = 'rgba(40,30,25,0.55)';
          col.beginPath();
          col.arc(x + dx + 6, y + dy + ry, 1.6, 0, Math.PI * 2);
          col.fill();
          bump.fillStyle = 'rgb(220,220,220)';
          bump.beginPath();
          bump.arc(x + dx + 6, y + dy + ry, 2, 0, Math.PI * 2);
          bump.fill();
        });
      }
    }
    for (let rx = 10; rx < S; rx += 16) {
      wrap((dx, dy) => {
        col.fillStyle = 'rgba(40,30,25,0.5)';
        col.beginPath();
        col.arc(rx + dx, y + dy + 6, 1.5, 0, Math.PI * 2);
        col.fill();
        bump.fillStyle = 'rgb(215,215,215)';
        bump.beginPath();
        bump.arc(rx + dx, y + dy + 6, 1.9, 0, Math.PI * 2);
        bump.fill();
      });
    }
  }
  // Chipped paint showing dark metal, mostly near the seams.
  for (let i = 0; i < 130; i++) {
    const x = r() * S;
    const y = Math.floor(r() * rows) * (S / rows) + (r() - 0.3) * 30;
    const pts: [number, number][] = [];
    const rad = 1.5 + r() * 5;
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const rr = rad * (0.5 + r() * 0.8);
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr * 0.7]);
    }
    wrap((dx, dy) => {
      for (const [ctx, style] of [
        [col, 'rgba(80,68,60,0.6)'],
        [bump, 'rgb(90,90,90)'],
      ] as const) {
        ctx.fillStyle = style;
        ctx.beginPath();
        pts.forEach(([px, py], k) => (k ? ctx.lineTo(x + dx + px, y + dy + py) : ctx.moveTo(x + dx + px, y + dy + py)));
        ctx.closePath();
        ctx.fill();
      }
    });
  }
  // Scratches.
  for (let i = 0; i < 110; i++) {
    const x = r() * S;
    const y = r() * S;
    const a = r() * Math.PI;
    const len = 6 + r() * 30;
    wrap((dx, dy) => {
      col.strokeStyle = `rgba(70,55,45,${0.15 + r() * 0.25})`;
      col.lineWidth = 0.8;
      col.beginPath();
      col.moveTo(x + dx, y + dy);
      col.lineTo(x + dx + Math.cos(a) * len, y + dy + Math.sin(a) * len);
      col.stroke();
      bump.strokeStyle = 'rgb(105,105,105)';
      bump.lineWidth = 0.8;
      bump.beginPath();
      bump.moveTo(x + dx, y + dy);
      bump.lineTo(x + dx + Math.cos(a) * len, y + dy + Math.sin(a) * len);
      bump.stroke();
    });
  }
  const map = new THREE.CanvasTexture(cc);
  map.colorSpace = THREE.SRGBColorSpace;
  const bmap = new THREE.CanvasTexture(bc);
  for (const t of [map, bmap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // Surface UVs are in metres: one tile per 2.6 m.
    t.repeat.set(1 / 2.6, 1 / 2.6);
    t.anisotropy = 4;
    t.generateMipmaps = true;
  }
  return [map, bmap];
}

/** Shared materials (ref-counted so the last pod disposed frees them). */
export function acquireShared() {
  if (!shared) {
    const [map, bumpMap] = makeDetailTextures();
    const surface = new THREE.MeshStandardMaterial({ vertexColors: true, map, bumpMap, bumpScale: 1.2, roughness: 1, metalness: 0 });
    surface.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aMat;\nvarying vec2 vMat;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vMat;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vMat.x;\nroughnessFactor = vMat.y;');
    };
    surface.customProgramCacheKey = () => 'pod-surface';
    const glass = new THREE.MeshStandardMaterial({
      color: '#1b2a33',
      metalness: 0.6,
      roughness: 0.06,
      transparent: true,
      opacity: 0.55,
      envMapIntensity: 1.6,
    });
    shared = { surface, glass, textures: [map, bumpMap], users: 0 };
  }
  shared.users++;
  return shared;
}

export function releaseShared() {
  if (!shared) return;
  if (--shared.users > 0) return;
  shared.surface.dispose();
  shared.glass.dispose();
  for (const t of shared.textures) t.dispose();
  shared = null;
}

const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/**
 * Self-lit parts. aKind: 0 flat (tail light, visor), 1 energy binder (hot core, shimmer running along it),
 * 2 nozzle core disk (white-hot centre), 3 intake ring (pulses), 4 nozzle rim ring (brightest).
 */
export function createGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uPulse: { value: 0.5 }, uPower: { value: 1 }, uBoost: { value: 0 } }]),
    vertexColors: true,
    fog: true,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute float aKind;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vKind;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vUv = uv;
        vCol = color;
        vKind = aKind;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uPulse;
      uniform float uPower;
      uniform float uBoost;
      #include <common>
      #include <fog_pars_fragment>
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vKind;
      varying vec3 vN;
      varying vec3 vV;
      ${NOISE}
      void main() {
        vec3 c = vCol;
        vec3 col;
        if (vKind < 0.5) {
          col = c * (1.4 + 0.4 * uPower);
        } else if (vKind < 1.5) {
          float f = abs(dot(normalize(vN), normalize(vV)));
          float run = vnoise(vec2(vUv.y * 9.0 - uTime * 14.0, vUv.x * 2.0));
          float s = 0.55 + 0.45 * sin(vUv.y * 46.0 - uTime * 31.0) * (0.5 + 0.5 * run);
          col = c * (1.3 + 1.2 * s) + vec3(0.8, 1.0, 1.0) * pow(f, 3.0) * (1.4 + 0.8 * s);
        } else if (vKind < 2.5) {
          float d = length(vUv - 0.5) * 2.0;
          float swirl = vnoise(vec2(atan(vUv.y - 0.5, vUv.x - 0.5) * 3.0 + uTime * 6.0, d * 4.0 - uTime * 3.0));
          vec3 hot = c * 1.35 + vec3(0.3) * (1.0 + 1.5 * uBoost);
          col = mix(hot, c * 0.55, smoothstep(0.0, 0.95, d + swirl * 0.3));
          col *= 0.6 + 0.4 * uPower;
        } else if (vKind < 3.5) {
          col = c * (1.2 + 1.6 * uPulse);
        } else {
          col = (c * 1.7 + vec3(0.1 + 0.6 * uBoost)) * (0.7 + 0.35 * uPower);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

/**
 * Exhaust plumes and nozzle halos, additive. aKind: 0 outer plume, 1 hot inner core, 2 halo billboard (camera-facing,
 * uv = corner). aEngine picks which engine's length/power uniform applies. Plume vertices hold their t (0 at the
 * nozzle, 1 at the tail) in uv.y and are stretched backwards by the length uniform.
 */
export function createPlumeMaterial(core: THREE.Color, mid: THREE.Color, tail: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uLen: { value: new THREE.Vector2(4, 4) },
        uPower: { value: new THREE.Vector2(1, 1) },
        uHalo: { value: 3 },
        uBoost: { value: 0 },
        uCore: { value: core },
        uMid: { value: mid },
        uTail: { value: tail },
      },
    ]),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute float aKind;
      attribute float aEngine;
      uniform float uTime;
      uniform vec2 uLen;
      uniform vec2 uPower;
      uniform float uHalo;
      varying vec2 vUv;
      varying float vKind;
      varying float vPower;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vUv = uv;
        vKind = aKind;
        float len = aEngine < 0.5 ? uLen.x : uLen.y;
        vPower = aEngine < 0.5 ? uPower.x : uPower.y;
        vec4 mvPosition;
        if (aKind > 1.5) {
          mvPosition = modelViewMatrix * vec4(position, 1.0);
          mvPosition.xy += (uv - 0.5) * uHalo * (0.75 + 0.25 * vPower);
          vN = vec3(0.0, 0.0, 1.0);
        } else {
          vec3 p = position;
          float t = uv.y;
          // Stretch back from the nozzle (stored in position at t = 0) and widen a little with throttle.
          p.z += t * len;
          p.x += sin(uTime * 23.0 + t * 7.0 + aEngine * 3.0) * 0.06 * t;
          p.y += sin(uTime * 19.0 + t * 5.0) * 0.06 * t;
          mvPosition = modelViewMatrix * vec4(p, 1.0);
          vN = normalize(normalMatrix * normal);
        }
        vV = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBoost;
      uniform vec3 uCore;
      uniform vec3 uMid;
      uniform vec3 uTail;
      #include <common>
      #include <fog_pars_fragment>
      varying vec2 vUv;
      varying float vKind;
      varying float vPower;
      varying vec3 vN;
      varying vec3 vV;
      ${NOISE}
      void main() {
        vec3 col;
        float a;
        if (vKind > 1.5) {
          float d = length(vUv - 0.5) * 2.0;
          a = exp(-d * d * 6.0) * (1.0 - smoothstep(0.6, 1.0, d));
          col = mix(uCore, uMid, 0.7) * (0.3 + 0.25 * vPower);
        } else {
          float t = vUv.y;
          float f = abs(dot(normalize(vN), normalize(vV)));
          float streak = vnoise(vec2(vUv.x * 9.0, t * 5.0 - uTime * 11.0));
          float flick = 0.88 + 0.12 * sin(uTime * 53.0 + vUv.x * 2.0);
          if (vKind < 0.5) {
            a = pow(1.0 - t, 1.4) * smoothstep(0.0, 0.06, t) * (0.45 + 0.55 * streak) * (0.35 + 0.65 * f);
            col = mix(uMid, uTail, smoothstep(0.0, 0.7, t)) * 0.65;
          } else {
            a = pow(1.0 - t, 2.4) * (0.5 + 0.5 * streak) * (0.3 + 0.7 * f) * 0.8;
            col = mix(mix(uCore, uMid, 0.35), uMid, smoothstep(0.0, 0.5, t)) * (1.0 + 0.6 * uBoost);
          }
          a *= flick * vPower;
        }
        #ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          #else
            float fogF = smoothstep(fogNear, fogFar, vFogDepth);
          #endif
          a *= 1.0 - fogF;
        #endif
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
