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

export default defineConfig({
  plugins: [react()],
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
