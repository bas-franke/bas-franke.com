// Gorge bridges (zones.gorges): over these spans the course is a plank bridge deck with fascia, a steel railing on the
// physics walls and a side truss, standing on steel trestle bents that go down ~90 m into the chasm with ties and
// cross bracing, like the trestles in the concept art. Masonry piers at both ends. One merged vertex-coloured mesh.

import * as THREE from 'three';
import { rng, type Track } from '../core/track';
import { GeoBuilder } from './trackGeo';
import type { Quality } from './types';
import type { Zones } from './zones';

const DECK = 2.6; // deck depth below the road surface

export function buildBridges(track: Track, zones: Zones, quality: Quality, b: GeoBuilder) {
  const r = rng(track.def.seed * 31 + 7);
  const theme = track.def.theme;
  const steel = new THREE.Color('#3b302b');
  const rust = new THREE.Color('#5c3b29');
  const wood = new THREE.Color('#6e4c33');
  const rail = new THREE.Color('#77706a');
  const stone = new THREE.Color(theme.rockShade).lerp(new THREE.Color(theme.rockLit), 0.35);
  const tint = (c: THREE.Color) => b.setColor(c.clone().multiplyScalar(0.85 + r() * 0.3));
  const W = (s: number, x: number, h: number) => track.toWorld(s, x, h, new THREE.Vector3());
  const up = new THREE.Vector3();

  for (const g of zones.gorges) {
    const a = g.s0 - 4;
    const e = g.s1 + 4;

    // Deck: fascia on both sides and the underside, every 2 m.
    const steps = Math.ceil((e - a) / 2);
    for (let i = 0; i < steps; i++) {
      const s0 = a + ((e - a) * i) / steps;
      const s1 = a + ((e - a) * (i + 1)) / steps;
      const f0 = track.frameAt(s0);
      const f1 = track.frameAt(s1);
      for (const side of [-1, 1]) {
        const x0 = side * (f0.width / 2 + 2);
        const x1 = side * (f1.width / 2 + 2);
        up.copy(f0.right).multiplyScalar(side);
        tint(wood);
        b.quad(W(s0, x0, -0.1), W(s1, x1, -0.1), W(s1, x1, -DECK * 0.6), W(s0, x0, -DECK * 0.6), undefined, up);
        b.setColor(steel);
        b.quad(W(s0, x0, -DECK * 0.6), W(s1, x1, -DECK * 0.6), W(s1, x1, -DECK), W(s0, x0, -DECK), undefined, up);
        // Railing kick plate on the physics wall line, both faces.
        const k0 = side * (f0.width / 2);
        const k1 = side * (f1.width / 2);
        b.setColor(rail.clone().multiplyScalar(0.7));
        b.quad(W(s0, k0, -0.1), W(s1, k1, -0.1), W(s1, k1, 0.55), W(s0, k0, 0.55), undefined, up.clone().negate());
        b.quad(W(s0, k0 + side * 0.1, -0.1), W(s1, k1 + side * 0.1, -0.1), W(s1, k1 + side * 0.1, 0.55), W(s0, k0 + side * 0.1, 0.55), undefined, up);
      }
      const hw0 = f0.width / 2 + 2;
      const hw1 = f1.width / 2 + 2;
      // Plank deck on top (the course is sand elsewhere, so the bridge carries its own surface).
      b.setColor(wood.clone().lerp(new THREE.Color(theme.sand), 0.35).multiplyScalar(i % 2 ? 0.92 : 1.05));
      b.quad(W(s0, -hw0, -0.02), W(s1, -hw1, -0.02), W(s1, hw1, -0.02), W(s0, hw0, -0.02), undefined, f0.up);
      b.setColor(steel.clone().multiplyScalar(0.8));
      b.quad(W(s0, -hw0, -DECK), W(s0, hw0, -DECK), W(s1, hw1, -DECK), W(s1, -hw1, -DECK), undefined, f0.up.clone().negate());
    }

    // Railing posts and rails every 3 m.
    const posts = Math.ceil((e - a) / 3);
    for (const side of [-1, 1]) {
      let prev: { lo: THREE.Vector3; hi: THREE.Vector3 } | null = null;
      for (let i = 0; i <= posts; i++) {
        const s = a + ((e - a) * i) / posts;
        const f = track.frameAt(s);
        const x = side * (f.width / 2 + 0.05);
        const base = W(s, x, 0.5);
        const hi = W(s, x, 1.55);
        const lo = W(s, x, 1.05);
        b.setColor(rail);
        b.beam(base, hi.clone().addScaledVector(f.up, 0.05), 0.16, 0.16, f.tangent);
        if (prev) {
          b.setColor(rail.clone().multiplyScalar(1.15));
          b.beam(prev.hi, hi, 0.14, 0.12, f.up);
          b.beam(prev.lo, lo, 0.1, 0.1, f.up);
        }
        prev = { lo, hi };
      }
    }

    // Trestle bents.
    const bents = Math.max(2, Math.round((e - a) / 16));
    const levels = Math.max(3, Math.floor(g.depth / 14));
    type Bent = { legs: THREE.Vector3[][] };
    const all: Bent[] = [];
    for (let k = 0; k <= bents; k++) {
      const s = a + ((e - a) * k) / bents;
      const f = track.frameAt(s);
      const hw = f.width / 2;
      const flat = new THREE.Vector3(f.right.x, 0, f.right.z).normalize();
      const bottomY = f.pos.y - g.depth - 8;
      const tops = [-(hw + 1.2), -hw * 0.35, hw * 0.35, hw + 1.2];
      const bots = [-(hw + 13), -hw * 0.5, hw * 0.5, hw + 13];
      const legs: THREE.Vector3[][] = [];
      for (let j = 0; j < 4; j++) {
        const top = W(s, tops[j], -DECK);
        const bot = f.pos.clone().addScaledVector(flat, bots[j]);
        bot.y = bottomY;
        tint(steel);
        b.beam(top, bot, j === 0 || j === 3 ? 1.0 : 0.8, 0.8, f.tangent);
        const pts: THREE.Vector3[] = [];
        for (let l = 0; l <= levels; l++) pts.push(top.clone().lerp(bot, l / levels));
        legs.push(pts);
      }
      // Ties at every level and X braces in each bay.
      for (let l = 1; l <= levels; l++) {
        for (let j = 0; j < 3; j++) {
          tint(rust);
          b.beam(legs[j][l], legs[j + 1][l], 0.45, 0.45, f.tangent);
          tint(rust);
          b.beam(legs[j][l - 1], legs[j + 1][l], 0.25, 0.25, f.tangent);
          b.beam(legs[j + 1][l - 1], legs[j][l], 0.25, 0.25, f.tangent);
        }
      }
      // Cap beam under the deck.
      b.setColor(steel);
      b.beam(W(s, -(hw + 2.2), -DECK - 0.4), W(s, hw + 2.2, -DECK - 0.4), 0.8, 0.8, f.tangent);
      all.push({ legs });
    }
    // Between bents: longitudinal ties on the outer legs, bracing in the side planes, and a side truss on the deck.
    for (let k = 0; k < bents; k++) {
      const A = all[k];
      const B = all[k + 1];
      for (const j of [0, 3]) {
        for (let l = 1; l <= levels; l++) {
          tint(rust);
          b.beam(A.legs[j][l], B.legs[j][l], 0.35, 0.35);
          if (quality !== 'low' && l > 0) {
            b.beam(A.legs[j][l - 1], B.legs[j][l], 0.22, 0.22);
            b.beam(B.legs[j][l - 1], A.legs[j][l], 0.22, 0.22);
          }
        }
      }
      const sA = a + ((e - a) * k) / bents;
      const sB = a + ((e - a) * (k + 1)) / bents;
      for (const side of [-1, 1]) {
        const xa = side * (track.frameAt(sA).width / 2 + 2.15);
        const xb = side * (track.frameAt(sB).width / 2 + 2.15);
        const sm = (sA + sB) / 2;
        const xm = side * (track.frameAt(sm).width / 2 + 2.15);
        b.setColor(steel);
        b.beam(W(sA, xa, -DECK - 3), W(sB, xb, -DECK - 3), 0.45, 0.45);
        b.beam(W(sA, xa, -DECK), W(sm, xm, -DECK - 3), 0.3, 0.3);
        b.beam(W(sm, xm, -DECK - 3), W(sB, xb, -DECK), 0.3, 0.3);
        b.beam(W(sA, xa, -DECK + 0.2), W(sA, xa, -DECK - 3), 0.4, 0.4);
      }
    }

    // Masonry piers at both ends.
    for (const s of [a, e]) {
      const f = track.frameAt(s);
      const hw = f.width / 2 + 3;
      const flat = new THREE.Vector3(f.right.x, 0, f.right.z).normalize();
      const fwd = new THREE.Vector3(f.tangent.x, 0, f.tangent.z).normalize();
      // Below the lower edge of the (possibly banked) deck so the pier never pokes through the road.
      const topY = Math.min(W(s, -hw, 0).y, W(s, hw, 0).y) - DECK;
      const botY = f.pos.y - g.depth * 0.6;
      const c: THREE.Vector3[] = [];
      for (const y of [botY, topY]) {
        for (const [xs, zs] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const grow = y === botY ? 1.25 : 1;
          c.push(f.pos.clone().addScaledVector(flat, xs * hw * grow).addScaledVector(fwd, zs * 4 * grow).setY(y));
        }
      }
      b.setColor(stone);
      b.box(c);
    }
  }
}
