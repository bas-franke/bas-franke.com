// Last Light models: the Blender-built GLBs in public/models/zombies (tools/blender/build_zombies.py, `npm run
// models:zombies`), loaded once and cloned per use. Characters get their own mixer, actions and tintable clothes;
// guns, arms and props are plain clones. If a file fails to load, primitives stand in so the game stays playable.
//
// Notes for the client:
// - GLTFLoader strips dots from node names ("hand.R" -> "handR"); `bones` has both spellings.
// - Survivors carry an extra `bones.grip`: an Object3D on the right hand at the rifle grip the hold poses were solved
//   for (IK in build_zombies.py), oriented so a gun added to it with no offset points forward (-Z) in the idle pose.
//   Both hands hold the gun in idle, walk, run and reload.
// - One-shot clips (attack, vault, rise, death_*, reload) are LoopOnce and clamp on their last frame.
// - Zombie attack: the blow lands 0.55 s into the 1.0 s clip.

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { WeaponId } from '@shared/zombies/weapons';
import type { CharacterInstance, Models, SurvivorClip, ZombieClip } from './api';

const BASE = '/models/zombies/';
const ZOMBIE_CLIPS: ZombieClip[] = ['idle', 'walk', 'jog', 'crawl', 'attack', 'tear', 'vault', 'rise', 'death_back', 'death_fwd'];
const SURVIVOR_CLIPS: SurvivorClip[] = ['idle', 'walk', 'run', 'downed', 'reload'];
const ONE_SHOT = new Set(['attack', 'vault', 'rise', 'death_back', 'death_fwd', 'reload']);
const BONE_NAMES = ['root', 'hips', 'spine', 'chest', 'neck', 'head', ...['upperarm', 'forearm', 'hand', 'thigh', 'shin', 'foot'].flatMap((b) => [`${b}.L`, `${b}.R`])];

/** Default jacket colour before a zombie's variant tint is applied. */
const SHIRTS = [0x3a3836];

/**
 * Zombie bodies in zombie.glb (build_zombies.py ZOMBIE_VARIANTS: businessman, bellhop, housekeeper, businesswoman) and
 * their clothing colours: [top (Cloth), bottom (ClothB)]. The albedo texture carries dirt, blood and weave; these
 * colours multiply it.
 */
const ZOMBIE_BODIES = 4;
const ZOMBIE_CLOTHES: [number[], number[]][] = [
  [[0x3a3836, 0x2d2f36, 0x4a4036, 0x30302e, 0x3b3530], [0x26262a, 0x2e2b28, 0x1f2023, 0x34302a]],
  [[0x7a1c18, 0x6e1a24, 0x5c1a1a, 0x7a2a1c], [0x1a1a1c, 0x222226]],
  [[0x6a6c70, 0x5a5e66, 0x4c5a5a, 0x5e5a62], [0x2a2624, 0x1e1c1c, 0x302826]],
  [[0xd8cfc0, 0xc9b9a8, 0xa9b4c2, 0xc8c0cc], [0x2a2a2e, 0x3a2e2a, 0x2c3040]],
];

/** Where the hold poses put the rifle grip, in the survivor's own space (build_zombies.py GRIP, converted to y-up). */
const GRIP = new THREE.Vector3(0.15, 1.2, -0.36);

const loader = new GLTFLoader();

function load(name: string): Promise<GLTF | null> {
  return loader.loadAsync(`${BASE}${name}.glb`).catch((err) => {
    console.warn(`Last Light: ${name}.glb failed to load; using primitives`, err);
    return null;
  });
}

/** Small deterministic hash so a variant always looks the same on every client. */
function hash(n: number, salt: number) {
  let h = (n * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function prepare(root: THREE.Object3D, skinned: boolean) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    // Bounds come from the rest pose; crawling and dying bodies leave them, so never cull characters.
    if (skinned) m.frustumCulled = false;
  });
}

/** Replaces the named materials with per-instance clones and returns them by name. */
function ownMaterials(root: THREE.Object3D, names: string[]) {
  const own = new Map<string, THREE.MeshStandardMaterial>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const swap = (mat: THREE.Material) => {
      if (!names.includes(mat.name)) return mat;
      let c = own.get(mat.name);
      if (!c) {
        c = (mat as THREE.MeshStandardMaterial).clone();
        own.set(mat.name, c);
      }
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
  });
  return own;
}

