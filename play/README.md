# play: play.bas-franke.com

Small online multiplayer games in the browser. No accounts: you host a room, get a four-letter code, share it, and the
room lives exactly as long as someone is in it. Empty seats can be filled with bots. Vite + React + three.js frontend,
Node.js + Express + `ws` backend on port **3004**. No database; rooms live in memory.

| Game        | What it is                                                                                              |
|-------------|---------------------------------------------------------------------------------------------------------|
| **Dustrunners** | Single-player podracing through red-rock canyons at `/race`: career (cups, prize money, garage), quick race, time trial against AI pilots. Not a room game: listed in the lobby from `SOLO_GAMES`. |
| **Rockets** | First-person rocket arena (Quake 3 "rockets only"): infinite rockets, splash damage, rocket jumps, jump pads, health packs. 5 minutes or 15 frags. |
| **Garden Sentinels** | Cozy sci-fi tower defense for 1 to 6 players: build and upgrade five kinds of towers along garden paths against crystal aliens. Co-op (one garden, 30 waves) or versus (everyone defends their own garden and sends enemies at the others). |
| **Last Light** | Co-op zombie survival for 1 to 10 SWAT operators (bots fill in): endless waves in a fully destructible grand hotel lobby. Board up the doors, buy guns old and new, ammo, grenades and armor with points, revive each other. |

Every room game supports bots (easy / normal / hard), chosen when the room is created or changed by the host in the room.

## How it works

```
frontend/src/                          backend/src/
├── lobby/      server list, create    ├── index.ts     Express: /api/health, /api/games, /api/rooms
│               dialog, game tiles     ├── net.ts       WebSocket endpoint /api/ws?room=CODE&name=Nick
├── room/       waiting room, chat,    ├── rooms.ts     Room lifecycle, host, bots, auto-close
│               mounts the game        ├── games/
├── ui/         header, dialogs,       │   ├── rockets/ server.ts (sim + rules), bots.ts, nav.ts
│               screenshot gallery     │   └── garden/  server.ts (loop, snapshots), sim.ts, bots.ts
├── engine/     three.js wrapper,      └── shared/      ← imported by the frontend as @shared/*
│   input, interpolation, models,          ├── protocol.ts   lobby/room messages, game metadata
│   effects, synthesized audio             ├── math.ts
└── games/                                 ├── rockets/      constants, map(s), physics, protocol
    ├── catalog.ts  screenshots per game   └── garden/       constants, towers, enemies, maps, board, protocol
    ├── rockets/ client.ts, arena.ts,
    │            Hud.tsx
    └── garden/  client.ts, Hud.tsx and one module
                 per concern (api.ts)
```

- **One source of truth for rules.** `backend/src/shared/` holds the protocol, the arena and all movement physics.
  tsc compiles it into the backend; Vite imports the same files through the `@shared` alias (`vite.config.ts`,
  `frontend/tsconfig.json`). Nothing in `shared/` may touch Node or DOM APIs.
- **Server-authoritative.** Each room runs its own 30 Hz loop. Players send input commands (60 per second, batched);
  the server replays them through the shared physics, runs the bots, resolves hits, and broadcasts one snapshot per
  loop. The client predicts its own movement with the same physics and reconciles on every snapshot; everyone else is
  interpolated 100 ms in the past; rockets are extrapolated along their velocity.
- **Rooms close themselves.** A room with no connected humans is closed after 15 s (so a page refresh survives); a
  freshly created room nobody joins closes after 60 s. Bots do not keep a room alive. The host is the first human; it
  passes to the next human when they leave. At most 40 rooms run at once (`MAX_ROOMS`).
- **Guests first, accounts optional.** Every page asks for a nickname (or a login) once; guests keep it in the
  `play_name` cookie plus a random device id in `play_id`, which the server uses to put you straight back into a running
  match after a refresh. An account (`backend/src/accounts.ts`, email + password, activated by mail) syncs the nickname
  and a copy of this site's browser storage (settings, progress) to other devices. Activation and password reset mails
  go through SendGrid (`mail.ts`); the session is an HttpOnly `play_sid` cookie on `/api`. Without `DATABASE_URL` the
  site runs guests-only.
- **Lobby links.** Every room is `/room/<CODE>`; the link is copyable in the waiting room and in every game's pause
  menu. Joining while a match runs puts you in the room as *waiting* until the next match starts.
