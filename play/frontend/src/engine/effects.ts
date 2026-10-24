// Comic-book effects: particle bursts pooled in one Points object so explosions cost next to nothing, solid inked
// fireballs, and pop-art "BOOM!" words. Lights come from a fixed pool so the shader light count never changes.

import * as THREE from 'three';
import { hullGeometry, inkMaterial } from './toon';

const MAX = 1500;

/**
 * A fixed set of point lights that live in the scene for good. three.js compiles shaders per light count, so adding
 * and removing lights mid-game causes hitches; borrowing from a pool keeps the count constant.
 */
export class LightPool {
  private readonly free: THREE.PointLight[] = [];

  constructor(scene: THREE.Scene, count: number) {
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 8, 2);
      light.position.set(0, -500, 0);
      scene.add(light);
      this.free.push(light);
    }
  }

  /** A light to use, or null when all are busy (the effect then simply goes without one). */
  take(color: number, intensity: number, distance: number): THREE.PointLight | null {
    const light = this.free.pop();
    if (!light) return null;
    light.color.setHex(color);
    light.intensity = intensity;
    light.distance = distance;
    return light;
  }

  give(light: THREE.PointLight) {
    light.intensity = 0;
    light.position.set(0, -500, 0);
    this.free.push(light);
  }
}

interface Fireball {
  group: THREE.Group;
  outer: THREE.MeshBasicMaterial;
  inner: THREE.MeshBasicMaterial;
  light: THREE.PointLight | null;
  life: number;
  max: number;
  radius: number;
  intensity: number;
}

interface Word {
  sprite: THREE.Sprite;
  life: number;
  max: number;
  size: number;
}

/** A round dot with a dark rim, so particles read as inked blobs rather than squares. */
function dotTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#16121c';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 9, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const WORDS = ['BOOM!', 'POW!', 'KABLAM!', 'WHAM!', 'BAM!'];

