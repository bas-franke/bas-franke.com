# bas-franke.com monorepo

This repository holds **multiple independent projects** that are all deployed to **one AWS EC2 instance**.
Each project has its own Vite frontend and Node.js backend, its own deploy workflow, and (optionally) its own
database inside a **shared RDS instance**.

| Project     | Folder        | Domain                                  | Backend port | Database |
|-------------|---------------|-----------------------------------------|--------------|----------|
| portfolio   | `portfolio/`  | `bas-franke.com`, `www.bas-franke.com`  | 3001         | none     |
| status      | `status/`     | `status.bas-franke.com`                 | 3002         | `status` |
| inck        | `inck/`       | `inck.ai`, `www.inck.ai`                | 3003         | `inck`   |
| play        | `play/`       | `play.bas-franke.com`                   | 3004         | `play`   |
| wordward    | `wordward/`   | `wordward.bas-franke.com`               | 3005         | `wordward` |
| stonks      | `stonks/`     | `stonks.bas-franke.com`                 | 3006         | `stonks`   |

When adding a project, add a row here, register it in `status/backend/src/projects.ts` so the status page
monitors it, and follow [docs/adding-a-project.md](docs/adding-a-project.md).

The **status** project is the source of truth for "is everything set up?": every check it runs comes with fix
instructions. When you add a new kind of infrastructure, add a check for it in `status/backend/src/checks/`.

## Read these before making changes

- @.claude/docs/architecture.md: how the server, Nginx, PM2, RDS and DNS fit together
- @.claude/docs/conventions.md: the rules every project must follow
- @.claude/docs/adding-a-project.md: checklist for creating a new subdomain project

One-time shared infrastructure setup (EC2, RDS, GitHub secrets, name.com) lives in [infra/README.md](../infra/README.md).
Per-project setup lives in each project's own `README.md`.

## Golden rules

1. **Projects are standalone.** Never import code across project folders, never share a `package.json`,
   `node_modules` or lockfile between projects. Duplicating a small helper is fine.
2. **One project = one port, one PM2 process, one Nginx site, one workflow, one database.**
3. **Secrets never go in git.** Runtime secrets live on the server in `/srv/apps/<project>/.env`.
4. A change to one project must not require redeploying another.
5. **inck: bump `PROMPT_VERSION`** in `inck/backend/src/ai.ts` whenever you change the story-writing prompt
   (writer instructions, `STORY_SCHEMA`, text cleanup in `text.ts`); the scheduler then rewrites older stories.
6. **Upload screenshots of every design change** to the status page yourself, without being asked (see below).
7. **play: regenerate screenshots after graphical changes**: run `npm run screenshots -- --stale` in `play/` and commit
   the images, manifests and `screenshots.lock.json` with the change; `npm run screenshots:check` tells you which
   games are stale (see [play/SCREENSHOTS.md](../play/SCREENSHOTS.md)).
8. **Push intermittently.** Commit and push each verified, working piece to `master` as it lands (per feature or step,
   also mid-task and during multi-agent work), never one big commit at the end, so every iteration can be tested live.
   Don't push broken builds or failing tests. Tell subagents to do the same.
9. **stonks: publish research results.** After any stonks-local experiments (sweeps, campaigns, agent rounds) run
   `.venv/Scripts/python lab.py publish` in `stonks-local/` so the Research page (minute/hourly/daily/weekly/mixed tabs)
   shows the newest results. Campaign scripts publish at the end themselves.

## Screenshots of design changes

Whenever you (or a subagent) finish a visible design change in any project, whether it's the final result or a
finished intermediate step, take a screenshot of the result and upload it:

```bash
node status/tools/upload-screenshot.mjs --project <project> --title "<what changed>" [--note "<details>"] [--source agent] <file.png> [...]
```

- `--project` is the folder name from the table above. One upload per meaningful state; use several files for
  before/after or desktop/phone views. Pass `--source agent` when a subagent uploads, ideally with its role (`--source "agent: hud"`).
- Prefer JPEG/WebP or a cropped PNG under ~3 MB. Don't upload half-broken work-in-progress frames.
- The status backend keeps the **20 newest per project** and deletes older ones automatically. All projects show up
  together, newest first, at <https://status.bas-franke.com/screenshots>.
- The token comes from the git-ignored `.env.screenshots` in the repo root (`STATUS_SCREENSHOT_TOKEN=...`). If it's
  missing or an upload fails, say so in your report instead of skipping silently. Setup: status/README.md "Screenshots".
- Subagents that change visuals must be told to upload too (copy this section into their brief).
