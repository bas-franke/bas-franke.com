# status: status.bas-franke.com

Checks that every part of the bas-franke.com setup is done and working, and shows **how to fix** whatever is not.
Vite + React frontend, Node.js + Express backend on port **3002**. Its own `status` database in the shared RDS stores the visitor analytics.

## What it checks

| Group                 | Checks                                                                                           |
|-----------------------|--------------------------------------------------------------------------------------------------|
| Shared infrastructure | Running on EC2 (IMDSv2), Elastic IP matches, Nginx + port-80 site, certbot renewal timer, PM2 boot service, Node version, disk/memory, GitHub deploy secrets, RDS reachable, page password, visitor analytics storage |
| Each project          | name.com DNS per domain, latest GitHub deploy, files deployed, `.env` present, PM2 process online, backend `/api/health`, TLS certificate per domain, Nginx site enabled, website loads over HTTPS, `/api` through Nginx, database connection (if the project has one) |

Checks run every 60 seconds; **Check now** forces a run. Projects are listed in
[backend/src/projects.ts](backend/src/projects.ts). Add new projects there.

## Visitor analytics

The page also shows how many people visit each site, for the last 7, 30, 90 or 365 days: an overview with each
project's headline numbers (visitors, page views, average engaged time, bounce rate, views per visit, visitors right
now, all with the change against the previous period) and a page per project with daily and monthly graphs, a
weekday × hour heatmap, top/entry/exit pages, traffic channels, referrers, campaigns, countries, languages, devices,
browsers, operating systems and an engaged-time distribution.

It is first-party and cookie-free. Every frontend has the same small `src/analytics.ts`, called once from `main.tsx`,
which posts each page view (including route changes inside the single-page apps) to
`https://status.bas-franke.com/api/page`. The status backend keeps per page view:

- the path, the external referrer host and the device class (from the viewport width);
- a visitor hash of salt + day + IP address + user agent, so the hash changes every day and the IP itself is never
  stored. "Visitors" are therefore unique per day, and a *visit* is one visitor on one day; monthly visitors add up
  the daily uniques. A visit that saw one page is a bounce;
- the browser and OS family parsed from the user agent (no versions);
- the country guessed from the browser's time zone (`Europe/Amsterdam` → NL, see `backend/src/tzcountry.ts`; no IP
  geolocation) and the primary language subtag of `navigator.language`;
- the traffic channel (direct, search, social, email, referral, campaign) from the referrer host and, on the landing
  page, `utm_source`/`utm_medium` (the `utm_source` is kept as the campaign);
- the engaged time: how long the page was visible, the window focused and used within the last 2 minutes, sent when
  the page view ends (route change, tab hidden, page closed) and capped at 30 minutes. It is matched to its page view by
  a random id that only lives in the page's memory, never in storage.

Requests from hosts that are not in `projects.ts` are dropped, as are known bots, and each IP is rate limited, so
local builds cannot pollute the numbers; the snippet also sends nothing from localhost or automated browsers.

To turn it on, the status project needs its own database (the **Visitor analytics** check shows the exact steps):
create the `status` database and user in RDS and put `DATABASE_URL` in `/srv/apps/status/.env`. The table is created
automatically at startup. New projects need nothing beyond their registration in `projects.ts`.


## Change history

Each project page has a **Changes** tab with the commits on `master` that touched the project's folder, newest first and
grouped by day (merge commits left out; click a change for its full message). The overview cards show when the latest
change was and its one-line summary.

The history is stored in the `changes` table of the status database (migration `004_changes`): at startup and every
10 minutes the backend copies new commits per project folder from the GitHub commits API into it (the full history the
first time, then only what is new; `backend/src/changes.ts`). The page only reads the table, so the history stays up when
GitHub is down or rate limited. The **Change history syncing** check shows whether the copy works. Set `GITHUB_TOKEN`:
without it the sync shares GitHub's 60-requests-per-hour anonymous limit with the deploy checks.

The page has slots for custom illustrations (mascot, state scenes, icons). The prompts, sizes and filenames are in
[ART.md](ART.md); finished PNGs go in `frontend/public/art/`. Missing images are simply left out.

### Screenshots

Claude uploads a screenshot after every finished design change in any project (rule in `.claude/CLAUDE.md`):

```bash
node status/tools/upload-screenshot.mjs --project play --title "Lobby redesign" [--note "..."] [--source agent] shot.png
```

`POST /api/screenshots?project=&title=&note=&source=` takes the raw PNG/JPEG/WebP bytes (max 8 MB) with
`Authorization: Bearer <SCREENSHOT_TOKEN>` (or a logged-in session). Images are stored in the `status` database, and
each upload deletes that project's screenshots beyond the newest 20. `GET /api/screenshots[?project=]` lists them
newest first; `GET /api/screenshots/<id>/image` serves one; `DELETE /api/screenshots/<id>` removes one.