function boneMap(root: THREE.Object3D): Record<string, THREE.Bone> {
  const out: Record<string, THREE.Bone> = {};
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) out[o.name] = o as THREE.Bone;
  });
  for (const n of BONE_NAMES) {
    const b = out[n] ?? out[THREE.PropertyBinding.sanitizeNodeName(n)];
    if (b) out[n] = b;
  }
  return out;
}

function makeActions(mixer: THREE.AnimationMixer, clips: THREE.AnimationClip[], names: string[]) {
  const actions: Record<string, THREE.AnimationAction> = {};
  for (const name of names) {
    const clip = clips.find((c) => c.name === name) ?? new THREE.AnimationClip(name, 1, []);
    const a = mixer.clipAction(clip);
    if (ONE_SHOT.has(name)) {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
    }
    actions[name] = a;
  }
  return actions;
}

// ---- primitive fallbacks -------------------------------------------------------------------------------------------

function fallbackCharacter(color: number, zombie: boolean): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, name: zombie ? 'Cloth' : 'Team' });
  const skin = new THREE.MeshStandardMaterial({ color: zombie ? 0x6b7362 : 0x9c735c, roughness: 0.8, name: 'Skin' });
  const add = (name: string, geo: THREE.BufferGeometry, m: THREE.Material, y: number, x = 0) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.name = name;
    mesh.position.set(x, y, 0);
    g.add(mesh);
    return mesh;
  };
  add(zombie ? 'Zombie_Body' : 'Survivor_Body', new THREE.CapsuleGeometry(0.17, 0.45, 4, 10), mat, 1.2);
  add(zombie ? 'Zombie_Head' : 'Survivor_Head', new THREE.SphereGeometry(0.11, 12, 10), skin, 1.66);
  for (const [s, x] of [
    ['L', -1],
    ['R', 1],
  ] as const) {
    add(zombie ? `Zombie_Arm${s}` : `Survivor_Arm${s}`, new THREE.CapsuleGeometry(0.045, 0.5, 4, 8), skin, 1.15, x * 0.25);
    add(zombie ? `Zombie_Leg${s}` : `Survivor_Leg${s}`, new THREE.CapsuleGeometry(0.07, 0.75, 4, 8), mat, 0.48, x * 0.1);
  }
  prepare(g, false);
  return g;
}

function fallbackGun(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.4, metalness: 0.8 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.5), mat);
  body.position.set(0, 0.06, -0.15);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.11, 0.05), mat);
  grip.position.set(0, -0.02, 0);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.12, 0.03), mat);
  mag.position.set(0, -0.03, -0.1);
  mag.name = 'mag';
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.06, -0.42);
  muzzle.name = 'muzzle';
  g.add(body, grip, mag, muzzle);
  prepare(g, false);
  return g;
}

/** Width, height, depth (m) and colour of each hotel prop, for the fallback boxes. */
const HOTEL_FALLBACK: Record<string, [number, number, number, number]> = {
  sofa: [2.2, 0.95, 1.0, 0xd8cdb8],
  armchair: [0.85, 0.85, 0.85, 0xd8cdb8],
  brassTable: [0.64, 0.56, 0.64, 0xb08a3e],
  coffeeTable: [1.2, 0.5, 0.7, 0x1a1a1a],
  tableLamp: [0.4, 0.68, 0.4, 0xe8dcc0],
  floorLamp: [0.5, 1.68, 0.5, 0xe8dcc0],
  planterTree: [1.6, 2.6, 1.5, 0x2e4a24],
  flowers: [0.8, 1.27, 0.7, 0xe8e4da],
  sconce: [0.1, 0.42, 0.15, 0xb08a3e],
  pendant: [1.05, 0.25, 1.05, 0xb08a3e],
  revolvingDoor: [4.1, 3.1, 4.1, 0xb08a3e],
  elevatorDoors: [2.7, 2.95, 0.25, 0xb08a3e],
  securityShutter: [6.2, 4.4, 0.4, 0x6a6864],
  barStool: [0.44, 0.97, 0.45, 0x222222],
  booth: [2.0, 1.22, 0.71, 0x4a2a16],
  diningTable: [1.0, 0.77, 1.0, 0xe8e4da],
  diningChair: [0.5, 1.0, 0.55, 0x4a2a16],
  luggageCart: [1.12, 1.85, 0.62, 0xb08a3e],
  stanchion: [0.32, 0.97, 0.32, 0xb08a3e],
  receptionBell: [0.11, 0.08, 0.11, 0xb08a3e],
  computer: [0.55, 0.47, 0.41, 0x111111],
};

