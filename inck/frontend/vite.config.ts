import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend port for this project (see .claude/CLAUDE.md port table).
const BACKEND_PORT = 3003;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://localhost:${BACKEND_PORT}`,
    },
  },
});