/** A jagged starburst with a word on it, in the style of a comic sound effect. */
function wordTexture(text: string, fill: string, burst: string): THREE.CanvasTexture {
  const w = 512;
  const h = 320;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const spikes = 14;
  ctx.beginPath();
  for (let i = 0; i <= spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2;
    const r = i % 2 ? 0.62 : 1;
    const x = w / 2 + Math.cos(a) * (w / 2 - 12) * r;
    const y = h / 2 + Math.sin(a) * (h / 2 - 12) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = burst;
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#16121c';
  ctx.stroke();
  ctx.font = `900 ${text.length > 5 ? 92 : 112}px Impact, "Arial Black", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.12);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 18;
  ctx.strokeStyle = '#16121c';
  ctx.strokeText(text, 0, 6);
  ctx.fillStyle = fill;
  ctx.fillText(text, 0, 6);
  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Effects {
  private readonly positions = new Float32Array(MAX * 3);
  private readonly colors = new Float32Array(MAX * 3);
  private readonly velocities = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX);
  private readonly maxLife = new Float32Array(MAX);
  private readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly dot = dotTexture();
  private next = 0;
  private readonly fireballs: Fireball[] = [];
  private readonly words: Word[] = [];
  private readonly ballGeo = new THREE.IcosahedronGeometry(1, 1);
  private readonly ballHull = hullGeometry(this.ballGeo);
  private wordTextures: THREE.CanvasTexture[] | null = null;
  private readonly lights: LightPool;
  gravity = 12;

  constructor(
    private readonly scene: THREE.Scene,
    flashLights = 3,
  ) {
    this.lights = new LightPool(scene, flashLights);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.22,
      map: this.dot,
      vertexColors: true,
      alphaTest: 0.5,
      sizeAttenuation: true,
    });
    // Cap the on-screen size so a puff right in front of the camera does not fill the view.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', '#include <fog_vertex>\n  gl_PointSize = min( gl_PointSize, 36.0 );');
    };
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.life.fill(0);
    for (let i = 0; i < MAX; i++) this.positions[i * 3 + 1] = -1000;
    scene.add(this.points);
  }

  burst(pos: THREE.Vector3 | { x: number; y: number; z: number }, color: number, count = 40, speed = 7, lifetime = 0.7, up = 0.4) {
    const c = new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.3 + Math.random() * 0.7);
      this.positions[i * 3] = pos.x;
      this.positions[i * 3 + 1] = pos.y;
      this.positions[i * 3 + 2] = pos.z;
      this.velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * s;
      this.velocities[i * 3 + 1] = Math.cos(phi) * s + up * speed;
      this.velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * s;
      const tint = 0.85 + Math.random() * 0.25;
      this.colors[i * 3] = Math.min(1, c.r * tint);
      this.colors[i * 3 + 1] = Math.min(1, c.g * tint);
      this.colors[i * 3 + 2] = Math.min(1, c.b * tint);
      this.life[i] = this.maxLife[i] = lifetime * (0.6 + Math.random() * 0.6);
    }
  }

  /** A solid, inked fireball that swells to `radius` and shrinks away, with a pooled light while it lasts. */
  flash(pos: { x: number; y: number; z: number }, color: number, radius = 1, duration = 0.35, intensity = 20) {
    const light = this.lights.take(color, intensity, radius * 8);
    light?.position.set(pos.x, pos.y, pos.z);
    const outer = new THREE.MeshBasicMaterial({ color, transparent: true });
    const inner = new THREE.MeshBasicMaterial({ color: 0xfff3b0, transparent: true });
    const group = new THREE.Group();
    const outerMesh = new THREE.Mesh(this.ballGeo, outer);
    const innerMesh = new THREE.Mesh(this.ballGeo, inner);
    innerMesh.scale.setScalar(0.62);
    innerMesh.position.y = 0.08;
    group.add(outerMesh, innerMesh, new THREE.Mesh(this.ballHull, inkMaterial()));
    group.position.set(pos.x, pos.y, pos.z);
    group.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    group.scale.setScalar(radius * 0.3);
    this.scene.add(group);
    this.fireballs.push({ group, outer, inner, light, life: duration, max: duration, radius, intensity });
  }

  /** A comic sound-effect word that pops up at `pos`. */
  boom(pos: { x: number; y: number; z: number }, size = 2.2) {
    this.wordTextures ??= WORDS.map((w, i) => wordTexture(w, ['#ffe14d', '#ffffff', '#ffe14d', '#7cf4ff', '#ffb0d8'][i], ['#ff4b2e', '#2e7bff', '#ff8a1f', '#e8392e', '#8d4bff'][i]));
    const tex = this.wordTextures[Math.floor(Math.random() * this.wordTextures.length)];
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, rotation: (Math.random() - 0.5) * 0.4 });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(pos.x, pos.y + 0.8, pos.z);
    sprite.renderOrder = 20;
    sprite.scale.set(0.01, 0.01, 1);
    this.scene.add(sprite);
    this.words.push({ sprite, life: 0.6, max: 0.6, size });
  }

  update(dt: number) {
    const p = this.positions;
    const v = this.velocities;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        p[i * 3 + 1] = -1000;
        continue;
      }
      v[i * 3 + 1] -= this.gravity * dt;
      const drag = 1 - 1.5 * dt;
      v[i * 3] *= drag;
      v[i * 3 + 2] *= drag;
      p[i * 3] += v[i * 3] * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
    }
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const f = this.fireballs[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.scene.remove(f.group);
        if (f.light) this.lights.give(f.light);
        f.outer.dispose();
        f.inner.dispose();
        this.fireballs.splice(i, 1);
        continue;
      }
      const t = 1 - f.life / f.max;
      // Pop out fast, then sag and shrink: reads as a cartoon explosion rather than a glow.
      const s = t < 0.3 ? 0.3 + (t / 0.3) * 0.75 : 1.05 - (t - 0.3) * 0.9;
      f.group.scale.setScalar(f.radius * s);
      const fade = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      f.outer.opacity = fade;
      f.inner.opacity = fade;
      if (f.light) f.light.intensity = f.intensity * (1 - t) * (1 - t);
    }

    for (let i = this.words.length - 1; i >= 0; i--) {
      const w = this.words[i];
      w.life -= dt;
      if (w.life <= 0) {
        this.scene.remove(w.sprite);
        w.sprite.material.dispose();
        this.words.splice(i, 1);
        continue;
      }
      const t = 1 - w.life / w.max;
      const pop = t < 0.15 ? (t / 0.15) * 1.15 : t < 0.25 ? 1.15 - ((t - 0.15) / 0.1) * 0.15 : 1;
      w.sprite.scale.set(w.size * pop * 1.6, w.size * pop, 1);
      w.sprite.position.y += dt * 0.6;
      w.sprite.material.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    }
  }

  dispose() {
    this.scene.remove(this.points);
    this.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.dot.dispose();
    for (const f of this.fireballs) {
      this.scene.remove(f.group);
      f.outer.dispose();
      f.inner.dispose();
    }
    for (const w of this.words) {
      this.scene.remove(w.sprite);
      w.sprite.material.dispose();
    }
    for (const t of this.wordTextures ?? []) t.dispose();
    this.ballGeo.dispose();
    this.ballHull.dispose();
  }
}
