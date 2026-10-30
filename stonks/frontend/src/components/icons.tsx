// Small inline icons and hand-drawn-feeling illustrations. All strokes use currentColor.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const IconHome = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M4 11.5 12 5l8 6.5" />
    <path d="M6 10v8.5a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1V10" />
  </svg>
);
export const IconTrades = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M7 4v15M7 19l-3-3M7 19l3-3" />
    <path d="M17 20V5M17 5l-3 3M17 5l3 3" />
  </svg>
);
export const IconLogs = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3.5" />
    <path d="M8 9h1M11.5 9H16M8 12.5h1M11.5 12.5H15M8 16h1M11.5 16h3" />
  </svg>
);
export const IconResearch = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M9.5 4h5M10.5 4v5.2L5.6 17.6A1.6 1.6 0 0 0 7 20h10a1.6 1.6 0 0 0 1.4-2.4L13.5 9.2V4" />
    <path d="M8 14.5h8" />
  </svg>
);
export const IconNotes = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M7.5 3.5h6.2L18.5 8.2V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1.5-1.5Z" />
    <path d="M13.5 3.6V8.2H18.4" />
    <path d="M9 12h6M9 15.5h4" />
  </svg>
);
export const IconSettings = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M5 7h9M18 7h1M5 17h1M10 17h9" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </svg>
);
export const IconHealth = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.500 15.400 12 20 12 20Z" />
    <path d="M7.500 12.500h2.500l1.300-2.300 1.700 4 1.200-1.700h2.300" />
  </svg>
);
export const IconMore = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M5 7h14M5 12h14M5 17h14" />
  </svg>
);
export const IconSun = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1" />
  </svg>
);
export const IconMoon = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z" />
  </svg>
);
export const IconLogout = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M14 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7" />
    <path d="M11 12h9M17 9l3 3-3 3" />
  </svg>
);
export const IconPause = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M9 6v12M15 6v12" />
  </svg>
);
export const IconPlay = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M8 5.5v13l10-6.5z" />
  </svg>
);
export const IconCheck = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
/** A rising line: the write-up with every coin and the compare graph. */
export const IconChart = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M4 19h16M5 15l4-5 3.5 3L19 6" />
  </svg>
);
export const IconStar = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="m12 3.5 2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.8l-5.4 2.9 1.2-5.9L3.4 9.7l6-.7z" />
  </svg>
);
export const IconStarFilled = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} fill="currentColor" {...p}>
    <path d="m12 3.5 2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.8l-5.4 2.9 1.2-5.9L3.4 9.7l6-.7z" />
  </svg>
);
/** Sliders: tweak the settings. */
export const IconSliders = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </svg>
);
export const IconTrash = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M4 7h16M9 7V4.5h6V7M7 7l1 13h8l1-13M10 11v6M14 11v6" />
  </svg>
);
export const IconPower = (p: P) => (
  <svg viewBox="0 0 24 24" {...base} strokeWidth={2} {...p}>
    <path d="M12 4v7" />
    <path d="M7.5 7a7 7 0 1 0 9 0" />
  </svg>
);

/** Brand mark: a little sprout growing out of a rising line. */
export const BrandMark = (p: P) => (
  <svg viewBox="0 0 32 32" width="30" height="30" {...base} strokeWidth={1.7} {...p}>
    <path d="M4 25c4-1 6-5 9-5s4 3 7 1 4-8 8-11" />
    <path d="M20 13.5c0-4 2.5-7 6.5-7.5-.2 4-2.6 7-6.5 7.5Z" fill="currentColor" fillOpacity=".18" />
    <path d="M20 13.5c-.8-2.6-3-4.3-5.8-4.4.2 2.7 2.4 4.6 5.8 4.4Z" fill="currentColor" fillOpacity=".12" />
  </svg>
);

