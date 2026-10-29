# Last Light → Hotel Lobby: shared brief for all workers

The user replaced the three dark maps with ONE map: a luxury hotel lobby, matching the reference images:
- C:\Users\buunn\AppData\Local\Temp\claude\C--Projects-bas-franke-com\5cfa0a1c-4b50-4c12-9ad4-13780799ba35\images\1.webp (concept sheet: lobby, SWAT operator, materials, props, lighting study)
- ...\images\2.webp (zombie reference: gaunt man in a torn dark suit jacket, dirty shirt, trousers, worn boots; pale veined skin, milky eyes)
- ...\images\3.webp (target in-game look: first-person MP5 with red dot and suppressor, black gloves/sleeves, SWAT team ahead)

Look at them with Read before you start, and again when judging your screenshots. Players are SWAT operators.

## Look
Golden-hour sun pouring through a full-height glass facade: long warm volumetric light shafts, polished dark veined marble
floor with strong reflections of the sunlight and lamps, travertine columns and walls, walnut wood panels, brushed brass
everywhere (table bases, lamps, trims, railings), cream upholstery, potted trees and plants, white flower arrangements,
warm wall sconces and pendant lights, a two-storey atrium with mezzanine balconies (glass + brass railings). High
contrast: bright shafts, warm highlights, deep but not black shadows. The zombies are the horror element; the lobby
itself is gorgeous. ACES-ish filmic grade, slight bloom on brass and lamps.

## Layout (metres; y up; yaw 0 looks down -Z; -Z = north = the glass facade)
- **Atrium (zone `atrium`, always open)**: interior x -12..12, z -18..18, ceiling 12 m. Glass curtain wall on the north
  side (z = -18) with a brass revolving door in the middle (x -2..2) and a glass door either side. Travertine columns
  1.2 m square at x = ±6, z = -12, -4, 4, 12. Reception desk (dark marble top, walnut + brass front, lit underside) along
  the west wall, x -11..-8, z -10..2. Lounge seating (sofas, armchairs, brass round tables, table lamps) on the east half.
  Planters with trees, flower arrangements. Elevator bank (brass doors) on the south wall. Mezzanine balconies at y = 5
  along the east and west walls, 3 m deep, glass+brass railing (visual only, not walkable).
- **Lounge bar (zone `lounge`)**: east wing x 12..24, z -10..10, ceiling 5 m: bar counter, stools, booths, window wall
  on the east side. Opens when the match starts with **4+ players** (humans + bots).
- **Restaurant (zone `restaurant`)**: west wing x -24..-12, z -10..10, ceiling 5 m: tables, chairs, a glass wall to the
  west. Opens with **7+ players**.
- Locked zones are sealed by a closed brass/steel security shutter in the opening between atrium and wing (indestructible
  solid, visible), their entrances are inactive (no zombie spawns), and they are not lit as brightly (only seen through
  the shutter slats). Open zones have their shutter raised.
- **Entrances where zombies break in** (barricades, 6 boards each = plywood/planks nailed across a glass door or a
  broken window): atrium: revolving door, two side doors, 2 south service doors; lounge: 2 on the east wall; restaurant:
  2 on the west wall.
- Outside: a sunlit plaza/street with trees and city buildings beyond the glass (cheap: textured backdrop + a few trees).

## Destructible materials
Add Mat values: `marble`, `travertine`, `walnut`, `glass` (glass shatters fast, low HP), keep the existing ones.
Columns are travertine chunks, the reception desk and bar are marble/walnut chunks, interior walls between zones travertine,
the facade is glass chunks in brass mullions (mullions = indestructible solids).

## Ownership (one owner per file; never edit someone else's file; do NOT commit; the main session commits)
- MAP/RULES worker: backend/src/shared/zombies/{maps,world,constants,protocol}.ts, backend/src/games/zombies/*.
- ENVIRONMENT worker: frontend/src/games/zombies/{world,decor,textures,texgen,texworker,lab}.ts (+ lab html).
- POST worker: frontend/src/games/zombies/post.ts.
- SWAT worker (Blender): survivor.glb + arms.glb, the survivor/arms sections of tools/blender/build_zombies.py.
- ZOMBIE worker (Blender): zombie.glb, the zombie section of build_zombies.py, zombie() in models.ts.
- PROPS worker (Blender): tools/blender/build_props.py → props.glb (hotel furniture), prop() list in models.ts and api.ts `prop` names.
- GUNS worker (Blender): tools/blender/build_weapons.py → weapons.glb.
- Main session: client.ts, viewmodel.ts, Hud.tsx, Room/lobby UI, protocol.ts/GAMES text, README, integration, commits.
api.ts changes: propose them in your report or message the main session; the PROPS worker may extend the prop name union.

## Tooling
- Portable Node 24: C:/Users/buunn/AppData/Local/Temp/claude/C--Projects-bas-franke-com/8dab55c6-e7c6-496f-b912-fb805e6169bc/scratchpad/node24/node-v24.22.1-win-x64/node.exe
- Blender 5.2: C:\Program Files\Blender Foundation\Blender 5.2\blender.exe (headless; no Blender MCP is connected)
- The desktop browser pane is shared and hidden (1 fps, stale screenshots). Use headless Chrome via Playwright
  (play/node_modules/playwright; see play/tools/screenshots/capture.mts and scratchpad/gfx/zshot.mjs) on your own Vite
  port: ENV 5201, POST 5202, MAP 5203 (+ backend 3021), main session 5194/3004.
- Compare your screenshots against the reference images side by side and iterate until they match in spirit.
