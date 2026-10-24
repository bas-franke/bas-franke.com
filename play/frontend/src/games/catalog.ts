// Screenshots shown in the lobby, the room page and the game picker. The files live in public/screenshots/ and the
// list in screenshots.json; both are written by `npm run screenshots` (see ../../../SCREENSHOTS.md), never by hand.
// The first screenshot of a game is its cover.

import { GAME_IDS, GAMES, SOLO_GAME_IDS, SOLO_GAMES, type GameId, type SoloGameId } from '@shared/protocol';
import manifest from './screenshots.json';

export interface Screenshot {
  src: string;
  caption: string;
  alt: string;
}

type Manifest = Partial<Record<string, { file: string; caption: string }[]>>;

const byGame = manifest as Manifest;

const nameOf = (id: GameId | SoloGameId) => (id in GAMES ? GAMES[id as GameId] : SOLO_GAMES[id as SoloGameId]).name;

export const SCREENSHOTS = Object.fromEntries(
  [...GAME_IDS, ...SOLO_GAME_IDS].map((id) => [
    id,
    (byGame[id] ?? []).map((s) => ({ src: `/screenshots/${s.file}`, caption: s.caption, alt: `${nameOf(id)}: ${s.caption}` })),
  ]),
) as Record<GameId | SoloGameId, Screenshot[]>;

export const coverOf = (id: GameId | SoloGameId): Screenshot | undefined => SCREENSHOTS[id][0];
