# ChatGPT script for the analytics artwork (images 20–40)

One ChatGPT conversation that makes all 21 new images for the analytics redesign. Full slot list, sizes and the
original prompts are in [ART.md](ART.md).

## Before you start

1. Open a **new** ChatGPT chat with image generation.
2. **Upload `status/frontend/public/art/mascot.png` together with message 0.** It is the reference for Bit. If
   ChatGPT's Bit starts to drift later, upload it again together with that image's message.
3. Paste message 0, then messages 1–21 one at a time. Wait for each image and download it before sending the next.
4. Every message after 0 restates the style, so if the chat gets confused, start a new chat, upload `mascot.png`
   and paste the message for the image you were on.
5. If an image comes back with a white or checkered background, reply: `Same image, but with a truly transparent
   background (PNG alpha), nothing behind the subject.`

## Message 0: setup (attach mascot.png)

```text
I'm going to ask you for 21 images for a website dashboard, one at a time. Please follow these rules for every image in this conversation:

HARD RULES
- One image per reply. Don't combine images, don't make variations unless I ask.
- PNG with a fully transparent background (real alpha channel). No background colour, no floor, no frame, no checkerboard pattern painted in, no white halo.
- Absolutely no text, letters, numbers, words, logos, watermarks or signatures anywhere, including on signs, screens, cards and paper. Use blank shapes or simple lines instead.
- Use exactly the canvas size I give: 1024×1024 square or 1536×1024 landscape.
- Keep the mascot identical to the attached reference image every time.

STYLE (all images)
Clean modern flat vector illustration with soft subtle gradients and gentle depth, thin rounded outlines in deep navy (#1e1b4b), limited palette: indigo (#6366f1), violet (#8b5cf6), mint green (#22c55e), warm amber (#f59e0b), coral red (#ef4444), white and soft cool greys. Playful, nerdy software-developer humour, friendly and polished like a premium tech startup website. Slight 3/4 isometric perspective. Single centred composition with generous empty padding around the subject.

MASCOT "Bit" (see the attached image; match it exactly)
A small friendly robot shaped like a rounded-corner cube that looks like a 1U server box. Glossy white body with indigo panel lines, a dark navy face screen with two rounded rectangle eyes glowing mint green, a tiny antenna on top with a small glowing amber status LED, short stubby arms with round mitten hands and short stubby legs. Cute, expressive, approachable.

Reply "Ready" and wait for my first image request. Don't generate anything yet.
```

## Messages 1–21

### Project card icons (44 px on screen)

```text
Image 1 of 21: group-inck.png, 1024×1024 square, transparent PNG, no text.
Same flat vector style as before (navy outlines, indigo/violet/mint/amber/coral palette, slight isometric, generous padding). No mascot.
Icon: a compact isometric tall smartphone-shaped card showing an abstract short story (a small picture block and a few rounded blank lines), with an old-fashioned fountain pen nib dipped in a small indigo ink pot leaning against it, one glossy ink drop falling. Bold simple shapes, very few details, must be readable at 44 pixels.
```

```text
Image 2 of 21: group-play.png, 1024×1024 square, transparent PNG, no text.
Same flat vector style as before (navy outlines, indigo/violet/mint/amber/coral palette, slight isometric, generous padding). No mascot.
Icon: a compact chunky game controller in indigo and violet with mint green buttons, a tiny cartoon rocket with an amber flame arcing over it. Bold simple shapes, very few details, must be readable at 44 pixels.
```

```text
Image 3 of 21: group-wordward.png, 1024×1024 square, transparent PNG, no text.
Same flat vector style as before (navy outlines, indigo/violet/mint/amber/coral palette, slight isometric, generous padding). No mascot.
Icon: a compact isometric keyboard key standing upright (blank, no letter), a round translucent soap bubble floating above it holding a tiny chubby pastel creature, a small candy-coloured castle turret behind. Bold simple shapes, very few details, must be readable at 44 pixels.
```

### Project page heroes (about 240×160 on screen, keep Bit big and props few)

```text
Image 4 of 21: hero-portfolio.png, 1536×1024 landscape, transparent PNG, no text.
Same flat vector style as before, with Bit the robot mascot exactly as in the reference image (white 1U-server cube body, navy face screen, mint green eyes, antenna with LED).
Bit as a proud gallery curator hanging a framed picture on a small exhibition wall. The wall already holds two other small frames with abstract shapes (a browser window, a mountain-and-sun sketch). Bit wears a tiny beret, a painter's palette and brush rest on a stool beside them, a calm lake-blue accent in one frame. Warm, tidy, slightly artsy. Mood: showing off the best work.
```

