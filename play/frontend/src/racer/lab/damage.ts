// Lab: per-part destruction outside the race. One pod hovers over a stretch of real track; click it to hit it where you
// clicked (the force pushes along the view direction), or run the scripted crashes, which build the same pod-space hits
// the sim does. The side panel shows every part's health and logs what each crash damaged. Ties core/damage (applyHit),
// the model (dent / setPartHealth / breakOff), the debris system (world/debris.ts, when present) and the effects.
//   /race/lab/damage?pod=ember&quality=high&track=redrock&at=0.3&energy=1&cam=back|front|left|right|top|q|under
//   &scenario=leftwall,rockleft&repeat=3   runs crashes on load (leftwall rightwall rockleft rear knifeleft back wreck)
//   &hit=x,y,z,dx,dy,dz,energy            one custom pod-space hit on load
//   &zoom=1.5 (camera distance) &anchors (show part anchors) &nopost &nofx &only=sky,terrain,track (world modules) &delay=0.6 (s before the script)
// `window.__lab` exposes { scene, camera, renderer, pod, dmg, debris, run(name), hit(h), reset() }.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  applyHit, contactHits, damageSummary, isWrecked, newPodDamage, partAnchors, PART_IDS, PARTS, podLayout,
  type Hit, type HitKind, type PartAnchor, type PartHit, type PartId, type PodDamage,
} from '../core/damage';
import { podById } from '../core/pods';
import { Track } from '../core/track';
import { trackById } from '../core/tracks';
import { createPostFx } from '../fx/post';
import { createSpeedFx } from '../fx/speed';
import { createPod } from '../vehicle/pod';
import { buildWorld } from '../world';
import type { FxPod, FxView, PodVisual, Quality, SmokeSource, WorldContext } from '../world/types';

/**
 * What the lab needs from world/debris.ts. It is written by another module at the same time, so it is loaded through
 * a glob (absent file = no debris, the lab still builds) and every call is feature-checked.
 */
interface DebrisLike {
  object?: THREE.Object3D;
  spawn(piece: THREE.Object3D, vel: THREE.Vector3, spin: THREE.Vector3, opts?: Record<string, unknown>): unknown;
  shrapnel?(point: THREE.Vector3, dir: THREE.Vector3, count: number, speed: number, color?: THREE.Color): unknown;
  update(view: FxView): SmokeSource[] | void;
  clear?(): void;
  dispose?(): void;
}
type DebrisCtor = new (ctx: WorldContext) => DebrisLike;
const debrisModules = import.meta.glob<{ DebrisSystem?: DebrisCtor }>('../world/debris.ts');

type V3 = [number, number, number];
const norm = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

type Layout = ReturnType<typeof podLayout>;
type Anchors = Record<PartId, PartAnchor>;
/**
 * Scripted crashes as lists of pod-space hits (nose -Z, right +X, up +Y), the shapes the sim produces: walls and rocks
 * as single contacts like physics.ts sideHit / rock touches, ground contacts through core/damage contactHits as
 * race.ts does (the parts reaching furthest towards the surface take it, skipping parts already gone).
 */
