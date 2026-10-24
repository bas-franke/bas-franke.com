// Builds the three.js scene for the Rockets arena from the server's box list.

import * as THREE from 'three';
import type { BoxKind, MapData } from '@shared/rockets/map';

function gridTexture(base: string, line: string, cells = 4): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  const step = size / cells;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }
  // Subtle noise so large surfaces are not flat.
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 3, 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const PALETTE: Record<Exclude<BoxKind, 'clip'>, { color: number; edge?: number; emissive?: number }> = {
  floor: { color: 0x1a2236 },
  wall: { color: 0x151c2c },
  platform: { color: 0x27324a, edge: 0x7cf4c9 },
  stair: { color: 0x2b3650 },
  pillar: { color: 0x33405c, edge: 0x6ea8fe },
  crate: { color: 0x7a5636, edge: 0xffd166 },
  ledge: { color: 0x27324a, edge: 0xff7a59 },
  tower: { color: 0x2d3a56, edge: 0xf78cff },
};

export interface ArenaView {
  group: THREE.Group;
  padRings: THREE.Mesh[];
  dispose(): void;
}

export function buildArena(map: MapData): ArenaView {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const floorTex = gridTexture('#1b2338', 'rgba(124,244,201,0.12)', 2);
  const wallTex = gridTexture('#141b2b', 'rgba(255,255,255,0.05)', 2);
  disposables.push(floorTex, wallTex);

  type Visible = Exclude<BoxKind, 'clip'>;
  const materials = new Map<Visible, THREE.MeshStandardMaterial>();
  const materialFor = (kind: Visible) => {
    let m = materials.get(kind);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: map.tint?.[kind] ?? PALETTE[kind].color, roughness: 0.85, metalness: 0.05 });
      if (kind === 'floor') m.map = floorTex;
      if (kind === 'wall') m.map = wallTex;
      materials.set(kind, m);
      disposables.push(m);
    }
    return m;
  };

  for (const b of map.boxes) {
    if (b.kind === 'clip') continue;
    const sx = b.max.x - b.min.x;
    const sy = b.max.y - b.min.y;
    const sz = b.max.z - b.min.z;
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    disposables.push(geo);
    const mat = materialFor(b.kind);
    if (b.kind === 'floor' || b.kind === 'wall') {
      // Scale the texture by world size so cells stay square.
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (b.kind === 'floor' ? sx / 4 : Math.max(sx, sz) / 4), uv.getY(i) * (b.kind === 'floor' ? sz / 4 : sy / 4));
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    mesh.receiveShadow = true;
    mesh.castShadow = b.kind !== 'floor' && b.kind !== 'wall';
    group.add(mesh);

    const edge = PALETTE[b.kind].edge;
    if (edge && b.kind !== 'stair') {
      const edges = new THREE.EdgesGeometry(geo);
      const lineMat = new THREE.LineBasicMaterial({ color: edge, transparent: true, opacity: 0.55 });
      const lines = new THREE.LineSegments(edges, lineMat);
      lines.position.copy(mesh.position);
      group.add(lines);
      disposables.push(edges, lineMat);
    }
  }

  // Jump pads: a glowing disc with a ring that the client spins.
  const padRings: THREE.Mesh[] = [];
  const padMat = new THREE.MeshStandardMaterial({ color: 0x0e2a24, emissive: 0x7cf4c9, emissiveIntensity: 0.9, roughness: 0.4 });
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x7cf4c9, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
  disposables.push(padMat, ringMat);
  for (const pad of map.pads) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(pad.radius, pad.radius * 1.05, 0.12, 32), padMat);
    disc.position.set(pad.pos.x, pad.pos.y + 0.06, pad.pos.z);
    disc.receiveShadow = true;
    group.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(pad.radius * 0.75, 0.05, 8, 40), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(pad.pos.x, pad.pos.y + 0.2, pad.pos.z);
    group.add(ring);
    padRings.push(ring);
    const light = new THREE.PointLight(0x7cf4c9, 6, 7, 2);
    light.position.set(pad.pos.x, pad.pos.y + 1, pad.pos.z);
    group.add(light);
  }

  // Mood lights on the towers.
  const towerColors = [0xf78cff, 0x6ea8fe, 0xffd166, 0xff7a59];
  map.boxes
    .filter((b) => b.kind === 'tower')
    .forEach((b, i) => {
      const light = new THREE.PointLight(towerColors[i % towerColors.length], 18, 16, 2);
      light.position.set((b.min.x + b.max.x) / 2, b.max.y + 2.5, (b.min.z + b.max.z) / 2);
      group.add(light);
    });

  // Spawn markers: faint rings on the floor so the arena does not look empty.
  const spawnMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, side: THREE.DoubleSide });
  disposables.push(spawnMat);
  for (const s of map.spawns) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.7, 24), spawnMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(s.pos.x, s.pos.y + 0.02, s.pos.z);
    group.add(ring);
  }

  return {
    group,
    padRings,
    dispose: () => {
      for (const d of disposables) d.dispose();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && !disposables.includes(m.geometry)) m.geometry.dispose();
      });
    },
  };
}

export function addArenaLights(scene: THREE.Scene, map: MapData) {
  scene.background = new THREE.Color(map.skyColor);
  // Fog scales with the map so the far side of the bigger arenas still reads.
  scene.fog = new THREE.Fog(map.fogColor, map.half * 1.1, Math.max(95, map.half * 4));
  const hemi = new THREE.HemisphereLight(0x9fbfff, 0x2a2018, 1.4);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.8);
  sun.position.set(18, 30, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const half = map.half + 4;
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 40 + map.half * 3;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);
  const fill = new THREE.DirectionalLight(0x7cf4c9, 0.6);
  fill.position.set(-20, 10, -15);
  scene.add(fill);
}
