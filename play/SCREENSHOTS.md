# Game screenshots

The lobby shows every game with real screenshots: as the cover on the game tiles and in the open-room list, in the
game picker of the create-room dialog, in the game details view (all of them, as a gallery) and on the room page.
A player should be able to tell from the lobby what a game will look like, so **the screenshots must match the
current look of the game**.

## The rule

> After changing anything a player sees in a game, regenerate that game's screenshots and commit them with the change.

That covers the arena or world rendering (`frontend/src/games/<game>/arena.ts`, `client.ts`), the HUD
(`frontend/src/games/<game>/Hud.tsx` and the HUD rules in `styles.css`), the engine (`frontend/src/engine/`, lighting,
post-processing), the 3D models (`frontend/public/models/`, built by `tools/blender/`), the shared world data
(`backend/src/shared/<game>/`: Rockets maps, Ruckus layouts) and the minigame or map pool (a new Rockets map is a
good reason to add it to the shots, see below). Lobby-only changes do not need new screenshots.

```bash
npm run screenshots -- --only rockets
```

Run it from `play/`. Omit `--only` to redo every game. Commit `frontend/public/screenshots/` and
`frontend/src/games/screenshots.json` together with the game change. If the run fails or a shot looks wrong, say so
in the commit message rather than committing stale images.

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
4. Writes `frontend/public/screenshots/<game>-<variant>.jpg`, deletes that game's old files, and rewrites
   `frontend/src/games/screenshots.json` (the list the frontend imports; the first entry of a game is its cover).

`--headful` shows the browser, `--verbose` prints the server output. The run needs Node 22.12+ (the dev server
requirement) and `npm run install:all` once.

The script talks to the games through two dev-only handles that exist only on the Vite dev server:
`window.__playClient` (the mounted game client, set in `frontend/src/room/Room.tsx`) and, for Rockets,
`window.__rockets.debugCam`. The waiting room's Start button and map select carry `data-testid="start"` and
`data-testid="map-select"`; keep those when changing the room page.

## Adding a game

1. Add a `shoot<Game>` function in `tools/screenshots/capture.mts` and register it in `shooters`. Reuse
   `startMatch()`; then wait for whatever state makes a good picture (read it from `window.__playClient.hud.get()`),
   and call `screenshot(page, '<game>-<variant>.jpg')`. One shot is enough; several variants make the gallery useful.
2. Run `npm run screenshots -- --only <game>` and commit the images plus the manifest.

Until a game has screenshots the lobby shows an accent-coloured placeholder for it, so nothing breaks in between.
