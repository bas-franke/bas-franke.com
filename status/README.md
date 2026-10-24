# status: status.bas-franke.com

Checks that every part of the bas-franke.com setup is done and working, and shows **how to fix** whatever is not.
Vite + React frontend, Node.js + Express backend on port **3002**. No database of its own.

## What it checks

| Group                 | Checks                                                                                           |
|-----------------------|--------------------------------------------------------------------------------------------------|
| Shared infrastructure | Running on EC2 (IMDSv2), Elastic IP matches, Nginx + port-80 site, certbot renewal timer, PM2 boot service, Node version, disk/memory, GitHub deploy secrets, RDS reachable, page password |
| Each project          | name.com DNS per domain, latest GitHub deploy, files deployed, `.env` present, PM2 process online, backend `/api/health`, TLS certificate per domain, Nginx site enabled, website loads over HTTPS, `/api` through Nginx, database connection (if the project has one) |

Checks run every 60 seconds; **Check now** forces a run. Projects are listed in
[backend/src/projects.ts](backend/src/projects.ts). Add new projects there.

### Configuration: `/srv/apps/status/.env` on the server

| Variable          | Required | Purpose                                                                    |
|-------------------|----------|----------------------------------------------------------------------------|
| `EXPECTED_IP`     | yes      | The Elastic IP that all domains must resolve to                           |
| `STATUS_PASSWORD` | advised  | Enables basic auth (user `admin`, or set `STATUS_USER`)                    |
| `RDS_HOST`        | when you have RDS | RDS endpoint, for the reachability check                          |
| `GITHUB_TOKEN`    | optional | Fine-grained token (Actions: read, Secrets: read) to verify repo secrets   |

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

Open <https://status.bas-franke.com> and log in with `admin` / your `STATUS_PASSWORD`.

## Step 11: Work through the red items

The page now lists what is still missing, roughly in setup order, each with copy-paste fix instructions.
Right after this guide you should expect:

- **portfolio**: certificate and Nginx site missing. Follow its README's "First-time server setup".
- **RDS reachable**: *skipped* until a project needs a database ([infra/README.md §6](../infra/README.md#6-aws-rds-only-when-the-first-project-needs-a-database)).
- **Deploy secrets configured**: *skipped* unless you add a `GITHUB_TOKEN` (optional).

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
