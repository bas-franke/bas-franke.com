# inck: inck.ai

A learning feed. Every 15 minutes (configurable) it writes one **very short story** (about 200 words) that makes a single
complicated idea click: a qubit, a ceasefire, why prices rise, how a chip is made. You scroll through them one per screen,
like a video feed; the site opens on the latest story. Each story belongs to a **topic** (Artificial intelligence, The war in
Ukraine, Inflation & central banks, …) that has its own hub page where the stories are organised as a curriculum from
"no knowledge needed" to deeper. Every story is written to stand alone: no prior knowledge, every term explained.

Everything (settings, topics, their curricula, stories, run history) lives in its own PostgreSQL database on the shared RDS
instance. Vite + React frontend, Node.js + Express backend on port **3003**.

| URL                       | What                                                                         |
|---------------------------|------------------------------------------------------------------------------|
| `https://inck.ai`         | The feed, opening on the latest story (`/s/<slug>` is one story's address)   |
| `https://inck.ai/topics`  | The condensed overview: every topic by category, plus search                 |
| `https://inck.ai/t/<slug>`| A topic hub: intro, sections, every story and what is still planned          |
| `https://inck.ai/sudo`    | Admin: "Write now", "Scan now" for the radar, settings, topics and curricula |

## How it works

1. **Topics and curricula.** A topic is either a *field* (a lasting subject such as Quantum computing) or an *event*
   (something happening in the world, such as a war or a crash). The first time a topic is picked, the text model
   designs its **curriculum**: an intro plus 4–7 sections, each with 3–8 story ideas, ordered from basics to deeper.
   For events the sections always cover what is happening, how it started (history), who is involved, key moments,
   consequences and what could happen next. Every topic also gets an automatic **Latest** section for "right now" stories.
   When every planned item has been written, the plan is extended. Thirteen topics are seeded; the scout adds more.
2. **The scheduler** ticks every 30 s. When `enabled`, the last run is ≥ `interval_minutes` ago (default 15), the time
   is inside the active hours and fewer than `max_per_day` stories were made in the last 24 h, it starts a run.
3. **The trend radar** discovers, on its own, what the world is talking about. Every `radar_hours` (default 3,
   checked before a "right now" story) it reads free live signals (BBC and NYT world/business/science headlines,
   Google Trends, Wikipedia's most-read pages, Hacker News), searches the web, and returns the 6–10 hottest subjects
   with a **heat** score (1–5) and a one-line reason. Each becomes a topic (or updates the existing topic it belongs
   to); topics it no longer lists cool down one step per scan. The seeded topics are never a menu for it.
   **A run** is either a *right now* story or a *curriculum* story, so that over time `trending_share` (default 60%)
   of stories serve hot topics. Right now: pick a hot topic (the hotter the likelier, spread over the day); a hot topic
   with few stories first gets its curriculum basics, then the scout picks the one thing to explain about it today.
   Curriculum: a random enabled topic, weighted by weight and heat, favouring topics with few stories, and its next
   unwritten item. Both skip gossip, individual crime cases, sports results and unverified rumours.
4. **The writer** (default `gpt-5.4-mini`) returns strict JSON: title, one-line hook, the story in Markdown, a one-sentence
   takeaway, the section it belongs to, difficulty, tags, 0–2 picture ideas with a relevance rating, and sources. Rules:
   about `target_words` words, told as a story (a scene, an analogy, why it matters), fully standalone, neutral on
   contested matters, no links in the body. Web search is used for "right now" stories and event topics.
5. **Pictures** (default `gpt-image-2`, low quality) follow relevance: a story in a topic everyone is talking about
   (heat 4–5) always gets at least one picture that anchors it, a warm topic (2–3) gets one when it helps, and stories
   in cool topics only get one when it is essential; never more than `images_max` (default 2). Files go to
   `/srv/apps/inck/data/images`; orphans are swept daily.
6. The story is published and appears at the top of the feed, in its topic hub, and as a "go deeper" link from related
   stories (its neighbours on the topic path and stories elsewhere that share tags). Hot topics are shown prominently:
   a trending strip above the feed (the rail on wide screens), a "Trending now" section on the overview, a badge on
   their stories and a banner on their hub.

## Configuration: `/srv/apps/inck/.env` on the server

| Variable         | Required | Purpose                                                                 |
|------------------|----------|-------------------------------------------------------------------------|
| `DATABASE_URL`   | yes      | `postgres://inck:<password>@<rds-endpoint>:5432/inck?sslmode=require`   |
| `OPENAI_API_KEY` | yes      | From <https://platform.openai.com/api-keys>                             |
| `ADMIN_PASSWORD` | yes      | Login for `/sudo` (user `admin`, or set `ADMIN_USER`)                  |
| `DATA_DIR`       | no       | Where pictures are stored; default `/srv/apps/inck/data`                |

Everything else (interval, hours, models, tone, length, trending share, topics, site name) is changed in the admin UI and
stored in the database. After editing `.env`: `pm2 restart inck --update-env`.

**Costs:** a story is one text request of a few thousand tokens (plus about $0.01 per web search for "right now" stories
and events) and, now and then, one low-quality picture (about half a cent). Planning a curriculum is one extra request per
topic. At a story every 15 minutes with `gpt-5.4-mini`, expect roughly $2–4 per day; the dashboard shows the estimate.
Set a usage limit in your OpenAI account to be safe.

---

# Setup checklist

The shared server, GitHub secrets and deploy key already exist ([infra/README.md](../infra/README.md)).
This project adds: a domain, the first RDS database, and three secrets in `.env`.

Replace `<elastic-ip>` with the server's Elastic IP (the one in `EXPECTED_IP` on the status page).

## 1. name.com: DNS for inck.ai

name.com → **My Domains → inck.ai → Manage DNS Records**

1. Delete every default `A`, `AAAA`, `ALIAS` or `CNAME` record name.com created, and turn off **URL Forwarding** for the domain.
2. Add:
   | Type  | Host      | Answer         | TTL |
   |-------|-----------|----------------|-----|
   | A     | *(empty)* | `<elastic-ip>` | 300 |
   | CNAME | `www`     | `inck.ai`      | 300 |
3. Check: `nslookup inck.ai 1.1.1.1` returns the Elastic IP (usually within minutes).

## 2. AWS: the shared RDS instance (first time only)

Follow [infra/README.md §6](../infra/README.md#6-aws-rds-only-when-the-first-project-needs-a-database):
security group `rds-sg` (PostgreSQL 5432 from `web-sg`), then **RDS → Create database** (PostgreSQL, `bas-franke-db`,
`db.t4g.micro`, same VPC as the EC2 instance, **Public access: No**, security group `rds-sg`).
Note the **endpoint** and the **master password**.

## 3. The `inck` database

From the server (`ssh -i bas-franke-ec2.pem ubuntu@<elastic-ip>`):

```bash
psql "host=<rds-endpoint> user=postgres dbname=postgres sslmode=require"
```

```sql
CREATE USER inck WITH PASSWORD '<strong-password>';
CREATE DATABASE inck OWNER inck;
REVOKE ALL ON DATABASE inck FROM PUBLIC;
```

The app creates its own tables on first start (migrations run automatically). Migration `007_stories` replaced the
original long-form magazine: it drops the old `articles` table and its illustrations are removed from disk at startup.

## 4. OpenAI API key

<https://platform.openai.com/api-keys> → **Create new secret key** (name it `inck`). Copy it once; it is not shown again.
Under **Settings → Limits**, set a monthly budget.

## 5. Server: folders, `.env`, certificate, Nginx

```bash
mkdir -p /var/www/inck/frontend /srv/apps/inck/backend /srv/apps/inck/data/images
cat > /srv/apps/inck/.env <<'EOF'
DATABASE_URL=postgres://inck:<db-password>@<rds-endpoint>:5432/inck?sslmode=require
OPENAI_API_KEY=<openai-key>
ADMIN_PASSWORD=<choose-a-password>
DATA_DIR=/srv/apps/inck/data
EOF
chmod 600 /srv/apps/inck/.env

sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d inck.ai -d www.inck.ai \
  --deploy-hook "systemctl reload nginx" \
  -m <your-email> --agree-tos -n
```

From your machine: `scp -i bas-franke-ec2.pem inck/deploy/nginx.conf ubuntu@<elastic-ip>:~/inck.nginx.conf`, then on the server:

```bash
sudo mv ~/inck.nginx.conf /etc/nginx/sites-available/inck
sudo ln -sf /etc/nginx/sites-available/inck /etc/nginx/sites-enabled/inck
sudo nginx -t && sudo systemctl reload nginx
```

## 6. Deploy

Push a change under `inck/` to `master`, or GitHub → **Actions → Deploy inck → Run workflow**. Then open
<https://inck.ai/sudo>, sign in, and press **Write now** for the first story (the first run of a topic also plans its
curriculum, so it takes a minute). The scheduler takes over from there.

The status page (<https://status.bas-franke.com>) shows every one of these steps as a check, with fix instructions,
including the database connection and whether the backend reports a missing API key.

---

## Run locally

Requires Node.js 22.12+ (Node 24 recommended). No PostgreSQL install needed: `npm run dev` starts an embedded one.

```bash
npm run install:all
cp backend/.env.example backend/.env.local   # add your OPENAI_API_KEY to generate stories locally
npm run dev
```

- Site: <http://localhost:5173>, admin: <http://localhost:5173/sudo> (password from `.env.local`)
- Backend: <http://localhost:3003/api/health>
- Dev database data lives in `backend/.pg/` (git-ignored); pictures in `backend/.data/`.
- No API key? `npm --prefix backend run seed:dev` inserts a few made-up stories into the local database so the feed and
  hubs have something to show (it refuses to run against anything but localhost).
