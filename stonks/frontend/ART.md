# Stonks artwork

Every picture on the site is a named slot. Most of the wide ones are temporary crops of the desk-at-dusk painting; the
others are simply left out until their file exists (coins, section pictures, Health pictures). To replace them:

1. Generate an image, save it as `<slot>.png` in one folder.
2. Run `python tools/art_import.py <folder>` in `stonks/frontend`. It resizes and writes `src/assets/art/<slot>.webp`.
3. Commit. No code changes needed.

## Style block

Attach the current painting (`src/assets/art/hero-dusk.webp`, or a screenshot of the Overview) to the chat and start with:

> You are painting a set of matching illustrations for a cozy home stock-trading desk. Match the attached painting
> exactly: soft gouache and watercolor look with visible paper grain, warm muted palette of cream, ink navy, aged brass,
> sage green and terracotta, gentle lamplight, the same white cat with grey-striped tail. Subjects: a wooden desk, brass
> desk lamp, olive branches, speckled ceramic cups, old books, and small candlestick charts glowing on screens. Calm and
> quiet, never busy. No readable text, numbers, logos or brand names anywhere; chart candles are shapes only. Candles are
> sage green and terracotta. No people.

## Wide scenes: 1536x1024

The site crops these to a wide strip. Keep everything important in the middle 50% of the height. On scenes marked
"left empty" the left 40% must be plain wall in one flat tone, because text sits there.

| Slot | Prompt |
| --- | --- |
| `hero-morning` | Left empty. The same desk and arched window as the attached painting at early morning: pale gold sunrise over the hills and lake, soft mist, the cat just waking and stretching, steam from a fresh cup, lamp off. Cream wall. |
| `hero-day` | Left empty. The same desk and window in bright afternoon: blue sky, sunlit hills, a sunbeam across the desk, the cat sitting upright watching the tablet's candles, cup half full. Cream wall. |
| `hero-night` | Left empty. The same desk and window deep at night: stars over the dark hills, tiny village lights, only the brass lamp lit, the cat asleep in the lamplight. The wall is deep ink navy, nearly black at the far left. |
| `banner-trades` | Left empty. A brass stock-ticker machine on the wooden desk, its paper tape curling down beside an open ledger book with a fountain pen, a tablet of candles behind, a cup of tea. |
| `banner-logs` | Left empty. An open leather diary on the desk with a brass bookmark and a pencil, lit by the lamp, the cat's paw resting on the page, a small candle in a holder. Handwriting shown only as soft unreadable squiggles. |
| `banner-health` | Left empty. The white cat wearing a tiny stethoscope, listening to an old brass machine with small gauges and glowing dials on the desk. Gauge faces have no numbers. |
| `banner-research` | Left empty. A cozy home laboratory desk: glass flasks with amber liquid, paper charts pinned to the wall, a brass magnifying glass over a printed candlestick chart, olive branch in a jar. |
| `banner-hall` | Left empty. A wooden shelf at dusk with three small brass trophies, framed miniature chart paintings, a ribbon, and the cat sitting proudly beside them. |
| `banner-notes` | Left empty. A stack of cream notepads and sharpened pencils in a ceramic cup, a sprig of olive, one page with soft unreadable sketches of chart lines. |
| `banner-settings` | Left empty. A panel of brass dials, knobs and a big toggle switch on a wooden console, warm lamplight, the cat's tail curling around it. |
| `spot-plan` | A close view of a tablet on the desk showing a calm rising candlestick chart with two smooth lines crossing it, a brass ruler and a cup at the edge. |
| `cover-how-the-bot-trades` | A small brass clockwork robot sitting at the desk beside the cat, gently placing coins on a tablet of candles. |
| `cover-twenty-nine-coins` | Twenty-nine brass coins laid out in neat rows on green felt, each stamped with a different simple shape, a magnifying glass over one. |
| `cover-will-the-winners-last` | An hourglass with golden sand on the desk beside a slim trophy, a wilting and a fresh olive sprig on each side, dusk light. |
| `modal-live` | A heavy brass safe door slightly open on the desk with warm light inside, the cat watching seriously. Feels careful, not scary. |
| `footer-ridge` | A wide layered landscape of hills at dusk whose ridgelines subtly rise and fall like a chart, tiny village lights, very simple, no foreground. Top half is plain sky fading to cream. |

## Tall: 1024x1536

| Slot | Prompt |
| --- | --- |
| `login-door` | A tall view of the room: an arched wooden door ajar with warm lamplight spilling out, inside the desk, window at dusk and the sleeping cat, a brass key in the lock. |

## Transparent background: 1024x1024

Ask for a **transparent background** with no ground shadow outside the subject.

| Slot | Prompt |
| --- | --- |
| `cat-asleep` | Keep the existing one unless you want it restyled. |
| `cat-awake` | The white cat sitting alert beside a small tablet of candles, ears up, one paw on the tablet, a small cup beside it. |
| `cat-trouble` | The white cat startled with wide eyes, a tangle of cable around one paw, a tablet showing a broken chart line, a wisp of smoke. Worried, not distressed. |
| `verdict-ok` | The white cat relaxed on a cushion, purring, with a small sage green check-shaped leaf sprig beside it. |
| `verdict-warn` | The white cat peering at a brass gauge with its needle leaning to the side, one eyebrow raised. |
| `verdict-fail` | The white cat wearing a small red firefighter hat, holding a tiny brass extinguisher near a smoking machine. |
| `verdict-unknown` | The white cat looking into a fogged glass orb, head tilted. |
| `empty-trades` | An open empty ledger with a pen resting across it, a cold cup, the cat asleep on the page. |
| `empty-logs` | A closed diary with a ribbon, a sleeping cat curled on top, a small unlit candle. |
| `empty-research` | Clean empty flasks on a wooden tray, the cat asleep beside them. |

## Small round pictures, transparent, 1024x1024

Simple single objects, centered, filling the frame. Shown at 56 px, so keep the shape bold.

| Slot | Prompt |
| --- | --- |
| `spot-strategy` | A brass compass lying on a folded chart. |
| `spot-orders` | A small brass bell with an order slip on a spike. |
| `spot-risk` | A brass shield with an olive branch across it. |
| `spot-fees` | A tiny stack of brass coins with a small tag tied on. |
| `spot-mode` | A two-position brass lever switch. |
| `spot-move` | Two brass balance pans with coins moving from one to the other. |
| `spot-history` | A rolled parchment tied with a ribbon. |

## Coins, transparent, 1024x1024

A round stamped brass coin seen straight on, filling the whole frame, soft painted shading.

| Slot | Prompt |
| --- | --- |
| `coin-btc` | Warm orange-gold coin with a bold letter B. |
| `coin-eth` | Cool silver-blue coin with a simple faceted diamond. |
| `coin-eur` | Sage green coin with a bold euro sign. |
| `coin-sol` | Purple-tinted coin with three slanted bars. |
