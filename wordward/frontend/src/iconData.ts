// Wordward's icon set: small line drawings on a 24×24 grid, drawn like brass-and-ink engravings. Every icon is the
// inner markup of an <svg viewBox="0 0 24 24">; the <Icon> component in icons.tsx wraps it. Conventions:
//   - plain shapes are stroked in currentColor (fill none, round caps and joins, width from CSS);
//   - class "f" = a soft wash fill, var(--icon-fill) (none unless the context sets it, e.g. gold on stars);
//   - class "s" = solid currentColor (eyes, pips, dots), no stroke.
// No emoji anywhere: these replace them so the UI looks the same on every platform.

/** A fuzzy circle (soot sprite fur): `n` little bumps around (cx, cy). */
function fuzz(cx: number, cy: number, r: number, n: number, depth: number) {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) d += `M${x.toFixed(2)} ${y.toFixed(2)}`;
    else {
      const m = a - Math.PI / n;
      const qx = cx + Math.cos(m) * (r + depth);
      const qy = cy + Math.sin(m) * (r + depth);
      d += `Q${qx.toFixed(2)} ${qy.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
  }
  return d + 'z';
}

const STAR = 'M12 2.9l2.75 5.6 6.15.9-4.45 4.35 1.05 6.1L12 16.95 6.5 19.85l1.05-6.1L3.1 9.4l6.15-.9z';
const HEART = 'M12 20.2l-1.3-1.15C6 14.9 3.2 12.3 3.2 9.1 3.2 6.5 5.2 4.5 7.8 4.5c1.5 0 3 .7 4.2 1.9 1.2-1.2 2.7-1.9 4.2-1.9 2.6 0 4.6 2 4.6 4.6 0 3.2-2.8 5.8-7.5 9.95z';
const OPEN_BOOK = '<path class="f" d="M12 6.5C10 5 7 4.5 3.5 5v13.5c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5z"/><path d="M12 6.5V20"/>';
const BUBBLE = 'M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-8l-4.5 3.5V16H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5z';
const CASTLE =
  '<path class="f" d="M4 20.5V9.5h3v2h2.5v-2h5v2H17v-2h3v11z"/><path d="M10 20.5v-3.5a2 2 0 0 1 4 0v3.5M12 9.5V3.5l3.5 1.2L12 6"/><path d="M6.5 14.5v1.5M17.5 14.5v1.5"/>';
const BOOT = 'M8.5 3.5h5v8.5l5.3 2.4a2.2 2.2 0 0 1 1.2 2v3.1H7.5z';
const DRAGON =
  '<path d="M8 7.2C7.1 4.6 5.2 3.1 3 3c1.4 1.6 2 3.6 2.4 6M16 7.2c.9-2.6 2.8-4.1 5-4.2-1.4 1.6-2 3.6-2.4 6M5.6 12.6 2.8 14.4l3.6.9M18.4 12.6l2.8 1.8-3.6.9"/><path class="f" d="M7 7.6C5.5 9 5 11 5.5 13L8 18.6c1 2 7 2 8 0l2.5-5.6c.5-2 0-4-1.5-5.4-2-1.3-8-1.3-10 0z"/><path class="s" d="M7.9 10.6l3.3 1.6-2.4.7zM16.1 10.6l-3.3 1.6 2.4.7z"/><circle class="s" cx="10.6" cy="17.2" r=".75"/><circle class="s" cx="13.4" cy="17.2" r=".75"/>';

const SPEAKER = '<path class="f" d="M3.8 9.3h3.6L12 5.4v13.2l-4.6-3.9H3.8z"/>';
const MUSIC = '<path d="M9 17.5V6l10-2.3v11.5M9 9.8l10-2.3"/><ellipse class="f" cx="6.8" cy="17.6" rx="2.4" ry="2"/><ellipse class="f" cx="16.8" cy="15.3" rx="2.4" ry="2"/>';

export const ICON_DATA = {
  // ---- interface ----
  speaker: `${SPEAKER}<path d="M15.5 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/>`,
  speakerOff: `${SPEAKER}<path d="M15.6 9.6l4.8 4.8M20.4 9.6l-4.8 4.8"/>`,
  musicOff: `${MUSIC}<path d="M3.5 3.5l17 17"/>`,
  star: `<path class="f" d="${STAR}"/>`,
  lock: '<path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/><rect class="f" x="4.8" y="10.5" width="14.4" height="10" rx="2.2"/><circle class="s" cx="12" cy="14.6" r="1.35"/><path d="M12 15.2v2.4"/>',
  memory:
    '<path class="f" d="M12 5.2C11 3.6 8.4 3.4 7.2 4.9 5.4 4.8 4 6.3 4.4 8.1 3 8.9 2.7 10.9 3.8 12.1c-.9 1.3-.3 3.3 1.3 3.8.1 1.8 2 2.9 3.6 2.2.9 1.3 2.6 1.4 3.3.4z"/><path class="f" d="M12 5.2c1-1.6 3.6-1.8 4.8-.3 1.8-.1 3.2 1.4 2.8 3.2 1.4.8 1.7 2.8.6 4-.9 1.3.3 3.3-1.3 3.8-.1 1.8-2 2.9-3.6 2.2-.9 1.3-2.6 1.4-3.3.4"/><path d="M12 5.2v13.3M8.2 8.2c.8.3 1.3 1 1.3 1.9M6.5 12.5c1 0 1.8.6 2 1.5M15.8 8.2c-.8.3-1.3 1-1.3 1.9M17.5 12.5c-1 0-1.8.6-2 1.5"/>',
  reverse: '<path d="M4 8.5h14.5M15 5l3.5 3.5L15 12M20 15.5H5.5M9 12l-3.5 3.5L9 19"/>',
  speed: '<path class="f" d="M13.5 2.5 5 13.5h6l-1.5 8 8.5-11h-6z"/>',
  perfect: '<circle class="f" cx="12" cy="12" r="8.8"/><circle cx="12" cy="12" r="5.3"/><circle class="s" cx="12" cy="12" r="1.9"/>',
  shield:
    '<circle class="f" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/><path d="M12 9.6l1.8 2.4-1.8 2.4-1.8-2.4z"/>',
  map: '<path class="f" d="M3.5 6.5 9 4.5l6 2 5.5-2v13l-5.5 2-6-2-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
  infinity: '<path d="M12 12c-2-2.6-3.6-4-5.5-4a4 4 0 0 0 0 8c1.9 0 3.5-1.4 5.5-4zm0 0c2 2.6 3.6 4 5.5 4a4 4 0 0 0 0-8c-1.9 0-3.5 1.4-5.5 4z"/>',
  cookie:
    '<path class="f" d="M20.5 12.6A8.5 8.5 0 1 1 11.4 3.5a3 3 0 0 0 3.6 3.6 3 3 0 0 0 5.5 5.5z"/><circle class="s" cx="8.5" cy="9.5" r="1.1"/><circle class="s" cx="9" cy="15" r="1.1"/><circle class="s" cx="14" cy="13.5" r="1.1"/><circle class="s" cx="15.5" cy="17.5" r=".9"/>',
  cloud: '<path class="f" d="M7 18.5h10.5a4 4 0 0 0 .6-8 6 6 0 0 0-11.6-1.4A4.6 4.6 0 0 0 7 18.5z"/>',
  user: '<circle class="f" cx="12" cy="8.3" r="3.8"/><path class="f" d="M4.5 20.5c.8-4 3.8-6 7.5-6s6.7 2 7.5 6z"/>',
  keyboard:
    '<rect class="f" x="2.5" y="6" width="19" height="12" rx="2.2"/><path d="M6.3 9.7h.01M9.4 9.7h.01M12.5 9.7h.01M15.6 9.7h.01M17.7 9.7h.01M6.3 12.2h.01M9.4 12.2h.01M12.5 12.2h.01M15.6 12.2h.01M17.7 12.2h.01M8.5 14.8h7"/>',
  enter: '<path d="M19 5v6.5a3 3 0 0 1-3 3H5.5M9.5 10.5l-4 4 4 4"/>',
  back: '<path d="M19.5 12h-15M10.5 6l-6 6 6 6"/>',
  next: '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  pause: '<rect class="s" x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect class="s" x="13.9" y="5" width="3.6" height="14" rx="1.2"/>',
  heart: `<path class="f" d="${HEART}"/>`,
  book: OPEN_BOOK,
  review: '<path d="M19.4 9.5A7.9 7.9 0 0 0 5.2 7.8M4.6 3.8v4.6h4.6M4.6 14.5a7.9 7.9 0 0 0 14.2 1.7M19.4 20.2v-4.6h-4.6"/>',
  dragon: DRAGON,
  alert: '<path class="f" d="M12 3.5 21.3 19.8H2.7z"/><path d="M12 9.5v4.5"/><circle class="s" cx="12" cy="16.8" r="1.1"/>',
  hourglass: '<path d="M6.5 3.5h11M6.5 20.5h11"/><path class="f" d="M8 3.5c0 4 8 4.5 8 8.5s-8 4.5-8 8.5h8c0-4-8-4.5-8-8.5s8-4.5 8-8.5z"/>',
  owl:
    '<path class="f" d="M6 7.5 5 3.5 8.5 6h7L19 3.5l-1 4c1.3 1.5 2 3.5 2 6 0 4.5-3.5 7-8 7s-8-2.5-8-7c0-2.5.7-4.5 2-6z"/><circle cx="9" cy="11" r="2.4"/><circle cx="15" cy="11" r="2.4"/><circle class="s" cx="9" cy="11" r="1"/><circle class="s" cx="15" cy="11" r="1"/><path d="M11 14.4l1 1.4 1-1.4z"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2"/><path class="f" d="M6.5 6.5l1 13.5h9l1-13.5"/><path d="M10 10v6.5M14 10v6.5"/>',
  key: '<circle class="f" cx="7.8" cy="12" r="4.2"/><circle class="s" cx="6.6" cy="12" r="1"/><path d="M12 12h8.5v3.2M17.2 12v2.4"/>',
  sparkle: '<path class="f" d="M11 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z"/><path class="f" d="M18 14.5c.3 2 1 2.7 3 3-2 .3-2.7 1-3 3-.3-2-1-2.7-3-3 2-.3 2.7-1 3-3z"/>',
  eye: '<path class="f" d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3.2"/><circle class="s" cx="12" cy="12" r="1.3"/>',
  quill:
    '<path class="f" d="M20 3.5c-6.5.3-11.5 4.4-13 12.2 6.6-1.2 11-5.6 13-12.2z"/><path d="M7 15.7 3.5 20.5M10.5 11.5l3.5.3M9 13.8l3 .2"/>',
  // ---- chapters ----
  village: '<path class="f" d="M5.5 10v10.5h13V10L12 4.5z"/><path d="M3.5 11.5 12 4.5l8.5 7M10 20.5v-5h4v5M15.5 7V4h2v4.5"/>',
  forest: '<path class="f" d="M12 3 6.5 10h3l-4 5.5h13l-4-5.5h3z"/><path d="M12 15.5V21M9 21h6"/>',
  home:
    '<path class="f" d="M5 9h14v11.5H5z"/><path d="M3.5 9h17V6.5h-17zM3.5 20.5h17M8.5 20.5v-5.5a3.5 3.5 0 0 1 7 0v5.5"/><path d="M12 19.5c-1.3 0-2-.8-2-1.8 0-1.2 1.2-1.6 1.5-3 .9.6 2.5 1.6 2.5 3 0 1-.7 1.8-2 1.8z"/>',
  town: '<path class="f" d="M8 20.5V8l4-4.5L16 8v12.5z"/><path d="M4.5 20.5h15M5 20.5v-7h3M16 13.5h3v7M11 20.5v-3a1 1 0 0 1 2 0v3"/><circle cx="12" cy="10.5" r="1.7"/>',
  school: '<path class="f" d="M5.5 5.5a2 2 0 0 1 2-2h11v14h-11a2 2 0 0 0-2 2z"/><path d="M5.5 19.5a2 2 0 0 0 2 2h11v-4M10 3.5v6l1.75-1.3 1.75 1.3v-6"/>',
  fair: '<path class="f" d="M3.5 12 12 5.5l8.5 6.5v8.5h-17z"/><path d="M3.5 12h17M12 5.5V2.5l3 1-3 1M12 12l-3 8.5h6zM7.5 12c0 1.2-1 2-2 2M16.5 12c0 1.2 1 2 2 2"/>',
  mountains: '<path class="f" d="M2.5 19.5 9 8.5l3.5 5.5 2.5-4 6.5 9.5z"/><path d="M6.9 12l2.1 1.4 1.6-2.2"/>',
  citadel: CASTLE,
  // ---- missions ----
  hello: `<path class="f" d="${BUBBLE}"/><path d="M8.2 10.3h.01M12 10.3h.01M15.8 10.3h.01"/>`,
  dice: '<rect class="f" x="4" y="4" width="16" height="16" rx="3.2"/><circle class="s" cx="8.4" cy="8.4" r="1.3"/><circle class="s" cx="15.6" cy="8.4" r="1.3"/><circle class="s" cx="12" cy="12" r="1.3"/><circle class="s" cx="8.4" cy="15.6" r="1.3"/><circle class="s" cx="15.6" cy="15.6" r="1.3"/>',
  family:
    '<circle class="f" cx="9" cy="7.5" r="2.8"/><path class="f" d="M3.5 20c.4-4 2.6-6 5.5-6s5.1 2 5.5 6z"/><circle class="f" cx="17" cy="11.2" r="2"/><path class="f" d="M13.9 20c.3-2.6 1.5-4 3.1-4s2.8 1.4 3.1 4"/>',
  apple:
    '<path class="f" d="M12 7.6c-2-1.3-6.5-1-6.5 4.5 0 4 2.5 8 4.5 8 1 0 1.3-.5 2-.5s1 .5 2 .5c2 0 4.5-4 4.5-8 0-5.5-4.5-5.8-6.5-4.5z"/><path d="M12 7.6c0-1.9.7-3.2 1.8-3.9"/><path class="f" d="M13 5.6c1.4-1.9 3.4-2 4.6-1.2-1 1.7-3 2.1-4.6 1.2z"/>',
  paw: '<path class="f" d="M12 12.5c-3 0-5.5 3-5.5 5.2 0 1.6 1.4 2.4 2.8 2.1 1.1-.3 1.8-.7 2.7-.7s1.6.4 2.7.7c1.4.3 2.8-.5 2.8-2.1 0-2.2-2.5-5.2-5.5-5.2z"/><ellipse class="f" cx="5.3" cy="10.8" rx="1.8" ry="2.3"/><ellipse class="f" cx="9.2" cy="6.6" rx="1.9" ry="2.5"/><ellipse class="f" cx="14.8" cy="6.6" rx="1.9" ry="2.5"/><ellipse class="f" cx="18.7" cy="10.8" rx="1.8" ry="2.3"/>',
  flower:
    '<path d="M12 13.5V21M12 18c-2.2-.2-3.6-1.5-4-3.5 2.2.1 3.6 1.4 4 3.5z"/><g class="f"><circle cx="12" cy="5.6" r="2.5"/><circle cx="15.8" cy="8.4" r="2.5"/><circle cx="14.3" cy="12.6" r="2.5"/><circle cx="9.7" cy="12.6" r="2.5"/><circle cx="8.2" cy="8.4" r="2.5"/></g><circle class="s" cx="12" cy="9.5" r="1.7"/>',
  weather:
    '<path d="M5.4 12.6A4 4 0 1 1 12.6 8.6M9 2.5v1.6M2.6 9h1.6M4.5 4.5l1.1 1.1M13.5 4.5l-1.1 1.1"/><path class="f" d="M9 19.5h9.2a3.4 3.4 0 0 0 .3-6.8 5 5 0 0 0-9.6 1.1A2.9 2.9 0 0 0 9 19.5z"/>',
  sentence: `<path class="f" d="${BUBBLE}"/><path d="M7.5 8.8h9M7.5 11.8h6"/>`,
  fox: '<path class="f" d="M4.5 3.8 9 7.5h6l4.5-3.7-.6 7.2L12 20l-6.9-9z"/><path d="M5.6 11.5 9.5 13l2.5 7 2.5-7 3.9-1.5"/><circle class="s" cx="9.3" cy="10.6" r="1"/><circle class="s" cx="14.7" cy="10.6" r="1"/><circle class="s" cx="12" cy="17.6" r="1.1"/>',
  sofa: '<path d="M4.5 11.5V8.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3M5.5 17.5v2M18.5 17.5v2"/><path class="f" d="M3 12a1.5 1.5 0 0 1 3 0v2h12v-2a1.5 1.5 0 0 1 3 0v5.5H3z"/>',
  shirt: '<path class="f" d="M8.5 3.5 4 6l1.5 4.5 2.5-1v11h8v-11l2.5 1L20 6l-4.5-2.5c-.5 1.5-1.8 2.5-3.5 2.5s-3-1-3.5-2.5z"/>',
  body: '<circle class="f" cx="12" cy="5" r="2.3"/><path d="M12 8v6.5M5.5 8.8l6.5 2 6.5-2M8.5 21l3.5-6.5 3.5 6.5"/>',
  clock: '<circle class="f" cx="12" cy="12" r="8.6"/><path d="M12 7v5l3.2 2.2M12 4.6v.01M19.4 12h.01M12 19.4v.01M4.6 12h.01"/>',
  pot: '<path class="f" d="M5 10h14v6.5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z"/><path d="M3 10h18M10 4.5c-.8 1 .8 1.5 0 2.8M14 4.5c-.8 1 .8 1.5 0 2.8"/>',
  hall: '<path class="f" d="M3.5 9 12 4l8.5 5z"/><path d="M4.5 20.5h15M4 9h16M6.5 9v9.5M10.5 9v9.5M13.5 9v9.5M17.5 9v9.5M5 18.5h14"/>',
  signpost: '<path d="M12 3v18M9 21h6"/><path class="f" d="M12 5.5h6.5l2 2-2 2H12zM12 11.5H5.5l-2 2 2 2H12z"/>',
  basket: '<path class="f" d="M3.5 10h17l-2 9.5h-13z"/><path d="M8 10l3-5.5M16 10l-3-5.5M9 13v3.5M12 13v3.5M15 13v3.5"/>',
  talk: '<path class="f" d="M3 4.5h11v7H8.2L5 14v-2.5H3z"/><path class="f" d="M16.5 8.5H21v8h-2V19l-3-2.5h-5.5v-3.2"/>',
  abacus:
    '<rect class="f" x="4" y="3.5" width="16" height="17" rx="1.5"/><path d="M4 8h16M4 12.5h16M4 17h16"/><g class="s"><circle cx="7.6" cy="8" r="1.4"/><circle cx="10.6" cy="8" r="1.4"/><circle cx="16.4" cy="8" r="1.4"/><circle cx="7.6" cy="12.5" r="1.4"/><circle cx="13.4" cy="12.5" r="1.4"/><circle cx="16.4" cy="12.5" r="1.4"/><circle cx="10.6" cy="17" r="1.4"/><circle cx="13.4" cy="17" r="1.4"/></g>',
  satchel: '<path class="f" d="M5.5 9a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M9.5 7V5a2.5 2.5 0 0 1 5 0v2M5.5 12.5h13M12 12.5v2.2"/>',
  run: `<path class="f" d="${BOOT}"/><path d="M7.5 17h12.5M2.5 9.5h3.5M2 13h4"/>`,
  adjectives: '<path class="f" d="M11 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z"/><path class="f" d="M18 14.5c.3 2 1 2.7 3 3-2 .3-2.7 1-3 3-.3-2-1-2.7-3-3 2-.3 2.7-1 3-3z"/>',
  briefcase: '<rect class="f" x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3.5 12.5h17M11 12.5v1.8h2v-1.8"/>',
  chain: '<rect x="2.6" y="8.6" width="11" height="6.8" rx="3.4" transform="rotate(-35 8.1 12)"/><rect x="10.4" y="8.6" width="11" height="6.8" rx="3.4" transform="rotate(-35 15.9 12)"/>',
  ball: '<circle class="f" cx="12" cy="12" r="8.6"/><path class="s" d="M12 9l2.85 2.07-1.09 3.36h-3.52l-1.09-3.36z"/><path d="M12 9V3.5M14.85 11.07l5-1.8M13.76 14.43l2.9 4.4M10.24 14.43l-2.9 4.4M9.15 11.07l-5-1.8"/>',
  music: MUSIC,
  gift: '<path class="f" d="M5.5 13v7.5h13V13M4 9.5h16V13H4z"/><path d="M12 9.5v11M12 9.5c-1.4-3.3-5.5-4-5.5-1.6 0 1.4 2.9 1.6 5.5 1.6zm0 0c1.4-3.3 5.5-4 5.5-1.6 0 1.4-2.9 1.6-5.5 1.6z"/>',
  soul: `<path class="f" d="${HEART}"/><path d="M8 9.2c.2-1 .9-1.7 1.9-1.9"/>`,
  laptop: '<rect class="f" x="5" y="5" width="14" height="10" rx="1.2"/><path d="M3 18.5h18l-1.5-3.5h-15zM10.5 16.8h3"/>',
  flask: '<path d="M9.5 3.5h5"/><path class="f" d="M10.5 3.5v6l-5.4 9a1.5 1.5 0 0 0 1.3 2.3h11.2a1.5 1.5 0 0 0 1.3-2.3l-5.4-9v-6z"/><path d="M7.3 15h9.4M11 17.8h.01M14 12.8h.01"/>',
  castle: CASTLE,
  scroll:
    '<path class="f" d="M7.5 4.5H18a2 2 0 0 1 0 4h-1v9.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1 0-4h1V6.5a2 2 0 0 1 1-2z"/><path d="M18 8.5h-1M9.5 9h4.5M9.5 12h4.5M5.5 16h9a2 2 0 0 1 0 4"/>',
  wingboot: `<path class="f" d="${BOOT}"/><path d="M7.5 17h12.5"/><path class="f" d="M13.5 7c1.8-2.4 4.8-3.5 7.5-3-1 1.7-2.8 2.7-4.8 3 1.5.3 2.9.1 4-.4-1 1.8-3.4 2.5-6.7 2.4"/>`,
  mask: '<path class="f" d="M5 4.5c4 1.5 10 1.5 14 0v7c0 4.5-3 8.5-7 8.5s-7-4-7-8.5z"/><path d="M8.3 10c.6-.6 1.6-.6 2.2 0M13.5 10c.6-.6 1.6-.6 2.2 0M9 14c1.8 1.6 4.2 1.6 6 0"/>',
  globe:
    '<circle class="f" cx="12" cy="10" r="6.2"/><path d="M5.8 10h12.4M12 3.8c-1.8 1.8-2.6 3.9-2.6 6.2s.8 4.4 2.6 6.2M12 3.8c1.8 1.8 2.6 3.9 2.6 6.2s-.8 4.4-2.6 6.2M4 13.5A8.6 8.6 0 0 0 19 16M12 18.6V21M8.5 21h7"/>',
  crown: '<path class="f" d="M3.5 8l4 4 4.5-7 4.5 7 4-4-1.5 10.5h-14z"/><path d="M5 20.5h14"/><circle class="s" cx="12" cy="14.2" r="1.2"/>',
  // ---- creatures (bestiary) ----
  moth:
    '<path class="f" d="M11.3 9.5C9 5 4.5 4.5 3.5 6.5s1.5 5 7.6 5.3zM12.7 9.5C15 5 19.5 4.5 20.5 6.5s-1.5 5-7.6 5.3zM11.2 13c-4 .4-6.5 2.5-5.5 4.4 1 1.8 4.3.6 5.6-3zM12.8 13c4 .4 6.5 2.5 5.5 4.4-1 1.8-4.3.6-5.6-3z"/><ellipse class="s" cx="12" cy="13.2" rx="1.25" ry="4.6"/><path d="M11.5 8.5C11 6.5 9.8 4.5 8.5 3.8M12.5 8.5c.5-2 1.7-4 3-4.7"/>',
  soot: `<path class="f" d="${fuzz(12, 13, 7.2, 18, 1.6)}"/><circle class="s" cx="9.6" cy="12.4" r="1.4"/><circle class="s" cx="14.4" cy="12.4" r="1.4"/><path d="M8 21v-1.2M16 21v-1.2"/>`,
  snail:
    '<path class="f" d="M3 19h14.5c1.6 0 2.5-1 2.5-2.5V9.5"/><path d="M20 9.5l1.4-3.2M20 9.5l-1.6-3"/><circle class="f" cx="10.5" cy="13" r="5.6"/><path d="M10.5 13.4a1.4 1.4 0 1 1 1.4 1.4 2.9 2.9 0 0 1-2.9-2.9 4.2 4.2 0 0 1 4.2-4.2"/>',
  tome: '<path class="f" d="M5.5 5a2 2 0 0 1 2-2h11v14.5h-11a2 2 0 0 0-2 2z"/><path d="M5.5 19.5a2 2 0 0 0 2 2h11V17.5M9.5 21.5v1M15 21.5v1"/><circle class="s" cx="10" cy="9.5" r="1.1"/><circle class="s" cx="14.5" cy="9.5" r="1.1"/><path d="M10.5 12.6c1 .8 2.5.8 3.5 0"/>',
  ink: '<path class="f" d="M12 3.2c3 4 6 7 6 10.6a6 6 0 0 1-12 0c0-3.6 3-6.6 6-10.6z"/><circle class="s" cx="9.8" cy="14" r="1.1"/><circle class="s" cx="14.2" cy="14" r="1.1"/><path d="M15.6 9.8c.7.8 1.1 1.7 1.2 2.6"/>',
} as const;

export type IconName = keyof typeof ICON_DATA;
