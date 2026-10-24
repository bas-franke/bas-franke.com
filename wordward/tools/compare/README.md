# compare

Renders a staged, repeatable Wordward scene in headless Chromium, puts it next to `reference.webp`, and measures
what a frame costs.

```sh
# from wordward/, with Node 24 on PATH (see BRIEF.md); `npm install` there once for playwright
node tools/compare/compare.mjs --help
node tools/compare/compare.mjs --port 5207                    # play scene at 1536x1024
node tools/compare/compare.mjs --port 5207 --size 390x844     # phone
node tools/compare/compare.mjs --port 5207 --scene menu       # or map
node tools/compare/compare.mjs --port 5207 --scene defeat     # or sentence, boss, bonk
```

- Starts its own Vite dev server on `--port` (default 5201, use your own to avoid clashes) and stops it at the end.
  No backend: the game runs as a guest, the `/api` 502s are expected and listed apart from real errors.
- `Math.random` is seeded (`--seed`), animation frames are disabled and `performance.now` runs on a virtual clock
  during staging; every frame is `__ww.engine.step(1/60)`. Shots repeat run to run (sub-pixel beam edges aside).
- Play scene: free play started via the UI, the game's spawner held back, `--creatures` (6) spawned and spread over
  the field, `--letters` (3) correct letters typed at the target, `--settle` (4) frames, then the shot.
- Moment scenes, staged the same way (same seed, spawner held back) to look at effects:
  - `--scene defeat`: every letter of the target (shield word, then its word) typed 2 frames apart, a 40-frame
    pause, then the last letter; the shot is `--settle` (6) frames later, with the defeat poof and ink mid-flight.
    Try `--settle 20` for droplets landing as floor splats.
  - `--scene sentence`: the round restarted with sentences only; a sentence convoy (ink slimes in one wide shield)
    leads, `--creatures` (3) escort it, `--letters` typed into the shield.
  - `--scene boss`: wave set to 5 and the Bookwyrm spawned with the private `spawnBoss()` (three heads, a shield
    each); `--creatures` (2) escort it, `--letters` typed at the closest head.
  - `--scene bonk`: the closest creature is put on the defence line and stepped until it hits (dust, red flash),
    then `--settle` (6) frames.
  - The perf JSON's `staged` adds `callsAtShot` (draw calls of the shot frame), `callsBefore` (defeat/bonk: the
    frame before the last letter / the hit) and `effectMeshesAtShot` (effect meshes drawing at the shot).
- Outputs in `out/` (git-ignored): `<name>-current.png`, `<name>-compare.png` (reference left, current right),
  `<name>-perf.json`. `<name>` is the scene, plus `-WxH` when not 1536x1024.
- Perf: `--frames` (120) steps timed in JS (simulation + render), `renderer.info` draw calls/triangles, programs,
  geometries/textures in memory, lights, and a per-top-level-object breakdown (name your groups to make it
  readable). SwiftShader renders in software: ms are only comparable between runs; counts are real.
- Exit code 2 when the page threw errors, 1 when the script failed.
