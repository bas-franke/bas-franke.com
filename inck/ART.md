# inck artwork

The site has slots for a handful of illustrations. Each is optional: a missing file is simply left out, so add them one at a
time. Save finished PNGs with exactly these filenames in [`frontend/public/art/`](frontend/public/art/), commit and push;
the inck deploy picks them up.

| # | Filename | Where it shows | Display size | Generate at | Export at |
|---|----------|----------------|--------------|-------------|-----------|
| 2 | `topic-space-astronomy.png` | Topic pill + cards | 16 px | 1024×1024 | 64×64 |
| 3 | `topic-computing-ai.png` | Topic pill + cards | 16 px | 1024×1024 | 64×64 |
| 4 | `topic-weird-history.png` | Topic pill + cards | 16 px | 1024×1024 | 64×64 |
| 5 | `topic-biology-nature.png` | Topic pill + cards | 16 px | 1024×1024 | 64×64 |
| 6 | `topic-mathematics.png` | Topic pill + cards | 16 px | 1024×1024 | 64×64 |
| 7 | `topic-economics-money.png` | Topic pill + cards | 16 px | 1024×1024 | 64×64 |
| 8 | `topic-design-architecture.png` | Topic pill + cards | 16 px | 1024×1024 | 64×64 |
| 9 | `topic-future-tech.png` | Topic pill + cards | 16 px | 1024×1024 | 64×64 |
| 10 | `topic-default.png` | Any topic without its own icon | 16 px | 1024×1024 | 64×64 |
| 11 | `loading.png` | While the feed loads | ~180 px | 1024×1024 | 600×600 |
| 12 | `empty.png` | No stories yet (feed, topic hub) | ~180 px | 1024×1024 | 600×600 |
| 13 | `notfound.png` | Story or topic not found | ~180 px | 1024×1024 | 600×600 |
| 14 | `footer.png` | The "you are all caught up" card at the end of the feed | ~120 px | 1024×1024 | 330×330 |

Topic icons are now shown per **category** (the feed groups topics into World, Money, Technology, Science and
Society): `topic-weird-history.png` stands for World, `topic-economics-money.png` for Money, `topic-computing-ai.png`
for Technology, `topic-space-astronomy.png` for Science and `topic-design-architecture.png` for Society, with
`topic-default.png` as the fallback. The mapping lives in `frontend/src/components/Art.tsx`.

## How to generate

Use ChatGPT (or the API with `gpt-image-1`/`gpt-image-2`), ask for a **transparent background**, and generate the mascot
(image 1) first. Then attach that image to every later mascot prompt as the character reference so "Inky" stays the
same. After generating: check the background is really transparent, resize to the export size, compress at
<https://squoosh.app> (OxiPNG), and save under the exact filename.

### Setup message (paste first, in one ChatGPT conversation)

```text
I need a set of illustrations for an online magazine called "inck" whose articles are written and illustrated by AI. Use this exact style for every image in this conversation:

STYLE: Mid-century magazine spot illustration. Loose ink line work with gouache fills, visible brush texture, slightly imperfect hand-drawn edges, generous white space. Palette only: warm paper off-white (#faf8f4), ink black (#171412), burnt orange (#d9480f), deep teal (#1f6f8b), mustard (#e8a33d), soft olive (#5b8c5a). Flat lighting, no gradients, no 3D render look, no photo realism. No text, no letters, no numbers, no logos, no watermark.

BACKGROUND: Always a fully transparent background (PNG with alpha). No paper colour behind the subject, no frame, no floor, no shadow on the background.

MASCOT: Our mascot "Inky" is a friendly blob of black ink with a glossy highlight, two simple white oval eyes with black pupils, a tiny expressive mouth, and short stubby arms. It can hold things. Its body ends in a little fountain-pen nib at the bottom, like a tail. Cute, curious, a bit cheeky. Inky must look identical in every image.

Reply "Ready" and wait for my first image request.
```

### Prompts

**1 · `masthead.png`** (Inky)

```text
Image 1, square 1024x1024, transparent background: Inky peeking over the top of an invisible ledge, both stubby arms resting on it, eyes wide with curiosity, a small spark of an idea above its head drawn as three short ink strokes. Simple silhouette, readable at 64 pixels tall.
```

**2–10 · Topic icons** (no mascot). Add this line to each: *"Tiny icon, one single object, bold simple ink shapes with one or two gouache colours, must read clearly at 16 pixels, object fills about 85% of the square."*

| File | Prompt |
|------|--------|
| `topic-space-astronomy.png` | A ringed planet with a tiny moon, drawn in ink with a teal fill. |
| `topic-computing-ai.png` | A single microchip with a few pins and a small spark on top, orange fill. |
| `topic-weird-history.png` | A rolled parchment scroll with a wax seal, mustard fill. |
| `topic-biology-nature.png` | A curled fern frond, olive fill. |
| `topic-mathematics.png` | A protractor with a pencil laid across it, teal fill. |
| `topic-economics-money.png` | A coin with a simple rising arrow drawn across it, orange fill. |
| `topic-design-architecture.png` | A drafting compass standing on a small arch, teal fill. |
| `topic-future-tech.png` | A small rocket at lift-off with two puffs of smoke, orange fill. |
| `topic-default.png` | An open book with a bookmark ribbon, mustard fill. |

**11 · `loading.png`** (Inky)

```text
Image 11, square 1024x1024, transparent background, same Inky: Inky turns the big wheel of a small old-fashioned printing press with both arms, a sheet of paper rolling out of the press, a few motion lines. Energetic, cheerful. Mood: setting the type, the story is on its way.
```

**12 · `empty.png`** (Inky)

```text
Image 12, square 1024x1024, transparent background, same Inky: Inky sits on a blank sheet of paper holding a pencil, looking up thoughtfully, a single question-mark-shaped ink curl above its head (a shape, not a character). Calm, slightly puzzled. Mood: nothing written here yet.
```

**13 · `notfound.png`** (Inky)

```text
Image 13, square 1024x1024, transparent background, same Inky: Inky holds a large magnifying glass and peers through it at an empty spot, its eye comically enlarged by the lens, a few scattered pieces of torn paper around. Funny, not sad. Mood: that page does not exist.
```

**14 · `footer.png`** (Inky)

```text
Image 14, square 1024x1024, transparent background, same Inky: Inky asleep on top of a tidy stack of newspapers, a tiny nightcap on its head, two little sleep bubbles drawn as simple round shapes (no letters), a cup of coffee gone cold beside the stack. Cosy. Mood: the presses rest between editions.
```

### Tips

- If the background comes back white or checkered, reply "Make the background fully transparent" or remove it at remove.bg.
- If Inky starts to drift, re-upload `masthead.png` with the prompt and say "use this exact character".
- The icons are shown very small: if a result is busy, ask for "fewer details, thicker lines".
