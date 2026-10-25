# Game screenshots

The lobby shows every game with real screenshots: as the cover on the game tiles and in the open-room list, in the
game picker of the create-room dialog, in the game details view (all of them, as a gallery) and on the room page.
A player should be able to tell from the lobby what a game will look like, so **the screenshots must match the
current look of the game**. Last Light also has **key art**: HUD-free 1920×1080 frames of the hotel for its menu and
loading screens (`frontend/public/art/lastlight/`, listed in `frontend/src/games/zombies/art.json`), made by the same run.

## The rule

> After changing anything a player sees in a game, regenerate that game's screenshots and commit them with the change.

That covers the arena or world rendering (`frontend/src/games/<game>/arena.ts`, `client.ts`), the HUD
(`frontend/src/games/<game>/Hud.tsx` and the HUD rules in `styles.css`), the engine (`frontend/src/engine/`, lighting,
post-processing), the 3D models (`frontend/public/models/`, built by `tools/blender/`), the shared world data
(`backend/src/shared/<game>/`: Rockets maps, Ruckus layouts) and the minigame or map pool (a new Rockets map is a
good reason to add it to the shots, see below). Lobby-only changes do not need new screenshots.

```bash
npm run screenshots -- --stale          # every game whose graphics changed since its last capture
npm run screenshots -- --only rockets   # one game, whatever its state
npm run screenshots:check               # which games are stale (exit code 1 if any)
```

Run them from `play/`. Omit `--only` to redo every game. Commit `frontend/public/screenshots/`,
`frontend/src/games/screenshots.json` and `frontend/src/games/screenshots.lock.json` (and for Last Light
`frontend/public/art/lastlight/` and `frontend/src/games/zombies/art.json`) together with the game change. If the run
fails or a shot looks wrong, say so in the commit message rather than committing stale images.

### Staleness: fingerprints and the lock file

[tools/screenshots/inputs.mjs](tools/screenshots/inputs.mjs) lists, per game, the files its pictures are made from
(`INPUTS`: globs relative to `play/`, `!` excludes). A game's **fingerprint** is a sha256 over the sorted paths and
contents of those files (text with LF line endings, so Windows and CI agree). After a successful capture the script
writes the fingerprint of every game it shot to `frontend/src/games/screenshots.lock.json`:

```json
{ "zombies": { "hash": "<sha256 hex>", "at": "2026-10-25T12:00:00.000Z" } }
```

A game is **stale** when its current fingerprint differs from the lock (or it has no entry). `npm run screenshots:check`
prints every game as fresh or stale; `--stale` captures only the stale ones. Last Light's entry covers its screenshots
and its key art, so it is only updated by a run that redid both (`--only zombies`, not `--only zombies-art`). Games
without a capture routine yet (`routine: false`) are listed but never fail the check.

When a game starts drawing from a new place (a new folder, model pack or shared module), add it to its `INPUTS` entry.
Changes to `capture.mts` itself do not mark anything stale: after changing a game's capture routine, rerun it with
`--only`.

The deploy workflow (`.github/workflows/deploy-play.yml`) runs the checker before the build and adds a
`::warning::` annotation per stale game. It never blocks a deploy; the fix is a capture run and a commit.

## What `npm run screenshots` does

[tools/screenshots/capture.mts](tools/screenshots/capture.mts) plays each game against bots in a headless browser:

1. Starts the backend on port 3034 and the Vite dev server on port 5205 (`frontend/vite.screenshots.config.ts`),
   so a dev server you have open keeps running. Override with `PLAY_SHOT_BACKEND_PORT` / `PLAY_SHOT_FRONTEND_PORT`.
2. Starts Chrome, else Edge, else Playwright's own Chromium (`--browser chrome|msedge|chromium` to pick one). Chrome
   and Edge are used as installed; the bundled Chromium needs `npx playwright install chromium` once.
3. Per game, creates a room with five bots through the API, opens it as the host, presses Start, waits until the
   game reports `ready`, hides the control hints and takes a 1280×720 JPEG of the whole page, HUD included.
   - **Rockets**: one room per map (`--maps foundry,skyway,canyon,orbit` is the default; any map id from
     `backend/src/shared/rockets/maps.ts` works), camera parked above the highest spawn point looking at the centre.
   - **Ruckus**: one five-round match, a shot a few seconds into the play phase of every minigame. Takes a few minutes.
   - **Last Light key art** (part of `--only zombies`, or by itself with `--only zombies-art`): one more match with
     eight bots, so the lounge bar and the restaurant are open, in its own 1920×1080 page. Once the first wave is at
     the boards it moves the camera through the shots in `ART_SHOTS` (a camera position and a look-at point each, or
     a close-up of the SWAT bot nearest the facade) using the client's `cinematic` camera, which hides the HUD and the
     viewmodel, and saves `frontend/public/art/lastlight/<id>.jpg` (JPEG quality 86).
4. Writes `frontend/public/screenshots/<game>-<variant>.jpg`, deletes that game's old files, and rewrites
   `frontend/src/games/screenshots.json` (the list the frontend imports; the first entry of a game is its cover). The
   key art goes to `frontend/src/games/zombies/art.json` (the first entry is the default picture), old art is deleted.
5. Records the fingerprints of the games it shot in `frontend/src/games/screenshots.lock.json`.

`--headful` shows the browser, `--verbose` prints the server output. The run needs Node 22.12+ (the dev server
requirement) and `npm run install:all` once.

The script talks to the games through two dev-only handles that exist only on the Vite dev server:
`window.__playClient` (the mounted game client, set in `frontend/src/room/Room.tsx`) and, for Rockets,
`window.__rockets.debugCam`, for Last Light `window.__zombies.cinematic` (`{ x, y, z, yaw, pitch, fov? }`, yaw 0 looks
north down −Z, positive pitch looks up). The waiting room's Start button and map select carry `data-testid="start"` and
`data-testid="map-select"`; keep those when changing the room page.

## Adding a game

1. Add a `shoot<Game>` function in `tools/screenshots/capture.mts` and register it in `shooters`. Reuse
   `startMatch()`; then wait for whatever state makes a good picture (read it from `window.__playClient.hud.get()`),
   and call `screenshot(page, '<game>-<variant>.jpg')`. One shot is enough; several variants make the gallery useful.
2. Add the game's inputs to `INPUTS` in `tools/screenshots/inputs.mjs` (or set `routine: true` on its entry).
3. Run `npm run screenshots -- --only <game>` and commit the images, the manifest and the lock file.

Until a game has screenshots the lobby shows an accent-coloured placeholder for it, so nothing breaks in between.
