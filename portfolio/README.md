# portfolio: bas-franke.com

Personal portfolio on the root domain. Vite + React frontend, Node.js + Express backend on port **3001**. No database.

## Content, design and artwork

- **Words:** everything on the page is in [frontend/src/content.ts](frontend/src/content.ts) (intro, about, projects,
  skills, contact). Edit that file; the components only decide how it looks.
- **Look:** warm paper, soft ink, one lake-blue accent, hairlines instead of boxes, slow reveals. Colours and type live
  at the top of [frontend/src/styles.css](frontend/src/styles.css). Light and dark mode follow the system setting
  and can be switched with the toggle in the header.
- **Artwork:** the hero and every project have an image slot that shows a procedural line drawing until an image
  exists. The ChatGPT prompts, sizes and filenames are in [ART.md](ART.md); finished files go in `frontend/src/art/`.
- **Portrait:** `frontend/src/art/profile.jpg`. Company marks for the experience rows go in `frontend/src/art/logos/<slug>.png`.
- **Résumé:** the *Download résumé* button in the hero builds a white A4 PDF in the browser from the same
  `content.ts`: the portrait and company marks from `frontend/src/art/`, the jobs on a timeline, the skill tiers
  as chips behind a level meter (`level` in `content.ts`). The layout is [frontend/src/resume.ts](frontend/src/resume.ts),
  which only takes bytes and so also runs under Node; [frontend/src/resumeDownload.ts](frontend/src/resumeDownload.ts)
  fetches the images and triggers the download. pdf-lib is loaded only when clicked.

## Contact form (optional)

The contact section always shows the e-mail address and phone number. The form only appears once the backend can
send mail, which it does over SMTP using these variables in `/srv/apps/portfolio/.env`:

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
all three required variables are set, and `GET /api/contact` returns `{ "enabled": true }`, which makes the form appear.
Messages are rate-limited to 5 per IP per hour and a hidden honeypot field drops most bots.

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
Then open <https://bas-franke.com>; the footer shows **API online** when the backend is reachable.

## Troubleshooting

| Symptom                              | Check                                                        |
|--------------------------------------|--------------------------------------------------------------|
| Workflow fails at "Configure SSH"    | `EC2_HOST` secret, security group allows port 22            |
| Workflow fails at "Upload files"     | Deploy public key is in `~/.ssh/authorized_keys` on EC2      |
| Site shows 502 / API offline         | `pm2 status`, `pm2 logs portfolio`                           |
| Browser certificate error            | `sudo certbot certificates`, Nginx site is enabled          |
| `nginx -t` fails on cert path        | Run step 2 (certbot) before enabling the site                |

Or open <https://status.bas-franke.com>, which checks all of this for you.

## Updating Nginx config later

Nginx configs are not deployed by CI. After changing `deploy/nginx.conf`, repeat step 3.
