# pulse art: one ChatGPT prompt for all 16 pictures

Paste the prompt below into ChatGPT (image generation, **no reference images**). It asks for the 16 pictures one at a
time in one consistent style. Save each result as `<filename>.png`. Not part of this set (they stay painted
placeholders): the favicon/app icon and the page background texture.

Sizes: ChatGPT only makes a few shapes, so each image asks for a ratio and the nearest ChatGPT size; the importer
crops to the exact pixel size (keep the subject away from the edges so the crop is safe).

## The prompt

````text
Please create 16 separate illustrations for a cozy personal to-do and notes app called Pulse. Make them ONE AT A TIME,
each as its own image, in the order below, and keep the exact same art style for all of them so they look like one
family. After each image, wait for me to say "next" (or just continue if I ask for all of them).

SHARED STYLE (applies to every image): cozy hand-painted gouache, storybook-like flat illustration with soft rounded
shapes, layered flat colour planes, gentle paper grain, subtle warm light and soft shadows. Warm palette of terracotta,
cream, sage green, dusty blue and soft gold, with small touches of dusty rose. Calm, friendly, uncluttered, with a clear
focal point and generous empty space around it. Absolutely no text, letters, numbers, logos, watermarks or UI. No
photorealism, no 3D render look, no harsh black outlines. Keep important things away from the very edges, because the
picture is cropped slightly to fit.

Wide pictures (use the widest ChatGPT landscape size, 1536x1024, and keep the subject in the middle band so it can be
cropped to the exact ratio):

1. dashboard-hero.png, wide 3:1 banner (cropped to 1800x600). A sunny wooden desk in front of a big window: green plants
   on the sill, an open notebook with a pencil, a steaming mug, soft clouds and rolling green hills outside, warm
   daylight.
2. notes-hero.png, wide 3:1 banner (1800x600). A quiet notes desk: stacks of old books in blue, terracotta, green and
   gold, a fountain pen, an open notebook and a lit candle with a soft glow, a small plant beside it, dusty blue wall.
3. rainy-banner.png, wide 3:1 banner (1800x600). Rain on a window with a blurred, softly glowing city behind it, a
   warm lamp and a steaming mug on the sill, calm and moody but still warm.
4. night-hero.png, wide 3:1 banner (1800x600). A night-time version of a cozy window: deep indigo sky with stars and a
   crescent moon, small rooftops with a few lit windows, light rain on the glass, a lit lamp and an open book on the
   desk in the foreground, golden lamplight. This one is used for dark mode.
5. column-todo.png, very wide 4:1 strip (1600x400). A seed packet (sage green, with a little sprout drawing, no
   words) leaning on a wooden table next to a small blue watering can with a few drops falling. Pale warm background.
6. column-doing.png, very wide 4:1 strip (1600x400). A small seedling pushing up through dark soil, two bright green
   leaves, a soft sun and a little cloud in a pale blue and gold sky.
7. column-done.png, very wide 4:1 strip (1600x400). A full ceramic fruit bowl on a wooden table: apples, an orange,
   a pear and lemons, warm golden background.

For the strips (5 to 7) use the widest landscape size, 1536x1024, with the subject centred in a horizontal band.

Square pictures (use the square 1024x1024 size, cropped to 800x800), each with one friendly animal or object as the
hero on a soft plain painted background with a little scenery:

8. empty-tasks.png, 1:1 (800x800). A small hedgehog sitting on a folded blue cloth next to a smooth pebble and a
   fallen leaf, calm and a bit lonely, soft sage green background.
9. empty-notes.png, 1:1 (800x800). A fluffy owl perched on a branch beside a blank open notebook and a tiny teacup,
   a crescent moon behind, dusty blue background.
10. overdue.png, 1:1 (800x800). A friendly orange fox with a white-tipped tail holding a golden pocket watch (no
    numbers on the dial), slightly hurried but gentle, autumn leaves around, warm terracotta background.
11. loading-404.png, 1:1 (800x800). A little cream paper boat drifting on a calm pond at dawn, soft mist, lily pads,
    a lantern glow in the distance, no animals.
12. celebrate.png, 1:1 (800x800). A cheerful brown bear holding a bunch of colourful balloons (terracotta, gold,
    dusty blue, sage, rose) with confetti falling softly, warm cream background.

Note covers (use the 3:2 landscape size, 1536x1024, cropped to 4:3 and 1200x900):

13. cover-tea.png, 4:3 (1200x900). A teapot, two cups and curls of steam on a wooden tray on a linen cloth, a sprig
    of flowers beside it, warm morning light.
14. cover-lighthouse.png, 4:3 (1200x900). A white lighthouse with a red band on a grassy cliff above a calm sea at
    golden hour, soft clouds, a few gulls far away, very peaceful.
15. cover-meadow.png, 4:3 (1200x900). A summer wildflower meadow, hundreds of small flowers in rose, gold, cream
    and blue, soft clouds, gentle hills behind.
16. cover-winter.png, 4:3 (1200x900). A snowy wooden cabin with a lit golden window and a smoking chimney at dusk,
    snow-laden pine trees, a violet and rose sky.

Keep all 16 images consistent in brushwork, colour palette and softness. Remember: no text anywhere.
````

## Optional: dark variants

Only if a picture looks too bright in dark mode, ask ChatGPT: "Repaint image N as the same scene at night or dusk with
warm lamplight, same style, no text" and save it as `<name>-dark.png` (for example `cover-meadow-dark.png`). The
importer converts it to `<name>-dark.webp`, which replaces the picture in the dark theme. `night-hero` already is the
dark-mode hero.

## Importing

1. Save the PNGs into `pulse/art-inbox/`, named exactly `<name>.png` (the filenames above).
2. From `pulse/`: `npm --prefix tools install` (once), then `node tools/art_import.mjs`. It crops each PNG to its exact
   size and writes `.webp` (quality 82) into `frontend/src/assets/art/`, and reports unknown names and the pictures still
   missing.
3. Commit the new `.webp` files and push; the deploy picks them up. A missing file simply keeps its painted placeholder.

The list of files and sizes lives in `frontend/src/art/slots.ts` (`FILES`); change it there if you want other sizes.