Setup (the **Screenshot uploads enabled** check shows the same steps):

1. Put a random token in the git-ignored `.env.screenshots` in the repo root: `STATUS_SCREENSHOT_TOKEN=<token>`
   (optional `STATUS_URL=http://127.0.0.1:3002` to upload to a local backend).
2. Add the same value as repository secret `STATUS_SCREENSHOT_TOKEN` in GitHub.
3. Run the **Deploy status** workflow; it writes `SCREENSHOT_TOKEN` to `/srv/apps/status/.env` before restarting.

### Configuration: `/srv/apps/status/.env` on the server

| Variable          | Required | Purpose                                                                    |
|-------------------|----------|----------------------------------------------------------------------------|
| `EXPECTED_IP`     | yes      | The Elastic IP that all domains must resolve to                           |
| `STATUS_PASSWORD` | advised  | Enables the login page (user `admin`, or set `STATUS_USER`). Changing it signs everyone out. |
| `RDS_HOST`        | when you have RDS | RDS endpoint, for the reachability check                          |
| `GITHUB_TOKEN`    | optional | Fine-grained token (Actions: read, Secrets: read) to verify repo secrets   |
| `DATABASE_URL`    | for analytics | `postgres://status:<password>@<rds-endpoint>:5432/status?sslmode=require`; without it page views are dropped |
| `ANALYTICS_SALT`  | optional | Salt for the daily visitor hashes (defaults to a value derived from `STATUS_PASSWORD`) |
| `ANALYTICS_TZ`    | optional | Time zone for day and month boundaries, default `Europe/Amsterdam`              |
| `SCREENSHOT_TOKEN` | for screenshots | Bearer token for screenshot uploads; written by the deploy workflow from the GitHub secret `STATUS_SCREENSHOT_TOKEN` |

After editing: `pm2 restart status --update-env`.

---

# Setup from zero

You have nothing in AWS or name.com yet. Follow these steps in order. It takes about an hour; most of it is waiting.
This sets up the shared server **and** the status page. The portfolio then only needs its own short section
([portfolio/README.md](../portfolio/README.md)).

Replace `<elastic-ip>` and `<your-email>` with your own values. Commands marked **(your PC)** run in a terminal
in this repo folder (Git Bash works on Windows); **(server)** means after `ssh`-ing into the EC2 instance.

## Step 1: AWS account

1. Sign up at <https://aws.amazon.com> → **Create an AWS account** (needs a credit card). Expect roughly
   $18/month for a t3.small plus ≈ $3.60/month for the public IPv4 address; check the current pricing for your region.
2. Sign in as the root user, then turn on MFA: top-right account menu → **Security credentials → Assign MFA device**.
3. In the top bar, pick the region you will use for everything, e.g. **Europe (Frankfurt) eu-central-1**.
4. Optional but recommended: **Billing → Budgets → Create budget → Monthly cost budget** at €30 so you get an email
   before costs surprise you.

## Step 2: AWS: key pair and security group

1. **EC2 → Network & Security → Key Pairs → Create key pair**
   - Name `bas-franke-ec2`, type **ED25519**, format **.pem** → Create. The file downloads; move it into this repo folder
     (it is git-ignored) or `~/.ssh/`.
2. **EC2 → Security Groups → Create security group**
   - Name `web-sg`, description "web server", VPC: the default one.
   - Inbound rules → Add rule three times:
     | Type  | Source            |
     |-------|-------------------|
     | SSH   | Anywhere-IPv4     |
     | HTTP  | Anywhere-IPv4     |
     | HTTPS | Anywhere-IPv4     |
   - SSH is open to everyone because GitHub Actions deploys from changing IPs. Only key logins are accepted and
     fail2ban blocks brute-forcing.

## Step 3: AWS: launch the EC2 instance

**EC2 → Instances → Launch instances**

- Name: `bas-franke-web`
- AMI: **Ubuntu Server 24.04 LTS** (64-bit x86)
- Instance type: **t3.small** (or t3.micro to start cheap)
- Key pair: `bas-franke-ec2`
- Network settings → **Select existing security group** → `web-sg`
- Storage: **20 GiB gp3**
- Advanced details → **Metadata version: V2 only (token required)**
- **Launch instance**

## Step 4: AWS: Elastic IP

1. **EC2 → Elastic IPs → Allocate Elastic IP address → Allocate.**
2. Select it → **Actions → Associate Elastic IP address** → Instance `bas-franke-web` → **Associate**.
3. Write the IP down. This is `<elastic-ip>` from now on.

## Step 5: name.com DNS

name.com → **My Domains → bas-franke.com → Manage DNS Records**

1. Delete every existing record name.com created by default (usually `A` records for the empty host and `*`, and/or
   an `ALIAS`/`CNAME` to a parking page). Also open the domain's **URL Forwarding** tab and remove any forwarding.
