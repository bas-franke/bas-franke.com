// Sky, sun, clouds, fog and all scene lighting.
// - Sky dome (skyDome.ts) and painterly cumulus billboards (skyClouds.ts), both camera-centred and drawn first.
// - FogExp2 tuned from Theme.hazeDistance for strong aerial perspective: near rock stays saturated, mid-distance
//   rock fades to the peach/lavender haze. Its colour warms when the camera looks towards the sun, and the sky's
//   horizon band always uses the current fog colour so fully fogged terrain blends into the sky.
// - A warm directional sun whose shadow camera follows the player with texel snapping (no shimmer), a hemisphere
//   light (sky blue above, warm sand below) and a weak bounce light from the canyon walls opposite the sun, so
//   shadowed rock reads red-brown/violet, never black.
// - scene.environment: a small PMREM of the sky over warm ground, for reflections on metal.

import * as THREE from 'three';
import type { Theme } from '../core/tracks';
import { createClouds } from './skyClouds';
import { createSkyDomeMaterial, createSkyDome } from './skyDome';
import { hexOnScreen, onScreen } from './skyTone';
import type { WorldBuilder } from './types';

/** Unit vector towards the sun for a theme (azimuth 0 = +z, clockwise from above). */
export function sunDirection(theme: Theme, out = new THREE.Vector3()): THREE.Vector3 {
  const ce = Math.cos(theme.sunElevation);
  return out.set(Math.sin(theme.sunAzimuth) * ce, Math.sin(theme.sunElevation), Math.cos(theme.sunAzimuth) * ce).normalize();
}

const SHADOW = {
  high: { size: 2048, half: 95 },
  medium: { size: 1024, half: 80 },
  low: { size: 0, half: 0 },
} as const;

