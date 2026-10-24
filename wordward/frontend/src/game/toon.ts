// Material kit for the warm, painterly "enchanted library at dusk" look.
//
// `toon(color)` is a soft lit surface: MeshToonMaterial with a smooth (linearly filtered) wrap-light ramp, so light
// rolls off gently instead of in hard cel bands. Importing this module patches three's toon shader (every
// MeshToonMaterial, including ones built elsewhere with `toonRamp()`): shadows get a warm coloured floor instead of
// sinking to black, and `toon()` materials get a faint warm rim that keeps silhouettes readable. A handful of ALU ops
// per fragment, no extra textures or passes.
//
// Glow is faked with additive sprites rather than a bloom pass: `glowSprite()` for single lights (a moth, a muzzle),
// `glowBatch()` for many static lights in one draw call (lanterns), `emissive()` for the glowing surfaces themselves.
// Ink outlines from the old comic look still exist (`inkMaterial`, `hullGeometry`) but are hidden by default.

import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Outline colour: a warm dark brown, like sepia ink. */
export const INK = 0x2a1d17;

/** Ramp texels, sampled across half-Lambert (0 = facing away from the light, 1 = facing it). */
const RAMP_STEPS = 8;
let ramp: THREE.DataTexture | null = null;
/** A smooth wrap-light ramp (linear filtered, so the steps blend into a soft painted falloff). */
export function toonRamp(): THREE.DataTexture {
  if (!ramp) {
    const data = new Uint8Array(RAMP_STEPS);
    for (let i = 0; i < RAMP_STEPS; i++) {
      const c = (i + 0.5) / RAMP_STEPS;
      const t = THREE.MathUtils.smoothstep(c, 0.3, 0.9);
      data[i] = Math.round(255 * (0.16 + 0.84 * t));
    }
    ramp = new THREE.DataTexture(data, RAMP_STEPS, 1, THREE.RedFormat);
    ramp.minFilter = ramp.magFilter = THREE.LinearFilter;
    ramp.generateMipmaps = false;
    ramp.needsUpdate = true;
  }
  return ramp;
}

// ---- toon shader look-dev -----------------------------------------------------------------------------------------
// Light amounts below are "times albedo" before tone mapping.

/** The shade where lit ends (0) and full shadow begins (1 at SHADE_LIT - SHADE_RANGE). */
const SHADE_LIT = 1.0;
const SHADE_RANGE = 0.85;
/** No face gets darker than this times its albedo, so shadows stay coloured. */
const SHADOW_FLOOR = 0.3;
/** Multiplier at full shadow: a warm umber shift, like a glazed oil shadow. */
const SHADOW_TINT = [1.06, 0.9, 0.8];
/** How much the shadow floor's colour is pushed in saturation (1 = unchanged). */
const SHADOW_SAT = 1.2;
/** Rim on `toon()` materials: where it starts (1 - N·V), how strong, and its warm lamp colour. */
const RIM_START = 0.55;
const RIM_STRENGTH = 0.28;
const RIM_COLOR = [1.0, 0.78, 0.48];

const glsl = (n: number) => n.toFixed(4);
const vec3 = (v: number[]) => `vec3( ${v.map(glsl).join(', ')} )`;

const TOON_SHADE = /* glsl */ `
	vec3 toonLit = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	float toonAlbedo = max( dot( diffuseColor.rgb, vec3( 0.3333 ) ), 0.004 );
	// 0 = fully lit, 1 = deep shadow.
	float toonS = clamp( ( ${glsl(SHADE_LIT)} - dot( toonLit, vec3( 0.3333 ) ) / toonAlbedo ) * ${glsl(1 / SHADE_RANGE)}, 0.0, 1.0 );
	vec3 toonFloor = diffuseColor.rgb * ${glsl(SHADOW_FLOOR)};
	toonFloor = max( mix( vec3( dot( toonFloor, vec3( 0.2126, 0.7152, 0.0722 ) ) ), toonFloor, ${glsl(SHADOW_SAT)} ), 0.0 );
	toonLit = max( toonLit, toonFloor ) * mix( vec3( 1.0 ), ${vec3(SHADOW_TINT)}, toonS * toonS * ( 3.0 - 2.0 * toonS ) );
	#ifdef TOON_RIM
		// A soft warm back-light on grazing faces, a little stronger on the shadow side.
		float toonRim = smoothstep( ${glsl(RIM_START)}, 1.0, 1.0 - abs( dot( geometryNormal, geometryViewDir ) ) );
		toonLit += mix( diffuseColor.rgb, ${vec3(RIM_COLOR)}, 0.5 ) * ( toonRim * ${glsl(RIM_STRENGTH)} * ( 0.6 + 0.4 * toonS ) );
	#endif
	vec3 outgoingLight = toonLit + totalEmissiveRadiance;`;

const OUTGOING = 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;';
// Patched once, before any material compiles (this module is imported by everything that makes toon materials).
if (!THREE.ShaderLib.toon.fragmentShader.includes('toonFloor')) {
  if (!THREE.ShaderLib.toon.fragmentShader.includes(OUTGOING)) console.warn('toon: three toon shader changed; look-dev patch skipped');
  THREE.ShaderLib.toon.fragmentShader = THREE.ShaderLib.toon.fragmentShader.replace(OUTGOING, TOON_SHADE);
}

