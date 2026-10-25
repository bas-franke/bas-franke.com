// Lab: speed effects without the race sim. Eight pods fly scripted lines down a track (player behind the pack) with the
// chase camera, and the lab fires boost, boost-pad and wall-hit events on a timer so every effect shows up quickly.
//   /race/lab/speedfx?track=redrock&at=0.3&speed=1&only=sky,terrain,trackSurface&nopost&quality=low&freeze&calm (no events)&hide=dust,motes
// Destruction effects (per-part health, contact hits, smoking debris), faked without the sim:
//   &health=nacelleL:0.2,binderR:0,intakeR:0.5  part health on the damaged pods (&dmgpods=0,2; default all)
//   &hits=1  a fake contact every 1 s on the damaged pods (&hitat=x,y,z pod space, &hitkind=wall|rock|pod|landing|ground,
//            &hite=0.8 energy; without them it cycles a left-flank scrape, a nose-on rock, a pod hit and a landing)
//   &cam=x,y,z  look at the player's pod from that pod-space point
//   &wreck   the damaged pods lie wrecked;  &debris=4  smoking pieces on the road ahead (&burn: they burn)
// `window.__lab` exposes { scene, camera, renderer, fx, pods }.

import * as THREE from 'three';
import { PART_IDS, damageSummary, partAnchors } from '../core/damage';
import type { HitKind, PartId } from '../core/damage';
import { PODS } from '../core/pods';
import { Track } from '../core/track';
import { trackById } from '../core/tracks';
import { createPostFx } from '../fx/post';
import { createSpeedFx } from '../fx/speed';
import { createPod } from '../vehicle/pod';
import { buildWorld } from '../world';
import type { FxPod, FxView, Quality, SmokeSource, WorldContext } from '../world/types';