function fallbackProp(name: string): THREE.Object3D {
  const mat = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
  const g = new THREE.Group();
  switch (name) {
    case 'locker': {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.5), mat(0x18281f, { metalness: 0.4 }));
      m.position.y = 1;
      g.add(m);
      break;
    }
    case 'lamp': {
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), mat(0xffd9a0, { emissive: 0xffb860, emissiveIntensity: 8, name: 'Bulb' }));
      bulb.material.name = 'Bulb';
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.14, 20, 1, true), mat(0x1c2b24, { metalness: 0.5, side: THREE.DoubleSide }));
      shade.position.y = 0.06;
      g.add(bulb, shade);
      break;
    }
    case 'board':
      g.add(new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.18, 0.035), mat(0x5c4530)));
      break;
    case 'nade':
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), mat(0x2d3318)));
      break;
    case 'fence': {
      const m = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.1, 0.01), mat(0x4a4744, { metalness: 0.8, wireframe: true }));
      m.position.y = 1.05;
      g.add(m);
      break;
    }
    case 'tree': {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.22, 6, 8), mat(0x151210));
      m.position.y = 3;
      g.add(m);
      break;
    }    default: {
      // Hotel props: a box of the right size so a failed load still blocks the eye the same way.
      const [w, h, d, color] = HOTEL_FALLBACK[name] ?? [0.5, 0.5, 0.5, 0x777777];
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
      m.position.y = h / 2;
      g.add(m);
    }
  }
  prepare(g, false);
  return g;
}

function fallbackArms(): THREE.Group {
  const g = new THREE.Group();
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x23251f, roughness: 0.85 });
  for (const [name, x, z] of [
    ['ArmR', 0.17, -0.25],
    ['ArmL', 0.0, -0.45],
  ] as const) {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.35, 4, 8), sleeve);
    m.name = name;
    m.position.set(x, -0.27, z);
    m.rotation.x = Math.PI / 2.4;
    g.add(m);
  }
  return g;
}

// ---- factory ---------------------------------------------------------------------------------------------------------

