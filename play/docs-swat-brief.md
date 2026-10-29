# SWAT operator: shared brief (5 workers)

Reference (the ONLY target now): C:\Users\buunn\AppData\Local\Temp\claude\C--Projects-bas-franke-com\5cfa0a1c-4b50-4c12-9ad4-13780799ba35\images\5.webp
("SWAT / character model reference": front, left, back, 3/4; equipment overview; detail crops; material samples).
Study it with Read before you start and whenever you judge a render. Previous attempt (too knitted, no goggles, crate
carrier): scratchpad\swat2\op_sheet.png.

Key look: dark NAVY ripstop combat shirt and trousers (not black; ~#1f2433), black nylon gear, black rubber/polymer.
Ballistic high-cut helmet with rails and NVG shroud, clear ballistic goggles over the eyes (eyes visible), black knit
balaclava/face mask below the goggles, over-ear comms headset with boom mic. Plate carrier with a white "SWAT" patch on
the front and back, three 5.56 mag pouches, radio pouch with antenna, admin/utility pouch, shoulder "SWAT" patch on the
left sleeve, medic pouch with a cross at the back of the belt, tactical belt with buckle and pouches, right-hip drop
holster with pistol, thigh strap, hard knee pads, tactical gloves with knuckle armour, high tactical boots with laces.
Realistic proportions: athletic male ~1.83 m, A-pose for modelling, then posed by the rig.

## Pipeline (play/tools/blender/swat/, intermediates in play/tools/blender/swat/out/ = gitignored scratch)
Every worker uses local headless Blender 5.2 (C:\Program Files\Blender Foundation\Blender 5.2\blender.exe; no MCP).
1. BODY worker → `swat_body.py` → out/swat_body.blend: armature `Survivor` with the contract bones (root, hips, spine,
   chest, neck, head, upperarm.L/R, forearm.L/R, hand.L/R, thigh.L/R, shin.L/R, foot.L/R; Blender +Y front; origin
   at the feet), an A-posed athletic body (hidden under clothes; hands and neck matter), and the navy uniform draped
   with cloth simulation (combat shirt with sleeve pockets, collar, cuffs; trousers with cargo pockets, knee seams,
   bloused into boots), auto-weighted. **Ship a first usable version within 20 minutes** (other workers fit gear to
   it), then refine in place.
2. HEAD worker → `swat_head.py` → out/swat_head.blend: helmet (rails, NVG shroud, Velcro panels), clear goggles with
   strap, headset with boom mic, knit balaclava shaped to a real face (nose, brow, cheeks, chin), eyes + brow skin
   visible through the goggles. Fit to out/swat_body.blend's head (until it lands, a 1.83 m mannequin head at the
   same height: crown ~1.83 m).
3. TORSO worker → `swat_torso.py` → out/swat_torso.blend: plate carrier (front/back plates, cummerbund, shoulder pads,
   MOLLE as flat crisp nylon rows), 3 mag pouches with bungee/flap tops, radio + antenna, admin pouch, SWAT patches,
   tactical belt with pouches and medic pouch, drop holster with pistol and thigh strap, left-sleeve SWAT patch
   decal. Fit to the body.
4. LIMBS worker → `swat_limbs.py` → out/swat_limbs.blend: tactical gloves (knuckle armour, padded fingers, wrist
   strap; fingered, shaped to the body's hands), hard knee pads with straps, high tactical boots (sole lugs, toe cap,
   laces and eyelets, ankle padding). Fit to the body.
5. FINISH worker (the existing SWAT worker) → `play/tools/blender/build_swat.py` assembles 1-4 from out/*.blend,
   bakes materials per the reference's samples (nylon weave, ripstop grid, rubber, metal, polymer; fine scale!),
   transfers weights so all gear follows the rig, ports the clips (idle, walk, run, downed, reload) with the rifle
   hold poses, keeps the `Team` material only on a small armband/patch, exports frontend/public/models/zombies/
   survivor.glb (≤ 30k tris, ≤ 5 MB), and verifies in the game (headless; see play/tools/screenshots/capture.mts).
Objects in each part file: put everything in one collection named after the file (`Head`, `Torso`, `Limbs`), in final
world-space position on the A-posed body, applied transforms, material names prefixed by part (`Head_Helmet`, ...).
Each part ≤ 8k tris at export; keep a high-poly copy (custom property `high`) for baking if you sculpt detail.

## Rules
- Only edit your own script; never another worker's file. Don't commit (the main session commits).
- Compare your renders with the reference crops side by side (render in a neutral light-grey studio like the sheet) and
  iterate on your own.
- Upload a comparison image when you have a solid result: from the repo root,
  `node status/tools/upload-screenshot.mjs --project play --title "<what>" --source "agent: swat <part>" <file.jpg>`
  (token in .env.screenshots; if it fails, say so in your report).
- Portable Node 24 for Node scripts: C:/Users/buunn/AppData/Local/Temp/claude/C--Projects-bas-franke-com/8dab55c6-e7c6-496f-b912-fb805e6169bc/scratchpad/node24/node-v24.22.1-win-x64/node.exe
- Report what your file contains (objects, materials, tris) when done.
