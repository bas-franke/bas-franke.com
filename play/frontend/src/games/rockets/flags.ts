// Capture-the-flag props: a comic flag on a pole for each team, the base stand it lives on, and the shrinking
// "going home" ring under a dropped flag. Cel-shaded with ink like everything else; the cloth waves in the vertex
// shader (one shared time uniform), so a waving flag costs nothing on the CPU.

import * as THREE from 'three';
import type { Team } from '@shared/protocol';
import { TEAMS } from '@shared/rockets/modes';
import { INK, flat, hullGeometry, inkMaterial, toon, toonRamp } from '../../engine/toon';

/** Shared by every cloth material (fill and ink), advanced once per frame by updateFlagTime. */
const clothTime = { value: 0 };

const CLOTH_W = 1.15;
const CLOTH_H = 0.72;
const POLE_H = 2.6;

/** Cloth displacement: a travelling wave that grows away from the pole (x = 0), with a little sag at the free end. */
const WAVE = /* glsl */ `
  float flagK = clamp( position.x / ${CLOTH_W.toFixed(2)}, 0.0, 1.0 );
  transformed.z += sin( position.x * 4.2 - clothTime * 6.5 + position.y * 1.3 ) * 0.14 * flagK;
  transformed.y -= flagK * flagK * 0.08 * ( 1.0 + sin( clothTime * 2.1 ) * 0.5 );`;

function waving<M extends THREE.Material>(m: M, ink = 0): M {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.clothTime = clothTime;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float clothTime;\nvoid main() {')
      .replace('#include <begin_vertex>', `#include <begin_vertex>${WAVE}${ink ? `\n  transformed += normal * ${ink.toFixed(3)};` : ''}`);
  };
  m.customProgramCacheKey = () => `flagcloth${ink}`;
  return m;
}

const clothMats = new Map<Team, THREE.Material>();
let clothInk: THREE.MeshBasicMaterial | null = null;
let clothGeo: THREE.BufferGeometry | null = null;
let clothHull: THREE.BufferGeometry | null = null;

function clothMaterial(team: Team) {
  let m = clothMats.get(team);
  if (!m) {
    const t = new THREE.MeshToonMaterial({ color: TEAMS[team].color, gradientMap: toonRamp(), side: THREE.DoubleSide });
    m = waving(t);
    clothMats.set(team, m);
  }
  return m;
}

/** The cloth's own ink: same wave, pushed out along the welded normals (a flat plane has no hull to push). */
function clothInkMaterial() {
  return (clothInk ??= waving(new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide }), 0.035));
}

function cloth() {
  if (!clothGeo) {
    // A thin slab rather than a plane, so the back-face ink has a volume to wrap.
    clothGeo = new THREE.BoxGeometry(CLOTH_W, CLOTH_H, 0.04, 12, 2, 1);
    clothGeo.translate(CLOTH_W / 2, 0, 0);
    clothHull = hullGeometry(clothGeo);
  }
  return { geo: clothGeo, hull: clothHull! };
}

function inked(geo: THREE.BufferGeometry, mat: THREE.Material) {
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  g.add(mesh, new THREE.Mesh(hullGeometry(geo), inkMaterial()));
  return g;
}

let poleGeo: THREE.BufferGeometry | null = null;
let knobGeo: THREE.BufferGeometry | null = null;

/** A flag on its pole, foot at the origin, cloth flying towards +X. */
export function buildFlag(team: Team): THREE.Group {
  const root = new THREE.Group();
  root.name = 'flag';
  poleGeo ??= new THREE.CylinderGeometry(0.05, 0.06, POLE_H, 8).translate(0, POLE_H / 2, 0);
  knobGeo ??= new THREE.IcosahedronGeometry(0.11, 0).translate(0, POLE_H + 0.06, 0);
  root.add(inked(poleGeo, toon(0xe8e4dc)), inked(knobGeo, toon(0xffd23f)));
  const { geo, hull } = cloth();
  const fill = new THREE.Mesh(geo, clothMaterial(team));
  fill.castShadow = true;
  const ink = new THREE.Mesh(hull, clothInkMaterial());
  const flag = new THREE.Group();
  flag.add(fill, ink);
  flag.position.set(0.04, POLE_H - CLOTH_H / 2 - 0.06, 0);
  root.add(flag);
  return root;
}

/** The base: a low team-coloured plinth with an ink rim. Stays put while the flag is away, so you can see it is gone. */
export function buildFlagStand(team: Team): THREE.Group {
  const root = new THREE.Group();
  root.add(inked(new THREE.CylinderGeometry(0.9, 1.05, 0.16, 16).translate(0, 0.08, 0), toon(0x2a2f44)));
  root.add(inked(new THREE.CylinderGeometry(0.62, 0.62, 0.05, 16).translate(0, 0.18, 0), toon(TEAMS[team].color)));
  return root;
}

/** A flat ring for a dropped flag: scale it from 1 down to 0 as the auto-return runs out. */
export function buildReturnRing(team: Team): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.4, 32).rotateX(-Math.PI / 2), flat(TEAMS[team].color));
  m.renderOrder = 2;
  return m;
}

/** Advances every cloth's wave and follows the quality setting's ink switch. Once per frame. */
export function updateFlagTime(t: number) {
  clothTime.value = t;
  if (clothInk) clothInk.visible = inkMaterial().visible;
}

export { POLE_H as FLAG_POLE_H };
