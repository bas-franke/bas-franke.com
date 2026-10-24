// Particle bursts and short-lived glows, pooled in one Points object so explosions cost next to nothing.

import * as THREE from 'three';

const MAX = 1500;

interface Glow {
  light: THREE.PointLight;
  mesh: THREE.Mesh;
  life: number;
  max: number;
}

export class Effects {
  private readonly positions = new Float32Array(MAX * 3);
  private readonly colors = new Float32Array(MAX * 3);
  private readonly velocities = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX);
  private readonly maxLife = new Float32Array(MAX);
  private readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private next = 0;
  private readonly glows: Glow[] = [];
  private readonly glowGeo = new THREE.SphereGeometry(1, 12, 10);
  gravity = 12;

  constructor(private readonly scene: THREE.Scene) {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.11,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
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
      const tint = 0.7 + Math.random() * 0.5;
      this.colors[i * 3] = Math.min(1, c.r * tint);
      this.colors[i * 3 + 1] = Math.min(1, c.g * tint);
      this.colors[i * 3 + 2] = Math.min(1, c.b * tint);
      this.life[i] = this.maxLife[i] = lifetime * (0.6 + Math.random() * 0.6);
    }
  }

  /** A quick expanding glow sphere (up to `radius` metres) with a point light; good for explosions and pickups. */
  flash(pos: { x: number; y: number; z: number }, color: number, radius = 1, duration = 0.35, intensity = 20) {
    const light = new THREE.PointLight(color, intensity, radius * 8, 2);
    light.position.set(pos.x, pos.y, pos.z);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(this.glowGeo, mat);
    mesh.position.copy(light.position);
    mesh.scale.setScalar(radius * 0.2);
    mesh.userData.radius = radius;
    this.scene.add(light, mesh);
    this.glows.push({ light, mesh, life: duration, max: duration });
    return { light, mesh };
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
      const fade = this.life[i] / this.maxLife[i];
      this.colors[i * 3] *= 0.5 + fade * 0.5;
    }
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    for (let i = this.glows.length - 1; i >= 0; i--) {
      const g = this.glows[i];
      g.life -= dt;
      const t = 1 - g.life / g.max;
      if (g.life <= 0) {
        this.scene.remove(g.light, g.mesh);
        (g.mesh.material as THREE.Material).dispose();
        this.glows.splice(i, 1);
        continue;
      }
      const radius = (g.mesh.userData.radius as number) ?? 1;
      g.light.intensity = g.light.intensity * (1 - t * 0.3);
      g.mesh.scale.setScalar(radius * (0.2 + t * 0.8));
      (g.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - t) * (1 - t);
    }
  }

  dispose() {
    this.scene.remove(this.points);
    this.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    for (const g of this.glows) this.scene.remove(g.light, g.mesh);
    this.glowGeo.dispose();
  }
}
