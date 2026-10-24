// Track layout check: lap length, tightest bends, elevation, and the closest approach between separate parts of the
// lap (the scenery needs ~150 m between them; less than the road width means the track crosses itself). Also writes
// an HTML page with every layout drawn to scale, for a screenshot.
//
//   tsx tools/racer/layouts.ts [out.html]

import { writeFileSync } from 'node:fs';
import { Track } from '../../frontend/src/racer/core/track';
import { TRACKS } from '../../frontend/src/racer/core/tracks';

const out = process.argv[2];
const svgs: string[] = [];
for (const def of TRACKS) {
  const t = new Track(def);
  const n = t.frames.length;
  let minR = Infinity;
  let minSep = Infinity;
  let sepAt: [number, number] = [0, 0];
  const ys = t.frames.map((f) => f.pos.y);
  for (const f of t.frames) minR = Math.min(minR, 1 / Math.max(1e-6, Math.abs(f.kappa)));
  for (let i = 0; i < n; i += 3) {
    for (let j = i + 3; j < n; j += 3) {
      const along = Math.min(j - i, n - (j - i)) * (t.length / n);
      if (along < 450) continue;
      const a = t.frames[i].pos;
      const b = t.frames[j].pos;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < minSep) {
        minSep = d;
        sepAt = [t.frames[i].s, t.frames[j].s];
      }
    }
  }
  // Corners: stretches where |kappa| > 1/250, with their minimum radius and turn angle.
  const corners: string[] = [];
  let i0 = -1;
  let turn = 0;
  let r = Infinity;
  for (let k = 0; k <= n; k++) {
    const f = t.frames[k % n];
    const on = Math.abs(f.kappa) > 1 / 330 && k < n;
    if (on) {
      if (i0 < 0) {
        i0 = k;
        turn = 0;
        r = Infinity;
      }
      turn += f.kappa * (t.length / n);
      r = Math.min(r, 1 / Math.abs(f.kappa));
    } else if (i0 >= 0) {
      corners.push(`${Math.round(t.frames[i0].s)}:${Math.round((turn * 180) / Math.PI)}°/R${Math.round(r)}`);
      i0 = -1;
    }
  }
  console.log(
    `${def.id.padEnd(9)} L=${Math.round(t.length)}m w=${def.width} minR=${Math.round(minR)}m elev=${Math.round(Math.min(...ys))}..${Math.round(Math.max(...ys))} minSep=${Math.round(minSep)}m @${sepAt.map(Math.round).join('/')}`,
  );
  console.log(`          ${corners.join('  ')}`);
  const padInfo = def.boostPads.map(([fr, lat]) => {
    let k = 0;
    for (let d = -60; d <= 120; d += 10) k = Math.max(k, Math.abs(t.frameAt(fr * t.length + d).kappa));
    return `${Math.round(fr * t.length)}${lat ? `(${lat})` : ''}:R${k > 1e-4 ? Math.round(1 / k) : 'inf'}`;
  });
  console.log(`          pads ${padInfo.join('  ')}`);
  // Straights (|kappa| < 1/500 for 120 m or more): good places for boost pads, as fractions of the lap.
  const straights: string[] = [];
  let st0 = -1;
  for (let k = 0; k <= n; k++) {
    const flat = k < n && Math.abs(t.frames[k].kappa) < 1 / 500;
    if (flat && st0 < 0) st0 = k;
    if (!flat && st0 >= 0) {
      const a = t.frames[st0].s;
      const b = t.frames[k - 1].s;
      if (b - a > 120) straights.push(`${(a / t.length).toFixed(3)}-${(b / t.length).toFixed(3)} (${Math.round(b - a)}m)`);
      st0 = -1;
    }
  }
  console.log(`          straights ${straights.join('  ')}`);

  const b = t.bounds;
  const span = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) + 200;
  const path = t.frames.map((f, k) => `${k ? 'L' : 'M'}${(f.pos.x - b.min.x + 100).toFixed(0)},${(f.pos.z - b.min.z + 100).toFixed(0)}`).join('') + 'Z';
  const pads = def.boostPads
    .map(([fr, lat]) => {
      const p = t.toWorld(fr * t.length, lat * (t.frameAt(fr * t.length).width / 2 - 6));
      return `<circle cx="${p.x - b.min.x + 100}" cy="${p.z - b.min.z + 100}" r="30" fill="orange"/>`;
    })
    .join('');
  const s0 = t.frames[0].pos;
  const s1 = t.frames[10].pos;
  svgs.push(
    `<div><b>${def.id}</b> ${Math.round(t.length)} m<br><svg viewBox="0 0 ${span} ${span}" width="380" height="380" style="background:#222">` +
      `<path d="${path}" stroke="#ddd" stroke-width="${def.width}" fill="none"/>${pads}` +
      `<circle cx="${s0.x - b.min.x + 100}" cy="${s0.z - b.min.z + 100}" r="40" fill="red"/>` +
      `<circle cx="${s1.x - b.min.x + 100}" cy="${s1.z - b.min.z + 100}" r="25" fill="lime"/>` +
      `<text x="20" y="${span - 30}" fill="#aaa" font-size="${span / 25}">1 km = ${(1000 / span) * 380 | 0}px</text></svg></div>`,
  );
}
if (out) {
  writeFileSync(out, `<html><body style="background:#111;color:#eee;font:14px sans-serif;display:flex;flex-wrap:wrap;gap:8px">${svgs.join('')}</body></html>`);
  console.log(`wrote ${out}`);
}
