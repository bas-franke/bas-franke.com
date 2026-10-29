# Characters in Blender: shared brief

The user wants every character modelled in Blender (no downloaded assets), as close as possible to:
- zombie: C:\Users\buunn\AppData\Local\Temp\claude\C--Projects-bas-franke-com\5cfa0a1c-4b50-4c12-9ad4-13780799ba35\images\2.webp
- SWAT operator + first person: ...\images\1.webp (character sheet, helmet/glove/boot/plate carrier details) and ...\images\3.webp
Current results (too mannequin-like, blotchy): scratchpad\zprev\sheet_full.jpg, scratchpad\swat\prev\op_sheet.jpg.

Blender 5.2 headless: C:\Program Files\Blender Foundation\Blender 5.2\blender.exe (no MCP). Use real modelling techniques
from Python, not just primitives:
- Anatomy: a proper base mesh (box/edge modelling or the Skin modifier on a skeleton graph → Subdivision → shape with
  scripted sculpt strokes (`bpy.ops.sculpt.brush_stroke` with stroke paths), Multires + Displace from procedural
  textures for wrinkles, veins and pores; correct human proportions (8 heads tall, real hands with 5 jointed fingers).
- Clothing: model garment panels and run Blender's cloth simulation in background mode to drape them on the body (bake a
  few dozen frames, apply), add Solidify for thickness, tear holes with booleans/vertex deletion, fray edges.
- Hair: hair curves → converted to hair cards with an alpha texture, or strand-like card meshes.
- Textures: high-to-low bake (normal, AO, curvature) in Cycles on the GPU, plus painted procedural albedo/roughness
  (skin subsurface tones, veins, lesions, dirt, blood, fabric weave), ≤ 2048, embedded in the GLB (WebP/JPEG).
- Skinning: automatic weights (`parent_set(type='ARMATURE_AUTO')`) then fix, so cloth deforms with the body.
Budgets: zombie variant ≤ 30k tris, zombie.glb ≤ 10 MB total; survivor ≤ 30k tris, ≤ 4 MB; arms ≤ 10k, ≤ 1.5 MB.

## Contracts the game relies on (must not change)
- Armature bones: root, hips, spine, chest, neck, head, upperarm.L/R, forearm.L/R, hand.L/R, thigh.L/R, shin.L/R, foot.L/R.
  Blender +Y front (glTF -Z), origin at the feet, ~1.78 m tall.
- zombie.glb: 4 variants (0 businessman = reference 2, 1 bellhop, 2 housekeeper, 3 businesswoman), part groups named
  `Zombie_<Body|Head|ArmL|ArmR|LegL|LegR>_<k>` (dismemberment hides a group), materials Cloth and ClothB tinted by the
  game, plus Skin, Blood, Eyes, Teeth, Hair, Shoe, Shirt, Trim, Mouth. Clips: idle, walk (1.3 s slow shamble), jog,
  crawl, attack (strike at 0.55 s), tear, vault, rise, death_back, death_fwd (in place). models.ts zombie() picks the
  variant and hides the others.
- survivor.glb: same skeleton, materials Team (armband/patches only), clips idle, walk, run, downed, reload with the rifle
  hold poses; models.ts computes the `grip` point from the right hand in the idle pose.
- arms.glb: meshes ArmR/ArmL, origin at the camera, -Z forward, right palm (0.12, -0.21, -0.33), left palm
  (0.02, -0.19, -0.53) (viewmodel.ts moves ArmL for pistols and handguards).

## Zombie pipeline (three stages, one owner each; files in play/tools/blender/zombie/, intermediates in
play/tools/blender/zombie/out/ (gitignored scratch, never commit .blend files))
1. `stage1_body.py` (BODY worker) → out/zombie_body.blend: the armature + 4 nude/base bodies with heads (variant
   collections `V0`..`V3`), anatomy sculpted, eyes/teeth/mouth interior, hands with fingers, auto-weighted. Ship a first
   usable version within ~25 minutes, then keep refining in place.
2. `stage2_cloth.py` (CLOTH worker) → reads out/zombie_body.blend, writes out/zombie_dressed.blend: draped, torn, frayed
   garments per variant (suit jacket with lapels/pockets + shirt + belt + trousers + boots; bellhop uniform + pillbox cap;
   housekeeper dress + apron + tights; blouse + pencil skirt + one shoe), weighted to the armature. Until stage 1 lands,
   develop on a body exported from the current build_zombies.py.
3. `stage3_finish.py` (FINISH worker) → reads out/zombie_dressed.blend: hair cards, all materials and bakes, the 10
   animation clips (port them from build_zombies.py), part grouping for dismemberment, decimation to budget, export
   frontend/public/models/zombies/zombie.glb; updates tools/blender/run_zombies.mjs so `npm run models:zombies -- zombie`
   runs stages 1-3, and adjusts models.ts zombie() only if needed. Until stage 2 lands, develop on the current zombie.
Each stage re-runs the earlier stages' scripts only via their CLI, never edits them.

## Others
- SWAT worker: tools/blender/build_swat.py (new) → survivor.glb (stop using the survivor section of build_zombies.py;
  update run_zombies.mjs minimally so `survivor` runs build_swat.py). Same techniques; reference 1 sheet.
- ARMS worker: tools/blender/build_arms.py (new) → arms.glb (likewise take over `arms`), reference 3 gloves; verify in the
  real game viewmodel (headless Playwright on your own Vite port, see play/tools/screenshots/capture.mts).
- Verify everything with renders compared side by side with the references, and a Node GLTFLoader load check.
  Don't commit; the main session commits.
- Ports for your own Vite/backends if you need them: BODY 5211, CLOTH 5212, FINISH 5213 (+3033), SWAT 5214, ARMS 5215 (+3035).
- Portable Node 24: C:/Users/buunn/AppData/Local/Temp/claude/C--Projects-bas-franke-com/8dab55c6-e7c6-496f-b912-fb805e6169bc/scratchpad/node24/node-v24.22.1-win-x64/node.exe
