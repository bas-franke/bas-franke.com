# Status page artwork

The status page has slots for 40 illustrations (1–19 for the health dashboard, 20–40 for the per-project analytics
pages; [ART-CHATGPT-PROMPT.md](ART-CHATGPT-PROMPT.md) is a paste-ready ChatGPT script for 20–40). Each one is optional: if a file is missing, the page simply leaves
it out, so you can add them one at a time. Drop finished files into
[`frontend/public/art/`](frontend/public/art/) with exactly the filename listed, commit and push. The status deploy
picks them up.

## How to generate

**Tool:** anything that outputs PNG with a real alpha channel.

- **OpenAI image generation (ChatGPT / `gpt-image-1`)**: ask for a transparent background, or set
  `background: "transparent"`, `output_format: "png"`, `quality: "high"` in the API.
  Supported sizes: `1024x1024`, `1536x1024`, `1024x1536`.
- **Midjourney / others without transparency**: generate on a plain white background (swap the last line of the style
  block for "plain pure white background"), then remove it with remove.bg, Photoshop "Remove background", or
  `rembg` (`pip install rembg`, `rembg i in.png out.png`).

**Consistency:** every prompt starts with the same **style block** and, where the mascot appears, the same
**mascot block**. Generate image 1 (the mascot reference) first and attach it as a reference/character image to
every later mascot prompt. That keeps "Bit" looking the same everywhere.

**After generating:**

1. Check the background is truly transparent (no white halo or checkerboard baked into the pixels).
2. Resize to the **export size** in the table (keeps the page fast; the generate size is just what the model makes).
3. Compress: <https://squoosh.app> (OxiPNG, or "Browser PNG" with reduced palette) or <https://tinypng.com>.
   Targets: icons < 15 KB, illustrations < 150 KB.
4. Save with the exact filename into `status/frontend/public/art/`.

---

## Shared blocks

Paste these in front of every prompt below.

**Style block**

```text
Clean modern flat vector illustration with soft subtle gradients and gentle depth, thin rounded outlines in deep navy (#1e1b4b), limited palette: indigo (#6366f1), violet (#8b5cf6), mint green (#22c55e), warm amber (#f59e0b), coral red (#ef4444), white and soft cool greys. Playful, nerdy software-developer humour, friendly and polished like a premium tech startup website. Slight 3/4 isometric perspective. No text, no letters, no numbers, no logos, no watermark, no signature. Single centred composition with generous empty padding around the subject. Fully transparent background (PNG with alpha), no background colour, no floor, no frame, no drop shadow on the background.
```

**Mascot block** (for prompts marked 🤖)

```text
The mascot "Bit": a small friendly robot shaped like a rounded-corner cube that looks like a 1U server box. Glossy white body with indigo panel lines, a dark navy face screen with two rounded rectangle eyes glowing mint green, a tiny antenna on top with a small glowing status LED, short stubby arms with round mitten hands and short stubby legs. Cute, expressive, approachable.
```

---

## The images

