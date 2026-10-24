// The rune shield every creature wears first (the word you read is written on it; typing it pops the shield).
//
// No dome: a thin golden rune circle glows on the floor around the creature, like the carved circles in the library
// floor, with a band of slowly turning glyphs between two fine rules, and a few glyph sparks that orbit the creature
// while drifting upwards. A letter hitting the shield sends a quick ripple out from the circle and makes the sparks
// flare. Both parts are additive but dim, so the creature stays the thing you look at.
//
// Two draw calls per shield (floor circle, sparks). Geometry, materials and the rune texture are shared by every
// shield; the per-shield values (size, hit flash, phase) are pushed as uniforms just before each draw, and the
// vertex shaders place everything from those, so nothing is allocated per frame. A wide sentence shield (`w` > `r`)
// becomes a stadium: two half circles joined by straight runs, with the glyphs following the outline.

import * as THREE from 'three';

/** A 2×2 quad on the floor (xz); the vertex shader scales it to the shield's extent. */
const floorGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
floorGeo.userData.shared = true;

const SPARKS = 7;
/** One camera-facing quad per spark; `seed` = (orbit phase, rise phase, orbit speed). */
const sparkGeo = (() => {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(SPARKS * 4 * 3);
  const corner = new Float32Array(SPARKS * 4 * 2);
  const seed = new Float32Array(SPARKS * 4 * 3);
  const index: number[] = [];
  const C = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let i = 0; i < SPARKS; i++) {
    const s = [(i / SPARKS) * Math.PI * 2 + (i % 2) * 0.4, (i * 0.618) % 1, (i % 2 ? 0.45 : -0.32) * (0.8 + (i % 3) * 0.15)];
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      corner.set([C[k * 2], C[k * 2 + 1]], v * 2);
      seed.set(s, v * 3);
    }
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
  g.setIndex(index);
  return g;
})();
sparkGeo.userData.shared = true;

const time = { value: 0 };
let ringMat: THREE.ShaderMaterial | null = null;
let sparkMat: THREE.ShaderMaterial | null = null;

