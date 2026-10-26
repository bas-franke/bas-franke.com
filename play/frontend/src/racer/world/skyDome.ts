// The sky dome: a camera-centred sphere drawn first, without depth, so it sits behind everything and never shows
// parallax. Gradient from the theme's zenith to its horizon colour, a band of the current fog colour at the horizon
// (so fully fogged terrain melts into the sky), a warm glow around the sun and an HDR sun disc for the bloom pass.
// The same shader in `env` mode paints a warm ground below the horizon for the PMREM reflection map.

import * as THREE from 'three';

export interface SkyColors {
  top: THREE.Color;
  horizon: THREE.Color;
  haze: THREE.Color;
  sun: THREE.Color;
  ground: THREE.Color;
}

const vertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform vec3 uGround;
uniform float uDisc;
uniform float uDiscCos;
uniform float uEnv;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float mu = dot(d, uSunDir);

  // The half of the sky facing the sun is warmer, and its horizon glow reaches higher.
  vec2 hd = normalize(d.xz + 1e-5);
  vec2 hs = normalize(uSunDir.xz + 1e-5);
  float side = 0.5 + 0.5 * dot(hd, hs);

  // Zenith-to-horizon gradient: the horizon colour holds through the lowest ~20 degrees (more on the sun side), then
  // turns to the zenith colour. Mixed in a gamma-ish space so violet-to-orange dusk skies pass through a saturated
  // pink-magenta (and blue-to-peach day skies through clean light blues), not grey.
  float t = pow(smoothstep(0.0, mix(0.55, 0.8, side * side), y), 0.8);
  vec3 col = mix(sqrt(uHorizon), sqrt(uTop), t);
  col *= col;
  col = mix(col, uHorizon * 1.08, side * side * 0.35 * (1.0 - t) * (1.0 - t));

  // Haze band hugging the horizon, in the fog colour.
  float band = exp(-max(y, 0.0) * 14.0);
  col = mix(col, uHaze, band * 0.85);

  // Below the horizon: haze for the visible sky, warm sand for reflections.
  float below = smoothstep(0.0, -0.08, y);
  col = mix(col, mix(uHaze, uGround, uEnv), below);

  // Sun glow: a wide warm halo plus a tight hot core, then the disc itself (HDR, for bloom).
  float m = max(mu, 0.0);
  col += uSun * (0.16 * pow(m, 5.0) + 0.4 * pow(m, 40.0) + 1.4 * pow(m, 1200.0)) * (1.0 - below * 0.8);
  float disc = smoothstep(uDiscCos - 0.00006, uDiscCos + 0.00003, mu);
  col += uSun * disc * uDisc;

  // Dither against banding in the long gradients.
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createSkyDomeMaterial(c: SkyColors, sunDir: THREE.Vector3, env: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: c.top },
      uHorizon: { value: c.horizon },
      uHaze: { value: c.haze },
      uSun: { value: c.sun },
      uSunDir: { value: sunDir },
      uGround: { value: c.ground },
      // Reflections get a dimmer disc so metal does not sparkle with fireflies.
      uDisc: { value: env ? 6 : 40 },
      uDiscCos: { value: Math.cos(THREE.MathUtils.degToRad(1.25)) },
      uEnv: { value: env ? 1 : 0 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
}

/** A dome mesh that recentres on whatever camera renders it. */
export function createSkyDome(material: THREE.ShaderMaterial, radius: number): THREE.Mesh {
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), material);
  dome.name = 'skyDome';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.matrixAutoUpdate = false;
  dome.onBeforeRender = (_r, _s, camera) => {
    dome.matrixWorld.makeTranslation(camera.matrixWorld.elements[12], camera.matrixWorld.elements[13], camera.matrixWorld.elements[14]);
    dome.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, dome.matrixWorld);
  };
  return dome;
}
