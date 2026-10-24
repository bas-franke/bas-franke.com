# play: rules for this project

- **Screenshots follow the games.** After changing what a player sees in a game (arena, world data, HUD, models,
  engine), run `npm run screenshots -- --only <game>` from `play/` and commit `frontend/public/screenshots/` and
  `frontend/src/games/screenshots.json` with the change. A new game gets a capture routine in
  `tools/screenshots/capture.mts`. Details: [SCREENSHOTS.md](SCREENSHOTS.md).
- **The lobby must scale to many games.** The front page is the room list plus one create button; games are compact
  tiles and a searchable picker inside the create dialog, never one big block per game. Game-specific lobby content
  comes from `GAMES` in `backend/src/shared/protocol.ts` and the screenshot manifest, not from hand-written JSX.
- The waiting room's `data-testid="start"` and `data-testid="map-select"` are used by the screenshot tool; keep them.
