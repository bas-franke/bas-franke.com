# play: play.bas-franke.com

Small online multiplayer games in the browser. No accounts: you host a room, get a four-letter code, share it, and the
room lives exactly as long as someone is in it. Empty seats can be filled with bots. Vite + React + three.js frontend,
Node.js + Express + `ws` backend on port **3004**. No database; rooms live in memory.

| Game        | What it is                                                                                              |
|-------------|---------------------------------------------------------------------------------------------------------|
| **Rockets** | First-person rocket arena (Quake 3 "rockets only"): infinite rockets, splash damage, rocket jumps, jump pads, health packs. 5 minutes or 15 frags. |
| **Ruckus**  | Party game in five rounds (Uther Party style). Each round is a minigame: Hot Potato, Floor is Lava, Coin Rush, Sweeper, Sumo. Points for placement; highest total wins. |
| **Last Light** | Co-op zombie survival for 1 to 10 (bots fill in): endless waves in one dark, fully destructible room. Board up the windows, buy guns old and new, ammo, grenades and armor with points, revive each other. |
| **Dustrunners** | Single-player podracing through red-rock canyons at `/race`: career (cups, prize money, garage), quick race, time trial against AI pilots. Not a room game: listed in the lobby from `SOLO_GAMES`. |

Every room game supports bots (easy / normal / hard), chosen when the room is created or changed by the host in the room.

## How it works

```
frontend/src/                          backend/src/
├── lobby/      server list, create    ├── index.ts     Express: /api/health, /api/games, /api/rooms
│               dialog, game tiles     ├── net.ts       WebSocket endpoint /api/ws?room=CODE&name=Nick
├── room/       waiting room, chat,    ├── rooms.ts     Room lifecycle, host, bots, auto-close
│               mounts the game        ├── games/
├── ui/         header, dialogs,       │   ├── rockets/ server.ts (sim + rules), bots.ts, nav.ts
│               screenshot gallery     │   └── ruckus/  server.ts (rounds), bots.ts, minigames/*
├── engine/     three.js wrapper,      └── shared/      ← imported by the frontend as @shared/*
│   input, interpolation, models,          ├── protocol.ts   lobby/room messages, game metadata
│   effects, synthesized audio             ├── math.ts
└── games/                                 ├── rockets/      constants, map(s), physics, protocol
    ├── catalog.ts  screenshots per game   └── ruckus/       constants, world (layouts + pawn physics), protocol
    ├── rockets/ client.ts, arena.ts,
    │            Hud.tsx
    └── ruckus/  client.ts, arena.ts,
                 Hud.tsx
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

### Ruckus

Five rounds in a shuffled order of the five minigames, each with a 4 s intro showing the rules, a timed play phase and
a 5 s results screen. Pawns move on a disc, a tile grid or a walled square (`shared/ruckus/world.ts`) and have a dash
that shoves whoever it hits. Placement points: 10, 7, 5, 4, 3, 2, 1, 1. Players who join mid-match watch until the
next round starts. Each minigame is one small class in `games/ruckus/minigames/`.

### Last Light

One closed room per map (Cold Storage, St. Agnes Chapel, Pumping Station), eight barricaded windows, lockers along the
walls, a dark yard outside. Zombies rise outside one at a time, shamble to a window, pull its six boards off and vault
in; players hold E inside a window to nail boards back (+10 points each, capped per wave). Waves never end: counts and
health grow like CoD zombies, a share of later waves jogs, everyone downed at once ends the match.

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
  `world.ts` + `textures.ts` (instanced chunks with world-space PBR textures and cracks, lamps, moonlight), `post.ts`
  (HDR, volumetric fog with moonlight shafts through windows and holes, lit dust, bloom, grade), `fx.ts` (debris,
  decals, blood, gibs), `audio.ts` (synthesized, with room reverb), `models.ts` (Blender GLBs from
  `tools/blender/build_zombies.py`, `npm run models:zombies`). Graphics quality (low / medium / high) is in the Esc menu.
- Dev labs: `/lab-zombies.html?map=storage` (world + lighting), `/lab-zombies-fx.html`, `/lab-zombies-audio.html`.

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

## 3. Deploy

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
- `npm run screenshots` refreshes the lobby screenshots ([SCREENSHOTS.md](SCREENSHOTS.md)).