- **Games are modules.** A game implements `GameServer` (backend `games/types.ts`) and `GameClient`
  (frontend `games/types.ts`) and is listed in both `games/registry.ts` files plus `GAMES` in `shared/protocol.ts`.
  Game messages travel inside the `{ t: 'g', m }` envelope; the room never looks inside them.

### Rockets

Ten maps (`shared/rockets/maps.ts`), each 64 to 80 m across and built from axis-aligned boxes with rotational
symmetry: Foundry, Skyway, Canyon, Ziggurat, Spires, Fortress, The Pit, Twin Bases, Downtown and Orbit. Skyway, The Pit
and Orbit float over the void. The host picks one in the room, or leaves it on random (never the same map twice in a
row). `MapBuilder` in `shared/rockets/map.ts` adds the walls plus invisible clip walls up to 60 m so rocket jumps stay
inside. Movement is Quake-style (ground friction/acceleration, air acceleration, CPM-ish air control, step-ups, bunny
hopping) with low gravity (18 m/s², a 2.3 m jump). Rockets fly at 30 m/s; splash damage falls off over 3.8 m and knocks
players back, with self-damage reduced and self-knockback boosted so rocket jumps fly high.
Bots navigate a grid-based nav graph generated from the map (`games/rockets/nav.ts`), strafe, lead their shots, chase
health packs when low and rocket-jump after players on the high ground (normal and hard only).

### Last Light

One map, the Grand Meridian Hotel: a two-storey marble and travertine lobby in golden-hour sun, with a lounge bar
(opens with 4+ players) and a restaurant (7+) behind security shutters. Zombies (hotel guests and staff) rise outside
one at a time, tear the six boards off a door or window and come in; players hold E inside an entrance to nail boards
back (+10 points each, capped per wave). Waves never end: counts and health grow like CoD zombies, a share of later
waves jogs, everyone downed at once ends the match. Players are SWAT operators.

- **Destruction.** `shared/zombies/world.ts` builds every wall and prop out of ~0.5 m chunks with health. Bullets chip
  them, grenades and the Barrett blow holes, zombies bash through when that is much shorter than the nearest window, and
  chunks no longer connected to the floor or ceiling collapse. The server sends only chunk indices and health; both
  sides build the same chunk list from the map id.
- **Zombie AI** (`games/zombies/nav.ts`): one flow field over the room and yard (0.5 m cells), a multi-source Dijkstra
  from every standing player a few times a second. Boarded windows and wall cells cost extra, so zombies go for the
  windows but take a blasted hole as soon as it exists.
- **Shots** arrive as directions (the client rolls the spread) with the server time the shooter was looking at; the
  server rewinds zombies up to 250 ms and traces head sphere, body cylinder and walls. Heavy arm hits take arms off,
  headshot kills take the head, grenades take legs.
- **Client** (`frontend/src/games/zombies/`, contracts in `api.ts`): `client.ts` (input, prediction, weapons, views),
  `world.ts` + `decor.ts` + `textures.ts`/`texgen.ts` (instanced chunks with world-space PBR textures and cracks,
  furniture, chandeliers, the sun), `post.ts` (HDR, volumetric sun shafts through the facade and blasted holes,
  screen-space floor reflections, bloom, auto exposure, grade), `fx.ts` (debris,
  decals, blood, gibs), `audio.ts` (synthesized, with room reverb), `models.ts` (Blender GLBs from
  `tools/blender/build_zombies.py`, `npm run models:zombies`). Graphics quality (low / medium / high) is in the Esc menu.
- Dev labs: `/lab-zombies.html?zones=atrium,lounge` (world + lighting), `/lab-zombies-fx.html`, `/lab-zombies-audio.html`.

### Garden Sentinels

Cozy sci-fi tower defense for 1 to 6 players (bots fill seats). Crystal aliens walk the garden paths from entry portals
to the greenhouse; players build towers on the grass cells beside the paths. Top-down camera: `W A S D` or drag to pan,
wheel to zoom, `Alt` + click pings the map. The host picks the mode in the room; each map belongs to one mode.

- **Co-op**: one garden, 20 shared lives, everyone has their own gold. Survive 30 waves to win. Enemy health and count
  grow with the number of defenders (`coopHp`, `coopCount` in `shared/garden/constants.ts`, read at each wave start).
  A kill pays every defender a share of the bounty, so nobody steals kills. Anyone upgrades or retargets any tower;
  only the builder sells.
- **Versus** (needs two players or bots): everyone defends their own copy of the map against the same base waves and
  spends gold on sends at the others. A board at 0 lives is out; the last garden standing wins.

