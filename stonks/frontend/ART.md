# Stonks artwork

Every picture on the site is a named slot. A slot with no file shows a placeholder with its name, or a fallback
(coins show their letters, cats and Health verdicts a simple mark, the hero the dusk painting). `footer-ridge` shows
nothing until it exists. `<slot>-dark` is an optional second file for the dark theme; without one, the dark theme shows
the light picture dimmed. The light theme only ever shows daylight pictures.

1. Generate an image, save it as `<slot>.png` in one folder.
2. Run `python tools/art_import.py <folder>` in `stonks/frontend`. It resizes and writes `src/assets/art/<slot>.webp`.
3. Commit. No code changes needed.

How the pictures are cropped:

- **Page banners:** the whole width sits on the right half of a strip about 4:1, the left half of the picture fades into
  the page, and only the middle 40% of the height shows.
- **Hero:** the right 55% shows, behind nothing; the left is covered by the words on a plain wall.
- **Covers:** 16:7 on cards, 21:8 on the article.
- **`spot-plan`:** a 96 px strip. **`modal-live`:** a 140 px strip. Only the middle shows.

## The prompt

Paste everything between the lines into ChatGPT, with `src/assets/art/hero-dusk.webp` attached (or a screenshot of the
Overview).

---

You are illustrating a matching set of 59 pictures for a private home trading dashboard called Stonks. Its world is one
cozy desk by an arched window. Match the attached painting exactly in style and subject.

**Style for every picture:** soft gouache and watercolor with visible paper grain, warm muted palette of cream, ink navy,
aged brass, sage green and terracotta. The same white cat with a grey-striped tail. Recurring things: a wooden desk, brass
desk lamp, olive branches, speckled ceramic cups, old books, small candlestick charts on screens. Calm and quiet, never
busy, generous empty space.

**Never:** readable text, letters, numbers, logos or brand names, except the shapes I name on coins. Chart candles are
shapes only, sage green and terracotta. No people. No frames, borders, captions or watermarks.

**How to work:** make the pictures one at a time, in the order below, at the size of each group. Above each picture write
its exact file name as a heading, so I can save it under that name. After each picture, go straight on to the next. If you
stop, I will say "next" and you continue from where you were. Keep the cat, the desk and the lamp consistent all the way
through.

### Group 1: daylight scenes, 1536x1024 (landscape), 18 pictures

These are for the light theme. Bright, airy, pale cream walls, soft daylight, no dark areas: the window shows a light sky,
never dusk or night.

