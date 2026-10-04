#!/usr/bin/env bash
set -euo pipefail

# First-time installation only. Existing configuration and databases are preserved.
if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this installer with sudo bash install.sh.' >&2
  exit 1
fi
for command in docker wget openssl; do
  command -v "$command" >/dev/null || { echo "Missing dependency: $command" >&2; exit 1; }
done
docker compose version >/dev/null
docker info >/dev/null

install_dir=/opt/hidden-crown
if [ -e "$install_dir/.env" ] || [ -e "$install_dir/docker-compose.yml" ] || [ -e "$install_dir/data/hidden-crown.sqlite" ] || [ -e "$install_dir/data/hidden-crown-v2.sqlite" ]; then
  echo "Existing deployment in $install_dir; refusing to overwrite configuration or data." >&2
  exit 1
fi
public_origin=${1:-}
if [ -z "$public_origin" ]; then
  read -r -p 'Public HTTPS URL (example: https://chess.example.com): ' public_origin </dev/tty
fi
public_origin=${public_origin%/}
if [[ ! "$public_origin" =~ ^https://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:[0-9]{1,5})?$ ]]; then
  echo 'Enter a complete HTTPS origin without a path, query or fragment.' >&2
  exit 1
fi
admin_password=$(openssl rand -hex 24)
umask 077
mkdir -p "$install_dir"
cd "$install_dir"
# The installer and downloaded templates belong to the same versioned release tag.
config_base=https://raw.githubusercontent.com/KKazuhaK/hidden-crown/v2.3.1
wget -qO docker-compose.yml.new "$config_base/docker-compose.bind.yml"
wget -qO .env.example.new "$config_base/.env.example"
mv docker-compose.yml.new docker-compose.yml
mv .env.example.new .env.example
printf '%s\n' \
  "PUBLIC_ORIGIN=$public_origin" \
  'ADMIN_USERNAME=admin' \
  "ADMIN_PASSWORD='$admin_password'" \
  'HOST_PORT=8787' \
  'HIDDEN_CROWN_IMAGE=ghcr.io/kkazuhak/hidden-crown:2.3.1' \
  'DATABASE_URL=' \
  'WAITING_TIMEOUT_MINUTES=15' \
  'TRUSTED_PROXIES=' > .env
chmod 600 .env
# The image runs as UID/GID 1000:1000.
install -d -m 700 -o 1000 -g 1000 data
docker compose config --quiet
printf '\nAdministrator username: admin\nAdministrator password: %s\nSaved in %s/.env (mode 600).\n\n' "$admin_password" "$install_dir"
docker compose pull
docker compose up -d
for attempt in $(seq 1 30); do
  if wget -qO /dev/null --header="Host: ${public_origin#https://}" http://127.0.0.1:8787/healthz; then
    docker compose ps
    printf '\nApplication is ready. Configure host Nginx to proxy %s to http://127.0.0.1:8787 with WebSocket support.\nAdministrator URL: %s/admin\n' "$public_origin" "$public_origin"
    printf '\nBefore inviting players, set TRUSTED_PROXIES to the exact Nginx peer shown in /admin, pass a single real visitor IP in X-Forwarded-For, and recreate the application container.\n'
    exit 0
  fi
  sleep 1
done
docker compose logs --tail=50
echo 'Application did not become healthy within 30 seconds.' >&2
exit 1
