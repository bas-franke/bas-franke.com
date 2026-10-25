// Last Light's frame. A lean custom chain (no EffectComposer):
//   1. moon depth: an orthographic depth map along the moon direction (own pass, ~20 Hz), so the fog can tell which
//      air the moon reaches: shafts through windows, skylights and blasted holes appear by themselves
//   2. world (layer 0) -> linear HDR target with a depth texture (MSAA on high)
//   3. viewmodel (VIEWMODEL_LAYER) -> its own HDR target with alpha, composited after the fog so the gun is never fogged
//   4. volumetric fog at half (or quarter) resolution: jittered raymarch through animated ground mist and dust puffs,
//      in-scatter from the moon (shadowed), lamp cones, flashlights and flashes; reprojected temporal blend
//   5. combine: scene * transmittance + in-scatter (depth-aware upsample), viewmodel over it
//   6. bloom (dual filter) and the grade: ACES (the renderer's), cold desaturation, lifted shadows, vignette, grain,
//      chromatic aberration, hurt / hit / downed

import * as THREE from 'three';
import { VIEWMODEL_LAYER, type CreatePipeline, type FrameParams, type Pipeline, type Quality } from './api';
import type { WorldViewExt } from './world';

const MAX_LAMPS = 8;
const MAX_FLASHLIGHTS = 10;
const MAX_FLASHES = 10;
const MAX_PUFFS = 24;

interface Spec {
  samples: number;
  /** Screen-space reflections on wet floors and ambient occlusion, 0 = off. */
  ssr: number;
  ao: number;
  fogDiv: number;
  steps: number;
  moonMap: number;
  bloomLevels: number;
}

