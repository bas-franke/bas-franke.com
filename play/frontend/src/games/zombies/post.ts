// Last Light's frame: the hotel lobby at 2 am in thick fog. A lean custom chain (no EffectComposer):
//   1. light depth maps (own passes, left out: glass and other transparent things, points, `noMoonShadow` objects, so
//      light passes the glass but mullions, columns, people and furniture block it): a perspective map per street
//      light with `shafts` (round-robin at a fixed rate), and the old orthographic sun map, only while the moon is
//      bright enough to matter. (WorldView calls the sun `moon`/`moonDir`.)
//   2. world (layer 0) -> linear HDR target with a depth texture (MSAA on medium/high)
//   3. viewmodel (VIEWMODEL_LAYER) -> its own HDR target with alpha, composited after the haze so the gun stays crisp
//   4. volumetric fog at half (or quarter) resolution: outside dense cold night fog (~5 m visibility, billowing, thinning
//      with height) that creeps in behind the glass; inside a lighter dusty haze. In-scatter from the street lights
//      (cone, range falloff, Henyey-Greenstein, shadowed for the shaft lamps: god rays between the mullions and lit
//      cones in the fog), lamp cones, flashlights, flashes and dust/smoke puffs; analytic step integration, temporal
//      blend
//   5. reflections on the floor and the wet paving (SSR at half or full resolution): world-space march of the mirrored
//      view ray against the depth buffer, binary refinement, roughness-aware blur from a small blur pyramid of the scene,
//      faded by the fog the bounce crosses outside. Where the ray misses, the material's own environment reflection.
//   6. combine: AO, reflections, scene * transmittance + in-scatter (depth-aware upsample that shortens far samples
//      over thin near things), far fogged pixels smeared, lit windows and lamps glowing through as soft haloes (a
//      transmittance floor for bright far pixels plus blurred light in the fog), viewmodel over it
//   7. auto exposure: average log luminance into a 1x1 target, adapted over time; a low key and tight max for night
//   8. bloom (dual filter, on exposed values) and the night grade: cold blue-grey shadows, sodium highlights, ACES,
//      vignette, the hurt / hit / downed effects, into an 8-bit display-encoded target
//   9. FXAA on that (every quality), then grain and dither against banding

import * as THREE from 'three';
import { VIEWMODEL_LAYER, type CreatePipeline, type FrameParams, type Pipeline, type Quality } from './api';
import type { StreetLight, WorldViewExt } from './world';

const MAX_LAMPS = 8;
const MAX_FLASHLIGHTS = 10;
const MAX_FLASHES = 10;
const MAX_PUFFS = 24;
/** Street lights in the fog; the first MAX_SHAFTS of them (`shafts: true`) get a shadow map. */
const MAX_STREET = 8;
const MAX_SHAFTS = 3;

interface Spec {
  samples: number;
  /** Reflection resolution divisor, 0 = off. */
  ssrDiv: number;
  ssrSteps: number;
  ao: number;
  fogDiv: number;
  steps: number;
  sunMap: number;
  bloomLevels: number;
  /** Street lights with shadowed shafts, their depth map size, and depth renders per second shared among them. */
  shafts: number;
  shaftMap: number;
  shaftRate: number;
}

