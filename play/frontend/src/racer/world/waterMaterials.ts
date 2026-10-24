// Shaders for the water module: painterly waterfall sheets with streaks scrolling down, a turquoise river with flowing
// foam and rapids, and soft billboard mist puffs that rise and fade. All of them sample one small tileable noise
// texture (cheaper than shader noise), share one time uniform and include three's fog chunks for aerial perspective.

import * as THREE from 'three';
import type { Theme } from '../core/tracks';

/** 256x256 tileable fbm value noise, three independent octave stacks in R, G and B. */
export function makeNoiseTexture(): THREE.DataTexture {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const channel = (seed: number) => {
    let a = seed;
    const rand = () => {
      a = (a * 1664525 + 1013904223) >>> 0;
      return a / 4294967296;
    };
    const out = new Float32Array(N * N);
    let amp = 1;
    for (let g = 4; g <= 64; g *= 2) {
      const lattice = Array.from({ length: g * g }, rand);
      const at = (x: number, y: number) => lattice[(y % g) * g + (x % g)];
      for (let y = 0; y < N; y++) {
        const fy = (y / N) * g;
        const y0 = Math.floor(fy);
        const ty = fy - y0;
        const sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < N; x++) {
          const fx = (x / N) * g;
          const x0 = Math.floor(fx);
          const tx = fx - x0;
          const sx = tx * tx * (3 - 2 * tx);
          const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
          const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
          out[y * N + x] += (top + (bot - top) * sy) * amp;
        }
      }
      amp *= 0.55;
    }
    // Stretch the histogram so the full 0..1 range is used.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of out) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return out.map((v) => (v - lo) / (hi - lo));
  };
  const r = channel(11);
  const g = channel(29);
  const b = channel(47);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = r[i] * 255;
    data[i * 4 + 1] = g[i] * 255;
    data[i * 4 + 2] = b[i] * 255;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export interface WaterShared {
  time: { value: number };
  noise: { value: THREE.Texture };
  sunDir: { value: THREE.Vector3 };
}

export function sunDirection(theme: Theme) {
  return new THREE.Vector3(Math.sin(theme.sunAzimuth), Math.tan(theme.sunElevation), Math.cos(theme.sunAzimuth)).normalize();
}

const col = (hex: string) => ({ value: new THREE.Color(hex) });

function shaderMaterial(shared: WaterShared, uniforms: Record<string, THREE.IUniform>, vertexShader: string, fragmentShader: string) {
  const m = new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...uniforms },
    vertexShader,
    fragmentShader,
    fog: true,
    transparent: true,
    depthWrite: false,
  });
  m.uniforms.uTime = shared.time;
  m.uniforms.uNoise = shared.noise;
  m.uniforms.uSunDir = shared.sunDir;
  return m;
}

const OUTPUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
`;

// --- Waterfall sheets ------------------------------------------------------------------------------------------------
// uv = (across, along the flow) in metres; aInfo = (across 0..1, drop fraction 0..1, metres past the lip: < 0 on the
// ledge behind it).

export function fallMaterial(shared: WaterShared, theme: Theme) {
  const sun = new THREE.Color(theme.sunColor);
  return shaderMaterial(
    shared,
    {
      uDeep: col('#5b8fc0'),
      uMid: col('#a9d3ec'),
      uFoam: { value: new THREE.Color('#ffffff').lerp(sun, 0.25) },
      uSunCol: { value: sun },
    },
    /* glsl */ `
      attribute vec3 aInfo;
      varying vec2 vUv;
      varying vec3 vInfo;
      varying vec3 vN;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vInfo = aInfo;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    /* glsl */ `
      uniform float uTime;
      uniform sampler2D uNoise;
      uniform vec3 uSunDir, uDeep, uMid, uFoam, uSunCol;
      varying vec2 vUv;
      varying vec3 vInfo;
      varying vec3 vN;
      #include <fog_pars_fragment>
      void main() {
        float u01 = vInfo.x, t = vInfo.y, lip = vInfo.z;
        // Water speeds up as it falls: stretch the scroll with the drop.
        float y = vUv.y - uTime * (6.0 + 16.0 * sqrt(t));
        float x = vUv.x;
        float s1 = texture2D(uNoise, vec2(x * 0.045, y * 0.0035)).r;
        float s2 = texture2D(uNoise, vec2(x * 0.11 + 0.3, y * 0.009)).g;
        float s3 = texture2D(uNoise, vec2(x * 0.27 + 0.7, y * 0.02)).b;
        float streak = s1 * 0.45 + s2 * 0.35 + s3 * 0.2;
        float bright = smoothstep(0.42, 0.68, streak);
        vec3 c = mix(uDeep, uMid, smoothstep(0.25, 0.5, streak));
        c = mix(c, uFoam, bright);
        // Bright lip where the water rolls over the edge, smoother darker water on the ledge behind it.
        float lipBand = exp(-lip * lip / 3.0);
        c = mix(c, uFoam * 1.1, lipBand * 0.85);
        c = mix(c, mix(uDeep, uMid, 0.5 + 0.4 * s2), step(lip, -0.6) * 0.6);
        // Churned white near the bottom.
        c = mix(c, uFoam, smoothstep(0.55, 0.95, t) * 0.75);
        float sunL = max(dot(normalize(vN), uSunDir), 0.0);
        c *= 0.78 + 0.32 * sunL;
        c += uSunCol * 0.12 * sunL * bright;
        float edge = smoothstep(0.0, 0.1 + 0.12 * s2, u01) * smoothstep(1.0, 0.9 - 0.12 * s1, u01);
        float a = edge * mix(0.7, 1.0, bright);
        a *= 1.0 - smoothstep(0.86, 1.0, t) * 0.85;
        a *= smoothstep(-9.0, -5.0, lip);
        gl_FragColor = vec4(c, a);
        ${OUTPUT}
      }
    `,
  );
}