All numbers live in `shared/garden/` (`towers.ts`, `enemies.ts`, `constants.ts`). The rules the data leaves open are
listed in the comment block at the top of `backend/src/games/garden/server.ts`.

- **Towers** take one 2 m cell and have three levels (level 3 is the gold-trimmed "Masterwork"). Laser Turret:
  continuous beam that ignores armour; level 3 chains to two more enemies. Bubble Shield: towers inside cannot be
  disrupted, enemies inside get zapped; level 3 stuns the disruptor. Slow Flower: 30 / 40 / 50% slow field (the
  strongest field applies, nothing stacks). Missile Pod: splash volleys of 1 / 2 / 3 missiles, weak against armour.
  Energy Beacon: damage and fire-rate aura for nearby towers, plus range at level 3. Laser and missile target first,
  last, strong or close. Selling returns 70% of the gold spent, or all of it in the build phase it was built in.
- **Enemies**: Runner (fast), Skitter (comes in packs of five), Disruptor (bolts the nearest tower in range and
  disables it for 3 s), Crystal Brute (50% armour), and the Prism Colossus boss every tenth wave, which sheds six
  skitters at 75, 50 and 25% health. A leak costs 1 to 10 lives depending on the kind.
- **Waves and economy**: 25 s to build before wave 1, 10 s between waves. `R` marks you ready; when every defender
  is ready the wave starts early and everyone gets 2 gold per second skipped. Wave lists come from `waveSpawns` (the
  HUD previews the next one). Health grows per wave (`waveHp`, plus `vsHpRamp` in versus) and bounties with it.
  Clearing a wave pays a bonus.
- **Sends** (versus): three runners, a skitter pack, a disruptor, a brute or a colossus, unlocked between wave 2 and
  15. A send costs gold now and raises your income (paid at every wave start) for the rest of the match. It queues
  into the target's next wave and enters 4 s in; the defender earns half the bounty. At most `sendCap(n)` sends per
  player per wave. The next build phase starts when every board is clear, or 25 s after the wave's last base spawn.
- **Maps** (`shared/garden/maps.ts`: ASCII grids of 2 m cells plus the routes enemies walk). Co-op: Greenhouse
  Commons, Lily Moat, Terraced Rockery, Sunflower Terraces, Koi Crossing, Moonlit Orchard. Versus (smaller): Seedling
  Plot, Sprout Spiral, Twin Beds, Pebble Loop. Versus boards sit side by side in rows of three (2 x 2 for four).
  Random picks among the current mode's maps.
- **Bots** (`games/garden/bots.ts`) are ordinary players with their own gold; the server applies their actions
  through the same code as human messages (contract in `botapi.ts`). They value every purchase as damage per second
  times metres of path covered, weighted towards the greenhouse and lowered where towers already reach (which spreads
  bots over the entries in co-op), and buy the best value per gold. Easy picks loosely among the top few; normal and
  hard save up for a clearly better purchase. In versus they put part of their gold into sends once their defence holds.
- **Network**: `sim.ts` is the whole simulation with no networking; `server.ts` steps it at 20 Hz and sends a
  snapshot every second tick (10 Hz). Enemies travel as route index, distance along the route and lateral offset.
  Towers only change through events (build, upgrade, sell, targeting), batched per tick into one `ev` message;
  refused actions go privately to that player. In versus each human gets their own snapshot with only their board and
  the board their camera is on (client `view` message); every fourth snapshot carries every board. The client
  interpolates enemies along their route.
- **Client** (`frontend/src/games/garden/`, contracts in `api.ts`): `client.ts` (network, interpolation, camera,
  input, placement), `world.ts` (boards built from the map grid: terrain, paths, water, bridges, foliage, portals,
  greenhouse, sky), `units.ts` (tower and enemy views, health bars, range circles), `fx.ts` (beams, missiles,
  explosions, fields, zaps, deaths, popups), `post.ts` (HDR, bloom, tilt-shift, grade), `ambience.ts` (instanced
  critters and decor around the boards), `audio.ts` (synthesized sound and music), `models.ts` (GLB loading with
  primitive stand-ins), `Hud.tsx` + `hudIcons.tsx` + `garden.css`, `Coach.tsx` (first-time tips, shown once per
  player). Graphics quality (low / medium / high) is in the HUD menu.