/** A curled-up cat with a few z's: the bot is resting. */
export const SleepingCat = (p: P) => (
  <svg viewBox="0 0 120 80" width="120" height="80" {...base} strokeWidth={1.5} {...p}>
    <path d="M20 66c-6-1-9-7-6-13 4-9 17-15 33-15 18 0 34 6 38 17 2 6-1 11-7 12" />
    <path d="M20 66h58" />
    <path d="M78 67c6 1 15 0 18-4 3-3 1-8-3-8-3 0-4 3-2 4" />
    <path d="M30 47c-2-6-1-12 2-15l4 7" />
    <path d="M36 39c3-2 7-2 10 0l3-6c3 3 4 8 2 13" />
    <path d="M33 50c1.5 1 3 1 4.5 0M42 50c1.5 1 3 1 4.5 0" />
    <path d="M39 55c.6.5 1.4.5 2 0" />
    <path d="M26 58c3 3 8 4 12 3" opacity=".6" />
    <path d="M60 22h7l-7 8h7" strokeWidth={1.3} opacity=".7" />
    <path d="M72 10h5l-5 6h5" strokeWidth={1.2} opacity=".5" />
    <path d="M81 2h3.5l-3.5 4h3.5" strokeWidth={1.1} opacity=".35" />
  </svg>
);

/** The same cat, awake and alert, watching the market. */
export const WatchingCat = (p: P) => (
  <svg viewBox="0 0 120 80" width="120" height="80" {...base} strokeWidth={1.5} {...p}>
    <path d="M44 72c-6-8-6-20 0-28" />
    <path d="M70 72c6-8 6-20 0-28" />
    <path d="M44 44c-3-7-2-15 1-20l7 9c4-1 7-1 10 0l7-9c3 5 4 13 1 20" />
    <circle cx="51.5" cy="40" r="1.6" fill="currentColor" />
    <circle cx="62.5" cy="40" r="1.6" fill="currentColor" />
    <path d="M55.5 45.5c.8.7 2.2.7 3 0" />
    <path d="M40 72h34" />
    <path d="M70 70c8 2 16-2 18-9" />
    <path d="M86 26l6-6 5 4 7-9" strokeWidth={1.3} opacity=".55" />
  </svg>
);

/** A steaming cup: nothing here yet, have some tea. */
export const SteamingCup = (p: P) => (
  <svg viewBox="0 0 120 100" width="120" height="100" {...base} strokeWidth={1.5} {...p}>
    <path d="M28 46h54v14c0 15-12 27-27 27S28 75 28 60z" />
    <path d="M82 52c8-1 13 3 13 9s-6 10-14 9" />
    <path d="M18 90h76" />
    <path d="M46 36c-4-5 4-8 0-13s3-8 0-12" opacity=".55">
      <animate attributeName="opacity" values=".2;.6;.2" dur="4s" repeatCount="indefinite" />
    </path>
    <path d="M58 36c-4-5 4-8 0-13s3-8 0-12" opacity=".4">
      <animate attributeName="opacity" values=".55;.15;.55" dur="4s" repeatCount="indefinite" />
    </path>
    <path d="M68 38c-3-4 3-6 0-10" opacity=".35">
      <animate attributeName="opacity" values=".15;.5;.15" dur="3.4s" repeatCount="indefinite" />
    </path>
    <path d="M36 62c2 6 6 10 12 12" opacity=".4" />
  </svg>
);

/** Lamp + book: shown on the login screen. */
export const ReadingLamp = (p: P) => (
  <svg viewBox="0 0 120 90" width="120" height="90" {...base} strokeWidth={1.5} {...p}>
    <path d="M30 80h60" />
    <path d="M38 80V66M38 66l20-26" />
    <path d="M48 36l18-12 10 14-20 10z" />
    <path d="M68 46c4 6 10 10 18 11" opacity=".35" strokeDasharray="2 4" />
    <path d="M62 50c2 8 8 14 16 16" opacity=".25" strokeDasharray="2 4" />
    <path d="M70 80c0-6 4-9 10-9s9 3 12 0v9" />
    <path d="M80 71v9" />
  </svg>
);
