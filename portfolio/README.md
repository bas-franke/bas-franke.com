# portfolio: bas-franke.com

Personal portfolio on the root domain. Vite + React frontend, Node.js + Express backend on port **3001**. No database.

## Content, design and artwork

- **Direction:** [DESIGN.md](DESIGN.md) is the brief: one day at the window, from dawn in the hero to night at Contact.
- **Words:** everything on the page is in [frontend/src/content.ts](frontend/src/content.ts) (intro, about, projects,
  skills, contact). Edit that file; the components only decide how it looks.
- **Look:** plain CSS in [frontend/src/styles/](frontend/src/styles/), one file per part of the page, imported in order
  by `index.css`. Colours and type are tokens in [tokens.css](frontend/src/styles/tokens.css). Light and dark mode
  follow the system setting and can be switched with the toggle in the header.
- **Artwork:** paintings in `frontend/src/art/`; an interlude or the Contact painting without a file is left out. The
  ChatGPT prompts, sizes and filenames are in [ART.md](ART.md).
- **Portrait:** `frontend/src/art/profile.jpg`. Company marks for the experience rows go in `frontend/src/art/logos/<slug>.png`.
- **Résumé:** the *Download résumé* button builds a white A4 PDF in the browser from the same
  `content.ts`: the portrait and company marks from `frontend/src/art/`, the jobs on a timeline, the skill tiers
  as chips behind a level meter (`level` in `content.ts`). The layout is [frontend/src/resume.ts](frontend/src/resume.ts),
  which only takes bytes and so also runs under Node; [frontend/src/resumeDownload.ts](frontend/src/resumeDownload.ts)
  fetches the images and triggers the download. pdf-lib is loaded only when clicked.

## Contact form

The contact section always shows the e-mail address, the phone number and the form. Once the backend can send mail,
the form sends through it. Until then the form opens the visitor's own mail app with the message filled in, so these
variables in `/srv/apps/portfolio/.env` are optional:

| Variable       | Required | Purpose                                                             |
|----------------|----------|---------------------------------------------------------------------|
| `SMTP_HOST`    | yes      | e.g. `smtp.gmail.com`                                               |
| `SMTP_USER`    | yes      | Login, usually the full mailbox address                             |
| `SMTP_PASS`    | yes      | Password. For Gmail, create an *App password* (2-step verification required) |
| `SMTP_PORT`    | no       | Default `587` (STARTTLS); use `465` with `SMTP_SECURE=true`         |
| `SMTP_SECURE`  | no       | `true` for implicit TLS on port 465                                 |
| `CONTACT_TO`   | no       | Where messages go; defaults to `SMTP_USER`                          |
| `CONTACT_FROM` | no       | Sender address; defaults to `SMTP_USER`                             |

After editing `.env`: `pm2 restart portfolio --update-env`. `GET /api/health` reports `"mail": "configured"` when
all three required variables are set, and `GET /api/contact` returns `{ "enabled": true }`, which makes the form send
directly. Messages are rate-limited to 5 per IP per hour and a hidden honeypot field drops most bots.

## Run locally

Requires Node.js 22.12+ (Node 24 recommended).

```bash
npm run install:all
npm run dev
```

- Frontend: <http://localhost:5173> (Vite proxies `/api` to the backend on `127.0.0.1:3001`)
- Backend: <http://localhost:3001/api/health>

## Setup checklist

Do the shared [infra setup](../infra/README.md) first (EC2, Elastic IP, bootstrap, deploy key, GitHub secrets).
Then for this project:

### name.com

| Type  | Host      | Answer           |
|-------|-----------|------------------|
| A     | *(empty)* | `<elastic-ip>`   |
| CNAME | `www`     | `bas-franke.com` |

Remove name.com's default parking/forwarding records for `@`. Check with `nslookup bas-franke.com`.

### AWS

Nothing project-specific. The `web-sg` security group already allows 80/443.

### GitHub

Nothing project-specific. The workflow [deploy-portfolio.yml](../.github/workflows/deploy-portfolio.yml) uses the
shared secrets `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`.

### First-time server setup

SSH in (`ssh -i bas-franke-ec2.pem ubuntu@<elastic-ip>`) once DNS points at the server, then:

```bash
# 1. Folders + optional env file (owned by ubuntu so CI can write without sudo)
mkdir -p /var/www/portfolio/frontend /srv/apps/portfolio/backend
touch /srv/apps/portfolio/.env && chmod 600 /srv/apps/portfolio/.env

# 2. TLS certificate (uses the shared port-80 site from the bootstrap script)
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d bas-franke.com -d www.bas-franke.com \
  --deploy-hook "systemctl reload nginx" \
  -m <your-email> --agree-tos -n
```

```bash
# 3. Nginx site (run from your machine, then enable it on the server)
scp -i bas-franke-ec2.pem portfolio/deploy/nginx.conf ubuntu@<elastic-ip>:~/portfolio.nginx.conf
```

```bash
sudo mv ~/portfolio.nginx.conf /etc/nginx/sites-available/portfolio
sudo ln -sf /etc/nginx/sites-available/portfolio /etc/nginx/sites-enabled/portfolio
sudo nginx -t && sudo systemctl reload nginx
```

### First deploy

GitHub → **Actions → Deploy portfolio → Run workflow** (or push a change under `portfolio/` to `master`).
Then open <https://bas-franke.com>; <https://bas-franke.com/api/health> answers when the backend is reachable.

## Troubleshooting

| Symptom                              | Check                                                        |
|--------------------------------------|--------------------------------------------------------------|
| Workflow fails at "Configure SSH"    | `EC2_HOST` secret, security group allows port 22            |
| Workflow fails at "Upload files"     | Deploy public key is in `~/.ssh/authorized_keys` on EC2      |
| Site or `/api/health` shows 502      | `pm2 status`, `pm2 logs portfolio`                           |
| Browser certificate error            | `sudo certbot certificates`, Nginx site is enabled          |
| `nginx -t` fails on cert path        | Run step 2 (certbot) before enabling the site                |

Or open <https://status.bas-franke.com>, which checks all of this for you.

## Updating Nginx config later

Nginx configs are not deployed by CI. After changing `deploy/nginx.conf`, repeat step 3.
