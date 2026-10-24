// Short-lived magical effects for the dusk library: a slim green laser with a small white-hot impact, crisp golden
// letter glyphs and sparks flying off the hit point, dark teal ink droplets (some landing as splats on the floor)
// when a creature is defeated, a golden rune ring when a bubble shield pops, and dust with a red flash when something
// reaches the defenders.
//
// Cost: every sprite-like particle (glows, sparkles, glyphs, droplets, floor splats, dust) is drawn by one of two
// instanced batches over a single canvas atlas, whatever the number of particles:
//  - `glow`: premultiplied blending, no depth test, drawn last. Each particle is either additive light (glows,
//    sparks, rings) or "solid" (glyph letters: an opaque crisp letter body inside an additive warm halo), so letters
//    stay readable on bright floor without a third batch.
//  - `soft`: alpha-blended, depth-tested: ink droplets, puffs, and floor-aligned quads (splats) for ink on the floor.
// Only the laser tubes are separate meshes (3 calls per live beam). A defeat therefore adds at most 5 draw calls
// (2 batches + 3 beam tubes), and empty batches draw nothing. Particle records and meshes are pooled; `update`
// allocates nothing. y is up, the floor is y = 0.

import * as THREE from 'three';

type Kind = 'flash' | 'glyph' | 'spark' | 'twinkle' | 'drop' | 'splat' | 'ring' | 'puff';

interface Particle {
  kind: Kind;
  /** Atlas cell. */
  cell: number;
  additive: boolean;
  /** In the glow batch: the texture's opaque part (alpha > ~0.5) covers what is behind (letter bodies). */
  solid: boolean;
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
  /** Stretch along the on-screen velocity (0 = round): sparks become streaks, droplets get a motion tail. Negative:
   * the quad lies flat on the floor (splats). */
  stretch: number;
}

interface MeshFx {
  kind: 'beam';
  obj: THREE.Object3D;
  /** Beam fade uniform (shared by its three tubes). */
  fade: { value: number };
  color: number;
  age: number;
  life: number;
}

/** The laser colour (a bright spring green). */
export const LASER = 0x9cff4c;
/** Kept for callers that pass it: the old pink beam colour is drawn as the laser green. */
export const BEAM = 0xff6fb5;
/** The old shield-hit beam colour, also drawn as the laser (the reference has one green laser). */
const SHIELD_BEAM = 0x5fd0ff;
const GOLD = 0xffb43c;
const GOLD_PALE = 0xffe2a0;
const INK_TEAL = 0x0d3f48;
const DUST = 0xbfa07a;
const LETTERS = 'abcdefghijklmnopqrstuvwxyzăâîșț';

const UP = new THREE.Vector3(0, 1, 0);
// Tapered: full radius at the muzzle (y = 0), slimmer at the target (y = 1).
const tubeGeo = new THREE.CylinderGeometry(0.55, 1, 1, 10, 1, true).translate(0, 0.5, 0);

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
const C_SPLAT = 7;
const C_LETTER = 8;

