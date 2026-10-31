// Every picture in pulse is a named slot: a file src/assets/art/<slot>.webp (made from the generated PNGs by
// tools/art_import.mjs). <slot>-dark.webp, when present, replaces the slot in the dark theme. Without a file the slot
// shows a painted SVG placeholder. ART.md has one ChatGPT prompt per slot; keep it in sync with this list.
export interface SlotDef {
  /** File name without extension. */
  slot: string;
  /** Pixel size to generate, as the prompt in ART.md asks for. */
  w: number;
  h: number;
  /** What it shows; also the placeholder's theme hint. */
  scene: string;
  /** Where it is used. */
  use: string;
}

export const SLOTS: SlotDef[] = [
  // Dashboard hero: follows the clock (morning 5-11, day 11-17, evening 17-21, night otherwise).
  { slot: 'hero-morning', w: 1600, h: 600, scene: 'sunrise over a misty valley with a kettle steaming on a windowsill', use: 'dashboard hero, morning' },
  { slot: 'hero-day', w: 1600, h: 600, scene: 'sunny desk by a window with plants, a notebook and a mug', use: 'dashboard hero, daytime' },
  { slot: 'hero-evening', w: 1600, h: 600, scene: 'golden hour over rooftops with a lamp being switched on', use: 'dashboard hero, evening' },
  { slot: 'hero-night', w: 1600, h: 600, scene: 'rainy night window with a lit lamp and an open book', use: 'dashboard hero, night' },
  // Page banners
  { slot: 'banner-board', w: 1600, h: 400, scene: 'a wall of pinned paper cards and washi tape', use: 'board page banner' },
  { slot: 'banner-notes', w: 1600, h: 400, scene: 'a stack of books, a fountain pen and a candle', use: 'notes page banner' },
  // Board column headers
  { slot: 'column-todo', w: 600, h: 300, scene: 'a seed packet and a watering can', use: 'To do column header' },
  { slot: 'column-doing', w: 600, h: 300, scene: 'a seedling pushing through soil', use: 'In progress column header' },
  { slot: 'column-done', w: 600, h: 300, scene: 'a full fruit bowl on a table', use: 'Done column header' },
  // Empty states
  { slot: 'empty-board', w: 800, h: 600, scene: 'an empty wooden shelf with a single plant', use: 'empty board' },
  { slot: 'empty-column', w: 600, h: 400, scene: 'a small pebble and a feather on a clean cloth', use: 'empty column' },
  { slot: 'empty-notes', w: 800, h: 600, scene: 'a blank notebook with a pencil and a cup of tea', use: 'no notes yet' },
  { slot: 'empty-today', w: 800, h: 600, scene: 'a hammock between two trees on a quiet afternoon', use: 'nothing due today' },
  { slot: 'empty-search', w: 800, h: 600, scene: 'a magnifying glass over an empty teacup', use: 'search with no results' },
  // Dashboard cards
  { slot: 'card-today', w: 600, h: 400, scene: 'a sun-warmed windowsill with a small clock', use: 'Today card' },
  { slot: 'card-overdue', w: 600, h: 400, scene: 'a gentle autumn rain on a bicycle leaning on a wall', use: 'Overdue card' },
  { slot: 'card-upcoming', w: 600, h: 400, scene: 'a winding path toward distant hills', use: 'Coming up card' },
  { slot: 'card-notes', w: 600, h: 400, scene: 'pages and a pressed flower in a book', use: 'Recent notes card' },
  // Note covers (picked per note in the editor)
  { slot: 'cover-rain-window', w: 1200, h: 800, scene: 'rain on a window with a blurred city and a warm lamp', use: 'note cover' },
  { slot: 'cover-tea', w: 1200, h: 800, scene: 'a teapot, two cups and steam on a wooden tray', use: 'note cover' },
  { slot: 'cover-plants', w: 1200, h: 800, scene: 'a shelf crowded with potted plants in sunlight', use: 'note cover' },
  { slot: 'cover-books', w: 1200, h: 800, scene: 'a leaning tower of old books with a reading lamp', use: 'note cover' },
  { slot: 'cover-meadow', w: 1200, h: 800, scene: 'a wildflower meadow in summer with soft clouds', use: 'note cover' },
  { slot: 'cover-autumn', w: 1200, h: 800, scene: 'a forest path covered in orange leaves', use: 'note cover' },
  { slot: 'cover-snow', w: 1200, h: 800, scene: 'a snowy cabin with a lit window at dusk', use: 'note cover' },
  { slot: 'cover-bread', w: 1200, h: 800, scene: 'fresh bread, butter and a jar of jam on a linen cloth', use: 'note cover' },
  { slot: 'cover-hills', w: 1200, h: 800, scene: 'layered blue hills at sunrise with a lone tree', use: 'note cover' },
  { slot: 'cover-shapes', w: 1200, h: 800, scene: 'abstract overlapping paper shapes in warm colours', use: 'note cover' },
  { slot: 'cover-fox', w: 1200, h: 800, scene: 'a fox curled up asleep in autumn leaves', use: 'note cover' },
  { slot: 'cover-owl', w: 1200, h: 800, scene: 'an owl on a branch under a crescent moon', use: 'note cover' },
  // Loading / errors / login / icon
  { slot: 'loading', w: 600, h: 600, scene: 'a kettle on a stove with a curl of steam', use: 'loading screen' },
  { slot: 'notfound', w: 800, h: 600, scene: 'a lantern on a foggy path with a signpost', use: '404 page' },
  { slot: 'login', w: 1200, h: 900, scene: 'a front door with a lantern, a doormat and a potted fern', use: 'login page' },
  { slot: 'icon', w: 512, h: 512, scene: 'a soft rounded heartbeat line glowing like a candle flame', use: 'favicon and app icon' },
];

/** The covers a note can pick, in the order the editor shows them. */
export const COVERS = SLOTS.filter((s) => s.slot.startsWith('cover-')).map((s) => s.slot);

export const slotDef = (slot: string) => SLOTS.find((s) => s.slot === slot);