| # | Filename | Where it shows | Display size | Generate at | Export at |
|---|----------|----------------|--------------|-------------|-----------|
| 1 | `mascot.png` | Header logo + reference for all mascot art | 40–56 px | 1024×1024 | 256×256 |
| 2 | `login-hero.png` | Login page, left panel | ~420 px | 1024×1024 | 840×840 |
| 3 | `state-ok.png` | Dashboard hero when everything is green | ~260×173 px | 1536×1024 | 780×520 |
| 4 | `state-warn.png` | Dashboard hero with warnings | ~260×173 px | 1536×1024 | 780×520 |
| 5 | `state-fail.png` | Dashboard hero when something fails | ~260×173 px | 1536×1024 | 780×520 |
| 6 | `state-loading.png` | While the first checks run | ~220 px | 1024×1024 | 440×440 |
| 7 | `state-offline.png` | Status API unreachable | ~220 px | 1024×1024 | 440×440 |
| 8 | `group-shared.png` | "Shared infrastructure" card icon | 44 px | 1024×1024 | 132×132 |
| 9 | `group-portfolio.png` | "portfolio" card icon | 44 px | 1024×1024 | 132×132 |
| 10 | `group-status.png` | "status" card icon | 44 px | 1024×1024 | 132×132 |
| 11 | `group-default.png` | Any future project without its own icon | 44 px | 1024×1024 | 132×132 |
| 12 | `provider-dns.png` | "name.com" chip | 16 px | 1024×1024 | 64×64 |
| 13 | `provider-aws.png` | "AWS" chip | 16 px | 1024×1024 | 64×64 |
| 14 | `provider-github.png` | "GitHub" chip | 16 px | 1024×1024 | 64×64 |
| 15 | `provider-server.png` | "Server" chip | 16 px | 1024×1024 | 64×64 |
| 16 | `provider-tls.png` | "Let's Encrypt" chip | 16 px | 1024×1024 | 64×64 |
| 17 | `provider-status.png` | "Status" chip | 16 px | 1024×1024 | 64×64 |
| 18 | `footer-cat.png` | Page footer | ~88 px | 1024×1024 | 264×264 |
| 19 | `login-badge.png` | Small sticker on the login card | ~64 px | 1024×1024 | 192×192 |
| 20 | `group-inck.png` | "inck" card icon | 44 px | 1024×1024 | 132×132 |
| 21 | `group-play.png` | "play" card icon | 44 px | 1024×1024 | 132×132 |
| 22 | `group-wordward.png` | "wordward" card icon | 44 px | 1024×1024 | 132×132 |
| 23 | `hero-portfolio.png` | portfolio project page header | ~240×160 px | 1536×1024 | 720×480 |
| 24 | `hero-status.png` | status project page header | ~240×160 px | 1536×1024 | 720×480 |
| 25 | `hero-inck.png` | inck project page header | ~240×160 px | 1536×1024 | 720×480 |
| 26 | `hero-play.png` | play project page header | ~240×160 px | 1536×1024 | 720×480 |
| 27 | `hero-wordward.png` | wordward project page header | ~240×160 px | 1536×1024 | 720×480 |
| 28 | `hero-default.png` | Page header for any project without its own hero | ~240×160 px | 1536×1024 | 720×480 |
| 29 | `overview-hero.png` | Overview health strip | ~150×100 px | 1536×1024 | 450×300 |
| 30 | `empty-analytics.png` | "No visitors yet" empty state | ~200 px | 1024×1024 | 600×600 |
| 31 | `section-traffic.png` | "Traffic" section heading | 28 px | 1024×1024 | 96×96 |
| 32 | `section-sources.png` | "Sources" section heading | 28 px | 1024×1024 | 96×96 |
| 33 | `section-locations.png` | "Locations" section heading | 28 px | 1024×1024 | 96×96 |
| 34 | `section-pages.png` | "Pages" section heading | 28 px | 1024×1024 | 96×96 |
| 35 | `section-engagement.png` | "Engagement" section heading | 28 px | 1024×1024 | 96×96 |
| 36 | `section-technology.png` | "Technology" section heading | 28 px | 1024×1024 | 96×96 |
| 37 | `section-live.png` | "Live" section heading | 28 px | 1024×1024 | 96×96 |
| 38 | `section-health.png` | "Health" section heading | 28 px | 1024×1024 | 96×96 |
| 39 | `section-calendar.png` | "Calendar" section heading | 28 px | 1024×1024 | 96×96 |
| 40 | `world-map.png` | Faint background behind the locations map | full width | 1536×1024 | 1200×800 |

Export sizes are 3× the display size for crisp results on high-DPI screens.

---