Hero scenes: keep the left 45% as plain, flat, pale cream wall (#f4ede3) with nothing on it, because words sit there. The
desk, window and cat fill the right 55%.

1. `hero-morning`: the same desk and arched window as the attached painting at early morning. Pale gold sunrise over the hills and lake, soft mist, the cat just waking and stretching, steam from a fresh cup, lamp off.
2. `hero-day`: the same desk and window in bright afternoon. Blue sky, sunlit hills, a sunbeam across the desk, the cat sitting upright watching the tablet's candles, cup half full.

Banners: the subject sits in the right half and in the middle 40% of the height, because the rest is cropped away. The left
side is plain pale cream wall.

3. `banner-trades`: a brass stock-ticker machine on the desk, its paper tape curling down beside an open ledger and a fountain pen, a tablet of candles behind, a cup of tea.
4. `banner-logs`: an open leather diary with a brass bookmark and a pencil, the cat's paw resting on the page, a small candle in a holder. Handwriting as soft unreadable squiggles.
5. `banner-health`: the white cat wearing a tiny stethoscope, listening to an old brass machine with small gauges. Gauge faces have no numbers.
6. `banner-research`: a sunny home laboratory desk with glass flasks of amber liquid, paper charts pinned to the wall, a brass magnifying glass over a printed candlestick chart, olive branch in a jar.
7. `banner-hall`: a wooden shelf with three small brass trophies, framed miniature chart paintings, a ribbon, and the cat sitting proudly beside them.
8. `banner-notes`: a stack of cream notepads, sharpened pencils in a ceramic cup, a sprig of olive, one page with soft unreadable sketches of chart lines.
9. `banner-settings`: a panel of brass dials, knobs and a big toggle switch on a wooden console, the cat's tail curling around it.

Others: subject centered, filling the middle of the frame.

10. `spot-plan`: a close view of a tablet on the desk showing a calm rising candlestick chart with two smooth lines crossing it, a brass ruler and a cup at the edge.
11. `modal-live`: a heavy brass safe door slightly open on the desk with warm light inside, the cat watching seriously. Careful, not scary.
12. `footer-ridge`: a wide layered landscape of pale hills in daylight whose ridgelines subtly rise and fall like a chart, very simple, no foreground. The top half is plain sky fading to cream.

Article covers: each one tells its story with objects, subject centered.

13. `cover-how-the-bot-trades`: a small brass clockwork robot sitting at the desk beside the cat, gently placing coins on a tablet of candles.
14. `cover-twenty-nine-coins`: twenty-nine brass coins in neat rows on green felt, each stamped with a different simple shape, a magnifying glass over one.
15. `cover-will-the-winners-last`: an hourglass with golden sand beside a slim trophy, a wilting and a fresh olive sprig on either side.
16. `cover-the-seat-belt`: a brass seat-belt buckle fastened around a small tablet of candles on the desk, the cat watching, calm and safe.
17. `cover-does-the-world-know-this-trick`: a brass globe beside a tall stack of open old books, a magnifying glass, a printed chart tucked between the pages.
18. `cover-if-bitcoin-falls-and-ether-rises`: an old brass balance scale with one plain gold coin sinking and one plain silver coin rising, the cat's paw reaching up. Coins carry no symbols.

### Group 2: evening scenes, 1536x1024 (landscape), 10 pictures

These are the dark theme's versions. Same composition rules as Group 1, but the empty left side is deep ink navy wall
(#152036), and everything is lit only by the lamp and the dusk sky.

19. `hero-dusk`: a richer repaint of the attached painting: dusk over the hills and lake, the lamp lit, the cat asleep beside the tablet.
20. `hero-night`: the same desk and window deep at night. Stars over dark hills, tiny village lights, only the brass lamp lit, the cat asleep in the lamplight.
21. `banner-trades-dark`: picture 3 at night in lamplight.
22. `banner-logs-dark`: picture 4 at night in lamplight, the small candle lit.
23. `banner-health-dark`: picture 5 at night, the gauges softly glowing.
24. `banner-research-dark`: picture 6 at night, the flasks glowing amber.
25. `banner-hall-dark`: picture 7 at dusk, the trophies catching the lamplight.
26. `banner-notes-dark`: picture 8 at night in lamplight.
27. `banner-settings-dark`: picture 9 at night, the dials softly glowing.
28. `footer-ridge-dark`: picture 12 at dusk, tiny village lights, the top half plain sky fading to ink navy (#152036).

### Group 3: tall scenes, 1024x1536 (portrait), 2 pictures

29. `login-door`: a tall view of the room in soft daylight. An arched wooden door ajar with sunlight spilling out, inside the desk, a bright window and the sleeping cat, a brass key in the lock. Pale cream walls.
30. `login-door-dark`: the same view at dusk, warm lamplight spilling through the door, deep ink navy walls.

### Group 4: cut-outs, 1024x1024 with a transparent background, 10 pictures

Real transparency, no ground shadow outside the subject, no white halo: these sit on both cream and dark navy.

31. `cat-awake`: the white cat sitting alert beside a small tablet of candles, ears up, one paw on the tablet, a small cup beside it.
32. `cat-trouble`: the white cat startled with wide eyes, a tangle of cable around one paw, a tablet showing a broken chart line, a wisp of smoke. Worried, not distressed.
33. `verdict-ok`: the white cat relaxed on a cushion, purring, with a small sage green sprig beside it.
34. `verdict-warn`: the white cat peering at a brass gauge with its needle leaning to the side, one eyebrow raised.
35. `verdict-fail`: the white cat wearing a small terracotta firefighter hat, holding a tiny brass extinguisher near a smoking machine.
36. `verdict-unknown`: the white cat looking into a fogged glass orb, head tilted.
37. `empty-trades`: an open empty ledger with a pen resting across it, a cold cup, the cat asleep on the page.
38. `empty-logs`: a closed diary with a ribbon, a sleeping cat curled on top, a small unlit candle.
39. `empty-research`: clean empty flasks on a wooden tray, the cat asleep beside them.
40. `brand-mark`: the app's logo: the white cat curled asleep on a small brass coin-shaped cushion, seen simply from the front, bold shapes, readable at 34 pixels.

### Group 5: small round pictures, 1024x1024 with a transparent background, 8 pictures

One simple object, centered, filling the frame, with a bold shape: these show at 56 pixels.

41. `spot-strategy`: a brass compass lying on a folded chart.
42. `spot-orders`: a small brass bell with an order slip on a spike.
43. `spot-risk`: a brass shield with an olive branch across it.
44. `spot-fees`: a tiny stack of brass coins with a small tag tied on.
45. `spot-mode`: a two-position brass lever switch.
46. `spot-move`: two brass balance pans with coins moving from one to the other.
47. `spot-history`: a rolled parchment tied with a ribbon.
48. `spot-trades`: a small brass waste bin beside a torn order slip.

### Group 6: coins, 1024x1024 with a transparent background, 11 pictures

A round stamped coin seen straight on, filling the whole frame, soft painted shading, bold simple mark: they show at 34
pixels. These marks are the only exception to the no-letters rule.

49. `coin-btc`: warm orange-gold coin with a bold letter B.
50. `coin-eth`: cool silver-blue coin with a simple faceted diamond.
51. `coin-eur`: sage green coin with a bold euro sign.
52. `coin-sol`: purple-tinted coin with three slanted bars.
53. `coin-xrp`: slate grey coin with a bold letter X.
54. `coin-ada`: deep blue coin with a ring of small dots.
55. `coin-doge`: pale gold coin with a bold letter D.
56. `coin-avax`: terracotta red coin with a bold triangle.
57. `coin-link`: royal blue coin with a bold hexagon outline.
58. `coin-dot`: rose pink coin with one big round dot.
59. `coin-ltc`: light silver coin with a bold letter L.

---
