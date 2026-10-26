// Tall team banners: one InstancedMesh of a segmented cloth strip. The instance colour is the banner colour; the
// pale emblem (a ring round a flame-tipped trident after the concept art, glowing via the emissive term), a dark hem and a
// fringed bottom are drawn in the fragment shader, so no textures. The cloth ripples in the wind in the vertex shader,
// pinned at the top, swinging more towards the bottom.

import * as THREE from 'three';

export interface Banner {
  /** Top centre of the cloth (where it hangs from its crossbar). */
  top: THREE.Vector3;
  /** Horizontal unit normal of the cloth (the side the emblem faces). */
  facing: THREE.Vector3;
  width: number;
  height: number;
  color: THREE.Color;
}

export function buildBanners(banners: Banner[], emblem: THREE.Color, castShadow: boolean) {
  // Unit cloth: 1 wide, 1 tall, hanging from y = 0 down to y = -1, facing +z.
  const geo = new THREE.PlaneGeometry(1, 1, 3, 14);
  geo.translate(0, -0.5, 0);
  const uniforms = { uTime: { value: 0 }, uEmblem: { value: emblem.clone() } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: false, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.uniforms.uEmblem = uniforms.uEmblem;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        varying vec2 vBUv;
        varying vec2 vBSize;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        // beginnormal runs before begin_vertex: compute the ripple once here, displace and re-shade with it.
        vec3 bp = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float bph = fract(sin(dot(bp.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
        vBUv = uv;
        vBSize = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
        float hang = -position.y * vBSize.y;
        float k = pow(-position.y, 1.3);
        float amp = (0.7 + 0.3 * sin(uTime * 0.37 + bph)) * 0.05 * vBSize.y;
        float ph1 = uTime * 2.1 + bph - hang * 0.55;
        float ph2 = uTime * 3.3 + bph * 1.7 - hang * 0.9 + position.x * 3.0;
        float wave = (sin(ph1) + 0.45 * sin(ph2)) * amp * k;
        float slope = (cos(ph1) * 0.55 + 0.45 * cos(ph2) * 0.9) * amp * k;
        objectNormal = normalize(objectNormal + vec3(0.0, slope, 0.0));`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed.z += wave;
        transformed.x += sin(uTime * 0.9 + bph) * k * 0.04;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uEmblem;
        varying vec2 vBUv;
        varying vec2 vBSize;
        float bMark = 0.0;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Emblem space: units of a third of the width, centred in the upper middle of the cloth.
          vec2 p = vec2((vBUv.x - 0.5) * vBSize.x, (vBUv.y - 0.64) * vBSize.y) / (vBSize.x / 3.0);
          float aa = 0.05;
          float rl = length(p);
          float ring = 1.0 - smoothstep(0.11 - aa, 0.11 + aa, abs(rl - 1.0));
          // Trident: a shaft with a flame-shaped tip, two side prongs joined by a cup at the bottom.
          float shaft = (1.0 - smoothstep(0.08, 0.08 + aa, abs(p.x))) * step(-0.78, p.y) * step(p.y, 0.45);
          float tipW = 0.26 * clamp((0.85 - p.y) / 0.4, 0.0, 1.0) * clamp((p.y - 0.3) / 0.12, 0.0, 1.0);
          float tip = (1.0 - smoothstep(tipW - aa * 0.5, tipW + aa * 0.5, abs(p.x + 0.04 * sin(p.y * 9.0)))) * step(0.001, tipW);
          vec2 cq = p - vec2(0.0, -0.05);
          float cup = (1.0 - smoothstep(0.08, 0.08 + aa, abs(length(cq) - 0.46))) * step(cq.y, 0.0);
          float prongW = 0.08 * clamp((0.62 - p.y) / 0.25, 0.0, 1.0);
          float prong = (1.0 - smoothstep(prongW, prongW + aa, abs(abs(p.x) - 0.46 - max(0.0, p.y - 0.3) * 0.25))) * step(-0.05, p.y) * step(p.y, 0.62);
          float mark = max(max(ring, shaft), max(max(tip, cup), prong));
          float yb = vBUv.y * vBSize.y;
          vec3 c = diffuseColor.rgb;
          // Soft lighter halo round the emblem, as if it shone through the cloth.
          c = mix(c, c * 1.6 + uEmblem * 0.06, exp(-pow(max(rl - 1.0, 0.0) * 2.2, 2.0)) * 0.55);
          // Dark edging along the sides and the top, a pale stripe above the tasselled bottom.
          float edge = max(step(min(vBUv.x, 1.0 - vBUv.x) * vBSize.x, 0.14), step((1.0 - vBUv.y) * vBSize.y, 0.35));
          c = mix(c, c * 0.35, edge);
          float stripe = step(0.5, yb) * step(yb, 0.68);
          bMark = mark;
          c = mix(c, uEmblem, max(mark, stripe * 0.8));
          if (yb < 0.4 && fract(vBUv.x * vBSize.x * 2.5) > 0.6) discard;
          c *= 0.78 + 0.22 * vBUv.y;
          diffuseColor.rgb = c;
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // The emblem glows so it reads from far down the course and blooms like the concept art.
        totalEmissiveRadiance += uEmblem * bMark * 0.9;
        // A little light through the cloth keeps the purple rich in the shade instead of going black.
        totalEmissiveRadiance += diffuseColor.rgb * (1.0 - bMark) * 0.85;`,
      );
  };
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, banners.length));
  mesh.count = banners.length;
  const m = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);
  const x = new THREE.Vector3();
  const sc = new THREE.Vector3();
  banners.forEach((b, i) => {
    x.crossVectors(up, b.facing).normalize();
    m.makeBasis(x, up, b.facing).scale(sc.set(b.width, b.height, 1)).setPosition(b.top);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, b.color);
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
