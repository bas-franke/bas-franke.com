// Garden Sentinels render pipeline. A lean custom chain (no EffectComposer):
//   1. scene -> linear HDR target (half float; MSAA 4x high, 2x medium, none on low)
//   2. bloom: soft-knee prefilter at half resolution, dual-filter down/up chain (levels by quality), tuned so amber
//      and mint emissives, the greenhouse glass and water sparkles glow without washing the garden out
//   3. tilt-shift: a half (high) / quarter (medium) resolution gaussian copy of the scene, mixed in towards the top
//      and bottom of the screen around the focus row (setFocus), stronger when zoomed in: the cozy miniature look
//   4. grade: warm white balance, ACES, warm highlights / cool shadows split tone, a touch of saturation, light
//      vignette, dither; FXAA on low (where there is no MSAA)
// Also gives the scene a soft sky environment (PMREM of a warm gradient dome) when it has none, so the ceramic and
// glass pick up gentle reflections, and forwards setFocus to world.ts (scene.userData.gardenFocus) so the sun's
// shadow frustum follows the camera.

import * as THREE from 'three';
import type { CreatePipeline, P3, Quality } from './api';

interface Spec {
  samples: number;
  bloomLevels: number;
  /** Tilt-shift blur resolution divisor; 0 = off. */
  tiltDiv: number;
  fxaa: boolean;
  /** Grade trims so every quality matches high: low has no shadows (brighter, limer lawn) and a shorter bloom chain. */
  exposure: number;
  sat: number;
  bloomGain: number;
}

const SPECS: Record<Quality, Spec> = {
  low: { samples: 0, bloomLevels: 4, tiltDiv: 0, fxaa: true, exposure: 0.96, sat: 0.95, bloomGain: 0.6 },
  medium: { samples: 2, bloomLevels: 5, tiltDiv: 4, fxaa: false, exposure: 1, sat: 1.04, bloomGain: 0.55 },
  high: { samples: 4, bloomLevels: 6, tiltDiv: 2, fxaa: false, exposure: 1, sat: 1.04, bloomGain: 0.55 },
};

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const prefilterFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform float threshold;
uniform float knee;
varying vec2 vUv;
void main() {
  // 4 bilinear taps = a 4x4 box: stable under motion.
  vec3 c = texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb
         + texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  c = min(c, vec3(40.0));
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float w = max(soft, br - threshold) / max(br, 1e-4);
  gl_FragColor = vec4(c * w, 1.0);
}`;

const downFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;

const upFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform float weight;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + texel * vec2(-1.0, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + texel * vec2(1.0, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + texel * vec2(0.0, -1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + texel * vec2(0.0, 1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 12.0 * weight, 1.0);
}`;

const copyFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + texel * vec2(-0.5, -0.5)).rgb + texture2D(tSrc, vUv + texel * vec2(0.5, -0.5)).rgb
         + texture2D(tSrc, vUv + texel * vec2(-0.5, 0.5)).rgb + texture2D(tSrc, vUv + texel * vec2(0.5, 0.5)).rgb;
  gl_FragColor = vec4(min(c * 0.25, vec3(16.0)), 1.0);
}`;

const gaussFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 dir;
varying vec2 vUv;
void main() {
  // 9-tap gaussian folded into 5 bilinear fetches.
  vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
  c += texture2D(tSrc, vUv + dir * 1.384615).rgb * 0.316216;
  c += texture2D(tSrc, vUv - dir * 1.384615).rgb * 0.316216;
  c += texture2D(tSrc, vUv + dir * 3.230769).rgb * 0.070270;
  c += texture2D(tSrc, vUv - dir * 3.230769).rgb * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}`;

const finalFrag = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tBlur;
uniform float tilt;
uniform float focusY;
uniform float bloomGain;
uniform float exposure;
uniform float sat;
uniform vec2 res;
uniform float encode;
varying vec2 vUv;