export function mount(el: HTMLElement): () => void {
  const p = new URLSearchParams(location.search);
  const def = trackById(p.get('track') ?? 'redrock');
  const track = new Track(def);
  const quality = (p.get('quality') as Quality) ?? 'high';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'racer-canvas';
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, 1, 0.3, 6000);
  const ctx: WorldContext = { track, theme: def.theme, renderer, scene, camera, quality };
  const world = buildWorld(ctx, p.get('only')?.split(','));
  // Without the sky module (?only=...) still give the scene a sky colour, haze and light.
  if (!scene.background) scene.background = new THREE.Color(def.theme.skyHorizon);
  if (!scene.fog) scene.fog = new THREE.Fog(def.theme.haze, 200, def.theme.hazeDistance * 2);
  if (!scene.children.some((o) => (o as THREE.Light).isLight)) {
    const sun = new THREE.DirectionalLight(def.theme.sunColor, 3);
    sun.position.set(Math.sin(def.theme.sunAzimuth), Math.tan(def.theme.sunElevation), Math.cos(def.theme.sunAzimuth));
    scene.add(sun, new THREE.HemisphereLight(def.theme.skyTop, def.theme.dirt, 1.2));
  }
  const post = p.has('nopost') ? null : createPostFx(ctx);
  const fx = createSpeedFx(ctx);
  scene.add(fx.object);
  // ?hide=dust,trails,motes,lines,sparks,rings,cones
  for (const name of p.get('hide')?.split(',') ?? []) {
    const o = fx.object.getObjectByName(name);
    if (o) o.visible = false;
  }
  const freeze = p.has('freeze');
  const camAt = p.get('cam')?.split(',').map(Number);
  const speedMul = Number(p.get('speed') ?? 1);

  // Pack layout: [metres ahead of the player, lateral fraction of half-width, speed factor]
  const allLines: [number, number, number][] = [
    [0, 0.05, 1],
    [22, -0.55, 0.97],
    [45, 0.45, 0.98],
    [70, -0.1, 0.99],
    [110, 0.6, 0.97],
    [150, -0.5, 1],
    [210, 0.2, 0.98],
    [280, -0.3, 0.99],
  ];
  const lines = allLines.slice(0, Number(p.get('pods') ?? allLines.length));
  const top = 130 * speedMul;
  const s0 = Number(p.get('at') ?? 0.3) * track.length;
  // Faked damage: the parts named in ?health on the chosen pods; 0 = broken (hidden by the model if it can).
  const healthArg = p.get('health');
  const dmgPods = p.get('dmgpods')?.split(',').map(Number);
  const hurt = (i: number) => (healthArg !== null || p.has('hits') || p.has('wreck')) && (!dmgPods || dmgPods.includes(i));
  const pods: FxPod[] = lines.map((_, i) => {
    const design = PODS[i % PODS.length];
    const visual = createPod(design, quality);
    scene.add(visual.object);
    const health = {} as Record<PartId, number>;
    for (const id of PART_IDS) health[id] = 1;
    const broken = new Set<PartId>();
    if (hurt(i)) {
      for (const kv of healthArg?.split(',') ?? []) {
        const [id, val] = kv.split(':');
        if (!(id in health)) continue;
        health[id as PartId] = Math.max(0, Math.min(1, Number(val)));
        if (health[id as PartId] <= 0) broken.add(id as PartId);
      }
      visual.setPartHealth?.(health, broken);
    }
    return {
      visual,
      livery: design.livery,
      isPlayer: i === 0,
      speed01: speedMul,
      speed: top,
      boosting: false,
      surge: 0,
      velocity: new THREE.Vector3(),
      ground: new THREE.Vector3(),
      groundNormal: new THREE.Vector3(0, 1, 0),
      impact: 0,
      impactSide: 0,
      padHit: false,
      damage: damageSummary({ health, broken }),
      wrecked: hurt(i) && p.has('wreck'),
      hit: null,
      health,
      anchors: partAnchors(design.shape),
    };
  });

  // Fake contacts: pod-space point and push direction (into the pod, away from what it hit), turned to world space.
  const hitPeriod = Number(p.get('hits') ?? 0);
  const hitAt = p.get('hitat')?.split(',').map(Number);
  const hitKind = p.get('hitkind') as HitKind | null;
  const hitE = Number(p.get('hite') ?? 0.8);
  const hitScript: [number[], HitKind][] = [
    [[-4.2, 0, -1.5], 'wall'],
    [[1.5, 0, -6.5], 'rock'],
    [[3.8, 0.2, 0.5], 'pod'],
    [[0, -1.1, -1], 'landing'],
  ];
  const hits = pods.map(() => ({ point: new THREE.Vector3(), dir: new THREE.Vector3(), energy: 0, kind: 'wall' as HitKind }));
  let hitN = 0;
  let nextHit = 0.5;
  // Smoking debris on the road ahead of the player, moved on ahead again once passed.
  const debris: (SmokeSource & { s: number; lat: number; mesh: THREE.Mesh })[] = [];
  const debrisGeo = new THREE.DodecahedronGeometry(0.7, 0);
  const debrisMat = new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 0.8, metalness: 0.4 });
  for (let i = 0; i < Number(p.get('debris') ?? 0); i++) {
    const mesh = new THREE.Mesh(debrisGeo, debrisMat);
    mesh.scale.set(1.4, 0.6, 1);
    scene.add(mesh);
    debris.push({ pos: mesh.position, amount: 0.4 + 0.6 * ((i * 0.37) % 1), burning: p.has('burn') && i % 2 === 0, s: s0 + 60 + i * 35, lat: ((i * 0.61) % 1) * 1.4 - 0.7, mesh });
  }
  const smokeSources: SmokeSource[] = debris;
  const prev = pods.map(() => new THREE.Vector3());
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const m = new THREE.Matrix4();

  const fit = () => {
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / el.clientHeight;
    camera.updateProjectionMatrix();
    post?.setSize(el.clientWidth, el.clientHeight, renderer.getPixelRatio());
  };
  fit();
  window.addEventListener('resize', fit);
  let raf = 0;
  let last = performance.now();
  let time = 0;
  let simT = 2;
  let playerS = s0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    if (!freeze) simT += dt;
    // Event script, a 6 s cycle: player boost 1-2.5 s, pad hit at 3 s, wall scrape 4-4.4 s (rival 2 hits at 5 s).
    const c = p.has('calm') ? 0 : simT % 6;
    pods.forEach((fp, i) => {
      const [ahead, lat, sf] = lines[i];
      const s = s0 + ahead + simT * top * sf + Math.sin(simT * 0.3 + i) * 6;
      const f = track.frameAt(s);
      if (i === 0) playerS = s;
      const x = (lat + Math.sin(simT * 0.5 + i * 2) * 0.12) * f.width * 0.5;
      const f2 = track.frameAt(s + 3);
      fwd.copy(f2.pos).sub(f.pos).normalize();
      right.copy(fwd).cross(f.up).normalize();
      up.copy(right).cross(fwd).normalize();
      const pos = fp.visual.object.position;
      pos.copy(f.pos).addScaledVector(f.right, x).addScaledVector(f.up, 1.5 + Math.sin(time * 2.3 + i) * 0.1);
      m.makeBasis(right, up, fwd.clone().negate());
      fp.visual.object.quaternion.setFromRotationMatrix(m);
      if (dt > 0) fp.velocity.copy(pos).sub(prev[i]).divideScalar(dt);
      if (fp.velocity.length() > 400) fp.velocity.set(0, 0, 0);
      prev[i].copy(pos);
      fp.ground.copy(f.pos).addScaledVector(f.right, x);
      fp.groundNormal.copy(f.up);
      fp.boosting = i === 0 ? c > 1 && c < 2.5 : i === 3 && c > 2 && c < 4;
      fp.surge = i === 0 && c > 3 && c < 3.8 ? 0.8 : 0;
      fp.padHit = i === 0 && c > 3 && c < 3.05;
      const hit = (i === 0 && c > 4 && c < 4.4) || (i === 2 && c > 5 && c < 5.1);
      fp.impact = hit ? 0.6 : 0;
      fp.impactSide = i === 0 ? 1 : -1;
      fp.hit = null;
      fp.visual.update({ dt, time, speed01: fp.speed01, throttle: 1, steer: 0, boosting: fp.boosting, surge: fp.surge, damage: fp.damage, wrecked: fp.wrecked });
    });
    if (hitPeriod > 0 && time >= nextHit) {
      nextHit = time + hitPeriod;
      const [pt, kind] = hitScript[hitN++ % hitScript.length];
      pods.forEach((fp, i) => {
        if (!hurt(i)) return;
        const h = hits[i];
        const o = fp.visual.object;
        o.updateWorldMatrix(true, false);
        h.kind = hitKind ?? kind;
        h.point.fromArray(hitAt ?? pt);
        // Push from the contact towards the pod's middle; a landing pushes straight up.
        if (h.kind === 'landing' || h.kind === 'ground') h.dir.set(0, 1, 0);
        else h.dir.set(0, 0.3, 0).sub(h.point).setY(0).normalize();
        h.point.applyMatrix4(o.matrixWorld);
        h.dir.applyQuaternion(o.quaternion);
        h.energy = hitE;
        fp.hit = h;
      });
    }
    for (const d of debris) {
      if (d.s < playerS - 30) d.s += 35 * debris.length;
      const f = track.frameAt(d.s);
      d.mesh.position.copy(f.pos).addScaledVector(f.right, d.lat * f.width * 0.5).addScaledVector(f.up, 0.3);
    }
    const pl = pods[0];
    const pf = new THREE.Vector3(0, 0, -1).applyQuaternion(pl.visual.object.quaternion);
    const pu = new THREE.Vector3(0, 1, 0).applyQuaternion(pl.visual.object.quaternion);
    // Own simple chase camera (the real one belongs to another module and may be mid-change).
    camera.position.copy(pl.visual.object.position).addScaledVector(pf, -13.5).addScaledVector(pu, 4);
    camera.up.copy(pu);
    camera.lookAt(fwd.copy(pl.visual.object.position).addScaledVector(pf, 14).addScaledVector(pu, 1.2));
    if (camAt) {
      // ?cam=x,y,z: a close look from that pod-space point at the player's pod (damage effects up close).
      camera.position.fromArray(camAt).applyQuaternion(pl.visual.object.quaternion).add(pl.visual.object.position);
      camera.lookAt(pl.visual.object.position);
    }
    camera.fov = 80 + (pl.boosting ? 8 : 0);
    camera.updateProjectionMatrix();
    const view: FxView = {
      dt,
      time,
      camera,
      playerPos: pl.visual.object.position,
      playerForward: pf,
      speed01: pl.speed01,
      boosting: pl.boosting,
      playerS: track.clamp(playerS),
      pods,
      smokeSources,
    };
    world.update(view);
    fx.update(view);
    if (post) post.render(view);
    else renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  (window as unknown as { __lab: unknown }).__lab = { scene, camera, renderer, fx, pods };
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    world.dispose();
    fx.dispose();
    post?.dispose();
    for (const fp of pods) fp.visual.dispose();
    debrisGeo.dispose();
    debrisMat.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
