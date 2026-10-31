# pulse

**pulse.bas-franke.com**: a cozy, single-user place for a homepage dashboard, a todo board and notes. Everything
autosaves (no save buttons) and every open tab or device updates live over a WebSocket.

- `frontend/`: Vite + React + TypeScript. Pages: Home (`/`), Board (`/board`), Notes (`/notes`, `/notes/<id>`).
- `backend/`: Node + Express + `ws`, PostgreSQL (`pulse` database in the shared RDS). Port **3007**.
- `deploy/`: Nginx site (with a WebSocket location for `/api/ws`) and the PM2 process.
- Workflow: `.github/workflows/deploy-pulse.yml` (deploys on push to `master` touching `pulse/**`).
- Art: every picture is a named slot, see [ART.md](ART.md) for the prompts and how to import the generated images.

## How it works

- Tasks (`title`, `details`, `status` todo/doing/done, `due` date, fractional `position`) and notes (`title`, `body`,
  `cover`, `pinned`) are plain tables. The client creates ids (UUIDs) and writes with `PUT /api/tasks/:id` and
  `PUT /api/notes/:id` (an upsert of just the fields that changed); `DELETE` removes.
- The client applies edits immediately (optimistic), debounces the save per item (~0.6 s for text), and shows a subtle
  "Saving… / Saved" state. The server broadcasts every change on `/api/ws`; other tabs apply it unless they have unsent
  edits of their own for that item. Reconnects resync from `GET /api/state`.
- Auth is one passphrase from `PULSE_PASSPHRASE` (see below). The session is an HttpOnly cookie signed with a key derived
  from the passphrase, so nothing is stored server side; changing the passphrase and restarting signs every device out.
  The WebSocket uses the same cookie.

## Local development

Needs Node 22.12+ (Vite 8). From `pulse/`:

```bash
npm run install:all
npm run dev          # throwaway Postgres on :5437, backend on :3007, Vite on :5173
```

Without `PULSE_PASSPHRASE` set, local dev is open (no login). Set it in `backend/.env.local` to test the login page.
`backend/.env.local` for the dev database:

```
DATABASE_URL=postgres://pulse:pulse@127.0.0.1:5437/pulse?sslmode=disable
```

## First-time server setup

1. **DNS**: a `pulse` A record to the Elastic IP (skip if a wildcard `*` record exists).
2. **Database**: run the "Provision databases" workflow (it already lists `pulse`); it creates the `pulse` user and
   database and writes `DATABASE_URL` to `/srv/apps/pulse/.env`.
3. **Passphrase**: add the repository secret `PULSE_PASSPHRASE` (GitHub → Settings → Secrets and variables → Actions)
   and run "Deploy pulse". Each deploy writes it to `/srv/apps/pulse/.env`; changing it signs every device out.

4. **Deploy**: push to `master` or run "Deploy pulse". The first deploy also issues the certificate and installs the
   Nginx site by itself. Migrations run at backend startup.

The status page (status.bas-franke.com) lists pulse and checks DNS, TLS, Nginx, PM2, the health endpoint, the database
and the WebSocket.