/** A strip of procedural rune glyphs with a small dot between each pair; tiles horizontally, glyphs fill the height. */
function runeTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 96;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.shadowColor = '#fff';
  g.shadowBlur = 6;
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const N = 12;
  const cell = W / N;
  g.lineWidth = 7;
  for (let i = 0; i < N; i++) {
    const cx = cell * (i + 0.5);
    const top = 14;
    const bot = H - 14;
    const hw = 13;
    g.beginPath();
    // Every rune has a stave; then two or three branches, hooks or a closed loop.
    g.moveTo(cx, top);
    g.lineTo(cx, bot);
    const marks = 2 + Math.floor(rnd() * 2);
    for (let m = 0; m < marks; m++) {
      const y0 = top + rnd() * (bot - top) * 0.65;
      const side = rnd() < 0.5 ? -1 : 1;
      const kind = rnd();
      if (kind < 0.45) {
        g.moveTo(cx, y0);
        g.lineTo(cx + side * hw, y0 + (rnd() < 0.5 ? -1 : 1) * hw * 0.9);
      } else if (kind < 0.75) {
        g.moveTo(cx, y0);
        g.lineTo(cx + side * hw, y0 + hw * 0.7);
        g.lineTo(cx, y0 + hw * 1.4);
      } else {
        g.moveTo(cx + hw * 0.6, y0 + hw * 0.6);
        g.arc(cx, y0 + hw * 0.6, hw * 0.6, 0, Math.PI * 2);
      }
    }
    g.stroke();
    // A small diamond between runes.
    const dx = cell * (i + 1);
    g.beginPath();
    g.moveTo(dx, H / 2 - 7);
    g.lineTo(dx + 5, H / 2);
    g.lineTo(dx, H / 2 + 7);
    g.lineTo(dx - 5, H / 2);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** How far the floor quad reaches beyond the circle, in shield radii (room for the hit ripple). */
const EXT = 1.5;

function materials() {
  if (!ringMat || !sparkMat) {
    ringMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // size = (half length of the straight run, radius); look = (flash, phase, glyph tiles around the outline).
      uniforms: { time, size: { value: new THREE.Vector2(0, 1) }, look: { value: new THREE.Vector3() }, runes: { value: runeTexture() } },
      vertexShader: /* glsl */ `
        uniform vec2 size;
        varying vec2 vP;
        void main() {
          vP = position.xz * vec2(size.x + size.y * ${EXT.toFixed(2)}, size.y * ${EXT.toFixed(2)});
          gl_Position = projectionMatrix * modelViewMatrix * vec4(vP.x, position.y, vP.y, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float time; uniform vec2 size; uniform vec3 look; uniform sampler2D runes;
        varying vec2 vP;
        const float PI = 3.14159265;
        // An antialiased line of half width w (in radii) at distance c, never thinner than about a pixel.
        float rule(float d, float c, float w, float aa) {
          w = max(w, aa * 0.6);
          return 1.0 - smoothstep(w, w + aa * 1.5, abs(d - c));
        }
        void main() {
          float L = size.x, R = size.y, flash = look.x;
          vec2 q = vec2(max(abs(vP.x) - L, 0.0), vP.y);
          float d = length(q) / R;
          float aa = fwidth(d);
          // Arc length along the stadium outline, clockwise from the front-left corner, for the glyph band.
          float s;
          if (abs(vP.x) <= L) s = vP.y > 0.0 ? vP.x + L : 3.0 * L + PI * R - vP.x;
          else if (vP.x > 0.0) s = 2.0 * L + (0.5 * PI - atan(vP.y, vP.x - L)) * R;
          else {
            float a = atan(vP.y, vP.x + L);
            if (a < 0.0) a += 2.0 * PI;
            s = 4.0 * L + PI * R + (1.5 * PI - a) * R;
          }
          float u = s / (4.0 * L + 2.0 * PI * R) * look.z + time * 0.012;
          float breathe = 0.85 + 0.15 * sin(time * 1.7 + look.y);
          float lit = breathe * (1.0 + flash * 1.1);
          // Two fine rules with the glyphs between them, a soft glow hugging the outer rule, a whisper of fill.
          float a = rule(d, 1.0, 0.014, aa) * 0.3 + rule(d, 0.785, 0.007, aa) * 0.17;
          // A small circle on screen (a phone) cannot show the glyphs: dim them so they do not smear into a bright band.
          float detail = smoothstep(0.05, 0.016, aa);
          float band = (d - 0.815) / 0.16;
          if (band > 0.0 && band < 1.0) a += texture2D(runes, vec2(u, band)).r * mix(0.13, 0.26, detail);
          a += exp(-pow((d - 1.0) / 0.08, 2.0)) * 0.05 + smoothstep(1.0, 0.2, d) * 0.018;
          a *= lit;
          // Hit: a ripple racing outwards from the circle.
          float rip = 1.0 + (1.0 - flash) * 0.42;
          a += rule(d, rip, 0.02 + (1.0 - flash) * 0.03, aa) * flash * 0.6;
          vec3 col = mix(vec3(1.0, 0.52, 0.16), vec3(1.0, 0.78, 0.42), clamp(flash, 0.0, 1.0));
          gl_FragColor = vec4(col * a, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    sparkMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { time, size: { value: new THREE.Vector2(0, 1) }, look: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */ `
        uniform float time; uniform vec2 size; uniform vec3 look;
        attribute vec2 corner; attribute vec3 seed;
        varying vec2 vC; varying float vA;
        void main() {
          float L = size.x, R = size.y, flash = look.x;
          float a = seed.x + time * seed.z + look.y;
          // Each spark circles the creature just inside the rune circle while rising, then fades and starts again low.
          float rise = fract(time * 0.16 + seed.y + look.y * 0.13);
          float k = 0.9 + flash * 0.3;
          vec3 c = vec3(cos(a) * (L + R * k), R * (0.08 + rise * 1.25), sin(a) * R * k);
          vec4 mv = modelViewMatrix * vec4(c, 1.0);
          float sc = length(modelMatrix[0].xyz);
          float tw = 0.75 + 0.25 * sin(time * 4.0 + seed.x * 7.0);
          mv.xy += corner * R * sc * 0.085 * tw * (1.0 + flash * 0.8);
          vC = corner;
          vA = sin(rise * 3.14159) * (0.6 + flash * 0.8);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vC; varying float vA;
        void main() {
          float r2 = dot(vC, vC);
          // A soft glow with a small four-point twinkle and a bright core.
          float star = max(0.0, 1.0 - abs(vC.x) * 6.0) * max(0.0, 1.0 - abs(vC.y)) + max(0.0, 1.0 - abs(vC.y) * 6.0) * max(0.0, 1.0 - abs(vC.x));
          float a = (exp(-r2 * 7.0) * 0.45 + exp(-r2 * 40.0) * 0.6 + star * 0.25) * vA;
          gl_FragColor = vec4(vec3(1.0, 0.8, 0.45) * a, 1.0);
          #include <colorspace_fragment>
        }`,
    });
  }
  return { ring: ringMat, spark: sparkMat! };
}

/** Advances the turning glyphs, the breathing glow and the orbiting sparks on every shield. */
export function tickBubbles(t: number) {
  time.value = t;
}

export interface Bubble {
  root: THREE.Group;
  /** Ripple and flare after a letter hits it. */
  hit(): void;
  update(dt: number, t: number): void;
}

/**
 * A rune shield of radius `r` around a creature whose origin is on the floor (or a balaur head's chin), stretched to
 * half-width `w` for a sentence convoy. The rune circle lies at the creature's feet: if Game lifts `root` (a hovering
 * creature), the circle stays on the floor under it and the sparks rise around the lifted body.
 */
export function makeBubble(r: number, w = r): Bubble {
  const { ring, spark } = materials();
  const root = new THREE.Group();
  const R = r * 0.95;
  const L = Math.max(0, w - r);
  const floor = new THREE.Mesh(floorGeo, ring);
  floor.frustumCulled = false;
  floor.renderOrder = 2;
  root.add(floor);
  const sparks = new THREE.Mesh(sparkGeo, spark);
  sparks.frustumCulled = false;
  sparks.renderOrder = 6;
  root.add(sparks);

  let flash = 0;
  const phase = Math.random() * 10;
  // Glyph tiles (12 runes each) around the outline: about 24 on a single creature's circle.
  const tiles = Math.max(1, Math.round((4 * L + 2 * Math.PI * R) / (R * 3.6)));
  // Per-shield uniforms on shared materials: set just before this mesh draws, and force the upload.
  floor.onBeforeRender = () => {
    ring.uniforms.size.value.set(L, R);
    ring.uniforms.look.value.set(flash, phase, tiles);
    ring.uniformsNeedUpdate = true;
  };
  sparks.onBeforeRender = () => {
    spark.uniforms.size.value.set(L, R);
    spark.uniforms.look.value.set(flash, phase, tiles);
    spark.uniformsNeedUpdate = true;
  };
  return {
    root,
    hit() {
      flash = 1;
    },
    update(dt) {
      flash = Math.max(0, flash - dt * 3);
      // Keep the circle on the creature's floor even when the shield is lifted around a hovering body.
      floor.position.y = 0.03 - root.position.y;
    },
  };
}
