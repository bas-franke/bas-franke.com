// Short-lived magical effects for the dusk library: a green laser with a white-hot core, golden letter glyphs and
// sparks flying off the hit point, teal ink splashes when a creature is defeated, a golden rune ring when a bubble
// shield pops, and dust with a red flash when something reaches the defenders.
//
// Cost: every sprite-like particle (glows, sparkles, glyphs, droplets, dust) is drawn by one of two instanced
// billboard batches over a single canvas atlas (one additive draw call, one alpha-blended draw call, whatever the
// number of particles). Only the laser tubes (3 calls per live beam) and the ink splats on the floor (1 call each)
// are separate meshes. Particle records and meshes are pooled; `update` allocates nothing. y is up, the floor is y = 0.

import * as THREE from 'three';

type Kind = 'flash' | 'glyph' | 'spark' | 'twinkle' | 'drop' | 'ring' | 'puff';

interface Particle {
  kind: Kind;
  /** Atlas cell. */
  cell: number;
  additive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.Color;
  age: number;
  life: number;
  size: number;
  rot: number;
  spin: number;
  drag: number;
  grav: number;
  alpha: number;
  /** Stretch along the on-screen velocity (0 = round): sparks become streaks, droplets get a motion tail. */
  stretch: number;
}

interface MeshFx {
  kind: 'beam' | 'splat';
  obj: THREE.Object3D;
  /** Beam fade uniform (shared by its three tubes) or the splat's material. */
  fade?: { value: number };
  mat?: THREE.MeshBasicMaterial;
  color: number;
  age: number;
  life: number;
  size: number;
}

/** The laser colour (a bright spring green). */
export const LASER = 0x9cff4c;
/** Kept for callers that pass it: the old pink beam colour is drawn as the laser green. */
export const BEAM = 0xff6fb5;
/** The old shield-hit beam colour, also drawn as the laser (the reference has one green laser). */
const SHIELD_BEAM = 0x5fd0ff;
const GOLD = 0xffbf55;
const INK_TEAL = 0x0f4a55;
const DUST = 0xcdb08a;
const LETTERS = 'abcdefghijklmnopqrstuvwxyzăâîșț';

const UP = new THREE.Vector3(0, 1, 0);
const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0);
const splatGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

// ---- atlas --------------------------------------------------------------------------------------------------------

const CELL = 128;
const CELLS = 8;
const C_GLOW = 0;
const C_TWINKLE = 1;
const C_RING = 2;
const C_RUNE = 3;
const C_DROP = 4;
const C_PUFF = 5;
const C_STREAK = 6;
const C_LETTER = 8;