const SPECS: Record<Quality, Spec> = {
  low: { samples: 0, ssrDiv: 0, ssrSteps: 0, ao: 0, fogDiv: 4, steps: 16, sunMap: 1024, bloomLevels: 4, shafts: 1, shaftMap: 512, shaftRate: 10 },
  medium: { samples: 2, ssrDiv: 2, ssrSteps: 24, ao: 1, fogDiv: 2, steps: 24, sunMap: 1536, bloomLevels: 5, shafts: 2, shaftMap: 768, shaftRate: 24 },
  high: { samples: 4, ssrDiv: 1, ssrSteps: 32, ao: 1, fogDiv: 2, steps: 32, sunMap: 2048, bloomLevels: 6, shafts: 3, shaftMap: 1024, shaftRate: 36 },
};

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fogFrag = /* glsl */ `
#include <packing>
uniform sampler2D tDepth;
uniform sampler2D tHistory;
uniform sampler2D tSun;
uniform sampler2D tSL0;
uniform sampler2D tSL1;
uniform sampler2D tSL2;
uniform mat4 projInv;
uniform mat4 viewInv;
uniform mat4 prevViewProj;
uniform mat4 sunMat;
uniform vec3 camPos;
uniform float near;
uniform float far;
uniform float time;
uniform float frame;
uniform vec2 res;
uniform float history;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 shaftTint;
uniform vec3 ambient;
uniform vec3 ambientOut;
uniform vec4 interior; // minX, maxX, minZ, maxZ
uniform float ceiling;
uniform float dust;
uniform vec4 gain; // lamps, flashlights, sun, density
uniform vec4 night; // outside density, inside density, creep depth (m), street-light gain
uniform float inBoost;
uniform float dbg;
uniform vec3 cityGlow;
uniform float cookieOut; // how much of the beam cookie shows in the outside fog // street-light in-scatter inside, relative to outside
uniform int lampCount;
uniform vec3 lampPos[${MAX_LAMPS}];
uniform vec3 lampColor[${MAX_LAMPS}];
uniform vec2 lampCone[${MAX_LAMPS}];
uniform int slCount;
uniform int slShadows;
uniform int slShafts; // street lights marked shafts (sorted first), shadow map or not
uniform vec3 slPos[${MAX_STREET}];
uniform vec3 slDir[${MAX_STREET}];
uniform vec3 slColor[${MAX_STREET}];
uniform vec3 slCone[${MAX_STREET}]; // cosOuter, cosInner, range
uniform mat4 slMat[${MAX_SHAFTS}];
uniform vec2 slClip[${MAX_SHAFTS}]; // near, far of the shadow camera
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
#define MAX_DIST 60.0

float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float noise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1,0,0)), n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1)), n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-3), 1.5)); }

// 1 inside the lobby, 0 outside. Hard at the solid walls and the ceiling; behind the glass facade (interior.z) the
// outside fog creeps in over the first metres, further where it billows.
float insideness(vec3 p, float n) {
  if (p.x < interior.x || p.x > interior.y || p.z > interior.w || p.y > ceiling || p.z < interior.z) return 0.0;
  return smoothstep(0.0, night.z * (0.5 + n), p.z - interior.z);
}

// Outside: cold night fog, dense (visibility ~5 m), billowing on a large scale, thinning slowly with height. Inside:
// a lighter dusty haze with finer swirls and more dust low down, so the street-light shafts read. Plus puffs.
float density(vec3 p, out float puffShare, out float inside) {
  vec3 wind = vec3(time * 0.05, time * 0.012, time * 0.03);
  float big = noise3(p * 0.09 + vec3(time * 0.035, time * 0.01, time * 0.02));
  float n = noise3(p * 0.35 + wind) * 0.6 + noise3(p * 1.7 - wind * 2.3) * 0.4;
  inside = insideness(p, big);
  float hy = max(p.y, 0.0);
  float outD = night.x * (0.6 + 0.8 * big) * (0.8 + 0.4 * n) * (0.45 + 0.55 * exp(-hy / 14.0));
  float inD = night.y * dust * (0.55 + 0.9 * n) + night.y * 0.5 * exp(-hy / 1.4) * n;
  float d = mix(outD, inD, inside);
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

float sunVis(vec3 p) {
  vec4 c = sunMat * vec4(p, 1.0);
  vec3 n = c.xyz / c.w * 0.5 + 0.5;
  if (n.x < 0.0 || n.x > 1.0 || n.y < 0.0 || n.y > 1.0) return 1.0;
  float d = texture2D(tSun, n.xy).r;
  return n.z - 0.0008 <= d ? 1.0 : 0.0;
}

float noise2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash13(vec3(i, 7.0)), b = hash13(vec3(i + vec2(1, 0), 7.0)), c = hash13(vec3(i + vec2(0, 1), 7.0)), d = hash13(vec3(i + 1.0, 7.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Street-light cookie: streaks in the lamp's own projection (constant along each ray from the lamp), as if the light
// came through grime, rain streaks and the gaps of the fixture. The facade's thin mullions alone leave the cone almost
// fully lit; the cookie splits it into separate diverging beams with dark gaps, and the real shadows cut into those.
// Needs no shadow map, so on low the lamps without one still throw beams.
float slCookie(int k, vec3 ld, float amount) {
  vec3 D = slDir[k];
  vec3 R = normalize(cross(D, vec3(0.0, 1.0, 0.0)));
  vec3 U = cross(R, D);
  vec2 q = vec2(dot(ld, R), dot(ld, U)) / max(dot(ld, D), 0.05);
  float sk = float(k) * 17.3;
  float n = noise2(vec2(q.x * 12.0 + sk, q.y * 1.6)) * 0.75 + noise2(vec2(q.x * 33.0 - sk, q.y * 4.0)) * 0.25;
  return mix(1.0, 0.04 + 0.96 * smoothstep(0.47, 0.6, n), amount);
}

// Street-light shadow maps (perspective): compare linear depths so one bias works near and far.
float slVis(int k, vec3 p) {
  vec4 c = slMat[k] * vec4(p, 1.0);
  if (c.w <= 0.0) return 0.0;
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  float d = k == 0 ? texture2D(tSL0, uv).r : (k == 1 ? texture2D(tSL1, uv).r : texture2D(tSL2, uv).r);
  if (d >= 1.0) return 1.0;
  float z = -perspectiveDepthToViewZ(d, slClip[k].x, slClip[k].y);
  return c.w <= z + 0.08 ? 1.0 : 0.0;
}

void main() {
  float depth = texture2D(tDepth, vUv).r;
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 vr = projInv * ndc;
  vec3 rayView = vr.xyz / vr.w;
  float dist;
  if (depth >= 1.0) dist = 45.0;
  else {
    float viewZ = perspectiveDepthToViewZ(depth, near, far);
    dist = min(length(rayView * (viewZ / rayView.z)), MAX_DIST);
  }
  vec3 dir = normalize(mat3(viewInv) * rayView);
  if (dbg > 0.5) {
    vec3 P = camPos + dir * (dist - 0.03);
    int k = int(dbg) - 1;
    vec3 ld = normalize(P - slPos[k]);
    float cone = smoothstep(slCone[k].x, slCone[k].y, dot(ld, slDir[k]));
    gl_FragColor = vec4(vec3(slVis(k, P) * cone, cone * 0.3, 0.0), 0.0);
    return;
  }
  float jitter = ign(gl_FragCoord.xy + frame * 5.588238);
  vec3 scatter = vec3(0.0);
  float trans = 1.0;
  float prevT = 0.0;
  float cosSun = dot(dir, sunDir);
  float phaseSun = hg(cosSun, 0.45) * 0.55 + 0.45 * 0.0796;
  for (int i = 0; i < STEPS; i++) {
    float a = (float(i) + jitter) / float(STEPS);
    float t = dist * a * a;
    float dt = t - prevT;
    prevT = t;
    vec3 p = camPos + dir * t;
    float puffShare;
    float inside;
    float sigma = density(p, puffShare, inside) * gain.w;
    if (sigma < 1e-5) continue;
    vec3 L = mix(ambientOut, ambient, inside) * (1.0 + puffShare * 2.0);
    if (gain.z > 0.0) L += sunColor * shaftTint * gain.z * phaseSun * sunVis(p);
    for (int k = 0; k < ${MAX_STREET}; k++) {
      if (k >= slCount) break;
      vec3 d = p - slPos[k];
      float r2 = dot(d, d);
      float rr = r2 / (slCone[k].z * slCone[k].z);
      if (rr >= 1.0) continue;
      vec3 ld = d * inversesqrt(r2);
      float cone = smoothstep(slCone[k].x, slCone[k].y, dot(ld, slDir[k]));
      if (cone <= 0.0) continue;
      float fall = 1.0 - rr * rr;
      float vis = k < slShadows ? slVis(k, p) : 1.0;
      if (vis <= 0.0) continue;
      if (k < slShafts) vis *= slCookie(k, ld, mix(cookieOut, 1.0, inside));
      // Only the shaft lamps get the lobby boost: the others are plaza lights.
      float boost = k < slShafts ? mix(1.0, inBoost, inside) : 1.0;
      // Forward scattering makes the shafts glow when you look towards the lamp; the isotropic part keeps them
      // readable from the side.
      float ph = hg(dot(dir, ld), 0.6) * 0.65 + 0.35 * 0.0796;
      L += slColor[k] * night.w * boost * cone * fall * fall * vis * ph / (r2 + 0.6);
    }
    for (int k = 0; k < ${MAX_LAMPS}; k++) {
      if (k >= lampCount) break;
      vec3 d = p - lampPos[k];
      float r2 = dot(d, d);
      vec3 ld = d * inversesqrt(r2);
      float cone = smoothstep(lampCone[k].x, lampCone[k].y, -ld.y);
      if (cone <= 0.0) continue;
      cone *= cone;
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
      L += vec3(1.0, 0.96, 0.9) * gain.y * flDir[k].w * cone * hg(dot(dir, ld), 0.45) / (r2 + 1.5);
    }
    for (int k = 0; k < ${MAX_FLASHES}; k++) {
      if (k >= flashCount) break;
      vec3 d = p - flashPos[k];
      L += flashColor[k] * 0.03 / (dot(d, d) + 0.3);
    }
    // In-scatter integrated over the step analytically: stable however thick the fog gets.
    float ext = exp(-sigma * dt);
    scatter += trans * L * (1.0 - ext);
    trans *= ext;
    if (trans < 0.003) break;
  }
  // Beyond the march the fog is lit by the city: a faint warm-grey glow low over the horizon, so tower silhouettes
  // read dark against it.
  if (depth >= 1.0) scatter += cityGlow * (0.25 + 0.75 * exp(-max(dir.y, 0.0) * 5.0));
  vec4 cur = vec4(scatter, trans);
  vec3 endP = camPos + dir * min(dist, 30.0);
  vec4 pc = prevViewProj * vec4(endP, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  float ok = (pc.w > 0.0 && puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) ? history : 0.0;
  vec4 hist = texture2D(tHistory, puv);
  hist.rgb = clamp(hist.rgb, cur.rgb * 0.5 - 0.002, cur.rgb * 1.6 + 0.002);
  gl_FragColor = mix(cur, hist, ok);
}
`;

