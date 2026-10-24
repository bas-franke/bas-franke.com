# Adding a new subdomain project

Example: a project called `notes` on `notes.bas-franke.com`, backend port `3003`, database `notes`.

## 1. Code (in this repo)

1. Copy the template: `cp -r portfolio notes` then delete `notes/frontend/node_modules`, `notes/backend/node_modules`,
   `dist/` folders, and the portfolio-specific content in `notes/frontend/src`.
2. Rename everything `portfolio` → `notes`:
   - `notes/*/package.json` → `name`
   - `notes/deploy/ecosystem.config.cjs` → `name`, `cwd`, env file path, `PORT`
   - `notes/deploy/nginx.conf` → `server_name`, `root`, cert paths, `proxy_pass` port
   - `notes/frontend/vite.config.ts` → proxy port
   - `notes/backend/src/index.ts` → default port
3. Copy `.github/workflows/deploy-portfolio.yml` → `deploy-notes.yml` and change the `PROJECT` env value,
   the `paths:` filter and the workflow `name`.
4. Add a row to the project table in `.claude/CLAUDE.md`.
5. Register the project in `status/backend/src/projects.ts` (name, domains, port, `database: true` if it has one)
   and redeploy `status`. The status page then shows exactly what is still missing for the new project.
6. Rewrite `notes/README.md` from the portfolio README, replacing the domain and names.

## 2. Database (only if needed)

Connect to RDS from the EC2 instance (`psql` is installed by the bootstrap script):

```bash
psql "host=<rds-endpoint> user=postgres dbname=postgres sslmode=require"
```

```sql
CREATE USER notes WITH PASSWORD '<strong-password>';
CREATE DATABASE notes OWNER notes;
REVOKE ALL ON DATABASE notes FROM PUBLIC;
```

Then put `DATABASE_URL=postgres://notes:<password>@<rds-endpoint>:5432/notes?sslmode=require` in
`/srv/apps/notes/.env` on the server.

## 3. External setup

- **name.com**: A record `notes` → Elastic IP (skip if a wildcard `*` record already exists).
- **AWS**: nothing new; the EC2 security group already allows 80/443 and RDS already allows the EC2 group.
- **GitHub**: nothing new; the secrets (repository or `main` environment) are shared by all workflows. Keep `environment: main` in the new workflow.
- **Server**: create folders, install the Nginx site, issue the certificate. The exact commands are in the
  "First-time server setup" section of the project README (same as portfolio, different names).

## 4. Deploy

Push to `master` or run the workflow manually from the GitHub Actions tab.