/** Tiny deterministic random, so textures look the same every run. */
function seeded(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

let atlas: THREE.CanvasTexture | null = null;
let splatTex: THREE.CanvasTexture | null = null;

/** Draws `draw` into atlas cell `i`, in a local frame where the cell is `CELL` px with its centre at the origin. */
function inCell(g: CanvasRenderingContext2D, i: number, draw: (g: CanvasRenderingContext2D, h: number) => void) {
  g.save();
  g.translate((i % CELLS) * CELL + CELL / 2, Math.floor(i / CELLS) * CELL + CELL / 2);
  g.beginPath();
  g.rect(-CELL / 2 + 1, -CELL / 2 + 1, CELL - 2, CELL - 2);
  g.clip();
  draw(g, CELL / 2 - 4);
  g.restore();
}

function radial(g: CanvasRenderingContext2D, r: number, stops: [number, string][]) {
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
  for (const [o, c] of stops) grad.addColorStop(o, c);
  g.fillStyle = grad;
  g.fillRect(-r, -r, r * 2, r * 2);
}

function buildAtlas() {
  const c = document.createElement('canvas');
  c.width = c.height = CELL * CELLS;
  const g = c.getContext('2d')!;
  // Soft halo with a brighter core.
  inCell(g, C_GLOW, (g, h) => {
    const stops: [number, string][] = [];
    for (let i = 0; i <= 10; i++) {
      const r = i / 10;
      const a = Math.exp(-r * r * 5) * (1 - r) + 0.4 * Math.exp(-r * r * 50);
      stops.push([r, `rgba(255,255,255,${Math.min(1, a).toFixed(3)})`]);
    }
    radial(g, h, stops);
  });
  // Four-pointed sparkle: crossed streaks over a small core.
  inCell(g, C_TWINKLE, (g, h) => {
    radial(g, h * 0.5, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]);
    g.globalCompositeOperation = 'lighter';
    for (const [len, w] of [[h, 5], [h * 0.5, 3]]) {
      for (let k = 0; k < 2; k++) {
        g.save();
        g.rotate(k * Math.PI / 2 + (len < h ? Math.PI / 4 : 0));
        const lg = g.createLinearGradient(-len, 0, len, 0);
        lg.addColorStop(0, 'rgba(255,255,255,0)');
        lg.addColorStop(0.5, 'rgba(255,255,255,1)');
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = lg;
        g.beginPath();
        g.moveTo(-len, 0);
        g.quadraticCurveTo(0, -w, len, 0);
        g.quadraticCurveTo(0, w, -len, 0);
        g.fill();
        g.restore();
      }
    }
  });
  // A soft thin ring.
  inCell(g, C_RING, (g, h) =>
    radial(g, h, [[0, 'rgba(255,255,255,0)'], [0.62, 'rgba(255,255,255,0)'], [0.78, 'rgba(255,255,255,0.95)'], [0.86, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]),
  );
  // Golden rune circle: a double ring with little carved runes between, glowing.
  inCell(g, C_RUNE, (g, h) => {
    const rnd = seeded(7);
    g.strokeStyle = '#ffe6a8';
    g.shadowColor = '#ffa524';
    g.shadowBlur = 6;
    g.lineCap = 'round';
    g.lineWidth = 2.5;
    g.beginPath();
    g.arc(0, 0, h * 0.9, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 1.6;
    g.beginPath();
    g.arc(0, 0, h * 0.66, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 2;
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      g.save();
      g.translate(Math.cos(a) * h * 0.78, Math.sin(a) * h * 0.78);
      g.rotate(a + Math.PI / 2);
      const k = 5;
      g.beginPath();
      g.moveTo(0, -k);
      g.lineTo(0, k);
      g.moveTo(0, (rnd() - 0.5) * k);
      g.lineTo((rnd() > 0.5 ? 1 : -1) * k * 0.8, (rnd() - 0.5) * k * 1.6);
      if (rnd() > 0.4) {
        g.moveTo(0, -k * 0.6);
        g.lineTo((rnd() > 0.5 ? 1 : -1) * k * 0.7, -k);
      }
      g.stroke();
      g.restore();
    }
  });
  // A glossy teal ink droplet with a specular dot.
  inCell(g, C_DROP, (g, h) => {
    const body = g.createRadialGradient(-h * 0.25, -h * 0.3, 1, 0, 0, h * 0.9);
    body.addColorStop(0, '#4fc6c4');
    body.addColorStop(0.4, '#17636e');
    body.addColorStop(1, '#06252e');
    g.fillStyle = body;
    g.beginPath();
    g.arc(0, 0, h * 0.86, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.ellipse(-h * 0.32, -h * 0.38, h * 0.2, h * 0.13, -0.6, 0, Math.PI * 2);
    g.fill();
  });
  // A soft cloudy puff.
  inCell(g, C_PUFF, (g, h) => {
    const rnd = seeded(5);
    for (let i = 0; i < 8; i++) {
      g.save();
      g.translate((rnd() - 0.5) * h * 0.8, (rnd() - 0.5) * h * 0.8);
      radial(g, h * (0.35 + rnd() * 0.25), [[0, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
      g.restore();
    }
  });
  // A thin horizontal streak with a hot middle (stretched along the velocity for sparks).
  inCell(g, C_STREAK, (g, h) => {
    g.save();
    g.scale(1, 0.16);
    radial(g, h, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
    g.restore();
  });
  // Golden glowing letters on transparent black (drawn additively).
  [...LETTERS].forEach((ch, i) =>
    inCell(g, C_LETTER + i, (g, h) => {
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `bold ${Math.round(h * 1.15)}px Georgia, 'Times New Roman', serif`;
      g.shadowColor = '#ff7a00';
      g.shadowBlur = 16;
      g.fillStyle = '#ff9420';
      g.fillText(ch, 0, h * 0.02);
      g.fillText(ch, 0, h * 0.02);
      g.shadowColor = '#ffb030';
      g.shadowBlur = 3;
      g.fillStyle = '#ffd25e';
      g.fillText(ch, 0, h * 0.02);
    }),
  );
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 2;

  // Ink splat (white, tinted by its material): a lumpy blob with satellite droplets and a wet highlight.
  const s = document.createElement('canvas');
  s.width = s.height = 128;
  const q = s.getContext('2d')!;
  const rnd = seeded(31);
  const h = 64;
  q.fillStyle = '#fff';
  q.beginPath();
  const n = 18;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = h * (0.34 + rnd() * 0.12 + (i % 3 === 0 ? 0.12 : 0));
    if (i === 0) q.moveTo(h + Math.cos(a) * r, h + Math.sin(a) * r);
    else q.lineTo(h + Math.cos(a) * r, h + Math.sin(a) * r);
  }
  q.fill();
  for (let i = 0; i < 16; i++) {
    const a = rnd() * Math.PI * 2;
    const d = h * (0.5 + rnd() * 0.44);
    q.beginPath();
    q.arc(h + Math.cos(a) * d, h + Math.sin(a) * d, 1.5 + rnd() * 5 * (1.3 - d / h), 0, Math.PI * 2);
    q.fill();
  }
  q.globalCompositeOperation = 'source-atop';
  const wet = q.createRadialGradient(h * 0.85, h * 0.8, 0, h, h, h * 0.5);
  wet.addColorStop(0, 'rgba(150,255,245,0.5)');
  wet.addColorStop(1, 'rgba(150,255,245,0)');
  q.fillStyle = wet;
  q.fillRect(0, 0, 128, 128);
  splatTex = new THREE.CanvasTexture(s);
  splatTex.colorSpace = THREE.SRGBColorSpace;
}

// ---- billboard batch ----------------------------------------------------------------------------------------------

/** Instanced camera-facing quads over the atlas: one draw call for any number of particles. */
class Batch {
  readonly mesh: THREE.Mesh;
  readonly pos: Float32Array;
  readonly src: Float32Array;
  readonly col: Float32Array;
  readonly vel: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  count = 0;

  constructor(readonly capacity: number, additive: boolean) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new Float32Array(capacity * 3);
    this.src = new Float32Array(capacity * 4);
    this.col = new Float32Array(capacity * 4);
    this.vel = new Float32Array(capacity * 3);
    this.attrs = [
      new THREE.InstancedBufferAttribute(this.pos, 3),
      new THREE.InstancedBufferAttribute(this.src, 4),
      new THREE.InstancedBufferAttribute(this.col, 4),
      new THREE.InstancedBufferAttribute(this.vel, 3),
    ];
    for (const a of this.attrs) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.attrs[0]);
    geo.setAttribute('iSrc', this.attrs[1]);
    geo.setAttribute('iCol', this.attrs[2]);
    geo.setAttribute('iVel', this.attrs[3]);
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: atlas } },
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute vec4 iSrc; // size, rotation, atlas cell, stretch
        attribute vec4 iCol;
        attribute vec3 iVel;
        varying vec2 vUv;
        varying vec4 vCol;
        void main() {
          vec4 mv = modelViewMatrix * vec4( iPos, 1.0 );
          float rot = iSrc.y;
          vec2 p = position.xy * iSrc.x;
          if ( iSrc.w > 0.0 ) {
            // Align with the on-screen velocity and stretch along it.
            vec2 v = ( modelViewMatrix * vec4( iVel, 0.0 ) ).xy;
            float l = length( v );
            if ( l > 1e-3 ) rot = atan( v.y, v.x );
            p.x *= 1.0 + iSrc.w * l;
          }
          float c = cos( rot ), s = sin( rot );
          mv.xy += vec2( c * p.x - s * p.y, s * p.x + c * p.y );
          gl_Position = projectionMatrix * mv;
          float col = mod( iSrc.z, ${CELLS}.0 );
          float row = floor( iSrc.z / ${CELLS}.0 + 0.001 );
          vUv = vec2( ( col + position.x + 0.5 ) / ${CELLS}.0, 1.0 - ( row + 0.5 - position.y ) / ${CELLS}.0 );
          vCol = iCol;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec2 vUv;
        varying vec4 vCol;
        void main() {
          vec4 t = texture2D( map, vUv );
          gl_FragColor = vec4( vCol.rgb * t.rgb, t.a * vCol.a );
          if ( gl_FragColor.a < 0.004 ) discard;
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: !additive,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 20 : 5;
    // Stays visible even when empty: three still binds the program (so it compiles with the first frame, not with
    // the first hit) but skips the zero-instance draw.
  }

  push(p: Particle, size: number, rot: number, alpha: number) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.pos[i * 3] = p.pos.x;
    this.pos[i * 3 + 1] = p.pos.y;
    this.pos[i * 3 + 2] = p.pos.z;
    this.src[i * 4] = size;
    this.src[i * 4 + 1] = rot;
    this.src[i * 4 + 2] = p.cell;
    this.src[i * 4 + 3] = p.stretch;
    this.vel[i * 3] = p.vel.x;
    this.vel[i * 3 + 1] = p.vel.y;
    this.vel[i * 3 + 2] = p.vel.z;
    this.col[i * 4] = p.color.r;
    this.col[i * 4 + 1] = p.color.g;
    this.col[i * 4 + 2] = p.color.b;
    this.col[i * 4 + 3] = alpha;
  }

  flush() {
    const geo = this.mesh.geometry as THREE.InstancedBufferGeometry;
    geo.instanceCount = this.count;
    if (!this.count) return;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
  }
}

// ---- beam shader --------------------------------------------------------------------------------------------------

/** An additive tube that fades towards its silhouette (N·V falloff), so a cylinder reads as a soft beam of light. */
function tubeMaterial(color: number, intensity: number, power: number, fade: { value: number }) {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color).multiplyScalar(intensity) }, power: { value: power }, fade },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vN = normalize( normalMatrix * normal );
        vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float power;
      uniform float fade;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float f = pow( abs( dot( normalize( vN ), normalize( vV ) ) ), power );
        gl_FragColor = vec4( color * ( f * fade ), 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

// ---- effects ------------------------------------------------------------------------------------------------------

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const MAX_PARTICLES = 600;

export class Effects {
  /** Holds every effect object; stays in the scene so spawning never touches the scene graph. */
  readonly root = new THREE.Group();
  private readonly glow: Batch;
  private readonly soft: Batch;
  private particles: Particle[] = [];
  private freeParticles: Particle[] = [];
  private meshes: MeshFx[] = [];
  private freeMeshes = new Map<string, MeshFx[]>();
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene) {
    if (!atlas) buildAtlas();
    this.glow = new Batch(MAX_PARTICLES, true);
    this.soft = new Batch(MAX_PARTICLES, false);
    this.root.name = 'effects';
    this.root.add(this.soft.mesh, this.glow.mesh);
    scene.add(this.root);
  }

  // ---- pooling ----

  private particle(kind: Kind, cell: number, additive: boolean, at: THREE.Vector3, color: number): Particle {
    let p = this.freeParticles.pop();
    if (!p) {
      p = { kind, cell, additive, pos: new THREE.Vector3(), vel: new THREE.Vector3(), color: new THREE.Color(), age: 0, life: 1, size: 1, rot: 0, spin: 0, drag: 0, grav: 0, alpha: 1, stretch: 0 };
    }
    p.kind = kind;
    p.cell = cell;
    p.additive = additive;
    p.pos.copy(at);
    p.vel.set(0, 0, 0);
    p.color.setHex(color);
    p.age = p.rot = p.spin = p.drag = p.grav = p.stretch = 0;
    p.life = p.size = p.alpha = 1;
    // Past the cap the oldest-living slot is recycled rather than growing without bound.
    if (this.particles.length >= MAX_PARTICLES) this.freeParticles.push(this.particles.shift()!);
    this.particles.push(p);
    return p;
  }

  private mesh(key: string, kind: MeshFx['kind'], color: number, make: () => Pick<MeshFx, 'obj' | 'fade' | 'mat'>): MeshFx {
    let m = this.freeMeshes.get(key)?.pop();
    if (!m) {
      m = { kind, color, age: 0, life: 1, size: 1, ...make() };
      this.root.add(m.obj);
    }
    m.age = 0;
    m.obj.visible = true;
    this.meshes.push(m);
    return m;
  }

  // ---- public effects ----

  /** The laser from `from` to `to`: a white-hot core in a green glow, with a muzzle flash and a bright impact flash. */
  beam(from: THREE.Vector3, to: THREE.Vector3, color = LASER) {
    if (color === BEAM || color === SHIELD_BEAM) color = LASER;
    const m = this.mesh(`beam${color}`, 'beam', color, () => {
      const fade = { value: 1 };
      const g = new THREE.Group();
      const outer = new THREE.Mesh(tubeGeo, tubeMaterial(color, 0.55, 2.6, fade));
      outer.scale.set(0.32, 1, 0.32);
      const mid = new THREE.Mesh(tubeGeo, tubeMaterial(color, 1.5, 0.9, fade));
      mid.scale.set(0.09, 1, 0.09);
      const core = new THREE.Mesh(tubeGeo, tubeMaterial(0xf8ffe0, 2.6, 0.35, fade));
      core.scale.set(0.035, 1, 0.035);
      for (const t of [outer, mid, core]) {
        t.renderOrder = 19;
        t.frustumCulled = false;
      }
      g.add(outer, mid, core);
      return { obj: g, fade };
    });
    const dir = this.tmp.subVectors(to, from);
    const len = dir.length();
    m.obj.position.copy(from);
    m.obj.quaternion.setFromUnitVectors(UP, dir.multiplyScalar(1 / Math.max(len, 1e-4)));
    m.obj.scale.set(1, len, 1);
    m.life = 0.17;
    this.flash(from, 1.3, color, 0.16);
    this.flash(to, 1.5, 0x9ac860, 0.2);
    this.star(to, 1.8, 0xd8c890, 0.2);
  }

  /** A soft additive glow that swells and fades in place. */
  flash(at: THREE.Vector3, size: number, color: number, life = 0.25) {
    const p = this.particle('flash', C_GLOW, true, at, color);
    p.size = size;
    p.life = life;
  }

  /** One four-pointed sparkle that grows, turns and fades in place. */
  star(at: THREE.Vector3, size: number, color: number, life = 0.35) {
    const p = this.particle('twinkle', C_TWINKLE, true, at, color);
    p.size = size;
    p.life = life;
    p.rot = Math.random() * 0.6;
    p.spin = rand(-2, 2);
  }

  /**
   * A letter was hit: golden glowing glyphs and sparks fly out of `at`. `letters` picks the glyphs (e.g. the letter
   * just typed, or the word); random letters otherwise.
   */
  sparkles(at: THREE.Vector3, count = 5, speed = 5, size = 0.22, letters?: string) {
    for (let i = 0; i < count; i++) {
      const src = letters || LETTERS;
      this.glyph(at, src[(Math.random() * src.length) | 0], speed, size * 6.5);
      this.spark(at, GOLD, speed * 1.6, size * 1.4);
      this.spark(at, 0xfff0b0, speed * 2, size * 1.1);
    }
  }

  /** One golden letter flying out of `at`, floating up and fading. Unknown characters fall back to a random letter. */
  glyph(at: THREE.Vector3, ch: string, speed = 4, size = 1) {
    let i = LETTERS.indexOf(ch.toLowerCase());
    if (i < 0) i = (Math.random() * 26) | 0;
    const p = this.particle('glyph', C_LETTER + i, true, at, 0xffffff);
    const a = Math.random() * Math.PI * 2;
    const h = speed * rand(0.6, 1.1);
    p.vel.set(Math.cos(a) * h, speed * rand(0.4, 0.9), Math.sin(a) * h);
    p.grav = 4;
    p.drag = 1.8;
    p.size = size * rand(0.8, 1.15);
    p.life = rand(0.65, 0.95);
    p.rot = rand(-0.4, 0.4);
  }

  private spark(at: THREE.Vector3, color: number, speed: number, size: number) {
    const p = this.particle('spark', C_STREAK, true, at, color);
    const a = Math.random() * Math.PI * 2;
    const h = speed * rand(0.4, 1);
    p.vel.set(Math.cos(a) * h, speed * rand(0.3, 1), Math.sin(a) * h);
    p.grav = 12;
    p.drag = 1.5;
    p.size = size * rand(0.7, 1.3);
    p.life = rand(0.3, 0.55);
    p.stretch = 0.35;
  }

  /** A glowing ring that expands and fades, facing the camera. */
  ring(at: THREE.Vector3, size: number, color: number, life = 0.35) {
    const p = this.particle('ring', C_RING, true, at, color);
    p.size = size;
    p.life = life;
  }

  private rune(at: THREE.Vector3, size: number, life: number) {
    const p = this.particle('ring', C_RUNE, true, at, 0xffffff);
    p.size = size;
    p.life = life;
    p.spin = rand(1.5, 2.5) * (Math.random() > 0.5 ? 1 : -1);
  }

  private drop(at: THREE.Vector3, speed: number, size: number) {
    const p = this.particle('drop', C_DROP, false, at, 0xffffff);
    const a = Math.random() * Math.PI * 2;
    const h = speed * rand(0.3, 1);
    p.vel.set(Math.cos(a) * h, speed * rand(0.4, 1.1), Math.sin(a) * h);
    p.grav = 22;
    p.size = size * rand(0.5, 1.2);
    p.life = rand(0.8, 1.1);
    p.stretch = 0.025;
  }

  private splat(x: number, z: number, size: number) {
    const m = this.mesh('splat', 'splat', INK_TEAL, () => {
      const mat = new THREE.MeshBasicMaterial({
        map: splatTex,
        color: INK_TEAL,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const obj = new THREE.Mesh(splatGeo, mat);
      obj.renderOrder = 2;
      return { obj, mat };
    });
    m.obj.position.set(x, 0.03, z);
    m.obj.rotation.y = Math.random() * Math.PI * 2;
    m.size = size;
    m.life = 1.8;
  }

  private puff(at: THREE.Vector3, color: number, size: number, vx: number, vy: number, vz: number, life: number) {
    const p = this.particle('puff', C_PUFF, false, at, color);
    p.vel.set(vx, vy, vz);
    p.drag = 3;
    p.size = size;
    p.life = life;
    p.alpha = 0.9;
    p.rot = Math.random() * 6;
    p.spin = rand(-1, 1);
  }

  /** A creature is defeated: it bursts into teal ink (droplets and a splat on the floor) with a soft golden sparkle. */
  poof(at: THREE.Vector3, size = 1.2, _color = 0xffffff) {
    const s = Math.max(0.6, size);
    this.flash(at, s * 2.4, 0x3fa8a8, 0.28);
    this.flash(at, s * 1.1, 0xfff0c0, 0.16);
    this.splat(at.x, at.z, s * 2.4);
    const drops = Math.round(10 + s * 3);
    for (let i = 0; i < drops; i++) this.drop(at, 4 + s * 2.2, 0.36 * s);
    for (let i = 0; i < 6; i++) {
      this.tmp.set(at.x + rand(-1, 1) * s, at.y + rand(-0.4, 0.8) * s, at.z + rand(-1, 1) * s);
      this.star(this.tmp, s * rand(0.8, 1.3), 0xffe2a0, rand(0.35, 0.6));
    }
    for (let i = 0; i < 8; i++) this.spark(at, GOLD, 5 * s, 0.3 * s);
    for (let i = 0; i < 3; i++) this.glyph(at, LETTERS[(Math.random() * 26) | 0], 3.5, 1.1);
  }

  /** A bubble shield pops: a spinning golden rune circle bursts outward with a ring of sparks. */
  pop(at: THREE.Vector3, size: number) {
    this.rune(at, size * 2.8, 0.55);
    this.ring(at, size * 2.1, GOLD, 0.3);
    this.flash(at, size * 2.4, 0xffd98a, 0.25);
    for (let i = 0; i < 14; i++) this.spark(at, i % 3 ? GOLD : 0xbff1ff, 6 + size, 0.32);
  }

  /** Something reached the defenders: dust clouds rolling out sideways and a red flash. */
  dust(at: THREE.Vector3, size = 1.6) {
    this.flash(at, size * 4, 0xff1e10, 0.5);
    this.flash(at, size * 1.6, 0xff6a3a, 0.25);
    for (let i = 0; i < 8; i++) {
      const side = i % 2 ? 1 : -1;
      this.tmp.set(at.x + side * (0.2 + i * 0.12), at.y, at.z + rand(-0.3, 0.3));
      this.puff(this.tmp, DUST, size * rand(0.8, 1.2), side * rand(1.5, 4), rand(0.8, 2), rand(-0.8, 0.8), rand(0.6, 0.85));
    }
    for (let i = 0; i < 6; i++) this.spark(at, 0xff9a4a, 5, 0.26);
  }

  /**
   * Compiles the laser and ink-splat materials up front (the particle batches compile with the first frame anyway),
   * so the first hit does not stutter. Uses parallel compile where the browser supports it. Call once after setup.
   */
  prewarm(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    const o = new THREE.Vector3(0, -1000, 0);
    this.beam(o, new THREE.Vector3(0, -999, 0));
    this.splat(0, 0, 1);
    void renderer.compileAsync(this.root, camera, this.scene).catch(() => {});
    this.clear();
  }

  update(dt: number) {
    const meshes = this.meshes;
    for (let i = meshes.length - 1; i >= 0; i--) {
      const m = meshes[i];
      m.age += dt;
      const k = m.age / m.life;
      if (k >= 1) {
        meshes[i] = meshes[meshes.length - 1];
        meshes.pop();
        m.obj.visible = false;
        const key = m.kind === 'beam' ? `beam${m.color}` : 'splat';
        let pool = this.freeMeshes.get(key);
        if (!pool) this.freeMeshes.set(key, (pool = []));
        pool.push(m);
        continue;
      }
      if (m.kind === 'beam') {
        const w = 1 - k * k;
        m.obj.scale.x = m.obj.scale.z = w * (0.9 + 0.1 * Math.sin(m.age * 90));
        m.fade!.value = 1 - k;
      } else {
        const s = m.size * (k < 0.08 ? 0.4 + (k / 0.08) * 0.6 : 1);
        m.obj.scale.set(s, 1, s);
        m.mat!.opacity = 0.85 * (k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
      }
    }

    this.glow.count = this.soft.count = 0;
    const ps = this.particles;
    let n = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        this.freeParticles.push(p);
        continue;
      }
      ps[n++] = p;
      if (p.grav || p.drag || p.vel.x || p.vel.y || p.vel.z) {
        if (p.drag) p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
        p.vel.y -= p.grav * dt;
        p.pos.addScaledVector(p.vel, dt);
      }
      p.rot += p.spin * dt;
      let s = p.size;
      let a = 1;
      let rot = p.rot;
      switch (p.kind) {
        case 'flash':
          s *= 0.55 + 0.45 * Math.sqrt(k);
          a = (1 - k) * (1 - k);
          break;
        case 'twinkle':
          s *= Math.sin(Math.min(1, k * 1.2) * Math.PI);
          break;
        case 'glyph':
          s *= k < 0.12 ? 0.5 + (k / 0.12) * 0.5 : 1 - (k - 0.12) * 0.35;
          rot += Math.sin(p.age * 3.5 + p.size * 7) * 0.3;
          a = k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45;
          break;
        case 'spark':
          s *= 1 - k;
          break;
        case 'drop':
          // Lands on the floor and soaks in.
          if (p.pos.y < 0.06 && p.vel.y < 0) {
            p.pos.y = 0.06;
            p.vel.set(0, 0, 0);
            p.grav = 0;
            p.stretch = 0;
          }
          if (k > 0.7) s *= 1 - (k - 0.7) / 0.3;
          break;
        case 'ring':
          s *= 0.35 + 0.75 * (1 - (1 - k) * (1 - k));
          a = 1 - k * k;
          break;
        case 'puff':
          s *= 0.45 + 0.75 * Math.sqrt(k);
          a = p.alpha * (1 - k) * Math.min(1, k * 8);
          break;
      }
      (p.additive ? this.glow : this.soft).push(p, s, rot, a);
    }
    ps.length = n;
    this.glow.flush();
    this.soft.flush();
  }

  clear() {
    for (const p of this.particles) this.freeParticles.push(p);
    this.particles.length = 0;
    for (const m of this.meshes) m.age = m.life;
    this.update(0);
  }
}
