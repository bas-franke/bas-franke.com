// Procedural PBR texture sets for Last Light: albedo (sRGB), tangent-space normal (from a height field via Sobel)
// and an ORM-style map (G roughness, B metalness, as three's roughnessMap / metalnessMap read them). Every set tiles
// seamlessly and covers `meters` of world space, because world.ts maps them with world-space box projection.
//
// Generating the full-resolution sets takes a couple of seconds of CPU, so it never blocks the frame: texSet() returns
// a 64 px version straight away (a few milliseconds) and hands the real one to a small pool of workers
// (texworker.ts). When it arrives, the set's textures are replaced and `onUpgrade` listeners swap them into their
// materials. Results are cached for the page, so the next match starts with the sharp versions.

import * as THREE from 'three';
import { SPECS, type SetName, type TexData, generate } from './texgen';

export type { SetName } from './texgen';

export interface TexSet {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  orm: THREE.DataTexture;
  /** World size of one tile in metres. */
  meters: number;
  /** True once the full-resolution textures are in. */
  sharp: boolean;
  /** Called (once) when the full-resolution textures replace the placeholder ones. */
  onUpgrade(fn: (set: TexSet) => void): void;
}

const PLACEHOLDER = 64;

function dataTex(data: Uint8Array, size: number, srgb: boolean) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---- worker pool ---------------------------------------------------------------------------------------------------

interface Job {
  name: SetName;
  n: number;
  done: (d: TexData) => void;
}

const queue: Job[] = [];
const workers: { w: Worker; busy: Job | null }[] = [];
let workersFailed = false;

function pool() {
  if (workers.length || workersFailed) return workers;
  const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  try {
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./texworker.ts', import.meta.url), { type: 'module' });
      const slot = { w, busy: null as Job | null };
      w.onmessage = (e: MessageEvent<TexData>) => {
        const job = slot.busy;
        slot.busy = null;
        job?.done(e.data);
        pump();
      };
      w.onerror = () => {
        // A broken worker: finish its job here and stop using workers.
        const job = slot.busy;
        slot.busy = null;
        workersFailed = true;
        if (job) queue.unshift(job);
        pump();
      };
      workers.push(slot);
    }
  } catch {
    workersFailed = true;
  }
  return workers;
}

function pump() {
  if (!queue.length) return;
  if (workersFailed) {
    // Main-thread fallback, one set per idle slot so frames keep coming.
    const job = queue.shift()!;
    setTimeout(() => {
      job.done(generate(job.name, job.n));
      pump();
    }, 16);
    return;
  }
  for (const slot of pool()) {
    if (slot.busy || !queue.length) continue;
    const job = queue.shift()!;
    slot.busy = job;
    slot.w.postMessage({ name: job.name, n: job.n });
  }
  if (workersFailed) pump();
}

// ---- sets ----------------------------------------------------------------------------------------------------------

const cache = new Map<string, TexSet>();

/** The texture set `name`; placeholder first, sharp shortly after. `size` overrides the resolution (low quality). */
export function texSet(name: SetName, size?: number): TexSet {
  const spec = SPECS[name];
  const n = size ?? spec.size;
  const key = `${name}:${n}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const small = generate(name, Math.min(PLACEHOLDER, n));
  const ps = Math.min(PLACEHOLDER, n);
  const listeners: ((s: TexSet) => void)[] = [];
  const set: TexSet = {
    map: dataTex(small.albedo, ps, true),
    normalMap: dataTex(small.normal, ps, false),
    orm: dataTex(small.orm, ps, false),
    meters: spec.meters,
    sharp: n <= PLACEHOLDER,
    onUpgrade(fn) {
      if (set.sharp) return;
      listeners.push(fn);
    },
  };
  cache.set(key, set);
  if (!set.sharp) {
    queue.push({
      name,
      n,
      done: (d) => {
        const old = [set.map, set.normalMap, set.orm];
        set.map = dataTex(d.albedo, n, true);
        set.normalMap = dataTex(d.normal, n, false);
        set.orm = dataTex(d.orm, n, false);
        set.sharp = true;
        for (const fn of listeners.splice(0)) fn(set);
        for (const t of old) t.dispose();
      },
    });
    // Big sets first: they take longest.
    queue.sort((a, b) => b.n - a.n);
    pump();
  }
  return set;
}

/** Resolves when every set requested so far is sharp (screenshots, warm-up). */
export function texturesSettled(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => ([...cache.values()].every((s) => s.sharp) ? resolve() : setTimeout(check, 50));
    check();
  });
}

export const DEFAULT_SIZE = (name: SetName) => SPECS[name].size;