const materials = new Map<string, THREE.Material>();
function cached<M extends THREE.Material>(key: string, make: () => M): M {
  let m = materials.get(key) as M | undefined;
  if (!m) {
    m = make();
    materials.set(key, m);
  }
  return m;
}

/** A soft lit surface in `color` with a faint warm rim (characters and props). Cached: do not mutate it. */
export const toon = (color: number) =>
  cached(`t${color}`, () => {
    const m = new THREE.MeshToonMaterial({ color, gradientMap: toonRamp() });
    m.defines = { TOON_RIM: '' };
    return m;
  });

/**
 * The same soft lit surface, coloured per vertex (`color` attribute, linear RGB): for merged static props, so a whole
 * shelf of books in many colours is one draw call. `rim` adds the warm rim of `toon()`.
 */
export const vertexColorMaterial = (rim = false) =>
  cached(`v${rim}`, () => {
    const m = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: toonRamp() });
    if (rim) m.defines = { TOON_RIM: '' };
    return m;
  });

/** Unlit flat colour: lenses, details that should not shade. */
export const flat = (color: number) => cached(`f${color}`, () => new THREE.MeshBasicMaterial({ color }));

/**
 * A glowing surface: unlit, `intensity` times brighter than `color` before tone mapping, so lamp glass, candle
 * flames and runes read as light sources. Pair with a `glowSprite`/`glowBatch` halo for the bloom.
 */
export const emissive = (color: number, intensity = 1.8) =>
  cached(`e${color}:${intensity}`, () => {
    const m = new THREE.MeshBasicMaterial({ color });
    m.color.multiplyScalar(intensity);
    return m;
  });

// ---- glow ---------------------------------------------------------------------------------------------------------

