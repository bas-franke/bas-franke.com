#!/usr/bin/env bash
# Creates the RDS user + database for each given project and stores DATABASE_URL in /srv/apps/<project>/.env.
# Safe to re-run: a project whose .env already has DATABASE_URL is left alone.
#
# Usage (on the server; the RDS master password is read from stdin so it never shows up in `ps`):
#   bash provision-db.sh status wordward <<< "$RDS_MASTER_PASSWORD"
# The RDS endpoint comes from RDS_HOST in /srv/apps/status/.env (or the RDS_HOST environment variable).
set -euo pipefail

APPS=/srv/apps
read -r MASTER_PASSWORD || true
[ -n "${MASTER_PASSWORD:-}" ] || { echo "::error::No RDS master password on stdin (secret RDS_MASTER_PASSWORD)."; exit 1; }
RDS_HOST=${RDS_HOST:-$(grep -E '^RDS_HOST=' "$APPS/status/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)}
[ -n "$RDS_HOST" ] || { echo "::error::RDS_HOST is not set in $APPS/status/.env."; exit 1; }

export PGPASSWORD=$MASTER_PASSWORD PGSSLMODE=require PGCONNECT_TIMEOUT=10
master() { psql -h "$RDS_HOST" -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

for project in "$@"; do
  [[ $project =~ ^[a-z][a-z0-9_]*$ ]] || { echo "::error::Bad project name: $project"; exit 1; }
  env_file=$APPS/$project/.env
  mkdir -p "$APPS/$project"
  touch "$env_file" && chmod 600 "$env_file"
  if grep -qE '^DATABASE_URL=' "$env_file"; then
    echo "$project: DATABASE_URL already set, skipping."
    continue
  fi

  password=$(openssl rand -hex 24)
  # The role may exist from an earlier half-finished attempt; its password is reset to the new one either way.
  master <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$project') THEN
    CREATE ROLE "$project" LOGIN PASSWORD '$password';
  ELSE
    ALTER ROLE "$project" LOGIN PASSWORD '$password';
  END IF;
END \$\$;
GRANT "$project" TO postgres;
SQL
  if [ -z "$(master -c "SELECT 1 FROM pg_database WHERE datname = '$project'")" ]; then
    master -c "CREATE DATABASE \"$project\" OWNER \"$project\""
    master -c "REVOKE ALL ON DATABASE \"$project\" FROM PUBLIC"
    echo "$project: created database and user."
  else
    master -c "ALTER DATABASE \"$project\" OWNER TO \"$project\""
    echo "$project: database existed, reset the user's password."
  fi

  echo "DATABASE_URL=postgres://$project:$password@$RDS_HOST:5432/$project?sslmode=require" >> "$env_file"
  if pm2 describe "$project" > /dev/null 2>&1; then
    pm2 restart "$project" --update-env > /dev/null
    echo "$project: restarted."
  fi
done