```text
Image 5 of 21: hero-status.png, 1536×1024 landscape, transparent PNG, no text.
Same flat vector style as before, with Bit the robot mascot exactly as in the reference image (white 1U-server cube body, navy face screen, mint green eyes, antenna with LED).
Bit as a friendly doctor pressing a stethoscope against a small server rack whose lights glow mint green, holding a clipboard showing a simple heartbeat line and a little bar chart drawn as plain shapes. A floating heart with a pulse line and a small round gauge hover nearby. Mood: caring, attentive check-up.
```

```text
Image 6 of 21: hero-inck.png, 1536×1024 landscape, transparent PNG, no text.
Same flat vector style as before, with Bit the robot mascot exactly as in the reference image (white 1U-server cube body, navy face screen, mint green eyes, antenna with LED).
Bit sits at a small writing desk with a vintage typewriter, ink-stained mitten hands, a giant fountain pen leaning against the desk and an indigo ink pot. Out of the typewriter rises a vertical stack of short story cards, like a scrolling feed, each with a tiny simple picture (an atom, a lightbulb, a globe, a chip) and blank rounded lines. Mood: curious, inspired, explaining big ideas in small bites.
```

```text
Image 7 of 21: hero-play.png, 1536×1024 landscape, transparent PNG, no text.
Same flat vector style as before, with Bit the robot mascot exactly as in the reference image (white 1U-server cube body, navy face screen, mint green eyes, antenna with LED).
Bit grins while gripping a chunky game controller, sitting on top of a small arcade cabinet (blank screen glow). Around them: a cartoon rocket with an amber exhaust trail looping overhead, a tiny desert podracer pod with twin engines kicking up red-rock dust, party confetti, and a small cute (not scary) green cartoon zombie hand poking out of the ground holding a flashlight. Mood: game night with friends, energetic and fun.
```

```text
Image 8 of 21: hero-wordward.png, 1536×1024 landscape, transparent PNG, no text.
Same flat vector style as before, with Bit the robot mascot exactly as in the reference image (white 1U-server cube body, navy face screen, mint green eyes, antenna with LED).
Bit types happily on a floating pastel keyboard (blank keys) while round translucent soap bubbles drift down from above, each holding a tiny chubby pastel creature. One bubble pops into sparkles. Behind, a small candy-coloured storybook castle, and a little round owl guardian perched on Bit's head sending a soft star beam. Mood: cute, cosy, learning a language as a game.
```

```text
Image 9 of 21: hero-default.png, 1536×1024 landscape, transparent PNG, no text.
Same flat vector style as before, with Bit the robot mascot exactly as in the reference image (white 1U-server cube body, navy face screen, mint green eyes, antenna with LED).
Bit unpacks a large open cardboard shipping box from which glowing indigo angle-bracket code symbols (simple shapes, not letters) and a small rocket float out. Packing peanuts scattered around, a roll of tape nearby. Excited, curious expression. Mood: a brand new project just arrived.
```

### Overview and empty state

```text
Image 10 of 21: overview-hero.png, 1536×1024 landscape, transparent PNG, no text.
Same flat vector style as before, with Bit the robot mascot exactly as in the reference image (white 1U-server cube body, navy face screen, mint green eyes, antenna with LED).
Bit stands on top of a small air-traffic control tower holding binoculars, overseeing a tiny town of five small isometric buildings, each topped with a little screen: a browser window with a palette, a monitor with a heartbeat line, an ink pot, a game controller, a bubble with a chubby creature. Thin glowing mint green lines connect the buildings to the tower. Very few, chunky details: it is shown only 150 pixels wide. Mood: everything under watch.
```

```text
Image 11 of 21: empty-analytics.png, 1024×1024 square, transparent PNG, no text.
Same flat vector style as before, with Bit the robot mascot exactly as in the reference image (white 1U-server cube body, navy face screen, mint green eyes, antenna with LED).
Bit stands patiently holding up a completely blank welcome sign on a stick (no writing at all), looking hopefully to the side. A single tumbleweed rolls past on a small patch of sandy ground, a lonely little cactus behind. Gentle, funny, slightly wistful. Mood: no visitors yet, waiting for the first one.
```

### Section icons (28 px on screen, so keep them dead simple)

