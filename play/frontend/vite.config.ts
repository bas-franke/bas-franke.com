import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend port for this project (see .claude/CLAUDE.md port table).
// 127.0.0.1 rather than localhost: the backend binds IPv4 only, and newer Node resolves localhost to ::1 first.
const BACKEND_PORT = 3004;

// Protocol and physics code is shared with the backend: backend/src/shared is the single source of truth,
// compiled into the backend by tsc and imported here through the @shared alias.
const here = import.meta.dirname;
const shared = path.resolve(here, '../backend/src/shared');

// Content hashes of the GLB models in public/ ("/models/zombies/weapons.glb" -> "3f9a1c2b"), so loaders can ask for
// `?v=<hash>`: the server lets browsers cache /models for a day, and a rebuilt model must show up right away.
function modelVersions(): Record<string, string> {
  const out: Record<string, string> = {};
  const pub = path.join(here, 'public');
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.glb')) out[`/${path.relative(pub, full).split(path.sep).join('/')}`] = createHash('sha1').update(readFileSync(full)).digest('hex').slice(0, 10);
    }
  };
  walk(path.join(pub, 'models'));
  return out;
}

export default defineConfig({
  plugins: [react()],
  define: { __MODEL_VERSIONS__: JSON.stringify(modelVersions()) },
  resolve: {
    alias: { '@shared': shared },
  },
  server: {
    fs: { allow: [here, shared] },
    proxy: {
      '/api': { target: `http://127.0.0.1:${BACKEND_PORT}`, ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
  },
});
