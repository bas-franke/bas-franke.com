// The man-made things on the course. The course itself is open sand between rock walls, part of the terrain
// (terrain.ts, rockFormations.ts); on it go the checkered start and finish lines (trackBarriers), gorge bridges with
// trestles (trackBridge), the start and finish gantries (trackStart) and the glowing boost pads (trackPads). Few
// materials: barrier atlas, atlas decals, vertex-coloured steel, pads, pad halo, start lamps.

import * as THREE from 'three';
import { buildLines } from './trackBarriers';
import { buildBridges } from './trackBridge';
import { GeoBuilder } from './trackGeo';
import { buildPads } from './trackPads';
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
  group.add(buildLines(track, decalMat));

  // Static structure with the barrier atlas (gantry) and vertex-coloured steel (bridges, pad frames).
  const atlasGeo = new GeoBuilder(true, false);
  const steelGeo = new GeoBuilder(false, true);
  const gantry = buildStartGantry(track, atlasGeo, track.startS);
  const finish = buildStartGantry(track, atlasGeo, track.finishS);
  group.add(gantry.object, finish.object);
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
      pads.dispose();
      gantry.dispose();
      finish.dispose();
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
