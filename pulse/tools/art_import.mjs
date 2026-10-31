// Converts the generated PNGs in art-inbox/ into exact-size webp files in frontend/src/assets/art/.
// Usage (from pulse/):  npm --prefix tools install   (once)   then   node tools/art_import.mjs
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inbox = path.join(root, 'art-inbox');
const out = path.join(root, 'frontend', 'src', 'assets', 'art');

// Parse FILES in slots.ts: { slot: '...', w: N, h: N
const src = readFileSync(path.join(root, 'frontend', 'src', 'art', 'slots.ts'), 'utf8');
const files = src.slice(src.indexOf('export const FILES'));
const specs = new Map([...files.slice(0, files.indexOf('];')).matchAll(/slot:\s*'([^']+)',\s*w:\s*(\d+),\s*h:\s*(\d+)/g)].map((m) => [m[1], { w: +m[2], h: +m[3] }]));

mkdirSync(out, { recursive: true });
const done = new Set();
const unknown = [];
for (const file of readdirSync(inbox).sort()) {
  if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
  const name = file.replace(/\.[^.]+$/, '');
  const spec = specs.get(name.replace(/-dark$/, ''));
  if (!spec) { unknown.push(file); continue; }
  await sharp(path.join(inbox, file)).resize(spec.w, spec.h, { fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toFile(path.join(out, `${name}.webp`));
  done.add(name.replace(/-dark$/, ''));
  console.log(`ok   ${file} -> ${name}.webp (${spec.w}x${spec.h})`);
}
for (const u of unknown) console.log(`unknown name (not in FILES): ${u}`);
const missing = [...specs.keys()].filter((s) => !done.has(s));
console.log(missing.length ? `still missing (placeholder stays): ${missing.join(', ')}` : 'all files imported');