export function createModels(): Models {
  let zombieGltf: GLTF | null = null;
  let survivorGltf: GLTF | null = null;
  let weapons: THREE.Object3D | null = null;
  let props: THREE.Object3D | null = null;
  let arms: THREE.Object3D | null = null;

  const ready = Promise.all([load('zombie'), load('survivor'), load('weapons'), load('props'), load('arms')]).then(([z, s, w, p, a]) => {
    zombieGltf = z;
    survivorGltf = s;
    weapons = w?.scene ?? null;
    props = p?.scene ?? null;
    arms = a?.scene ?? null;
    if (weapons) prepare(weapons, false);
    if (props) prepare(props, false);
    if (arms)
      arms.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.castShadow = false;
      });
  });

  function character(gltf: GLTF | null, zombie: boolean, color: number): CharacterInstance {
    const root = new THREE.Group();
    const model = gltf ? (cloneSkinned(gltf.scene) as THREE.Group) : fallbackCharacter(color, zombie);
    if (gltf) prepare(model, true);
    root.add(model);
    const own = ownMaterials(model, zombie ? ['Cloth', 'ClothB', 'Skin'] : ['Team']);
    const mixer = new THREE.AnimationMixer(model);
    const actions = makeActions(mixer, gltf?.animations ?? [], zombie ? ZOMBIE_CLIPS : SURVIVOR_CLIPS);
    const bones = boneMap(model);
    const named = (n: string) => model.getObjectByName(n) ?? new THREE.Object3D();
    const parts = zombie
      ? { head: named('Zombie_Head'), armL: named('Zombie_ArmL'), armR: named('Zombie_ArmR'), legL: named('Zombie_LegL'), legR: named('Zombie_LegR') }
      : undefined;
    const tint = (primary: number, secondary?: number) => {
      if (zombie) {
        own.get('Cloth')?.color.setHex(primary);
        if (secondary !== undefined) own.get('ClothB')?.color.setHex(secondary);
      } else {
        own.get('Team')?.color.setHex(primary);
      }
    };
    if (!zombie && bones['hand.R']) {
      // Pose the idle frame once and hang a forward-facing grip on the right hand where the poses hold the rifle.
      actions.idle?.play();
      mixer.update(0);
      model.updateMatrixWorld(true);
      const hand = bones['hand.R'];
      const want = new THREE.Matrix4().makeTranslation(GRIP.x, GRIP.y, GRIP.z);
      const grip = new THREE.Object3D();
      grip.name = 'grip';
      grip.applyMatrix4(new THREE.Matrix4().copy(hand.matrixWorld).invert().multiply(want));
      hand.add(grip);
      bones.grip = grip as THREE.Bone;
      actions.idle?.stop();
      mixer.update(0);
    }
    return {
      root,
      mixer,
      actions,
      bones,
      parts,
      tint,
      dispose() {
        mixer.stopAllAction();
        mixer.uncacheRoot(model);
        for (const m of own.values()) m.dispose();
        root.removeFromParent();
      },
    };
  }

  return {
    ready,
    zombie(variant: number) {
      const inst = character(zombieGltf, true, SHIRTS[0]);
      // zombie.glb holds four bodies (businessman, bellhop, housekeeper, businesswoman) as Zombie_<Part>_<k>: keep one, drop the rest.
      const k = Math.floor(hash(variant, 8) * ZOMBIE_BODIES);
      const model = inst.root.children[0];
      if (model?.getObjectByName(`Zombie_Head_${k}`)) {
        const drop: THREE.Object3D[] = [];
        model.traverse((o) => {
          const m = /^Zombie_(Body|Head|ArmL|ArmR|LegL|LegR)_(\d)$/.exec(o.name);
          if (m && Number(m[2]) !== k) drop.push(o);
        });
        for (const o of drop) o.removeFromParent();
        const part = (n: string) => model.getObjectByName(`Zombie_${n}_${k}`) ?? new THREE.Object3D();
        inst.parts = { head: part('Head'), armL: part('ArmL'), armR: part('ArmR'), legL: part('LegL'), legR: part('LegR') };
      }
      const [tops, bottoms] = ZOMBIE_CLOTHES[k] ?? ZOMBIE_CLOTHES[0];
      inst.tint(tops[Math.floor(hash(variant, 1) * tops.length)], bottoms[Math.floor(hash(variant, 2) * bottoms.length)]);
      // A little spread in height, build and skin so a crowd never looks cloned.
      const h = 0.93 + hash(variant, 3) * 0.13;
      inst.root.scale.set(h * (0.95 + hash(variant, 4) * 0.1), h, h);
      const skins = new Set<THREE.MeshStandardMaterial>();
      inst.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat.name === 'Skin') skins.add(mat as THREE.MeshStandardMaterial);
      });
      for (const mat of skins) mat.color.offsetHSL((hash(variant, 5) - 0.5) * 0.06, (hash(variant, 6) - 0.5) * 0.1, (hash(variant, 7) - 0.5) * 0.08);
      return inst;
    },
    survivor(color: number) {
      const inst = character(survivorGltf, false, color);
      inst.tint(color);
      return inst;
    },
    weapon(id: WeaponId) {
      const src = weapons?.getObjectByName(id);
      const root = src ? src.clone(true) : fallbackGun();
      root.position.set(0, 0, 0);
      root.rotation.set(0, 0, 0);
      root.updateMatrix();
      const muzzle = root.getObjectByName(`${id}_muzzle`) ?? root.getObjectByName('muzzle') ?? root;
      const mag = root.getObjectByName(`${id}_mag`) ?? root.getObjectByName('mag') ?? null;
      return { root, muzzle, mag };
    },
    arms() {
      const a = arms ? arms.clone(true) : fallbackArms();
      return a;
    },
    prop(name) {
      const src = props?.getObjectByName(name);
      if (!src) return fallbackProp(name);
      const p = src.clone(true);
      p.position.set(0, 0, 0);
      return p;
    },
  };
}
