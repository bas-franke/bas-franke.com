import type { Project } from './types.js';

// Every project in the repo. Add new projects here so the status page monitors them
// (keep in sync with the table in .claude/CLAUDE.md).
export const projects: Project[] = [
  { name: 'portfolio', domains: ['bas-franke.com', 'www.bas-franke.com'], port: 3001, database: false },
  { name: 'status', domains: ['status.bas-franke.com'], port: 3002, database: true },
  { name: 'inck', domains: ['inck.ai', 'www.inck.ai'], port: 3003, database: true, registrar: 'name.com' },
  { name: 'play', domains: ['play.bas-franke.com'], port: 3004, database: true, websocket: '/api/ws' },
  { name: 'wordward', domains: ['wordward.bas-franke.com'], port: 3005, database: true },
  { name: 'stonks', domains: ['stonks.bas-franke.com'], port: 3006, database: true },
  { name: 'pulse', domains: ['pulse.bas-franke.com'], port: 3007, database: true, websocket: '/api/ws' },
];