### 1. `mascot.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Full-body front view of Bit standing upright, waving hello with one hand and holding a small steaming coffee mug with a tiny curly-brace pattern in the other. Happy expression, eyes shaped like smiling arcs. Clean silhouette that stays readable at very small sizes.
```

### 2. `login-hero.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Bit stands proudly next to a large round vault door made of server hardware, holding up a glowing indigo keycard like a backstage pass. Around them float small elements: a padlock with a mint green check, angle-bracket code symbols drawn as simple shapes, a tiny cloud, a couple of sparkles and a little rocket. Feels like "secure access granted". Balanced square composition.
```

### 3. `state-ok.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Wide landscape scene: Bit relaxes in a hammock strung between two small server racks whose status lights all glow mint green. Bit wears tiny sunglasses and holds a coffee mug, a small potted cactus and a rubber duck sit nearby, a couple of happy sparkles in the air. Mood: everything is running perfectly, calm and smug.
```

### 4. `state-warn.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Wide landscape scene: Bit wears a small amber hard hat and inspects a server rack through an oversized magnifying glass. One light on the rack blinks warm amber while the others are green. A small traffic cone and a coiled network cable sit on the ground beside them. Curious, slightly concerned expression. Mood: something needs attention, but it is under control.
```

### 5. `state-fail.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Wide landscape scene: Bit bravely points a small fire extinguisher at a server rack that has coral red lights and a little cartoon puff of smoke above it. A tangled network cable and a fallen rubber duck lie on the floor. Determined, heroic expression, not scary, still cute and funny. Mood: something broke and we are on it.
```

### 6. `state-loading.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Bit runs inside a hamster wheel that is wired to a small server, little motion lines behind them, a loading-spinner ring floating above made of simple dots. Energetic, cheerful expression. Mood: running the checks right now.
```

### 7. `state-offline.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Bit sits on the ground holding the unplugged end of a network cable, looking at it with a confused expression; the cable curls into the shape of a question mark. A small dark server box next to them has no lights on. Gentle, funny, slightly sad. Mood: cannot reach the server.
```

### 8. `group-shared.png`

```text
[STYLE BLOCK]
Icon: a compact isometric server rack with a soft indigo cloud hovering above it, connected by two glowing mint green lines, a tiny padlock on the rack. Bold simple shapes, very few details, must stay readable at 44 pixels. Square composition.
```

### 9. `group-portfolio.png`

```text
[STYLE BLOCK]
Icon: a compact isometric browser window showing an abstract portfolio layout (a circle avatar shape and a few rounded content blocks), with a small painter's palette and brush leaning against it. Bold simple shapes, very few details, readable at 44 pixels. Square composition.
```

### 10. `group-status.png`

```text
[STYLE BLOCK]
Icon: a compact isometric computer monitor showing a bold mint green heartbeat line, with a small round gauge dial attached to its side. Bold simple shapes, very few details, readable at 44 pixels. Square composition.
```

### 11. `group-default.png`

```text
[STYLE BLOCK]
Icon: a compact isometric cardboard shipping box, open at the top, with glowing indigo angle-bracket code symbols drawn as simple shapes rising out of it. Bold simple shapes, very few details, readable at 44 pixels. Square composition.
```

### 12–17. Provider icons

Use this extra line for all six: *"Tiny UI icon, one single object, extremely simple bold shapes, thick outlines, at most three colours, must be recognisable at 16 pixels. Square composition, object fills about 80% of the canvas."*

| File | Prompt (after style block + extra line) |
|------|------------------------------------------|
| `provider-dns.png` | A globe with a small signpost in front of it pointing to the right. |
| `provider-aws.png` | A rounded cloud with a tiny server box tucked inside it. |
| `provider-github.png` | A git branch diagram: three round nodes connected by lines, one line branching off and merging back. |
| `provider-server.png` | A front view of a small server rack with three stacked units and green lights. |
| `provider-tls.png` | A closed padlock on top of a shield with a check mark. |
| `provider-status.png` | A semicircular speedometer gauge with the needle pointing to green. |

### 18. `footer-cat.png`

```text
[STYLE BLOCK]
A chubby grey tabby cat curled up asleep on a warm open laptop keyboard, a small yellow rubber duck sitting next to the laptop, a couple of little "z" sleep bubbles drawn as simple round shapes (no letters). Cosy, funny developer vibe. Square composition.
```

### 19. `login-badge.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Round sticker design: Bit's face only (head and antenna), winking, inside a circular sticker with a thick white border and a subtle indigo-to-violet gradient fill. Looks like a laptop sticker. Square composition.
```

### 20. `group-inck.png`

```text
[STYLE BLOCK]
Icon: a compact isometric tall smartphone-shaped card showing an abstract short story (a small picture block and a few rounded text lines), with an old-fashioned fountain pen nib dipped in a small indigo ink pot leaning against it, one glossy ink drop falling. Bold simple shapes, very few details, readable at 44 pixels. Square composition.
```

### 21. `group-play.png`

```text
[STYLE BLOCK]
Icon: a compact chunky game controller in indigo and violet with mint green buttons, a tiny cartoon rocket with an amber flame arcing over it. Bold simple shapes, very few details, readable at 44 pixels. Square composition.
```

### 22. `group-wordward.png`

```text
[STYLE BLOCK]
Icon: a compact isometric keyboard key standing upright, with a round translucent soap bubble floating above it that holds a tiny chubby pastel creature, and a small candy-coloured castle turret behind. Bold simple shapes, very few details, readable at 44 pixels. Square composition.
```

### 23–28. Project page heroes 🤖

Wide 3:2 scenes, shown at about 240×160 px, so keep Bit large and the props few and chunky.

### 23. `hero-portfolio.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Wide landscape scene: Bit as a proud gallery curator hanging a framed picture on a small exhibition wall. The wall already holds two other small frames with abstract shapes (a browser window, a mountain-and-sun sketch). Bit wears a tiny beret, a painter's palette and brush rest on a stool beside them, a calm lake-blue accent in one frame. Warm, tidy, slightly artsy. Mood: showing off the best work.
```

### 24. `hero-status.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Wide landscape scene: Bit as a friendly doctor with a stethoscope pressed against a small server rack whose lights glow mint green, holding a clipboard showing a simple heartbeat line and a little bar chart drawn as plain shapes. A floating heart with a pulse line and a small round gauge hover nearby. Mood: caring, attentive check-up.
```

### 25. `hero-inck.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Wide landscape scene: Bit sits at a small writing desk with a vintage typewriter, ink-stained mitten hands, a giant fountain pen leaning against the desk and an indigo ink pot. Out of the typewriter rises a vertical stack of short story cards, like a scrolling feed, each with a tiny simple picture (an atom, a lightbulb, a globe, a chip) and blank rounded lines. Mood: curious, inspired, explaining big ideas in small bites.
```

### 26. `hero-play.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Wide landscape scene: Bit grins while gripping a chunky game controller, sitting on top of a small arcade cabinet. Around them, playful game elements: a cartoon rocket with an amber exhaust trail looping overhead, a tiny dusty desert podracer pod with twin engines kicking up red-rock dust, party confetti, and a small cute (not scary) green cartoon zombie hand poking out of the ground holding a flashlight. Mood: game night with friends, energetic and fun.
```

### 27. `hero-wordward.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Wide landscape scene: Bit types happily on a floating pastel keyboard while round translucent soap bubbles drift down from above, each holding a tiny chubby pastel creature. One bubble pops into sparkles. Behind, a small candy-coloured storybook castle, and a little round owl guardian perched on Bit's antenna sending a soft star beam. Mood: cute, cosy, learning a language as a game.
```

### 28. `hero-default.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Wide landscape scene: Bit unpacks a large open cardboard shipping box from which glowing indigo angle-bracket code symbols (simple shapes) and a small rocket float out. Packing peanuts scattered around, a roll of tape nearby. Excited, curious expression. Mood: a brand new project just arrived.
```

### 29. `overview-hero.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Wide landscape scene: Bit stands on top of a small air-traffic control tower, holding binoculars, overseeing a tiny town of five small isometric buildings, each topped with a little screen: a browser window with a palette, a monitor with a heartbeat line, an ink pot, a game controller, a bubble with a chubby creature. Thin glowing mint green lines connect the buildings to the tower. Very few, chunky details, readable at 150 pixels wide. Mood: everything under watch.
```

### 30. `empty-analytics.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Bit stands patiently holding up a blank welcome sign on a stick (the sign is empty, no text), looking hopefully to the side. A single tumbleweed rolls past on a small patch of sandy ground, a lonely little cactus behind. Gentle, funny, slightly wistful. Mood: no visitors yet, waiting for the first one. Square composition.
```

### 31–39. Section icons

Use the same extra line as the provider icons: *"Tiny UI icon, one single object, extremely simple bold shapes, thick outlines, at most three colours, must be recognisable at 16 pixels. Square composition, object fills about 80% of the canvas."*

| File | Prompt (after style block + extra line) |
|------|------------------------------------------|
| `section-traffic.png` | A small chart card with a mint green line zig-zagging upwards to the right, ending in an arrowhead. |
| `section-sources.png` | A wooden signpost with two arrow signs pointing in different directions (left and right), the signs blank. |
| `section-locations.png` | An indigo globe with a coral red map pin stuck in the top. |
| `section-pages.png` | Three stacked document sheets slightly fanned out, the top one with a folded corner and blank rounded lines. |
| `section-engagement.png` | A round stopwatch with a button on top and a single hand. |
| `section-technology.png` | A small open laptop with a smartphone standing in front of it. |
| `section-live.png` | A round radar screen with a sweeping beam and one glowing mint green dot with pulse rings. |
| `section-health.png` | A coral red heart with a white heartbeat line across it. |
| `section-calendar.png` | A wall calendar page with two ring binders on top and a grid of blank squares, one square highlighted indigo. |

### 40. `world-map.png`

This one ignores the "single centred composition with generous padding" and outline parts of the style block.

```text
[STYLE BLOCK]
Override for this image: no outlines, no mascot, no objects, fill the whole width of the canvas. A very simple stylised flat world map made only of evenly spaced small round dots in soft indigo and light cool grey, continents recognisable but simplified, no borders, no oceans drawn, no labels, no pins, low contrast. Used as a faint background texture behind a chart. Wide landscape composition.
```
