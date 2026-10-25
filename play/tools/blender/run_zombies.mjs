// Builds the Last Light models in a headless Blender and writes the GLB files to frontend/public/models/zombies.
// Pass a model name (zombie, survivor, weapons, props, arms) to rebuild only that file. weapons.glb comes from
// build_weapons.py, props.glb from build_props.py, arms.glb from build_arms.py, survivor.glb from build_swat.py.
// Usage: npm run models:zombies   (set BLENDER=/path/to/blender if it is not found automatically)

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../frontend/public/models/zombies');
const script = path.join(here, 'build_zombies.py');

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
// zombie.glb: three stages in tools/blender/zombie (body sculpt -> clothing -> hair, bakes, clips and export); each
// stage reads the previous one's .blend from zombie/out. build_zombies.py only builds other names when asked.
if (!only || only === 'zombie') {
  for (const stage of ['stage1_body.py', 'stage2_cloth.py', 'stage3_finish.py']) {
    const file = path.join(here, 'zombie', stage);
    if (existsSync(file)) execFileSync(blender, ['--background', '--factory-startup', '--python', file, '--', out], { stdio: 'inherit' });
  }
}
// The SWAT operator (survivor.glb) comes from build_swat.py.
if (only && !['weapons', 'props', 'survivor', 'arms', 'zombie'].includes(only)) execFileSync(blender, ['--background', '--factory-startup', '--python', script, '--', out, ...process.argv.slice(2)], { stdio: 'inherit' });
if (!only || only === 'survivor') {
  execFileSync(blender, ['--background', '--factory-startup', '--python', path.join(here, 'build_swat.py'), '--', out], { stdio: 'inherit' });
}
// First-person arms come from build_arms.py (cloth-simulated sleeves, baked maps).
if (!only || only === 'arms') {
  execFileSync(blender, ['--background', '--factory-startup', '--python', path.join(here, 'build_arms.py'), '--', out], { stdio: 'inherit' });
}
// Guns come from their own script (baked textures, so it takes a few minutes on a GPU).
if (!only || only === 'weapons') {
  execFileSync(blender, ['--background', '--factory-startup', '--python', path.join(here, 'build_weapons.py'), '--', out, 'weapons'], { stdio: 'inherit' });
}
// props.glb comes from build_props.py; it runs last so it replaces any props build_zombies.py still writes.
if (!only || only === 'props') {
  execFileSync(blender, ['--background', '--factory-startup', '--python', path.join(here, 'build_props.py'), '--', out], { stdio: 'inherit' });
}
console.log(`Models written to ${out}`);
