# inck: inck.ai

An automated magazine. Every hour (configurable) it picks a topic, has ChatGPT write a genuinely interesting article with
data charts, has `gpt-image-2` paint a cover and 2–6 inline illustrations, and publishes it. Everything (settings, topics, articles, run
history) lives in its own PostgreSQL database on the shared RDS instance. Vite + React frontend, Node.js + Express
backend on port **3003**.

| URL                       | What                                                                 |
|---------------------------|----------------------------------------------------------------------|
| `https://inck.ai`         | The magazine: latest articles, topic filter, search, article pages   |
| `https://inck.ai/sudo`   | Dashboard, "Generate now", settings, topics, article management      |

## How generation works

1. The scheduler ticks every 30 s. When `enabled`, the last run is ≥ `interval_minutes` ago, the time is inside the
   active hours and fewer than `max_per_day` articles were made in the last 24 h, it starts a run.
2. A topic is picked at random, weighted by its `weight` and favouring topics with fewer articles this week.
3. The text model (default `gpt-5.4-mini`, with web search on) returns a strict JSON article: title, dek, Markdown body,
   tags, 0–3 charts with real figures, sources, and 2–6 image prompts. `[[chart:N]]` and `[[image:N]]` markers in the body say where they go.
4. The image model (default `gpt-image-2`) renders the illustrations, two at a time (WebP, stored in `/srv/apps/inck/data/images`).
5. The article is published. Failed runs are logged with their error and shown on the dashboard.

Charts are rendered in the browser from the data (Recharts), so numbers stay readable and the page stays light.

## Configuration: `/srv/apps/inck/.env` on the server

| Variable         | Required | Purpose                                                                 |
|------------------|----------|-------------------------------------------------------------------------|
| `DATABASE_URL`   | yes      | `postgres://inck:<password>@<rds-endpoint>:5432/inck?sslmode=require`   |
| `OPENAI_API_KEY` | yes      | From <https://platform.openai.com/api-keys>                             |
| `ADMIN_PASSWORD` | yes      | Login for `/sudo` (user `admin`, or set `ADMIN_USER`)                  |
| `DATA_DIR`       | no       | Where images are stored; default `/srv/apps/inck/data`                  |

Everything else (interval, hours, models, tone, topics, site name) is changed in the admin UI and stored in the database.
After editing `.env`: `pm2 restart inck --update-env`.

**Costs:** each article is one text request (a few thousand tokens, more with web search) plus one image. At hourly
generation with `gpt-5.4-nano`, a medium-quality cover and low-quality inline figures, expect about $1–2 per day; the dashboard shows token and
image counts. Set a usage limit in your OpenAI account to be safe.

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

The app creates its own tables on first start (migrations run automatically).

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
<https://inck.ai/sudo>, sign in, and press **Generate now** for the first article. The scheduler takes over from there.

The status page (<https://status.bas-franke.com>) shows every one of these steps as a check, with fix instructions,
including the database connection and whether the backend reports a missing API key.

---

## Run locally

Requires Node.js 22.12+ (Node 24 recommended). No PostgreSQL install needed: `npm run dev` starts an embedded one.

```bash
npm run install:all
cp backend/.env.example backend/.env.local   # add your OPENAI_API_KEY to generate articles locally
npm run dev
```

- Site: <http://localhost:5173>, admin: <http://localhost:5173/sudo> (password from `.env.local`)
- Backend: <http://localhost:3003/api/health>
- Dev database data lives in `backend/.pg/` (git-ignored); images in `backend/.data/`.
