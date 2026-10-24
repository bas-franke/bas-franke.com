# Conventions

## Project folder layout

Every project is a top-level folder with the same shape (copy `portfolio/` as the template):

```
<project>/
├── README.md                 # setup checklist: GitHub, AWS, name.com, first deploy
├── package.json              # convenience scripts only (dev both sides, install all)
├── frontend/                 # Vite + React + TypeScript
│   ├── package.json          # own lockfile
│   ├── vite.config.ts        # dev proxy /api → http://localhost:<port>
│   └── src/
├── backend/                  # Node.js + Express + TypeScript
│   ├── package.json          # own lockfile
│   ├── tsconfig.json         # compiles src/ → dist/
│   └── src/index.ts
└── deploy/
    ├── nginx.conf            # Nginx site for this project's domain
    └── ecosystem.config.cjs  # PM2 process definition
```

And one workflow at the repo root: `.github/workflows/deploy-<project>.yml` (GitHub only reads workflows from there).

## Naming

- Project folder name = PM2 process name = Nginx site name = database name = database user name
  (lowercase, letters/digits/hyphens; use underscores instead of hyphens for the database and DB user).
- Subdomain is normally the project name: `<project>.bas-franke.com`. The portfolio is the exception and owns the root domain.

## Ports

Backends listen on `127.0.0.1` with ports starting at **3001**, one per project, recorded in the table in
`.claude/CLAUDE.md`. Pick the next free number for a new project. The port appears in exactly three places:
`backend` default `PORT`, `deploy/ecosystem.config.cjs`, `deploy/nginx.conf`, plus the frontend `vite.config.ts` proxy.

## Backend rules

- All HTTP routes are mounted under `/api` (Nginx only forwards `/api/*`).
- Always expose `GET /api/health` returning `{ "status": "ok" }`; the deploy workflow checks it.
- Read config from `process.env` only. PM2 loads `/srv/apps/<project>/.env` via `--env-file-if-exists`.
- `app.set('trust proxy', 1)` so `req.ip` / `req.protocol` reflect the real client behind Nginx.
- Database: PostgreSQL via `DATABASE_URL`. Use TLS to RDS (`?sslmode=require`).

## Frontend rules

- Use relative API URLs (`fetch('/api/...')`), never hard-coded hosts.
- Build output goes to `frontend/dist/` (Vite default).
- Only `VITE_`-prefixed env vars reach the browser; never put secrets in them.

## Tooling

- Node.js **24 LTS** on the server and in CI. Locally Node 22.12+ is required by current Vite.
- npm (not yarn/pnpm), each package with its own `package-lock.json` committed.
- Default branch is `master`; deploys run on push to `master`.
