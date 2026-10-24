# bas-franke.com

Monorepo of independent projects that all run on one AWS EC2 instance (Nginx + PM2), with optional per-project
databases in one shared RDS PostgreSQL instance.

| Project                    | URL                              |
|----------------------------|----------------------------------|
| [portfolio](portfolio/)    | <https://bas-franke.com>         |
| [status](status/)          | <https://status.bas-franke.com>  |

- **Starting from nothing?** Follow [status/README.md → Setup from zero](status/README.md#setup-from-zero).
- Shared infrastructure reference: [infra/README.md](infra/README.md)
- Architecture, conventions and how to add a project: [.claude/](.claude/CLAUDE.md)
