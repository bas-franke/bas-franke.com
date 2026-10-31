import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { isAuthed } from './auth.js';

export type Event =
  | { type: 'task'; task: unknown; from?: string }
  | { type: 'task-removed'; id: string; from?: string }
  | { type: 'note'; note: unknown; from?: string }
  | { type: 'note-removed'; id: string; from?: string };

type Tab = WebSocket & { alive?: boolean };
const clients = new Set<Tab>();

/** Sends an event to every open tab (including the sender; clients ignore their own echoes by `from`). */
export function broadcast(event: Event) {
  const data = JSON.stringify(event);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
}

export const clientCount = () => clients.size;

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/api/ws') return void socket.destroy();
    if (!isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return void socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws: Tab) => {
      clients.add(ws);
      ws.alive = true;
      ws.on('pong', () => (ws.alive = true));
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });
  // Ping every 25 s: keeps Nginx from idling the socket out and drops dead tabs.
  setInterval(() => {
    for (const c of clients) {
      if (c.alive === false) {
        c.terminate();
        clients.delete(c);
        continue;
      }
      c.alive = false;
      c.ping();
    }
  }, 25_000).unref();
}
