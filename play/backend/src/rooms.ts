// Rooms: creation, membership, bots, lifecycle. A room is alive only while a human is connected to it.

import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { config } from './config.js';
import { gameFactories } from './games/registry.js';
import type { GameHost, GamePlayer, GameServer } from './games/types.js';
import {
  BOT_NAMES,
  GAMES,
  LIMITS,
  PLAYER_COLORS,
  type BotDifficulty,
  type ClientMsg,
  type GameServerMsg,
  type PlayerInfo,
  type RoomSettings,
  type RoomState,
  type RoomSummary,
  type RoomView,
  type ServerMsg,
  sanitizeName,
} from './shared/protocol.js';

export class RoomError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

interface Member extends GamePlayer {
  socket?: WebSocket;
  ping: number;
  joinedAt: number;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length = 4) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

const randomId = (prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`;

/** How long clients get to look at the results before the room goes back to the waiting state. */
const RESULTS_LINGER_MS = 12_000;

export class Room implements GameHost {
  readonly createdAt = Date.now();
  state: RoomState = 'waiting';
  hostId: string | null = null;
  readonly members = new Map<string, Member>();
  game?: GameServer;
  /** When the room last had no connected humans; null while someone is in it. */
  emptySince: number | null = Date.now();
  private everJoined = false;
  private endTimer?: NodeJS.Timeout;
  closed = false;

  constructor(
    readonly code: string,
    readonly settings: RoomSettings,
    private readonly onClose: (room: Room) => void,
  ) {
    this.setBots(settings.bots, settings.botDifficulty);
  }

  get name() {
    return this.settings.name;
  }

  botDifficulty() {
    return this.settings.botDifficulty;
  }

  players(): GamePlayer[] {
    return [...this.members.values()].map(({ id, name, bot, color }) => ({ id, name, bot, color }));
  }

  humans() {
    return [...this.members.values()].filter((m) => !m.bot);
  }

  bots() {
    return [...this.members.values()].filter((m) => m.bot);
  }

  private freeColor() {
    const used = new Set([...this.members.values()].map((m) => m.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[this.members.size % PLAYER_COLORS.length];
  }

  view(): RoomView {
    const players: PlayerInfo[] = [...this.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      bot: m.bot,
      color: m.color,
      connected: m.bot || m.socket?.readyState === 1,
      ping: m.ping,
    }));
    return {
      code: this.code,
      name: this.settings.name,
      game: this.settings.game,
      state: this.state,
      maxPlayers: this.settings.maxPlayers,
      botDifficulty: this.settings.botDifficulty,
      hostId: this.hostId,
      players,
    };
  }

  summary(): RoomSummary {
    return {
      code: this.code,
      name: this.settings.name,
      game: this.settings.game,
      humans: this.humans().length,
      bots: this.bots().length,
      maxPlayers: this.settings.maxPlayers,
      state: this.state,
      createdAt: this.createdAt,
    };
  }

  // ---- membership ---------------------------------------------------------------------------------------------

  addHuman(socket: WebSocket, rawName: string): Member {
    if (this.closed) throw new RoomError('This room has closed.', 410);
    if (this.members.size >= this.settings.maxPlayers) {
      // Humans take priority over bots: drop a bot to make space.
      const bot = this.bots().pop();
      if (!bot) throw new RoomError('This room is full.', 409);
      this.removeMember(bot.id, 'replaced by a player');
    }
    const member: Member = {
      id: randomId('p'),
      name: this.uniqueName(sanitizeName(rawName, 'Player')),
      bot: false,
      color: this.freeColor(),
      socket,
      ping: 0,
      joinedAt: Date.now(),
    };
    this.members.set(member.id, member);
    this.everJoined = true;
    this.emptySince = null;
    if (!this.hostId) this.hostId = member.id;
    this.sendTo(member, { t: 'welcome', you: member.id, room: this.view(), serverTime: Date.now() });
    this.broadcastRoom();
    this.systemChat(`${member.name} joined`);
    this.game?.addPlayer(member);
    return member;
  }

  private uniqueName(name: string) {
    const taken = new Set([...this.members.values()].map((m) => m.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 100; i++) {
      const candidate = `${name.slice(0, LIMITS.playerNameMax - 3)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${name.slice(0, LIMITS.playerNameMax - 5)} ${randomCode(3)}`;
  }

  removeMember(id: string, reason: string) {
    const member = this.members.get(id);
    if (!member) return;
    this.members.delete(id);
    this.game?.removePlayer(id);
    if (member.socket && member.socket.readyState === 1) {
      this.sendTo(member, { t: 'closed', reason });
      member.socket.close(1000, reason);
    }
    if (!member.bot) this.systemChat(`${member.name} left`);
    if (this.hostId === id) {
      const next = this.humans()[0];
      this.hostId = next?.id ?? null;
      if (next) this.systemChat(`${next.name} is now the host`);
    }
    if (this.humans().length === 0) this.emptySince ??= Date.now();
    this.broadcastRoom();
  }

  setBots(count: number, difficulty?: BotDifficulty) {
    if (difficulty) this.settings.botDifficulty = difficulty;
    const maxBots = Math.max(0, this.settings.maxPlayers - this.humans().length);
    count = Math.min(Math.max(0, Math.floor(count)), maxBots);
    const bots = this.bots();
    while (bots.length > count) this.removeMember(bots.pop()!.id, 'bot removed');
    while (bots.length < count) {
      const taken = new Set(bots.map((b) => b.name));
      const name = BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${bots.length + 1}`;
      const bot: Member = { id: randomId('b'), name, bot: true, color: this.freeColor(), ping: 0, joinedAt: Date.now() };
      this.members.set(bot.id, bot);
      bots.push(bot);
      this.game?.addPlayer(bot);
    }
    this.settings.bots = count;
    this.broadcastRoom();
  }

  // ---- game lifecycle -----------------------------------------------------------------------------------------

  startGame() {
    if (this.state === 'playing') throw new RoomError('The game is already running.');
    const meta = GAMES[this.settings.game];
    if (this.members.size < meta.minPlayers) throw new RoomError(`${meta.name} needs at least ${meta.minPlayers} players. Add a bot or wait for a friend.`);
    this.game = gameFactories[this.settings.game](this);
    this.state = 'playing';
    this.broadcastRoom();
    this.game.start();
  }

  stopGame(reason: string) {
    clearTimeout(this.endTimer);
    this.endTimer = undefined;
    if (!this.game) return;
    const game = this.game;
    this.game = undefined;
    game.stop();
    this.state = 'waiting';
    this.systemChat(reason);
    this.broadcastRoom();
  }

  matchEnded() {
    if (this.endTimer) return;
    this.endTimer = setTimeout(() => this.stopGame('Match over. Ready for another?'), RESULTS_LINGER_MS);
  }

  // ---- messages -------------------------------------------------------------------------------------------------

  handleMessage(id: string, msg: ClientMsg) {
    const member = this.members.get(id);
    if (!member) return;
    switch (msg.t) {
      case 'ping':
        this.sendTo(member, { t: 'pong', at: msg.at, serverTime: Date.now() });
        return;
      case 'chat': {
        const text = sanitizeName(msg.text, '', LIMITS.chatMax);
        if (text) this.broadcastAll({ t: 'chat', from: member.name, text });
        return;
      }
      case 'setBots':
        this.requireHost(member);
        this.setBots(msg.count, msg.difficulty);
        return;
      case 'start':
        this.requireHost(member);
        this.startGame();
        this.systemChat(`${member.name} started ${GAMES[this.settings.game].name}`);
        return;
      case 'stop':
        this.requireHost(member);
        if (this.state === 'playing') this.stopGame(`${member.name} ended the match`);
        return;
      case 'g':
        this.game?.onMessage(id, msg.m);
        return;
    }
  }

  private requireHost(member: Member) {
    if (member.id !== this.hostId) throw new RoomError('Only the host can do that.');
  }

  reportPing(id: string, ping: number) {
    const m = this.members.get(id);
    if (m) m.ping = ping;
  }

  // ---- sending --------------------------------------------------------------------------------------------------

  private sendTo(member: Member, msg: ServerMsg) {
    if (member.socket && member.socket.readyState === 1) member.socket.send(JSON.stringify(msg));
  }

  send(id: string, m: GameServerMsg) {
    const member = this.members.get(id);
    if (member) this.sendTo(member, { t: 'g', m });
  }

  /** Sends a room-level message to everyone connected. */
  broadcastAll(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) if (m.socket && m.socket.readyState === 1) m.socket.send(data);
  }

  /** GameHost.broadcast: wraps a game message in the envelope. */
  broadcast(m: GameServerMsg) {
    this.broadcastAll({ t: 'g', m });
  }

  broadcastRoom() {
    this.broadcastAll({ t: 'room', room: this.view() });
  }

  systemChat(text: string) {
    this.broadcastAll({ t: 'chat', from: '', text, system: true });
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------------

  /** Called every couple of seconds by the manager. */
  sweep(now: number) {
    if (this.closed || this.emptySince === null) return;
    const limit = this.everJoined ? config.emptyRoomGraceMs : config.unclaimedRoomMs;
    if (now - this.emptySince > limit) this.close('Room closed: nobody left in it.');
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.endTimer);
    this.game?.stop();
    this.game = undefined;
    for (const m of [...this.members.values()]) {
      if (m.socket && m.socket.readyState === 1) {
        this.sendTo(m, { t: 'closed', reason });
        m.socket.close(1000, 'room closed');
      }
    }
    this.members.clear();
    this.onClose(this);
  }
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();

  create(raw: Partial<RoomSettings>): Room {
    if (this.rooms.size >= config.maxRooms) throw new RoomError('The server is full right now; try again in a few minutes.', 503);
    const game = raw.game && raw.game in GAMES ? raw.game : undefined;
    if (!game) throw new RoomError('Unknown game.');
    const meta = GAMES[game];
    const maxPlayers = Math.min(meta.maxPlayers, Math.max(LIMITS.minPlayers, Math.floor(Number(raw.maxPlayers ?? meta.maxPlayers)) || meta.maxPlayers));
    const bots = Math.min(maxPlayers - 1, Math.max(0, Math.floor(Number(raw.bots ?? 0)) || 0));
    const botDifficulty: BotDifficulty = raw.botDifficulty === 'easy' || raw.botDifficulty === 'hard' ? raw.botDifficulty : 'normal';
    const settings: RoomSettings = {
      name: sanitizeName(raw.name, `${meta.name} room`, LIMITS.roomNameMax),
      game,
      maxPlayers,
      bots,
      botDifficulty,
    };
    let code = randomCode();
    while (this.rooms.has(code)) code = randomCode();
    const room = new Room(code, settings, (r) => this.rooms.delete(r.code));
    this.rooms.set(code, room);
    return room;
  }

  get(code: string) {
    return this.rooms.get(code.toUpperCase());
  }

  list(): RoomSummary[] {
    return [...this.rooms.values()]
      .filter((r) => !r.closed)
      .map((r) => r.summary())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) room.sweep(now);
  }

  playerCount() {
    let n = 0;
    for (const r of this.rooms.values()) n += r.humans().length;
    return n;
  }

  closeAll(reason: string) {
    for (const room of [...this.rooms.values()]) room.close(reason);
  }
}
