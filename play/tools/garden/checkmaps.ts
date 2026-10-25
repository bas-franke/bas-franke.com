// Garden Sentinels map validator. Checks every map in GMAPS (grid, portals, greenhouse, routes, buildable space,
// route lengths) and prints an ASCII render with the routes drawn over it.
//
//   node backend/node_modules/tsx/dist/cli.mjs tools/garden/checkmaps.ts            all maps, with renders
//   node backend/node_modules/tsx/dist/cli.mjs tools/garden/checkmaps.ts -q         summary only
//   node backend/node_modules/tsx/dist/cli.mjs tools/garden/checkmaps.ts <id> ...   only these maps
//
// (run from play/, with Node 22+). Exits 1 when any map has an error; warnings are advice only.
//
// Route rule: every sample of a route, across its width, must stand on a path (#) or bridge (=) cell. Axis-aligned
// segments are checked over their full width; 45-degree segments are drawn as 3-cell staircases, so they are checked
// over 70% of the width (enemies walk within 80% of it, so a body may brush a corner).

import { G } from '../../backend/src/shared/garden/constants.js';
import { GMAPS, type GMapDef } from '../../backend/src/shared/garden/maps.js';

const LEGAL = new Set(['.', '#', '=', '~', 'o', 'R', 'T', 'f', 'l', 's', 'E', 'G']);
const WALK = new Set(['#', '=']);
const LIMITS = {
  coop: { len: [90, 160], near: 140, cols: [30, 44], rows: [18, 28] },
  vs: { len: [60, 100], near: 50, cols: [16, 24], rows: [12, 17] },
} as const;

const args = process.argv.slice(2);
const quiet = args.includes('-q');
const only = args.filter((a) => !a.startsWith('-'));

const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const isInt = (v: number) => eq(v, Math.round(v));
const isHalf = (v: number) => eq(v - Math.floor(v), 0.5);

interface Report {
  errors: string[];
  warns: string[];
  info: string[];
}

