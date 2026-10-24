# wordward: wordward.bas-franke.com

A cute typing game for learning Romanian (or English). Chubby creatures float down towards a candy-coloured castle,
each inside a bubble shield. Type the word on the bubble (the language you read) to pop it, then type the translation
to send the creature home with a star beam from Bufnița, the owl guardian. The closest creature is always the target,
and both languages stay on screen the whole time, so you read, copy and remember as you play.
Vite + React + three.js frontend (cel-shaded storybook look, everything procedural), tiny Node.js + Express backend on
port **3005**. No database: settings, best scores, level stars and learning progress are saved in cookies on the
player's device (mirrored to `localStorage`).

## How it plays

- **Adventure (campaign):** a winding path through 8 chapters (village → forest → home → town → school → fair →
  mountains → citadel), 54 missions in all (`game/campaign.ts`). Every chapter has 3–6 missions, a **review** mission
  built from that chapter's words you have not mastered yet, and a **boss** mission (a balaur every wave).
  - **Variants:** every mission has a standard run plus two of: 🧠 *din memorie* (the translation is hidden; two
    misses on a letter reveal it), 🔄 *invers* (the other direction), ⚡ *viteză* (much faster, 5 HP), 🎯 *fără
    greșeli* (three typos ends the mission). Variants open once the standard run is won.
  - **Going back:** some missions only open after a variant of an earlier one (e.g. *Familia* needs *Salut!* from
    memory; *Bucătărie* needs *La masă* at speed), and each boss needs a number of stars and variant wins from its
    chapter, so you replay missions to earn them. The mission sheet lists what is missing with a link to it.
  - Stars (1–3: ★★★ = 80%+ HP left and 90%+ accuracy) are kept per mission, variant and direction.
- **Free play:** endless waves from the topics you pick, with a balaur every 5th wave.

- **Directions:** EN → RO (read English, type Romanian) or RO → EN.
- **Shields (on by default):** every creature first wears a bubble with the word in the language you read; typing it
  pops the bubble (blue), then the translation defeats the creature (pink). Can be switched off in the menu, then the
  word you read is shown above the one to type.
- **Modes:** words, sentences, or a mix (sentences join from wave 2). A sentence arrives as a parade of pebbles, one
  per word of the translation, inside one long bubble with the source sentence. Pop it, then shoot the pebbles from
  left to right.
- **Creatures:** liliac (bat fluffball, short words, fast), pietroi (rock buddy riding a comet tail), fantomiță (little
  ghost, long words, sways), zmeuț (baby dragon, the longest words, 2 damage), pietricele (sentences, damage = pebbles
  left), and every 5th wave **Balaurul**, a chubby winged dragon with one bubble and word pair per head (3 to 5 heads).
  The first of each kind in a game gets a "A wild … appeared!" toast.
- **Typing:** case-insensitive; spaces and punctuation are skipped for you. With *diacritice ușoare* on (default),
  `a` also matches `ă`/`â`, `i` → `î`, `s` → `ș`, `t` → `ț`. Real diacritics always work, including dead keys and
  phone keyboards (input goes through a hidden text field that copes with Android word composition).
- **Learning:** a word you get wrong comes back a few creatures later; the game-over screen lists the words to
  practise. Progress is kept per word and direction (`game/progress.ts`): two typo-free wins = mastered, and
  unmastered words are served first. The menu shows how many words of the chosen topics you have mastered.
- **Castle:** 10 HP (Pokémon-style bar), +1 at the start of every wave. Cottages puff smoke as it takes damage.

## Accounts

Optional. Guests play with progress saved on the device (below). With an account (username + password, **no email**,
so children can sign up) the same save is also kept on the server and follows the player to any device:

- `backend/src/accounts.ts`: `GET /api/account` (who am I + save; `enabled: false` when there is no database),
  `POST /api/account/register | login | logout | delete`, `PUT /api/account/save`.
- Passwords are scrypt-hashed; the session is a random token in an `HttpOnly` cookie `wws` scoped to `Path=/api`
  (so it never rides along with page and asset requests), 1 year; only its SHA-256 is stored. Login and sign-up are
  rate limited per IP (`AUTH_ATTEMPTS`, `SIGNUPS_PER_HOUR`).
- Saves are merged, never overwritten (`backend/src/saves.ts`, same rules as the client): best stars/scores/word
  progress of every device, settings from the newest. The client uploads ~3 s after each change and adopts the merged
  result; on login this device's progress is merged into the account; logging out clears the device's progress.
