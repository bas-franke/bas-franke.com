# Wordward redesign brief (shared by every agent)

Target look: `tools/compare/reference.webp` (1536×1024). Open it first and study it.

**What it shows:** a cozy enchanted library courtyard at dusk, seen from high above and in front (camera pitched
~55–60° down, slight perspective so the far end is narrower). A long floor of mossy grey-green stone tiles with faint
carved rune circles fills the middle. Both sides are tall wooden bookshelves full of books, warm brass lanterns
glowing, ivy, white flowers, red mushrooms, stacked books, red and green cushions, arched windows with a starry night
sky, a brass globe. Lighting is warm golden lamp light with soft shadows. Not cel-shaded: soft, painterly, warm.
Creatures are small, cute, chunky: black fluffy soot sprites carrying books, a snail with a parchment-scroll shell, a
glowing golden moth fairy with a red banner, teal ink-slime drops. At the bottom: a little wizard in a green pointy hat
and cream scarf holding a candle, and a round cream/teal robot cannon that fires a bright green laser. Hit letters fly
off as golden glowing glyphs with ink splashes. HUD: three pink hearts top-left, "Wave 3" on a parchment banner with
leaves at top-centre, score top-right in white, a parchment text box at bottom-centre showing what is being typed
("maan |" with an enter icon), and small parchment speech-bubble word labels in a serif font above creatures.

**Keep the gameplay:** EN→RO learning, bubble shield (type the word you read, then its translation), the closest
creature is the target, waves, campaign, accounts optional. Guest mode must keep working with no backend/database.

## Coordinates (contract)

- y is up. The floor is the plane y = 0. The play field lies on the floor: x ∈ [-halfWidth, +halfWidth] across the
  screen, creatures start far away (top of the screen, negative z) and walk/fly towards the defenders at the bottom
  (positive z). Game logic keeps its scalar `e.y` = distance left to the defence line; world position is
  `(x, groundOffset, LINE_Z - (e.y - IMPACT_Y))` — the floor/camera agent owns this mapping in `Game.ts`.
- **Creature models** (`Model` in enemies.ts): origin at the ground contact point (y = 0 under the creature), body
  above it, facing +z (towards the camera/defenders), designed to read well from ~55° above. About 1 unit radius
  before the game's `CREATURE_SCALE` (1.45). `Model` gains `height` (top of the creature above its origin, for label
  placement). Flying creatures hover inside their own model (the root stays at y = 0).

## File ownership (do not edit files you do not own; read anything)

| Agent | Owns |
|-------|------|
| library | `frontend/src/game/library.ts` (new): `buildLibrary(scene, opts)` side walls + props |
| stage   | `frontend/src/game/world.ts`, `Game.ts` (only camera/mapping/tag-position/impact code), defenders |
| critters| `frontend/src/game/enemies.ts` (small creatures) |
| boss    | `frontend/src/game/boss.ts`, `frontend/src/game/shield.ts` (new; balaur + bubble shield) |
| ui      | `frontend/src/styles.css`, `frontend/src/App.tsx`, `frontend/index.html` |
| look    | `frontend/src/game/toon.ts`, `effects.ts`, `engine.ts` (materials, effects, renderer, perf) |
| compare | `tools/compare/*` (except this brief and the reference), root `wordward/package.json` devDependencies |

Exported APIs others use must stay compatible (names and signatures), or be extended only:
`toon(color)`, `flat(color)`, `inkMaterial()`, `hullGeometry()` (toon.ts); `Effects` methods `beam`, `sparkles`,
`ring`, `poof`, `pop`, `dust`, `update`, `clear`; `World` interface in world.ts; `makeModel`, `makeBalaurBody`,
`makeHead`, `makeBubble`, `tickBubbles`, `Model`, `Bubble`, `Kind` exported from enemies.ts (re-exports are fine).

## Rules

- Node 24: `export PATH="/c/Users/buunn/AppData/Local/Temp/claude/C--Projects-bas-franke-com/8dab55c6-e7c6-496f-b912-fb805e6169bc/scratchpad/node24/node-v24.22.1-win-x64:$PATH"`.
  Type-check with `npx tsc --noEmit` in `wordward/frontend`. It must pass when you finish.
- Do **not** commit, stage, stash, reset or checkout anything in git. Other sessions share this checkout.
- Performance matters: target 60 fps on a mid phone. Merge static geometry or use `InstancedMesh` for repeated
  props (books, tiles, leaves, flowers), keep real lights few (≤ 3–4; fake lamp glow with additive sprites/emissive),
  no per-frame allocations, no shadow maps unless cheap. Report draw calls/triangles for your part.
- Everything procedural (no downloaded assets); canvas-generated textures are fine.
- Screenshots: once `tools/compare/compare.mjs` exists, run it (`node tools/compare/compare.mjs --help`) to see the
  game next to the reference. Use a unique `--port` so you do not clash with other agents.