const SPECS: Record<Quality, Spec> = {
  low: { samples: 0, ssr: 0, ao: 0, fogDiv: 4, steps: 16, moonMap: 512, bloomLevels: 4 },
  medium: { samples: 2, ssr: 1, ao: 1, fogDiv: 2, steps: 26, moonMap: 1024, bloomLevels: 5 },
  high: { samples: 4, ssr: 1, ao: 1, fogDiv: 2, steps: 38, moonMap: 1024, bloomLevels: 5 },
};

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fogFrag = /* glsl */ `
#include <packing>
uniform sampler2D tDepth;
uniform sampler2D tHistory;
uniform sampler2D tMoon;
uniform mat4 projInv;
uniform mat4 viewInv;
uniform mat4 prevViewProj;
uniform mat4 moonMat;
uniform vec3 camPos;
uniform float near;
uniform float far;
uniform float time;
uniform float frame;
uniform vec2 res;
uniform float history;
uniform vec3 moonDir;
uniform vec3 moonColor;
uniform vec3 ambient;
uniform vec4 interior; // minX, maxX, minZ, maxZ
uniform float ceiling;
uniform float dust;
uniform vec4 gain; // lamps, flashlights, moon, density
uniform int lampCount;
uniform vec3 lampPos[${MAX_LAMPS}];
uniform vec3 lampColor[${MAX_LAMPS}];
uniform vec2 lampCone[${MAX_LAMPS}];
uniform int flCount;
uniform vec3 flPos[${MAX_FLASHLIGHTS}];
uniform vec4 flDir[${MAX_FLASHLIGHTS}];
uniform int flashCount;
uniform vec3 flashPos[${MAX_FLASHES}];
uniform vec3 flashColor[${MAX_FLASHES}];
uniform int puffCount;
uniform vec4 puffs[${MAX_PUFFS}];
uniform float puffDensity[${MAX_PUFFS}];
varying vec2 vUv;

#define STEPS ${'${STEPS}'}
#define MAX_DIST 42.0

float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float noise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1,0,0)), n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1)), n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-3), 1.5)); }

bool isInside(vec3 p) { return p.x > interior.x && p.x < interior.y && p.z > interior.z && p.z < interior.w && p.y < ceiling; }

float density(vec3 p, out float puffShare) {
  bool inside = isInside(p);
  vec3 wind = vec3(time * 0.18, 0.0, time * 0.07);
  float n = noise3(p * 0.45 + wind) * 0.65 + noise3(p * 1.3 - wind * 1.7) * 0.35;
  float mistH = inside ? 0.55 : 1.1;
  float ground = exp(-max(p.y, 0.0) / mistH) * smoothstep(0.25, 0.75, n);
  float base = inside ? 0.03 * dust : 0.014;
  float d = base * (0.6 + 0.8 * n) + ground * (inside ? 0.22 : 0.16);
  if (!inside) {
    // Fog banks rolling slowly across the yard.
    float bank = smoothstep(0.42, 0.85, noise3(p * vec3(0.07, 0.3, 0.07) + vec3(time * 0.035, 0.0, time * 0.015)));
    d += bank * 0.06 * exp(-max(p.y, 0.0) / 2.4);
  }
  float pd = 0.0;
  for (int i = 0; i < ${MAX_PUFFS}; i++) {
    if (i >= puffCount) break;
    vec3 q = p - puffs[i].xyz;
    float r = puffs[i].w;
    float k = 1.0 - dot(q, q) / (r * r);
    if (k > 0.0) pd += puffDensity[i] * k * k * (0.55 + 0.9 * noise3(p * 2.1 + vec3(0.0, time * 0.4, 0.0)));
  }
  puffShare = pd / max(d + pd, 1e-4);
  return d + pd;
}

float moonVis(vec3 p) {
  vec4 c = moonMat * vec4(p, 1.0);
  vec3 n = c.xyz / c.w * 0.5 + 0.5;
  if (n.x < 0.0 || n.x > 1.0 || n.y < 0.0 || n.y > 1.0) return 1.0;
  float d = texture2D(tMoon, n.xy).r;
  return n.z - 0.0015 <= d ? 1.0 : 0.0;
}

void main() {
  float depth = texture2D(tDepth, vUv).r;
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 vr = projInv * ndc;
  vec3 rayView = vr.xyz / vr.w;
  float dist;
  if (depth >= 1.0) dist = 26.0;
  else {
    float viewZ = perspectiveDepthToViewZ(depth, near, far);
    dist = min(length(rayView * (viewZ / rayView.z)), MAX_DIST);
  }
  vec3 dir = normalize(mat3(viewInv) * rayView);
  float jitter = ign(gl_FragCoord.xy + frame * 5.588238);
  vec3 scatter = vec3(0.0);
  float trans = 1.0;
  float prevT = 0.0;
  float cosMoon = dot(dir, moonDir);
  float phaseMoon = hg(cosMoon, 0.45) * 0.7 + hg(cosMoon, -0.2) * 0.3;
  for (int i = 0; i < STEPS; i++) {
    float a = (float(i) + jitter) / float(STEPS);
    float t = dist * a * a;
    float dt = t - prevT;
    prevT = t;
    vec3 p = camPos + dir * t;
    float puffShare;
    float sigma = density(p, puffShare) * gain.w;
    if (sigma < 1e-4) continue;
    vec3 L = ambient * (1.0 + puffShare);
    L += moonColor * gain.z * phaseMoon * moonVis(p);
    for (int k = 0; k < ${MAX_LAMPS}; k++) {
      if (k >= lampCount) break;
      vec3 d = p - lampPos[k];
      float r2 = dot(d, d);
      vec3 ld = d * inversesqrt(r2);
      float cone = smoothstep(lampCone[k].x, lampCone[k].y, -ld.y);
      if (cone <= 0.0) continue;
      cone *= cone * cone;
      L += lampColor[k] * gain.x * cone * hg(dot(dir, ld), 0.35) / (r2 + 0.3);
    }
    for (int k = 0; k < ${MAX_FLASHLIGHTS}; k++) {
      if (k >= flCount) break;
      vec3 d = p - flPos[k];
      float r2 = dot(d, d);
      vec3 ld = d * inversesqrt(r2);
      float c = dot(ld, flDir[k].xyz);
      float cone = smoothstep(0.9, 0.975, c) + 0.12 * smoothstep(0.75, 0.9, c);
      if (cone <= 0.0) continue;
      L += vec3(1.0, 0.95, 0.86) * gain.y * flDir[k].w * cone * hg(dot(dir, ld), 0.45) / (r2 + 1.5);
    }
    for (int k = 0; k < ${MAX_FLASHES}; k++) {
      if (k >= flashCount) break;
      vec3 d = p - flashPos[k];
      L += flashColor[k] * 0.03 / (dot(d, d) + 0.3);
    }
    float ext = exp(-sigma * dt);
    scatter += trans * L * sigma * dt;
    trans *= ext;
    if (trans < 0.01) break;
  }
  vec4 cur = vec4(scatter, trans);
  // Reproject the end point into last frame and blend with history to hide the jitter.
  vec3 endP = camPos + dir * min(dist, 30.0);
  vec4 pc = prevViewProj * vec4(endP, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  float ok = (pc.w > 0.0 && puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) ? history : 0.0;
  vec4 hist = texture2D(tHistory, puv);
  // Clamp history to a band around the current sample so moving lights do not smear.
  hist.rgb = clamp(hist.rgb, cur.rgb * 0.5 - 0.002, cur.rgb * 1.6 + 0.002);
  gl_FragColor = mix(cur, hist, ok);
}
`;

