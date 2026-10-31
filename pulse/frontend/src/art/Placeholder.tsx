// Placeholder for a slot without a picture yet: a painted flat SVG scene per slot, built from the motifs in motifs.tsx and
// coloured with theme variables so it works in light and dark. Same props as before: { slot, className, alt }.
import { useId } from 'react';
import { slotDef } from './slots';
import * as H from './scenes-hero';
import * as S from './scenes-small';
import * as C from './scenes-cover';
import type { Scene } from './scenes-hero';

const SCENES: Record<string, Scene> = {
  'hero-morning': H.heroMorning, 'hero-day': H.heroDay, 'hero-evening': H.heroEvening, 'hero-night': H.heroNight,
  'banner-board': H.bannerBoard, 'banner-notes': H.bannerNotes,
  'column-todo': S.columnTodo, 'column-doing': S.columnDoing, 'column-done': S.columnDone,
  'empty-board': S.emptyBoard, 'empty-column': S.emptyColumn, 'empty-notes': S.emptyNotes, 'empty-today': S.emptyToday, 'empty-search': S.emptySearch,
  'card-today': S.cardToday, 'card-overdue': S.cardOverdue, 'card-upcoming': S.cardUpcoming, 'card-notes': S.cardNotes,
  'cover-rain-window': C.coverRainWindow, 'cover-tea': C.coverTea, 'cover-plants': C.coverPlants, 'cover-books': C.coverBooks,
  'cover-meadow': C.coverMeadow, 'cover-autumn': C.coverAutumn, 'cover-snow': C.coverSnow, 'cover-bread': C.coverBread,
  'cover-hills': C.coverHills, 'cover-shapes': C.coverShapes, 'cover-fox': C.coverFox, 'cover-owl': C.coverOwl,
  loading: C.loadingScene, notfound: C.notFound, login: C.loginScene, icon: C.iconScene,
};

const CSS = `
@keyframes ph-steam{0%{transform:translateY(6px);opacity:0}30%{opacity:.9}100%{transform:translateY(-14px);opacity:0}}
.art-ph .steam{animation:ph-steam 3.2s ease-in-out infinite}
.art-ph .s2{animation-delay:1.4s}
@media (prefers-reduced-motion:reduce){.art-ph .steam{animation:none}}
`;

export function Placeholder({ slot, className = '', alt = '' }: { slot: string; className?: string; alt?: string }) {
  const k = 'p' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const def = slotDef(slot);
  const w = def?.w ?? 800;
  const h = def?.h ?? 600;
  const scene = SCENES[slot] ?? SCENES['cover-hills'];
  return (
    <svg
      className={`art art-ph ${className}`}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid slice"
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    >
      <style>{CSS}</style>
      {scene(w, h, k)}
    </svg>
  );
}
