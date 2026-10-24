// Cel-shading kit for the comic-book look: a three-step light ramp for MeshToonMaterial, cached toon materials, and
// an ink material for inverted-hull outlines whose width stays roughly constant on screen at any distance.
//
// Same kit as play/frontend/src/engine/toon.ts (copied, projects never share code).
//
// Importing this module also patches three's built-in toon shader (every MeshToonMaterial, including ones built
// elsewhere with `toonRamp()`): shadows get a coloured floor and a cool hue shift instead of sinking to black, the
// deepest shade gets a faint screen-space halftone, and `toon()` materials get a rim band that keeps silhouettes
// readable against dark backgrounds. All of it is a handful of ALU ops per fragment, no extra textures or passes.

import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Outline colour: a warm near-black, like printed ink. */
export const INK = 0x16121c;

let ramp: THREE.DataTexture | null = null;
/** Three hard light bands: shadow, mid, lit. The shader adds a coloured floor under the shadow band. */
export function toonRamp(): THREE.DataTexture {
  if (!ramp) {
    ramp = new THREE.DataTexture(new Uint8Array([90, 180, 255]), 3, 1, THREE.RedFormat);
    ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
    ramp.generateMipmaps = false;
    ramp.needsUpdate = true;
  }
  return ramp;
}

// ---- toon shader look-dev -----------------------------------------------------------------------------------------
// Light amounts below are "times albedo" before tone mapping: with the Rockets lights a sunlit top face is ~1.3, a
// face in cast shadow ~0.5 and a face turned to the ground ~0.15, which is what made dark maps go black.

/** The shade where lit ends (0) and full shadow begins (1 at SHADE_LIT - SHADE_RANGE). */
const SHADE_LIT = 1.1;
const SHADE_RANGE = 0.8;
/** No face gets darker than this times its (lifted, re-saturated) albedo, so shadows stay coloured. */
const SHADOW_FLOOR = 0.46;
/** Multiplier at full shadow: a cool violet shift, like a printed shadow tint. Mean ~1 so it doesn't darken. */
const SHADOW_TINT = [0.9, 0.88, 1.2];
/** How much the shadow floor's colour is pushed in saturation (1 = unchanged). */
const SHADOW_SAT = 1.45;
/** Halftone: dot cell in device pixels and how much a dot darkens. 0 strength turns it off. */
const HALFTONE_CELL = 5.0;
const HALFTONE_STRENGTH = 0.14;
/** Rim band on `toon()` materials: where it starts (1 - N·V) and how much albedo it adds. */
const RIM_START = 0.6;
const RIM_STRENGTH = 0.45;

const glsl = (n: number) => n.toFixed(4);
const vec3 = (v: number[]) => `vec3( ${v.map(glsl).join(', ')} )`;

const TOON_SHADE = /* glsl */ `
	vec3 toonLit = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	float toonAlbedo = max( dot( diffuseColor.rgb, vec3( 0.3333 ) ), 0.004 );
	// 0 = fully lit, 1 = deep shadow (back faces, cast shadows, faces turned to the ground).
	float toonS = clamp( ( ${glsl(SHADE_LIT)} - dot( toonLit, vec3( 0.3333 ) ) / toonAlbedo ) * ${glsl(1 / SHADE_RANGE)}, 0.0, 1.0 );
	// Floor colour: albedo lifted toward its square root (dark paints gain most) and pushed in saturation.
	vec3 toonFloor = ( diffuseColor.rgb + sqrt( diffuseColor.rgb ) ) * ${glsl(SHADOW_FLOOR * 0.5)};
	toonFloor = max( mix( vec3( dot( toonFloor, vec3( 0.2126, 0.7152, 0.0722 ) ) ), toonFloor, ${glsl(SHADOW_SAT)} ), 0.0 );
	toonLit = max( toonLit, toonFloor ) * mix( vec3( 1.0 ), ${vec3(SHADOW_TINT)}, toonS );
	#if ${HALFTONE_STRENGTH > 0 ? 1 : 0}
		// Screen-space halftone on a 45 degree grid; dots grow with the shade and only appear in the darkest band.
		vec2 toonHp = gl_FragCoord.xy * ${glsl(1 / HALFTONE_CELL)};
		vec2 toonHq = fract( vec2( toonHp.x + toonHp.y, toonHp.x - toonHp.y ) ) - 0.5;
		toonLit *= 1.0 - ${glsl(HALFTONE_STRENGTH)} * step( dot( toonHq, toonHq ), toonS * 0.4 - 0.22 );
	#endif
	#ifdef TOON_RIM
		// A hard back-light band on grazing faces, strongest on the shadow side where silhouettes get lost.
		float toonRim = step( ${glsl(RIM_START)}, 1.0 - abs( dot( geometryNormal, geometryViewDir ) ) );
		toonLit += diffuseColor.rgb * ( toonRim * ${glsl(RIM_STRENGTH)} * ( 0.35 + 0.65 * toonS ) );
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

/** A cel-shaded surface in `color`, with a rim band for readable silhouettes (characters and props). */
export const toon = (color: number) =>
  cached(`t${color}`, () => {
    const m = new THREE.MeshToonMaterial({ color, gradientMap: toonRamp() });
    m.defines = { TOON_RIM: '' };
    return m;
  });

/** Unlit flat colour: lenses, lamps, flames. */
export const flat = (color: number) => cached(`f${color}`, () => new THREE.MeshBasicMaterial({ color }));

// ---- ink ----------------------------------------------------------------------------------------------------------

let inkVisible = true;
/** 2 / drawing-buffer height, shared by every ink material, for the one-pixel minimum line. */
const inkPx = { value: 2 / 720 };
const bufferSize = new THREE.Vector2();
/** projectionMatrix[1][1] at the default 82 degree vertical FOV: line widths are tuned there. */
const P11_REF = 1 / Math.tan((82 / 2) * THREE.MathUtils.DEG2RAD);

/**
 * Black back faces pushed out along smooth normals. The push is done in view space after instancing and the model
 * matrix, so it is the same on InstancedMesh and on non-uniformly scaled meshes. It grows with depth (and is FOV
 * corrected) so the line is a constant fraction of the screen height, never under one pixel; `minWorld` keeps
 * close-up outlines from vanishing.
 */
export function inkMaterial(perDepth = 0.0042, minWorld = 0.006, fog = true): THREE.MeshBasicMaterial {
  return cached(`ink${perDepth}:${minWorld}:${fog}`, () => {
    const m = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide, fog });
    m.visible = inkVisible;
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
        mvPosition.xyz += inkN * max( ${minWorld.toFixed(4)}, inkDepth * max( ${(perDepth * P11_REF).toFixed(5)}, inkPx ) / inkP11 );
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

/** Ink for crease lines (LineSegments over hard edges). */
export const inkLineMaterial = () =>
  cached('inkLine', () => {
    const m = new THREE.LineBasicMaterial({ color: INK });
    m.visible = inkVisible;
    return m;
  });

/** Shows or hides every ink material (hulls and crease lines), including ones created later. For graphics quality. */
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