const combineFrag = /* glsl */ `
#include <packing>
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tFog;
uniform sampler2D tView;
uniform sampler2D tFloorRough;
uniform sampler2D tYardRough;
uniform vec2 fogRes;
uniform vec2 res;
uniform float near;
uniform float far;
uniform float ca;
uniform float blur;
uniform float fogOn;
uniform float ssr;
uniform float ao;
uniform float floorMeters;
uniform float yardMeters;
uniform float frame;
uniform vec4 interior;
uniform vec3 camPos;
uniform mat4 projInv;
uniform mat4 viewInv;
uniform mat4 viewMat;
uniform mat4 proj;
varying vec2 vUv;

float lin(float d) { return -perspectiveDepthToViewZ(d, near, far); }
vec3 viewPosAt(vec2 uv, float d) {
  vec4 vr = projInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rv = vr.xyz / vr.w;
  return rv * (perspectiveDepthToViewZ(d, near, far) / rv.z);
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// Ambient occlusion from the depth buffer: a few taps on a rotated disc, each weighted by how far it rises above the
// surface's tangent plane (normals from depth derivatives). Darkens corners, wall bases and the ground under props.
float occlusion(vec3 P, vec3 N) {
  float radius = 0.4;
  float px = radius * proj[1][1] * 0.5 * res.y / max(-P.z, 0.1);
  if (px < 2.0) return 1.0;
  float a0 = ign(gl_FragCoord.xy + frame * 7.0) * 6.2832;
  float occ = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    float a = a0 + fi * 2.39996;
    float rr = (fi + 0.5) / 8.0;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * rr * px / res;
    float d = texture2D(tDepth, uv).r;
    if (d >= 1.0) continue;
    vec3 Q = viewPosAt(uv, d);
    vec3 v = Q - P;
    float dist = length(v);
    occ += max(dot(N, v / max(dist, 1e-4)) - 0.12, 0.0) * (1.0 - smoothstep(radius * 0.6, radius * 1.6, dist));
  }
  return clamp(1.0 - occ / 8.0 * 1.6, 0.0, 1.0);
}

// Reflections on the wet parts of the floor: the floor's own roughness map says where it is wet; march the mirrored
// view ray in world space against the depth buffer, refine the hit, fade at the screen edges and with distance.
vec3 floorReflection(vec3 W, vec3 base, out float k) {
  k = 0.0;
  bool inRoom = W.x > interior.x && W.x < interior.y && W.z > interior.z && W.z < interior.w;
  float rough = inRoom ? texture2D(tFloorRough, W.xz / floorMeters).g : texture2D(tYardRough, W.xz / yardMeters).g;
  float wet = 1.0 - smoothstep(0.06, 0.42, rough);
  if (wet < 0.02) return base;
  vec3 V = normalize(W - camPos);
  vec3 R = vec3(V.x, -V.y, V.z);
  float cosv = max(-V.y, 0.0);
  float fres = 0.03 + 0.97 * pow(1.0 - cosv, 5.0);
  float jit = ign(gl_FragCoord.xy + frame * 3.0);
  float tPrev = 0.0;
  for (int i = 0; i < 18; i++) {
    float t = 0.06 * pow(1.33, float(i) + jit);
    vec3 Q = W + R * t;
    vec4 c = proj * viewMat * vec4(Q, 1.0);
    if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float sceneZ = lin(texture2D(tDepth, uv).r);
    if (c.w > sceneZ && c.w - sceneZ < 0.35 + t * 0.12) {
      float a = tPrev;
      float b = t;
      for (int j = 0; j < 4; j++) {
        float m = 0.5 * (a + b);
        vec4 cm = proj * viewMat * vec4(W + R * m, 1.0);
        vec2 um = cm.xy / cm.w * 0.5 + 0.5;
        if (cm.w > lin(texture2D(tDepth, um).r)) b = m;
        else a = m;
      }
      vec4 cb = proj * viewMat * vec4(W + R * b, 1.0);
      vec2 ub = cb.xy / cb.w * 0.5 + 0.5;
      vec2 edge = smoothstep(vec2(0.0), vec2(0.08), ub) * (1.0 - smoothstep(vec2(0.92), vec2(1.0), ub));
      k = wet * fres * edge.x * edge.y * (1.0 - smoothstep(6.0, 14.0, b)) * ssr;
      return texture2D(tScene, ub).rgb;
    }
    tPrev = t;
  }
  return base;
}

void main() {
  vec2 c = vUv - 0.5;
  vec2 off = c * ca;
  vec3 col;
  col.r = texture2D(tScene, vUv + off).r;
  col.g = texture2D(tScene, vUv).g;
  col.b = texture2D(tScene, vUv - off).b;
  if (blur > 0.0) {
    vec3 acc = col;
    for (int i = 1; i <= 6; i++) acc += texture2D(tScene, vUv - c * blur * float(i) * 0.012).rgb;
    col = acc / 7.0;
  }
  float depth = texture2D(tDepth, vUv).r;
  if (depth < 1.0 && (ao > 0.0 || ssr > 0.0)) {
    vec3 P = viewPosAt(vUv, depth);
    if (ao > 0.0) {
      vec3 N = normalize(cross(dFdx(P), dFdy(P)));
      if (dot(N, P) > 0.0) N = -N;
      col *= mix(1.0, occlusion(P, N), ao);
    }
    if (ssr > 0.0) {
      vec3 W = (viewInv * vec4(P, 1.0)).xyz;
      if (W.y < 0.02 && W.y > -0.06) {
        float k;
        vec3 refl = floorReflection(W, col, k);
        col = mix(col, refl, k);
      }
    }
  }
  // Depth-aware upsample of the half-res fog: weigh the four nearest fog texels by depth similarity.
  float dz = lin(depth);
  vec2 fp = vUv * fogRes - 0.5;
  vec2 f0 = floor(fp);
  vec2 fr = fp - f0;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 uv = (f0 + o + 0.5) / fogRes;
    float sz = lin(texture2D(tDepth, uv).r);
    float bw = (i == 0 ? 1.0 - fr.x : fr.x) * (j == 0 ? 1.0 - fr.y : fr.y);
    float w = bw / (0.02 + abs(sz - dz) / max(dz, 0.5));
    sum += texture2D(tFog, uv) * w;
    wsum += w;
  }
  vec4 fog = mix(vec4(0.0, 0.0, 0.0, 1.0), sum / max(wsum, 1e-5), fogOn);
  col = col * fog.a + fog.rgb;
  vec4 vm = texture2D(tView, vUv);
  col = col * (1.0 - vm.a) + vm.rgb;
  gl_FragColor = vec4(col, 1.0);
}
`;

const prefilterFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform vec2 threshold;
varying vec2 vUv;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 karis(vec3 c, inout float ws) { c = min(max(c, vec3(0.0)), vec3(300.0)); float w = 1.0 / (1.0 + lum(c)); ws += w; return c * w; }
void main() {
  float ws = 0.0;
  vec3 c = karis(texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb, ws);
  c += karis(texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb, ws);
  c += karis(texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb, ws);
  c += karis(texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb, ws);
  c /= ws;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - threshold.x + threshold.y, 0.0, 2.0 * threshold.y);
  soft = soft * soft / (4.0 * threshold.y + 1e-4);
  float k = max(soft, br - threshold.x) / max(br, 1e-4);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

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
  gl_FragColor = vec4(c * 0.125, 1.0);
}
`;

const upFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + texel * vec2(-2.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(2.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(0.0, -2.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(0.0, 2.0)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb * 2.0;
  gl_FragColor = vec4(c / 12.0, 1.0);
}
`;

const finalFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tBloom;
uniform float bloom;
uniform float time;
uniform float hurt;
uniform float hit;
uniform float downed;
uniform float exposure;
uniform float grain;
uniform vec2 res;
varying vec2 vUv;
// ACES fitted (Stephen Hill), so the look does not depend on the renderer's tone mapping setting.
vec3 acesFit(vec3 c) {
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 o = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = i * c;
  vec3 a = c * (c + 0.0245786) - 0.000090537;
  vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  return clamp(o * (a / b), 0.0, 1.0);
}
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec3 col = texture2D(tSrc, vUv).rgb;
  col += texture2D(tBloom, vUv).rgb * bloom;
  // Grade in linear HDR before the tone curve: cold, a little desaturated, shadows lifted to a deep teal.
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float sat = mix(0.78, 0.35, max(hurt * 0.8, downed));
  col = mix(vec3(l), col, sat);
  col *= vec3(0.93, 1.0, 1.08);
  col += vec3(0.0016, 0.0024, 0.0034) * (1.0 - smoothstep(0.0, 0.05, l));
  vec2 c = vUv - 0.5;
  float r = length(c * vec2(res.x / res.y, 1.0));
  float vig = smoothstep(0.35, 1.15, r);
  col *= 1.0 - vig * (0.62 + downed * 0.25);
  // Hurt: a red pulse closing in from the edges.
  float pulse = 0.65 + 0.35 * sin(time * (6.0 + hurt * 4.0));
  vec3 red = vec3(0.25, 0.0, 0.0);
  col = mix(col, col * vec3(1.0, 0.35, 0.3) + red * 0.04, clamp(vig * 2.2 * hurt * pulse + hit * smoothstep(0.2, 0.9, r) * 0.9, 0.0, 1.0));
  float hv = smoothstep(0.15, 0.95, r);
  col += vec3(0.11, 0.0, 0.004) * hv * hv * hurt * pulse;
  col *= 1.0 - downed * 0.35;
  col = acesFit(col * exposure);
  // Grain, stronger in the darks, and a faint scanline flicker of the exposure.
  float g = h12(gl_FragCoord.xy + fract(time * 13.7) * 1000.0) - 0.5;
  col += g * grain * (0.6 + 0.4 * smoothstep(0.0, 0.15, dot(col, vec3(0.33)))) * (1.0 - 0.6 * smoothstep(0.3, 0.9, dot(col, vec3(0.33))));
  col *= 0.985 + 0.015 * sin(time * 47.0);
  gl_FragColor = linearToOutputTexel(vec4(max(col, 0.0), 1.0));
}
`;

interface PuffState {
  pos: THREE.Vector3;
  radius: number;
  density: number;
  life: number;
  age: number;
  grow: number;
}

export const createPipeline: CreatePipeline = (renderer, scene, camera, world, view, quality) => {
  let spec = SPECS[quality];
  const hdr = (w: number, h: number, samples = 0, depth = false, depthTex = false) => {
    const t = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: depth,
      stencilBuffer: false,
      samples,
    });
    if (depthTex) {
      t.depthTexture = new THREE.DepthTexture(w, h);
      t.depthTexture.type = THREE.UnsignedIntType;
    }
    t.texture.generateMipmaps = false;
    return t;
  };

  let sceneRT = hdr(4, 4, spec.samples, true, true);
  let viewRT = hdr(4, 4, spec.samples, true);
  let fogRTs = [hdr(4, 4), hdr(4, 4)];
  const combineRT = hdr(4, 4);
  let bloomRTs: THREE.WebGLRenderTarget[] = [];
  const makeBloom = () => {
    for (const r of bloomRTs) r.dispose();
    bloomRTs = Array.from({ length: spec.bloomLevels }, () => hdr(4, 4));
  };
  makeBloom();

  // Moon depth map.
  const makeMoonRT = (n: number) => {
    const t = new THREE.WebGLRenderTarget(n, n, { depthBuffer: true, stencilBuffer: false });
    t.depthTexture = new THREE.DepthTexture(n, n);
    t.depthTexture.type = THREE.UnsignedIntType;
    t.depthTexture.minFilter = t.depthTexture.magFilter = THREE.NearestFilter;
    return t;
  };
  let moonRT = makeMoonRT(spec.moonMap);
  const b = world.bounds;
  const ext = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 2;
  const moonCam = new THREE.OrthographicCamera(-ext, ext, ext, -ext, 1, 160);
  moonCam.position.copy(view.moonDir).multiplyScalar(80);
  moonCam.lookAt(0, 0, 0);
  moonCam.updateMatrixWorld();
  moonCam.layers.set(0);
  const moonMat = new THREE.Matrix4().multiplyMatrices(moonCam.projectionMatrix, moonCam.matrixWorldInverse);
  const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });

  // Full-screen triangle.
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const pass = (frag: string, uniforms: Record<string, THREE.IUniform>, opts: Partial<THREE.ShaderMaterialParameters> = {}) =>
    new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...opts });

  const arr3 = (n: number) => Array.from({ length: n }, () => new THREE.Vector3());
  const fogUniforms: Record<string, THREE.IUniform> = {
    tDepth: { value: null },
    tHistory: { value: null },
    tMoon: { value: moonRT.depthTexture },
    projInv: { value: new THREE.Matrix4() },
    viewInv: { value: new THREE.Matrix4() },
    prevViewProj: { value: new THREE.Matrix4() },
    moonMat: { value: moonMat },
    camPos: { value: new THREE.Vector3() },
    near: { value: 0.05 },
    far: { value: 300 },
    time: { value: 0 },
    frame: { value: 0 },
    res: { value: new THREE.Vector2() },
    history: { value: 0 },
    moonDir: { value: view.moonDir.clone() },
    moonColor: { value: new THREE.Color() },
    ambient: { value: new THREE.Color(0.006, 0.008, 0.012) },
    interior: { value: new THREE.Vector4(world.interior.minX, world.interior.maxX, world.interior.minZ, world.interior.maxZ) },
    ceiling: { value: world.height },
    dust: { value: (view as WorldViewExt).dust ?? 1 },
    gain: { value: new THREE.Vector4(40, 1, 3, 1) },
    lampCount: { value: 0 },
    lampPos: { value: arr3(MAX_LAMPS) },
    lampColor: { value: arr3(MAX_LAMPS) },
    lampCone: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Vector2()) },
    flCount: { value: 0 },
    flPos: { value: arr3(MAX_FLASHLIGHTS) },
    flDir: { value: Array.from({ length: MAX_FLASHLIGHTS }, () => new THREE.Vector4()) },
    flashCount: { value: 0 },
    flashPos: { value: arr3(MAX_FLASHES) },
    flashColor: { value: arr3(MAX_FLASHES) },
    puffCount: { value: 0 },
    puffs: { value: Array.from({ length: MAX_PUFFS }, () => new THREE.Vector4()) },
    puffDensity: { value: new Array(MAX_PUFFS).fill(0) },
  };
  const makeFog = () => pass(fogFrag.replace('${STEPS}', String(spec.steps)), fogUniforms);
  let fogMat = makeFog();
  const combine = pass(combineFrag, {
    tScene: { value: null },
    tDepth: { value: null },
    tFog: { value: null },
    tView: { value: null },
    fogRes: { value: new THREE.Vector2() },
    near: { value: 0.05 },
    far: { value: 300 },
    ca: { value: 0.0025 },
    blur: { value: 0 },
    fogOn: { value: 1 },
    tFloorRough: { value: null },
    tYardRough: { value: null },
    res: { value: new THREE.Vector2() },
    ssr: { value: spec.ssr },
    ao: { value: spec.ao },
    floorMeters: { value: 4 },
    yardMeters: { value: 6 },
    frame: { value: 0 },
    interior: { value: new THREE.Vector4(world.interior.minX, world.interior.maxX, world.interior.minZ, world.interior.maxZ) },
    camPos: { value: new THREE.Vector3() },
    projInv: { value: new THREE.Matrix4() },
    viewInv: { value: new THREE.Matrix4() },
    viewMat: { value: new THREE.Matrix4() },
    proj: { value: new THREE.Matrix4() },
  });
  const wext = view as Partial<WorldViewExt>;
  const prefilter = pass(prefilterFrag, { tSrc: { value: combineRT.texture }, texel: { value: new THREE.Vector2() }, threshold: { value: new THREE.Vector2(1.1, 0.7) } });
  const down = pass(downFrag, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } });
  const up = pass(upFrag, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } }, {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    transparent: true,
  });
  const final = pass(finalFrag, {
    tSrc: { value: combineRT.texture },
    tBloom: { value: null },
    bloom: { value: 0.12 },
    time: { value: 0 },
    hurt: { value: 0 },
    hit: { value: 0 },
    downed: { value: 0 },
    exposure: { value: 1.6 },
    grain: { value: 0.022 },
    res: { value: new THREE.Vector2() },
  });

  const draw = (mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  };

  // Reflection environment from the world's dark env scene.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = view.group.userData.envScene as THREE.Scene | undefined;
  const envRT = envScene ? pmrem.fromScene(envScene, 0.04) : null;
  if (envRT) scene.environment = envRT.texture;

  // ---- sizes ----------------------------------------------------------------------------------------------------
  let width = 0;
  let height = 0;
  const size = new THREE.Vector2();
  const fit = () => {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(1, size.x);
    const h = Math.max(1, size.y);
    if (w === width && h === height) return;
    width = w;
    height = h;
    sceneRT.setSize(w, h);
    viewRT.setSize(w, h);
    combineRT.setSize(w, h);
    const fw = Math.max(1, Math.round(w / spec.fogDiv));
    const fh = Math.max(1, Math.round(h / spec.fogDiv));
    for (const f of fogRTs) f.setSize(fw, fh);
    fogUniforms.res.value.set(fw, fh);
    combine.uniforms.fogRes.value.set(fw, fh);
    let bw = Math.max(1, w >> 1);
    let bh = Math.max(1, h >> 1);
    for (const r of bloomRTs) {
      r.setSize(bw, bh);
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
    prefilter.uniforms.texel.value.set(1 / w, 1 / h);
    combine.uniforms.res.value.set(w, h);
    final.uniforms.res.value.set(w, h);
    fogUniforms.history.value = 0;
  };

  // ---- puffs ------------------------------------------------------------------------------------------------------
  const puffs: PuffState[] = [];

  let frame = 0;
  let moonDue = 0;
  let layerCheck = 0;
  const prevViewProj = new THREE.Matrix4();
  const viewProj = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  const hiddenScratch: THREE.Object3D[] = [];
  let fogCur = 0;

  const renderMoon = () => {
    hiddenScratch.length = 0;
    scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (o.userData.noMoonShadow || (m.material && (m.material as THREE.Material).transparent) || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite)
        hiddenScratch.push(o);
    });
    for (const o of hiddenScratch) o.visible = false;
    const bg = scene.background;
    scene.background = null;
    scene.overrideMaterial = depthOnly;
    renderer.setRenderTarget(moonRT);
    renderer.clear(false, true, false);
    renderer.render(scene, moonCam);
    scene.overrideMaterial = null;
    scene.background = bg;
    for (const o of hiddenScratch) o.visible = true;
  };

  /** Lab switches for profiling: multiply the quality spec's effects. */
  const flags = { ssr: 1, ao: 1, glows: 1 };
  const pipeline: Pipeline & { debug: Record<string, Record<string, THREE.IUniform>>; flags: typeof flags } = {
    debug: { fog: fogUniforms, combine: combine.uniforms, final: final.uniforms },
    flags,
    render(p: FrameParams) {
      fit();
      frame++;
      const autoClear = renderer.autoClear;
      const savedLayers = camera.layers.mask;
      // Lights must reach both passes; new lights (muzzle flashes) are picked up every second. Lights marked
      // `userData.worldOnly` (flashlights right next to the gun) stay on the world layer.
      if (layerCheck-- <= 0) {
        layerCheck = 60;
        scene.traverse((o) => {
          if ((o as THREE.Light).isLight && o.userData.worldOnly !== true) o.layers.enableAll();
        });
      }
      moonDue -= p.dt;
      if (moonDue <= 0 || frame < 3) {
        moonDue = 1 / 20;
        renderMoon();
      }
      // World.
      camera.layers.set(0);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      // Viewmodel.
      camera.layers.set(VIEWMODEL_LAYER);
      const bg = scene.background;
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(viewRT);
      renderer.clear(true, true, false);
      renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = true;
      scene.background = bg;
      renderer.setClearColor(0x000000, 1);
      camera.layers.mask = savedLayers;

      // Fog uniforms.
      const u = fogUniforms;
      camera.updateMatrixWorld();
      u.projInv.value.copy(camera.projectionMatrixInverse);
      u.viewInv.value.copy(camera.matrixWorld);
      u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
      u.near.value = camera.near;
      u.far.value = camera.far;
      u.time.value = p.time;
      u.frame.value = frame % 64;
      u.prevViewProj.value.copy(prevViewProj);
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      prevViewProj.copy(viewProj);
      const moonI = view.moon.intensity;
      u.moonColor.value.copy(view.moon.color).multiplyScalar(moonI * 0.7);
      u.moonDir.value.copy(view.moonDir);
      const lamps = view.lamps;
      const ln = Math.min(MAX_LAMPS, lamps.length);
      u.lampCount.value = ln;
      for (let i = 0; i < ln; i++) {
        const L = lamps[i];
        L.light.getWorldPosition(tmp);
        u.lampPos.value[i].copy(tmp);
        u.lampColor.value[i].set(L.color.r, L.color.g, L.color.b).multiplyScalar(L.level);
        const outer = Math.cos(L.light.angle);
        const inner = Math.cos(L.light.angle * (1 - L.light.penumbra));
        u.lampCone.value[i].set(outer, inner);
      }
      const fl = p.flashlights.slice(0, MAX_FLASHLIGHTS);
      u.flCount.value = fl.length;
      fl.forEach((f, i) => {
        u.flPos.value[i].set(f.pos.x, f.pos.y, f.pos.z);
        u.flDir.value[i].set(f.dir.x, f.dir.y, f.dir.z, f.on * 2.2);
      });
      const fx = [...(flags.glows ? (wext.glows ?? []) : []).filter((g) => g.intensity > 0), ...p.flashes].slice(0, MAX_FLASHES);
      u.flashCount.value = fx.length;
      fx.forEach((f, i) => {
        u.flashPos.value[i].set(f.pos.x, f.pos.y, f.pos.z);
        u.flashColor.value[i].set(f.color.r, f.color.g, f.color.b).multiplyScalar(f.intensity);
      });
      // Puffs age and spread.
      for (let i = puffs.length - 1; i >= 0; i--) {
        const q = puffs[i];
        q.age += p.dt;
        q.radius += q.grow * p.dt;
        q.pos.y += p.dt * 0.15;
        if (q.age >= q.life) puffs.splice(i, 1);
      }
      u.puffCount.value = puffs.length;
      puffs.forEach((q, i) => {
        u.puffs.value[i].set(q.pos.x, q.pos.y, q.pos.z, q.radius);
        const k = 1 - q.age / q.life;
        u.puffDensity.value[i] = Math.min(1, q.density) * 0.9 * k * Math.sqrt(k) * Math.min(1, q.age * 8 + 0.3);
      });

      // Fog pass (ping-pong history).
      const cur = fogRTs[fogCur];
      const prev = fogRTs[1 - fogCur];
      fogCur = 1 - fogCur;
      u.tDepth.value = sceneRT.depthTexture;
      u.tHistory.value = prev.texture;
      u.tMoon.value = moonRT.depthTexture;
      renderer.autoClear = false;
      draw(fogMat, cur);
      u.history.value = 0.82;

      // Combine.
      const c = combine.uniforms;
      c.tScene.value = sceneRT.texture;
      c.tDepth.value = sceneRT.depthTexture;
      c.tFog.value = cur.texture;
      c.tView.value = viewRT.texture;
      c.near.value = camera.near;
      c.far.value = camera.far;
      c.blur.value = p.downed ? 1 : p.hit * 0.25;
      c.ssr.value = spec.ssr * flags.ssr;
      c.ao.value = spec.ao * flags.ao;
      c.frame.value = frame % 64;
      c.camPos.value.copy(u.camPos.value);
      c.projInv.value.copy(camera.projectionMatrixInverse);
      c.viewInv.value.copy(camera.matrixWorld);
      c.viewMat.value.copy(camera.matrixWorldInverse);
      c.proj.value.copy(camera.projectionMatrix);
      if (wext.floorSet) {
        c.tFloorRough.value = wext.floorSet.orm;
        c.floorMeters.value = wext.floorSet.meters;
      }
      if (wext.yardSet) {
        c.tYardRough.value = wext.yardSet.orm;
        c.yardMeters.value = wext.yardSet.meters;
      }
      if (!wext.floorSet || !wext.yardSet) c.ssr.value = 0;
      c.ca.value = 0.0022 + p.hit * 0.008 + (p.downed ? 0.006 : 0);
      draw(combine, combineRT);

      // Bloom.
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
        up.uniforms.texel.value.set(0.5 / src.width, 0.5 / src.height);
        draw(up, bloomRTs[i - 1]);
      }
      const f = final.uniforms;
      f.tBloom.value = bloomRTs[0].texture;
      f.time.value = p.time;
      f.hurt.value = p.hurt;
      f.hit.value = p.hit;
      f.downed.value = p.downed ? 1 : 0;
      draw(final, null);
      renderer.autoClear = autoClear;
    },
    puff(pos, radius, density, life, grow = 0.4) {
      if (puffs.length >= MAX_PUFFS) {
        // Replace the faintest.
        let k = 0;
        for (let i = 1; i < puffs.length; i++) if (puffs[i].density * (1 - puffs[i].age / puffs[i].life) < puffs[k].density * (1 - puffs[k].age / puffs[k].life)) k = i;
        puffs.splice(k, 1);
      }
      puffs.push({ pos: new THREE.Vector3(pos.x, pos.y, pos.z), radius, density, life, age: 0, grow });
    },
    setQuality(q) {
      if (SPECS[q] === spec) return;
      spec = SPECS[q];
      sceneRT.dispose();
      viewRT.dispose();
      for (const f of fogRTs) f.dispose();
      sceneRT = hdr(4, 4, spec.samples, true, true);
      viewRT = hdr(4, 4, spec.samples, true);
      fogRTs = [hdr(4, 4), hdr(4, 4)];
      makeBloom();
      moonRT.dispose();
      moonRT = makeMoonRT(spec.moonMap);
      fogMat.dispose();
      fogMat = makeFog();
      width = height = 0;
      moonDue = 0;
      // world.ts dropped its shadow maps for the new sizes: draw them again before anything samples them.
      renderer.shadowMap.needsUpdate = true;
    },
    dispose() {
      sceneRT.dispose();
      viewRT.dispose();
      combineRT.dispose();
      for (const f of fogRTs) f.dispose();
      for (const r of bloomRTs) r.dispose();
      moonRT.dispose();
      tri.dispose();
      depthOnly.dispose();
      for (const m of [fogMat, combine, prefilter, down, up, final]) m.dispose();
      envRT?.dispose();
      pmrem.dispose();
      if (scene.environment === envRT?.texture) scene.environment = null;
    },
  };
  return pipeline;
};
