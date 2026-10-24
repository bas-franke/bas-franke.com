// The player's robot look, kept in this browser. The room gets it with `setLook` after joining and on every change.

import { DEFAULT_LOOK, type Look, sanitizeLook } from '@shared/rockets/cosmetics';

const KEY = 'play.look';

/** The saved look (older saves get defaults for options added since), or the concept-art default. */
export function loadLook(): Required<Look> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitizeLook(JSON.parse(raw));
  } catch {
    /* storage unavailable or corrupt */
  }
  return { ...DEFAULT_LOOK };
}

export function saveLook(look: Look) {
  try {
    localStorage.setItem(KEY, JSON.stringify(look));
  } catch {
    /* storage unavailable */
  }
}
