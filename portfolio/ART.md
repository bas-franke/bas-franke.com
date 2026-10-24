# Portfolio artwork

The site has nine optional image slots. Each one shows a procedural line drawing in the site's own ink until the
file exists, so the page is complete without any of them and you can add them one at a time.

**Where files go:** `frontend/src/art/` (picked up at build time, hashed and cached forever), except the link
preview image, which goes in `frontend/public/og.jpg`. Use the exact filenames below, commit, push; the deploy does
the rest and the drawings disappear by themselves.

**Dark mode:** light artwork is automatically inverted in dark mode, which works well for ink-on-paper images.
If you want full control, add a `<name>-dark.webp` next to any file and it is used instead.

## How to generate

Use ChatGPT (image generation). Paste the **style block** first, then the prompt. Generate the hero first and
attach it as a reference image to the other prompts so the ink, paper and blue stay consistent.

After generating:

1. Crop to the ratio in the table (ChatGPT's sizes are 1024×1024, 1536×1024 and 1024×1536; crop afterwards).
2. Resize to the **export size** and save as WebP at quality 80 with <https://squoosh.app>.
   Targets: hero under 250 KB, work covers under 120 KB each, `og.jpg` under 200 KB.
3. Save with the exact filename.

### Style block (paste in front of every prompt)

```text
Minimal ink-wash illustration on warm off-white paper (#f5f2ec). Thin, confident charcoal-ink lines (#1b1d1c), soft diluted ink washes in warm grey, and one accent of dusty lake blue (#4f6b7c) used sparingly. Calm, quiet and precise, with a lot of empty paper. The restraint of Japanese sumi-e, but no clichés: no lotus, no bamboo, no stacked stones, no enso brush circle, no people, no mountains with mist unless asked. Subtle paper grain, a very slight ink bleed at the edge of each stroke. No text, no letters, no numbers, no logos, no watermark, no signature, no frame or border.
```

## The images

| # | File | Where it shows | Ratio | Generate at | Export at |
|---|------|----------------|-------|-------------|-----------|
| 1 | `src/art/hero.webp` | Hero, right of the headline | 4:5 | 1024×1536, crop | 1200×1500 |
| 2 | `src/art/hero-dark.webp` | Hero in dark mode (optional) | 4:5 | 1024×1536, crop | 1200×1500 |
| 3 | `src/art/work-saxo.webp` | Work list: Saxo Bank | 4:3 | 1536×1024, crop | 960×720 |
| 4 | `src/art/work-binck.webp` | Work list: BinckBank | 4:3 | 1536×1024, crop | 960×720 |
| 5 | `src/art/work-irp.webp` | Work list: IRP | 4:3 | 1536×1024, crop | 960×720 |
| 6 | `src/art/work-inck.webp` | Work list: inck.ai | 4:3 | 1536×1024, crop | 960×720 |
| 7 | `src/art/work-status.webp` | Work list: status page | 4:3 | 1536×1024, crop | 960×720 |
| 8 | `src/art/work-portfolio.webp` | Work list: this site | 4:3 | 1536×1024, crop | 960×720 |
| 9 | `public/og.jpg` | Link preview in chat apps and social media | 1.91:1 | 1536×1024, crop | 1200×630 (JPEG) |

The export sizes are roughly 3× the display size, so they stay crisp on high-DPI screens.

### 1. `hero.webp`

```text
[STYLE BLOCK]
Portrait composition. A wide, perfectly still body of water meets a pale empty sky, the horizon line about two thirds of the way down. Low, faint mist lies on the water. One thin dark line of a distant shore. The surface of the water is suggested by a handful of thin horizontal ink lines, spaced more widely towards the bottom of the page. A small pale sun, drawn as one quiet circle, hangs above the horizon on the right. Nothing else. Mood: the moment just before the day starts.
```

### 2. `hero-dark.webp` (optional)

```text
[STYLE BLOCK, but replace the paper with near-black paper (#141516) and the charcoal ink with warm pale ink (#ebe7df); keep the lake blue accent]
Portrait composition. The same night-time view: a perfectly still body of water under an empty dark sky, horizon two thirds down, faint mist on the water, one thin pale line of a distant shore, a handful of thin horizontal pale lines for the surface of the water, spaced more widely towards the bottom. A small moon, drawn as one quiet circle, hangs above the horizon on the right. Nothing else. Mood: quiet, late, calm.
```

### 3. `work-saxo.webp`

```text
[STYLE BLOCK]
Landscape composition. Eight thin horizontal hairlines run across the page like ruled paper, with generous margins. One single confident line in lake blue rises from the lower left to the upper right in a slow, smooth curve, like a hand-drawn chart of steady growth, ending in a small filled dot. Nothing else.
```

### 4. `work-binck.webp`

```text
[STYLE BLOCK]
Landscape composition. A fine, even grid of thin ink hairlines, like a page from an accountant's ledger, sitting slightly off-centre with wide margins. Five or six of the cells are filled with a soft lake-blue wash, scattered like entries being recorded. Precise, orderly, calm. Nothing else.
```

### 5. `work-irp.webp`

```text
[STYLE BLOCK]
Landscape composition. Concentric thin ink circles, like ripples spreading from a single drop on still water, centred a little right of the middle. The inner rings are crisp, the outer rings fade until they dissolve into the paper. Nothing else.
```

### 6. `work-inck.webp`

```text
[STYLE BLOCK]
Landscape composition. A single drop of ink falls from the top of the page, drawn as one short vertical line and a small teardrop, and lands on a still surface that shows three or four thin elliptical ripples. Below the surface the ink spreads into a soft grey wash. It should suggest writing and publishing without showing a pen. Nothing else.
```

### 7. `work-status.webp`

```text
[STYLE BLOCK]
Landscape composition. One long thin horizontal ink line crosses the whole page, perfectly steady, with a single small heartbeat pulse in the middle drawn in lake blue: one sharp rise, one dip, then steady again. Two much fainter guide lines run parallel above and below. Nothing else.
```

### 8. `work-portfolio.webp`

```text
[STYLE BLOCK]
Landscape composition. A single sheet of paper drawn in thin ink outline with a soft shadow, lying slightly rotated on the page, with a second sheet beneath it offset a little. On the top sheet, three short horizontal lines like the first lines of a letter, the first one in lake blue. Nothing else.
```

### 9. `og.jpg`

```text
[STYLE BLOCK]
Very wide landscape composition. The same dawn scene as the hero: a perfectly still body of water, a low horizon, faint mist, a handful of thin horizontal lines for the surface, one small pale sun on the right. The left two thirds of the image is empty pale sky, so that a name could be placed there later. No text.
```

### Optional: a calmer portrait

The site uses the existing photo in `src/art/profile.jpg`. If you want a quieter version, upload that photo to
ChatGPT with:

```text
Keep this person exactly as they are: same face, glasses, hair, expression and clothing, no retouching. Replace the busy background with a soft, out-of-focus warm grey-beige, like a plain wall in natural light. Square crop, head and shoulders, the person slightly left of centre.
```

Save the result as `src/art/profile.jpg` (JPEG, 960×960, under 150 KB).