export const buildSky: WorldBuilder = (ctx) => {
  const { theme, scene, renderer, quality } = ctx;
  const group = new THREE.Group();
  group.name = 'sky';
  const sunDir = sunDirection(theme);
  const elev = Math.max(0.02, theme.sunElevation);
  // 0 at the horizon, 1 with the sun high.
  const day = THREE.MathUtils.smoothstep(elev, 0.05, 0.6);

  // Sky colours are chosen as they should appear on screen and inverted through the tone curve (skyTone.ts).
  const C = (hex: string) => new THREE.Color(hex);
  const top = hexOnScreen(theme.skyTop, renderer);
  const horizon = hexOnScreen(theme.skyHorizon, renderer);
  const sunCol = C(theme.sunColor);
  // Aerial-perspective colour: the theme haze cooled slightly towards the horizon sky (peach -> lavender-peach).
  const hazeScreen = C(theme.haze).lerp(C(theme.skyHorizon), 0.25);
  const hazeBase = onScreen(hazeScreen, renderer);
  // Looking into the sun the haze glows warmer and brighter.
  const hazeSun = onScreen(hazeScreen.clone().lerp(C(theme.sunColor), 0.45), renderer, 1.5);
  const haze = hazeBase.clone();
  const ground = C(theme.sand).multiply(sunCol).multiplyScalar(0.55);

  // Sky dome.
  const domeColors = { top, horizon, haze, sun: sunCol.clone().multiplyScalar(2), ground };
  const domeMat = createSkyDomeMaterial(domeColors, sunDir, false);
  const dome = createSkyDome(domeMat, 1000);
  group.add(dome);

  // Clouds: lit tops in sunlight (gold at dusk), undersides a lavender mixed from the sky (pink-lavender under a
  // violet dusk sky, blue-grey under a blue one).
  const cloudLit = onScreen(C('#fffaf2').lerp(sunCol, 0.45 + 0.5 * (1 - day)), renderer, 2.6);
  const cloudShade = onScreen(C(theme.skyTop).lerp(C(theme.skyHorizon), 0.55).lerp(C('#c7a6cf'), 0.4).multiplyScalar(0.92), renderer);
  const clouds = createClouds({
    coverage: theme.clouds,
    quality,
    sunDir,
    lit: cloudLit,
    shade: cloudShade,
    sun: sunCol.clone().multiplyScalar(1.2),
    haze,
    seed: Math.round(theme.sunAzimuth * 1000) + 7,
  });
  group.add(clouds.mesh);

  // Fog: exponential-squared; half faded (factor 0.5) at hazeDistance.
  const fog = new THREE.FogExp2(0xffffff, Math.sqrt(Math.LN2) / theme.hazeDistance);
  fog.color.copy(haze);
  scene.fog = fog;
  scene.background = haze.clone();

  // Sun.
  // The theme's sun colour times warm rock and sand compounds into blood red at sunset; the light itself is kept
  // closer to white and the warmth comes from the albedos.
  // A low sun keeps more of its colour and a little more strength (it rakes the ground at a shallow angle).
  const sun = new THREE.DirectionalLight(sunCol.clone().lerp(C('#ffffff'), 0.15 + 0.2 * day), 2.9 + 0.4 * day);
  sun.name = 'sun';
  const sh = SHADOW[quality];
  if (sh.size > 0) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(sh.size, sh.size);
    const cam = sun.shadow.camera;
    cam.left = -sh.half;
    cam.right = sh.half;
    cam.top = sh.half;
    cam.bottom = -sh.half;
    cam.near = 1;
    cam.far = 1400;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.06;
    sun.shadow.radius = 2;
  }
  group.add(sun, sun.target);

  // Sky fill above, warm sand bounce below.
  // Skylight: a cool lavender-violet whatever the hour, so shade on red rock goes red-violet (never black, and not
  // the blood red a warm skylight times warm rock gives); bluer under a day sky, more violet under a dusk one.
  const hemiSky = C(theme.skyTop).lerp(C(theme.skyHorizon), 0.25).lerp(C('#c4aec4'), 0.6);
  const hemiGround = C(theme.sand).lerp(C(theme.rockLit), 0.35).lerp(C('#d0b0a0'), 0.25);
  const hemi = new THREE.HemisphereLight(hemiSky, hemiGround, 1.45);
  group.add(hemi);

  // Light reflected off sunlit canyon walls, coming from the side opposite the sun, low.
  const bounce = new THREE.DirectionalLight(C(theme.rockLit).lerp(C(theme.sand), 0.5).lerp(C('#bfb2a6'), 0.35), 0.4);
  bounce.position.set(-sunDir.x, 0.25, -sunDir.z).normalize().multiplyScalar(100);
  group.add(bounce);

  // Environment map: the sky over warm ground, prefiltered once.
  const envMat = createSkyDomeMaterial({ ...domeColors, haze: hazeBase.clone() }, sunDir, true);
  const envScene = new THREE.Scene();
  const envDome = createSkyDome(envMat, 50);
  envScene.add(envDome);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(envScene, 0.02, 0.1, 200);
  pmrem.dispose();
  envDome.geometry.dispose();
  envMat.dispose();
  scene.environment = envRT.texture;
  // The hemisphere light already supplies diffuse ambient; the env map is mostly here for reflections.
  scene.environmentIntensity = 0.35;

  // Shadow-follow scratch (no per-frame allocations).
  const lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize();
  const ly = new THREE.Vector3().crossVectors(sunDir, lx).normalize();
  const center = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  const texel = sh.size > 0 ? (2 * sh.half) / sh.size : 1;
  const sunFlat = new THREE.Vector2(sunDir.x, sunDir.z).normalize();

  return {
    object: group,
    update(view) {
      clouds.material.uniforms.uTime.value = view.time;

      // Shadow box: centred a little ahead of the player (the camera looks forward), snapped to whole texels in
      // light space so static shadows do not crawl as it moves.
      fwd.copy(view.playerForward).setY(0);
      if (fwd.lengthSq() > 1e-6) fwd.normalize();
      center.copy(view.playerPos).addScaledVector(fwd, sh.half * 0.45);
      const a = Math.round(center.dot(lx) / texel) * texel;
      const b = Math.round(center.dot(ly) / texel) * texel;
      const c = center.dot(sunDir);
      sun.target.position.copy(lx).multiplyScalar(a).addScaledVector(ly, b).addScaledVector(sunDir, c);
      sun.position.copy(sun.target.position).addScaledVector(sunDir, 700);
      sun.target.updateMatrixWorld();

      // Haze warms towards the sun's colour when looking into the light.
      view.camera.getWorldDirection(camFwd);
      const fl = Math.hypot(camFwd.x, camFwd.z) || 1;
      const toward = Math.max(0, (camFwd.x * sunFlat.x + camFwd.z * sunFlat.y) / fl);
      fog.color.copy(hazeBase).lerp(hazeSun, toward * toward * (1 - day * 0.4));
      haze.copy(fog.color);
    },
    dispose() {
      if (scene.fog === fog) scene.fog = null;
      if (scene.environment === envRT.texture) scene.environment = null;
      scene.background = null;
      dome.geometry.dispose();
      domeMat.dispose();
      clouds.dispose();
      envRT.dispose();
      sun.dispose();
      bounce.dispose();
      hemi.dispose();
    },
  };
};