function check(def: GMapDef): Report {
  const errors: string[] = [];
  const warns: string[] = [];
  const info: string[] = [];
  const g = def.grid;
  const H = g.length;
  const W = H ? g[0].length : 0;
  const at = (c: number, r: number) => (r >= 0 && r < H && c >= 0 && c < W ? g[r][c] : undefined);

  if (!def.id || !def.name || !def.blurb) errors.push('missing id, name or blurb');
  if (!def.modes.length) errors.push('no modes');
  if (H === 0) return { errors: [...errors, 'empty grid'], warns, info };
  g.forEach((row, r) => {
    if (row.length !== W) errors.push(`row ${r} has ${row.length} cells, expected ${W}`);
    [...row].forEach((ch, c) => {
      if (!LEGAL.has(ch)) errors.push(`illegal char '${ch}' at (${c}, ${r})`);
    });
  });
  if (errors.length) return { errors, warns, info };
  for (const m of def.modes) {
    const L = LIMITS[m];
    if (W < L.cols[0] || W > L.cols[1] || H < L.rows[0] || H > L.rows[1])
      warns.push(`${m} map is ${W}x${H}; aim for ${L.cols.join('-')} cols x ${L.rows.join('-')} rows`);
  }
  if (def.mood && (def.mood.warmth < 0 || def.mood.warmth > 1 || def.mood.water < 0 || def.mood.water > 1))
    errors.push('mood values must be 0..1');
  if (!def.mood) warns.push('no mood');

  const count = (ch: string) => g.reduce((n, row) => n + [...row].filter((c) => c === ch).length, 0);

  // Portals: 2x2 E blocks centred on each entry, backing onto the map edge.
  if (!def.entries.length) errors.push('no entries');
  if (count('E') !== def.entries.length * 4) errors.push(`${count('E')} E cells for ${def.entries.length} entries (want 4 each)`);
  const mouths: { x: number; y: number; dx: number; dy: number }[] = [];
  def.entries.forEach((e, i) => {
    const ok = [at(e.x - 1, e.y - 1), at(e.x, e.y - 1), at(e.x - 1, e.y), at(e.x, e.y)].every((c) => c === 'E');
    if (!isInt(e.x) || !isInt(e.y) || !ok) {
      errors.push(`entry ${i} at (${e.x}, ${e.y}) is not the centre of a 2x2 E block`);
      mouths.push({ x: NaN, y: NaN, dx: 0, dy: 0 });
      return;
    }
    const dx = Math.round(Math.sin(e.facing));
    const dy = Math.round(Math.cos(e.facing));
    if (Math.abs(dx) + Math.abs(dy) !== 1 || !eq(Math.atan2(dx, dy), Math.atan2(Math.sin(e.facing), Math.cos(e.facing))))
      errors.push(`entry ${i} facing ${e.facing.toFixed(3)} is not one of 0, PI/2, PI, -PI/2`);
    // The back of the portal (opposite the mouth) must be the map edge.
    const backOnEdge = (dx === 1 && e.x - 1 === 0) || (dx === -1 && e.x + 1 === W) || (dy === 1 && e.y - 1 === 0) || (dy === -1 && e.y + 1 === H);
    if (!backOnEdge) errors.push(`entry ${i}: the back of the portal does not sit on the map edge (facing towards the map?)`);
    mouths.push({ x: e.x + dx, y: e.y + dy, dx, dy });
  });

  // Greenhouse: one 4x4 G block centred on goal.
  const { x: gx, y: gy } = def.goal;
  if (count('G') !== 16) errors.push(`${count('G')} G cells (want one 4x4 greenhouse)`);
  for (let r = gy - 2; r < gy + 2; r++) for (let c = gx - 2; c < gx + 2; c++) if (at(c, r) !== 'G') errors.push(`goal (${gx}, ${gy}) is not the centre of the 4x4 G block`);
  const doors = [
    { x: gx, y: gy - 2, dx: 0, dy: 1 }, // north door: final approach heads south (+y)
    { x: gx, y: gy + 2, dx: 0, dy: -1 },
    { x: gx - 2, y: gy, dx: 1, dy: 0 },
    { x: gx + 2, y: gy, dx: -1, dy: 0 },
  ];

  // Routes.
  const covered = new Set<string>();
  const usedEntries = new Set<number>();
  const usedDoors = new Set<number>();
  const lens: number[] = [];
  def.routes.forEach((rt, ri) => {
    const tag = `route ${ri}`;
    const p = rt.pts;
    if (rt.entry < 0 || rt.entry >= def.entries.length) {
      errors.push(`${tag}: bad entry ${rt.entry}`);
      return;
    }
    usedEntries.add(rt.entry);
    if (!(rt.half === 1 || rt.half === 0.5)) warns.push(`${tag}: half ${rt.half} (expected 1, or 0.5 for a narrow path)`);
    if (p.length < 2) {
      errors.push(`${tag}: needs at least 2 points`);
      return;
    }
    const tol = rt.half < 1 ? 0.5 : 0;
    // Waypoints: corners for 2-wide paths, cell centres for 1-wide ones (start/end may sit on the portal/door edge).
    p.forEach(([x, y], i) => {
      if (i === 0 || i === p.length - 1) return;
      const ok = rt.half === 1 ? isInt(x) && isInt(y) : rt.half === 0.5 ? isHalf(x) && isHalf(y) : true;
      if (!ok) errors.push(`${tag}: point ${i} (${x}, ${y}) is not on a ${rt.half === 1 ? 'cell corner' : 'cell centre'}`);
    });
    // Start at the portal mouth.
    const m = mouths[rt.entry];
    const [sx, sy] = p[0];
    const along0 = m.dx !== 0 ? sy - m.y : sx - m.x;
    const across0 = m.dx !== 0 ? sx - m.x : sy - m.y;
    if (!eq(across0, 0) || Math.abs(along0) > tol + 1e-6) errors.push(`${tag}: starts at (${sx}, ${sy}), portal ${rt.entry} mouth is (${m.x}, ${m.y})`);
    else {
      const [nx, ny] = p[1];
      if (Math.sign(nx - sx) !== m.dx || Math.sign(ny - sy) !== m.dy) errors.push(`${tag}: first segment does not leave the portal straight out of its mouth`);
    }
    // End at a greenhouse door, arriving straight on.
    const [ex, ey] = p[p.length - 1];
    const [qx, qy] = p[p.length - 2];
    const di = doors.findIndex((d) => (d.dx !== 0 ? eq(ex, d.x) && Math.abs(ey - d.y) <= tol + 1e-6 : eq(ey, d.y) && Math.abs(ex - d.x) <= tol + 1e-6));
    if (di < 0) errors.push(`${tag}: ends at (${ex}, ${ey}), not at the middle of a greenhouse side`);
    else {
      usedDoors.add(di);
      const d = doors[di];
      if (Math.sign(ex - qx) !== d.dx || Math.sign(ey - qy) !== d.dy) errors.push(`${tag}: last segment does not arrive straight at the door`);
    }
    // Segments.
    let len = 0;
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, ay] = p[i];
      const [bx, by] = p[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const L = Math.hypot(dx, dy);
      if (L < 1e-6) {
        errors.push(`${tag}: zero-length segment at point ${i}`);
        continue;
      }
      const diag = !eq(dx, 0) && !eq(dy, 0);
      if (diag && !eq(Math.abs(dx), Math.abs(dy))) {
        errors.push(`${tag}: segment ${i} (${ax},${ay})->(${bx},${by}) is neither axis-aligned nor 45 degrees`);
        continue;
      }
      len += L;
      const ux = dx / L;
      const uy = dy / L;
      const k = diag ? 0.7 : 0.98;
      const bad = new Set<string>();
      for (let t = 0.02; t <= L - 0.02 + 1e-9; t += 0.05) {
        for (const lat of [-1, -0.5, 0, 0.5, 1]) {
          const off = lat * rt.half;
          const x = ax + ux * t - uy * off;
          const y = ay + uy * t + ux * off;
          const c = Math.floor(x);
          const r = Math.floor(y);
          covered.add(`${c},${r}`);
          if (Math.abs(lat) > k + 1e-9 && !diag) continue;
          if (Math.abs(off) > k * rt.half + 1e-9) continue;
          if (!WALK.has(at(c, r) ?? '')) bad.add(`(${c},${r})${at(c, r) ?? 'off-map'}`);
        }
      }
      if (bad.size) errors.push(`${tag}: segment ${i} (${ax},${ay})->(${bx},${by}) leaves the path at ${[...bad].slice(0, 6).join(' ')}${bad.size > 6 ? ' ...' : ''}`);
    }
    const metres = len * G.cell;
    lens.push(metres);
    for (const mode of def.modes) {
      const [lo, hi] = LIMITS[mode].len;
      if (metres < lo || metres > hi) warns.push(`${tag}: ${metres.toFixed(0)} m long; ${mode} routes ideally ${lo}-${hi} m`);
    }
  });
  def.entries.forEach((_, i) => {
    if (!usedEntries.has(i)) errors.push(`entry ${i} has no route`);
  });
  if (usedDoors.size > 1) errors.push('routes end at different greenhouse doors (one door per greenhouse)');

  // Path cells no route walks over, bridges without water.
  let stray = 0;
  let dryBridges = 0;
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      const ch = g[r][c];
      // Corner fills next to a walked cell are fine; a path cell with no walked neighbour is a dead end.
      if (WALK.has(ch) && ![-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => covered.has(`${c + dx},${r + dy}`)))) stray++;
      if (ch === '=') {
        let water = false;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (['~', 'o'].includes(at(c + dx, r + dy) ?? '')) water = true;
        if (!water) dryBridges++;
      }
    }
  if (stray) warns.push(`${stray} path/bridge cells are nowhere near a route (dead-end paths)`);
  if (dryBridges) warns.push(`${dryBridges} bridge cells do not touch water`);

  // Buildable space.
  const dist: number[][] = g.map((row) => [...row].map((ch) => (WALK.has(ch) ? 0 : 99)));
  for (let pass = 0; pass < 4; pass++)
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const n = dist[r + dy]?.[c + dx];
            if (n !== undefined && n + 1 < dist[r][c]) dist[r][c] = n + 1;
          }
  let build = 0;
  let near = 0;
  let adj = 0;
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++)
      if (g[r][c] === '.') {
        build++;
        if (dist[r][c] <= 3) near++;
        if (dist[r][c] === 1) adj++;
      }
  for (const mode of def.modes) {
    const want = LIMITS[mode].near;
    if (near < want) warns.push(`only ${near} buildable cells within 3 of a path (${mode} wants >= ${want})`);
  }
  if (def.modes.includes('vs') && build > 85) warns.push(`${build} buildable cells; versus boards aim for ~50-70`);
  info.push(
    `${W}x${H} (${W * G.cell}x${H * G.cell} m), ${def.entries.length} entries, ${def.routes.length} routes ${lens.map((l) => l.toFixed(0) + 'm').join(' ')}, ` +
      `buildable ${build} (${near} within 3 of a path, ${adj} touching it), bridges ${count('=')}, water ${count('~') + count('o')}`,
  );
  return { errors, warns, info };
}

