// Runs build_models.py in a headless Blender and writes the GLB files to frontend/public/models.
// Usage: npm run models   (set BLENDER=/path/to/blender if it is not found automatically)

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../frontend/public/models');
const script = path.join(here, 'build_models.py');

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
execFileSync(blender, ['--background', '--factory-startup', '--python', script, '--', out], { stdio: 'inherit' });
console.log(`Models written to ${out}`);
