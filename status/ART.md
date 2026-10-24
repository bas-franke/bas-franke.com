# Status page artwork

The status page has slots for 20 illustrations. Each one is optional: if a file is missing, the page simply leaves
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
| 18 | `pattern-doodles.png` | Faint tiled page background | 512 px tile | 1024×1024 | 512×512 |
| 19 | `footer-cat.png` | Page footer | ~88 px | 1024×1024 | 264×264 |
| 20 | `login-badge.png` | Small sticker on the login card | ~64 px | 1024×1024 | 192×192 |

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

### 18. `pattern-doodles.png`

```text
Seamless tileable pattern, edges must wrap perfectly on all four sides. Sparse, evenly scattered hand-drawn line-art doodles of developer things: curly braces, semicolons drawn as shapes, a tiny rocket, a cute bug, a coffee cup, a git branch, a mouse cursor, a floppy disk, a rubber duck, a small cloud, a terminal prompt chevron, a lightbulb. Single colour only: thin indigo (#6366f1) lines, consistent 2 px stroke, no fills, no shading. Lots of empty space between doodles. No text, no letters, no numbers. Fully transparent background (PNG with alpha).
```

The page shows this at 6% opacity, so it only needs to read as texture. If the edges don't line up, fix them in
Photoshop (Filter → Other → Offset by half the size, then retouch the seams), or use a "seamless/tile" option in
your generator.

### 19. `footer-cat.png`

```text
[STYLE BLOCK]
A chubby grey tabby cat curled up asleep on a warm open laptop keyboard, a small yellow rubber duck sitting next to the laptop, a couple of little "z" sleep bubbles drawn as simple round shapes (no letters). Cosy, funny developer vibe. Square composition.
```

### 20. `login-badge.png` 🤖

```text
[STYLE BLOCK] [MASCOT BLOCK]
Round sticker design: Bit's face only (head and antenna), winking, inside a circular sticker with a thick white border and a subtle indigo-to-violet gradient fill. Looks like a laptop sticker. Square composition.
```
