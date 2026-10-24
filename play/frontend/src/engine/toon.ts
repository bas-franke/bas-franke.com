// Cel-shading kit for the comic-book look: a three-step light ramp for MeshToonMaterial, cached toon materials, and
// an ink material for inverted-hull outlines whose width stays roughly constant on screen at any distance.

import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Outline colour: a warm near-black, like printed ink. */
export const INK = 0x16121c;

let ramp: THREE.DataTexture | null = null;
/** Three hard light bands: shadow, mid, lit. */
export function toonRamp(): THREE.DataTexture {
  if (!ramp) {
    ramp = new THREE.DataTexture(new Uint8Array([95, 185, 255]), 3, 1, THREE.RedFormat);
    ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
    ramp.generateMipmaps = false;
    ramp.needsUpdate = true;
  }
  return ramp;
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

/** A cel-shaded surface in `color`. */
export const toon = (color: number) => cached(`t${color}`, () => new THREE.MeshToonMaterial({ color, gradientMap: toonRamp() }));

/** Unlit flat colour: lenses, lamps, flames. */
export const flat = (color: number) => cached(`f${color}`, () => new THREE.MeshBasicMaterial({ color }));

/**
 * Black back faces pushed out along smooth normals. The push grows with view depth so far objects keep a visible
 * line; `minWorld` keeps close-up outlines from vanishing.
 */
export function inkMaterial(perDepth = 0.0042, minWorld = 0.006, fog = true): THREE.MeshBasicMaterial {
  return cached(`ink${perDepth}:${minWorld}:${fog}`, () => {
    const m = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide, fog });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 inkView = modelViewMatrix * vec4( position, 1.0 );
        transformed += normalize( normal ) * max( ${minWorld.toFixed(4)}, -inkView.z * ${perDepth.toFixed(5)} );`,
      );
    };
    m.customProgramCacheKey = () => `ink${perDepth}:${minWorld}`;
    return m;
  });
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
