# bas-franke.com monorepo

This repository holds **multiple independent projects** that are all deployed to **one AWS EC2 instance**.
Each project has its own Vite frontend and Node.js backend, its own deploy workflow, and (optionally) its own
database inside a **shared RDS instance**.

| Project     | Folder        | Domain                                  | Backend port | Database |
|-------------|---------------|-----------------------------------------|--------------|----------|
| portfolio   | `portfolio/`  | `bas-franke.com`, `www.bas-franke.com`  | 3001         | none     |
| status      | `status/`     | `status.bas-franke.com`                 | 3002         | none     |

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
