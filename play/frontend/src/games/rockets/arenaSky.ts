// The sky around a Rockets arena: a banded dome with a haze band over the horizon, a darker zenith, a comic sun and a
// deeper void below; a ring of inked clouds; two layers of flat comic silhouettes in the map's theme (city, mesas,
// mountains, floating islands...), opaque and tinted toward the horizon colour instead of fogged; and on space maps
// two parallax star layers, a ringed planet, drifting asteroids and a soft glow under the platforms. Nothing here uses
// scene fog, and the whole sky draws in a handful of calls.

import * as THREE from 'three';
import type { MapData } from '@shared/rockets/map';
import { hullGeometry, inkMaterial, toonRamp } from '../../engine/toon';
import { mulberry } from './arenaTextures';
import { Bucket, type Theme, at } from './arenaDecor';

/** Default direction of the sun light set up in addArenaLights; themes may set their own. */
export const SUN_DIR = new THREE.Vector3(18, 30, 12).normalize();

export const sunDirOf = (theme: Theme) => (theme.sun ? new THREE.Vector3(...theme.sun).normalize() : SUN_DIR);

type Disposable = { dispose(): void };

export function buildSky(map: MapData, theme: Theme, disposables: Disposable[]): THREE.Group {
  const sky = new THREE.Group();
  const zenith = new THREE.Color(map.skyColor);
  const horizon = new THREE.Color(map.fogColor);
  const space = !!theme.planet;
  const dusk = !!theme.dusk;
  const sunDir = sunDirOf(theme);

  // ---- dome ----
  const radius = 230;
  const domeGeo = new THREE.SphereGeometry(radius, 32, 16);
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: zenith },
      horizon: { value: horizon },
      haze: { value: horizon.clone().lerp(new THREE.Color(0xffffff), 0.22) },
      deep: { value: zenith.clone().multiplyScalar(0.45).lerp(horizon, 0.25) },
      hazeAmount: { value: space ? 0.3 : 0.7 },
      // Printed bands in the sky; a dusk sky is one smooth wash instead.
      bands: { value: dusk ? 0 : 1 },
      sunDir: { value: sunDir },
      sunColor: { value: new THREE.Color(map.id === 'canyon' || dusk ? 0xffd86a : 0xfff8dc) },
      sunSize: { value: Math.cos(map.id === 'canyon' ? 0.11 : dusk ? 0.09 : space ? 0.035 : 0.07) },
      // Dusk: a warm glow round the low sun, spreading along the horizon.
      glowColor: { value: new THREE.Color(0xff9a4a) },
      glowAmount: { value: dusk ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 zenith;
      uniform vec3 horizon;
      uniform vec3 haze;
      uniform float hazeAmount;
      uniform float bands;
      uniform vec3 deep;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      uniform float sunSize;
      uniform vec3 glowColor;
      uniform float glowAmount;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col;
        if (h >= 0.0) {
          // Banded like a printed gradient higher up, darkening again toward the top; the lowest stretch is a smooth
          // ramp out of the horizon colour so no hard step sits right on the skyline.
          float x = smoothstep(0.0, 0.92, h);
          float t = mix(x, floor(x * 7.0) / 7.0, smoothstep(0.12, 0.3, x) * bands);
          // Printed skies clamp into the zenith colour; a smooth one eases all the way (no crease when you look up).
          col = mix(horizon, zenith, mix(smoothstep(0.0, 0.75, t), min(t * 1.7, 1.0), bands));
          col = mix(col, zenith * 0.62, smoothstep(0.55, 1.0, t));
          // A soft haze lifting off the horizon, smooth on both edges.
          float hz = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.05, 0.24, h));
          col = mix(col, haze, hz * hazeAmount);
          // Exactly the fog colour at the horizon line, so fogged geometry melts into it.
          col = mix(horizon, col, smoothstep(0.0, 0.03, h));
        } else {
          float t = floor(smoothstep(0.0, -0.55, h) * 4.0) / 4.0;
          col = mix(horizon, deep, t);
        }
        float s = dot(d, sunDir);
        if (glowAmount > 0.0) {
          vec3 dirFlat = normalize(vec3(d.x, 0.0, d.z));
          vec3 sunFlat = normalize(vec3(sunDir.x, 0.0, sunDir.z));
          float side = max(dot(dirFlat, sunFlat), 0.0);
          float low = 1.0 - smoothstep(-0.05, 0.45, h);
          float g = pow(max(s, 0.0), 10.0) * 0.9 + pow(side, 3.0) * low * 0.75;
          col = mix(col, glowColor, clamp(g, 0.0, 1.0) * glowAmount);
          col += glowColor * pow(max(s, 0.0), 60.0) * 0.6 * glowAmount;
        }
        float ring = sunSize - (1.0 - sunSize) * 0.35;
        if (s > ring) col = s > sunSize ? sunColor : (glowAmount > 0.0 ? mix(sunColor, glowColor, 0.5) : vec3(0.086, 0.07, 0.11));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  // Centre the dome on the camera so the horizon sits at eye height wherever you stand.
  dome.onBeforeRender = (_r, _s, camera) => {
    dome.position.copy(camera.position);
    dome.updateMatrixWorld();
  };
  sky.add(dome);
  disposables.push(domeGeo, domeMat);

  const rand = mulberry(map.id.length * 7919 + map.half);
  const lit = new Bucket();
  const flat = new Bucket();
  const hulls: THREE.BufferGeometry[] = [];
  const inked = (geo: THREE.BufferGeometry) => {
    hulls.push(hullGeometry(geo));
    return geo;
  };

  // ---- clouds (asteroids in space): clusters of flattened icosahedra, toon-lit, inked ----
  const count = space ? 18 : 14;
  for (let c = 0; c < count; c++) {
    const a = (c / count) * Math.PI * 2 + rand() * 0.3;
    const dist = 150 + rand() * 40;
    const cx = Math.cos(a) * dist;
    const cz = Math.sin(a) * dist;
    if (space) {
      const r = 2 + rand() * 5;
      const g = new THREE.IcosahedronGeometry(r, 0);
      g.scale(1, 0.7 + rand() * 0.5, 0.8 + rand() * 0.4);
      g.rotateX(rand() * 3);
      lit.add(inked(at(g, cx, -30 + rand() * 90, cz, rand() * 3)), new THREE.Color(0x6a5a8a).multiplyScalar(0.8 + rand() * 0.4));
      continue;
    }
    // Kept below ~18 degrees of elevation so at a level gaze they stay clear of the top HUD panels.
    const cy = 20 + rand() * 28;
    const blobs = 3 + Math.floor(rand() * 3);
    const tint = dusk ? new THREE.Color(0xd88ab0).lerp(zenith, 0.35) : new THREE.Color(0xffffff).lerp(horizon, 0.18);
    for (let i = 0; i < blobs; i++) {
      const r = 7 + rand() * 6;
      const g = new THREE.IcosahedronGeometry(r, 1);
      g.scale(dusk ? 1.6 : 1, dusk ? 0.22 : 0.6, 1);
      g.translate(cx + (i - blobs / 2) * r * 0.9, cy + rand() * 3, cz + (rand() - 0.5) * 6);
      lit.add(inked(g), tint);
    }
  }

  // ---- silhouettes: opaque flat rings, each tinted further toward the horizon colour the further away it is ----
  if (theme.skyline !== 'none') {
    // Atmospheric perspective by colour, not alpha: one deep theme tone, mixed toward the horizon (= fog) colour by
    // distance. No ink on any ring: thin outlines on distant shapes read as wireframe glitches.
    const deepTone = horizon.clone().lerp(zenith, 0.5).multiplyScalar(0.5);
    const tone = (fogK: number) => deepTone.clone().lerp(horizon, fogK);
    const layers = [
      { r: 205, n: 26, scale: 0.8, color: tone(0.72) },
      { r: 165, n: 18, scale: 0.55, color: tone(0.42) },
    ];
    // Floating islands get extra depth: a hazy far scatter and a closer, crisper ring.
    if (theme.skyline === 'islands') layers.unshift({ r: 222, n: 30, scale: 0.45, color: tone(0.86) }), layers.push({ r: 118, n: 9, scale: 0.75, color: tone(0.22) });
    // A neon city: a dense far skyline and a closer ring of towers, dark blue-violet so their lights stand out.
    if (theme.skyline === 'neon') {
      const night = new THREE.Color(0x1a1840);
      const city = (k: number) => night.clone().lerp(horizon, k);
      layers.splice(0, 2, { r: 205, n: 44, scale: 0.8, color: city(0.4) }, { r: 165, n: 30, scale: 0.6, color: city(0.2) }, { r: 120, n: 16, scale: 0.7, color: city(0.06) });
    }
    for (const layer of layers) {
      for (let i = 0; i < layer.n; i++) {
        const a = ((i + rand() * 0.6) / layer.n) * Math.PI * 2;
        const d = layer.r + rand() * 14;
        const color = layer.color.clone().multiplyScalar(0.96 + rand() * 0.08);
        for (const geo of silhouette(theme.skyline, rand, layer.scale)) {
          at(geo.g, Math.cos(a) * d + geo.dx, 0, Math.sin(a) * d + geo.dz, -a);
          flat.add(geo.g, geo.glow !== undefined ? new THREE.Color(geo.glow).lerp(color, geo.mix ?? 0) : color);
        }
      }
    }
  }

  // ---- neon city: hover cars drifting round the skyline, steam rising off the wall pipes ----
  if (theme.skyline === 'neon') {
    const cars = new Bucket();
    for (let i = 0; i < 14; i++) {
      const a = rand() * Math.PI * 2;
      const d = 70 + rand() * 70;
      const y = 22 + rand() * 30;
      const s = 1 + rand() * 0.6;
      // Built along local z (the direction of travel round the ring), then turned and placed like the skyline.
      const parts: [THREE.BufferGeometry, number][] = [
        [new THREE.BoxGeometry(1.7 * s, 0.6 * s, 3.6 * s), 0x2a2638],
        [new THREE.BoxGeometry(1.3 * s, 0.45 * s, 1.6 * s).translate(0, 0.5 * s, 0.2 * s), 0x3a3450],
        [new THREE.BoxGeometry(1.5 * s, 0.08, 3.2 * s).translate(0, -0.34 * s, 0), rand() < 0.5 ? 0x56f2ff : 0xff5ac8],
        [new THREE.BoxGeometry(1.4 * s, 0.14 * s, 0.06).translate(0, 0.05, 1.82 * s), 0xff3a3a],
        [new THREE.BoxGeometry(1.2 * s, 0.12 * s, 0.06).translate(0, 0.05, -1.82 * s), 0xfff2d0],
      ];
      for (const [g, color] of parts) cars.add(at(g, Math.cos(a) * d, y, Math.sin(a) * d, -a), color);
    }
    const carGeo = cars.build();
    if (carGeo) {
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false });
      const traffic = new THREE.Mesh(carGeo, mat);
      traffic.frustumCulled = false;
      // The whole stream turns slowly round the arena.
      traffic.onBeforeRender = () => {
        traffic.rotation.y = (performance.now() / 1000) * 0.012;
        traffic.updateMatrixWorld();
      };
      sky.add(traffic);
      disposables.push(carGeo, mat);
    }
    // Elevated highways on arcs between the skyline rings: a dark deck on pillars, a lit edge and lamp dots.
    const roads = new Bucket();
    const deck = new THREE.Color(0x1e1c3c).lerp(horizon, 0.18);
    for (let i = 0; i < 4; i++) {
      const r = 96 + i * 9 + rand() * 6;
      const y = 16 + rand() * 12;
      const a0 = rand() * Math.PI * 2;
      const span = 0.7 + rand() * 0.6;
      const steps = Math.ceil((span * r) / 4);
      for (let s = 0; s < steps; s++) {
        const a = a0 + (s / steps) * span;
        const seg = (span * r) / steps + 0.1;
        const [cx, cz] = [Math.cos(a) * r, Math.sin(a) * r];
        // Segments run along the tangent: local z after the -a turn.
        roads.add(at(new THREE.BoxGeometry(5, 0.8, seg), cx, y, cz, -a), deck);
        roads.add(at(new THREE.BoxGeometry(0.2, 0.16, seg), cx - Math.cos(a) * 2.5, y + 0.1, cz - Math.sin(a) * 2.5, -a), i % 2 ? 0xff5ac8 : 0x56f2ff);
        if (s % 3 === 0) roads.add(at(new THREE.BoxGeometry(0.5, 0.25, 0.5), cx + Math.cos(a) * 2.3, y + 0.6, cz + Math.sin(a) * 2.3), 0xfff0c8);
        if (s % 6 === 0) roads.add(at(new THREE.BoxGeometry(1.4, y + 12, 1.4), cx, (y - 12) / 2, cz), deck.clone().multiplyScalar(0.8));
      }
    }
    const roadGeo = roads.build();
    if (roadGeo) {
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false });
      sky.add(new THREE.Mesh(roadGeo, mat));
      disposables.push(roadGeo, mat);
    }
    // Searchlights from the city: soft additive cones that sweep slowly.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + rand();
      const d = 120 + rand() * 40;
      const len = 140;
      const beam = new Bucket();
      const cone = new THREE.CylinderGeometry(5, 0.6, len, 12, 1, true).translate(0, len / 2, 0);
      beam.add(cone, i === 1 ? 0x9ad8ff : 0xffd0f0, (_x, y) => 0.16 * (1 - y / len));
      const geo = beam.build()!;
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(Math.cos(a) * d, -5, Math.sin(a) * d);
      mesh.frustumCulled = false;
      mesh.renderOrder = -7;
      const phase = rand() * 10;
      mesh.onBeforeRender = () => {
        const t = performance.now() / 1000 + phase;
        // Lean inward over the arena and swing side to side.
        mesh.rotation.set(0, -a, 0);
        mesh.rotateZ(0.5 + 0.18 * Math.sin(t * 0.21));
        mesh.rotateX(0.35 * Math.sin(t * 0.13));
        mesh.updateMatrixWorld();
      };
      sky.add(mesh);
      disposables.push(geo, mat);
    }
    const puffTex = radialGlow();
    const puffMat = new THREE.SpriteMaterial({ map: puffTex, color: 0xe6d2f4, transparent: true, opacity: 0.24, depthWrite: false });
    const wall = map.half + 0.5;
    for (let i = 0; i < 10; i++) {
      const t = (rand() - 0.5) * map.half * 1.6;
      const side = Math.floor(rand() * 4);
      const [x, z] = side === 0 ? [t, -wall] : side === 1 ? [wall, t] : side === 2 ? [t, wall] : [-wall, t];
      for (let k = 0; k < 3; k++) {
        const puff = new THREE.Sprite(puffMat);
        const s = 4 + k * 3 + rand() * 2;
        puff.scale.set(s, s, 1);
        puff.position.set(x * (1 + k * 0.02), 11 + k * 3.2, z * (1 + k * 0.02));
        sky.add(puff);
      }
    }
    disposables.push(puffTex, puffMat);
  }

  // ---- space: stars, a ringed planet and a moon ----
  if (theme.stars) {
    const pts = new Float32Array(theme.stars * 3);
    for (let i = 0; i < theme.stars; i++) {
      const y = 0.08 + rand() * 0.92;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      pts.set([Math.cos(a) * r * 215, y * 215, Math.sin(a) * r * 215], i * 3);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: space ? 2.4 : 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: space ? 0.95 : 0.6, depthWrite: false });
    const stars = new THREE.Points(starGeo, starMat);
    stars.renderOrder = -9;
    stars.frustumCulled = false;
    sky.add(stars);
    disposables.push(starGeo, starMat);
    if (space) {
      // A second, fainter field all round (below too: there is no ground out here) on a smaller shell, so it slides
      // against the far one as you move and the void gets depth.
      const n = Math.round(theme.stars * 0.8);
      const near = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const y = rand() * 2 - 1;
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(1 - y * y);
        const d = 110 + rand() * 40;
        near.set([Math.cos(a) * r * d, y * d, Math.sin(a) * r * d], i * 3);
      }
      const nearGeo = new THREE.BufferGeometry();
      nearGeo.setAttribute('position', new THREE.BufferAttribute(near, 3));
      const nearMat = new THREE.PointsMaterial({ color: 0xc8b8ff, size: 1.5, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.55, depthWrite: false });
      const nearStars = new THREE.Points(nearGeo, nearMat);
      nearStars.renderOrder = -9;
      nearStars.frustumCulled = false;
      sky.add(nearStars);
      disposables.push(nearGeo, nearMat);
    }
  }
  if (theme.planet) {
    // Low over the horizon, so the top HUD never hides it.
    const dir = new THREE.Vector3(-0.85, 0.2, -0.42).normalize().multiplyScalar(200);
    // Latitude bands, printed in three tones.
    const bands = [0xffb35a, 0xff8a4a, 0xffd08a];
    const bandGeo: THREE.BufferGeometry[] = [];
    for (let b = 0; b < 6; b++) {
      const t0 = (b / 6) * Math.PI;
      const t1 = ((b + 1) / 6) * Math.PI;
      bandGeo.push(new THREE.SphereGeometry(30, 24, 3, 0, Math.PI * 2, t0, t1 - t0));
    }
    const tilt = new THREE.Euler(0.35, 0, 0.3);
    bandGeo.forEach((g, b) => {
      g.rotateX(tilt.x).rotateZ(tilt.z);
      lit.add(inked(at(g, dir.x, dir.y, dir.z)), bands[b % 3]);
    });
    const ring = new THREE.TorusGeometry(50, 7, 3, 48);
    ring.scale(1, 1, 0.06);
    ring.rotateX(Math.PI / 2 + tilt.x).rotateZ(tilt.z);
    lit.add(inked(at(ring, dir.x, dir.y, dir.z)), 0xffe6b0);
    const moon = new THREE.IcosahedronGeometry(9, 1);
    lit.add(inked(at(moon, 120, 60, 110)), 0xc8c0e0);

    // A soft glow pooled under the platforms, so they float over something instead of flat paint.
    let lowest = 0;
    for (const b of map.boxes) lowest = Math.min(lowest, b.min.y);
    const glowTex = radialGlow();
    const glowGeo = new THREE.PlaneGeometry(map.half * 3, map.half * 3).rotateX(-Math.PI / 2);
    const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, color: 0x8a5aff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.y = lowest - 9;
    glow.renderOrder = -8;
    sky.add(glow);
    disposables.push(glowTex, glowGeo, glowMat);
  }

  const litGeo = lit.build();
  if (litGeo) {
    const mat = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: toonRamp(), fog: false });
    sky.add(new THREE.Mesh(litGeo, mat));
    disposables.push(litGeo, mat);
  }
  const flatGeo = flat.build();
  if (flatGeo) {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false });
    sky.add(new THREE.Mesh(flatGeo, mat));
    disposables.push(flatGeo, mat);
  }
  if (hulls.length) {
    const hull = new Bucket();
    for (const h of hulls) hull.add(h, 0);
    const hullGeo = hull.build();
    if (hullGeo) {
      sky.add(new THREE.Mesh(hullGeo, inkMaterial(0.0016, 0.2, false)));
      disposables.push(hullGeo);
    }
  }
  return sky;
}

