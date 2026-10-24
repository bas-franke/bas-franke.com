// <Icon>: the UI's inline SVG icons (drawn in iconData.ts), plus the lookups that pick an icon for a mission, chapter,
// variant or creature, and a helper that swaps the emoji the game logic still puts in its strings for icons.

import { Fragment, type ReactNode } from 'react';
import type { Mission, Variant } from './game/campaign';
import { CHAPTERS, MISSIONS, VARIANTS } from './game/campaign';
import { ICON_DATA, type IconName } from './iconData';

export type { IconName };

/**
 * One icon, 1em square by default, stroked in currentColor. With a `label` it is announced (role img + title),
 * otherwise it is decorative and hidden from screen readers.
 */
export function Icon({ name, label, className, size }: { name: IconName; label?: string; className?: string; size?: number | string }) {
  const style = size !== undefined ? { width: size, height: size } : undefined;
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg viewBox="0 0 24 24" className={`icon icon-${name}${className ? ` ${className}` : ''}`} style={style} focusable="false" {...a11y}>
      {label && <title>{label}</title>}
      <g dangerouslySetInnerHTML={{ __html: ICON_DATA[name] }} />
    </svg>
  );
}

export const VARIANT_ICON: Record<Variant, IconName> = {
  std: 'star',
  memory: 'memory',
  reverse: 'reverse',
  speed: 'speed',
  perfect: 'perfect',
};

/** Chapter emblems, by chapter number (1-based). */
const CHAPTER_ICONS: IconName[] = ['village', 'forest', 'home', 'town', 'school', 'fair', 'mountains', 'citadel'];
export const chapterIcon = (n: number): IconName => CHAPTER_ICONS[n - 1] ?? 'book';

const MISSION_ICONS: Record<string, IconName> = {
  salut: 'hello',
  numere: 'dice',
  familia: 'family',
  masa: 'apple',
  animale: 'paw',
  natura: 'flower',
  vreme: 'weather',
  propozitii1: 'sentence',
  salbatice: 'fox',
  acasa: 'sofa',
  haine: 'shirt',
  corp: 'body',
  timp: 'clock',
  bucatarie: 'pot',
  oras: 'hall',
  drum: 'signpost',
  cumparaturi: 'basket',
  vorba: 'talk',
  numere2: 'abacus',
  scoala: 'satchel',
  verbe: 'run',
  adjective: 'adjectives',
  meserii: 'briefcase',
  legaturi: 'chain',
  sport: 'ball',
  arta: 'music',
  sarbatori: 'gift',
  suflet: 'soul',
  online: 'laptop',
  stiinta: 'flask',
  cetate: 'castle',
  propozitii2: 'quill',
  verbe2: 'wingboot',
  adjective2: 'mask',
  lumea: 'globe',
  maestru1: 'book',
  maestru2: 'scroll',
  maestru3: 'crown',
};

/** A mission's emblem: its own drawing, the review arrows or the Bookwyrm; undefined = use the numbered medallion. */
export function missionIcon(m: Pick<Mission, 'id' | 'kind'> | { missionId: string }): IconName | undefined {
  const id = 'id' in m ? m.id : m.missionId;
  if (id.startsWith('recap')) return 'review';
  if (id.startsWith('boss')) return 'dragon';
  return MISSION_ICONS[id];
}

/** The mission emblem, or a lettered medallion with the mission number when it has no drawing. */
export function MissionEmblem({ mission, className }: { mission: Pick<Mission, 'id' | 'kind' | 'n'>; className?: string }) {
  const name = missionIcon(mission);
  if (name) return <Icon name={name} className={className} />;
  return (
    <span className={`medallion${className ? ` ${className}` : ''}`} aria-hidden="true">
      <b>{mission.n}</b>
    </span>
  );
}

// ---- emoji in strings from the game logic -----------------------------------------------------------------------

const EMOJI = /(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*️?)/u;
const EMOJI_ICON = new Map<string, IconName>([
  ['⭐', 'star'],
  ['♥', 'heart'],
  ['🎭', 'mask'],
  ['🔁', 'review'],
  ['🐉', 'dragon'],
  ['📚', 'book'],
  ['🔒', 'lock'],
]);
for (const [v, info] of Object.entries(VARIANTS)) EMOJI_ICON.set(info.emoji, VARIANT_ICON[v as Variant]);
for (const m of MISSIONS) {
  const name = missionIcon(m);
  if (name && !EMOJI_ICON.has(m.emoji)) EMOJI_ICON.set(m.emoji, name);
}
CHAPTERS.forEach((c) => !EMOJI_ICON.has(c.emoji) && EMOJI_ICON.set(c.emoji, chapterIcon(c.n)));

const bare = (s: string) => s.replace(/️/g, '');

/** Text with every emoji swapped for the matching icon (unknown emoji are dropped). */
export function IconText({ text }: { text: string }) {
  const parts = text.split(new RegExp(EMOJI.source, 'gu'));
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (i % 2 === 0) {
      if (p) out.push(<Fragment key={i}>{p}</Fragment>);
      return;
    }
    const name = EMOJI_ICON.get(p) ?? EMOJI_ICON.get(bare(p));
    if (name) out.push(<Icon key={i} name={name} className="inline" />);
  });
  return <>{out}</>;
}

/** The same text with emoji removed, for labels and titles. */
export const stripEmoji = (s: string) => s.replace(new RegExp(EMOJI.source, 'gu'), '').replace(/\s{2,}/g, ' ').trim();
