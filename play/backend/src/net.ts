// WebSocket endpoint: /api/ws?room=CODE&name=Nick. One socket per player for the life of the session.

import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { RoomError, type RoomManager } from './rooms.js';
import type { ClientMsg } from './shared/protocol.js';

interface Live extends WebSocket {
  isAlive?: boolean;
}

const HEARTBEAT_MS = 15_000;

function closeWith(ws: WebSocket, code: number, message: string) {
  try {
    ws.send(JSON.stringify({ t: 'error', message }));
  } catch {
    /* ignore */
  }
  ws.close(code, message.slice(0, 120));
}

export function attachWebSocket(server: Server, rooms: RoomManager) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: Live, req: IncomingMessage) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    const url = new URL(req.url ?? '/', 'http://localhost');
    const code = (url.searchParams.get('room') ?? '').trim().toUpperCase();
    const name = url.searchParams.get('name') ?? '';
    const room = rooms.get(code);
    if (!room) {
      closeWith(ws, 4004, 'That room does not exist (any more). Rooms close when the last player leaves.');
      return;
    }

    let memberId: string;
    try {
      memberId = room.addHuman(ws, name).id;
    } catch (err) {
      closeWith(ws, 4009, err instanceof Error ? err.message : 'Cannot join.');
      return;
    }

    // Simple flood protection: count messages per second.
    let windowStart = Date.now();
    let count = 0;

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > config.maxMessagesPerSecond) {
        closeWith(ws, 4008, 'Too many messages.');
        return;
      }
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString()) as ClientMsg;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      try {
        room.handleMessage(memberId, msg);
      } catch (err) {
        if (err instanceof RoomError) ws.send(JSON.stringify({ t: 'error', message: err.message }));
        else console.error(`[room ${room.code}] message handler failed`, err);
      }
    });

    ws.on('close', () => room.removeMember(memberId, 'left'));
    ws.on('error', (err) => console.warn(`[room ${room.code}] socket error: ${err.message}`));
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients as Set<Live>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