vec3 aces(vec3 x) {
  // Narkowicz fit, with a slightly softer shoulder via the pre-scale.
  x *= 0.6;
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  vec3 col = texture2D(tScene, vUv).rgb;
  if (tilt > 0.0) {
    float d = abs(vUv.y - focusY);
    float t = smoothstep(0.26, 0.6, d) * tilt;
    col = mix(col, texture2D(tBlur, vUv).rgb, t);
  }
  col += texture2D(tBloom, vUv).rgb * bloomGain;
  col *= exposure * vec3(1.05, 1.0, 0.93);
  col = aces(col);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, sat);
  vec3 shadowTint = vec3(0.94, 1.0, 1.07);
  vec3 lightTint = vec3(1.04, 1.0, 0.94);
  col *= mix(shadowTint, lightTint, smoothstep(0.1, 0.7, l));
  vec2 q = (vUv - 0.5) * vec2(res.x / res.y, 1.0);
  col *= 1.0 - 0.32 * smoothstep(0.4, 1.1, length(q));
  col = clamp(col, 0.0, 1.0);
  if (encode > 0.5) col = toSRGB(col);
  col += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

// FXAA 3.11-style (quality-lite) on the graded, sRGB image.
const fxaaFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
varying vec2 vUv;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec3 cM = texture2D(tSrc, vUv).rgb;
  float lM = luma(cM);
  float lN = luma(texture2D(tSrc, vUv + vec2(0.0, texel.y)).rgb);
  float lS = luma(texture2D(tSrc, vUv - vec2(0.0, texel.y)).rgb);
  float lE = luma(texture2D(tSrc, vUv + vec2(texel.x, 0.0)).rgb);
  float lW = luma(texture2D(tSrc, vUv - vec2(texel.x, 0.0)).rgb);
  float mn = min(lM, min(min(lN, lS), min(lE, lW)));
  float mx = max(lM, max(max(lN, lS), max(lE, lW)));
  float range = mx - mn;
  if (range < max(0.0312, mx * 0.125)) { gl_FragColor = vec4(cM, 1.0); return; }
  float lNW = luma(texture2D(tSrc, vUv + vec2(-texel.x, texel.y)).rgb);
  float lNE = luma(texture2D(tSrc, vUv + texel).rgb);
  float lSW = luma(texture2D(tSrc, vUv - texel).rgb);
  float lSE = luma(texture2D(tSrc, vUv + vec2(texel.x, -texel.y)).rgb);
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float red = max((lN + lS + lE + lW) * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
  dir = clamp(dir * rcp, -8.0, 8.0) * texel;
  vec3 a = 0.5 * (texture2D(tSrc, vUv - dir * 0.1667).rgb + texture2D(tSrc, vUv + dir * 0.1667).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tSrc, vUv - dir * 0.5).rgb + texture2D(tSrc, vUv + dir * 0.5).rgb);
  float lB = luma(b);
  gl_FragColor = vec4((lB < mn || lB > mx) ? a : b, 1.0);
}`;

function skyEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const env = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
varying vec3 vP;
void main() {
  vec3 d = normalize(vP);
  vec3 sky = mix(vec3(0.75, 0.82, 0.9), vec3(0.45, 0.62, 0.95), smoothstep(0.0, 0.8, d.y));
  vec3 ground = mix(vec3(0.32, 0.42, 0.2), vec3(0.18, 0.28, 0.12), smoothstep(0.0, -0.6, d.y));
  vec3 c = d.y > 0.0 ? sky : ground;
  // Warm sun glow, same side as world.ts's sun.
  vec3 s = normalize(vec3(-0.55, 1.15, -0.75));
  c += vec3(1.0, 0.8, 0.55) * pow(max(dot(d, s), 0.0), 24.0) * 4.0;
  gl_FragColor = vec4(c, 1.0);
}`,
    }),
  );
  env.add(dome);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.02);
  pmrem.dispose();
  dome.geometry.dispose();
  (dome.material as THREE.Material).dispose();
  return rt;
}

