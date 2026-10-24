// Player customisation for Rockets: colours and part variants for the robot. A player's look is chosen in the
// customiser, saved in their browser, sent to the room, and shown to everyone. In team modes the body colour is
// replaced by the team colour; trim, visor, paint pattern and parts stay the player's own.

// The robot renders its body and trim to match these swatches on a sunlit face (character.ts compensates for the
// lighting), so pick them as they should look on screen. Saved looks with a retired colour fall back to the default.
export const BODY_COLORS = [0xe8661a, 0xe8392e, 0x3d7bff, 0x2fbf6a, 0x8d4bff, 0xffc83a, 0xf2f2ee, 0x3a3f4a, 0xff6ab0, 0x22c3c3] as const;
export const TRIM_COLORS = [0xead7b0, 0xffffff, 0x9aa3b5, 0x1c1e22, 0xffd166, 0x7cf4c9] as const;
export const VISOR_COLORS = [0x4ff0ff, 0xff4fd8, 0x9bff4f, 0xffd23f, 0xff4b3a, 0xffffff] as const;

export const HELMETS = ['dome', 'crest', 'antenna', 'horns'] as const;
export const FACES = ['smile', 'visor', 'cyclops', 'grin'] as const;
export const SHOULDERS = ['round', 'block', 'spike'] as const;
/** How the armour is painted in the body and trim colours. */
export const PATTERNS = ['plain', 'two-tone', 'stripes', 'chevrons', 'camo-blocks'] as const;
export const BACKPACKS = ['none', 'thrusters', 'antenna-pack', 'tank'] as const;
export const BOOTS = ['standard', 'heavy', 'spring'] as const;
/** A small decal on the left shoulder pad. */
export const EMBLEMS = ['none', 'star', 'bolt', 'ring', 'diamond', 'cross', 'heart'] as const;
/** The visor glass: ear to ear, split by a centre bar, or a rounder window. */
export const VISOR_SHAPES = ['wide', 'split', 'round'] as const;
/** What sits on the sides of the helmet. */
export const EARS = ['pods', 'fins', 'none'] as const;

export type Helmet = (typeof HELMETS)[number];
export type Face = (typeof FACES)[number];
export type Shoulders = (typeof SHOULDERS)[number];
export type Pattern = (typeof PATTERNS)[number];
export type Backpack = (typeof BACKPACKS)[number];
export type Boots = (typeof BOOTS)[number];
export type Emblem = (typeof EMBLEMS)[number];
export type VisorShape = (typeof VISOR_SHAPES)[number];
export type Ears = (typeof EARS)[number];

export interface Look {
  body: number;
  trim: number;
  visor: number;
  helmet: Helmet;
  face: Face;
  shoulders: Shoulders;
  /** Added later: optional so older saved looks and clients still fit (missing means the default). */
  pattern?: Pattern;
  backpack?: Backpack;
  boots?: Boots;
  emblem?: Emblem;
  visorShape?: VisorShape;
  ears?: Ears;
}

/** The concept-art robot: orange body, cream trim, cyan smile. */
export const DEFAULT_LOOK: Required<Look> = {
  body: 0xe8661a,
  trim: 0xead7b0,
  visor: 0x4ff0ff,
  helmet: 'dome',
  face: 'smile',
  shoulders: 'round',
  pattern: 'plain',
  backpack: 'none',
  boots: 'standard',
  emblem: 'none',
  visorShape: 'wide',
  ears: 'pods',
};

const pick = <T>(list: readonly T[], value: unknown, fallback: T): T => (list.includes(value as T) ? (value as T) : fallback);

/** Accepts anything from the wire and returns a valid, complete look (unknown or missing values fall back to the default). */
export function sanitizeLook(raw: unknown): Required<Look> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Look, unknown>>;
  return {
    body: pick(BODY_COLORS, r.body, DEFAULT_LOOK.body),
    trim: pick(TRIM_COLORS, r.trim, DEFAULT_LOOK.trim),
    visor: pick(VISOR_COLORS, r.visor, DEFAULT_LOOK.visor),
    helmet: pick(HELMETS, r.helmet, DEFAULT_LOOK.helmet),
    face: pick(FACES, r.face, DEFAULT_LOOK.face),
    shoulders: pick(SHOULDERS, r.shoulders, DEFAULT_LOOK.shoulders),
    pattern: pick(PATTERNS, r.pattern, DEFAULT_LOOK.pattern),
    backpack: pick(BACKPACKS, r.backpack, DEFAULT_LOOK.backpack),
    boots: pick(BOOTS, r.boots, DEFAULT_LOOK.boots),
    emblem: pick(EMBLEMS, r.emblem, DEFAULT_LOOK.emblem),
    visorShape: pick(VISOR_SHAPES, r.visorShape, DEFAULT_LOOK.visorShape),
    ears: pick(EARS, r.ears, DEFAULT_LOOK.ears),
  };
}

/** A random look, for bots and the customiser's Randomize. */
export function randomLook(rand: () => number = Math.random): Required<Look> {
  const any = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  return {
    body: any(BODY_COLORS),
    trim: any(TRIM_COLORS),
    visor: any(VISOR_COLORS),
    helmet: any(HELMETS),
    face: any(FACES),
    shoulders: any(SHOULDERS),
    pattern: any(PATTERNS),
    backpack: any(BACKPACKS),
    boots: any(BOOTS),
    emblem: any(EMBLEMS),
    visorShape: any(VISOR_SHAPES),
    ears: any(EARS),
  };
}
