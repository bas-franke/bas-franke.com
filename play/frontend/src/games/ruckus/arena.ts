// Three.js scenery for Ruckus minigames, in the cel-shaded comic style: a floating disc, a tile grid over lava or a
// walled square, plus bars and coins, all toon-lit with ink outlines over a banded sky.

import * as THREE from 'three';
import { BAR_HEIGHT, BAR_THICKNESS, type Layout, type MinigameId, type WorldState, tileCenter } from '@shared/ruckus/world';
import { instantiate } from '../../engine/models';
import { INK, hullGeometry, toon, toonRamp } from '../../engine/toon';
import { THEMES, buildBackdrop, checkerTexture, discTexture, inked, lavaMaterial, rkInk, tileTexture } from './look';

/** Outline width around the disc, in metres; the disc scales with its radius, so it gets its own scaled shell. */
const DISC_INK = 0.09;
const DISC_H = 1.2;

export class RuckusArena {
  readonly group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];
  private disc?: THREE.Group;
  private discInk?: THREE.Mesh;
  private tiles: THREE.Mesh[] = [];
  private tileStates: number[] = [];
  private tileFall: number[] = [];
  private bars: THREE.Group[] = [];
  private barMat?: THREE.Material;
  private coins = new Map<number, THREE.Group>();
  private coinModel: THREE.Group | null = null;
  private layout?: Layout;
  private mg?: MinigameId;
  private lava?: THREE.Mesh;
  private lavaMat?: THREE.ShaderMaterial;
  private clouds: THREE.Group | null = null;
  private readonly seen = new Set<number>();

  constructor(private readonly scene: THREE.Scene) {
    scene.add(this.group);
  }

  setCoinModel(model: THREE.Group | null) {
    this.coinModel = model;
  }

  accent() {
    return this.mg ? THEMES[this.mg].accent : 0x7cf4c9;
  }

  build(mg: MinigameId, layout: Layout, world: WorldState) {
    this.clear();
    this.mg = mg;
    this.layout = layout;
    const theme = THEMES[mg];
    const backdrop = buildBackdrop(theme, layout.kind !== 'tiles');
    this.group.add(backdrop.group);
    this.clouds = backdrop.clouds;
    this.disposables.push(backdrop);
    this.scene.background = new THREE.Color(theme.deep);
    const side = toon(theme.side);
    const accent = toon(theme.accent);

    if (layout.kind === 'disc') {
      const tex = discTexture(theme);
      const top = new THREE.MeshToonMaterial({ map: tex, gradientMap: toonRamp() });
      const geo = new THREE.CylinderGeometry(1, 0.94, DISC_H, 64);
      // A floating rock under the platform, so the arena reads as an island in the sky.
      const rockGeo = new THREE.ConeGeometry(0.94, 2.6, 9);
      const inkGeo = new THREE.CylinderGeometry(1, 0.94, DISC_H, 64);
      const inkMat = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
      this.disposables.push(tex, top, geo, rockGeo, inkGeo, inkMat);
      this.disc = new THREE.Group();
      const slab = new THREE.Mesh(geo, [side, top, side]);
      slab.position.y = -DISC_H / 2;
      slab.receiveShadow = true;
      const rock = new THREE.Mesh(rockGeo, toon(0x8a6a58));
      rock.rotation.x = Math.PI;
      rock.position.y = -DISC_H - 1.3;
      const rockInk = new THREE.Mesh(rockGeo, inkMat);
      rockInk.scale.set(1.02, 1.04, 1.02);
      rock.add(rockInk);
      this.disc.add(slab, rock);
      this.discInk = new THREE.Mesh(inkGeo, inkMat);
      this.group.add(this.disc, this.discInk);
      this.setRadius(world.radius ?? layout.radius);
    } else if (layout.kind === 'square') {
      const size = layout.half * 2;
      const tex = checkerTexture(theme, Math.max(4, Math.round(size / 2.5)));
      const top = new THREE.MeshToonMaterial({ map: tex, gradientMap: toonRamp() });
      const geo = new THREE.BoxGeometry(size, 1.2, size);
      this.disposables.push(tex, top, geo);
      const floor = new THREE.Mesh(geo, [side, side, top, side, side, side]);
      floor.position.y = -0.6;
      floor.receiveShadow = true;
      floor.add(this.hull(geo));
      this.group.add(floor);
      const wallGeoX = new THREE.BoxGeometry(size + 0.6, 0.7, 0.3);
      const wallGeoZ = new THREE.BoxGeometry(0.3, 0.7, size + 0.6);
      const postGeo = new THREE.CylinderGeometry(0.32, 0.36, 1.2, 10);
      this.disposables.push(wallGeoX, wallGeoZ, postGeo);
      for (const s of [-1, 1]) {
        const wx = new THREE.Mesh(wallGeoX, accent);
        wx.position.set(0, 0.35, s * (layout.half + 0.15));
        const wz = new THREE.Mesh(wallGeoZ, accent);
        wz.position.set(s * (layout.half + 0.15), 0.35, 0);
        wx.castShadow = wz.castShadow = true;
        wx.add(this.hull(wallGeoX));
        wz.add(this.hull(wallGeoZ));
        this.group.add(wx, wz);
        for (const t of [-1, 1]) {
          const post = new THREE.Mesh(postGeo, toon(0xffffff));
          post.position.set(s * (layout.half + 0.15), 0.6, t * (layout.half + 0.15));
          post.castShadow = true;
          post.add(this.hull(postGeo));
          this.group.add(post);
        }
      }
    } else {
      const n = layout.cols * layout.rows;
      const geo = new THREE.BoxGeometry(layout.size * 0.94, 0.5, layout.size * 0.94);
      const hullGeo = hullGeometry(geo);
      const tex = tileTexture();
      this.disposables.push(geo, hullGeo, tex);
      const ink = rkInk();
      for (let i = 0; i < n; i++) {
        const c = tileCenter(layout, i);
        const checker = (i % layout.cols) + Math.floor(i / layout.cols);
        const base = new THREE.Color(checker % 2 ? theme.floorB : theme.floorA);
        const mat = new THREE.MeshToonMaterial({ color: base, map: tex, gradientMap: toonRamp(), emissive: 0x000000 });
        this.disposables.push(mat);
        const tile = new THREE.Mesh(geo, mat);
        tile.position.set(c.x, -0.25, c.z);
        tile.receiveShadow = true;
        tile.castShadow = true;
        tile.add(new THREE.Mesh(hullGeo, ink));
        this.group.add(tile);
        this.tiles.push(tile);
        this.tileStates.push(0);
        this.tileFall.push(0);
      }
      const lavaGeo = new THREE.PlaneGeometry(260, 260);
      this.lavaMat = lavaMaterial();
      this.disposables.push(lavaGeo, this.lavaMat);
      this.lava = new THREE.Mesh(lavaGeo, this.lavaMat);
      this.lava.rotation.x = -Math.PI / 2;
      this.lava.position.y = -4;
      this.group.add(this.lava);
    }

    // Bars (sweeper).
    if (world.bars) {
      this.barMat = accent;
      for (const bar of world.bars) this.bars.push(this.makeBar(bar.len, accent));
    }
    this.update(world, 0);
  }

  private hull(geo: THREE.BufferGeometry) {
    const h = hullGeometry(geo);
    this.disposables.push(h);
    return new THREE.Mesh(h, rkInk());
  }

  private makeBar(len: number, mat: THREE.Material) {
    const pivot = new THREE.Group();
    const geo = new THREE.BoxGeometry(len, BAR_HEIGHT, BAR_THICKNESS);
    const hubGeo = new THREE.CylinderGeometry(0.5, 0.5, BAR_HEIGHT + 0.3, 16);
    const capGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.12, 16);
    this.disposables.push(geo, hubGeo, capGeo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(len / 2, BAR_HEIGHT / 2, 0);
    mesh.castShadow = true;
    mesh.add(this.hull(geo));
    pivot.add(mesh);
    const hub = new THREE.Mesh(hubGeo, toon(0xffffff));
    hub.position.y = (BAR_HEIGHT + 0.3) / 2;
    hub.castShadow = true;
    hub.add(this.hull(hubGeo));
    const cap = new THREE.Mesh(capGeo, toon(0xffc928));
    cap.position.y = (BAR_HEIGHT + 0.3) / 2 + 0.06;
    hub.add(cap);
    pivot.add(hub);
    this.group.add(pivot);
    return pivot;
  }

  private setRadius(r: number) {
    if (!this.disc || !this.discInk) return;
    this.disc.scale.set(r, 1, r);
    const k = r + DISC_INK;
    this.discInk.scale.set(k, (DISC_H + DISC_INK * 2) / DISC_H, k);
    this.discInk.position.y = -DISC_H / 2;
  }

  /** Apply the latest world state; `dt` animates tile falls and coin spin. */
  update(world: WorldState, dt: number) {
    if (world.radius !== undefined) this.setRadius(world.radius);
    const now = performance.now();

    if (world.tiles && this.tiles.length) {
      for (let i = 0; i < this.tiles.length; i++) {
        const state = world.tiles[i] ?? 0;
        const tile = this.tiles[i];
        const mat = tile.material as THREE.MeshToonMaterial;
        if (state !== this.tileStates[i]) {
          this.tileStates[i] = state;
          if (state === 1) mat.emissive.setHex(0xff3b1f);
          if (state === 2) this.tileFall[i] = 0.001;
        }
        if (state === 1) {
          // Hard on/off blink: cartoon warning light rather than a soft glow.
          const on = Math.sin(now / 70) > 0;
          mat.emissiveIntensity = on ? 1.3 : 0.25;
          tile.position.y = -0.25 + (Math.random() - 0.5) * 0.05;
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
        if (!this.bars[i]) this.bars.push(this.makeBar(world.bars[i].len, this.barMat ?? toon(this.accent())));
        // Bar angle is measured from +x toward +z; three's rotation.y is the other way around.
        this.bars[i].rotation.y = -world.bars[i].a;
      }
    }

    if (world.coins) {
      const seen = this.seen;
      seen.clear();
      for (const c of world.coins) {
        seen.add(c.id);
        let g = this.coins.get(c.id);
        if (!g) {
          g = instantiate(this.coinModel, undefined, () => inked(new THREE.CylinderGeometry(0.3, 0.3, 0.08, 16).rotateX(Math.PI / 2), 0xffc928));
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
          g.position.y = 0.45 + Math.sin(now / 300 + id) * 0.08;
        }
      }
    }
    if (this.lava && this.lavaMat) {
      this.lava.position.y = -4 + Math.sin(now / 900) * 0.15;
      this.lavaMat.uniforms.time.value = now / 1000;
    }
    if (this.clouds) this.clouds.rotation.y += dt * 0.01;
  }

  clear() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.group.clear();
    this.disc = this.discInk = this.lava = this.lavaMat = this.barMat = undefined;
    this.clouds = null;
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

/** Lighting for the toon ramp: a strong key for clear light/shadow bands and a white sky fill, no fog. */
export function addRuckusLights(scene: THREE.Scene) {
  scene.background = new THREE.Color(0x8f7bff);
  scene.fog = null;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a8a7a, 1.5));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
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
}