const ssrFrag = /* glsl */ `
#include <packing>
uniform sampler2D tDepth;
uniform sampler2D tScene;
uniform sampler2D tHalf;
uniform sampler2D tQuarter;
uniform sampler2D tFloorRough;
uniform sampler2D tYardRough;
uniform float hasRough;
uniform float yardMeters;
uniform vec4 interior; // minX, maxX, minZ, maxZ
uniform float fogOut; // outside fog density: what the reflected ray crosses fades out
uniform vec2 quarterTexel;
uniform float floorMeters;
uniform float floorRough;
uniform float strength;
uniform float near;
uniform float far;
uniform vec3 camPos;
uniform mat4 projInv;
uniform mat4 viewInv;
uniform mat4 viewMat;
uniform mat4 proj;
varying vec2 vUv;

#define STEPS ${'${SSR_STEPS}'}

float lin(float d) { return -perspectiveDepthToViewZ(d, near, far); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  gl_FragColor = vec4(0.0);
  float d0 = texture2D(tDepth, vUv).r;
  if (d0 >= 1.0) return;
  vec4 vr = projInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rv = vr.xyz / vr.w;
  vec3 P = rv * (perspectiveDepthToViewZ(d0, near, far) / rv.z);
  vec3 W = (viewInv * vec4(P, 1.0)).xyz;
  // The floor only: polished stone everywhere (the wet patches of the old maps used the same path).
  if (W.y > 0.03 || W.y < -0.06) return;
  bool outside = W.x < interior.x || W.x > interior.y || W.z < interior.z || W.z > interior.w;
  float rough = hasRough > 0.5 ? texture2D(tFloorRough, W.xz / floorMeters).g : floorRough;
  // Wet paving: glossy puddles, but rougher than polished marble, so neon and lamps smear into streaks.
  if (outside) rough = hasRough > 0.5 ? max(texture2D(tYardRough, W.xz / yardMeters).g * 0.8, 0.2) : 0.3;
  float gloss = 1.0 - smoothstep(0.08, 0.62, rough);
  if (gloss < 0.02) return;
  vec3 V = normalize(W - camPos);
  vec3 R = vec3(V.x, -V.y, V.z);
  float cosv = max(-V.y, 0.0);
  float fres = 0.04 + 0.96 * pow(1.0 - cosv, 5.0);
  float jit = 0.0;
  float tPrev = 0.0;
  for (int i = 0; i < STEPS; i++) {
    float t = 0.08 * pow(1.23, float(i) + jit);
    vec3 Q = W + R * t;
    vec4 c = proj * viewMat * vec4(Q, 1.0);
    if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float sd = texture2D(tDepth, uv).r;
    float sceneZ = sd >= 1.0 ? 1e5 : lin(sd);
    if (c.w > sceneZ && c.w - sceneZ < 0.35 + t * 0.15) {
      float a = tPrev;
      float b = t;
      for (int j = 0; j < 5; j++) {
        float m = 0.5 * (a + b);
        vec4 cm = proj * viewMat * vec4(W + R * m, 1.0);
        vec2 um = cm.xy / cm.w * 0.5 + 0.5;
        float md = texture2D(tDepth, um).r;
        if (md < 1.0 && cm.w > lin(md)) b = m;
        else a = m;
      }
      vec4 cb = proj * viewMat * vec4(W + R * b, 1.0);
      vec2 ub = cb.xy / cb.w * 0.5 + 0.5;
      vec2 edge = smoothstep(vec2(0.0), vec2(0.07), ub) * (1.0 - smoothstep(vec2(0.93), vec2(1.0), ub));
      float fade = edge.x * edge.y * (1.0 - smoothstep(16.0, 26.0, b));
      // Rougher stone and longer bounces blur the image: pick from the blur pyramid by the cone width.
      float spread = clamp(rough * b * 2.2 + rough * 0.6, 0.0, outside ? 4.0 : 2.0);
      vec3 sharp = texture2D(tScene, ub).rgb;
      vec3 half_ = texture2D(tHalf, ub).rgb;
      vec3 quarter = texture2D(tQuarter, ub).rgb;
      vec3 col = spread < 1.0 ? mix(sharp, half_, spread) : mix(half_, quarter, min(spread - 1.0, 1.0));
      if (spread > 2.0) {
        // Beyond the pyramid: a few quarter-res taps stretched vertically (reflections streak along the view).
        vec2 o = quarterTexel * (spread - 1.0) * 1.5;
        vec3 w = texture2D(tQuarter, ub + vec2(o.x, o.y * 2.5)).rgb + texture2D(tQuarter, ub - vec2(o.x, o.y * 2.5)).rgb;
        w += texture2D(tQuarter, ub + vec2(-o.x, o.y * 1.2)).rgb + texture2D(tQuarter, ub + vec2(o.x, -o.y * 1.2)).rgb;
        col = mix(quarter, w * 0.25, min(spread - 2.0, 1.0));
      }
      // The bounce crosses fog the direct view never saw: far things fade out of the puddles.
      if (outside) col *= exp(-fogOut * b);
      col = min(col, vec3(60.0));
      float k = gloss * (0.3 + 0.7 * fres) * fade * strength;
      gl_FragColor = vec4(col * k, k);
      return;
    }
    tPrev = t;
  }
}
`;

