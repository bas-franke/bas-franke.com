// Debris: the parts that break off pods and the shrapnel sprayed by hits. Broken-off parts are small rigid bodies
// (contact points from the mesh's own extreme vertices, box inertia, gravity, air drag) that collide with the course
// itself: the track surface across the corridor (each piece's own banked frame plane), a vertical rock wall at
// ±width/2 and the rock formations' collision circles. Contacts are point impulses with restitution and friction, so a
// piece that lands sliding gets turned over into tumbling and rolling, then settles with its lowest point on the
// ground (plates tip over flat) and goes to sleep. Their lights die in a couple of seconds. Pieces lie on the course
// for a while, then sink into the sand. Shrapnel is one instanced mesh of small dull metal scraps with point
// physics; hard metal-on-ground hits throw additive sparks (a third draw call). No allocations in update().

import * as THREE from 'three';
import type { Frame, Obstacle, Track } from '../core/track';
import { ADDITIVE_FOG, InstanceRing, fxMaterial, qualityScale, quadGeometry } from '../fx/particles';
import type { FrameView, SmokeSource, WorldContext } from './types';

const GRAVITY = 22;
/** Live broken-off pieces; the oldest goes first when a new one would exceed it. */
const MAX_PIECES = 60;
const MAX_SHARDS = 400;
const MAX_SPARKS = 700;
/** Substep length: a piece at 100 m/s moves under a metre per step, so corners never tunnel through the ground. */
const STEP = 1 / 120;
/** How long a piece lies on the course after it comes to rest, and how long it takes to sink away. */
const REST_TIME = 20;
const SINK_TIME = 2.5;
/** A piece that never settles (stuck rocking on a ramp lip) is put to sleep after this long. */
const MAX_AWAKE = 25;
const RESTITUTION_GROUND = 0.38;
const RESTITUTION_WALL = 0.42;
const FRICTION_GROUND = 0.55;
const FRICTION_WALL = 0.3;
/** Below this approach speed contacts do not bounce at all, which is what lets a piece come to rest. */
const BOUNCE_MIN = 2.5;
/** Points this close above the ground already count as touching it (keeps a resting piece's contacts steady). */
const SKIN = 0.004;