let glowTex: THREE.CanvasTexture | null = null;
/** Shared 128 px radial gradient (white, soft exponential falloff with a brighter core), for additive halos. */
export function glowTexture(): THREE.CanvasTexture {
  if (!glowTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    for (let i = 0; i <= 10; i++) {
      const r = i / 10;
      const a = Math.exp(-r * r * 5.5) * (1 - r) + 0.35 * Math.exp(-r * r * 60);
      grad.addColorStop(r, `rgba(255,255,255,${Math.min(1, a).toFixed(3)})`);
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    glowTex = new THREE.CanvasTexture(c);
    glowTex.colorSpace = THREE.SRGBColorSpace;
  }
  return glowTex;
}

/** Additive halo material for `glowSprite`, cached per colour and opacity. Clone it to fade one sprite on its own. */
export const glowSpriteMaterial = (color: number, opacity = 1) =>
  cached(`g${color}:${opacity}`, () => {
    const m = new THREE.SpriteMaterial({ map: glowTexture(), color, opacity, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    m.fog = false;
    return m;
  });

/**
 * A camera-facing additive halo `size` world units across: a lantern's light, the moth's aura, a muzzle glow.
 * One draw call per sprite; for many static lights use `glowBatch`.
 */
export function glowSprite(color: number, size: number, opacity = 1): THREE.Sprite {
  const s = new THREE.Sprite(glowSpriteMaterial(color, opacity));
  s.scale.set(size, size, 1);
  s.renderOrder = 10;
  return s;
}

/** Seconds, shared by every glow batch for the flicker. */
const glowTime = { value: 0 };

export interface GlowItem {
  x: number;
  y: number;
  z: number;
  /** Diameter in world units. */
  size: number;
  color: number;
  /** Brightness multiplier (default 1). */
  intensity?: number;
}

/**
 * Many static additive halos in one draw call (camera-facing quads expanded in the vertex shader), e.g. every
 * lantern on a shelf wall. `flicker` (0..1) makes each halo breathe gently at its own phase, like candle light.
 * Add the returned mesh to the scene; positions are in the mesh's local space.
 */
export function glowBatch(items: GlowItem[], flicker = 0.12): THREE.Mesh {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const offset = new Float32Array(items.length * 4);
  const tint = new Float32Array(items.length * 3);
  const c = new THREE.Color();
  items.forEach((it, i) => {
    offset.set([it.x, it.y, it.z, it.size], i * 4);
    c.setHex(it.color).multiplyScalar(it.intensity ?? 1);
    tint.set([c.r, c.g, c.b], i * 3);
  });
  geo.setAttribute('glowOffset', new THREE.InstancedBufferAttribute(offset, 4));
  geo.setAttribute('glowTint', new THREE.InstancedBufferAttribute(tint, 3));
  geo.instanceCount = items.length;
  const mat = new THREE.ShaderMaterial({
    uniforms: { glowTime, flicker: { value: flicker } },
    vertexShader: /* glsl */ `
      attribute vec4 glowOffset;
      attribute vec3 glowTint;
      uniform float glowTime;
      uniform float flicker;
      varying vec2 vUv;
      varying vec3 vTint;
      void main() {
        vUv = position.xy * 2.0;
        float ph = dot( glowOffset.xyz, vec3( 1.7, 3.1, 2.3 ) );
        float f = 1.0 + flicker * ( 0.6 * sin( glowTime * 3.1 + ph ) + 0.4 * sin( glowTime * 7.3 + ph * 1.9 ) );
        vTint = glowTint * f;
        vec4 mv = modelViewMatrix * vec4( glowOffset.xyz, 1.0 );
        mv.xy += position.xy * glowOffset.w * ( 0.92 + 0.08 * f );
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vTint;
      void main() {
        float r2 = dot( vUv, vUv );
        if ( r2 >= 1.0 ) discard;
        float a = exp( -r2 * 5.5 ) * ( 1.0 - sqrt( r2 ) ) + 0.35 * exp( -r2 * 60.0 );
        gl_FragColor = vec4( vTint * a, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.onBeforeRender = () => {
    glowTime.value = performance.now() / 1000;
  };
  return mesh;
}

let blobTex: THREE.CanvasTexture | null = null;
const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
/**
 * A soft contact shadow: a dark radial blob lying on the floor (y = 0.02), `radius` world units, warm brown. Much
 * cheaper than shadow maps; add it under a creature's origin. Material cached per opacity.
 */
export function shadowBlob(radius: number, opacity = 0.5): THREE.Mesh {
  if (!blobTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.75)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    blobTex = new THREE.CanvasTexture(c);
  }
  const mat = cached(`blob${opacity}`, () => new THREE.MeshBasicMaterial({ color: 0x1a0f08, alphaMap: blobTex!, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const m = new THREE.Mesh(blobGeo, mat);
  m.scale.set(radius * 2, 1, radius * 2);
  m.position.y = 0.02;
  m.renderOrder = 1;
  return m;
}

// ---- ink (legacy outlines, hidden by default) ---------------------------------------------------------------------

let inkVisible = false;
/** 2 / drawing-buffer height, shared by every ink material, for the one-pixel minimum line. */
const inkPx = { value: 2 / 720 };
const bufferSize = new THREE.Vector2();
/** projectionMatrix[1][1] at the default 82 degree vertical FOV: line widths are tuned there. */
const P11_REF = 1 / Math.tan((82 / 2) * THREE.MathUtils.DEG2RAD);
/** The painterly look wants hairlines at most: every ink width is scaled by this. */
const INK_SCALE = 0.4;

/**
 * Dark back faces pushed out along smooth normals (inverted-hull outline), constant-ish on screen. Hidden unless
 * `setInkVisible(true)`; the meshes cost nothing while hidden (three skips invisible materials).
 */
export function inkMaterial(perDepth = 0.0042, minWorld = 0.006, fog = true): THREE.MeshBasicMaterial {
  return cached(`ink${perDepth}:${minWorld}:${fog}`, () => {
    const m = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide, fog, transparent: true, opacity: 0.55, depthWrite: false });
    m.visible = inkVisible;
    const pd = perDepth * INK_SCALE;
    const mw = minWorld * INK_SCALE;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.inkPx = inkPx;
      shader.vertexShader = shader.vertexShader.replace('void main() {', 'uniform float inkPx;\nvoid main() {').replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec3 inkN = normal;
        #ifdef USE_INSTANCING
          mat3 inkIm = mat3( instanceMatrix );
          inkN = inkIm * ( inkN / vec3( dot( inkIm[ 0 ], inkIm[ 0 ] ), dot( inkIm[ 1 ], inkIm[ 1 ] ), dot( inkIm[ 2 ], inkIm[ 2 ] ) ) );
        #endif
        inkN = normalize( normalMatrix * inkN );
        float inkDepth = max( -mvPosition.z, 0.0 );
        float inkP11 = projectionMatrix[ 1 ][ 1 ];
        mvPosition.xyz += inkN * max( ${mw.toFixed(5)}, inkDepth * max( ${(pd * P11_REF).toFixed(5)}, inkPx * 0.5 ) / inkP11 );
        gl_Position = projectionMatrix * mvPosition;`,
      );
    };
    m.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(bufferSize);
      if (bufferSize.y > 0) inkPx.value = 2 / bufferSize.y;
    };
    m.customProgramCacheKey = () => `ink${perDepth}:${minWorld}`;
    return m;
  });
}

/** Ink for crease lines (LineSegments over hard edges). Hidden with the rest of the ink. */
export const inkLineMaterial = () =>
  cached('inkLine', () => {
    const m = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.4 });
    m.visible = inkVisible;
    return m;
  });

/** Shows or hides every ink material (hulls and crease lines), including ones created later. Off by default. */
export function setInkVisible(visible: boolean) {
  inkVisible = visible;
  for (const [key, m] of materials) if (key.startsWith('ink')) m.visible = visible;
}

/** A copy of `geo` with welded vertices and smooth normals, so its hull has no cracks at hard edges. */
export function hullGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.clone();
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  const welded = mergeVertices(g, 1e-4);
  g.dispose();
  welded.computeVertexNormals();
  return welded;
}
