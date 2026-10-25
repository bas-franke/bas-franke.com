// The menu's copies of Last Light's graphics and mouse settings. client.ts reads the same storage keys when a match
// starts; importing its readers here would drag three.js into the menu chunk, so these few lines are duplicated.

export type Quality = 'low' | 'medium' | 'high';

const QUALITY_KEY = 'lastlight.quality.v1';
const SENS_KEY = 'lastlight.sens.v1';

export const QUALITIES: { id: Quality; label: string; blurb: string }[] = [
  { id: 'low', label: 'Low', blurb: 'Half-size textures, fewer shadows and effects. For older laptops.' },
  { id: 'medium', label: 'Medium', blurb: 'The balanced default.' },
  { id: 'high', label: 'High', blurb: 'Sharpest picture, every effect. Wants a real graphics card.' },
];

/** Same range as the in-game slider in Hud.tsx. */
export const SENS_MIN = 0.2;
export const SENS_MAX = 3;

export function loadQuality(): Quality {
  try {
    const q = localStorage.getItem(QUALITY_KEY);
    if (q === 'low' || q === 'medium' || q === 'high') return q;
  } catch {
    /* storage blocked */
  }
  return 'medium';
}

export function loadSensitivity(): number {
  try {
    const s = Number(localStorage.getItem(SENS_KEY));
    if (s > 0.1 && s < 5) return s;
  } catch {
    /* storage blocked */
  }
  return 1;
}

const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the setting just lasts this visit */
  }
};

export const saveQuality = (q: Quality) => store(QUALITY_KEY, q);
export const saveSensitivity = (s: number) => store(SENS_KEY, String(s));
