// The rune shield every creature wears first (the word you read is written on it; typing it pops the shield).
//
// No dome: a thin golden rune circle glows on the floor just outside the creature's body, like the carved circles in
// the library floor, with a narrow band of slowly turning glyphs between two hairline rules, and a few glyph sparks
// that orbit the creature while drifting upwards. A letter hitting the shield sends a quick ripple out from the circle
// and makes the sparks flare. Both parts are additive and dim: only the current target (`setShieldFocus`) shows its
// circle at full strength, every other shield is a faint circle plus its sparks, so the creatures stay what you look
// at. A sentence convoy's wide stadium is rules only (no glyphs) at about a quarter strength. A shield whose creature
// stands high above the floor (a balaur head on its neck) faces the camera as a halo around the head instead.
//
// Two draw calls for all shields together: one InstancedMesh draws every floor circle, another every shield's sparks.
// Each instance carries its shield root's world matrix and per-shield attributes (size, hit flash, phase, glyph
// tiles); `tickBubbles` packs the live shields into them once per frame, and the vertex shaders place everything from
// those, so nothing is allocated per frame. A wide sentence shield (`w` > `r`) becomes a stadium: two half circles joined by straight runs, with the glyphs following the outline.

import * as THREE from 'three';

/** A 2×2 quad on the floor (xz); the vertex shader scales it to the shield's extent. */
const floorGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

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

/**
 * Ring strength (1 = the old full-bright circle) for shields that are not the current target and for the target; a
 * sentence stadium's (calm, target); the sparks' (calm, target). GLSL float literals.
 */
const CALM = '0.2';
const FOCUS = '0.55';
const WIDE = ['0.2', '0.28'];
const SPARK = ['0.45', '0.65'];

/** How far the floor quad reaches beyond the circle, in shield radii (room for the hit ripple). */
const EXT = 1.5;

