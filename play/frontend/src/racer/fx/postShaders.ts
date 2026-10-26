// GLSL for the post chain in post.ts. Every pass draws one full-screen triangle; `vUv` is the 0..1 screen position.
// The scene is rendered linear HDR (no tone mapping); only the composite pass applies ACES and the sRGB encoding, via
// the renderer's own `toneMapping()` and `linearToOutputTexel()` that three injects into every ShaderMaterial.

export const fullscreenVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** HDR scene -> first bloom level: 4 bilinear taps (a 4x4 box), Karis-weighted against fireflies, soft threshold. */
export const prefilterFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform vec3 threshold; // x threshold, y knee, z clamp
varying vec2 vUv;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Other modules' additive effects can overflow half floats (Inf) or produce NaN; keep them out of the blur chain.
vec3 karis(vec3 c, inout float wsum) { c = min(max(c, vec3(0.0)), vec3(500.0)); float w = 1.0 / (1.0 + lum(c)); wsum += w; return c * w; }

void main() {
  float wsum = 0.0;
  vec3 c = karis(texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb, wsum);
  c += karis(texture2D(tSrc, vUv + texel * vec2(1.0, -1.0)).rgb, wsum);
  c += karis(texture2D(tSrc, vUv + texel * vec2(-1.0, 1.0)).rgb, wsum);
  c += karis(texture2D(tSrc, vUv + texel * vec2(1.0, 1.0)).rgb, wsum);
  c /= wsum;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - threshold.x + threshold.y, 0.0, 2.0 * threshold.y);
  soft = soft * soft / (4.0 * threshold.y + 1e-4);
  float k = max(soft, br - threshold.x) / max(br, 1e-4);
  gl_FragColor = vec4(min(c * k, vec3(threshold.z)), 1.0);
}
`;

/** Dual-filter (Kawase) downsample: centre + 4 diagonal taps one source texel out. */
export const downFrag = /* glsl */ `
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

/** Dual-filter upsample (tent), added onto the level below with additive blending. */
export const upFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform float weight;
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
  gl_FragColor = vec4(c * (weight / 12.0), 1.0);
}
`;

/**
 * Screen-space light shafts at low resolution: march from each pixel towards the sun, summing the bright sky near the
 * sun. Rock and pods in between are dark, so they cut the shafts. Output in .r.
 */
export const shaftsFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 sunUv;
uniform float aspect;
uniform float threshold;
varying vec2 vUv;
#define STEPS 20

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec2 d = sunUv - vUv;
  float acc = 0.0;
  float decay = 1.0;
  for (int i = 0; i < STEPS; i++) {
    float t = (float(i) + 0.5) / float(STEPS);
    vec2 p = vUv + d * t;
    vec2 sd = (p - sunUv) * vec2(aspect, 1.0);
    // Only the sky close to the sun lights the shafts.
    float near = exp(-dot(sd, sd) * 9.0);
    // Clamped: the HDR sun disc (~60) would otherwise drown everything.
    acc += clamp(lum(texture2D(tSrc, p).rgb) - threshold, 0.0, 1.0) * near * decay;
    decay *= 0.94;
  }
  gl_FragColor = vec4(acc / float(STEPS), 0.0, 0.0, 1.0);
}
`;

/**
 * Sun visibility, one pixel: how much of a small cross around the sun is bright sky rather than rock or pods. Drawn
 * with alpha blending onto last frame's value, so it eases in and out instead of flickering behind thin spires.
 */
