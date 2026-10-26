// GLB models built in Blender (see play/tools/blender). Loaded once, cloned per use, tinted per player through the
// material named "Team". If a file is missing the game falls back to a primitive so it stays playable.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group | null>>();

export type ModelName = 'droid' | 'launcher' | 'rocket' | 'healthpack';

export function loadModel(name: ModelName): Promise<THREE.Group | null> {
  let p = cache.get(name);
  if (!p) {
    p = loader
      .loadAsync(`/models/${name}.glb`)
      .then((gltf) => {
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.receiveShadow = false;
          }
        });
        return gltf.scene;
      })
      .catch((err) => {
        console.warn(`model ${name} failed to load; using a placeholder`, err);
        return null;
      });
    cache.set(name, p);
  }
  return p;
}

export function preload(names: ModelName[]) {
  return Promise.all(names.map(loadModel));
}

/** A fresh copy of a loaded model, with team-coloured materials replaced by the given colour. */
export function instantiate(template: THREE.Group | null, color?: number, fallback?: () => THREE.Object3D): THREE.Group {
  const group = new THREE.Group();
  if (!template) {
    if (fallback) group.add(fallback());
    return group;
  }
  const clone = template.clone(true);
  clone.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const replaced = mats.map((mat) => {
      if (color !== undefined && mat.name === 'Team') {
        const c = (mat as THREE.MeshStandardMaterial).clone();
        c.color.setHex(color);
        return c;
      }
      return mat;
    });
    m.material = Array.isArray(m.material) ? replaced : replaced[0];
  });
  group.add(clone);
  return group;
}

export function capsuleFallback(color: number, radius = 0.4, height = 1.8) {
  const geo = new THREE.CapsuleGeometry(radius, Math.max(0.1, height - radius * 2), 6, 12);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = height / 2;
  mesh.castShadow = true;
  return mesh;
}

export function boxFallback(color: number, size = 0.5) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
  mesh.position.y = size / 2;
  mesh.castShadow = true;
  return mesh;
}

export function sphereFallback(color: number, radius = 0.3) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10), new THREE.MeshStandardMaterial({ color, roughness: 0.4 }));
  mesh.position.y = radius;
  mesh.castShadow = true;
  return mesh;
}