const SCENARIOS: Record<string, { label: string; hits: (lay: Layout, e: number, anchors: Anchors, dmg: PodDamage) => Hit[] }> = {
  leftwall: {
    label: 'Scrape left wall',
    // A run of light contacts along the left engine's outboard side; the wall pushes right and friction drags back.
    hits: ({ L, R, xE, zE }, e) =>
      [-0.35, -0.12, 0.12, 0.35].map((f) => ({ point: [-(xE + R * 1.25), 0, zE + f * L] as V3, dir: norm([1, 0, 0.3]), energy: 0.35 * e, kind: 'wall' as HitKind })),
  },
  rightwall: {
    label: 'Square hit right wall',
    hits: ({ R, xE, zE }, e) => [{ point: [xE + R * 1.25, 0, zE], dir: norm([-1, 0, 0.35]), energy: 1.0 * e, kind: 'wall' }],
  },
  rockleft: {
    label: 'Nose into rock (left engine)',
    hits: ({ L, R, xE, zE }, e) => [{ point: [-xE, -0.1 * R, zE - L / 2 - 0.12 * L], dir: norm([0.1, 0.05, 1]), energy: 1.2 * e, kind: 'rock' }],
  },
  rear: {
    label: 'Rear-ended',
    hits: ({ C, yC, zC }, e) => [{ point: [0, yC, zC + C / 2 + 0.15], dir: [0, 0, -1], energy: 0.9 * e, kind: 'pod' }],
  },
  knifeleft: {
    label: 'Hard knife-edge landing (left)',
    // Rolled left side down: the road lies towards the pod's left (and a little below).
    hits: (_lay, e, anchors, dmg) => contactHits(anchors, norm([-1, -0.25, 0]), 1.1 * e, 'landing', dmg),
  },
  back: {
    label: 'Lands on its back',
    // Upside down: the ground lies towards the pod's own +Y; the fins and canopy reach furthest.
    hits: (_lay, e, anchors, dmg) => contactHits(anchors, [0, 1, 0], 1.2 * e, 'ground', dmg),
  },
};
/** The order "Full wreck" cycles through until a critical part breaks. */
const WRECK_CYCLE = ['rockleft', 'rightwall', 'back', 'leftwall', 'rear', 'knifeleft'];

const CAMS: Record<string, V3> = {
  back: [5, 4, 14], front: [-5, 3, -14], left: [-14, 2.5, 1], right: [14, 2.5, 1], top: [0.1, 17, 2], q: [-10, 6, -10], under: [6, -1.2, 9],
};

const css = `
.dlab { position: absolute; top: 0; right: 0; bottom: 0; width: 300px; overflow-y: auto; padding: 10px 12px; box-sizing: border-box;
  background: rgba(14, 12, 12, 0.82); color: #eee; font: 12px/1.35 system-ui, sans-serif; }
.dlab h3 { margin: 8px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #f0b070; }
.dlab button { margin: 2px 2px 2px 0; padding: 3px 7px; font: inherit; color: #eee; background: #3a3230; border: 1px solid #5a4a44; border-radius: 3px; cursor: pointer; }
.dlab button:hover { background: #504440; }
.dlab .row { display: flex; align-items: center; gap: 6px; height: 16px; }
.dlab .row span { width: 104px; white-space: nowrap; overflow: hidden; }
.dlab .row.broken span { color: #ff6b5a; text-decoration: line-through; }
.dlab .row.crit span { font-weight: 700; }
.dlab .bar { flex: 1; height: 7px; background: #2a2424; border-radius: 2px; overflow: hidden; }
.dlab .bar i { display: block; height: 100%; background: #6fcf6f; }
.dlab .row b { width: 30px; text-align: right; font-weight: 400; color: #aaa; }
.dlab .log { white-space: pre-wrap; font: 11px/1.3 ui-monospace, monospace; color: #ccc; }
.dlab .status { color: #aaa; }
.dlab .wreck { color: #ff6b5a; font-weight: 700; }
`;

