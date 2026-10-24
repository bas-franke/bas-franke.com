// Where things go around a track, shared by every world module so they agree: how far the canyon walls are from the
// road on each side, where the track crosses a gorge on a bridge, where the grandstands, waterfalls, the great arch
// and the mesa city are. Deterministic from the track's seed. Owned by the integrator: ask before changing it.

import * as THREE from 'three';
import { rng, type Track } from '../core/track';

export interface Span {
  /** Start and end distance along the track (s0 < s1, may exceed the track length: wrap with track.wrap). */
  s0: number;
  s1: number;
}

export interface Zones {
  /**
   * Distance from the centreline (metres, always > width/2 + 6) to the foot of the canyon wall on a side
   * (-1 left, 1 right). Infinity where that side is open (gorge crossing, vista).
   */
  wallOffset(s: number, side: -1 | 1): number;
  /** Height of the canyon wall above the road at s on a side (0 where open). */
  wallHeight(s: number, side: -1 | 1): number;
  /** Track stretches that are a bridge over a deep gorge: the ground drops ~90 m, a river runs below. */
  gorges: (Span & { depth: number })[];
  /** Grandstand sections: balconies/terraces cut into the wall on that side, crowds and awnings. */
  stands: (Span & { side: -1 | 1 })[];
  /** Waterfalls: top-centre position, width, drop height, and the direction the water falls towards (horizontal). */
  waterfalls: { top: THREE.Vector3; width: number; drop: number; facing: THREE.Vector3 }[];
  /** A natural rock arch spanning the track at s (null if the track has none). */
  arch: { s: number; span: number; height: number } | null;
  /** Mesa-top settlement far from the track: centre on the ground, radius and the mesa's height. */
  city: { pos: THREE.Vector3; radius: number; height: number } | null;
  /** Open vista stretches per side (no wall, long view across the desert). */
  vistas: (Span & { side: -1 | 1 })[];
}

const cache = new WeakMap<Track, Zones>();

export function zonesFor(track: Track): Zones {
  let z = cache.get(track);
  if (!z) {
    z = build(track);
    cache.set(track, z);
  }
  return z;
}

function inSpan(track: Track, s: number, sp: Span) {
  const w = track.wrap(s);
  const a = track.wrap(sp.s0);
  const len = sp.s1 - sp.s0;
  const d = track.wrap(w - a);
  return d <= len;
}

/** 0..1 ramp that is 1 inside the span and fades over `edge` metres outside it. */
function spanWeight(track: Track, s: number, sp: Span, edge: number) {
  const w = track.wrap(s);
  const mid = track.wrap(sp.s0 + (sp.s1 - sp.s0) / 2);
  let d = Math.abs(w - mid);
  d = Math.min(d, track.length - d);
  const half = (sp.s1 - sp.s0) / 2;
  return THREE.MathUtils.clamp(1 - (d - half) / edge, 0, 1);
}

function build(track: Track): Zones {
  const r = rng(track.def.seed * 7 + 3);
  const L = track.length;
  const theme = track.def.theme;

  // Smooth periodic noise along the track per side: a few sines with random phases.
  const wave = (k: number[]) => {
    const ph = k.map(() => r() * Math.PI * 2);
    return (s: number) => k.reduce((sum, kk, i) => sum + Math.sin((s / L) * Math.PI * 2 * kk + ph[i]) / k.length, 0);
  };
  const nl = wave([3, 7, 13]);
  const nr = wave([4, 9, 17]);
  const hl = wave([2, 5, 11]);
  const hr = wave([3, 6, 10]);

  // Start straight: stands on both sides just before and after the line.
  const stands: Zones['stands'] = [
    { s0: L - 160, s1: L + 40, side: -1 },
    { s0: L - 120, s1: L + 10, side: 1 },
  ];
  const extraStand = 0.3 + r() * 0.35;
  stands.push({ s0: L * extraStand, s1: L * extraStand + 120, side: r() < 0.5 ? -1 : 1 });

  const gorges: Zones['gorges'] = [];
  const waterfalls: Zones['waterfalls'] = [];
  if (theme.waterfalls) {
    const at = L * (0.55 + r() * 0.15);
    const g = { s0: at - 110, s1: at + 110, depth: 90 };
    gorges.push(g);
    // Falls pour into the gorge from cliffs up- and downstream of the bridge, facing the bridge.
    const f = track.frameAt(at);
    // Unbanked right, so the bank of the bridge does not tilt fall positions hundreds of metres out.
    const flatRight = f.right.clone().setY(0).normalize();
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < 2; i++) {
        const dist = 120 + i * 80 + r() * 30;
        const along = (r() - 0.5) * 60;
        const top = f.pos.clone().addScaledVector(flatRight, side * dist).addScaledVector(f.tangent, along);
        top.y += 25 + r() * 25;
        waterfalls.push({ top, width: 14 + r() * 22, drop: 90 + top.y - f.pos.y, facing: flatRight.clone().multiplyScalar(-side) });
      }
    }
  }

  const vistas: Zones['vistas'] = [];
  const vAt = L * (0.15 + r() * 0.1);
  vistas.push({ s0: vAt, s1: vAt + L * 0.12, side: r() < 0.5 ? -1 : 1 });

  let arch: Zones['arch'] = null;
  if (theme.arches) {
    const s = L * (0.35 + r() * 0.12);
    arch = { s, span: track.frameAt(s).width + 50, height: 55 + r() * 20 };
  }

  let city: Zones['city'] = null;
  if (theme.skyCity) {
    // Outside the loop, beyond the bounding box, on the side facing the start straight.
    const c = track.bounds.getCenter(new THREE.Vector3());
    const f = track.frameAt(L * 0.95);
    const dir = f.pos.clone().sub(c).setY(0).normalize();
    const size = track.bounds.getSize(new THREE.Vector3());
    const pos = c.clone().addScaledVector(dir, Math.max(size.x, size.z) / 2 + 500);
    pos.y = 0;
    city = { pos, radius: 160, height: 120 };
  }

  const wallOffset = (s: number, side: -1 | 1) => {
    for (const g of gorges) if (spanWeight(track, s, g, 0) > 0) return Infinity;
    for (const v of vistas) if (v.side === side && inSpan(track, s, v)) return Infinity;
    const f = track.frameAt(s);
    const n = side < 0 ? nl(s) : nr(s);
    let off = f.width / 2 + 16 + (n + 1) * 22;
    // Stands sit on a terrace: push the wall back a little there.
    for (const st of stands) if (st.side === side) off += spanWeight(track, s, st, 40) * 10;
    return off;
  };
  const wallHeight = (s: number, side: -1 | 1) => {
    if (!Number.isFinite(wallOffset(s, side))) return 0;
    let fade = 1;
    for (const g of gorges) fade = Math.min(fade, 1 - spanWeight(track, s, g, 80) * 0.6);
    for (const v of vistas) if (v.side === side) fade = Math.min(fade, 1 - spanWeight(track, s, v, 60));
    const n = side < 0 ? hl(s) : hr(s);
    return (45 + (n + 1) * 40) * fade;
  };

  return { wallOffset, wallHeight, gorges, stands, waterfalls, arch, city, vistas };
}