2. Add these records (TTL 300):
   | Type  | Host      | Answer           |
   |-------|-----------|------------------|
   | A     | *(empty)* | `<elastic-ip>`   |
   | CNAME | `www`     | `bas-franke.com` |
   | A     | `*`       | `<elastic-ip>`   |

   The `*` wildcard covers `status.bas-franke.com` and every future subdomain.
3. Check **(your PC)**: `nslookup status.bas-franke.com 1.1.1.1` should answer with `<elastic-ip>`.
   Continue with step 6 meanwhile; DNS is needed again at step 9.

## Step 6: Bootstrap the server

**(your PC)**:

```bash
chmod 600 bas-franke-ec2.pem
scp -i bas-franke-ec2.pem infra/ec2-bootstrap.sh ubuntu@<elastic-ip>:~
ssh -i bas-franke-ec2.pem ubuntu@<elastic-ip> "bash ~/ec2-bootstrap.sh"
```

Type `yes` the first time SSH asks to trust the host. The script installs Nginx, certbot, Node.js 24, PM2, fail2ban and
the PostgreSQL client (≈ 3–5 minutes).

## Step 7: Deploy key for GitHub Actions

**(your PC)**:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f gh-deploy -N ""
ssh -i bas-franke-ec2.pem ubuntu@<elastic-ip> "cat >> ~/.ssh/authorized_keys" < gh-deploy.pub
```

This creates `gh-deploy` (private) and `gh-deploy.pub` (public); both are git-ignored.

## Step 8: GitHub repository secrets

<https://github.com/bas-franke/bas-franke.com> → **Settings → Secrets and variables → Actions → New repository secret**:

The deploy jobs use the GitHub environment `main`, so these can be repository secrets **or** secrets of an
environment named `main` (Settings → Environments → main).

| Name          | Value                                                                  |
|---------------|------------------------------------------------------------------------|
| `EC2_HOST`    | `<elastic-ip>`                                                         |
| `EC2_USER`    | `ubuntu`                                                               |
| `EC2_SSH_KEY` | Entire contents of the `gh-deploy` file, `-----BEGIN` to `END-----` lines included |

## Step 9: Status project on the server

**(server)**: `ssh -i bas-franke-ec2.pem ubuntu@<elastic-ip>`, then:

```bash
# Folders the deploy writes to
mkdir -p /var/www/status/frontend /srv/apps/status/backend

# Configuration
cat > /srv/apps/status/.env <<'EOF'
EXPECTED_IP=<elastic-ip>
STATUS_PASSWORD=<choose-a-password>
EOF
chmod 600 /srv/apps/status/.env

# TLS certificate (DNS from step 5 must resolve already)
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d status.bas-franke.com \
  --deploy-hook "systemctl reload nginx" \
  -m <your-email> --agree-tos -n
```

**(your PC)**, copy the Nginx site:

```bash
scp -i bas-franke-ec2.pem status/deploy/nginx.conf ubuntu@<elastic-ip>:~/status.nginx.conf
```

**(server)**, enable it:

```bash
sudo mv ~/status.nginx.conf /etc/nginx/sites-available/status
sudo ln -sf /etc/nginx/sites-available/status /etc/nginx/sites-enabled/status
sudo nginx -t && sudo systemctl reload nginx
```

## Step 10: Push and deploy

**(your PC)**: commit and push this repo to `master`. Pushing runs both `Deploy portfolio` and `Deploy status`
(the portfolio deploy succeeds, but its site only works after its own setup).
You can also start a deploy by hand: GitHub → **Actions → Deploy status → Run workflow**.

Open <https://status.bas-franke.com> and sign in with `admin` / your `STATUS_PASSWORD`. Your browser offers to save
the login, and "Keep me signed in" keeps the session for 30 days.

## Step 11: Work through the red items

The page now lists what is still missing, roughly in setup order, each with copy-paste fix instructions.
Right after this guide you should expect:

- **portfolio**: certificate and Nginx site missing. Follow its README's "First-time server setup".
- **RDS reachable**: *skipped* until a project needs a database ([infra/README.md §6](../infra/README.md#6-aws-rds-only-when-the-first-project-needs-a-database)).
- **Deploy secrets configured**: *skipped* unless you add a `GITHUB_TOKEN` (optional).
- **Visitor analytics storing page views**: red until the `status` database exists. Create RDS first, then follow
  the check's fix steps; the graphs fill up from the first deploy after that.

When everything is green, the setup is complete.

---

## Run locally

Requires Node.js 22.12+ (Node 24 recommended).

```bash
npm run install:all
npm run dev
```

Open <http://localhost:5173>. Most checks fail locally (no EC2, PM2 or Nginx); that is expected. DNS, TLS, website and
GitHub checks are real even from your machine.
