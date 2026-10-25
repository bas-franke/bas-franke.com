// The race surface and everything on it, from -(width/2 + 2) to +(width/2 + 2) around the centreline: the packed-dirt
// road (trackRoad), the chevron barriers on the physics walls and the start line (trackBarriers), gorge bridges with
// trestles (trackBridge), the start and finish gantries (trackStart), the glowing boost pads (trackPads), and the
// rocks and jump ramp markings (trackObstacles). Few materials:
// road, barrier atlas, atlas decals, vertex-coloured steel, pads, pad halo, start lamps.

import * as THREE from 'three';
import { buildBarriers } from './trackBarriers';
import { buildBridges } from './trackBridge';
import { GeoBuilder } from './trackGeo';
import { buildPads } from './trackPads';
import { buildRoad } from './trackRoad';
import { buildObstacles } from './trackObstacles';
import { buildStartGantry } from './trackStart';
import { barrierAtlas } from './trackTextures';
import type { WorldBuilder } from './types';
import { zonesFor } from './zones';

export const buildTrackSurface: WorldBuilder = (ctx) => {
  const { track, theme, renderer, quality } = ctx;
  const zones = zonesFor(track);
  const aniso = Math.min(quality === 'low' ? 2 : quality === 'medium' ? 4 : 8, renderer.capabilities.getMaxAnisotropy());
  const group = new THREE.Group();
  group.name = 'track';

  const road = buildRoad(track, quality, aniso);
  group.add(road.object);

  // Barrier atlas: slightly emissive so the yellow chevrons pop even in shadow.
  const atlas = barrierAtlas(theme, aniso);
  const wallMat = new THREE.MeshStandardMaterial({
    map: atlas.map,
    emissiveMap: atlas.emissiveMap,
    emissive: '#ffffff',
    emissiveIntensity: 0.55,
    roughness: 0.62,
    metalness: 0.15,
  });
  const decalMat = wallMat.clone();
  decalMat.polygonOffset = true;
  decalMat.polygonOffsetFactor = -2;
  decalMat.polygonOffsetUnits = -4;
  decalMat.emissiveIntensity = 0.25;
  decalMat.roughness = 0.85;
  group.add(buildBarriers(track, zones, wallMat, decalMat));

  // Static structure with the barrier atlas (gantry) and vertex-coloured steel (bridges, pad frames).
  const atlasGeo = new GeoBuilder(true, false);
  const steelGeo = new GeoBuilder(false, true);
  const gantry = buildStartGantry(track, atlasGeo, track.startS);
  const finish = buildStartGantry(track, atlasGeo, track.finishS);
  group.add(gantry.object, finish.object);
  const obstacles = buildObstacles(track, theme, atlasGeo);
  group.add(obstacles.object);
  buildBridges(track, zones, quality, steelGeo);
  const pads = buildPads(track, steelGeo, aniso);
  group.add(pads.object);

  const atlasMesh = new THREE.Mesh(atlasGeo.build(), wallMat);
  atlasMesh.castShadow = atlasMesh.receiveShadow = true;
  const steelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0.3 });
  const steelMesh = new THREE.Mesh(steelGeo.build(), steelMat);
  steelMesh.castShadow = steelMesh.receiveShadow = true;
  group.add(atlasMesh, steelMesh);

  return {
    object: group,
    update(view) {
      pads.update(view.time);
      gantry.update(view.time);
      finish.update(view.time);
    },
    dispose() {
      road.dispose();
      pads.dispose();
      gantry.dispose();
      finish.dispose();
      obstacles.dispose();
      // Geometry dispose is idempotent, so sweeping everything (including what the parts disposed) is safe.
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      wallMat.dispose();
      decalMat.dispose();
      steelMat.dispose();
      atlas.map.dispose();
      atlas.emissiveMap.dispose();
    },
  };
};