/** A small white-to-clear radial gradient, for additive glows. */
function radialGlow(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Piece {
  g: THREE.BufferGeometry;
  dx: number;
  dz: number;
  glow?: number;
  /** How far `glow` is blended into the layer colour. */
  mix?: number;
}

/** One distant landmark in the given style, standing on y = 0 and reaching well below it so no gap shows. */
function silhouette(kind: Theme['skyline'], rand: () => number, k: number): Piece[] {
  const base = -12;
  const column = (geo: THREE.BufferGeometry, h: number, dx = 0, dz = 0, glow?: number): Piece => {
    geo.translate(0, base + (h - base) / 2, 0);
    return { g: geo, dx, dz, glow };
  };
  const boxy = (w: number, h: number, d: number, dx = 0, dz = 0) => column(new THREE.BoxGeometry(w, h - base, d), h, dx, dz);
  const cone = (r: number, h: number, seg: number, dx = 0, dz = 0, top = 0) => column(new THREE.CylinderGeometry(top, r, h - base, seg), h, dx, dz);
  switch (kind) {
    case 'neon': {
      // Skyscrapers with lit window bands and neon edge strips, sometimes a spire with a red light on top.
      const out: Piece[] = [];
      const towers = 2 + Math.floor(rand() * 2);
      for (let i = 0; i < towers; i++) {
        const h = (40 + rand() * 80) * k;
        const w = (6 + rand() * 7) * k;
        const dx = (i - (towers - 1) / 2) * 10 * k;
        const dz = rand() * 8;
        out.push(boxy(w, h, w, dx, dz));
        if (rand() < 0.5) out.push(boxy(w * 0.6, h + 10 * k, w * 0.6, dx, dz));
        const lit = [0x6af0ff, 0xff5ac8, 0xffc86a, 0x9a7aff][Math.floor(rand() * 4)];
        // Window bands on the face toward the arena (local -x faces inward once placed).
        for (let y = 4 * k; y < h - 3 * k; y += (2.2 + rand() * 1.5) * k) {
          if (rand() < 0.35) continue;
          const band = new THREE.BoxGeometry(0.3, 0.7 * k, w * (0.5 + rand() * 0.4));
          out.push({ g: band.translate(-w / 2 - 0.2, y, 0), dx, dz, glow: lit, mix: 0.35 + rand() * 0.3 });
        }
        if (rand() < 0.6) {
          const strip = new THREE.BoxGeometry(0.3, h * 0.7, 0.6 * k);
          out.push({ g: strip.translate(-w / 2 - 0.25, h * 0.5, (rand() < 0.5 ? -1 : 1) * (w / 2 - 0.3 * k)), dx, dz, glow: rand() < 0.5 ? 0xff4ab8 : 0x4ae8ff, mix: 0.1 });
        }
        if (rand() < 0.35) {
          out.push({ g: new THREE.CylinderGeometry(0.3, 0.3, 12 * k).translate(0, h + 6 * k, 0), dx, dz });
          out.push({ g: new THREE.BoxGeometry(1.2, 1.2, 1.2).translate(0, h + 12 * k, 0), dx, dz, glow: 0xff3a3a, mix: 0 });
        }
      }
      return out;
    }
    case 'city': {
      const out: Piece[] = [];
      for (let i = 0; i < 3; i++) {
        const h = (28 + rand() * 50) * k;
        out.push(boxy((6 + rand() * 8) * k, h, 8 * k, (i - 1) * 9 * k, rand() * 6));
        if (rand() < 0.4) out.push({ g: new THREE.CylinderGeometry(0.4, 0.4, 10).translate(0, h + 5, 0), dx: (i - 1) * 9 * k, dz: 0 });
      }
      return out;
    }
    case 'industry': {
      const out = [boxy((10 + rand() * 10) * k, (18 + rand() * 14) * k, 10 * k)];
      if (rand() < 0.7) out.push(cone(2.2 * k, (35 + rand() * 20) * k, 8, 6 * k, 0, 1.6 * k));
      if (rand() < 0.5) out.push(cone(6 * k, (16 + rand() * 6) * k, 12, -9 * k, 3, 6 * k));
      return out;
    }
    case 'mesas': {
      const r = (20 + rand() * 16) * k;
      return [cone(r, (14 + rand() * 18) * k, 7, 0, 0, r * 0.72)];
    }
    case 'pyramids':
      return rand() < 0.6 ? [cone((22 + rand() * 12) * k, (30 + rand() * 24) * k, 4)] : [cone((40 + rand() * 20) * k, (10 + rand() * 6) * k, 9, 0, 0, 20 * k)];
    case 'spires':
      return [cone((6 + rand() * 6) * k, (45 + rand() * 45) * k, 5), cone((4 + rand() * 4) * k, (25 + rand() * 25) * k, 5, 8 * k, 4)];
    case 'castles': {
      const out = [cone((30 + rand() * 20) * k, (24 + rand() * 30) * k, 6)];
      if (rand() < 0.35) out.push(boxy(5 * k, 38 * k, 5 * k, 12 * k, 0), cone(4 * k, 46 * k, 4, 12 * k, 0, 0));
      return out;
    }
    case 'volcanoes': {
      const h = (34 + rand() * 30) * k;
      const r = (34 + rand() * 18) * k;
      const top = r * 0.18;
      const out = [cone(r, h, 8, 0, 0, top)];
      out.push(column(new THREE.CylinderGeometry(top * 0.9, top * 0.9, 1.2, 8), h + 0.2, 0, 0, 0xff8a2a));
      return out;
    }
    case 'islands': {
      // Floating islands: a flat top, a rock root, hanging at a random height.
      const r = (8 + rand() * 9) * k;
      const y = -6 + rand() * 40;
      const rock = new THREE.ConeGeometry(r, r * 1.6, 7);
      rock.rotateX(Math.PI);
      rock.translate(0, y - r * 0.8, 0);
      const cap = new THREE.CylinderGeometry(r * 1.02, r, 2, 7);
      cap.translate(0, y + 1, 0);
      return [{ g: rock, dx: 0, dz: 0 }, { g: cap, dx: 0, dz: 0, glow: 0x9ad06a, mix: 0.55 }];
    }
    case 'hills':
    default: {
      const r = (30 + rand() * 30) * k;
      const hill = new THREE.SphereGeometry(r, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2);
      hill.scale(1, (0.35 + rand() * 0.35) * (40 / r) * k, 1).translate(0, -6, 0);
      const out: Piece[] = [{ g: hill, dx: 0, dz: 0 }];
      if (rand() < 0.4) out.push(cone(3 * k, 30 * k, 4, r * 0.3, 0, 0));
      return out;
    }
  }
}