export const sunVisFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 sunUv;
uniform float rate;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float sky(vec2 o) { return smoothstep(0.3, 0.8, min(lum(texture2D(tSrc, sunUv + o).rgb), 2.0)); }
void main() {
  vec2 a = vec2(0.012, 0.0);
  vec2 b = vec2(0.0, 0.02);
  float v = sky(vec2(0.0)) * 2.0 + sky(a) + sky(-a) + sky(b) + sky(-b) + sky(a * 2.5) + sky(-a * 2.5) + sky(b * 2.5) + sky(-b * 2.5);
  gl_FragColor = vec4(v / 10.0, 0.0, 0.0, rate);
}
`;

/**
 * Final pass: zoom motion blur (+ chromatic aberration on boost) of the HDR scene, bloom, sun glow / shafts / veil,
 * colour grade, ACES (once), vignette, sRGB, dither.
 * Defines: TAPS (blur samples), SHAFTS (0/1).
 */
export const compositeFrag = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tShafts;
uniform sampler2D tSunVis;
uniform vec2 res;
uniform float aspect;
uniform vec2 focus;
uniform float blur;      // fraction of the distance to the focus smeared at full mask
uniform float ca;        // chromatic aberration, fraction of the distance to the focus
uniform vec4 podMask;    // xy centre (uv), zw radii (uv): the player's pod stays sharp
uniform float bloomStrength;
uniform vec2 sunUv;
uniform float sunOn;     // 0..1, sun in front of the camera and near the screen
uniform vec3 sunColor;
uniform float shaftStrength;
uniform float veilStrength;
uniform vec3 hazeColor;
uniform float saturation;
uniform vec3 whiteBalance;
uniform vec3 lift;
uniform vec3 highTint;   // multiplies the highlights (warm: pushes pink-white sky and lit rock towards peach-gold)
uniform float contrast;
uniform float hueKeep;
uniform float vignette;
uniform float noiseSeed;
varying vec2 vUv;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Sanitised scene read: NaN / Inf / negatives from other modules' blending must not smear along the blur.
vec4 S(vec2 p) { return min(max(texture2D(tScene, p), vec4(0.0)), vec4(500.0)); }

void main() {
  vec2 uv = vUv;
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)) + noiseSeed));

  // --- Zoom blur towards the focus point: nothing in the centre, most at the bottom and the edges.
  vec2 d = uv - focus;
  float r = length(d * vec2(aspect, 1.0));
  // Grows towards the frame edges, where the streaks in the concept art are strongest.
  float mask = smoothstep(0.4, 1.0, r) * (1.0 + 0.5 * smoothstep(0.7, 1.1, r));
  mask *= mix(0.45, 1.0, smoothstep(0.3, 0.0, d.y));       // the sky above the focus smears less...
  mask *= 1.0 + 0.4 * smoothstep(0.0, -0.45, d.y);        // ...and the ground below it more
  vec2 pe = (uv - podMask.xy) / podMask.zw;
  mask *= smoothstep(0.75, 1.35, length(pe));             // keep the player's pod crisp
  float amount = blur * mask;
  vec3 col;
  if (amount * length(d * res) > 1.0) {
    vec2 stp = -d * amount / float(TAPS);
    vec2 p = uv + stp * ign;
    col = vec3(0.0);
    if (ca > 0.0) {
      // Three reads per tap, so half the taps at twice the stride (boost is brief and smeared anyway).
      vec2 co = d * ca * mask;
      stp *= 2.0;
      for (int i = 0; i < TAPS / 2; i++) {
        col.r += S(p + co).r;
        col.g += S(p).g;
        col.b += S(p - co).b;
        p += stp;
      }
      col *= 2.0;
    } else {
      for (int i = 0; i < TAPS; i++) {
        col += S(p).rgb;
        p += stp;
      }
    }
    col /= float(TAPS);
  } else {
    col = S(uv).rgb;
  }

  // --- Bloom.
  col += texture2D(tBloom, uv).rgb * bloomStrength;

  // --- Sun: lens glow and a wide warm veil from the sun side, both dimmed when rock covers the sun; light shafts.
  if (sunOn > 0.0) {
    vec2 sd = (uv - sunUv) * vec2(aspect, 1.0);
    float dist = length(sd);
    float vis = sunOn * texture2D(tSunVis, vec2(0.5)).r;
    float glow = exp(-dist * 7.0) * 0.25 + exp(-dist * 2.2) * 0.05;
    float veil = exp(-dist * 0.9) * veilStrength;
    col += sunColor * glow * vis;
    col = mix(col, hazeColor * 1.1, veil * sunOn * (0.4 + 0.6 * vis));
#if SHAFTS
    col += sunColor * texture2D(tShafts, uv).r * shaftStrength * sunOn;
#endif
  }

  // --- Grade in linear HDR: warm white balance, richer colour.
  col *= whiteBalance;
  float l = lum(col);
  col = max(mix(vec3(l), col, saturation), 0.0);

#ifdef TONE_MAPPING
  // ACES per channel bleaches bright emissives (orange pads, blue engines) to white. For hot pixels, blend towards a
  // hue-preserving version (the curve applied to the max channel, then scaled) so glows keep their colour.
  float peak = max(col.r, max(col.g, col.b));
  vec3 aces = toneMapping(col);
  if (peak > 1.0) {
    vec3 keep = col * (toneMapping(vec3(peak)).g / peak);
    aces = mix(aces, keep, hueKeep * smoothstep(1.0, 6.0, peak));
  }
  col = aces;
#endif

  // --- Display-referred grade: filmic contrast around mid grey, warm highlights, shadows lifted towards violet,
  // light vignette.
  vec3 g = pow(col, vec3(1.0 / 2.2));
  g = clamp((g - 0.5) * contrast + 0.5, 0.0, 1.0);
  g = mix(g, g * g * (3.0 - 2.0 * g), 0.25);
  // Split tone: warm highlights against the violet-lifted shadows below.
  g = mix(g, g * highTint, smoothstep(0.35, 0.95, dot(g, vec3(0.2126, 0.7152, 0.0722))));
  col = pow(g, vec3(2.2));
  col += lift * pow(1.0 - min(col, 1.0), vec3(3.0));
  vec2 vq = (vUv - 0.5) * vec2(aspect, 1.0) / sqrt(aspect * aspect + 1.0) * 2.0;
  col *= 1.0 - vignette * smoothstep(0.35, 1.05, dot(vq, vq));

  gl_FragColor = linearToOutputTexel(vec4(col, 1.0));
  gl_FragColor.rgb += (ign - 0.5) / 255.0;
}
`;