/** Tiny deterministic random, so textures look the same every run. */
function seeded(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

let atlas: THREE.CanvasTexture | null = null;

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
  // Soft glow: a tight hot core in a faint halo (small and hot rather than a big blob).
  inCell(g, C_GLOW, (g, h) => {
    const stops: [number, string][] = [];
    for (let i = 0; i <= 12; i++) {
      const r = i / 12;
      const a = 0.55 * Math.exp(-r * r * 7) * (1 - r) + 0.6 * Math.exp(-r * r * 60);
      stops.push([r, `rgba(255,255,255,${Math.min(1, a).toFixed(3)})`]);
    }
    radial(g, h, stops);
  });
  // Four-pointed sparkle: thin crossed streaks over a small core.
  inCell(g, C_TWINKLE, (g, h) => {
    radial(g, h * 0.35, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]);
    g.globalCompositeOperation = 'lighter';
    for (const [len, w] of [[h, 3.5], [h * 0.45, 2]]) {
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
  // A glossy dark teal ink droplet, drawn as a teardrop pointing along +x (the batch turns it along its velocity):
  // a round head with a thin tail behind, a lighter rim and a crisp specular dot.
  inCell(g, C_DROP, (g, h) => {
    const r = h * 0.4;
    g.translate(h * 0.5, 0);
    g.fillStyle = '#0a3840';
    g.beginPath();
    g.moveTo(-h * 1.45, 0);
    g.quadraticCurveTo(-r * 1.3, -r * 0.45, 0, -r * 0.8);
    g.lineTo(0, r * 0.8);
    g.quadraticCurveTo(-r * 1.3, r * 0.45, -h * 1.45, 0);
    g.fill();
    const body = g.createRadialGradient(-r * 0.3, -r * 0.35, 1, 0, 0, r);
    body.addColorStop(0, '#2f8c90');
    body.addColorStop(0.45, '#1d5560');
    body.addColorStop(0.85, '#06262e');
    body.addColorStop(1, '#0b3a42');
    g.fillStyle = body;
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(80,190,190,0.55)';
    g.lineWidth = r * 0.08;
    g.beginPath();
    g.arc(0, 0, r * 0.9, Math.PI * 0.15, Math.PI * 0.85);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath();
    g.ellipse(-r * 0.36, -r * 0.42, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2);
    g.fill();
  });
  // A soft cloudy puff (lobes kept inside the cell, so no square edges).
  inCell(g, C_PUFF, (g, h) => {
    const rnd = seeded(5);
    for (let i = 0; i < 8; i++) {
      g.save();
      g.translate((rnd() - 0.5) * h * 0.6, (rnd() - 0.5) * h * 0.6);
      radial(g, h * (0.3 + rnd() * 0.25), [[0, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
      g.restore();
    }
  });
  // A thin horizontal streak with a hot middle (stretched along the velocity for sparks).
  inCell(g, C_STREAK, (g, h) => {
    g.save();
    g.scale(1, 0.12);
    radial(g, h, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
    g.restore();
  });
  // Ink splat (white, tinted per particle): a lumpy blob with satellite droplets and a wet highlight.
  inCell(g, C_SPLAT, (g, h) => {
    const rnd = seeded(31);
    g.fillStyle = '#fff';
    g.beginPath();
    const n = 18;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = h * (0.34 + rnd() * 0.12 + (i % 3 === 0 ? 0.12 : 0));
      if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.fill();
    for (let i = 0; i < 16; i++) {
      const a = rnd() * Math.PI * 2;
      const d = h * (0.5 + rnd() * 0.44);
      g.beginPath();
      g.arc(Math.cos(a) * d, Math.sin(a) * d, 1.5 + rnd() * 5 * (1.3 - d / h), 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-atop';
    const wet = g.createRadialGradient(-h * 0.15, -h * 0.2, 0, 0, 0, h * 0.5);
    wet.addColorStop(0, 'rgba(190,255,250,1)');
    wet.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = wet;
    g.fillRect(-h, -h, h * 2, h * 2);
  });
  // Golden letters: a thin regular-weight serif letter (opaque: bright amber-gold body over a dark brown outline)
  // inside a soft warm halo. The glow batch draws alpha > ~0.5 as solid and the halo as added light. The halo is
  // drawn on a scratch canvas and its alpha capped under the solid threshold, so a brighter halo never turns into an
  // opaque blob around the letter.
  const halo = document.createElement('canvas');
  halo.width = halo.height = CELL;
  const hg = halo.getContext('2d', { willReadFrequently: true })!;
  [...LETTERS].forEach((ch, i) => {
    const h = CELL / 2 - 4;
    const font = `${Math.round(h * 1.05)}px Georgia, 'Times New Roman', serif`;
    const y = h * 0.04;
    hg.clearRect(0, 0, CELL, CELL);
    hg.save();
    hg.translate(CELL / 2, CELL / 2);
    hg.textAlign = 'center';
    hg.textBaseline = 'middle';
    hg.font = font;
    hg.shadowColor = 'rgba(255,140,25,0.9)';
    hg.fillStyle = 'rgba(255,170,50,0.3)';
    // A tight bright edge glow plus a wider soft one, so the letter shape still reads through its halo.
    hg.shadowBlur = 22;
    hg.fillText(ch, 0, y);
    hg.shadowBlur = 5;
    hg.fillText(ch, 0, y);
    hg.fillText(ch, 0, y);
    hg.restore();
    const img = hg.getImageData(0, 0, CELL, CELL);
    const d = img.data;
    for (let k = 3; k < d.length; k += 4) if (d[k] > 55) d[k] = 55; // ≤ 0.22: a soft glow, never solid
    hg.putImageData(img, 0, 0);
    inCell(g, C_LETTER + i, (g) => {
      g.drawImage(halo, -CELL / 2, -CELL / 2);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = font;
      g.lineJoin = 'round';
      g.lineWidth = 1.5;
      g.strokeStyle = '#7a3a00';
      g.strokeText(ch, 0, y);
      const fill = g.createLinearGradient(0, -h * 0.5, 0, h * 0.5);
      fill.addColorStop(0, '#ffe08a');
      fill.addColorStop(1, '#ff9e2c');
      g.fillStyle = fill;
      g.fillText(ch, 0, y);
    });
  });
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 2;
}

// ---- billboard batch ----------------------------------------------------------------------------------------------

const SOLID_FLAG = 64; // added to the atlas cell for solid particles (the atlas has 64 cells)

/** Instanced camera-facing (or floor-flat) quads over the atlas: one draw call for any number of particles. */
class Batch {
  readonly mesh: THREE.Mesh;
  readonly pos: Float32Array;
  readonly src: Float32Array;
  readonly col: Float32Array;
  readonly vel: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  count = 0;

  constructor(readonly capacity: number, glow: boolean) {
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
        attribute vec4 iSrc; // size, rotation, atlas cell (+64 = solid), stretch (< 0: flat on the floor)
        attribute vec4 iCol;
        attribute vec3 iVel;
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vSolid;
        void main() {
          float rot = iSrc.y;
          vec2 p = position.xy * iSrc.x;
          vec4 mv;
          if ( iSrc.w < 0.0 ) {
            // Lies on the floor (y up), turned by rot.
            float c = cos( rot ), s = sin( rot );
            mv = modelViewMatrix * vec4( iPos + vec3( c * p.x - s * p.y, 0.0, s * p.x + c * p.y ), 1.0 );
          } else {
            mv = modelViewMatrix * vec4( iPos, 1.0 );
            if ( iSrc.w > 0.0 ) {
              // Align with the on-screen velocity and stretch along it.
              vec2 v = ( modelViewMatrix * vec4( iVel, 0.0 ) ).xy;
              float l = length( v );
              if ( l > 1e-3 ) rot = atan( v.y, v.x );
              p.x *= 1.0 + iSrc.w * l;
            }
            float c = cos( rot ), s = sin( rot );
            mv.xy += vec2( c * p.x - s * p.y, s * p.x + c * p.y );
          }
          gl_Position = projectionMatrix * mv;
          float cell = iSrc.z;
          vSolid = step( ${SOLID_FLAG}.0 - 0.5, cell );
          cell -= vSolid * ${SOLID_FLAG}.0;
          float col = mod( cell, ${CELLS}.0 );
          float row = floor( cell / ${CELLS}.0 + 0.001 );
          vUv = vec2( ( col + position.x + 0.5 ) / ${CELLS}.0, 1.0 - ( row + 0.5 - position.y ) / ${CELLS}.0 );
          vCol = iCol;
        }`,
      fragmentShader: glow
        ? /* glsl */ `
        uniform sampler2D map;
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vSolid;
        void main() {
          // Solid letters sample a sharper mip, so small far-off glyphs keep an opaque body.
          vec4 t = texture2D( map, vUv, -0.8 * vSolid );
          float a = t.a * vCol.a;
          // Premultiplied: light added in proportion to alpha; solid particles also cover what is behind.
          float cover = vSolid * smoothstep( 0.42, 0.7, t.a ) * vCol.a;
          if ( a < 0.004 ) discard;
          // Letter halos glow twice as bright as their capped texture alpha (the letter body itself stays as drawn).
          vec3 c = vCol.rgb * t.rgb * ( 1.0 + vSolid * ( 1.0 - smoothstep( 0.3, 0.6, t.a ) ) );
          gl_FragColor = vec4( c * a, cover );
          #include <colorspace_fragment>
        }`
        : /* glsl */ `
        uniform sampler2D map;
        varying vec2 vUv;
        varying vec4 vCol;
        varying float vSolid;
        void main() {
          vec4 t = texture2D( map, vUv );
          gl_FragColor = vec4( vCol.rgb * t.rgb, t.a * vCol.a );
          if ( gl_FragColor.a < 0.004 ) discard;
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: !glow,
      side: THREE.DoubleSide, // floor-flat quads face away from the camera
      // The light batch skips the warm ACES grade: added light should stay coloured instead of rolling off to white.
      toneMapped: !glow,
      blending: glow ? THREE.CustomBlending : THREE.NormalBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = glow ? 20 : 5;
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
    this.src[i * 4 + 2] = p.cell + (p.solid ? SOLID_FLAG : 0);
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
      varying float vAlong;
      void main() {
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vN = normalize( normalMatrix * normal );
        vV = -mv.xyz;
        vAlong = position.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float power;
      uniform float fade;
      varying vec3 vN;
      varying vec3 vV;
      varying float vAlong;
      void main() {
        float f = pow( abs( dot( normalize( vN ), normalize( vV ) ) ), power );
        // A touch dimmer right out of the muzzle, full strength along the way to the target.
        float k = 0.75 + 0.25 * smoothstep( 0.0, 0.3, vAlong );
        gl_FragColor = vec4( color * ( f * fade * k ), 1.0 );
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
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
  private readonly tmp2 = new THREE.Vector3();
  /** The game camera (from `prewarm`): on a portrait phone the world is drawn small, so letters are drawn larger. */
  private camera: THREE.Camera | null = null;

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
      p = { kind, cell, additive, solid: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), color: new THREE.Color(), age: 0, life: 1, size: 1, rot: 0, spin: 0, drag: 0, grav: 0, alpha: 1, stretch: 0 };
    }
    p.kind = kind;
    p.cell = cell;
    p.additive = additive;
    p.solid = false;
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

  private mesh(key: string, color: number, make: () => Pick<MeshFx, 'obj' | 'fade'>): MeshFx {
    let m = this.freeMeshes.get(key)?.pop();
    if (!m) {
      m = { kind: 'beam', color, age: 0, life: 1, ...make() };
      this.root.add(m.obj);
    }
    m.age = 0;
    m.obj.visible = true;
    this.meshes.push(m);
    return m;
  }

  // ---- public effects ----

  /** The laser from `from` to `to`: a slim beam with a white core in a green glow, a muzzle flash and a small, hot
   * impact (white core, green-gold halo, a few gold rays). */
  beam(from: THREE.Vector3, to: THREE.Vector3, color = LASER) {
    if (color === BEAM || color === SHIELD_BEAM) color = LASER;
    // One laser at a time: a new shot restarts the live beam instead of stacking another (fast typing would pile
    // additive tubes up into a white-yellow bar, and add 3 draw calls per beam).
    let live: MeshFx | undefined;
    for (const b of this.meshes) if (b.color === color) live = b;
    if (live) live.age = 0;
    const m = live ?? this.mesh(`beam${color}`, color, () => {
      const fade = { value: 1 };
      const g = new THREE.Group();
      const outer = new THREE.Mesh(tubeGeo, tubeMaterial(color, 0.4, 2.4, fade));
      outer.scale.set(0.16, 1, 0.16);
      const mid = new THREE.Mesh(tubeGeo, tubeMaterial(color, 1.1, 0.9, fade));
      mid.scale.set(0.05, 1, 0.05);
      const core = new THREE.Mesh(tubeGeo, tubeMaterial(0xf4ffd8, 1.6, 0.35, fade));
      core.scale.set(0.02, 1, 0.02);
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
    this.flash(from, 0.8, color, 0.14, 0.7);
    // Impact: a hot white pin-point, a modest green-gold halo, a small gold sparkle and short rays.
    this.flash(to, 0.5, 0xfffbe8, 0.12, 1);
    this.flash(to, 1.15, 0x9fd040, 0.18, 0.55);
    this.star(to, 0.9, GOLD_PALE, 0.18);
    for (let i = 0; i < 5; i++) this.spark(to, i % 2 ? GOLD : GOLD_PALE, 7, 0.16, 0.12, 0.22);
  }

  /** A soft additive glow that swells and fades in place. */
  flash(at: THREE.Vector3, size: number, color: number, life = 0.25, strength = 1) {
    const p = this.particle('flash', C_GLOW, true, at, color);
    p.size = size;
    p.life = life;
    p.alpha = strength;
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
    const src = letters || LETTERS;
    // About half as many letters as sparks pairs, so fast typing does not bury the creature under glyphs.
    const glyphs = Math.max(1, Math.round(count / 2));
    // Spread the glyphs round the ring (a random start, then evenly apart) so they never stack on one side.
    const a0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      if (i < glyphs) {
        const a = a0 + (i / glyphs) * Math.PI * 2 + rand(-0.5, 0.5);
        this.glyph(at, src[(Math.random() * src.length) | 0], speed * 0.9, size * 5, a);
      }
      this.spark(at, GOLD, speed * 1.6, size * 1.1);
      this.spark(at, GOLD_PALE, speed * 2, size * 0.9);
    }
    // Every hit splashes a little ink: 4–6 small teal droplets with thin tendril tails, flung outwards.
    const drops = 4 + ((Math.random() * 3) | 0);
    for (let i = 0; i < drops; i++) this.inkDrop(at, speed * 1.6, size * 2.1);
  }

  /** A small hit droplet: flies out fast and flat-ish with a long thin tail, then falls and vanishes. */
  private inkDrop(at: THREE.Vector3, speed: number, size: number) {
    const p = this.particle('drop', C_DROP, false, at, 0xffffff);
    const a = Math.random() * Math.PI * 2;
    const h = speed * rand(0.6, 1);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Out in a screen-facing ring (up the screen is +y and -z), like the glyphs.
    // Starts at the creature's skin, a touch towards the camera, so the body does not hide the spray.
    p.pos.x += ca * 0.5;
    p.pos.y += sa * 0.3 + 0.1;
    p.pos.z += 0.35 - sa * 0.2;
    p.vel.set(ca * h, sa * h * 0.7 + speed * 0.25, -sa * h * 0.5);
    p.grav = 14;
    p.drag = 2.2;
    p.size = size * rand(0.7, 1.15);
    p.life = rand(0.45, 0.65);
    p.stretch = 0.12;
  }

  /** One golden letter flying out of `at`, floating up and fading. Unknown characters fall back to a random letter. */
  glyph(at: THREE.Vector3, ch: string, speed = 4, size = 1, angle = Math.random() * Math.PI * 2) {
    let i = LETTERS.indexOf(ch.toLowerCase());
    if (i < 0) i = (Math.random() * 26) | 0;
    const p = this.particle('glyph', C_LETTER + i, true, at, 0xffffff);
    p.solid = true;
    const h = speed * rand(0.8, 1.2);
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    // Start off the hit point and fly outwards in a ring that faces the camera (up the screen is +y and -z), so the
    // letters circle the impact instead of stacking on the creature.
    p.pos.x += ca * 0.75;
    p.pos.y += sa * 0.55 + 0.1;
    p.pos.z -= sa * 0.4;
    p.vel.set(ca * h, sa * h * 0.75 + speed * 0.2, -sa * h * 0.55);
    p.grav = 1.5;
    p.drag = 2.6;
    // Portrait screens show the field narrower, so hit letters grow up to 1.4x to stay readable on a phone.
    const cam = this.camera as THREE.PerspectiveCamera | null;
    const portrait = cam && cam.isPerspectiveCamera && cam.aspect < 1 ? Math.min(1.4, 1 / cam.aspect) : 1;
    p.size = size * portrait * rand(0.85, 1.15);
    p.life = rand(0.7, 1);
    p.rot = rand(-0.35, 0.35);
  }

  private spark(at: THREE.Vector3, color: number, speed: number, size: number, lifeMin = 0.3, lifeMax = 0.55) {
    const p = this.particle('spark', C_STREAK, true, at, color);
    const a = Math.random() * Math.PI * 2;
    const h = speed * rand(0.4, 1);
    p.vel.set(Math.cos(a) * h, speed * rand(0.3, 1), Math.sin(a) * h);
    p.grav = 12;
    p.drag = 1.5;
    p.size = size * rand(0.7, 1.3);
    p.life = rand(lifeMin, lifeMax);
    p.stretch = 0.3;
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
    const h = speed * rand(0.35, 1);
    p.vel.set(Math.cos(a) * h, speed * rand(0.2, 0.75), Math.sin(a) * h);
    p.grav = 26;
    p.drag = 0.5;
    // Mostly fine spray, a few fat drops.
    const r = Math.random();
    p.size = size * (0.3 + r * r * 0.9);
    p.life = rand(0.9, 1.2);
    p.stretch = 0.035;
  }

  /** An ink splat lying on the floor (a flat quad in the soft batch). */
  private splat(x: number, z: number, size: number, life = 1.8, alpha = 0.9) {
    this.tmp2.set(x, 0.025, z);
    const p = this.particle('splat', C_SPLAT, false, this.tmp2, INK_TEAL);
    p.size = size;
    p.life = life;
    p.rot = Math.random() * Math.PI * 2;
    p.stretch = -1;
    p.alpha = alpha;
  }

  private puff(at: THREE.Vector3, color: number, size: number, vx: number, vy: number, vz: number, life: number) {
    const p = this.particle('puff', C_PUFF, false, at, color);
    p.vel.set(vx, vy, vz);
    p.drag = 3;
    p.size = size;
    p.life = life;
    p.alpha = 1;
    p.rot = Math.random() * 6;
    p.spin = rand(-1, 1);
  }

  /** A creature is defeated: it bursts into dark teal ink droplets (some land as splats) with a soft gold sparkle. */
  poof(at: THREE.Vector3, size = 1.2, _color = 0xffffff) {
    const s = Math.max(0.6, size);
    this.flash(at, s * 1.1, 0xffc870, 0.2, 0.45);
    this.splat(at.x, at.z, s * 1.4, 1.6, 0.75);
    const drops = Math.round(14 + s * 5);
    for (let i = 0; i < drops; i++) this.drop(at, 5 + s * 2.5, 0.5 * s);
    for (let i = 0; i < 4; i++) {
      this.tmp.set(at.x + rand(-0.9, 0.9) * s, at.y + rand(-0.3, 0.8) * s, at.z + rand(-0.6, 0.6) * s);
      this.star(this.tmp, s * rand(0.4, 0.7), GOLD_PALE, rand(0.3, 0.55));
    }
    for (let i = 0; i < 14; i++) this.spark(at, i % 3 ? GOLD : GOLD_PALE, 5.5 * s, 0.16 * s);
    for (let i = 0; i < 3; i++) this.glyph(at, LETTERS[(Math.random() * 26) | 0], 4.5, 0.8);
  }

  /** A bubble shield pops: a spinning golden rune circle bursts outward with a ring of sparks. */
  pop(at: THREE.Vector3, size: number) {
    this.rune(at, size * 2.8, 0.55);
    this.ring(at, size * 2.1, GOLD, 0.3);
    this.flash(at, size * 1.6, 0xffd98a, 0.22, 0.45);
    for (let i = 0; i < 14; i++) this.spark(at, i % 3 ? GOLD : 0xbff1ff, 6 + size, 0.26);
  }

  /** Something reached the defenders: dust clouds rolling out sideways, a dust ring on the floor and a red flash. */
  dust(at: THREE.Vector3, size = 1.6) {
    this.flash(at, size * 2.6, 0xff2a14, 0.45, 0.55);
    this.flash(at, size * 1.1, 0xff8a4a, 0.22, 0.6);
    this.tmp.set(at.x, 0.03, at.z);
    // Depth-tested (soft batch), so the defenders stand in front of it.
    const ring = this.particle('ring', C_RING, false, this.tmp, 0xe6cfa6);
    ring.size = size * 2.8;
    ring.life = 0.45;
    ring.alpha = 0.6;
    ring.stretch = -1;
    for (let i = 0; i < 8; i++) {
      const side = i % 2 ? 1 : -1;
      this.tmp.set(at.x + side * (0.2 + i * 0.12), at.y, at.z + rand(-0.3, 0.3));
      this.puff(this.tmp, DUST, size * rand(0.9, 1.4), side * rand(1.5, 4), rand(0.8, 2), rand(-0.8, 0.8), rand(0.6, 0.85));
    }
    for (let i = 0; i < 6; i++) this.spark(at, 0xff9a4a, 5, 0.26);
  }

  /**
   * Compiles the laser materials up front (the particle batches compile with the first frame anyway), so the first
   * hit does not stutter. Uses parallel compile where the browser supports it. Call once after setup.
   */
  prewarm(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    this.camera = camera;
    const o = new THREE.Vector3(0, -1000, 0);
    this.beam(o, new THREE.Vector3(0, -999, 0));
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
        const key = `beam${m.color}`;
        let pool = this.freeMeshes.get(key);
        if (!pool) this.freeMeshes.set(key, (pool = []));
        pool.push(m);
        continue;
      }
      const w = 1 - k * k;
      m.obj.scale.x = m.obj.scale.z = w * (0.9 + 0.1 * Math.sin(m.age * 90));
      m.fade.value = 1 - k;
    }

    this.glow.count = this.soft.count = 0;
    const ps = this.particles;
    let n = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.age += dt;
      let k = p.age / p.life;
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
      let a = p.alpha;
      let rot = p.rot;
      switch (p.kind) {
        case 'flash':
          s *= 0.6 + 0.4 * Math.sqrt(k);
          a *= (1 - k) * (1 - k);
          break;
        case 'twinkle':
          s *= Math.sin(Math.min(1, k * 1.2) * Math.PI);
          break;
        case 'glyph':
          s *= k < 0.1 ? 0.55 + (k / 0.1) * 0.45 : 1 - (k - 0.1) * 0.3;
          rot += Math.sin(p.age * 3.5 + p.size * 7) * 0.25;
          a *= k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
          break;
        case 'spark':
          s *= 1 - k;
          break;
        case 'drop':
          // Lands on the floor: the bigger drops flatten into small splats that soak in, the rest just vanish.
          if (p.pos.y < 0.05 && p.vel.y < 0) {
            if (p.size > 0.35) {
              p.kind = 'splat';
              p.cell = C_SPLAT;
              p.color.setHex(INK_TEAL);
              p.pos.y = 0.025;
              p.vel.set(0, 0, 0);
              p.grav = p.drag = 0;
              p.stretch = -1;
              p.rot = Math.random() * Math.PI * 2;
              p.size *= 0.9;
              p.alpha = 0.9;
              p.life = p.age + rand(0.9, 1.3);
              k = p.age / p.life;
            } else {
              p.life = p.age + 1e-3;
              a = 0;
            }
          } else if (k > 0.75) s *= 1 - (k - 0.75) / 0.25;
          break;
        case 'ring':
          s *= 0.35 + 0.75 * (1 - (1 - k) * (1 - k));
          a *= 1 - k * k;
          break;
        case 'puff':
          s *= 0.45 + 0.75 * Math.sqrt(k);
          a *= (1 - k) * Math.min(1, k * 8);
          break;
      }
      if (p.kind === 'splat') {
        // Grows out quickly, then soaks in.
        s = p.size * (p.age < 0.08 ? 0.4 + (p.age / 0.08) * 0.6 : 1);
        a = p.alpha * (k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
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
