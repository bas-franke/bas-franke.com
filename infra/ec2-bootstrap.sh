#!/usr/bin/env bash
# One-time setup for the shared EC2 instance (Ubuntu 24.04).
# Run as the default `ubuntu` user:  bash ec2-bootstrap.sh
# Safe to re-run.
set -euo pipefail

NODE_MAJOR=24
DEPLOY_USER="${DEPLOY_USER:-ubuntu}"

echo "==> System packages"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  nginx certbot rsync postgresql-client fail2ban curl ca-certificates gnupg dnsutils

echo "==> Node.js ${NODE_MAJOR} (NodeSource, system-wide so non-interactive SSH finds it)"
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}.* ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==> PM2 (process manager for all backends)"
sudo npm install -g pm2
sudo env PATH="$PATH" pm2 startup systemd -u "$DEPLOY_USER" --hp "/home/$DEPLOY_USER" >/dev/null
pm2 save --force

echo "==> Swap (1 GB) for npm installs on small instances"
if [ ! -f /swapfile ]; then
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> App folders"
sudo mkdir -p /var/www /srv/apps /var/www/letsencrypt
sudo chown "$DEPLOY_USER:$DEPLOY_USER" /var/www /srv/apps

echo "==> Nginx catch-all on port 80 (ACME challenges + redirect to HTTPS)"
sudo tee /etc/nginx/sites-available/00-default >/dev/null <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/00-default /etc/nginx/sites-enabled/00-default
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

echo "==> fail2ban (protects SSH, which must be open for GitHub Actions)"
sudo systemctl enable --now fail2ban

echo
echo "Done. Next: add the GitHub Actions deploy key to ~/.ssh/authorized_keys (see infra/README.md)."
