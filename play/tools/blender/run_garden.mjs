// Runs the Garden Sentinels Blender scripts headless and writes the GLBs to frontend/public/models/garden.
//   build_garden_towers.py  -> towers.glb   (five towers, three levels each)
//   build_garden_enemies.py -> enemies.glb  (runner, skitter, disruptor, brute, colossus, animated)
//   build_garden_kit.py     -> kit.glb      (environment kit: rocks, foliage, bridge, portal, greenhouse, ...)
//   build_garden_decor.py   -> decor.glb    (ambient critters and cozy decor: butterflies, birds, gnome bot, bench, ...)
//   render_garden_portraits.py -> portraits/tower_<kind>_<lv>.webp, portraits/enemy_<kind>.webp (HUD cards, from the two GLBs above)
// Usage: npm run models:garden [towers|enemies|kit|decor|portraits]   (set BLENDER=/path/to/blender if it is not found automatically)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../frontend/public/models/garden');
mkdirSync(out, { recursive: true });

function findBlender() {
  if (process.env.BLENDER && existsSync(process.env.BLENDER)) return process.env.BLENDER;
  const candidates = [];
  if (process.platform === 'win32') {
    const root = 'C:\\Program Files\\Blender Foundation';
    if (existsSync(root)) {
      for (const dir of readdirSync(root).sort().reverse()) candidates.push(path.join(root, dir, 'blender.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Blender.app/Contents/MacOS/Blender');
  }
  candidates.push('blender');
  return candidates.find((c) => c === 'blender' || existsSync(c));
}

const blender = findBlender();
console.log(`Using ${blender}`);
const only = process.argv[2];
for (const part of ['towers', 'enemies', 'kit', 'decor']) {
  if (only && only !== part) continue;
  execFileSync(blender, ['--background', '--factory-startup', '--python', path.join(here, `build_garden_${part}.py`), '--', out], { stdio: 'inherit' });
}
// Portraits render the freshly built towers/enemies, so they always run last.
if (!only || only === 'portraits') {
  execFileSync(blender, ['--background', '--factory-startup', '--python', path.join(here, 'render_garden_portraits.py'), '--', out], { stdio: 'inherit' });
}
console.log(`Models written to ${out}`);
