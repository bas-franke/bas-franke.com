# Architecture

```
                 name.com DNS
   bas-franke.com, www, <sub>.bas-franke.com  ──A record──►  Elastic IP
                                                               │
┌──────────────────────────── EC2 (Ubuntu 24.04) ──────────────┼──────────────┐
│                                                              ▼              │
│   Nginx :80/:443  (one site file per project, TLS via Let's Encrypt)         │
│     ├─ bas-franke.com        → /var/www/portfolio/frontend   (static)        │
│     │                          /api/* → 127.0.0.1:3001       (PM2: portfolio)│
│     └─ <sub>.bas-franke.com  → /var/www/<sub>/frontend                       │
│                                /api/* → 127.0.0.1:30xx       (PM2: <sub>)    │
│                                                                              │
│   PM2 (runs as `ubuntu`, started on boot)                                    │
└──────────────────────────────────────────────┬───────────────────────────────┘
                                               │ 5432 (private, SG-to-SG only)
                                  ┌────────────▼────────────┐
                                  │ RDS PostgreSQL instance │
                                  │  db: portfolio (later)  │
                                  │  db: <sub>              │
                                  └─────────────────────────┘
```

## Server layout

| Path                                   | Contents                                                  | Written by        |
|----------------------------------------|-----------------------------------------------------------|-------------------|
| `/var/www/<project>/frontend/`         | Built Vite output (`dist/`), served directly by Nginx     | GitHub Actions    |
| `/srv/apps/<project>/backend/`         | Built backend (`dist/`), `package.json`, `node_modules`   | GitHub Actions    |
| `/srv/apps/<project>/.env`             | Runtime secrets (DB URL, API keys). **Never in git.**     | You, once, by SSH |
| `/etc/nginx/sites-available/<project>` | Copy of `<project>/deploy/nginx.conf`                     | You, once, by SSH |
| `/etc/letsencrypt/live/<domain>/`      | TLS certificates                                          | certbot           |

## Request flow

- Requests for `/api/*` are proxied by Nginx to the project's backend on `127.0.0.1:<port>`.
  Backends bind to `127.0.0.1` only, so they are never reachable from the internet directly.
- Everything else is served from the static frontend folder with an SPA fallback to `index.html`.
- Frontend and backend share an origin, so **no CORS is needed**. The frontend always calls relative URLs (`/api/...`).

## Deployment flow

1. Push to `master` touching `<project>/**` (or run the workflow manually).
2. `.github/workflows/deploy-<project>.yml` builds frontend and backend on the GitHub runner.
3. It `rsync`s the frontend build to `/var/www/<project>/frontend/` and the backend build to
   `/srv/apps/<project>/backend/` over SSH.
4. On the server it runs `npm ci --omit=dev` and `pm2 startOrReload` for that project only.

Nginx configs and TLS certificates are **not** touched by CI; they are installed once by hand (see each project's README).
That keeps the CI SSH user free of `sudo`.

## Shared resources

- **EC2**: one instance, one Elastic IP, one security group `web-sg` (22, 80, 443 open; SSH is key-only + fail2ban
  because GitHub Actions runners have changing IPs).
- **Nginx port 80** is a single catch-all site (`00-default`, installed by `infra/ec2-bootstrap.sh`) that answers
  Let's Encrypt challenges from `/var/www/letsencrypt` and redirects everything else to HTTPS. Project site files
  therefore only contain `443` server blocks. Certificates are issued with `certbot certonly --webroot` and renew automatically.
- **RDS**: one PostgreSQL instance. Each project that needs a DB gets its **own database and its own DB user**
  with rights only on that database. Connection string goes in `/srv/apps/<project>/.env` as `DATABASE_URL`.
- **GitHub secrets** (repository level, shared by all workflows): `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`.