const combineFrag = /* glsl */ `
#include <packing>
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tFog;
uniform sampler2D tView;
uniform sampler2D tSSR;
uniform sampler2D tHalf;
uniform sampler2D tQuarter;
uniform vec2 blurTexel;
uniform vec3 glow; // transmittance floor for bright far things, (unused), halo strength
uniform vec2 fogRes;
uniform vec2 res;
uniform float near;
uniform float far;
uniform float ca;
uniform float blur;
uniform float fogOn;
uniform float ssrOn;
uniform vec2 ssrTexel;
uniform float ao;
uniform float frame;
uniform mat4 projInv;
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
// surface's tangent plane (normals from depth derivatives). Grounds furniture, column bases and corners.
float occlusion(vec3 P, vec3 N) {
  float radius = 0.45;
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
  return clamp(1.0 - occ / 8.0 * 1.4, 0.0, 1.0);
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
  if (depth < 1.0 && ao > 0.0) {
    vec3 P = viewPosAt(vUv, depth);
    vec3 N = normalize(cross(dFdx(P), dFdy(P)));
    if (dot(N, P) > 0.0) N = -N;
    col *= mix(1.0, occlusion(P, N), ao);
  }
  if (ssrOn > 0.0) {
    // A small cross blur hides the stair-stepping of the half-res march; weights carry the hit mask along.
    vec2 st = ssrTexel * 1.5;
    vec4 r = texture2D(tSSR, vUv) * 2.0;
    r += texture2D(tSSR, vUv + vec2(st.x, 0.0));
    r += texture2D(tSSR, vUv - vec2(st.x, 0.0));
    r += texture2D(tSSR, vUv + vec2(0.0, st.y));
    r += texture2D(tSSR, vUv - vec2(0.0, st.y));
    r /= 6.0;
    // Colour is stored premultiplied by the weight (see the SSR pass), so the blur never pulls in black.
    col = col * (1.0 - clamp(r.a, 0.0, 1.0)) + r.rgb;
  }
  // Depth-aware upsample of the low-res haze.
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
    vec4 fs = texture2D(tFog, uv);
    // A low-res sample that saw further than this pixel (thin arms and transoms against the fog) is shortened to the
    // pixel's depth, assuming even fog along the ray: no bright fog dots over thin dark things.
    // (The haze marched at most 60 m, 45 m for the sky; view-z ratios equal distance ratios along one ray.)
    float sd = texture2D(tDepth, uv).r >= 1.0 ? 45.0 : min(sz, 60.0);
    float rz = min(dz, 60.0) / max(sd, 1e-3);
    if (rz < 0.98) {
      float tt = pow(max(fs.a, 1e-4), rz);
      fs.rgb *= (1.0 - tt) / max(1.0 - fs.a, 1e-4);
      fs.a = tt;
    }
    float w = bw / (0.02 + (rz < 0.98 ? 0.15 : 1.0) * abs(sz - dz) / max(dz, 0.5));
    sum += fs * w;
    wsum += w;
  }
  vec4 fog = mix(vec4(0.0, 0.0, 0.0, 1.0), sum / max(wsum, 1e-5), fogOn);
  // Thick fog smears what is behind it (multiple scattering): pixels well into the fog take the blurred scene, so
  // mid-distance leaf canopies soften instead of cutting crisp outlines into the windows behind them, and the blur
  // also glows additively in the fog in front of everything, which turns lit windows and lamps into haloes.
  float fogged = 1.0 - fog.a;
  vec3 wide = vec3(0.0);
  // A 12-tap Vogel disc on the quarter-res image, weighted towards the centre: round and soft, no rings.
  float wsumB = 0.0;
  // Tighter for the nearer towers, so their window grids survive; wider far away.
  vec2 blurR = blurTexel * mix(1.2, 2.8, smoothstep(30.0, 120.0, dz));
  for (int i = 0; i < 12; i++) {
    float fi = float(i) + 0.5;
    float rr = sqrt(fi / 12.0);
    float a = fi * 2.39996;
    float wb = 1.0 - 0.6 * rr;
    wide += texture2D(tQuarter, vUv + vec2(cos(a), sin(a)) * rr * blurR).rgb * wb;
    wsumB += wb;
  }
  wide /= wsumB;
  col = mix(col, wide, smoothstep(0.55, 0.95, fogged) * 0.7);
  // Bright far things (the city's lit windows, lamp heads) glow through fog that would swallow them: a transmittance
  // floor that only bright pixels reach, so dark towers stay lost in the murk. Never for the sky.
  // Gated by how fogged the pixel is (not by its own depth), so leaf cards and the windows seen between them get the
  // same floor: no speckle where near and far pixels alternate.
  float bright = smoothstep(0.4, 4.0, dot(col, vec3(0.2126, 0.7152, 0.0722)));
  float floorT = depth < 1.0 ? glow.x * bright * smoothstep(0.8, 0.97, fogged) * (1.0 - 0.4 * smoothstep(40.0, 140.0, dz)) : 0.0;
  // The halo: blurred light in the fog in front, mostly from the bright things.
  float wl = dot(wide, vec3(0.2126, 0.7152, 0.0722));
  fog.rgb += wide * glow.x * glow.z * fogged * smoothstep(0.2, 2.0, wl);
  col = col * max(fog.a, floorT) + fog.rgb;
  vec4 vm = texture2D(tView, vUv);
  col = col * (1.0 - vm.a) + vm.rgb;
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Box-ish 2x downsample (4 bilinear taps), for the reflection blur pyramid. */
const halveFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + texel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(0.5, -0.5)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(-0.5, 0.5)).rgb;
  c += texture2D(tSrc, vUv + texel * vec2(0.5, 0.5)).rgb;
  gl_FragColor = vec4(min(c * 0.25, vec3(60.0)), 1.0);
}
`;