- **Models**: `tools/blender/build_garden_{towers,enemies,kit,decor}.py` build
  `frontend/public/models/garden/{towers,enemies,kit,decor}.glb`; `render_garden_portraits.py` renders the HUD
  portraits (`portraits/tower_<kind>_<lv>.webp`, `portraits/enemy_<kind>.webp`) from the tower and enemy GLBs.
  `npm run models:garden` rebuilds everything; `npm run models:garden -- towers` (or `enemies`, `kit`, `decor`,
  `portraits`) rebuilds one part. Missing models fall back to primitives.
- **Dev labs** (no backend needed): `/lab-garden-world.html?map=<id>&boards=<n>`,
  `/lab-garden-units.html?view=towers|enemies|all`, `/lab-garden-fx.html?stress=1`,
  `/lab-garden-ambience.html?map=<id>`, `/lab-garden-hud.html?mode=vs`, `/lab-garden-coach.html?step=<n>`,
  `/lab-garden-audio.html`, `/lab-garden-room.html` (waiting-room panels) and
  `/lab-garden-client.html?map=<id>&mode=coop|vs` (the real client and HUD against a scripted fake server; `sim=real`
  runs the real game server in the page). Each lab lists its options at the top of `frontend/src/games/garden/lab/*`.
- **Tools** (run from `play/` with Node 22+):
  `node backend/node_modules/tsx/dist/cli.mjs tools/garden/checkmaps.ts [-q] [<id> ...]` validates every map (grid,
  portals, greenhouse, routes on path cells, buildable space, route lengths) and prints ASCII renders.
  `node backend/node_modules/tsx/dist/cli.mjs tools/garden/sim.ts --mode coop --bots 3 --diff normal` plays whole
  matches with bots at full speed and prints lives, gold, kills and leaks per wave (`--sweep` runs co-op with 1, 3, 6
  bots and versus with 2, 4, 6; `--bytes` measures snapshot sizes).
  `node backend/node_modules/tsx/dist/cli.mjs tools/garden/test.ts [filter]` runs the rule tests against the
  simulation (no framework; exits 1 on a failure).
  `node backend/node_modules/tsx/dist/cli.mjs tools/garden/soak.ts --url http://127.0.0.1:3004 [--rooms 6] [--minutes 5]`
  connects fake WebSocket players (plus garbage and malicious messages) to a running backend and checks traffic,
  snapshot timing, errors and that matches end; start that backend with `CREATE_RATE_LIMIT=1000`.

### Dustrunners (work in progress)

A single-player podracer at `/race`, in the painted canyon style of a concept art piece: career mode (four cups, prize
money, a garage with pods and upgrades), quick race and time trial against AI pilots. Client-only (no backend, career
saved in localStorage), so it lives outside the room system: it is in `SOLO_GAMES` (shared/protocol.ts), which the lobby lists with a Play button that opens `/race`. Code in
`frontend/src/racer/`: `core/` (track splines, flight model in track space, AI racing line, race rules, career),
`world/` (one module per part of the scenery; `zones.ts` decides where things go), `vehicle/` (procedural pods),
`fx/` (camera, controls, speed particles, post-processing), `audio/` (synthesized), `ui/` (HUD and menus).
Debug: `/race?go=<track>&autopilot&skipintro&at=0.4`, module labs at `/race/lab/<name>` (world, pod, hud, track,
stands, water, skyCity, audio, ...). `node tools/racer/shot.mjs <url> <out.png>` screenshots a page in headless Chrome.

### 3D models

