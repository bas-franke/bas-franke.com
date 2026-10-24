// The crowd: one InstancedMesh of tiny low-poly spectators. Each instance gets a shirt colour; legs and skin
// colours are baked into the geometry and kept out of the instance tint. A vertex shader makes them bob, hop and
// throw their arms up, livelier the closer the player's pod is, each with its own rhythm hashed from its position.

import * as THREE from 'three';
import { GeoBuilder } from './standGeom';

export interface Spectator {
  pos: THREE.Vector3;
  /** Horizontal unit direction the spectator faces (towards the road). */
  facing: THREE.Vector3;
  scale: number;
  /** 0..1, picks the shirt colour. */
  tint: number;
}

// Mostly muted and dark with a few bright team colours, so the crowd reads as a crowd rather than confetti.
const SHIRTS = ['#b8392e', '#2d58a8', '#d9a92c', '#e8e0d0', '#2f6f5e', '#a8582a', '#3a3440', '#2a2c33', '#5a4a40', '#8a8f96', '#d8c8a8', '#3d4a66', '#6b2e2a', '#41383a'];

/** One spectator, ~1.75 m tall, origin at the feet, facing +z. aArm: -1 left arm, 1 right arm, 0 elsewhere. */
function personGeometry(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const X = new THREE.Vector3(1, 0, 0);
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  const pants = new THREE.Color('#3a3330');
  const shirt = new THREE.Color(1, 1, 1);
  const skin = new THREE.Color('#c58c64');
  // Fixed-colour flag per vertex: 1 = keep the baked colour, 0 = take the shirt colour.
  const fixed: number[] = [];
  const arm: number[] = [];
  const mark = (from: number, f: number, a: number) => {
    for (let i = from; i < g.vertexCount; i++) {
      fixed.push(f);
      arm.push(a);
    }
  };
  let n = 0;
  g.box(new THREE.Vector3(0, 0.45, 0), X, Y, Z, 0.17, 0.45, 0.11, pants, true);
  mark(n, 1, 0);
  n = g.vertexCount;
  g.box(new THREE.Vector3(0, 1.17, 0), X, Y, Z, 0.21, 0.29, 0.13, shirt, true);
  mark(n, 0, 0);
  n = g.vertexCount;
  g.box(new THREE.Vector3(0, 1.6, 0.01), X, Y, Z, 0.11, 0.13, 0.11, skin, true);
  mark(n, 1, 0);
  for (const side of [-1, 1]) {
    n = g.vertexCount;
    // Arm in the shirt colour, hanging from the shoulder at (±0.27, 1.4). No hands or hair: ~56 triangles a person.
    g.box(new THREE.Vector3(side * 0.27, 1.1, 0), X, Y, Z, 0.06, 0.3, 0.06, shirt);
    mark(n, 0, side);
  }
  const geo = g.build();
  geo.setAttribute('aFixed', new THREE.Float32BufferAttribute(fixed, 1));
  geo.setAttribute('aArm', new THREE.Float32BufferAttribute(arm, 1));
  return geo;
}

export function buildCrowd(people: Spectator[], castShadow: boolean) {
  const geo = personGeometry();
  const uniforms = { uTime: { value: 0 }, uPlayer: { value: new THREE.Vector3(1e6, 0, 0) } };
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.uniforms.uPlayer = uniforms.uPlayer;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform vec3 uPlayer;
        attribute float aFixed;
        attribute float aArm;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 iw = (modelMatrix * vec4(ip, 1.0)).xyz;
        // Excitement: a murmur everywhere, a roar as the player flies past.
        float ex = 0.2 + 0.8 * smoothstep(260.0, 40.0, distance(iw, uPlayer));
        float rate = 4.0 + ph * 4.0;
        float beat = sin(uTime * rate + ph * 6.2832);
        // Arms swing up around the shoulder; some people keep them up longer (the cheering ones).
        float raise = clamp((0.5 + 0.5 * beat) * ex * (0.6 + ph) + (ph > 0.7 ? ex * 0.6 : 0.0), 0.0, 1.0) * 2.6;
        if (aArm != 0.0) {
          vec2 piv = vec2(aArm * 0.27, 1.4);
          vec2 r = transformed.xy - piv;
          float a = aArm * raise;
          transformed.xy = piv + vec2(r.x * cos(a) - r.y * sin(a), r.x * sin(a) + r.y * cos(a));
        }
        transformed.y += max(0.0, beat) * 0.22 * ex * step(0.35, ph);
        transformed.x += sin(uTime * 1.3 + ph * 20.0) * 0.05 * transformed.y;`,
      )
      .replace(
        '#include <color_vertex>',
        `// color_vertex runs before begin_vertex: derive the per-instance hash here and reuse it below.
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float ph = fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453);
        #include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
        vColor.xyz = mix(vColor.xyz, color.xyz * (0.65 + 0.6 * fract(ph * 7.31)), aFixed);
        #endif`,
      );
  };
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, people.length));
  mesh.count = people.length;
  const m = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);
  const x = new THREE.Vector3();
  const c = new THREE.Color();
  const shirts = SHIRTS.map((s) => new THREE.Color(s));
  people.forEach((p, i) => {
    x.crossVectors(up, p.facing).normalize();
    m.makeBasis(x, up, p.facing).scale(new THREE.Vector3(p.scale, p.scale, p.scale)).setPosition(p.pos);
    mesh.setMatrixAt(i, m);
    c.copy(shirts[Math.floor(p.tint * shirts.length) % shirts.length]);
    mesh.setColorAt(i, c);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return {
    mesh,
    uniforms,
    dispose() {
      geo.dispose();
      mat.dispose();
      mesh.dispose();
    },
  };
}
