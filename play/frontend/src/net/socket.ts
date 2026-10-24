// The one WebSocket a player holds for the life of a room visit.

import type { ClientMsg, GameClientMsg, ServerMsg } from '@shared/protocol';

export type SocketStatus = 'connecting' | 'open' | 'closed';
type Listener = (m: ServerMsg) => void;

export class RoomSocket {
  private ws?: WebSocket;
  private readonly listeners = new Set<Listener>();
  private pingTimer?: number;
  status: SocketStatus = 'connecting';
  /** Why the socket closed, as told by the server (or a generic message). */
  closeReason = '';
  rtt = 0;
  private offset = 0;

  constructor(
    readonly code: string,
    readonly name: string,
  ) {}

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/ws?room=${encodeURIComponent(this.code)}&name=${encodeURIComponent(this.name)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.status = 'open';
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), 2000);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        const now = Date.now();
        this.rtt = now - msg.at;
        // Server clock relative to ours, assuming symmetric latency.
        this.offset = msg.serverTime - (msg.at + this.rtt / 2);
      }
      if (msg.t === 'error' && this.status === 'connecting') this.closeReason = msg.message;
      if (msg.t === 'closed') this.closeReason = msg.reason;
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = (ev) => {
      if (!this.closeReason) this.closeReason = ev.reason || (this.status === 'connecting' ? 'Could not connect to the room.' : 'Connection lost.');
      this.status = 'closed';
      window.clearInterval(this.pingTimer);
      for (const l of this.listeners) l({ t: 'closed', reason: this.closeReason });
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    return this;
  }

  private ping() {
    this.send({ t: 'ping', at: Date.now() });
  }

  /** Our best guess of the server's Date.now(). */
  serverNow() {
    return Date.now() + this.offset;
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  sendGame(m: GameClientMsg) {
    this.send({ t: 'g', m });
  }

  on(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.listeners.clear();
    window.clearInterval(this.pingTimer);
    this.ws?.close(1000, 'leaving');
  }
}