Every model (droid, launcher, rocket, health pack, pawn, bomb, coin, crown) is built procedurally in Blender by
[tools/blender/build_models.py](tools/blender/build_models.py) and exported to `frontend/public/models/*.glb`.
Rebuild them with `npm run models` (finds Blender automatically; set `BLENDER=/path/to/blender` otherwise). Materials
named `Team` are recoloured per player at runtime. If a model fails to load the game falls back to a primitive.
Garden Sentinels has its own scripts and output folder (`frontend/public/models/garden/`, `npm run models:garden`):
see [Garden Sentinels](#garden-sentinels).

### Screenshots

The lobby shows real screenshots of every game (`frontend/public/screenshots/`, listed in
`frontend/src/games/screenshots.json`): on the game tiles, in the room list, in the game picker and as a gallery in
the game details. `npm run screenshots` takes them automatically by playing each game against bots in a headless
browser. **Regenerate them whenever a game's look changes** and commit them with the change: see
[SCREENSHOTS.md](SCREENSHOTS.md).

## Configuration: `/srv/apps/play/.env` on the server

Nothing is required. Optional tuning:

| Variable               | Default | Purpose                                                       |
|------------------------|---------|---------------------------------------------------------------|
| `MAX_ROOMS`            | `40`    | Simultaneous rooms (each runs its own simulation loop)        |
| `EMPTY_ROOM_GRACE_MS`  | `15000` | How long a room survives without a connected human            |
| `UNCLAIMED_ROOM_MS`    | `60000` | How long a created room waits for its first player            |
| `CREATE_RATE_LIMIT`    | `10`    | Room creations per IP per minute                              |
| `DATABASE_URL`         | none    | PostgreSQL for accounts (written by the *Provision databases* workflow); without it: guests only |
| `SENDGRID_API_KEY`     | none    | Activation and password reset mails (synced from the GitHub secret by the deploy workflow) |
| `PUBLIC_URL`           | `https://play.bas-franke.com` | Base of the links in those mails                 |
| `AUTH_ATTEMPTS`        | `20`    | Login/sign-up attempts per IP per 10 minutes                  |
| `SIGNUPS_PER_HOUR`     | `5`     | New accounts per IP per hour                                  |

A deploy restarts the backend and therefore closes every room; players get a message and can create a new one.

---

# Setup checklist

The shared server, GitHub secrets and deploy key already exist ([infra/README.md](../infra/README.md)). This project
needs a subdomain, a certificate and an Nginx site **with WebSocket support** (the status page checks all of it).

Replace `<elastic-ip>` with the server's Elastic IP.

## 1. name.com: DNS

Nothing to do if the wildcard `*` A record from the shared setup exists. Otherwise add `A play → <elastic-ip>`.
Check: `nslookup play.bas-franke.com 1.1.1.1`.

## 2. Server: folders, certificate, Nginx

```bash
mkdir -p /var/www/play/frontend /srv/apps/play/backend
touch /srv/apps/play/.env && chmod 600 /srv/apps/play/.env

sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d play.bas-franke.com \
  --deploy-hook "systemctl reload nginx" \
  -m <your-email> --agree-tos -n
```

From your machine: `scp -i bas-franke-ec2.pem play/deploy/nginx.conf ubuntu@<elastic-ip>:~/play.nginx.conf`, then on
the server:

```bash
sudo mv ~/play.nginx.conf /etc/nginx/sites-available/play
sudo ln -sf /etc/nginx/sites-available/play /etc/nginx/sites-enabled/play
sudo nginx -t && sudo systemctl reload nginx
```

The site file has a dedicated `location = /api/ws` block with the `Upgrade`/`Connection` headers and a one-hour read
timeout; without it the lobby works but joining a room fails.

## 3. Accounts: database and SendGrid (optional)

- Database: GitHub → **Actions → Provision databases → Run workflow** with `play` in the list (needs the
  `RDS_MASTER_PASSWORD` secret). It creates the `play` database and user and writes `DATABASE_URL` to the `.env`.
  Tables are created by the backend on start (`backend/src/migrations.ts`).
- Mail: in SendGrid verify a sender (Settings → Sender Authentication, or a single sender) and create an API key with
  *Mail Send* permission. The sender `play@bas-franke.com` is in code (`backend/src/config.ts`); it must be covered by domain authentication or verified as a single sender. Add the repository secret `SENDGRID_API_KEY`; the
  next deploy writes them to `/srv/apps/play/.env`. Without them sign-ups wait for an activation mail that never comes.

## 4. Deploy

Push a change under `play/` to `master`, or GitHub → **Actions → Deploy play → Run workflow**. Then open
<https://play.bas-franke.com>, host a room with a bot and start a game.

---

## Run locally

Requires Node.js 22.12+ (Node 24 recommended) and, only to rebuild the models, Blender 4.2+.

```bash
npm run install:all
npm run dev
```

- Site: <http://localhost:5173> (Vite proxies `/api` and the WebSocket to the backend on `127.0.0.1:3004`)
- Backend: <http://localhost:3004/api/health>
- Open the room URL in a second browser tab to play against yourself; bots are the quickest way to test a game alone.
- In this browser's embedded preview pointer lock is refused; Rockets then switches to drag-to-look with `F` to fire.
- Accounts locally: `npm --prefix backend run dev:db` starts a throwaway PostgreSQL on port 5436; put
  `DATABASE_URL=postgres://play:play@127.0.0.1:5436/play?sslmode=disable` and `PUBLIC_URL=http://localhost:5173` in
  `backend/.env.local`. Without `SENDGRID_API_KEY` the mail links are logged and shown on the page instead.
- `npm run screenshots` refreshes the lobby screenshots ([SCREENSHOTS.md](SCREENSHOTS.md)).
