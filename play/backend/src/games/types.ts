// Contract between a room and the game running inside it. Each game is a self-contained module under games/<id>/.

import type { BotDifficulty, GameClientMsg, GameServerMsg, RoomSettings, Team } from '../shared/protocol.js';
import type { Look } from '../shared/rockets/cosmetics.js';

export interface GamePlayer {
  id: string;
  name: string;
  bot: boolean;
  color: number;
  /** Set in team modes. */
  team?: Team;
  /** Robot customisation (Rockets). */
  look?: Look;
}

/** What a game can see and do in its room. */
export interface GameHost {
  readonly code: string;
  readonly settings: RoomSettings;
  botDifficulty(): BotDifficulty;
  /** Everyone in the room, humans and bots. */
  players(): GamePlayer[];
  send(id: string, m: GameServerMsg): void;
  broadcast(m: GameServerMsg): void;
  systemChat(text: string): void;
  /** The game calls this once when the match is over; the room goes back to the waiting state shortly after. */
  matchEnded(): void;
}

export interface GameServer {
  start(): void;
  stop(): void;
  /** A player joined (possibly mid-match). The game must send that player whatever it needs to render. */
  addPlayer(p: GamePlayer): void;
  removePlayer(id: string): void;
  /** A player changed team mid-match (team modes only). */
  setTeam?(id: string, team: Team): void;
  onMessage(id: string, m: GameClientMsg): void;
}

export type GameFactory = (host: GameHost) => GameServer;
