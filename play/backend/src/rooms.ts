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
  type GameId,
  type GameServerMsg,
  type PlayerInfo,
  type RoomSettings,
  type RoomState,
  type RoomSummary,
  type RoomView,
  type ServerMsg,
  sanitizeName,
} from './shared/protocol.js';
import { mapById, RANDOM_MAP } from './shared/rockets/maps.js';
import { MODES, TEAMS } from './shared/rockets/modes.js';
import { botLook, sanitizeLook } from './shared/rockets/cosmetics.js';
import { zmapById } from './shared/zombies/maps.js';
import { isGMode } from './shared/garden/constants.js';
import { gmapById } from './shared/garden/maps.js';
import { drTrackById } from './shared/dustrunners/tracks.js';
import type { GameMode, RocketsMode, Team } from './shared/protocol.js';

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
  /** The browser's `play_id` cookie (or `pid` query param): recognises a player who reconnects mid-match. */
  playId?: string;
  /** Joined while a match was running: in the room (list, chat) but not in the game until the next start. */
  waiting?: boolean;
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
/** How long a match with only waiting humans left keeps running, so its last player can refresh and come back. */
const ABANDON_GRACE_MS = 15_000;

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
  private abandonTimer?: NodeJS.Timeout;
  /** play_ids of the humans in the running match (seated at the start or rejoined); a reconnect with one goes back in. */
  private readonly matchIds = new Set<string>();
  /** play_id of the host who left the running match; they get the host back when they reconnect. */
  private leftHostPlayId?: string;
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

  /** What the game sees: everyone seated, humans and bots; members waiting for the next match are left out. */
  players(): GamePlayer[] {
    return [...this.members.values()].filter((m) => !m.waiting).map(({ id, name, bot, color, team, look }) => ({ id, name, bot, color, team, look }));
  }

  /** Every human in the room, seated or waiting. */
  humans() {
    return [...this.members.values()].filter((m) => !m.bot);
  }

  /** Humans waiting for the next match. */
  waitingHumans() {
    return [...this.members.values()].filter((m) => m.waiting);
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
      ...(m.team !== undefined ? { team: m.team } : {}),
      ...(m.look ? { look: m.look } : {}),
      ...(m.waiting ? { waiting: true } : {}),
    }));
    return {
      code: this.code,
      name: this.settings.name,
      game: this.settings.game,
      state: this.state,
      maxPlayers: this.settings.maxPlayers,
      botDifficulty: this.settings.botDifficulty,
      map: this.settings.map,
      mode: this.settings.mode,
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
      waiting: this.waitingHumans().length,
      bots: this.bots().length,
      maxPlayers: this.settings.maxPlayers,
      state: this.state,
      createdAt: this.createdAt,
    };
  }

  // ---- membership ---------------------------------------------------------------------------------------------

  /**
   * A human joins. In the waiting state they are simply in. While a match runs they wait for the next one (listed,
   * chatting, no game messages) unless their play_id was in this match: a refresh or reconnect goes straight back in.
   * Only humans fill a room: bots never block a joiner (they are trimmed when the next match starts).
   */
  addHuman(socket: WebSocket, rawName: string, playId?: string): Member {
    if (this.closed) throw new RoomError('This room has closed.', 410);
    // The same browser is already here (a second tab, or a socket that has not timed out yet after a refresh): the
    // new connection takes over its seat and name, so one person never holds two seats and games that reclaim by
    // name (Garden Sentinels) find theirs.
    const prev = playId ? this.humans().find((m) => m.playId === playId) : undefined;
    let name = sanitizeName(rawName, 'Player');
    let wasHost = false;
    if (prev) {
      name = prev.name;
      wasHost = this.hostId === prev.id;
      this.removeMember(prev.id, 'Opened in another tab.', true);
    }
    const playing = this.state === 'playing' && !!this.game;
    const rejoin = playing && !!playId && this.matchIds.has(playId);
    const seated = !playing || rejoin;
    // Only humans fill a room. A rejoiner only needs a seat in the match, so waiters never take the seat of a
    // player who is refreshing.
    const taken = rejoin ? this.seatedHumans().length : this.humans().length;
    if (taken >= this.settings.maxPlayers) throw new RoomError('This room is full.', 409);
    if (seated && this.members.size >= this.settings.maxPlayers && !this.keepsBotsMidMatch()) {
      // Humans take priority over bots: drop a bot to make space (see keepsBotsMidMatch for the exceptions).
      const bot = this.bots().pop();
      if (bot) this.removeMember(bot.id, 'replaced by a player');
    }
    const member: Member = {
      id: randomId('p'),
      name: this.uniqueName(name),
      bot: false,
      color: this.freeColor(),
      socket,
      ping: 0,
      joinedAt: Date.now(),
      ...(playId ? { playId } : {}),
      ...(seated ? {} : { waiting: true }),
    };
    if (seated && this.teamMode()) member.team = this.smallerTeam();
    this.members.set(member.id, member);
    if (seated) this.balanceBots();
    this.everJoined = true;
    this.emptySince = null;
    // The host gets the room back after a refresh: same tab replaced, or the match's host reconnecting.
    const backAsHost = wasHost || (rejoin && !!playId && playId === this.leftHostPlayId);
    if (!this.hostId || backAsHost) this.hostId = member.id;
    if (backAsHost) this.leftHostPlayId = undefined;
    this.sendTo(member, { t: 'welcome', you: member.id, room: this.view(), serverTime: Date.now() });
    this.broadcastRoom();
    if (!seated) this.systemChat(`${member.name} joined and plays from the next match`);
    else if (!prev) this.systemChat(rejoin ? `${member.name} is back` : `${member.name} joined`);
    if (playing && seated) {
      if (playId) this.matchIds.add(playId);
      this.game?.addPlayer(member);
    }
    this.checkAbandoned();
    return member;
  }

  /** Humans in the room who are not waiting for the next match. */
  seatedHumans() {
    return this.humans().filter((m) => !m.waiting);
  }

  /**
   * Seats waiting members (new match or back to the lobby), oldest first while there are seats for humans, and trims
   * bots so the room fits maxPlayers again. Anyone over the limit (rejoiners took the seats) keeps waiting.
   */
  private seatWaiting() {
    const waiting = this.waitingHumans().sort((a, b) => a.joinedAt - b.joinedAt);
    let free = this.settings.maxPlayers - this.seatedHumans().length;
    let seated = 0;
    for (const m of waiting) {
      if (free-- <= 0) break;
      delete m.waiting;
      if (this.teamMode()) m.team = this.smallerTeam();
      seated++;
    }
    if (seated > 0 || this.members.size > this.settings.maxPlayers) this.setBots(this.bots().length);
    else this.balanceBots();
  }

  /**
   * Mid-match bots that must not be evicted for a rejoiner: Garden Sentinels versus bots own a board (the rejoiner is
   * seated over the limit; stopGame trims the extra bots) and a Dustrunners joiner only spectates the race anyway.
   */
  private keepsBotsMidMatch() {
    return this.state === 'playing' && (this.gardenVersusPlaying() || this.settings.game === 'dustrunners');
  }

  private gardenVersusPlaying() {
    return this.settings.game === 'garden' && this.settings.mode === 'vs' && this.state === 'playing';
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

  /** `quiet`: no "left" line or host handover message (the same player is replacing this connection right away). */
  removeMember(id: string, reason: string, quiet = false) {
    const member = this.members.get(id);
    if (!member) return;
    this.members.delete(id);
    if (!member.waiting) this.game?.removePlayer(id);
    if (member.socket && member.socket.readyState === 1) {
      this.sendTo(member, { t: 'closed', reason });
      member.socket.close(1000, reason);
    }
    if (!member.bot && !quiet) this.systemChat(`${member.name} left`);
    if (this.hostId === id) {
      // A host who leaves mid-match gets the room back on reconnecting (addHuman); meanwhile a seated human takes over.
      if (this.state === 'playing' && member.playId && !quiet) this.leftHostPlayId = member.playId;
      const next = this.seatedHumans()[0] ?? this.humans()[0];
      this.hostId = next?.id ?? null;
      if (next && !quiet) this.systemChat(`${next.name} is now the host`);
    }
    if (this.humans().length === 0) this.emptySince ??= Date.now();
    this.balanceBots();
    this.broadcastRoom();
    if (!member.bot) this.checkAbandoned();
  }

  /**
   * The last player in the match left while others wait for the next one (or a waiter arrived after they left): end
   * it after a grace period for a page refresh, instead of leaving the waiters behind an endless bot match.
   */
  private checkAbandoned() {
    if (this.abandonTimer || !this.abandoned()) return;
    this.abandonTimer = setTimeout(() => {
      this.abandonTimer = undefined;
      if (this.abandoned()) this.stopGame('Everyone in the match left: the next one can start.');
    }, ABANDON_GRACE_MS);
  }

  /** A match is running with no seated human in it while somebody waits for the next one. */
  private abandoned() {
    return !this.closed && this.state === 'playing' && this.waitingHumans().length > 0 && this.seatedHumans().length === 0;
  }

  // ---- teams ----------------------------------------------------------------------------------------------------

  private teamMode() {
    return this.settings.game === 'rockets' && !!MODES[this.settings.mode as RocketsMode]?.teams;
  }

  private teamCount(team: Team, onlyBots = false) {
    let n = 0;
    for (const m of this.members.values()) if (m.team === team && !m.waiting && (!onlyBots || m.bot)) n++;
    return n;
  }

  /** The team a newcomer should join: fewer players, then fewer bots (so humans spread out), then Red. */
  private smallerTeam(): Team {
    const red = this.teamCount(0);
    const blue = this.teamCount(1);
    if (red !== blue) return red < blue ? 0 : 1;
    return this.teamCount(0, true) >= this.teamCount(1, true) ? 0 : 1;
  }

  private moveTo(m: Member, team: Team) {
    if (m.team === team) return;
    m.team = team;
    this.game?.setTeam?.(m.id, team);
  }

  /** Keeps teams within one player of each other by moving bots, never humans. */
  private balanceBots() {
    if (!this.teamMode()) return;
    for (let guard = 0; guard < LIMITS.maxPlayers; guard++) {
      const red = this.teamCount(0);
      const blue = this.teamCount(1);
      if (Math.abs(red - blue) < 2) return;
      const big: Team = red > blue ? 0 : 1;
      const bot = this.bots().find((b) => b.team === big);
      if (!bot) return;
      this.moveTo(bot, big === 0 ? 1 : 0);
    }
  }

  /** Puts everyone on a team (team modes) or clears teams (free for all). */
  private assignTeams() {
    if (!this.teamMode()) {
      for (const m of this.members.values()) delete m.team;
      return;
    }
    for (const m of this.members.values()) if (m.team === undefined && !m.waiting) m.team = this.smallerTeam();
    this.balanceBots();
  }

  private setTeam(member: Member, team: Team) {
    if (!this.teamMode() || member.waiting || (team !== 0 && team !== 1) || member.team === team) return;
    this.moveTo(member, team);
    this.balanceBots();
    this.systemChat(`${member.name} joined ${TEAMS[team].name}`);
    this.broadcastRoom();
  }

  setBots(count: number, difficulty?: BotDifficulty) {
    if (difficulty) this.settings.botDifficulty = difficulty;
    // Mid-match, members waiting for the next one do not take seats from bots yet (seatWaiting trims at the start).
    const humans = this.state === 'playing' ? this.seatedHumans().length : this.humans().length;
    const maxBots = Math.max(0, this.settings.maxPlayers - humans);
    count = Math.min(Math.max(0, Math.floor(count)), maxBots);
    const bots = this.bots();
    while (bots.length > count) this.removeMember(bots.pop()!.id, 'bot removed');
    while (bots.length < count) {
      const taken = new Set(bots.map((b) => b.name));
      const name = BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${bots.length + 1}`;
      const bot: Member = { id: randomId('b'), name, bot: true, color: this.freeColor(), look: botLook(), ping: 0, joinedAt: Date.now() };
      if (this.teamMode()) bot.team = this.smallerTeam();
      this.members.set(bot.id, bot);
      bots.push(bot);
      this.game?.addPlayer(bot);
    }
    this.settings.bots = count;
    this.balanceBots();
    this.broadcastRoom();
  }

  // ---- game lifecycle -----------------------------------------------------------------------------------------

  startGame() {
    if (this.state === 'playing') throw new RoomError('The game is already running.');
    this.seatWaiting();
    const meta = GAMES[this.settings.game];
    if (this.members.size < meta.minPlayers) throw new RoomError(`${meta.name} needs at least ${meta.minPlayers} players. Add a bot or wait for a friend.`);
    this.game = gameFactories[this.settings.game](this);
    this.state = 'playing';
    this.matchIds.clear();
    for (const m of this.humans()) if (m.playId) this.matchIds.add(m.playId);
    this.broadcastRoom();
    this.game.start();
  }

  stopGame(reason: string) {
    clearTimeout(this.endTimer);
    this.endTimer = undefined;
    clearTimeout(this.abandonTimer);
    this.abandonTimer = undefined;
    if (!this.game) return;
    const game = this.game;
    this.game = undefined;
    game.stop();
    this.state = 'waiting';
    this.matchIds.clear();
    this.leftHostPlayId = undefined;
    this.systemChat(reason);
    // Back in the lobby everyone is in: seat the waiting members and trim bots (also Garden versus rejoiners seated
    // over the limit) until the room fits again.
    this.seatWaiting();
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
      case 'setBots': {
        this.requireHost(member);
        // Validate: an unknown difficulty used to crash the bot code inside the game loop.
        const d = msg.difficulty === 'easy' || msg.difficulty === 'normal' || msg.difficulty === 'hard' ? msg.difficulty : undefined;
        this.setBots(Number(msg.count) || 0, d);
        return;
      }
      case 'setMap':
        this.requireHost(member);
        if (msg.map === RANDOM_MAP || validMap(this.settings.game, String(msg.map), this.settings.mode)) this.settings.map = msg.map;
        this.broadcastRoom();
        return;
      case 'setMode':
        this.requireHost(member);
        if (this.state === 'playing') throw new RoomError('Change the mode between matches.');
        if (!validMode(this.settings.game, msg.mode)) return;
        this.settings.mode = msg.mode;
        // Garden Sentinels maps belong to one mode; a map of the other mode falls back to random.
        if (this.settings.game === 'garden' && this.settings.map !== RANDOM_MAP && !gmapById(this.settings.map)?.modes.includes(msg.mode as 'coop' | 'vs')) this.settings.map = RANDOM_MAP;
        this.assignTeams();
        this.broadcastRoom();
        return;
      case 'setTeam':
        this.setTeam(member, msg.team);
        return;
      case 'setLook':
        member.look = sanitizeLook(msg.look);
        this.broadcastRoom();
        return;
      case 'start':
        this.requireHost(member);
        if (this.settings.game === 'garden' && this.settings.mode === 'vs' && this.members.size < 2) {
          throw new RoomError('Versus needs at least two gardens: invite someone or add a bot.');
        }
        this.startGame();
        this.systemChat(`${member.name} started ${GAMES[this.settings.game].name}`);
        return;
      case 'stop':
        this.requireHost(member);
        if (this.state === 'playing') this.stopGame(`${member.name} ended the match`);
        return;
      case 'g':
        if (!member.waiting) this.game?.onMessage(id, msg.m);
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
    // Snapshots are superseded 30 times a second: skip them for a socket that is not draining.
    if (member?.socket && (m as { k?: string }).k === 'snap' && member.socket.bufferedAmount > 64 * 1024) return;
    // Garden Sentinels: a re-sent full init ('sync') is not queued behind a socket that is already badly backed up.
    if (member?.socket && this.settings.game === 'garden' && (m as { k?: string }).k === 'init' && member.socket.bufferedAmount > 256 * 1024) return;
    if (member && !member.waiting) this.sendTo(member, { t: 'g', m });
  }

  /** Sends a room-level message to everyone connected. */
  broadcastAll(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) if (m.socket && m.socket.readyState === 1) m.socket.send(data);
  }

  /** GameHost.broadcast: wraps a game message in the envelope. */
  broadcast(m: GameServerMsg) {
    const data = JSON.stringify({ t: 'g', m } satisfies ServerMsg);
    for (const p of this.members.values()) if (!p.waiting && p.socket && p.socket.readyState === 1) p.socket.send(data);
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
    clearTimeout(this.abandonTimer);
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

/** Whether `id` is one of the maps of `game` (Dustrunners: its tracks; games without maps have none). */
const validMap = (game: GameId, id: string, mode?: GameMode) =>
  game === 'rockets'
    ? !!mapById(id)
    : game === 'zombies'
      ? !!zmapById(id)
      : game === 'garden'
        ? !!gmapById(id)?.modes.includes(isGMode(mode) ? mode : 'coop')
        : game === 'dustrunners'
          ? !!drTrackById(id)
          : false;

/** Modes per game: Rockets has its MODES, Garden Sentinels co-op / versus, the others ignore the mode. */
const validMode = (game: GameId, mode: unknown) => (game === 'garden' ? isGMode(mode) : typeof mode === 'string' && mode in MODES);
const defaultMode = (game: GameId): GameMode => (game === 'garden' ? 'coop' : 'ffa');

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
      mode: validMode(game, raw.mode) ? (raw.mode as GameMode) : defaultMode(game),
      map: typeof raw.map === 'string' && validMap(game, raw.map, validMode(game, raw.mode) ? (raw.mode as GameMode) : defaultMode(game)) ? raw.map : RANDOM_MAP,
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
