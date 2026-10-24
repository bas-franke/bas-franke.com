# wordward: wordward.bas-franke.com

A typing game for learning Romanian (or English). Monsters fall towards a Transylvanian citadel, each carrying a word.
Type the translation and the laser on the citadel tower shoots them down letter by letter. The closest enemy is always
the target, and both languages stay on screen the whole time, so you read, copy and remember as you play.
Vite + React + three.js frontend (cel-shaded, everything procedural), tiny Node.js + Express backend on port **3005**.
No database: settings and best scores live in the browser's `localStorage`.

## How it plays

- **Directions:** EN → RO (read English, type Romanian) or RO → EN.
- **Modes:** words, sentences, or a mix (sentences join from wave 2). A sentence arrives as a convoy of rocks, one
  word each, which you shoot from left to right.
- **Enemies:** liliac (bat, short words, fast and fluttering), meteorit (burning rock), strigoi (ghost, long words,
  sways), zmeu (dragon head, the longest words, 2 damage), convoi (sentences, damage = words left), and every 5th
  wave the **balaur**, a winged dragon with one head per word (3 heads at wave 5, up to 5), typed left to right.
- **Typing:** case-insensitive; spaces and punctuation are skipped for you. With *diacritice ușoare* on (default),
  `a` also matches `ă`/`â`, `i` → `î`, `s` → `ș`, `t` → `ț`. Real diacritics always work, including dead keys and
  phone keyboards (input goes through a hidden text field).
- **Learning:** a word you get wrong comes back a few enemies later; the game-over screen lists the words to practise.
  Progress is kept per word and direction in `localStorage` (`game/progress.ts`): two typo-free kills = mastered, and
  unmastered words are served first. The menu shows how many words of the chosen topics you have mastered.
- **Citadel:** 10 hearts, +1 at the start of every wave. Houses catch fire as it takes damage.

## Code

```
frontend/src/
├── App.tsx          menu, HUD, pause and game-over screens (React)
├── game/
│   ├── Game.ts      waves, spawning, targeting, typing, scoring; positions the DOM word tags each frame
│   ├── world.ts     sky, Carpathian mountain ranges, the citadel and its laser tower
│   ├── enemies.ts   procedural enemy models (bat, meteor, ghost, zmeu, convoy rock, balaur body)
│   ├── progress.ts  per-word learning progress in localStorage
│   ├── effects.ts   pooled lasers, sparks, inked fireballs, debris
│   ├── toon.ts      toon ramp, cached materials, ink outlines (same technique as play/)
│   ├── engine.ts    renderer wrapper with an adaptive-resolution governor
│   └── audio.ts     synthesized sound effects
└── vocab/
    ├── words-a.ts   nouns by topic       `english|romanian`, "(hints)" are shown but not typed
    ├── words-b.ts   verbs, adjectives, small words, feelings
    ├── words-c.ts   phrases, countries, travel, cooking, office, Romania, castle & battle, space, more of everything
    ├── sentences*.ts short sentences (≤ 6 words a side)
    └── index.ts     categories, parsing, the typing/matching rules
```

About 1,900 words and phrases in 40 topics plus 300+ sentences. To add vocabulary, add `english|romanian` lines to a category block (or a new block plus an entry in `CATEGORIES`).
Verbs are written `(to) eat|(a) mânca` so the infinitive marker is shown but not typed.

## Configuration

Nothing. `/srv/apps/wordward/.env` exists (created by the workflow) but no variable is read except `PORT`/`HOST`.

---

# Setup checklist

The shared server, GitHub secrets and deploy key already exist ([infra/README.md](../infra/README.md)), and the
wildcard `*` DNS record points `wordward.bas-franke.com` at the server.

Unlike the older projects, **the deploy workflow sets up the server side by itself** on its first run
([.github/workflows/deploy-wordward.yml](../.github/workflows/deploy-wordward.yml), step *Ensure certificate and
Nginx site*): it creates `/srv/apps/wordward/.env`, issues the Let's Encrypt certificate with the webroot challenge,
installs `deploy/nginx.conf` as the Nginx site and reloads Nginx. On later runs it only reinstalls the site when
`nginx.conf` changed, and restores the previous file if `nginx -t` fails.

So: push a change under `wordward/` to `master`, or GitHub → **Actions → Deploy wordward → Run workflow**, then open
<https://wordward.bas-franke.com>. The status page lists wordward once the status project is redeployed.

If you prefer to do it by hand (or the certificate step fails), the manual commands are:

```bash
mkdir -p /var/www/wordward/frontend /srv/apps/wordward/backend
touch /srv/apps/wordward/.env && chmod 600 /srv/apps/wordward/.env
sudo certbot certonly --webroot -w /var/www/letsencrypt -d wordward.bas-franke.com \
  --deploy-hook "systemctl reload nginx" -m <your-email> --agree-tos -n
sudo cp nginx.conf /etc/nginx/sites-available/wordward
sudo ln -sf /etc/nginx/sites-available/wordward /etc/nginx/sites-enabled/wordward
sudo nginx -t && sudo systemctl reload nginx
```

## Run locally

Requires Node.js 22.12+ (Node 24 recommended).

```bash
npm run install:all
npm run dev
```

The game needs no backend to play; Vite serves it at <http://localhost:5173>. In dev builds `window.__ww` is the
running `Game`, and `__ww.engine.step(1/60)` advances it by hand (useful in hidden tabs, which get no animation frames).
