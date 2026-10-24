# Shared infrastructure setup (one time)

Do this once. Every project in this repo reuses it. This page is the reference; for a click-by-click walkthrough
starting with no AWS or name.com setup at all, follow [status/README.md → Setup from zero](../status/README.md#setup-from-zero),
which covers these steps and deploys the status page. Then do [portfolio](../portfolio/README.md).

Once the status project is deployed, <https://status.bas-franke.com> tells you which of these steps are still missing.

Values you will collect along the way. Keep them somewhere safe:

| Name             | Example                                          | Used for                      |
|------------------|--------------------------------------------------|-------------------------------|
| Elastic IP       | `3.120.45.67`                                    | DNS records, `EC2_HOST`       |
| EC2 key pair     | `bas-franke-ec2.pem`                             | Your own SSH access           |
| Deploy key       | `gh-deploy` / `gh-deploy.pub`                    | GitHub Actions → EC2          |
| RDS endpoint     | `bas-franke-db.xxxx.eu-central-1.rds.amazonaws.com` | Project `DATABASE_URL`s    |
| RDS master pass  | (generated)                                      | Creating per-project DBs      |

---

## 1. AWS: EC2

In the AWS console, pick one region and use it for everything (for example `eu-central-1`, Frankfurt).

1. **EC2 → Key Pairs → Create key pair**: name `bas-franke-ec2`, type ED25519, format `.pem`. Save the file.
2. **EC2 → Security Groups → Create**: name `web-sg`, inbound rules:
   | Type  | Port | Source      | Why                                                          |
   |-------|------|-------------|--------------------------------------------------------------|
   | SSH   | 22   | `0.0.0.0/0` | GitHub Actions runners have changing IPs. Key-only auth + fail2ban. |
   | HTTP  | 80   | `0.0.0.0/0` | Let's Encrypt + redirect to HTTPS                            |
   | HTTPS | 443  | `0.0.0.0/0` | The sites                                                    |
3. **EC2 → Launch instance**:
   - Name `bas-franke-web`, AMI **Ubuntu Server 24.04 LTS**, type **t3.small** (2 GB RAM; t3.micro works for 1–2 small projects).
   - Key pair `bas-franke-ec2`, security group `web-sg`, storage **20 GB gp3**.
   - Advanced details → Metadata version: **V2 only** (the status page reads instance info from it).
4. **EC2 → Elastic IPs → Allocate**, then **Actions → Associate** with `bas-franke-web`.
   This IP never changes, even after a reboot.

## 2. Server bootstrap

From your machine:

```bash
scp -i bas-franke-ec2.pem infra/ec2-bootstrap.sh ubuntu@<elastic-ip>:~
ssh -i bas-franke-ec2.pem ubuntu@<elastic-ip> "bash ~/ec2-bootstrap.sh"
```

This installs Nginx, certbot, Node.js 24, PM2 (auto-start on boot), the PostgreSQL client, fail2ban, a swap file,
and creates `/var/www` and `/srv/apps`.

## 3. Deploy key for GitHub Actions

Create a separate key that is only used by CI (no passphrase):

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f gh-deploy -N ""
ssh -i bas-franke-ec2.pem ubuntu@<elastic-ip> "cat >> ~/.ssh/authorized_keys" < gh-deploy.pub
```

## 4. GitHub: repository secrets

Repository `bas-franke/bas-franke.com` → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret        | Value                                         |
|---------------|-----------------------------------------------|
| `EC2_HOST`    | The Elastic IP                                |
| `EC2_USER`    | `ubuntu`                                      |
| `EC2_SSH_KEY` | Full contents of the private key file `gh-deploy` (including the `BEGIN`/`END` lines) |

Also check **Settings → Actions → General → Actions permissions** allows actions to run.
All `deploy-*.yml` workflows share these secrets.

## 5. name.com: DNS

name.com → **My Domains → bas-franke.com → Manage DNS Records**.

1. Delete the default parking records (name.com adds an `A` record for `@` and `*`, and sometimes URL forwarding).
   Also check **URL Forwarding** is off for the domain.
2. Add:
   | Type  | Host     | Answer           | TTL |
   |-------|----------|------------------|-----|
   | A     | *(empty)* | `<elastic-ip>`  | 300 |
   | CNAME | `www`    | `bas-franke.com` | 300 |
   | A     | `*`      | `<elastic-ip>`   | 300 |

   The wildcard `*` record means every future subdomain (`status`, `notes`, …) points at the server automatically.
   If you prefer explicit records, add one `A` record per subdomain instead.
3. Check from your machine: `nslookup bas-franke.com` and `nslookup status.bas-franke.com` both return the Elastic IP.
   Changes usually show up within minutes.

## 6. AWS: RDS (only when the first project needs a database)

1. **EC2 → Security Groups → Create**: name `rds-sg`, inbound: **PostgreSQL 5432, source = security group `web-sg`**.
   Nothing else. The database is never reachable from the internet.
2. **RDS → Create database**:
   - Standard create, **PostgreSQL** (latest version), template **Free tier** or **Production** as you like.
   - Identifier `bas-franke-db`, master username `postgres`, set a strong password.
   - Instance `db.t4g.micro`, 20 GB gp3.
   - Connectivity: same VPC as the EC2 instance, **Public access: No**, security group `rds-sg` (remove `default`).
   - Additional configuration → Initial database name: leave empty (each project creates its own).
3. Copy the **endpoint** from the database's Connectivity tab.
4. Test from the server: `psql "host=<endpoint> user=postgres dbname=postgres sslmode=require"`.
5. Put `RDS_HOST=<endpoint>` in `/srv/apps/status/.env` so the status page can monitor it.

Creating a database per project is described in [.claude/docs/adding-a-project.md](../.claude/docs/adding-a-project.md#2-database-only-if-needed).