/** Average log luminance over a center-weighted grid, adapted towards it over time (1x1 target, ping-pong). */
const lumFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tPrev;
uniform float adapt;
varying vec2 vUv;
void main() {
  float sum = 0.0;
  float wsum = 0.0;
  for (int j = 0; j < 9; j++) for (int i = 0; i < 16; i++) {
    vec2 uv = (vec2(float(i), float(j)) + 0.5) / vec2(16.0, 9.0);
    float w = 1.0 - 0.7 * smoothstep(0.1, 0.6, length((uv - 0.5) * vec2(1.6, 1.0)));
    vec3 c = texture2D(tSrc, uv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    sum += log(max(l, 1e-4)) * w;
    wsum += w;
  }
  float cur = sum / wsum;
  float prev = texture2D(tPrev, vec2(0.5)).r;
  gl_FragColor = vec4(mix(prev, cur, adapt), 0.0, 0.0, 1.0);
}
`;

const exposureGlsl = /* glsl */ `
uniform sampler2D tLum;
uniform vec3 expo; // key, min, max
uniform float exposure;
float autoExposure() {
  float avg = exp(texture2D(tLum, vec2(0.5)).r);
  return clamp(expo.x / max(avg, 1e-4), expo.y, expo.z) * exposure;
}
`;

const prefilterFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform vec2 threshold;
${exposureGlsl}
varying vec2 vUv;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 karis(vec3 c, inout float ws) { c = min(max(c, vec3(0.0)), vec3(300.0)); float w = 1.0 / (1.0 + lum(c)); ws += w; return c * w; }
void main() {
  float e = autoExposure();
  float ws = 0.0;
  vec3 c = karis(texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb * e, ws);
  c += karis(texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb * e, ws);
  c += karis(texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb * e, ws);
  c += karis(texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb * e, ws);
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
uniform float grain;
uniform vec3 tone; // cold shadows, sodium highlights, black lift
uniform vec2 res;
${exposureGlsl}
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
  vec3 col = texture2D(tSrc, vUv).rgb * autoExposure();
  col += texture2D(tBloom, vUv).rgb * bloom;
  // Night grade in exposed linear HDR before the tone curve: split toning, cold blue-grey shadows and sodium-orange
  // highlights, a little less saturation in the dark, and a faint cold floor so the murk never crushes to pure black.
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float shadowK = 1.0 - smoothstep(0.0, 0.35, l);
  float hiK = smoothstep(0.3, 2.0, l);
  col *= mix(vec3(1.0), vec3(0.86, 0.96, 1.14), shadowK * tone.x);
  col *= mix(vec3(1.0), vec3(1.1, 0.98, 0.84), hiK * tone.y);
  float sat = mix(mix(1.04, 0.85, shadowK), 0.35, max(hurt * 0.8, downed));
  col = max(mix(vec3(l), col, sat), 0.0);
  col += vec3(0.0035, 0.0045, 0.0065) * tone.z * (1.0 - smoothstep(0.0, 0.08, l));
  vec2 c = vUv - 0.5;
  float r = length(c * vec2(res.x / res.y, 1.0));
  float vig = smoothstep(0.4, 1.15, r);
  col *= 1.0 - vig * (0.42 + downed * 0.4);
  // Hurt: a red pulse closing in from the edges.
  float pulse = 0.65 + 0.35 * sin(time * (6.0 + hurt * 4.0));
  vec3 red = vec3(0.6, 0.0, 0.0);
  col = mix(col, col * vec3(1.0, 0.3, 0.25) + red * 0.05, clamp(vig * 2.4 * hurt * pulse + hit * smoothstep(0.2, 0.9, r) * 0.9, 0.0, 1.0));
  float hv = smoothstep(0.15, 0.95, r);
  col += vec3(0.25, 0.0, 0.01) * hv * hv * hurt * pulse;
  col *= 1.0 - downed * 0.4;
  col = acesFit(col);
  // Display-encoded into an 8-bit target: the AA pass works on what the eye sees, and adds the grain after.
  gl_FragColor = sRGBTransferOETF(vec4(max(col, 0.0), 1.0));
}
`;

// FXAA 3.11-style (quality-lite) on the graded, display-encoded image. MSAA alone leaves the brightest edges stepped
// (it resolves in linear HDR, where a lamp or lit window outweighs the dark fog next to it), and low has no MSAA.
// Then fine film grain (mostly in the mid-tones) and a triangular dither of one 8-bit step: the dark smooth fog
// gradients would band without it.
const aaFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform float time;
uniform float grain;
uniform float on; // the lab's A/B switch
varying vec2 vUv;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 fxaa() {
  vec3 cM = texture2D(tSrc, vUv).rgb;
  float lM = luma(cM);
  float lN = luma(texture2D(tSrc, vUv + vec2(0.0, texel.y)).rgb);
  float lS = luma(texture2D(tSrc, vUv - vec2(0.0, texel.y)).rgb);
  float lE = luma(texture2D(tSrc, vUv + vec2(texel.x, 0.0)).rgb);
  float lW = luma(texture2D(tSrc, vUv - vec2(texel.x, 0.0)).rgb);
  float mn = min(lM, min(min(lN, lS), min(lE, lW)));
  float mx = max(lM, max(max(lN, lS), max(lE, lW)));
  // A low floor: the night image is dark, and its edges are dark-on-darker.
  if (on < 0.5 || mx - mn < max(0.0156, mx * 0.1)) return cM;
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
  return (lB < mn || lB > mx) ? a : b;
}
void main() {
  // The grain goes on in linear, as it did before the AA pass existed; the dither in output space.
  vec3 col = sRGBTransferEOTF(vec4(fxaa(), 1.0)).rgb;
  float tl = luma(col);
  vec2 seed = gl_FragCoord.xy + fract(time * 13.7) * 1000.0;
  float g = h12(seed) - 0.5;
  col += g * grain * (0.35 + 0.65 * smoothstep(0.0, 0.12, tl)) * (1.0 - 0.7 * smoothstep(0.4, 1.0, tl));
  vec4 outC = sRGBTransferOETF(vec4(max(col, 0.0), 1.0));
  outC.rgb += (h12(seed + 17.3) + h12(seed + 41.9) - 1.0) / 255.0;
  gl_FragColor = outC;
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

/** Milliseconds per pass group, GPU-synced, filled when `pipeline.profile` is true (lab only: it stalls the GPU). */
export interface PassTimes {
  sun: number;
  world: number;
  viewmodel: number;
  haze: number;
  ssr: number;
  combine: number;
  bloomGrade: number;
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
  const halfRT = hdr(4, 4);
  const quarterRT = hdr(4, 4);
  const ssrRT = hdr(4, 4);
  const lumRTs = [hdr(1, 1), hdr(1, 1)];
  for (const r of lumRTs) r.texture.minFilter = r.texture.magFilter = THREE.NearestFilter;
  let lumCur = 0;
  let bloomRTs: THREE.WebGLRenderTarget[] = [];
  const makeBloom = () => {
    for (const r of bloomRTs) r.dispose();
    bloomRTs = Array.from({ length: spec.bloomLevels }, () => hdr(4, 4));
  };
  makeBloom();

  // Sun depth map, fitted to the building (the shafts only matter where people are) with a margin for the facade.
  const makeSunRT = (n: number) => {
    const t = new THREE.WebGLRenderTarget(n, n, { depthBuffer: true, stencilBuffer: false });
    t.depthTexture = new THREE.DepthTexture(n, n);
    t.depthTexture.type = THREE.UnsignedIntType;
    t.depthTexture.minFilter = t.depthTexture.magFilter = THREE.NearestFilter;
    return t;
  };
  let sunRT = makeSunRT(spec.sunMap);
  const ib = world.interior;
  const centre = new THREE.Vector3((ib.minX + ib.maxX) / 2, world.height / 2, (ib.minZ + ib.maxZ) / 2);
  const ext = Math.hypot(ib.maxX - ib.minX, ib.maxZ - ib.minZ, world.height) / 2 + 6;
  const sunCam = new THREE.OrthographicCamera(-ext, ext, ext, -ext, 1, 200);
  sunCam.layers.set(0);
  const sunMat = new THREE.Matrix4();
  const placeSun = () => {
    sunCam.position.copy(view.moonDir).normalize().multiplyScalar(90).add(centre);
    sunCam.lookAt(centre);
    sunCam.updateMatrixWorld();
    sunMat.multiplyMatrices(sunCam.projectionMatrix, sunCam.matrixWorldInverse);
  };
  placeSun();
  // Street-light depth maps: a perspective camera at each shaft lamp's head, along its cone. A depth pass of the lobby
  // costs about as much as a fifth of the world pass, so they are rendered round-robin at a fixed rate (the lamps
  // never move; only people and debris need the refresh, and the haze's temporal blend hides the steps).
  const shaftRTs: THREE.WebGLRenderTarget[] = [];
  const shaftCams = Array.from({ length: MAX_SHAFTS }, () => {
    const c = new THREE.PerspectiveCamera(90, 1, 0.45, 40);
    c.layers.set(0);
    return c;
  });
  const makeShaftRTs = () => {
    for (const r of shaftRTs) r.dispose();
    shaftRTs.length = 0;
    for (let i = 0; i < spec.shafts; i++) shaftRTs.push(makeSunRT(spec.shaftMap));
  };
  makeShaftRTs();
  let shaftNext = 0;
  let shaftDue = 0;
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

  const wext = view as Partial<WorldViewExt>;
  const arr3 = (n: number) => Array.from({ length: n }, () => new THREE.Vector3());
  const fogUniforms: Record<string, THREE.IUniform> = {
    tDepth: { value: null },
    tHistory: { value: null },
    tSun: { value: sunRT.depthTexture },
    tSL0: { value: sunRT.depthTexture },
    tSL1: { value: sunRT.depthTexture },
    tSL2: { value: sunRT.depthTexture },
    projInv: { value: new THREE.Matrix4() },
    viewInv: { value: new THREE.Matrix4() },
    prevViewProj: { value: new THREE.Matrix4() },
    sunMat: { value: sunMat },
    camPos: { value: new THREE.Vector3() },
    near: { value: 0.05 },
    far: { value: 300 },
    time: { value: 0 },
    frame: { value: 0 },
    res: { value: new THREE.Vector2() },
    history: { value: 0 },
    sunDir: { value: view.moonDir.clone() },
    sunColor: { value: new THREE.Color() },
    // Faint cold moonlight, if the world has any left.
    shaftTint: { value: new THREE.Color(0.8, 0.9, 1.0) },
    // Fog lit by nothing in particular: inside the dark lobby, and the night outside (a little sodium city glow in the
    // blue-grey), which is also the colour the far fog settles to.
    ambient: { value: new THREE.Color(0.0016, 0.0019, 0.0024) },
    ambientOut: { value: new THREE.Color(0.018, 0.021, 0.027) },
    interior: { value: new THREE.Vector4(ib.minX, ib.maxX, ib.minZ, ib.maxZ) },
    ceiling: { value: world.height },
    dust: { value: wext.dust ?? 1 },
    // lamps, flashlights, sun, density
    gain: { value: new THREE.Vector4(6, 0.6, 4, 1) },
    // outside density (1/m, ~5 m visibility), inside density, fog creep behind the glass (m), street-light gain
    night: { value: new THREE.Vector4(0.22, 0.036, 3.5, 0.08) },
    // The shafts in the thin lobby haze would be far fainter than the lamp-lit fog outside; lift them so the lobby
    // reads as lit by the street.
    inBoost: { value: 22 },
    dbg: { value: 0 },
    cookieOut: { value: 0.5 },
    cityGlow: { value: new THREE.Color(0.016, 0.014, 0.013) },
    slCount: { value: 0 },
    slShadows: { value: 0 },
    slShafts: { value: 0 },
    slPos: { value: arr3(MAX_STREET) },
    slDir: { value: arr3(MAX_STREET) },
    slColor: { value: arr3(MAX_STREET) },
    slCone: { value: arr3(MAX_STREET) },
    slMat: { value: Array.from({ length: MAX_SHAFTS }, () => new THREE.Matrix4()) },
    slClip: { value: Array.from({ length: MAX_SHAFTS }, () => new THREE.Vector2(0.45, 40)) },
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

  const ssrUniforms: Record<string, THREE.IUniform> = {
    tDepth: { value: null },
    tScene: { value: null },
    tHalf: { value: halfRT.texture },
    tQuarter: { value: quarterRT.texture },
    tFloorRough: { value: null },
    tYardRough: { value: null },
    hasRough: { value: 0 },
    yardMeters: { value: 4 },
    interior: { value: new THREE.Vector4(ib.minX, ib.maxX, ib.minZ, ib.maxZ) },
    fogOut: { value: 0.15 },
    quarterTexel: { value: new THREE.Vector2() },
    floorMeters: { value: 4 },
    floorRough: { value: 0.18 },
    strength: { value: 0.9 },
    near: { value: 0.05 },
    far: { value: 300 },
    camPos: { value: new THREE.Vector3() },
    projInv: { value: new THREE.Matrix4() },
    viewInv: { value: new THREE.Matrix4() },
    viewMat: { value: new THREE.Matrix4() },
    proj: { value: new THREE.Matrix4() },
  };
  const makeSsr = () => pass(ssrFrag.replace('${SSR_STEPS}', String(Math.max(1, spec.ssrSteps))), ssrUniforms);
  let ssrMat = makeSsr();
  const halve = pass(halveFrag, { tSrc: { value: null }, texel: { value: new THREE.Vector2() } });

  const combine = pass(combineFrag, {
    tScene: { value: null },
    tDepth: { value: null },
    tFog: { value: null },
    tView: { value: null },
    tSSR: { value: ssrRT.texture },
    tHalf: { value: halfRT.texture },
    tQuarter: { value: quarterRT.texture },
    glow: { value: new THREE.Vector3(0.05, 14, 0.5) },
    blurTexel: { value: new THREE.Vector2() },
    fogRes: { value: new THREE.Vector2() },
    near: { value: 0.05 },
    far: { value: 300 },
    ca: { value: 0.0012 },
    blur: { value: 0 },
    fogOn: { value: 1 },
    ssrOn: { value: 0 },
    ssrTexel: { value: new THREE.Vector2() },
    res: { value: new THREE.Vector2() },
    ao: { value: spec.ao },
    frame: { value: 0 },
    projInv: { value: new THREE.Matrix4() },
    proj: { value: new THREE.Matrix4() },
  });

  const expoUniforms = () => ({
    tLum: { value: lumRTs[0].texture },
    // key (target average luminance after exposure), min, max
    // Night: a low key and a tight max, so a dark view stays dark instead of being lifted to day.
    expo: { value: new THREE.Vector3(0.11, 0.2, 2.5) },
    exposure: { value: 1 },
  });
  const lum = pass(lumFrag, { tSrc: { value: combineRT.texture }, tPrev: { value: null }, adapt: { value: 1 } });
  const prefilter = pass(prefilterFrag, { tSrc: { value: combineRT.texture }, texel: { value: new THREE.Vector2() }, threshold: { value: new THREE.Vector2(0.7, 0.45) }, ...expoUniforms() });
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
    bloom: { value: 0.22 },
    time: { value: 0 },
    hurt: { value: 0 },
    hit: { value: 0 },
    downed: { value: 0 },
    grain: { value: 0.018 },
    tone: { value: new THREE.Vector3(1, 1, 1) },
    res: { value: new THREE.Vector2() },
    ...expoUniforms(),
  });
  // The lab tunes exposure on the final pass; the prefilter follows it.
  prefilter.uniforms.expo = final.uniforms.expo;
  prefilter.uniforms.exposure = final.uniforms.exposure;
  // 8-bit, display-encoded: what the AA pass smooths. The lab's grain slider (on the final pass) drives the AA pass.
  const ldrRT = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false });
  ldrRT.texture.generateMipmaps = false;
  const aa = pass(aaFrag, { tSrc: { value: ldrRT.texture }, texel: { value: new THREE.Vector2() }, time: final.uniforms.time, grain: final.uniforms.grain, on: { value: 1 } });

  const draw = (mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  };

  // Reflection environment from the world's env scene.
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
    ldrRT.setSize(w, h);
    aa.uniforms.texel.value.set(1 / w, 1 / h);
    halfRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    quarterRT.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    const sd = Math.max(1, spec.ssrDiv);
    ssrRT.setSize(Math.max(1, Math.round(w / sd)), Math.max(1, Math.round(h / sd)));
    combine.uniforms.ssrTexel.value.set(1 / ssrRT.width, 1 / ssrRT.height);
    combine.uniforms.blurTexel.value.set(1 / quarterRT.width, 1 / quarterRT.height);
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
  let sunDue = 0;
  let layerCheck = 0;
  let firstLum = true;
  const prevViewProj = new THREE.Matrix4();
  const viewProj = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  const hiddenScratch: THREE.Object3D[] = [];
  let fogCur = 0;

  // Depth from a light: glass and other transparent things, points, lines, sprites and `noMoonShadow` objects (sky,
  // lamp heads) are left out, so the light passes the glass but mullions, columns, people and furniture block it.
  const renderDepth = (target: THREE.WebGLRenderTarget, cam: THREE.Camera) => {
    hiddenScratch.length = 0;
    scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (o.userData.noMoonShadow || o.userData.noSunShadow || (m.material && (m.material as THREE.Material).transparent) || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite)
        hiddenScratch.push(o);
    });
    for (const o of hiddenScratch) o.visible = false;
    const bg = scene.background;
    scene.background = null;
    scene.overrideMaterial = depthOnly;
    renderer.setRenderTarget(target);
    renderer.clear(false, true, false);
    renderer.render(scene, cam);
    scene.overrideMaterial = null;
    scene.background = bg;
    for (const o of hiddenScratch) o.visible = true;
  };

  const renderSun = () => {
    placeSun();
    renderDepth(sunRT, sunCam);
  };
  const shaftLights = () => (wext.streetLights ?? []).filter((l) => l.shafts).slice(0, flags.shafts ? spec.shafts : 0);
  const placeShaft = (i: number, L: StreetLight) => {
    const c = shaftCams[i];
    // The cone plus a margin, so the shadow map covers every lit point.
    c.fov = Math.min(150, (Math.acos(L.cosOuter) * 2 * 180) / Math.PI + 8);
    c.far = L.range;
    c.position.copy(L.pos);
    c.lookAt(tmp.copy(L.pos).add(L.dir));
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    fogUniforms.slMat.value[i].multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    fogUniforms.slClip.value[i].set(c.near, c.far);
  };
  const baseIntensity = new WeakMap<THREE.SpotLight, number>();

  // Profiling (lab): GPU-synced pass timings.
  const gl = renderer.getContext();
  const times: PassTimes = { sun: 0, world: 0, viewmodel: 0, haze: 0, ssr: 0, combine: 0, bloomGrade: 0 };
  let tMark = 0;
  let profiling = false;
  const mark = (key: keyof PassTimes | null) => {
    if (!profiling) return;
    gl.finish();
    const now = performance.now();
    if (key) times[key] += (now - tMark - times[key]) * 0.1;
    tMark = now;
  };

  const sunGain = fogUniforms.gain.value.z as number;
  /** Lab switches for profiling: multiply the quality spec's effects. */
  const flags = { ssr: 1, ao: 1, glows: 1, shafts: 1 };
  const pipeline: Pipeline & {
    debug: Record<string, Record<string, THREE.IUniform>>;
    flags: typeof flags;
    profile: boolean;
    times: PassTimes;
  } = {
    debug: { fog: fogUniforms, ssr: ssrUniforms, combine: combine.uniforms, final: final.uniforms, aa: aa.uniforms },
    flags,
    get profile() {
      return profiling;
    },
    set profile(v: boolean) {
      profiling = v;
    },
    times,
    render(p: FrameParams) {
      fit();
      frame++;
      const autoClear = renderer.autoClear;
      const savedLayers = camera.layers.mask;
      mark(null);
      // Lights must reach both passes; new lights (muzzle flashes) are picked up every second. Lights marked
      // `userData.worldOnly` (flashlights right next to the gun) stay on the world layer.
      if (layerCheck-- <= 0) {
        layerCheck = 60;
        scene.traverse((o) => {
          if ((o as THREE.Light).isLight && o.userData.worldOnly !== true) o.layers.enableAll();
        });
      }
      // The old golden-hour sun is a dim moon at night: its shafts (and its depth pass) only run while it is bright.
      const sunOn = view.moon.intensity > 0.4;
      sunDue -= p.dt;
      if (sunOn && (sunDue <= 0 || frame < 3)) {
        sunDue = 1 / 20;
        renderSun();
      }
      const shafts = shaftLights();
      for (let i = 0; i < shafts.length; i++) placeShaft(i, shafts[i]);
      if (shafts.length) {
        shaftDue -= p.dt;
        if (frame < 3) for (let i = 0; i < shafts.length; i++) renderDepth(shaftRTs[i], shaftCams[i]);
        else if (shaftDue <= 0) {
          shaftDue = Math.max(0, shaftDue) + 1 / spec.shaftRate;
          renderDepth(shaftRTs[shaftNext % shafts.length], shaftCams[shaftNext % shafts.length]);
          shaftNext++;
        }
      }
      mark('sun');
      // World.
      camera.layers.set(0);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      mark('world');
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
      mark('viewmodel');

      // Haze uniforms.
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
      const sunI = view.moon.intensity;
      u.sunColor.value.copy(view.moon.color).multiplyScalar(sunI);
      u.sunDir.value.copy(view.moonDir).normalize();
      u.gain.value.z = sunOn ? sunGain : 0;
      u.dust.value = wext.dust ?? 1;
      const sl = (wext.streetLights ?? []).slice().sort((a, b) => Number(b.shafts) - Number(a.shafts)).slice(0, MAX_STREET);
      u.slCount.value = sl.length;
      u.slShadows.value = shafts.length;
      u.slShafts.value = sl.filter((l) => l.shafts).length;
      sl.forEach((L, i) => {
        let base = baseIntensity.get(L.light);
        if (base === undefined) baseIntensity.set(L.light, (base = L.light.intensity));
        u.slPos.value[i].copy(L.pos);
        u.slDir.value[i].copy(L.dir);
        u.slColor.value[i].set(L.color.r, L.color.g, L.color.b).multiplyScalar(base * L.level);
        u.slCone.value[i].set(L.cosOuter, L.cosInner, L.range);
      });
      for (let i = 0; i < MAX_SHAFTS; i++) u[`tSL${i}`].value = (shaftRTs[i] ?? sunRT).depthTexture;
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

      // Haze (ping-pong history).
      const cur = fogRTs[fogCur];
      const prev = fogRTs[1 - fogCur];
      fogCur = 1 - fogCur;
      u.tDepth.value = sceneRT.depthTexture;
      u.tHistory.value = prev.texture;
      u.tSun.value = sunRT.depthTexture;
      renderer.autoClear = false;
      draw(fogMat, cur);
      u.history.value = 0.8;
      mark('haze');

      // Floor reflections.
      // Blur pyramid: rough reflections and the fog's smear of far things.
      halve.uniforms.tSrc.value = sceneRT.texture;
      halve.uniforms.texel.value.set(1 / width, 1 / height);
      draw(halve, halfRT);
      halve.uniforms.tSrc.value = halfRT.texture;
      halve.uniforms.texel.value.set(1 / halfRT.width, 1 / halfRT.height);
      draw(halve, quarterRT);
      const ssrOn = spec.ssrDiv > 0 && flags.ssr > 0;
      if (ssrOn) {
        const s = ssrUniforms;
        s.tDepth.value = sceneRT.depthTexture;
        s.tScene.value = sceneRT.texture;
        s.near.value = camera.near;
        s.far.value = camera.far;
        s.camPos.value.copy(u.camPos.value);
        s.projInv.value.copy(camera.projectionMatrixInverse);
        s.viewInv.value.copy(camera.matrixWorld);
        s.viewMat.value.copy(camera.matrixWorldInverse);
        s.proj.value.copy(camera.projectionMatrix);
        if (wext.floorSet && wext.yardSet) {
          s.tFloorRough.value = wext.floorSet.orm;
          s.floorMeters.value = wext.floorSet.meters;
          s.tYardRough.value = wext.yardSet.orm;
          s.yardMeters.value = wext.yardSet.meters;
          s.hasRough.value = 1;
        } else s.hasRough.value = 0;
        s.fogOut.value = fogUniforms.night.value.x * 0.8;
        s.quarterTexel.value.set(1 / quarterRT.width, 1 / quarterRT.height);
        renderer.setClearColor(0x000000, 0);
        draw(ssrMat, ssrRT);
        renderer.setClearColor(0x000000, 1);
      }
      mark('ssr');

      // Combine.
      const c = combine.uniforms;
      c.tScene.value = sceneRT.texture;
      c.tDepth.value = sceneRT.depthTexture;
      c.tFog.value = cur.texture;
      c.tView.value = viewRT.texture;
      c.near.value = camera.near;
      c.far.value = camera.far;
      c.blur.value = p.downed ? 1 : p.hit * 0.25;
      c.ssrOn.value = ssrOn ? 1 : 0;
      c.ao.value = spec.ao * flags.ao;
      c.frame.value = frame % 64;
      c.projInv.value.copy(camera.projectionMatrixInverse);
      c.proj.value.copy(camera.projectionMatrix);
      c.ca.value = 0.0012 + p.hit * 0.008 + (p.downed ? 0.006 : 0);
      draw(combine, combineRT);
      mark('combine');

      // Exposure: adapt over ~0.7 s (instantly on the first frame).
      const lumSrc = lumRTs[lumCur];
      lumCur = 1 - lumCur;
      const lumDst = lumRTs[lumCur];
      lum.uniforms.tPrev.value = lumSrc.texture;
      lum.uniforms.adapt.value = firstLum ? 1 : 1 - Math.exp(-p.dt * 1.5);
      firstLum = false;
      draw(lum, lumDst);
      prefilter.uniforms.tLum.value = lumDst.texture;
      final.uniforms.tLum.value = lumDst.texture;

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
      draw(final, ldrRT);
      draw(aa, null);
      mark('bloomGrade');
      renderer.autoClear = autoClear;
    },
    puff(pos, radius, density, life, grow = 0.4) {
      if (puffs.length >= MAX_PUFFS) {
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
      sunRT.dispose();
      sunRT = makeSunRT(spec.sunMap);
      makeShaftRTs();
      fogMat.dispose();
      fogMat = makeFog();
      ssrMat.dispose();
      ssrMat = makeSsr();
      width = height = 0;
      sunDue = 0;
      // world.ts dropped its shadow maps for the new sizes: draw them again before anything samples them.
      renderer.shadowMap.needsUpdate = true;
    },
    dispose() {
      sceneRT.dispose();
      viewRT.dispose();
      combineRT.dispose();
      ldrRT.dispose();
      halfRT.dispose();
      quarterRT.dispose();
      ssrRT.dispose();
      for (const r of lumRTs) r.dispose();
      for (const f of fogRTs) f.dispose();
      for (const r of bloomRTs) r.dispose();
      sunRT.dispose();
      for (const r of shaftRTs) r.dispose();
      tri.dispose();
      depthOnly.dispose();
      for (const m of [fogMat, ssrMat, halve, combine, lum, prefilter, down, up, final, aa]) m.dispose();
      envRT?.dispose();
      pmrem.dispose();
      if (scene.environment === envRT?.texture) scene.environment = null;
    },
  };
  return pipeline;
};