// --- River -----------------------------------------------------------------------------------------------------------
// uv = (across metres from the centre, along metres downstream); aInfo = (across 0..1, along 0..1, unused).

export const MAX_FOAM_SPOTS = 8;

export function riverMaterial(shared: WaterShared, theme: Theme, spots: THREE.Vector4[]) {
  const padded = spots.slice(0, MAX_FOAM_SPOTS);
  while (padded.length < MAX_FOAM_SPOTS) padded.push(new THREE.Vector4(0, 0, 0, 0));
  return shaderMaterial(
    shared,
    {
      uDeep: col('#13667e'),
      uTurq: col('#2fb3bd'),
      uLight: col('#8fe3dc'),
      uFoam: col('#f4fbff'),
      uSky: { value: new THREE.Color(theme.skyHorizon) },
      uSunCol: { value: new THREE.Color(theme.sunColor) },
      uSpots: { value: padded },
    },
    /* glsl */ `
      attribute vec3 aInfo;
      varying vec2 vUv;
      varying vec3 vInfo;
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vInfo = aInfo;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    /* glsl */ `
      uniform float uTime;
      uniform sampler2D uNoise;
      uniform vec3 uSunDir, uDeep, uTurq, uLight, uFoam, uSky, uSunCol;
      uniform vec4 uSpots[${MAX_FOAM_SPOTS}];
      varying vec2 vUv;
      varying vec3 vInfo;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      void main() {
        float a01 = vInfo.x;
        float along = vUv.y - uTime * 5.0;
        float n1 = texture2D(uNoise, vec2(vUv.x * 0.02, along * 0.006)).r;
        float n2 = texture2D(uNoise, vec2(vUv.x * 0.05 + 0.4, (vUv.y - uTime * 7.0) * 0.012)).g;
        float n3 = texture2D(uNoise, vec2(vUv.x * 0.07 + 0.2, (vUv.y - uTime * 9.0) * 0.006)).b;
        float n4 = texture2D(uNoise, vec2(vUv.x * 0.16 + 0.6, (vUv.y - uTime * 11.0) * 0.012)).r;
        float bank = min(a01, 1.0 - a01);
        float mid = 1.0 - smoothstep(0.0, 0.5, bank);
        vec3 c = mix(uTurq, uDeep, smoothstep(0.15, 0.5, bank) * 0.7);
        c = mix(c, uLight, smoothstep(0.55, 0.8, n1 * 0.6 + n2 * 0.4) * 0.6);
        // Ripple lines: thin ridges in the flow noise.
        float ridge = 1.0 - abs(n2 - 0.5) * 2.0;
        c = mix(c, uLight, smoothstep(0.85, 0.97, ridge) * 0.5);
        // Foam: along the banks, in rapid streaks, and boiling around the foot of each fall.
        float foam = (1.0 - smoothstep(0.03, 0.14 + 0.08 * n2, bank)) * 0.9;
        foam = max(foam, smoothstep(0.64, 0.74, n3 * 0.7 + n4 * 0.3) * (0.5 + 0.5 * mid));
        for (int i = 0; i < ${MAX_FOAM_SPOTS}; i++) {
          vec4 sp = uSpots[i];
          if (sp.z <= 0.0) continue;
          float d = length(vWorld.xz - sp.xy) + (n3 - 0.5) * sp.z * 0.8;
          foam = max(foam, 1.0 - smoothstep(sp.z * 0.5, sp.z * 1.7, d));
          foam = max(foam, (1.0 - smoothstep(sp.z * 1.2, sp.z * 3.5, d)) * smoothstep(0.5, 0.7, n2));
        }
        c = mix(c, uFoam, clamp(foam, 0.0, 1.0));
        // Sky reflection at grazing angles and sun glints.
        vec3 v = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(v.y, 0.0), 4.0);
        c = mix(c, uSky, fres * 0.5);
        vec3 h = normalize(v + uSunDir);
        float glint = pow(max(h.y, 0.0), 400.0) * smoothstep(0.6, 0.9, n3);
        c += uSunCol * glint * 2.0;
        float lit = 0.8 + 0.25 * uSunDir.y;
        c *= lit;
        float a = smoothstep(0.0, 0.05, bank) * smoothstep(0.0, 0.04, vInfo.y) * smoothstep(1.0, 0.92, vInfo.y);
        gl_FragColor = vec4(c, a * (0.88 + 0.12 * foam));
        ${OUTPUT}
      }
    `,
  );
}

// --- Mist ------------------------------------------------------------------------------------------------------------
// One instanced quad per puff, turned to face the camera in the vertex shader. aCenter = start position;
// aSize = (size, life phase, rise over a life, opacity); aMove = (drift x, drift z over a life, lives per second, seed).

export function mistMaterial(shared: WaterShared, theme: Theme) {
  const sun = new THREE.Color(theme.sunColor);
  return shaderMaterial(
    shared,
    {
      uLit: { value: new THREE.Color('#ffffff').lerp(sun, 0.3) },
      uShade: { value: new THREE.Color('#b5c8d8').lerp(new THREE.Color(theme.skyTop), 0.15) },
    },
    /* glsl */ `
      attribute vec3 aCenter;
      attribute vec4 aSize;
      attribute vec4 aMove;
      uniform float uTime;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vSeed;
      varying float vH;
      #include <fog_pars_vertex>
      void main() {
        float life = fract(uTime * aMove.z + aSize.y);
        vec3 c = aCenter + vec3(aMove.x * life, aSize.z * life, aMove.y * life);
        float size = aSize.x * (0.6 + 0.6 * life);
        float ang = aMove.w * 6.2832 + uTime * 0.08 * (aMove.w - 0.5);
        vec2 p = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * position.xy;
        vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 wp = c + (camR * p.x + camU * p.y) * size;
        vUv = position.xy + 0.5;
        vH = p.y * 2.0 * camU.y;
        vSeed = aMove.w;
        vAlpha = aSize.w * smoothstep(0.0, 0.25, life) * (1.0 - smoothstep(0.55, 1.0, life));
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    /* glsl */ `
      uniform float uTime;
      uniform sampler2D uNoise;
      uniform vec3 uSunDir, uLit, uShade;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vSeed;
      varying float vH;
      #include <fog_pars_fragment>
      void main() {
        vec2 q = vUv - 0.5;
        float r = length(q) * 2.0;
        float n = texture2D(uNoise, vUv * 0.45 + vec2(vSeed * 7.3, vSeed * 3.1 + uTime * 0.01)).r;
        float n2 = texture2D(uNoise, vUv * 1.1 + vec2(vSeed * 2.7, vSeed * 5.9)).g;
        float shape = 1.0 - smoothstep(0.25, 1.0, r + (n - 0.5) * 0.9 + (n2 - 0.5) * 0.35);
        // Never reach the quad's edge, whatever the noise does.
        float a = shape * (1.0 - smoothstep(0.7, 0.98, r)) * vAlpha;
        if (a < 0.004) discard;
        float light = clamp(0.55 + vH * 0.45 + (n2 - 0.5) * 0.5, 0.0, 1.0);
        vec3 c = mix(uShade, uLit, light);
        gl_FragColor = vec4(c, a);
        ${OUTPUT}
      }
    `,
  );
}