function render(def: GMapDef): string {
  const rows = def.grid.map((r) => [...r]);
  const marks = new Map<string, Set<number>>();
  def.routes.forEach((rt, ri) => {
    for (let i = 0; i + 1 < rt.pts.length; i++) {
      const [ax, ay] = rt.pts[i];
      const [bx, by] = rt.pts[i + 1];
      const L = Math.hypot(bx - ax, by - ay);
      // Draw the route on the cell just left of its centreline (looking along travel) so 2-wide paths show one track.
      const ux = (bx - ax) / L;
      const uy = (by - ay) / L;
      for (let t = 0.25; t < L; t += 0.25) {
        const x = ax + ux * t + uy * 0.25;
        const y = ay + uy * t - ux * 0.25;
        const k = `${Math.floor(x)},${Math.floor(y)}`;
        if (!marks.has(k)) marks.set(k, new Set());
        marks.get(k)!.add(ri);
      }
    }
  });
  for (const [k, s] of marks) {
    const [c, r] = k.split(',').map(Number);
    if (rows[r]?.[c] === undefined || !WALK.has(rows[r][c])) continue;
    rows[r][c] = s.size > 1 ? '*' : String([...s][0]);
  }
  const head = '    ' + Array.from({ length: def.grid[0].length }, (_, i) => (i % 10 === 0 ? String((i / 10) % 10) : ' ')).join('');
  const head2 = '    ' + Array.from({ length: def.grid[0].length }, (_, i) => String(i % 10)).join('');
  return [head, head2, ...rows.map((r, i) => String(i).padStart(3) + ' ' + r.join(''))].join('\n');
}

let failed = 0;
const ids = new Set<string>();
for (const def of GMAPS) {
  if (ids.has(def.id)) {
    console.log(`DUPLICATE id ${def.id}`);
    failed++;
  }
  ids.add(def.id);
  if (only.length && !only.includes(def.id)) continue;
  const rep = check(def);
  const status = rep.errors.length ? 'FAIL' : rep.warns.length ? 'ok (warnings)' : 'ok';
  console.log(`\n== ${def.id} "${def.name}" [${def.modes.join(', ')}] ${status}`);
  rep.info.forEach((s) => console.log('   ' + s));
  rep.errors.forEach((s) => console.log('   ERROR ' + s));
  rep.warns.forEach((s) => console.log('   warn  ' + s));
  if (!quiet) console.log(render(def));
  if (rep.errors.length) failed++;
}
const coop = GMAPS.filter((m) => m.modes.includes('coop')).length;
const vs = GMAPS.filter((m) => m.modes.includes('vs')).length;
console.log(`\n${GMAPS.length} maps (${coop} co-op, ${vs} versus): ${failed ? failed + ' with errors' : 'all valid'}`);
process.exit(failed ? 1 : 0);
