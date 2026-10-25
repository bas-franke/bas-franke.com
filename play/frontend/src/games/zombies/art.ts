// Key art for the Last Light menu and loading screens: cinematic, HUD-free shots of the hotel. The files live in
// public/art/lastlight/ and the list in art.json; both are written by `npm run screenshots -- --only zombies`
// (see ../../../SCREENSHOTS.md), never by hand. Until the first run, the lobby screenshots stand in.

import { SCREENSHOTS } from '../catalog';
import manifest from './art.json';

export interface LLArt {
  src: string;
  caption: string;
}

const own = (manifest as { file: string; caption: string }[]).map((a) => ({ src: `/art/lastlight/${a.file}`, caption: a.caption }));

export const LL_ART: LLArt[] = own.length ? own : SCREENSHOTS.zombies.map((s) => ({ src: s.src, caption: s.caption }));

/** A different picture each time, so back-to-back loads do not repeat. */
let last = -1;
export function pickArt(): LLArt | undefined {
  if (!LL_ART.length) return undefined;
  let i = Math.floor(Math.random() * LL_ART.length);
  if (LL_ART.length > 1 && i === last) i = (i + 1) % LL_ART.length;
  last = i;
  return LL_ART[i];
}