function materials() {
  if (!ringMat || !sparkMat) {
    ringMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // Per shield (instance): iSize = (half length of the straight run, radius, floor height in the shield's frame or
      // the halo centre's height when upright, upright 0/1); iLook = (flash, phase, glyph tiles around the outline,
      // focus 0..1). The instance matrix is the shield root's world matrix.
      uniforms: { time, runes: { value: runeTexture() } },
      vertexShader: /* glsl */ `
        attribute vec4 iSize; attribute vec4 iLook;
        varying vec2 vP; varying vec2 size; varying vec4 look;
        void main() {
          size = iSize.xy;
          look = iLook;
          vP = position.xz * vec2(size.x + size.y * ${EXT.toFixed(2)}, size.y * ${EXT.toFixed(2)});
          if (iSize.w > 0.5) {
            // Upright: a camera-facing halo around the head centre (the head itself hides the part in front of it).
            vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, iSize.z, 0.0, 1.0);
            float sc = length((modelMatrix * instanceMatrix)[0].xyz);
            mv.xy += vec2(vP.x, -vP.y) * sc;
            gl_Position = projectionMatrix * mv;
          } else {
            gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(vP.x, position.y + iSize.z, vP.y, 1.0);
          }
        }`,
      fragmentShader: /* glsl */ `
        uniform float time; uniform sampler2D runes;
        varying vec2 vP; varying vec2 size; varying vec4 look;
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
          // Outside everything that can light up (the outer glow, or the hit ripple while it runs): skip the rest. Half
          // the quad's pixels end here, before any atan or texture fetch. (After fwidth, which needs every pixel.)
          if (d > (flash > 0.01 ? max(1.2, 1.5 - flash * 0.4) : 1.2)) discard;
          float breathe = 0.85 + 0.15 * sin(time * 1.7 + look.y);
          // Strength: the current target in full, every other shield faint, a sentence stadium about a quarter; a hit
          // flares any of them back to full.
          bool wide = L > 0.0;
          float strength = wide ? mix(${WIDE[0]}, ${WIDE[1]}, look.w) : mix(${CALM}, ${FOCUS}, look.w);
          // A sentence stadium covers a lot of floor: its flare stays modest.
          float lit = breathe * (wide ? strength * (1.0 + flash * 0.7) : mix(strength, 1.0, flash) * (1.0 + flash * 0.8));
          // Two hairline rules with the glyphs between them, a soft glow hugging the outer rule, a whisper of fill.
          float a = rule(d, 1.0, 0.007, aa) * 0.34 + rule(d, 0.88, 0.0035, aa) * 0.2;
          // A small circle on screen (a phone) cannot show the glyphs: dim them so they do not smear into a bright band.
          float detail = smoothstep(0.05, 0.016, aa);
          float band = (d - 0.9) / 0.08;
          if (!wide && band > 0.0 && band < 1.0) {
            // Arc length along the stadium outline, clockwise from the front-left corner, for the glyph band.
            float s;
            if (abs(vP.x) <= L) s = vP.y > 0.0 ? vP.x + L : 3.0 * L + PI * R - vP.x;
            else if (vP.x > 0.0) s = 2.0 * L + (0.5 * PI - atan(vP.y, vP.x - L)) * R;
            else {
              float ang = atan(vP.y, vP.x + L);
              if (ang < 0.0) ang += 2.0 * PI;
              s = 4.0 * L + PI * R + (1.5 * PI - ang) * R;
            }
            float u = s / (4.0 * L + 2.0 * PI * R) * look.z + time * 0.012;
            a += texture2D(runes, vec2(u, band)).r * mix(0.13, 0.26, detail);
          }
          a += exp(-pow((d - 1.0) / 0.06, 2.0)) * 0.04 + smoothstep(1.0, 0.2, d) * 0.012;
          a *= lit;
          // Hit: a ripple racing outwards from the circle.
          float rip = 1.0 + (1.0 - flash) * 0.42;
          a += rule(d, rip, 0.012 + (1.0 - flash) * 0.02, aa) * flash * (wide ? 0.14 : 0.55);
          vec3 col = mix(vec3(1.0, 0.52, 0.16), vec3(1.0, 0.78, 0.42), clamp(flash, 0.0, 1.0));
          gl_FragColor = vec4(col * a, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    sparkMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { time },
      vertexShader: /* glsl */ `
        uniform float time;
        attribute vec2 corner; attribute vec3 seed; attribute vec4 iSize; attribute vec4 iLook;
        varying vec2 vC; varying float vA;
        void main() {
          vec4 look = iLook;
          float L = iSize.x, R = iSize.y, flash = look.x;
          float a = seed.x + time * seed.z + look.y;
          // Each spark circles the creature just inside the rune circle while rising, then fades and starts again low.
          float rise = fract(time * 0.16 + seed.y + look.y * 0.13);
          // Just outside the rune circle (a halo's sparks circle the head at its own radius).
          float k = (iSize.w > 0.5 ? 1.0 : 1.12) + flash * 0.3;
          vec3 c = vec3(cos(a) * (L + R * k), R * (0.1 + rise * 1.55), sin(a) * R * k);
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(c, 1.0);
          float sc = length((modelMatrix * instanceMatrix)[0].xyz);
          float tw = 0.75 + 0.25 * sin(time * 4.0 + seed.x * 7.0);
          mv.xy += corner * R * sc * 0.085 * tw * (1.0 + flash * 0.8);
          vC = corner;
          vA = sin(rise * 3.14159) * (mix(${SPARK[0]}, ${SPARK[1]}, look.w) + flash * 0.8);
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

/** Instances the batch meshes hold before they grow. */
const START_CAPACITY = 16;

interface Live {
  root: THREE.Group;
  /** Size asked for: half length of the straight run and radius, in the shield root's frame. */
  L: number;
  r: number;
  phase: number;
  flash: number;
  /** Eased towards 1 while this is the current target's shield. */
  focus: number;
}

/** The current target's object (see `setShieldFocus`). */
let focusRoot: THREE.Object3D | null = null;
let lastT = -1;

/**
 * Marks the shield inside `root` (the target creature's model root, a balaur head, or a convoy's root) as the current
 * target: its rune circle shows at full strength, every other shield stays calm. `null` calms them all.
 */
export function setShieldFocus(root: THREE.Object3D | null) {
  focusRoot = root;
}

/** Every live shield, drawn by one instanced mesh for the circles and one for the sparks. */
const live: Live[] = [];
let capacity = 0;
let rings: THREE.InstancedMesh | null = null;
let sparks: THREE.InstancedMesh | null = null;
let sizeAttr: THREE.InstancedBufferAttribute;
let lookAttr: THREE.InstancedBufferAttribute;

/** (Re)builds the two batch meshes with room for `n` shields; the instance matrix and attributes are shared. */
function grow(n: number) {
  const { ring, spark } = materials();
  const scene = rings?.parent ?? null;
  rings?.removeFromParent();
  sparks?.removeFromParent();
  rings?.geometry.dispose();
  sparks?.geometry.dispose();
  rings?.dispose();
  capacity = n;
  sizeAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
  lookAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const rg = new THREE.BufferGeometry();
  rg.index = floorGeo.index;
  for (const k in floorGeo.attributes) rg.setAttribute(k, floorGeo.attributes[k]);
  const sg = new THREE.BufferGeometry();
  sg.index = sparkGeo.index;
  for (const k in sparkGeo.attributes) sg.setAttribute(k, sparkGeo.attributes[k]);
  for (const g of [rg, sg]) {
    g.setAttribute('iSize', sizeAttr);
    g.setAttribute('iLook', lookAttr);
  }
  rings = new THREE.InstancedMesh(rg, ring, n);
  sparks = new THREE.InstancedMesh(sg, spark, n);
  rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sparks.instanceMatrix = rings.instanceMatrix;
  rings.renderOrder = 2;
  sparks.renderOrder = 6;
  for (const m of [rings, sparks]) {
    m.name = 'shields';
    m.frustumCulled = false;
    m.count = 0;
    m.visible = false;
    if (scene) scene.add(m);
  }
}

/**
 * Advances the turning glyphs, the breathing glow and the orbiting sparks on every shield, and packs the live shields
 * into the batch meshes. Call it once per frame after the creatures have moved (it refreshes their world matrices).
 * Shields whose root has left the scene (popped, or the creature removed) are dropped here.
 */
export function tickBubbles(t: number) {
  time.value = t;
  const dt = lastT < 0 ? 0 : Math.min(0.1, Math.max(0, t - lastT));
  lastT = t;
  if (live.length > capacity) grow(Math.max(START_CAPACITY, capacity * 2, live.length));
  let n = 0;
  let scene: THREE.Object3D | null = null;
  for (let i = 0; i < live.length; i++) {
    const b = live[i];
    // Walk up to the scene: a shield is drawn while every ancestor is visible, and dropped once it is detached.
    let o: THREE.Object3D = b.root;
    let shown = o.visible;
    let focused = o === focusRoot;
    while (o.parent) {
      o = o.parent;
      if (!o.visible) shown = false;
      if (o === focusRoot) focused = true;
    }
    if (!(o as THREE.Scene).isScene) {
      live[i] = live[live.length - 1];
      live.pop();
      i--;
      continue;
    }
    scene = o;
    if (!shown) continue;
    b.focus += ((focused ? 1 : 0) - b.focus) * Math.min(1, dt * 8);
    b.root.updateWorldMatrix(true, false);
    rings!.setMatrixAt(n, b.root.matrixWorld);
    // A creature standing high above the floor (a balaur head on its neck: its parent sits well above y = 0) gets an
    // upright halo around the head; everything else a circle on its floor, kept there even when the shield is lifted
    // around a hovering body. The circle sits just outside the body (0.76 r; the halo clears the head at 1.05 r).
    const upright = !b.L && (b.root.parent?.matrixWorld.elements[13] ?? 0) > 0.5;
    const R = b.r * (upright ? 1.05 : 0.76);
    if (upright) sizeAttr.setXYZW(n, 0, R, b.r * 0.8, 1);
    else sizeAttr.setXYZW(n, b.L, R, 0.03 - b.root.position.y, 0);
    // Glyph tiles (12 runes each) around the outline: about 26 on a single creature's circle.
    lookAttr.setXYZW(n, b.flash, b.phase, Math.max(1, Math.round((4 * b.L + 2 * Math.PI * R) / (R * 2.9))), b.focus);
    n++;
  }
  if (!rings || !sparks) return;
  if (scene && rings.parent !== scene) {
    scene.add(rings);
    scene.add(sparks);
  }
  rings.count = sparks.count = n;
  rings.visible = sparks.visible = n > 0;
  if (n > 0) {
    rings.instanceMatrix.clearUpdateRanges();
    rings.instanceMatrix.addUpdateRange(0, n * 16);
    rings.instanceMatrix.needsUpdate = true;
    sizeAttr.clearUpdateRanges();
    sizeAttr.addUpdateRange(0, n * 4);
    sizeAttr.needsUpdate = true;
    lookAttr.clearUpdateRanges();
    lookAttr.addUpdateRange(0, n * 4);
    lookAttr.needsUpdate = true;
  }
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
 * creature), the circle stays on the floor under it and the sparks rise around the lifted body. Add `root` to the
 * creature; removing it from the scene (directly or with the creature) removes the shield.
 */
export function makeBubble(r: number, w = r): Bubble {
  if (!rings) grow(START_CAPACITY);
  const root = new THREE.Group();
  const b: Live = {
    root,
    L: Math.max(0, w - r),
    r,
    phase: Math.random() * 10,
    flash: 0,
    focus: 0,
  };
  live.push(b);
  return {
    root,
    hit() {
      b.flash = 1;
    },
    update(dt) {
      b.flash = Math.max(0, b.flash - dt * 3);
    },
  };
}