- Without `DATABASE_URL` the backend still runs (health check, guest mode) and the account button is hidden.

## Saving (cookies)

`game/save.ts` keeps one save object (settings, best scores, level stars, per-word progress) and writes it to
first-party cookies `ww0`, `ww1`… (`wwn` = chunk count; 2-year `Max-Age`, `SameSite=Lax`, `Secure` on HTTPS) and in
full to `localStorage` (`wordward:save`). On load both are read and merged (best of each). Cookies travel with every
request and Nginx rejects a Cookie header over 8 KB, so the cookie copy is capped at about 6 KB: words are stored as
5-character FNV hashes plus a mastery digit (`abcde2.fghij3…`), best-learned first, and whatever does not fit stays in
`localStorage` only. That is roughly 850 words in the cookies; levels, bests and settings always fit. The first
versions' separate localStorage keys are migrated once.

## Mobile

- The app is sized to `visualViewport`, so when the phone keyboard opens the whole game (HUD, castle, word panel)
  stays above it. The game measures the HUD and the word panel and frames the camera so the castle sits right above
  the panel; tall portrait screens get a taller field, short ones (keyboard open, landscape) a shorter one.
- Creatures are scaled up 1.45× (and long sentences shrink to fit the width), the HUD compacts on short screens, all
  buttons are at least 44–48 px, and a "Tap to type" button appears when the keyboard is closed mid-game.
- Leaving the tab or app pauses the game.

## Code

```
frontend/src/
├── App.tsx          menu, HUD, pause and game-over screens (React)
├── game/
│   ├── Game.ts      waves, spawning, targeting, shields then words, scoring, camera framing, DOM word tags
│   ├── world.ts     banded sky, smiling sun, clouds, pastel mountains, hills, the castle and the owl guardian
│   ├── enemies.ts   procedural creatures (bat, rock buddy, ghost, baby dragon, pebble, balaur) and bubbles
│   ├── progress.ts  per-word learning progress (mastered after two typo-free wins)
│   ├── campaign.ts  chapters, missions, variants, requirements, stars; builds the run config for a mission
│   ├── save.ts      the save: cookies (budgeted) + localStorage
│   ├── effects.ts   pooled star beams, sparkles, poof clouds, bubble pops, dust
│   ├── toon.ts      toon shader look-dev patch, cached materials, ink outlines (copied from play/)
│   ├── engine.ts    renderer wrapper with an adaptive-resolution governor
│   └── audio.ts     synthesized sound effects
└── vocab/
    ├── words-a.ts   nouns by topic       `english|romanian`, "(hints)" are shown but not typed
    ├── words-b.ts   verbs, adjectives, small words, feelings
    ├── words-c.ts   phrases, countries, travel, cooking, office, Romania, castle & battle, space, more of everything
    ├── words-d.ts   more animals, food, house, town, plants, time, numbers, linking words, questions, verbs
    ├── words-e.ts   sports, arts, society, online, character, jobs, holidays, science, body, school, shop, clothes
    ├── sentences*.ts short sentences (≤ 6 words a side)
    └── index.ts     categories, parsing, the typing/matching rules
```

About 3,250 words and phrases in 62 topics plus ~500 sentences. To add vocabulary, add `english|romanian` lines to a category block (or a new block plus an entry in `CATEGORIES`).
Verbs are written `(to) eat|(a) mânca` so the infinitive marker is shown but not typed.

## Configuration: `/srv/apps/wordward/.env` on the server

| Variable           | Default | Purpose                                                      |
|--------------------|---------|--------------------------------------------------------------|
| `DATABASE_URL`     | —       | PostgreSQL for accounts; without it: guest mode only         |
| `AUTH_ATTEMPTS`    | `20`    | Login/sign-up attempts per IP per 10 minutes                 |
| `SIGNUPS_PER_HOUR` | `5`     | New accounts per IP per hour                                 |

### Database (one time, for accounts)

On the server (`psql` is installed), as the RDS master user:

```sql
CREATE USER wordward WITH PASSWORD '<strong-password>';
CREATE DATABASE wordward OWNER wordward;
REVOKE ALL ON DATABASE wordward FROM PUBLIC;
```

Then add `DATABASE_URL=postgres://wordward:<password>@<rds-endpoint>:5432/wordward?sslmode=require` to
`/srv/apps/wordward/.env` and run `pm2 restart wordward --update-env` (or push any change). Tables are created by the
migrations at startup. Locally, `npm --prefix backend run dev:db` starts an embedded PostgreSQL on port 5435.

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
