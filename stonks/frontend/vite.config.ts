import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend port for this project (see .claude/CLAUDE.md port table).
// 127.0.0.1 rather than localhost: the backend binds IPv4 only, and newer Node resolves localhost to ::1 first.
// BACKEND_PORT env overrides it for local runs against a backend on another port.
const BACKEND_PORT = Number(process.env.BACKEND_PORT) || 3006;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: `http://127.0.0.1:${BACKEND_PORT}` },
    },
  },
});
