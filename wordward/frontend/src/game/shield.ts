// The rune shield every creature wears first (the word you read is written on it; typing it pops the shield).
//
// A softly glowing golden dome around the creature with a slowly turning band of glowing rune glyphs at its foot.
// Both parts are additive, so they brighten whatever is behind them instead of hiding it. Two draw calls per shield,
// with geometry, materials and the rune texture shared by every shield; the per-shield values (hit flash, how far a
// sentence shield is stretched) are pushed as uniforms just before each draw.

import * as THREE from 'three';

const domeGeo = new THREE.SphereGeometry(1, 32, 18);
domeGeo.userData.shared = true;
/** An open band, slightly narrower at the top, in units of the shield radius; its foot sits just above the floor. */
const bandGeo = new THREE.CylinderGeometry(0.96, 1.05, 0.42, 64, 1, true).translate(0, 0.22, 0);
bandGeo.userData.shared = true;

const time = { value: 0 };
let domeMat: THREE.ShaderMaterial | null = null;
let bandMat: THREE.ShaderMaterial | null = null;

/** A strip of procedural rune glyphs: golden strokes with a glow, between two thin rules. Tiles horizontally. */
function runeTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#fff2c4';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.shadowColor = '#ffb93c';
  g.shadowBlur = 14;
  // Thin rules above and below the glyphs, with a small diamond between each pair of runes.
  g.lineWidth = 3;
  for (const y of [14, H - 14]) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const N = 9;
  const cell = W / N;
  g.lineWidth = 8;
  for (let i = 0; i < N; i++) {
    const cx = cell * (i + 0.5);
    const top = 30;
    const bot = H - 30;
    const hw = cell * 0.2;
    g.beginPath();
    // Every rune has a stave; then two or three branches, hooks or a closed loop.
    g.moveTo(cx, top);
    g.lineTo(cx, bot);
    const marks = 2 + Math.floor(rnd() * 2);
    for (let m = 0; m < marks; m++) {
      const y0 = top + rnd() * (bot - top) * 0.7;
      const side = rnd() < 0.5 ? -1 : 1;
      const kind = rnd();
      if (kind < 0.45) {
        g.moveTo(cx, y0);
        g.lineTo(cx + side * hw, y0 + (rnd() < 0.5 ? -1 : 1) * hw * 0.8);
      } else if (kind < 0.75) {
        g.moveTo(cx, y0);
        g.lineTo(cx + side * hw, y0 + hw * 0.6);
        g.lineTo(cx, y0 + hw * 1.2);
      } else {
        g.moveTo(cx + hw * 0.55, y0 + hw * 0.5);
        g.arc(cx, y0 + hw * 0.5, hw * 0.55, 0, Math.PI * 2);
      }
    }
    g.stroke();
    // A diamond on the rules between runes.
    const dx = cell * (i + 1);
    g.beginPath();
    g.moveTo(dx, H / 2 - 9);
    g.lineTo(dx + 6, H / 2);
    g.lineTo(dx, H / 2 + 9);
    g.lineTo(dx - 6, H / 2);
    g.closePath();
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

const VERT = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying vec3 vP; varying vec2 vUv;
  void main() {
    vP = position;
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

function materials() {
  if (!domeMat || !bandMat) {
    domeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { time, flash: { value: 0 } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform float time; uniform float flash;
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
          // Bright golden rim, a faint fill, and slow shimmer bands rising over the skin.
          float rim = pow(f, 3.0);
          float shimmer = smoothstep(0.75, 1.0, sin(vP.y * 9.0 - time * 1.6 + sin(atan(vP.z, vP.x) * 3.0) * 0.6));
          float a = rim * 0.42 + pow(f, 1.5) * 0.04 + shimmer * (0.015 + f * 0.06) * (1.0 - vP.y * vP.y);
          // On a hit: a flash and a bright ring running down from the top.
          float ring = exp(-pow((1.0 - vP.y) * 0.5 - (1.0 - flash), 2.0) * 90.0) * flash;
          a += flash * 0.1 + ring * 0.7;
          vec3 c = mix(vec3(1.0, 0.55, 0.12), vec3(1.0, 0.85, 0.5), clamp(rim + ring, 0.0, 1.0));
          gl_FragColor = vec4(c * a, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const runes = runeTexture();
    bandMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { time, flash: { value: 0 }, rep: { value: 1 }, runes: { value: runes } },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform float time; uniform float flash; uniform float rep; uniform sampler2D runes;
        varying vec2 vUv;
        void main() {
          vec4 r = texture2D(runes, vec2(vUv.x * rep + time * 0.025, vUv.y));
          // The far side of the band shows through, dimmer.
          float a = r.a * 1.6 * (gl_FrontFacing ? 1.0 : 0.4) * (1.0 + flash * 1.5);
          // A soft glow strip behind the glyphs, fading at the top and bottom edges.
          a += 0.06 * sin(vUv.y * 3.14159) * (gl_FrontFacing ? 1.0 : 0.5);
          gl_FragColor = vec4(vec3(1.0, 0.78, 0.36) * a, 1.0);
          #include <colorspace_fragment>
        }`,
    });
  }
  return { dome: domeMat, band: bandMat! };
}

/** Advances the shimmer and the turning runes on every shield. */
export function tickBubbles(t: number) {
  time.value = t;
}

export interface Bubble {
  root: THREE.Group;
  /** Ripple and flash after a letter hits it. */
  hit(): void;
  update(dt: number, t: number): void;
}

/**
 * A rune shield of radius `r` around a creature whose origin is on the floor (or a balaur head's chin), stretched to
 * half-width `w` for a sentence convoy. The dome (0.88 r) has its centre at 0.75 of its radius, so its foot is just under the origin.
 */
export function makeBubble(r: number, w = r): Bubble {
  const { dome, band } = materials();
  const root = new THREE.Group();
  const shell = new THREE.Group();
  // Drawn a little inside the nominal radius, so neighbouring shields overlap less.
  const R = r * 0.88;
  const W = w - (r - R);
  shell.position.y = R * 0.75;
  shell.scale.set(W, R, R * 0.95);
  root.add(shell);
  const skin = new THREE.Mesh(domeGeo, dome);
  skin.renderOrder = 5;
  shell.add(skin);
  const ring = new THREE.Mesh(bandGeo, band);
  ring.scale.set(W, R, R * 0.95);
  ring.renderOrder = 6;
  root.add(ring);

  let flash = 0;
  let wobble = 0;
  const rep = Math.max(1, Math.round(w / r));
  // Per-shield uniforms on shared materials: set just before this mesh draws, and force the upload.
  skin.onBeforeRender = () => {
    dome.uniforms.flash.value = flash;
    dome.uniformsNeedUpdate = true;
  };
  ring.onBeforeRender = () => {
    band.uniforms.flash.value = flash;
    band.uniforms.rep.value = rep;
    band.uniformsNeedUpdate = true;
  };
  const phase = Math.random() * 10;
  return {
    root,
    hit() {
      flash = 1;
      wobble = 1;
    },
    update(dt, t) {
      flash = Math.max(0, flash - dt * 3.5);
      wobble = Math.max(0, wobble - dt * 4);
      const k = Math.sin(t * 30) * wobble * 0.06;
      const breathe = Math.sin(t * 2 + phase) * 0.015;
      root.scale.set(1 + k + breathe, 1 - k + breathe, 1 + k + breathe);
    },
  };
}