const SPARK_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aT; // spawn time, life, width, seed
uniform float uTime;
varying float vV;
varying float vU;
varying float vTail;
void main() {
  float age = uTime - aT.x;
  float u = age / aT.y;
  if (u < 0.0 || u > 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float drag = exp(-2.0 * age);
  vec3 p = aPos + aVel * (1.0 - drag) / 2.0 + 0.5 * vec3(0.0, -18.0, 0.0) * age * age;
  vec3 vel = aVel * drag + vec3(0.0, -18.0, 0.0) * age;
  vec3 streak = -vel * 0.02;
  float sl = length(streak);
  if (sl > 1.6) streak *= 1.6 / sl;
  vec3 a = p + (position.x > 0.0 ? streak : vec3(0.0));
  vec3 view = normalize(cameraPosition - a);
  vec3 sdir = sl > 1e-3 ? streak / max(sl, 1e-3) : vec3(0.0, 1.0, 0.0);
  vec3 side = normalize(cross(sdir, view) + vec3(1e-4));
  float dist = length(cameraPosition - a);
  a += side * position.y * max(aT.z, dist * 0.0014);
  vV = position.y;
  vU = u;
  vTail = position.x > 0.0 ? 1.0 : 0.0;
  vec4 mvPosition = viewMatrix * vec4(a, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SPARK_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
varying float vV;
varying float vU;
varying float vTail;
void main() {
  float a = (1.0 - vV * vV) * (1.0 - vU) * (1.0 - 0.85 * vTail);
  vec3 hot = mix(vec3(4.0, 3.1, 1.5), vec3(2.6, 0.7, 0.15), smoothstep(0.0, 0.55, vU + vTail * 0.3));
  gl_FragColor = vec4(hot, a);
  ${ADDITIVE_FOG}
}
`;

interface Piece {
  obj: THREE.Object3D;
  /** Box centre (= centre of mass) in the object's local frame (scale baked in). */
  com: THREE.Vector3;
  /**
   * Contact points: the mesh's own extreme vertices in many directions (its hull, roughly), local frame, relative to
   * the centre of mass, xyz packed. Real vertices rather than box corners, so what touches the ground is the mesh.
   */
  pts: Float32Array;
  /** Thin plates (fins, flaps): the local axis of their thickness, so they can be tipped over to lie flat. */
  thin: boolean;
  flatAxis: THREE.Vector3;
  /** Bounding-sphere radius. */
  radius: number;
  /** World centre of mass, velocity, angular velocity. Orientation is obj.quaternion. */
  c: THREE.Vector3;
  v: THREE.Vector3;
  w: THREE.Vector3;
  invMass: number;
  /** Inverse inertia, diagonal in the local frame. */
  invI: THREE.Vector3;
  /** Quadratic air drag per unit mass. */
  drag: number;
  /** Nearest track frame (search hint). */
  idx: number;
  age: number;
  /** Seconds of near-stillness in contact (sleeps at 0.5), seconds asleep, seconds sinking (< 0 = not yet). */
  still: number;
  asleep: boolean;
  rest: number;
  sink: number;
  /** Ground normal when it fell asleep (sinking direction). */
  restUp: THREE.Vector3;
  smoke: number;
  smokeLife: number;
  burnLife: number;
  sparkCool: number;
  src: SmokeSource;
  /** The piece's own glow material (pod lights), faded out over glowLife seconds, and the meshes that use it. */
  glow: THREE.ShaderMaterial | null;
  glowMeshes: THREE.Mesh[];
  glowLife: number;
  glowOut: boolean;
}

export interface DebrisImpact {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** Approach speed, m/s. */
  speed: number;
  /** 'ground' (the sand), 'wall' (canyon wall) or 'rock' (a formation). */
  surface: 'ground' | 'wall' | 'rock';
}

export class DebrisSystem {
  readonly object = new THREE.Group();
  /**
   * Called on hard hits (approach speed > ~6 m/s) so the effects can kick up dust; the impact object and its vectors
   * are reused, do not keep them.
   */
  onImpact: ((hit: DebrisImpact) => void) | null = null;

  private readonly track: Track;
  private readonly frames: Frame[];
  private readonly obstacles: Obstacle[];
  private readonly obsMaxR: number;
  private readonly pieces: Piece[] = [];
  private readonly pool: Piece[] = [];
  private readonly sources: SmokeSource[] = [];
  private readonly nearOut: { pos: THREE.Vector3; r: number }[] = [];
  private readonly nearPool: { pos: THREE.Vector3; r: number }[] = [];
  private time = 0;
  private acc = 0;
  private hintIdx = 0;

  // Shrapnel: per-shard state in typed arrays, drawn as one instanced mesh.
  private readonly shards: THREE.InstancedMesh;
  private readonly shardCap: number;
  private readonly sP: Float32Array;
  private readonly sV: Float32Array;
  private readonly sAxis: Float32Array;
  /** angle, spin rate, scale, age, life */
  private readonly sA: Float32Array;
  private readonly sQ: Float32Array;
  /** Per-flake stretch of its outline (x, z), so the one jagged shape comes out in many proportions. */
  private readonly sAsp: Float32Array;
  private readonly sIdx: Int32Array;
  /** 0 dead, 1 flying, 2 resting */
  private readonly sState: Uint8Array;
  private sHead = 0;
  private shardsLive = 0;

  /** What a dead piece's lights turn into: sooty, unlit. Shared by every piece. */
  private readonly deadGlow = new THREE.MeshStandardMaterial({ color: '#2a2522', roughness: 0.85, metalness: 0.3 });
  private readonly sparks: THREE.Mesh;
  private readonly sparkMat: THREE.ShaderMaterial;
  private readonly sparkRing: InstanceRing;
  private readonly sparkAttr: Record<string, THREE.InstancedBufferAttribute>;

  private readonly impact: DebrisImpact = { point: new THREE.Vector3(), normal: new THREE.Vector3(), speed: 0, surface: 'ground' };
  private readonly frame: Frame = {
    s: 0, pos: new THREE.Vector3(), tangent: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(),
    width: 0, kappa: 0, bank: 0,
  };

  constructor(ctx: WorldContext) {
    this.track = ctx.track;
    this.frames = ctx.track.frames;
    // Formations sorted by s so a piece only tests the few circles around it.
    this.obstacles = [...ctx.track.obstacles].sort((a, b) => a.s - b.s);
    this.obsMaxR = this.obstacles.reduce((m, o) => Math.max(m, o.r), 0);
    this.object.name = 'debris';
    const q = qualityScale(ctx.quality);

    // A shard is a torn, slightly dished scrap of skin: a jagged 7-sided outline (unit across) fanned from a raised
    // centre. Each flake gets its own stretch and heading, so no two read alike and none reads as a square.
    this.shardCap = Math.round(MAX_SHARDS * Math.max(0.4, q));
    const geo = new THREE.BufferGeometry();
    const rim = [0.5, 0.26, 0.44, 0.17, 0.38, 0.47, 0.22];
    const fan: number[] = [];
    for (let k = 0; k < rim.length; k++) {
      const a0 = (k / rim.length) * Math.PI * 2 + 0.3 * Math.sin(k * 2.7);
      const k1 = (k + 1) % rim.length;
      const a1 = (k1 / rim.length) * Math.PI * 2 + 0.3 * Math.sin(k1 * 2.7);
      fan.push(0, 0.05, 0, Math.cos(a1) * rim[k1], (k1 % 2) * 0.03, Math.sin(a1) * rim[k1], Math.cos(a0) * rim[k], (k % 2) * 0.03, Math.sin(a0) * rim[k]);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(fan, 3));
    geo.computeVertexNormals();
    // Dull, scuffed metal: rough and with little environment reflection, so flakes near the camera never flash white
    // or bloom.
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.45, roughness: 0.78, envMapIntensity: 0.25, side: THREE.DoubleSide });
    this.shards = new THREE.InstancedMesh(geo, mat, this.shardCap);
    this.shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shards.frustumCulled = false;
    this.shards.castShadow = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < this.shardCap; i++) {
      this.shards.setMatrixAt(i, zero);
      this.shards.setColorAt(i, white);
    }
    this.sP = new Float32Array(this.shardCap * 3);
    this.sV = new Float32Array(this.shardCap * 3);
    this.sAxis = new Float32Array(this.shardCap * 3);
    this.sA = new Float32Array(this.shardCap * 5);
    this.sQ = new Float32Array(this.shardCap * 4);
    this.sAsp = new Float32Array(this.shardCap * 2).fill(1);
    this.sIdx = new Int32Array(this.shardCap);
    this.sState = new Uint8Array(this.shardCap);
    this.object.add(this.shards);

    const sparkCount = Math.round(MAX_SPARKS * Math.max(0.35, q));
    const s = quadGeometry(sparkCount, { aPos: 3, aVel: 3, aT: 4 });
    for (let i = 0; i < sparkCount; i++) s.attr.aT.setXY(i, -1e6, 1);
    this.sparkAttr = s.attr;
    this.sparkRing = new InstanceRing(sparkCount, s.attr);
    this.sparkMat = fxMaterial({
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      additive: true,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
    });
    this.sparks = new THREE.Mesh(s.geo, this.sparkMat);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 3;
    this.object.add(this.sparks);

    for (let i = 0; i < MAX_PIECES; i++) this.nearPool.push({ pos: new THREE.Vector3(), r: 0 });
  }

  /** A broken-off part (already detached, world transform baked): flies with world velocity `vel` (m/s) and spin `spin` (rad/s, world axes). */
  spawn(piece: THREE.Object3D, vel: THREE.Vector3, spin: THREE.Vector3, opts?: { smoke?: number; burning?: boolean; mass?: number }) {
    if (this.pieces.length >= MAX_PIECES) this.remove(this.pieces.shift()!);
    const p = this.pool.pop() ?? newPiece();
    p.obj = piece;

    // The mesh in the piece's own (unrotated, scaled) frame: its vertices give the contact points, the box round them
    // the centre of mass, the inertia and the drag.
    const pos = _v1.copy(piece.position);
    const quat = _q1.copy(piece.quaternion);
    piece.position.set(0, 0, 0);
    piece.quaternion.identity();
    piece.updateMatrixWorld(true);
    const verts = collectVertices(piece);
    piece.position.copy(pos);
    piece.quaternion.copy(quat);
    _box.makeEmpty();
    for (let i = 0; i < verts.length; i += 3) _box.expandByPoint(_v2.set(verts[i], verts[i + 1], verts[i + 2]));
    if (_box.isEmpty()) _box.set(_v2.set(-0.4, -0.4, -0.4), _v3.set(0.4, 0.4, 0.4));
    _box.getCenter(p.com);
    _box.getSize(_v2).max(_v3.set(0.06, 0.06, 0.06));
    p.pts = supportPoints(verts, _box, p.com);
    p.radius = 0;
    for (let i = 0; i < p.pts.length; i += 3) p.radius = Math.max(p.radius, Math.hypot(p.pts[i], p.pts[i + 1], p.pts[i + 2]));
    // A plate is much thinner than it is wide; it should end up lying flat on that face.
    const sizes = [_v2.x, _v2.y, _v2.z];
    const order = [0, 1, 2].sort((i, j) => sizes[i] - sizes[j]);
    p.thin = sizes[order[0]] < 0.35 * sizes[order[1]];
    p.flatAxis.set(0, 0, 0).setComponent(order[0], 1);

    // Mass from the box volume as a hollow metal shell (~150 kg/m³), unless the caller knows better.
    const volume = _v2.x * _v2.y * _v2.z;
    const mass = opts?.mass ?? THREE.MathUtils.clamp(volume * 150, 3, 2000);
    p.invMass = 1 / mass;
    const { x: a, y: b, z: c } = _v2;
    p.invI.set(12 / (mass * (b * b + c * c)), 12 / (mass * (a * a + c * c)), 12 / (mass * (a * a + b * b)));
    // Drag from the mean face area; capped so thin plates still carry instead of stopping dead in the air.
    const area = (a * b + b * c + a * c) / 3;
    p.drag = Math.min(0.012, (0.6 * area) / mass);

    p.c.copy(p.com).applyQuaternion(piece.quaternion).add(piece.position);
    p.v.copy(vel);
    p.w.copy(spin);
    p.idx = this.nearestIndex(p.c);
    p.age = 0;
    p.still = 0;
    p.asleep = false;
    p.rest = 0;
    p.sink = -1;
    const smoke = THREE.MathUtils.clamp(opts?.smoke ?? 0, 0, 1);
    p.smoke = smoke;
    p.smokeLife = smoke > 0 ? 4 + smoke * 4 : 0;
    p.burnLife = opts?.burning ? p.smokeLife * (0.5 + 0.3 * Math.random()) : 0;
    p.sparkCool = 0;
    // Its lights die over a couple of seconds, sputtering.
    const glow = (piece.userData.glowMaterial as THREE.ShaderMaterial | null | undefined) ?? null;
    p.glow = glow?.uniforms?.uPower ? glow : null;
    p.glowMeshes = [];
    p.glowLife = 1.5 + Math.random() * 1.5;
    p.glowOut = false;
    if (p.glow) {
      piece.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material === glow) p.glowMeshes.push(o as THREE.Mesh);
      });
    }
    p.src.amount = 0;
    p.src.burning = false;
    this.object.add(piece);
    this.pieces.push(p);
  }

  /** A spray of small metal shards from a hit: world point, unit direction, count, speed (m/s), tint. */
  shrapnel(point: THREE.Vector3, dir: THREE.Vector3, count: number, speed: number, color?: THREE.Color) {
    const idx = (this.hintIdx = this.nearestIndex(point, this.hintIdx));
    const n = Math.min(count, this.shardCap);
    for (let k = 0; k < n; k++) {
      const i = this.sHead;
      this.sHead = (i + 1) % this.shardCap;
      if (this.sState[i] === 0) this.shardsLive++;
      this.sState[i] = 1;
      // A cone round `dir` widening with randomness, slower shards spread wider.
      const f = 0.35 + 0.65 * Math.random();
      randomUnit(_v1).multiplyScalar(0.75 * (1.2 - f));
      _v1.add(dir).normalize().multiplyScalar(speed * f);
      _v1.y += speed * 0.12 * Math.random();
      this.sP[i * 3] = point.x + (Math.random() - 0.5) * 0.3;
      this.sP[i * 3 + 1] = point.y + (Math.random() - 0.5) * 0.3;
      this.sP[i * 3 + 2] = point.z + (Math.random() - 0.5) * 0.3;
      this.sV[i * 3] = _v1.x;
      this.sV[i * 3 + 1] = _v1.y;
      this.sV[i * 3 + 2] = _v1.z;
      randomUnit(_v2);
      this.sAxis[i * 3] = _v2.x;
      this.sAxis[i * 3 + 1] = _v2.y;
      this.sAxis[i * 3 + 2] = _v2.z;
      const a = i * 5;
      this.sA[a] = Math.random() * Math.PI * 2;
      this.sA[a + 1] = 10 + Math.random() * 30;
      // Mostly 5-20 cm across, the odd bigger scrap.
      this.sA[a + 2] = 0.05 + Math.random() * Math.random() * 0.17;
      this.sAsp[i * 2] = 0.55 + Math.random() * 0.9;
      this.sAsp[i * 2 + 1] = 0.55 + Math.random() * 0.9;
      this.sA[a + 3] = 0;
      this.sA[a + 4] = 7 + Math.random() * 7;
      this.sIdx[i] = idx;
      if (color) {
        // The livery paint, dulled and scorched, varied per flake so a burst does not read as one flat colour.
        _col.copy(color).lerp(_grey, 0.45).multiplyScalar(0.35 + Math.random() * 0.3);
        this.shards.setColorAt(i, _col);
      } else {
        const g = 0.16 + Math.random() * 0.2;
        this.shards.setColorAt(i, _col.setRGB(g, g * 0.97, g * 0.93));
      }
    }
    if (this.shards.instanceColor) this.shards.instanceColor.needsUpdate = true;
    // A puff of sparks with it: the hit itself.
    const sparks = Math.min(24, 4 + count / 3);
    for (let k = 0; k < sparks; k++) {
      randomUnit(_v1).multiplyScalar(0.6).add(dir).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      this.spark(point, _v1, 0.25 + Math.random() * 0.35, 0.03);
    }
  }

  /** Steps everything; returns the smoking pieces this frame (positions reused, do not keep). */
  update(view: FrameView): SmokeSource[] {
    const dt = Math.min(view.dt, 0.1);
    this.time += dt;
    this.sparkMat.uniforms.uTime.value = this.time;

    // Rigid pieces in fixed substeps (carried over between frames), so a slow frame does not change the physics.
    this.acc = Math.min(this.acc + dt, STEP * 12);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      for (const p of this.pieces) if (!p.asleep) this.stepPiece(p, STEP);
    }

    // Ageing, sleeping pieces lying out their time and sinking, smoke, removal (compacting in place).
    const sources = this.sources;
    sources.length = 0;
    let w = 0;
    for (let r = 0; r < this.pieces.length; r++) {
      const p = this.pieces[r];
      p.age += dt;
      p.sparkCool -= dt;
      if (p.glow && !p.glowOut) this.fadeGlow(p);
      if (p.asleep) {
        p.rest += dt;
        if (p.sink < 0 && p.rest > REST_TIME) p.sink = 0;
      } else if (p.age > MAX_AWAKE) {
        this.sleep(p);
      }
      if (p.sink >= 0) {
        p.sink += dt;
        // Sink a little deeper than the piece is big, slowly at first, then out of sight.
        const d = (-dt * (p.radius * 2 + 0.3) * 2 * (p.sink / SINK_TIME)) / SINK_TIME;
        p.obj.position.addScaledVector(p.restUp, d);
        p.c.addScaledVector(p.restUp, d);
        if (p.sink > SINK_TIME) {
          this.remove(p);
          continue;
        }
      }
      if (p.smokeLife > 0 && p.age < p.smokeLife) {
        const u = p.age / p.smokeLife;
        p.src.pos.copy(p.c);
        p.src.amount = p.smoke * (1 - u) * (1 - u) * Math.min(1, 0.4 + p.age * 3);
        p.src.burning = p.age < p.burnLife;
        sources.push(p.src);
      }
      this.pieces[w++] = p;
    }
    this.pieces.length = w;

    this.updateShards(dt);
    this.sparkRing.flush();
    return sources;
  }

  /** Pieces near a world point (for future pod-vs-debris knocks): returns approximate centres and radii. */
  near(point: THREE.Vector3, radius: number): { pos: THREE.Vector3; r: number }[] {
    const out = this.nearOut;
    out.length = 0;
    for (const p of this.pieces) {
      if (p.sink >= 0) continue;
      const rr = radius + p.radius;
      if (p.c.distanceToSquared(point) > rr * rr) continue;
      const e = this.nearPool[out.length];
      e.pos.copy(p.c);
      e.r = p.radius;
      out.push(e);
    }
    return out;
  }

  clear() {
    for (const p of this.pieces) this.remove(p);
    this.pieces.length = 0;
    const zero = _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.shardCap; i++) {
      this.sState[i] = 0;
      this.shards.setMatrixAt(i, zero);
    }
    this.shardsLive = 0;
    this.shards.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this.sparkRing.count; i++) this.sparkAttr.aT.setX(i, -1e6);
    this.sparkAttr.aT.needsUpdate = true;
  }

  dispose() {
    this.clear();
    this.shards.geometry.dispose();
    (this.shards.material as THREE.Material).dispose();
    this.shards.dispose();
    this.sparks.geometry.dispose();
    this.sparkMat.dispose();
    this.deadGlow.dispose();
    this.object.removeFromParent();
  }

  // --- Rigid pieces ---

  private stepPiece(p: Piece, dt: number) {
    const q = p.obj.quaternion;
    // Gravity, quadratic air drag, a little air damping of the spin.
    p.v.y -= GRAVITY * dt;
    p.v.multiplyScalar(1 / (1 + p.drag * p.v.length() * dt));
    p.w.multiplyScalar(1 - 0.15 * dt);
    p.c.addScaledVector(p.v, dt);
    const wl = p.w.length();
    if (wl > 1e-5) {
      _q1.setFromAxisAngle(_v1.copy(p.w).divideScalar(wl), wl * dt);
      q.premultiply(_q1).normalize();
    }

    // The course under the piece: the frame plane of the nearest track point, the walls at ±width/2.
    const f = this.frameNear(p.c, p);
    _rightH.set(f.right.x, 0, f.right.z).normalize();
    const hw = f.width / 2;
    let groundPen = 0;
    let wallPen = 0;
    let wallSign = 0;
    let rockPen = 0;
    let contact = false;
    let hardest = 0;
    const pts = p.pts;
    for (let k = 0; k < pts.length; k += 3) {
      // Contact point offset from the centre of mass, world axes.
      _r.set(pts[k], pts[k + 1], pts[k + 2]).applyQuaternion(q);
      _pt.copy(p.c).add(_r);
      _rel.copy(_pt).sub(f.pos);
      const h = _rel.dot(f.up);
      const pen = -h;
      if (h < SKIN) {
        contact = true;
        if (pen > groundPen) groundPen = pen;
        const hit = this.contact(p, _r, f.up, RESTITUTION_GROUND, FRICTION_GROUND);
        if (hit > hardest) hardest = hit;
        if (hit > 0) this.hitFx(p, _pt, f.up, hit, 'ground');
      }
      const x = _rel.dot(_rightH);
      const wp = Math.abs(x) - hw;
      if (wp > 0) {
        const sign = x > 0 ? 1 : -1;
        _n.copy(_rightH).multiplyScalar(-sign);
        if (wp > wallPen) {
          wallPen = wp;
          wallSign = sign;
        }
        const hit = this.contact(p, _r, _n, RESTITUTION_WALL, FRICTION_WALL);
        if (hit > 0) this.hitFx(p, _pt, _n, hit, 'wall');
      }
      if (this.obstacles.length) {
        const pen2 = this.rockContact(p, f, _rel, x, h);
        if (pen2 > rockPen) rockPen = pen2;
      }
    }
    // Push out of whatever the points sank into (the deepest point per surface).
    if (groundPen > 0) p.c.addScaledVector(f.up, groundPen);
    if (wallPen > 0) p.c.addScaledVector(_rightH, -wallSign * wallPen);
    if (rockPen > 0) p.c.addScaledVector(_rockN, rockPen);

    if (contact) {
      // Rolling resistance: spin dies away on the sand once the piece is down, faster once it is slow (a cylinder
      // would otherwise roll on for ages down the banking).
      p.w.multiplyScalar(1 - (p.v.lengthSq() < 4 ? 3 : 1) * dt);
      // A plate that has slowed down on its edge tips over onto its face: real ones never stay propped up, but with
      // point contacts and rolling resistance they can balance; this torque turns the face normal towards up.
      let propped = false;
      if (p.thin && p.v.lengthSq() < 9) {
        _n.copy(p.flatAxis).applyQuaternion(q);
        if (_n.dot(f.up) < 0) _n.negate();
        const tilt = 1 - _n.dot(f.up);
        // Only clearly propped plates (over ~20°): tapered fins rest a few degrees off flat on their own.
        if (tilt > 0.06) {
          propped = true;
          p.w.addScaledVector(_t1.copy(_n).cross(f.up), 30 * dt);
        }
      }
      if (!propped && p.v.lengthSq() < 0.36 && p.w.lengthSq() < 1.2 && hardest < 1) {
        p.still += dt;
        if (p.still > 0.5) this.sleep(p);
      } else {
        p.still = 0;
      }
    } else {
      p.still = 0;
    }
    // A piece that falls off the world (off the end of the course, into a gorge) is not coming back.
    if (_rel.copy(p.c).sub(f.pos).dot(f.up) < -60 && p.sink < 0) p.sink = SINK_TIME;
    p.obj.position.copy(p.com).applyQuaternion(q).negate().add(p.c);
  }

  /** Resolves one corner contact with impulses; returns the approach speed (0 if it was separating). */
  private contact(p: Piece, r: THREE.Vector3, n: THREE.Vector3, restitution: number, friction: number): number {
    const q = p.obj.quaternion;
    _vp.copy(p.w).cross(r).add(p.v);
    const vn = _vp.dot(n);
    if (vn >= 0) return 0;
    const e = vn < -BOUNCE_MIN ? restitution : 0;
    // Normal impulse: j = -(1+e) vn / (1/m + n·((I⁻¹ (r×n)) × r)).
    _rn.copy(r).cross(n);
    this.invInertia(p, q, _rn, _t1);
    const kn = p.invMass + _t2.copy(_t1).cross(r).dot(n);
    const j = (-(1 + e) * vn) / kn;
    p.v.addScaledVector(n, j * p.invMass);
    p.w.addScaledVector(_t1, j);
    // Coulomb friction against the sliding velocity at the corner: this is what turns a skid into a tumble.
    _vp.copy(p.w).cross(r).add(p.v);
    _vt.copy(_vp).addScaledVector(n, -_vp.dot(n));
    const vtl = _vt.length();
    if (vtl > 1e-4) {
      _vt.divideScalar(vtl);
      _rn.copy(r).cross(_vt);
      this.invInertia(p, q, _rn, _t1);
      const kt = p.invMass + _t2.copy(_t1).cross(r).dot(_vt);
      const jt = Math.min(vtl / kt, friction * j);
      p.v.addScaledVector(_vt, -jt * p.invMass);
      p.w.addScaledVector(_t1, -jt);
    }
    return -vn;
  }

  /** out = I⁻¹ v with the inertia diagonal in the piece's local frame. */
  private invInertia(p: Piece, q: THREE.Quaternion, v: THREE.Vector3, out: THREE.Vector3) {
    _qi.copy(q).invert();
    out.copy(v).applyQuaternion(_qi).multiply(p.invI).applyQuaternion(q);
  }

  /** Corner against the rock formations' collision circles (track space, up to their height). Returns penetration. */
  private rockContact(p: Piece, f: Frame, rel: THREE.Vector3, x: number, h: number): number {
    const cs = f.s + rel.dot(f.tangent);
    const obs = this.obstacles;
    let lo = 0;
    let hi = obs.length;
    const from = cs - this.obsMaxR - 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (obs[mid].s < from) lo = mid + 1;
      else hi = mid;
    }
    let best = 0;
    for (let i = lo; i < obs.length; i++) {
      const o = obs[i];
      if (o.s > cs + this.obsMaxR + 2) break;
      if (h > o.h) continue;
      const ds = cs - o.s;
      const dx = x - o.x;
      const d = Math.hypot(ds, dx);
      const pen = o.r - d;
      if (pen <= 0 || d < 1e-4) continue;
      _n.copy(f.tangent).multiplyScalar(ds).addScaledVector(_rightH, dx).setY(0).normalize();
      const hit = this.contact(p, _r, _n, RESTITUTION_WALL, FRICTION_WALL);
      if (hit > 0) this.hitFx(p, _pt, _n, hit, 'rock');
      if (pen > best) {
        best = pen;
        _rockN.copy(_n);
      }
    }
    return best;
  }

  /** Sparks (and the impact hook) for a corner hitting something at approach speed `speed`. */
  private hitFx(p: Piece, point: THREE.Vector3, n: THREE.Vector3, speed: number, surface: DebrisImpact['surface']) {
    // The sliding speed at the corner counts too: a part skidding on its edge sheds sparks as it goes.
    const slide = _vt.lengthSq() > 0 ? Math.sqrt(Math.max(0, _vp.lengthSq() - _vp.dot(n) ** 2)) : 0;
    const hard = Math.max(speed, slide * 0.45);
    if (hard < 6 || p.sparkCool > 0) return;
    p.sparkCool = surface === 'ground' ? 0.06 : 0.03;
    const count = Math.min(14, Math.round((hard - 4) * (surface === 'ground' ? 0.5 : 0.9)));
    for (let k = 0; k < count; k++) {
      randomUnit(_sv).multiplyScalar(hard * 0.35);
      _sv.addScaledVector(n, Math.abs(_sv.dot(n)) + hard * 0.15).addScaledVector(p.v, 0.5);
      this.spark(point, _sv, 0.2 + Math.random() * 0.4, 0.025 + Math.random() * 0.02);
    }
    if (this.onImpact && speed > 6) {
      this.impact.point.copy(point);
      this.impact.normal.copy(n);
      this.impact.speed = speed;
      this.impact.surface = surface;
      this.onImpact(this.impact);
    }
  }

  /**
   * A broken-off part's lights die: power fades out over glowLife seconds while the lit meshes sputter, blinking to
   * burnt-out dark more and more often, then stay dark (the glow shader alone never goes fully dark at zero power).
   */
  private fadeGlow(p: Piece) {
    const glow = p.glow!;
    const u = p.age / p.glowLife;
    const done = u >= 1;
    const sputter = Math.random() < 0.2 + 0.5 * u ? Math.random() * 0.35 : 1;
    const power = done ? 0 : (1 - u) ** 1.5 * sputter;
    const U = glow.uniforms;
    if (typeof U.uPower.value === 'number') U.uPower.value = power;
    else (U.uPower.value as THREE.Vector2).setScalar(power);
    if (U.uPulse) U.uPulse.value = 0.5 * power;
    if (U.uBoost) U.uBoost.value = 0;
    const lit = !done && Math.random() > u * u * 0.85;
    for (const m of p.glowMeshes) m.material = lit ? glow : this.deadGlow;
    p.glowOut = done;
  }

  private sleep(p: Piece) {
    p.asleep = true;
    p.v.set(0, 0, 0);
    p.w.set(0, 0, 0);
    const f = this.frameNear(p.c, p);
    p.restUp.copy(f.up);
    // Settle exactly onto the ground: the mesh's real lowest vertex touches it, neither floating nor sunk (the contact
    // points are only a sample of the hull, so they can miss the lowest vertex by a few centimetres).
    const q = p.obj.quaternion;
    p.obj.position.copy(p.com).applyQuaternion(q).negate().add(p.c);
    p.obj.updateMatrixWorld(true);
    _low.n = Infinity;
    _low.pos.copy(f.pos);
    _low.up.copy(f.up);
    p.obj.traverseVisible(lowestVertex);
    const low = _low.n;
    if (low < 1 && low > -1) {
      p.c.addScaledVector(f.up, -low);
      p.obj.position.addScaledVector(f.up, -low);
    }
  }

  private remove(p: Piece) {
    const root = p.obj;
    root.removeFromParent();
    // Give the lights back their own material before anything is freed (the burnt-out one is shared).
    for (const m of p.glowMeshes) if (p.glow) m.material = p.glow;
    p.glowMeshes.length = 0;
    p.glow = null;
    // A piece broken off a pod frees its own per-pod clones (dents, a cracked canopy, its glow) itself.
    if (typeof root.userData.dispose === 'function') root.userData.dispose();
    const ownGeo = root.userData.debrisOwnsGeometry === true;
    const ownMat = root.userData.debrisOwnsMaterial === true;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData.debrisOwnsGeometry ?? ownGeo) mesh.geometry.dispose();
      if (mesh.userData.debrisOwnsMaterial ?? ownMat) {
        const m = mesh.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
    p.obj = DUMMY;
    this.pool.push(p);
  }

  // --- Track lookups (no allocation: hill-climb from the last nearest frame) ---

  /** Interpolated frame nearest to a world point, updating the piece's search hint. Returns a shared scratch frame. */
  private frameNear(c: THREE.Vector3, p: Piece): Frame {
    const i = (p.idx = this.climb(c, p.idx));
    const a = this.frames[i];
    _rel.copy(c).sub(a.pos);
    return this.track.frameAt(a.s + _rel.dot(a.tangent), this.frame);
  }

  private climb(c: THREE.Vector3, i: number): number {
    const fr = this.frames;
    const last = fr.length - 1;
    let d = fr[i].pos.distanceToSquared(c);
    for (let k = 0; k < 400; k++) {
      const a = i > 0 ? fr[i - 1].pos.distanceToSquared(c) : Infinity;
      const b = i < last ? fr[i + 1].pos.distanceToSquared(c) : Infinity;
      if (a < d && a <= b) {
        i--;
        d = a;
      } else if (b < d) {
        i++;
        d = b;
      } else break;
    }
    return i;
  }

  /** Nearest frame index: hill-climb from a hint, falling back to a full scan when the hint is clearly wrong. */
  private nearestIndex(c: THREE.Vector3, hint = -1): number {
    if (hint >= 0) {
      const i = this.climb(c, hint);
      if (this.frames[i].pos.distanceToSquared(c) < 120 * 120) return i;
    }
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.frames.length; i++) {
      const d = this.frames[i].pos.distanceToSquared(c);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // --- Shrapnel and sparks ---

  private spark(pos: THREE.Vector3, vel: THREE.Vector3, life: number, width: number) {
    const i = this.sparkRing.next();
    this.sparkAttr.aPos.setXYZ(i, pos.x, pos.y, pos.z);
    this.sparkAttr.aVel.setXYZ(i, vel.x, vel.y, vel.z);
    this.sparkAttr.aT.setXYZW(i, this.time, life, width, Math.random());
  }

  private updateShards(dt: number) {
    if (this.shardsLive === 0) return;
    const fr = this.frames;
    for (let i = 0; i < this.shardCap; i++) {
      const st = this.sState[i];
      if (st === 0) continue;
      const a = i * 5;
      const age = (this.sA[a + 3] += dt);
      const life = this.sA[a + 4];
      if (age > life) {
        this.sState[i] = 0;
        this.shardsLive--;
        this.shards.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      const i3 = i * 3;
      _pt.set(this.sP[i3], this.sP[i3 + 1], this.sP[i3 + 2]);
      if (st === 1) {
        _vp.set(this.sV[i3], this.sV[i3 + 1], this.sV[i3 + 2]);
        _vp.y -= GRAVITY * dt;
        // Flakes are light and flat: strong drag, so they flutter down rather than arc like the heavy parts.
        _vp.multiplyScalar(1 / (1 + 0.035 * _vp.length() * dt));
        _pt.addScaledVector(_vp, dt);
        const idx = (this.sIdx[i] = this.climb(_pt, this.sIdx[i]));
        const f = fr[idx];
        _rel.copy(_pt).sub(f.pos);
        const h = _rel.dot(f.up);
        _rightH.set(f.right.x, 0, f.right.z).normalize();
        const x = _rel.dot(_rightH);
        const hw = f.width / 2;
        if (Math.abs(x) > hw) {
          // Off the wall: reflect the lateral part, lose most of it.
          const sx = x > 0 ? 1 : -1;
          _pt.addScaledVector(_rightH, (hw - Math.abs(x)) * sx);
          const vx = _vp.dot(_rightH);
          if (vx * sx > 0) _vp.addScaledVector(_rightH, -vx * 1.35);
        }
        if (h < 0.02) {
          _pt.addScaledVector(f.up, 0.02 - h);
          const vn = _vp.dot(f.up);
          if (vn < 0) _vp.addScaledVector(f.up, -vn * 1.3);
          _vp.multiplyScalar(0.55);
          this.sA[a + 1] *= 0.5;
          if (_vp.lengthSq() < 1.5) {
            // Lie flat on the sand, at a random heading.
            this.sState[i] = 2;
            _q1.setFromUnitVectors(_UP, f.up);
            _q2.setFromAxisAngle(_UP, this.sA[a] * 3.1);
            _q1.multiply(_q2);
            _q1.toArray(this.sQ, i * 4);
            _vp.set(0, 0, 0);
          }
        }
        this.sP[i3] = _pt.x;
        this.sP[i3 + 1] = _pt.y;
        this.sP[i3 + 2] = _pt.z;
        this.sV[i3] = _vp.x;
        this.sV[i3 + 1] = _vp.y;
        this.sV[i3 + 2] = _vp.z;
      }
      if (this.sState[i] === 1) {
        this.sA[a] += this.sA[a + 1] * dt;
        _q1.setFromAxisAngle(_v1.set(this.sAxis[i3], this.sAxis[i3 + 1], this.sAxis[i3 + 2]), this.sA[a]);
      } else {
        _q1.fromArray(this.sQ, i * 4);
      }
      const sc = this.sA[a + 2] * Math.min(1, (life - age) / 1.5);
      _s.set(sc * this.sAsp[i * 2], sc, sc * this.sAsp[i * 2 + 1]);
      this.shards.setMatrixAt(i, _m.compose(_pt, _q1, _s));
    }
    this.shards.instanceMatrix.needsUpdate = true;
  }
}

function newPiece(): Piece {
  return {
    obj: DUMMY, com: new THREE.Vector3(), pts: new Float32Array(0), thin: false, flatAxis: new THREE.Vector3(), radius: 0,
    c: new THREE.Vector3(), glow: null, glowMeshes: [], glowLife: 0, glowOut: false,
    v: new THREE.Vector3(), w: new THREE.Vector3(), invMass: 1, invI: new THREE.Vector3(), drag: 0, idx: 0, age: 0,
    still: 0, asleep: false, rest: 0, sink: -1, restUp: new THREE.Vector3(0, 1, 0), smoke: 0, smokeLife: 0, burnLife: 0,
    sparkCool: 0, src: { pos: new THREE.Vector3(), amount: 0, burning: false },
  };
}

/**
 * Vertices of a piece's solid meshes in the root's world frame (set to identity by the caller), xyz packed. Additive
 * or depth-less shader meshes (exhaust plumes, halos) are not solid and are left out.
 */
function collectVertices(root: THREE.Object3D): number[] {
  const out: number[] = [];
  root.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.every((m) => m.blending === THREE.AdditiveBlending || (m.transparent && !m.depthWrite))) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    const stride = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += stride) {
      _v3.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      out.push(_v3.x, _v3.y, _v3.z);
    }
  });
  return out;
}

/**
 * The extreme vertex in each of SUPPORT_DIRS directions (in box-normalised space, so long pieces get as many points
 * along their sides as round their ends), deduplicated, relative to `com`. Falls back to the box corners.
 */
function supportPoints(verts: number[], box: THREE.Box3, com: THREE.Vector3): Float32Array {
  const hx = Math.max(1e-3, (box.max.x - box.min.x) / 2);
  const hy = Math.max(1e-3, (box.max.y - box.min.y) / 2);
  const hz = Math.max(1e-3, (box.max.z - box.min.z) / 2);
  const n = verts.length / 3;
  if (n === 0) {
    const out = new Float32Array(24);
    for (let k = 0; k < 8; k++) out.set([k & 1 ? hx : -hx, k & 2 ? hy : -hy, k & 4 ? hz : -hz], k * 3);
    return out;
  }
  const picked = new Set<number>();
  for (const d of SUPPORT_DIRS) {
    let best = 0;
    let bestD = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = ((verts[i * 3] - com.x) / hx) * d.x + ((verts[i * 3 + 1] - com.y) / hy) * d.y + ((verts[i * 3 + 2] - com.z) / hz) * d.z;
      if (v > bestD) {
        bestD = v;
        best = i;
      }
    }
    picked.add(best);
  }
  const out = new Float32Array(picked.size * 3);
  let k = 0;
  for (const i of picked) {
    out[k++] = verts[i * 3] - com.x;
    out[k++] = verts[i * 3 + 1] - com.y;
    out[k++] = verts[i * 3 + 2] - com.z;
  }
  return out;
}

/** Lowest solid vertex of a piece above the plane in `_low` (a traverse callback, so sleeping allocates nothing). */
const _low = { n: Infinity, pos: new THREE.Vector3(), up: new THREE.Vector3() };
function lowestVertex(o: THREE.Object3D) {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh) return;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (mats.every((m) => m.blending === THREE.AdditiveBlending || (m.transparent && !m.depthWrite))) return;
  const pos = mesh.geometry.getAttribute('position');
  if (!pos) return;
  for (let i = 0; i < pos.count; i++) {
    const h = _v3.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).sub(_low.pos).dot(_low.up);
    if (h < _low.n) _low.n = h;
  }
}

/** Evenly spread unit directions (Fibonacci sphere) plus the 8 box diagonals, so box-like pieces keep their corners. */
const SUPPORT_DIRS: THREE.Vector3[] = (() => {
  const dirs: THREE.Vector3[] = [];
  const N = 56;
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const t = i * Math.PI * (3 - Math.sqrt(5));
    dirs.push(new THREE.Vector3(r * Math.cos(t), y, r * Math.sin(t)));
  }
  for (let k = 0; k < 8; k++) dirs.push(new THREE.Vector3(k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1).normalize());
  return dirs;
})();

function randomUnit(out: THREE.Vector3): THREE.Vector3 {
  const z = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(t), r * Math.sin(t), z);
}

const DUMMY = new THREE.Object3D();
const _UP = new THREE.Vector3(0, 1, 0);
const _box = new THREE.Box3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _r = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _n = new THREE.Vector3();
const _rightH = new THREE.Vector3();
const _rockN = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _vt = new THREE.Vector3();
const _rn = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _col = new THREE.Color();
const _grey = new THREE.Color(0.35, 0.34, 0.33);
