import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend port for this project (see .claude/CLAUDE.md port table). 127.0.0.1 rather than localhost: newer Node
// resolves localhost to ::1 first, while the backend listens on IPv4 only.
const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? 3003);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${BACKEND_PORT}`,
    },
  },
});