export function mount(el: HTMLElement): () => void {
  const p = new URLSearchParams(location.search);
  const def = trackById(p.get('track') ?? 'redrock');
  const track = new Track(def);
  const quality = (p.get('quality') as Quality) ?? 'high';
  const design = podById(p.get('pod') ?? 'ember');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'racer-canvas';
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.2, 6000);
  const ctx: WorldContext = { track, theme: def.theme, renderer, scene, camera, quality };
  const world = buildWorld(ctx, p.get('only')?.split(','));
  if (!scene.background) scene.background = new THREE.Color(def.theme.skyHorizon);
  if (!scene.fog) scene.fog = new THREE.Fog(def.theme.haze, 200, def.theme.hazeDistance * 2);
  if (!scene.children.some((o) => (o as THREE.Light).isLight)) {
    const sun = new THREE.DirectionalLight(def.theme.sunColor, 3);
    sun.position.set(Math.sin(def.theme.sunAzimuth), Math.tan(def.theme.sunElevation), Math.cos(def.theme.sunAzimuth));
    scene.add(sun, new THREE.HemisphereLight(def.theme.skyTop, def.theme.dirt, 1.2));
  }
  const post = p.has('nopost') ? null : createPostFx(ctx);
  const fx = p.has('nofx') ? null : createSpeedFx(ctx);
  if (fx) scene.add(fx.object);

  // Where the pod hovers: on the centreline, 1.5 m up, facing down the track.
  const s0 = track.clamp(Number(p.get('at') ?? 0.3) * track.length);
  const f = track.frameAt(s0);
  const podPos = f.pos.clone().addScaledVector(f.up, 1.5);
  const podQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.right, f.up, f.tangent.clone().negate()));
  const anchors = partAnchors(design.shape);
  const lay = podLayout(design.shape);

  let visual!: PodVisual;
  let dmg: PodDamage = newPodDamage();
  const makePod = () => {
    visual = createPod(design, quality);
    visual.object.position.copy(podPos);
    visual.object.quaternion.copy(podQuat);
    visual.object.updateMatrixWorld(true);
    scene.add(visual.object);
  };
  makePod();
  const fxPod: FxPod = {
    visual,
    livery: design.livery,
    isPlayer: true,
    speed01: 0,
    speed: 0,
    boosting: false,
    surge: 0,
    velocity: new THREE.Vector3(),
    ground: f.pos.clone(),
    groundNormal: f.up.clone(),
    impact: 0,
    impactSide: 0,
    padHit: false,
    damage: [0, 0, 0],
    wrecked: false,
    hit: null,
    health: dmg.health,
    anchors,
  };

  // Part anchors as wire spheres (?anchors or the checkbox): checks that the damage model's left/right and the
  // model's (mirrored) left engine agree.
  const anchorGroup = new THREE.Group();
  const anchorMat = new THREE.MeshBasicMaterial({ color: '#40e0ff', wireframe: true, transparent: true, opacity: 0.35, depthTest: false });
  const anchorGeo = new THREE.SphereGeometry(1, 10, 6);
  for (const id of PART_IDS) {
    const m = new THREE.Mesh(anchorGeo, anchorMat);
    m.position.fromArray(anchors[id].pos);
    m.scale.setScalar(anchors[id].r);
    m.name = id;
    m.raycast = () => {};
    anchorGroup.add(m);
  }
  anchorGroup.visible = p.has('anchors');

  // Debris, when world/debris.ts exists.
  let debris: DebrisLike | null = null;
  let alive = true;
  const debrisLoad = debrisModules['../world/debris.ts'];
  const debrisReady = debrisLoad
    ? debrisLoad()
      .then((m) => {
        if (!alive || !m.DebrisSystem) return;
        debris = new m.DebrisSystem(ctx);
        if (debris.object) scene.add(debris.object);
      })
      .catch((err) => console.error('damage lab: debris system failed', err))
    : Promise.resolve();

  // --- Panel ---
  const style = document.createElement('style');
  style.textContent = css;
  const panel = document.createElement('div');
  panel.className = 'dlab';
  el.append(style, panel);
  const energyDefault = Number(p.get('energy') ?? 1);
  panel.innerHTML = `
    <div class="status"></div>
    <h3>Click energy <output>${energyDefault.toFixed(2)}</output></h3>
    <input type="range" min="0.1" max="2" step="0.05" value="${energyDefault}" style="width:100%">
    <h3>Crashes</h3>
    <div class="btns"></div>
    <label><input type="checkbox" class="anch" ${anchorGroup.visible ? 'checked' : ''}> show part anchors</label>
    <h3>Parts</h3>
    <div class="parts"></div>
    <h3>Log</h3>
    <div class="log"></div>`;
  const status = panel.querySelector('.status') as HTMLElement;
  const slider = panel.querySelector('input[type=range]') as HTMLInputElement;
  const sliderOut = panel.querySelector('output')!;
  const logEl = panel.querySelector('.log') as HTMLElement;
  slider.oninput = () => (sliderOut.textContent = Number(slider.value).toFixed(2));
  (panel.querySelector('.anch') as HTMLInputElement).onchange = (e) => (anchorGroup.visible = (e.target as HTMLInputElement).checked);
  const btns = panel.querySelector('.btns')!;
  const addBtn = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    btns.append(b);
  };
  for (const [name, sc] of Object.entries(SCENARIOS)) addBtn(sc.label, () => run(name));
  addBtn('Full wreck', () => run('wreck'));
  addBtn('Reset', () => reset());
  const rows = new Map<PartId, { row: HTMLElement; bar: HTMLElement; num: HTMLElement }>();
  const partsEl = panel.querySelector('.parts')!;
  for (const id of PART_IDS) {
    const row = document.createElement('div');
    row.className = 'row' + (PARTS[id].critical ? ' crit' : '');
    row.innerHTML = `<span title="${id}">${PARTS[id].name}</span><div class="bar"><i></i></div><b></b>`;
    row.onmouseenter = () => highlight(id);
    row.onmouseleave = () => highlight(null);
    partsEl.append(row);
    rows.set(id, { row, bar: row.querySelector('i')!, num: row.querySelector('b')! });
  }
  const highlight = (id: PartId | null) => {
    for (const m of anchorGroup.children as THREE.Mesh[]) m.visible = !id || m.name === id;
    anchorGroup.userData.forced = !!id;
  };
  const refreshPanel = () => {
    for (const id of PART_IDS) {
      const r = rows.get(id)!;
      const h = dmg.health[id];
      r.bar.style.width = `${(h * 100).toFixed(0)}%`;
      r.bar.style.background = h > 0.6 ? '#6fcf6f' : h > 0.3 ? '#e0b040' : '#e05a40';
      r.num.textContent = dmg.broken.has(id) ? 'gone' : h.toFixed(2);
      r.row.classList.toggle('broken', dmg.broken.has(id));
    }
    const api = [
      visual.parts ? 'parts' : null, visual.setPartHealth ? 'setPartHealth' : null, visual.breakOff ? 'breakOff' : null,
      visual.dent ? 'dent' : null, debris ? 'debris' : null, debris?.shrapnel ? 'shrapnel' : null,
    ].filter(Boolean);
    status.innerHTML = `${design.name ?? design.id} &middot; ${quality}<br>APIs: ${api.join(', ') || 'none yet'}` +
      (isWrecked(dmg) ? '<br><span class="wreck">WRECKED</span>' : '');
  };
  const logLines: string[] = [];
  const log = (title: string, out: PartHit[]) => {
    const list = out.filter((h) => h.amount >= 0.01 || h.broke);
    const body = list.length
      ? list.map((h) => `  ${PARTS[h.part].name.padEnd(16)} -${h.amount.toFixed(2)} → ${h.broke ? 'BROKE' : h.health.toFixed(2)}`).join('\n')
      : '  (nothing)';
    logLines.unshift(`${title}\n${body}`);
    logLines.length = Math.min(logLines.length, 30);
    logEl.textContent = logLines.join('\n');
  };

  // --- Applying hits ---
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  let pendingImpact = 0;
  let pendingSide = 0;
  const hit = (h: Hit, title: string = h.kind): PartHit[] => {
    const out = applyHit(dmg, anchors, h);
    const point = new THREE.Vector3(...h.point);
    const dir = new THREE.Vector3(...h.dir).normalize();
    visual.dent?.(point.clone(), dir.clone(), Math.min(0.35, 0.05 + 0.13 * h.energy));
    // Break off the carriers first (a nacelle takes its fin and flap along), then the rest.
    const broke = out.filter((o) => o.broke).sort((a, b) => (PARTS[b.part].carries ? 1 : 0) - (PARTS[a.part].carries ? 1 : 0));
    const centre = new THREE.Vector3(0, lay.yC * 0.5, (lay.zE + lay.zC) / 2);
    for (const b of broke) {
      if (!PARTS[b.part].detaches) continue;
      const piece = visual.breakOff?.(b.part);
      if (!piece || !debris) continue;
      // Pod space: out from the pod's middle through the part, pushed along the blow, and up; then into world space.
      const a = new THREE.Vector3(...anchors[b.part].pos);
      const v = a.clone().sub(centre).setY(0).normalize().multiplyScalar(4)
        .addScaledVector(dir, 2.5 * h.energy)
        .add(new THREE.Vector3((Math.random() - 0.5) * 2, 3 + 2 * h.energy + Math.random() * 2, (Math.random() - 0.5) * 2));
      v.applyQuaternion(visual.object.quaternion);
      const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(3 + Math.random() * 6);
      const engine = PARTS[b.part].group === 'engineL' || PARTS[b.part].group === 'engineR';
      debris.spawn(piece, v, spin, { smoke: engine ? 0.7 : 0.3, burning: PARTS[b.part].critical });
    }
    visual.setPartHealth?.(dmg.health, dmg.broken);
    const wp = visual.object.localToWorld(tmpA.copy(point));
    const wd = tmpB.copy(dir).applyQuaternion(visual.object.quaternion);
    // Shards spray back off the struck skin (against the push), a little upwards.
    const spray = wd.clone().negate().addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(visual.object.quaternion), 0.4).normalize();
    debris?.shrapnel?.(wp.clone(), spray, Math.round(10 + 30 * h.energy), 7 + 9 * h.energy);
    if (h.energy > (fxPod.hit?.energy ?? 0)) fxPod.hit = { point: wp.clone(), dir: wd.clone(), energy: h.energy, kind: h.kind };
    pendingImpact = Math.max(pendingImpact, Math.min(1, h.energy));
    pendingSide = h.point[0] < 0 ? -1 : 1;
    log(title, out);
    refreshPanel();
    return out;
  };

  // Hits run from a queue, a beat apart, so sparks and debris read as separate impacts.
  const queue: (() => void)[] = [];
  let queueT = 0;
  const run = (name: string) => {
    const e = Number(slider.value) || 1;
    if (name === 'wreck') {
      let n = 0;
      const step = () => {
        if (isWrecked(dmg) || n >= 40) return;
        const sc = SCENARIOS[WRECK_CYCLE[n % WRECK_CYCLE.length]];
        n++;
        for (const h of sc.hits(lay, Math.max(1.2, e), anchors, dmg)) queue.push(() => hit(h, `wreck ${n}: ${sc.label}`));
        queue.push(step);
      };
      queue.push(step);
      return;
    }
    const sc = SCENARIOS[name];
    if (!sc) return console.warn(`damage lab: no scenario "${name}"`);
    sc.hits(lay, e, anchors, dmg).forEach((h, i, all) => queue.push(() => hit(h, all.length > 1 ? `${sc.label} (${i + 1}/${all.length})` : sc.label)));
  };
  const reset = () => {
    queue.length = 0;
    scene.remove(visual.object);
    visual.dispose();
    dmg = newPodDamage();
    makePod();
    fxPod.visual = visual;
    fxPod.health = dmg.health;
    if (debris) {
      if (debris.clear) debris.clear();
      else {
        // No clear(): rebuild it.
        if (debris.object) scene.remove(debris.object);
        debris.dispose?.();
        const Ctor = debris.constructor as DebrisCtor;
        debris = new Ctor(ctx);
        if (debris.object) scene.add(debris.object);
      }
    }
    logLines.length = 0;
    logEl.textContent = '';
    refreshPanel();
  };

  // --- Camera and clicking ---
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(podPos);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 3;
  controls.maxDistance = 80;
  const camAt = new THREE.Vector3(...(CAMS[p.get('cam') ?? 'back'] ?? CAMS.back)).multiplyScalar(Number(p.get('zoom') ?? 1));
  camera.position.copy(visual.object.localToWorld(camAt));
  controls.update();
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down: [number, number] | null = null;
  const onDown = (e: PointerEvent) => (down = [e.clientX, e.clientY]);
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    down = null;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const shown = (o: THREE.Object3D | null): boolean => !o || (o.visible && shown(o.parent));
    const solid = ray.intersectObject(visual.object, true).find((i) => {
      const m = (i.object as THREE.Mesh).material as THREE.Material;
      // Skip the glow and plume shells (shader materials) and hidden parts.
      return shown(i.object) && !(m as THREE.ShaderMaterial).isShaderMaterial;
    });
    if (!solid) return;
    const inv = visual.object.matrixWorld.clone().invert();
    const pt = solid.point.clone().applyMatrix4(inv);
    const dir = ray.ray.direction.clone().transformDirection(inv);
    const e2 = Number(slider.value);
    hit({ point: pt.toArray() as V3, dir: dir.toArray() as V3, energy: e2, kind: 'rock' }, `click (${pt.x.toFixed(1)}, ${pt.y.toFixed(1)}, ${pt.z.toFixed(1)}) e=${e2.toFixed(2)}`);
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);

  const fit = () => {
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / el.clientHeight;
    camera.updateProjectionMatrix();
    post?.setSize(el.clientWidth, el.clientHeight, renderer.getPixelRatio());
  };
  fit();
  window.addEventListener('resize', fit);
  refreshPanel();

  // Scripted run on load (for screenshots), once the debris module had its chance to load.
  const delay = Number(p.get('delay') ?? 0.6);
  void debrisReady.then(() => {
    setTimeout(() => {
      if (!alive) return;
      refreshPanel();
      const repeat = Math.max(1, Number(p.get('repeat') ?? 1));
      for (let i = 0; i < repeat; i++) for (const name of p.get('scenario')?.split(',').filter(Boolean) ?? []) run(name);
      const custom = p.get('hit')?.split(',').map(Number);
      if (custom && custom.length >= 7) {
        queue.push(() => hit({ point: [custom[0], custom[1], custom[2]], dir: norm([custom[3], custom[4], custom[5]]), energy: custom[6], kind: 'rock' }, 'custom hit'));
      }
    }, delay * 1000);
  });

  let raf = 0;
  let last = performance.now();
  let time = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    queueT -= dt;
    while (queue.length && queueT <= 0) {
      queue.shift()!();
      queueT = 0.12;
    }
    controls.update();
    const wrecked = isWrecked(dmg);
    const summary = damageSummary(dmg);
    fxPod.damage = summary;
    fxPod.wrecked = wrecked;
    fxPod.impact = pendingImpact;
    fxPod.impactSide = pendingSide;
    pendingImpact = 0;
    visual.update({ dt, time, speed01: 0, throttle: 0.35, steer: 0, boosting: false, surge: 0, damage: summary, wrecked });
    if (anchorGroup.parent !== visual.object) visual.object.add(anchorGroup);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(visual.object.quaternion);
    const view: FxView = {
      dt, time, camera, playerPos: visual.object.position, playerForward: fwd, speed01: 0, boosting: false, playerS: s0, pods: [fxPod],
    };
    const smoke = debris?.update(view);
    if (smoke) view.smokeSources = smoke;
    world.update(view);
    fx?.update(view);
    // The hit is "this frame's" contact: shown once.
    fxPod.hit = null;
    if (post) post.render(view);
    else renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  const lab = { THREE, scene, camera, renderer, track, run, hit, reset, anchors, layout: lay } as Record<string, unknown>;
  Object.defineProperties(lab, {
    pod: { get: () => visual },
    dmg: { get: () => dmg },
    debris: { get: () => debris },
  });
  (window as unknown as { __lab: unknown }).__lab = lab;
  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    renderer.domElement.removeEventListener('pointerdown', onDown);
    renderer.domElement.removeEventListener('pointerup', onUp);
    controls.dispose();
    world.dispose();
    fx?.dispose();
    post?.dispose();
    if (debris) {
      if (debris.object) scene.remove(debris.object);
      debris.dispose?.();
    }
    visual.dispose();
    anchorGeo.dispose();
    anchorMat.dispose();
    panel.remove();
    style.remove();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
