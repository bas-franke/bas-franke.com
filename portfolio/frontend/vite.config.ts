import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend port for this project (see .claude/CLAUDE.md port table).
// 127.0.0.1 rather than localhost: the backend binds IPv4 only, and newer Node resolves localhost to ::1 first.
const BACKEND_PORT = 3001;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${BACKEND_PORT}`,
    },
  },
});
