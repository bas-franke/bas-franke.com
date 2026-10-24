// Three.js scenery for Ruckus minigames: a disc, a tile grid or a walled square, plus bars and coins.

import * as THREE from 'three';
import { BAR_HEIGHT, BAR_THICKNESS, type Layout, type MinigameId, type WorldState, tileCenter } from '@shared/ruckus/world';
import { boxFallback, instantiate } from '../../engine/models';

const ACCENTS: Record<MinigameId, number> = {
  hotpotato: 0xff7a59,
  lava: 0xff5c3a,
  coins: 0xffd166,
  sweeper: 0x6ea8fe,
  sumo: 0xf78cff,
};

export class RuckusArena {
  readonly group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];
  private disc?: THREE.Mesh;
  private rim?: THREE.Mesh;
  private baseRadius = 1;
  private tiles: THREE.Mesh[] = [];
  private tileStates: number[] = [];
  private tileFall: number[] = [];
  private bars: THREE.Group[] = [];
  private coins = new Map<number, THREE.Group>();
  private coinModel: THREE.Group | null = null;
  private layout?: Layout;
  private mg?: MinigameId;
  private lava?: THREE.Mesh;

  constructor(private readonly scene: THREE.Scene) {
    scene.add(this.group);
  }

  setCoinModel(model: THREE.Group | null) {
    this.coinModel = model;
  }

  accent() {
    return this.mg ? ACCENTS[this.mg] : 0x7cf4c9;
  }

  build(mg: MinigameId, layout: Layout, world: WorldState) {
    this.clear();
    this.mg = mg;
    this.layout = layout;
    const accent = ACCENTS[mg];
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x27324a, roughness: 0.8 });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x151c2c, roughness: 0.9 });
    const rimMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.6, roughness: 0.4 });
    this.disposables.push(floorMat, sideMat, rimMat);

    if (layout.kind === 'disc') {
      this.baseRadius = layout.radius;
      const geo = new THREE.CylinderGeometry(1, 0.94, 1.2, 64);
      this.disposables.push(geo);
      this.disc = new THREE.Mesh(geo, [sideMat, floorMat, sideMat]);
      this.disc.position.y = -0.6;
      this.disc.receiveShadow = true;
      const rimGeo = new THREE.TorusGeometry(1, 0.06, 8, 96);
      this.disposables.push(rimGeo);
      this.rim = new THREE.Mesh(rimGeo, rimMat);
      this.rim.rotation.x = Math.PI / 2;
      this.rim.position.y = 0.02;
      this.group.add(this.disc, this.rim);
      this.setRadius(world.radius ?? layout.radius);
    } else if (layout.kind === 'square') {
      const size = layout.half * 2;
      const geo = new THREE.BoxGeometry(size, 1.2, size);
      this.disposables.push(geo);
      const floor = new THREE.Mesh(geo, floorMat);
      floor.position.y = -0.6;
      floor.receiveShadow = true;
      this.group.add(floor);
      const wallGeoX = new THREE.BoxGeometry(size + 0.6, 0.7, 0.3);
      const wallGeoZ = new THREE.BoxGeometry(0.3, 0.7, size + 0.6);
      this.disposables.push(wallGeoX, wallGeoZ);
      for (const s of [-1, 1]) {
        const wx = new THREE.Mesh(wallGeoX, rimMat);
        wx.position.set(0, 0.35, s * (layout.half + 0.15));
        const wz = new THREE.Mesh(wallGeoZ, rimMat);
        wz.position.set(s * (layout.half + 0.15), 0.35, 0);
        wx.castShadow = wz.castShadow = true;
        this.group.add(wx, wz);
      }
    } else {
      const n = layout.cols * layout.rows;
      const geo = new THREE.BoxGeometry(layout.size * 0.94, 0.5, layout.size * 0.94);
      this.disposables.push(geo);
      for (let i = 0; i < n; i++) {
        const c = tileCenter(layout, i);
        const mat = new THREE.MeshStandardMaterial({ color: 0x27324a, roughness: 0.8, emissive: 0x000000 });
        this.disposables.push(mat);
        const tile = new THREE.Mesh(geo, mat);
        tile.position.set(c.x, -0.25, c.z);
        tile.receiveShadow = true;
        tile.castShadow = true;
        this.group.add(tile);
        this.tiles.push(tile);
        this.tileStates.push(0);
        this.tileFall.push(0);
      }
      const lavaGeo = new THREE.PlaneGeometry(80, 80);
      const lavaMat = new THREE.MeshStandardMaterial({ color: 0x4a1208, emissive: 0xff4a1a, emissiveIntensity: 0.9, roughness: 1 });
      this.disposables.push(lavaGeo, lavaMat);
      this.lava = new THREE.Mesh(lavaGeo, lavaMat);
      this.lava.rotation.x = -Math.PI / 2;
      this.lava.position.y = -4;
      this.group.add(this.lava);
      const glow = new THREE.PointLight(0xff5a2a, 40, 40, 1.5);
      glow.position.set(0, -2, 0);
      this.group.add(glow);
    }

    // Bars (sweeper).
    if (world.bars) {
      const barMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.4, roughness: 0.5 });
      this.disposables.push(barMat);
      for (const bar of world.bars) this.bars.push(this.makeBar(bar.len, barMat));
    }
    this.update(world, 0);
  }

  private makeBar(len: number, mat: THREE.Material) {
    const pivot = new THREE.Group();
    const geo = new THREE.BoxGeometry(len, BAR_HEIGHT, BAR_THICKNESS);
    this.disposables.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(len / 2, BAR_HEIGHT / 2, 0);
    mesh.castShadow = true;
    pivot.add(mesh);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, BAR_HEIGHT + 0.3, 24), mat);
    hub.position.y = (BAR_HEIGHT + 0.3) / 2;
    pivot.add(hub);
    this.group.add(pivot);
    return pivot;
  }

  private setRadius(r: number) {
    if (!this.disc || !this.rim) return;
    this.disc.scale.set(r, 1, r);
    this.rim.scale.set(r, r, 1);
  }

  /** Apply the latest world state; `dt` animates tile falls and coin spin. */
  update(world: WorldState, dt: number) {
    if (world.radius !== undefined) this.setRadius(world.radius);

    if (world.tiles && this.tiles.length) {
      for (let i = 0; i < this.tiles.length; i++) {
        const state = world.tiles[i] ?? 0;
        const tile = this.tiles[i];
        const mat = tile.material as THREE.MeshStandardMaterial;
        if (state !== this.tileStates[i]) {
          this.tileStates[i] = state;
          if (state === 1) mat.emissive.setHex(0xff3b1f);
          if (state === 2) this.tileFall[i] = 0.001;
        }
        if (state === 1) {
          mat.emissiveIntensity = 0.5 + Math.sin(performance.now() / 60) * 0.3;
          tile.position.y = -0.25 + (Math.random() - 0.5) * 0.03;
        }
        if (state === 2 && this.tileFall[i] > 0) {
          this.tileFall[i] += dt;
          const t = this.tileFall[i];
          tile.position.y = -0.25 - 9 * t * t;
          tile.rotation.x += dt * 2;
          mat.emissiveIntensity = Math.max(0, 0.8 - t);
          if (t > 1.2) tile.visible = false;
        }
      }
    }

    if (world.bars) {
      for (let i = 0; i < world.bars.length; i++) {
        if (!this.bars[i]) {
          const mat = (this.bars[0]?.children[0] as THREE.Mesh | undefined)?.material as THREE.Material | undefined;
          this.bars.push(this.makeBar(world.bars[i].len, mat ?? new THREE.MeshStandardMaterial({ color: this.accent() })));
        }
        // Bar angle is measured from +x toward +z; three's rotation.y is the other way around.
        this.bars[i].rotation.y = -world.bars[i].a;
      }
    }

    if (world.coins) {
      const seen = new Set<number>();
      for (const c of world.coins) {
        seen.add(c.id);
        let g = this.coins.get(c.id);
        if (!g) {
          g = instantiate(this.coinModel, undefined, () => boxFallback(0xffd166, 0.4));
          g.position.set(c.x, 0.45, c.z);
          g.rotation.y = Math.random() * Math.PI;
          this.group.add(g);
          this.coins.set(c.id, g);
        }
      }
      for (const [id, g] of this.coins) {
        if (!seen.has(id)) {
          this.group.remove(g);
          this.coins.delete(id);
        } else {
          g.rotation.y += dt * 2.5;
          g.position.y = 0.45 + Math.sin(performance.now() / 300 + id) * 0.08;
        }
      }
    }
    if (this.lava) this.lava.position.y = -4 + Math.sin(performance.now() / 900) * 0.15;
  }

  clear() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.group.clear();
    this.disc = this.rim = this.lava = undefined;
    this.tiles = [];
    this.tileStates = [];
    this.tileFall = [];
    this.bars = [];
    this.coins.clear();
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
  }
}

export function addRuckusLights(scene: THREE.Scene) {
  scene.background = new THREE.Color(0x0b0f1a);
  scene.fog = new THREE.Fog(0x0b0f1a, 40, 90);
  scene.add(new THREE.HemisphereLight(0x9fb8ff, 0x1a1410, 1.0));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(12, 24, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -18;
  sun.shadow.camera.right = sun.shadow.camera.top = 18;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 70;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0x7cf4c9, 0.3);
  fill.position.set(-15, 8, -10);
  scene.add(fill);
}
