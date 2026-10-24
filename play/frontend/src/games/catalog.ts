// Screenshots shown in the lobby, the room page and the game picker. The files live in public/screenshots/ and the
// list in screenshots.json; both are written by `npm run screenshots` (see ../../../SCREENSHOTS.md), never by hand.
// The first screenshot of a game is its cover.

import { GAME_IDS, GAMES, type GameId } from '@shared/protocol';
import manifest from './screenshots.json';

export interface Screenshot {
  src: string;
  caption: string;
  alt: string;
}

type Manifest = Partial<Record<string, { file: string; caption: string }[]>>;

const byGame = manifest as Manifest;

export const SCREENSHOTS = Object.fromEntries(
  GAME_IDS.map((id) => [
    id,
    (byGame[id] ?? []).map((s) => ({ src: `/screenshots/${s.file}`, caption: s.caption, alt: `${GAMES[id].name}: ${s.caption}` })),
  ]),
) as Record<GameId, Screenshot[]>;

export const coverOf = (id: GameId): Screenshot | undefined => SCREENSHOTS[id][0];