```text
Image 12 of 21: section-traffic.png, 1024×1024 square, transparent PNG, no text, no numbers.
Same flat vector style as before. No mascot. Tiny UI icon, one single object, extremely simple bold shapes, thick outlines, at most three colours, must be recognisable at 16 pixels, object fills about 80% of the canvas.
A small chart card with a mint green line zig-zagging upwards to the right, ending in an arrowhead.
```

```text
Image 13 of 21: section-sources.png, 1024×1024 square, transparent PNG, no text.
Same flat vector style as before. No mascot. Tiny UI icon, one single object, extremely simple bold shapes, thick outlines, at most three colours, must be recognisable at 16 pixels, object fills about 80% of the canvas.
A signpost with two blank arrow signs pointing in different directions (left and right).
```

```text
Image 14 of 21: section-locations.png, 1024×1024 square, transparent PNG, no text.
Same flat vector style as before. No mascot. Tiny UI icon, one single object, extremely simple bold shapes, thick outlines, at most three colours, must be recognisable at 16 pixels, object fills about 80% of the canvas.
An indigo globe with a coral red map pin stuck in the top.
```

```text
Image 15 of 21: section-pages.png, 1024×1024 square, transparent PNG, no text.
Same flat vector style as before. No mascot. Tiny UI icon, one single object, extremely simple bold shapes, thick outlines, at most three colours, must be recognisable at 16 pixels, object fills about 80% of the canvas.
Three stacked document sheets slightly fanned out, the top one with a folded corner and blank rounded lines.
```

```text
Image 16 of 21: section-engagement.png, 1024×1024 square, transparent PNG, no text, no numbers.
Same flat vector style as before. No mascot. Tiny UI icon, one single object, extremely simple bold shapes, thick outlines, at most three colours, must be recognisable at 16 pixels, object fills about 80% of the canvas.
A round stopwatch with a button on top and a single hand, no numbers on the face.
```

```text
Image 17 of 21: section-technology.png, 1024×1024 square, transparent PNG, no text, no logos.
Same flat vector style as before. No mascot. Tiny UI icon, one single object, extremely simple bold shapes, thick outlines, at most three colours, must be recognisable at 16 pixels, object fills about 80% of the canvas.
A small open laptop with a smartphone standing in front of it.
```

```text
Image 18 of 21: section-live.png, 1024×1024 square, transparent PNG, no text.
Same flat vector style as before. No mascot. Tiny UI icon, one single object, extremely simple bold shapes, thick outlines, at most three colours, must be recognisable at 16 pixels, object fills about 80% of the canvas.
A round radar screen with a sweeping beam and one glowing mint green dot with pulse rings.
```

```text
Image 19 of 21: section-health.png, 1024×1024 square, transparent PNG, no text.
Same flat vector style as before. No mascot. Tiny UI icon, one single object, extremely simple bold shapes, thick outlines, at most three colours, must be recognisable at 16 pixels, object fills about 80% of the canvas.
A coral red heart with a white heartbeat line across it.
```

```text
Image 20 of 21: section-calendar.png, 1024×1024 square, transparent PNG, no text, no numbers.
Same flat vector style as before. No mascot. Tiny UI icon, one single object, extremely simple bold shapes, thick outlines, at most three colours, must be recognisable at 16 pixels, object fills about 80% of the canvas.
A wall calendar page with two ring binders on top and a grid of blank squares, one square highlighted indigo.
```

### Background

```text
Image 21 of 21: world-map.png, 1536×1024 landscape, transparent PNG, no text.
Different from the others: no outlines, no mascot, no objects, and fill the whole width of the canvas instead of centring with padding.
A very simple stylised flat world map made only of evenly spaced small round dots in soft indigo (#6366f1) and light cool grey, continents recognisable but simplified, no borders, no oceans drawn, no labels, no pins, low contrast. It is used as a faint background texture behind a chart.
```

## After downloading

- [ ] Rename each file to the exact name in its message (`group-inck.png`, `hero-play.png`, …). ChatGPT names them randomly.
- [ ] Open each one on a dark background: no white halo, no checkerboard baked in, no stray text. Regenerate if so.
- [ ] Resize to the export size: group icons 132×132, heroes 720×480, `overview-hero` 450×300,
      `empty-analytics` 600×600, section icons 96×96, `world-map` 1200×800.
- [ ] Compress with <https://squoosh.app> (OxiPNG) or <https://tinypng.com>: icons < 15 KB, illustrations < 150 KB.
- [ ] Drop them into `status/frontend/public/art/`.
- [ ] Commit and push (`status: analytics artwork`); the status deploy picks them up. Missing files are simply skipped by the page.
