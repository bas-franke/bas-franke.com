// Player customisation for Rockets: colours and part variants for the robot. A player's look is chosen in the
// customiser, saved in their browser, sent to the room, and shown to everyone. In team modes the body colour is
// replaced by the team colour; trim, visor and parts stay the player's own.

export const BODY_COLORS = [0xf07a1e, 0xe8392e, 0x3d7bff, 0x2fbf6a, 0x8d4bff, 0xffc83a, 0xf2f2ee, 0x3a3f4a, 0xff6ab0, 0x22c3c3] as const;
export const TRIM_COLORS = [0xeadcbc, 0xffffff, 0x9aa3b5, 0x1c1e22, 0xffd166, 0x7cf4c9] as const;
export const VISOR_COLORS = [0x4ff0ff, 0xff4fd8, 0x9bff4f, 0xffd23f, 0xff4b3a, 0xffffff] as const;

export const HELMETS = ['dome', 'crest', 'antenna', 'horns'] as const;
export const FACES = ['smile', 'visor', 'cyclops', 'grin'] as const;
export const SHOULDERS = ['round', 'block', 'spike'] as const;

export type Helmet = (typeof HELMETS)[number];
export type Face = (typeof FACES)[number];
export type Shoulders = (typeof SHOULDERS)[number];

export interface Look {
  body: number;
  trim: number;
  visor: number;
  helmet: Helmet;
  face: Face;
  shoulders: Shoulders;
}

/** The concept-art robot: orange body, cream trim, cyan smile. */
export const DEFAULT_LOOK: Look = { body: 0xf07a1e, trim: 0xeadcbc, visor: 0x4ff0ff, helmet: 'dome', face: 'smile', shoulders: 'round' };

const pick = <T>(list: readonly T[], value: unknown, fallback: T): T => (list.includes(value as T) ? (value as T) : fallback);

/** Accepts anything from the wire and returns a valid look (unknown values fall back to the default). */
export function sanitizeLook(raw: unknown): Look {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Look, unknown>>;
  return {
    body: pick(BODY_COLORS, r.body, DEFAULT_LOOK.body),
    trim: pick(TRIM_COLORS, r.trim, DEFAULT_LOOK.trim),
    visor: pick(VISOR_COLORS, r.visor, DEFAULT_LOOK.visor),
    helmet: pick(HELMETS, r.helmet, DEFAULT_LOOK.helmet),
    face: pick(FACES, r.face, DEFAULT_LOOK.face),
    shoulders: pick(SHOULDERS, r.shoulders, DEFAULT_LOOK.shoulders),
  };
}

/** A random look, for bots. */
export function randomLook(rand: () => number = Math.random): Look {
  const any = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  return { body: any(BODY_COLORS), trim: any(TRIM_COLORS), visor: any(VISOR_COLORS), helmet: any(HELMETS), face: any(FACES), shoulders: any(SHOULDERS) };
}
