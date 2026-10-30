# Portfolio artwork

Every picture on the page belongs to the same painted world (see `DESIGN.md`). There are no drawn fallbacks: an
interlude or the Contact painting without a file is simply left out, so they can be added one at a time. The hero is
the exception, it needs both of its files to build.

**Where files go:** `frontend/src/art/` (picked up at build time, hashed and cached forever), except the link preview
image, which goes in `frontend/public/og.jpg`. Use the exact filenames below, commit, push; the deploy does the rest.

**Dark mode:** the hero crossfades between `hero.webp` and `hero-dark.webp`. An interlude uses
`interlude-<name>-dark.webp` when it exists. Without one, the evening and fireside paintings are shown as they are and
the morning band shows only its line of text until `interlude-morning-dark.webp` exists. Contact is night in both themes, so its painting has no dark version.

**After generating:** crop to the ratio in the table (ChatGPT's sizes are 1024×1024, 1536×1024 and 1024×1536), resize
to the export size and save as WebP at quality 75–80 with <https://squoosh.app>. ChatGPT's 1536 px output upscaled to
1920 is fine for these soft images.

## The cozy set (hero, interludes, link preview)

The three pictures between the sections are "interludes", each with one line of text (the lines live in
`src/content.ts` under `interludes`).

Paste this into ChatGPT as one message; reply "next" if it stops after one image.

```text
I need a set of 6 illustrations for my personal portfolio website (I'm a software engineer in Amsterdam). Generate them one at a time, in the order below, each as a separate image, and keep the style identical across all of them, as if made by the same illustrator for the same app. Do not add any text, letters, numbers, logos, watermarks, signatures, frames or borders.

STYLE FOR ALL IMAGES
Modern, cute and cozy flat illustration, like the hero art of a well-designed app or a modern indie game. Simple rounded shapes, soft geometric forms, chubby friendly proportions (a round plump mug, a bouncy little plant, soft pillowy furniture), clean edges with no outlines or very thin ones, and smooth soft gradients with a fine grain texture on top. A warm, gentle palette: cream (#f4efe6), peach, honey, soft amber and a touch of blush pink, with dusty lake blue (#4f6b7c) for the sky, water and shadows. Soft glowing light. Playful but calm, not childish: no faces on objects, no kawaii eyes, no cartoon outlines, no clutter. One small recurring character: a round, fluffy ginger cat, drawn very simply, appears in some images. Dutch places. No people. Lots of clean empty space.

IMAGE 1, "hero" (portrait, 1024x1536)
Seen from inside a cozy room: a deep wooden windowsill in the lower third with a steaming mug of coffee, a small potted plant and a closed notebook on it, and the little ginger cat curled up asleep beside the mug. Through the old window with thin wooden frames, a wide still lake at dawn: a low horizon with one thin line of distant shore, faint mist on the water, and a small pale sun on the right. Soft golden morning light falls onto the sill. The upper half is mostly calm pale sky through the glass.

IMAGE 2, "hero-dark" (portrait, 1024x1536)
The same windowsill and window as image 1, but late in the evening: the room is dark and warm, a small candle or the glow of a lamp lights the sill, the mug, the plant, the notebook and the sleeping cat in amber. Outside, the lake lies under a deep blue night sky with a small moon on the right and its reflection on the water. Dark, rich and calm; the darkest tones close to #16130f.

IMAGE 3, "interlude-morning" (wide landscape, 1536x1024)
A wooden desk by a large window on a quiet morning: an open laptop seen from the side, a notebook with a pencil, reading glasses and a cup of coffee with a wisp of steam, in soft early sunlight with long gentle shadows. Through the window, the hint of Amsterdam rooftops and trees. Put the desk and window on the right two thirds of the image; keep the lower-left quarter calm, light and simple (a line of text will sit there). Keep the top and bottom edges quiet and pale, they fade into the page.

IMAGE 4, "interlude-evening" (wide landscape, 1536x1024)
An Amsterdam canal at blue hour: a row of narrow old canal houses on the right with warm yellow light in a few windows, a few bicycles leaning against a bridge railing, the lights reflected in the still water, one bare tree. The sky deep dusty blue fading to a last amber glow. Keep the lower-left quarter calm (still water, a line of text will sit there) and the top and bottom edges quiet, they fade into the page.

IMAGE 5, "interlude-fireside" (wide landscape, 1536x1024)
A cozy reading corner in the evening: a soft rounded armchair with a knitted blanket and the little ginger cat asleep on it, a floor lamp casting a warm pool of amber light, a small side table with a cup of tea and a stack of books, a bookshelf softly lost in the dark behind it, and a window with blue evening outside. Put the chair and lamp on the right half; keep the lower-left quarter calm and simple (a line of text will sit there) and the top and bottom edges quiet.

IMAGE 6, "og" (wide landscape, 1536x1024)
The view from image 1 as a wide scene: a still lake at dawn seen across a wooden windowsill with a steaming mug on the right, a small pale sun above the horizon, faint mist. The left two thirds is calm pale sky and water, so a name can be placed there later. No text.

After each image, tell me its name from this list so I can save it with the right filename, then continue with the next one.
```

| File | Where it shows | Ratio | Export at | Target size |
|------|----------------|-------|-----------|-------------|
| `src/art/hero.webp` | Hero, the painted window (16:10 crop on phones) | 4:5, crop | 1200×1500 | < 250 KB |
| `src/art/hero-dark.webp` | The same window in dark mode | 4:5, crop | 1200×1500 | < 250 KB |
| `src/art/interlude-morning.webp` | Band between About and Experience | 3:2 as generated | 1920×1280 | < 300 KB |
| `src/art/interlude-evening.webp` | Framed beside its line, between Experience and Skills | 3:2, shown 5:4 | 1920×1280 | < 300 KB |
| `src/art/interlude-fireside.webp` | Arched window between Skills and Contact | 3:2, shown 3:4 | 1920×1280 | < 300 KB |
| `public/og.jpg` | Link preview in chat apps and social media | 1.91:1, crop | 1200×630 JPEG | < 200 KB |

## The day set (October 2026 redesign)

These finish the "one day at the window" story from `DESIGN.md`. The existing morning picture is as orange as the
evening one, so the day has no arc yet, and Contact has no picture of its own. Attach `hero.webp` and
`interlude-evening.webp` to the chat as style references, then paste this as one message; reply "next" if it stops.

```text
Using the two attached images as the exact style reference (same illustrator, same soft painted look, same fine grain, same ginger cat), please generate 3 new illustrations for my website, one at a time, each as a separate image. Do not add any text, letters, numbers, logos, watermarks, signatures, frames or borders. No people.

IMAGE 1, "interlude-morning" (wide landscape, 1536x1024)
A wooden desk by a large window at about nine in the morning: an open laptop seen from the side with its screen turned away from us, a notebook with a pencil, reading glasses and a cup of coffee with a wisp of steam. Clear, cool, fresh daylight: a pale blue sky with a few thin clouds, the sun high and out of frame, soft crisp shadows on the desk. Through the window, Amsterdam rooftops and green trees in full daylight. Absolutely no orange, sunset or golden-hour colours: the palette is pale blue, cream, light wood and fresh green. Desk and window on the right two thirds; the lower left quarter stays calm and light. Top and bottom edges quiet and pale.

IMAGE 2, "interlude-morning-dark" (wide landscape, 1536x1024)
Exactly the same desk, window and composition as image 1, before sunrise at blue hour: the room is dim, deep blue and quiet, one small warm desk lamp lights the notebook and the cup in amber, the laptop is closed. Outside, dark blue rooftops with a few lit windows. The darkest tones close to #16130f.

IMAGE 3, "contact-night" (very wide landscape, 1536x1024; the left part matters most, it will be cropped to 21:9)
The same cozy home at night. On the LEFT: a soft rounded armchair with a knitted blanket and the little ginger cat asleep on it, a floor lamp casting a warm pool of amber light, a small side table with a cup of tea. The RIGHT 60% of the image is a quiet, almost empty dark wall fading into deep warm shadow with one tall window showing dark blue night and a few distant lights: text will sit on this part, so keep it very calm with no objects. The darkest tones close to #16130f, the wall a very dark warm brown.

After each image, tell me its name from this list so I can save it with the right filename, then continue with the next one.
```

| File | Where it shows | Ratio | Export at | Target size |
|------|----------------|-------|-----------|-------------|
| `src/art/interlude-morning.webp` | Band between About and Experience (replaces the orange one) | 3:2 | 1920×1280 | < 300 KB |
| `src/art/interlude-morning-dark.webp` | The same band in dark mode | 3:2 | 1920×1280 | < 300 KB |
| `src/art/contact-night.webp` | Behind the Contact section | 3:2, shown wide | 1920×1280 | < 300 KB |

## Company marks

Company marks for the experience rows live in `src/art/logos/<slug>.png` (gohome, transparent, piggy, saxo, binck),
128×128; the Binck one is the green asterisk from the public-domain wordmark on Wikipedia (File:BinckBank.svg). The
marks are also printed in the PDF résumé, which draws a monogram tile for any company without one.

## Optional: a calmer portrait

The site uses the existing photo in `src/art/profile.jpg`. If you want a quieter version, upload that photo to
ChatGPT with:

```text
Keep this person exactly as they are: same face, glasses, hair, expression and clothing, no retouching. Replace the busy background with a soft, out-of-focus warm grey-beige, like a plain wall in natural light. Square crop, head and shoulders, the person slightly left of centre.
```

Save the result as `src/art/profile.jpg` (JPEG, 960×960, under 150 KB).