export const createPipeline: CreatePipeline = (renderer, scene, camera, quality) => {
  let spec = SPECS[quality];
  const hdr = (samples = 0, depth = false) => {
    const t = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: depth,
      stencilBuffer: false,
      samples,
    });
    t.texture.generateMipmaps = false;
    return t;
  };
  let sceneRT = hdr(spec.samples, true);
  let bloomRTs: THREE.WebGLRenderTarget[] = [];
  const blurRTs = [hdr(), hdr(), hdr()];
  const ldrRT = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false });
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  black.needsUpdate = true;

  // Soft sky reflections for the ceramic and glass.
  let envRT: THREE.WebGLRenderTarget | null = null;
  const prevEnvIntensity = scene.environmentIntensity;
  if (!scene.environment) {
    envRT = skyEnvironment(renderer);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.35;
  }

  const mk = (frag: string, uniforms: Record<string, THREE.IUniform>, additive = false) =>
    new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NoBlending,
      transparent: additive,
    });
  const prefilter = mk(prefilterFrag, { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 0.95 }, knee: { value: 0.5 } });
  const down = mk(downFrag, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } });
  const up = mk(upFrag, { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, weight: { value: 1 } }, true);
  const copy = mk(copyFrag, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } });
  const gauss = mk(gaussFrag, { tSrc: { value: null }, dir: { value: new THREE.Vector2() } });
  const final = mk(finalFrag, {
    tScene: { value: null },
    tBloom: { value: null },
    tBlur: { value: black },
    tilt: { value: 0 },
    focusY: { value: 0.5 },
    bloomGain: { value: 0.55 },
    exposure: { value: 1.0 },
    sat: { value: 1.04 },
    res: { value: new THREE.Vector2(1, 1) },
    encode: { value: 1 },
  });
  const fxaa = mk(fxaaFrag, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } });

  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri, prefilter);
  quad.frustumCulled = false;
  const draw = (m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null, clear = true) => {
    quad.material = m;
    renderer.setRenderTarget(target);
    if (clear) renderer.clear(true, false, false);
    renderer.render(quad, quadCam);
  };

  const makeBloom = () => {
    for (const r of bloomRTs) r.dispose();
    bloomRTs = Array.from({ length: spec.bloomLevels }, () => hdr());
  };
  makeBloom();

  let width = 0;
  let height = 0;
  const size = new THREE.Vector2();
  const fit = (force = false) => {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(1, size.x);
    const h = Math.max(1, size.y);
    if (!force && w === width && h === height) return;
    width = w;
    height = h;
    sceneRT.setSize(w, h);
    ldrRT.setSize(w, h);
    let bw = Math.max(1, w >> 1);
    let bh = Math.max(1, h >> 1);
    for (const r of bloomRTs) {
      r.setSize(bw, bh);
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
    const td = Math.max(1, spec.tiltDiv);
    blurRTs[0].setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    for (const r of blurRTs.slice(1)) r.setSize(Math.max(1, Math.round(w / td)), Math.max(1, Math.round(h / td)));
    final.uniforms.res.value.set(w, h);
  };

  // Focus.
  const focus = new THREE.Vector3();
  let focusDist = 60;
  const proj = new THREE.Vector3();

  return {
    render() {
      fit();
      // Count every pass of the frame in renderer.info (the engine's perf overlay reads it after the hook).
      renderer.info.autoReset = false;
      renderer.info.reset();
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 1);
      // Scene.
      renderer.setRenderTarget(sceneRT);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);

      // Bloom.
      prefilter.uniforms.tSrc.value = sceneRT.texture;
      prefilter.uniforms.texel.value.set(1 / width, 1 / height);
      draw(prefilter, bloomRTs[0]);
      for (let i = 1; i < bloomRTs.length; i++) {
        const src = bloomRTs[i - 1];
        down.uniforms.tSrc.value = src.texture;
        down.uniforms.texel.value.set(1 / src.width, 1 / src.height);
        draw(down, bloomRTs[i]);
      }
      for (let i = bloomRTs.length - 1; i > 0; i--) {
        const src = bloomRTs[i];
        up.uniforms.tSrc.value = src.texture;
        up.uniforms.texel.value.set(1 / src.width, 1 / src.height);
        up.uniforms.weight.value = 0.85;
        draw(up, bloomRTs[i - 1], false);
      }

      // Tilt-shift blur source.
      let tilt = 0;
      if (spec.tiltDiv > 0) {
        copy.uniforms.tSrc.value = sceneRT.texture;
        copy.uniforms.texel.value.set(1 / width, 1 / height);
        let src = blurRTs[0];
        draw(copy, src);
        if (spec.tiltDiv > 2) {
          copy.uniforms.tSrc.value = src.texture;
          copy.uniforms.texel.value.set(1 / src.width, 1 / src.height);
          draw(copy, blurRTs[1]);
          src = blurRTs[1];
        }
        const a = src;
        const b = src === blurRTs[1] ? blurRTs[2] : blurRTs[1];
        gauss.uniforms.tSrc.value = a.texture;
        gauss.uniforms.dir.value.set(1.5 / a.width, 0);
        draw(gauss, b);
        gauss.uniforms.tSrc.value = b.texture;
        gauss.uniforms.dir.value.set(0, 1.5 / b.height);
        draw(gauss, a);
        final.uniforms.tBlur.value = a.texture;
        // Stronger when zoomed in (the miniature look), subtle when overviewing.
        tilt = THREE.MathUtils.clamp(1.0 - focusDist / 90, 0, 0.45);
        proj.copy(focus).project(camera);
        final.uniforms.focusY.value = THREE.MathUtils.clamp(proj.y * 0.5 + 0.5, 0.2, 0.8);
      }
      final.uniforms.tilt.value = tilt;
      final.uniforms.exposure.value = spec.exposure;
      final.uniforms.sat.value = spec.sat;
      final.uniforms.bloomGain.value = spec.bloomGain;

      // Grade.
      final.uniforms.tScene.value = sceneRT.texture;
      final.uniforms.tBloom.value = bloomRTs[0].texture;
      if (spec.fxaa) {
        final.uniforms.encode.value = 1;
        draw(final, ldrRT);
        fxaa.uniforms.tSrc.value = ldrRT.texture;
        fxaa.uniforms.texel.value.set(1 / width, 1 / height);
        draw(fxaa, null);
      } else {
        draw(final, null);
      }
      renderer.autoClear = autoClear;
    },
    setSize() {
      fit(true);
    },
    setQuality(q) {
      const next = SPECS[q];
      if (next === spec) return;
      const old = spec;
      spec = next;
      if (old.samples !== spec.samples) {
        sceneRT.dispose();
        sceneRT = hdr(spec.samples, true);
      }
      if (old.bloomLevels !== spec.bloomLevels) makeBloom();
      fit(true);
    },
    setFocus(target: P3, distance: number) {
      focus.set(target.x, target.y, target.z);
      focusDist = distance;
      const f = scene.userData.gardenFocus as ((t: P3, d: number) => void) | undefined;
      f?.(target, distance);
    },
    dispose() {
      sceneRT.dispose();
      for (const r of [...bloomRTs, ...blurRTs]) r.dispose();
      ldrRT.dispose();
      black.dispose();
      for (const m of [prefilter, down, up, copy, gauss, final, fxaa]) m.dispose();
      tri.dispose();
      if (envRT) {
        if (scene.environment === envRT.texture) {
          scene.environment = null;
          scene.environmentIntensity = prevEnvIntensity;
        }
        envRT.dispose();
      }
    },
  };
};
