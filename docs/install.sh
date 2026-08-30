#!/usr/bin/env bash
# One-time install on a fresh Ubuntu Server 22.04/24.04.
#   sudo bash docs/install.sh [your-domain.example.com]
# Installs Node 22 (NodeSource), PostgreSQL 16 (PGDG), Nginx; creates the
# finance user/db, builds the app, installs systemd + nginx (self-signed cert
# until certbot replaces it), daily DB backups, and starts everything.
# Idempotent: safe to re-run. Re-runs never touch /etc/finance/.env or an
# existing nginx site file (so certbot's edits survive).
set -euo pipefail
trap 'echo "!! Install failed at line $LINENO — see the output above." >&2' ERR

DOMAIN="${1:-finance.example.com}"
APP_DIR=/opt/finance-app
WEB_ROOT=/var/www/finance
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[ "$EUID" -eq 0 ] || { echo "Run as root: sudo bash $0 [domain]"; exit 1; }

# Fresh servers: keep apt non-interactive (needrestart prompts on 22.04+) and
# wait out unattended-upgrades instead of dying on the dpkg lock.
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT=(apt-get -qq -o DPkg::Lock::Timeout=600)

echo "== 1/9 Prerequisites (Node 22, PostgreSQL 16, Nginx) =="
"${APT[@]}" update
"${APT[@]}" install -y curl ca-certificates openssl rsync nginx ssl-cert
if ! command -v node >/dev/null || ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  "${APT[@]}" install -y nodejs
fi
if ! command -v psql >/dev/null; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  "${APT[@]}" update
  "${APT[@]}" install -y postgresql-16
fi
systemctl enable --now postgresql

echo "== 2/9 System user =="
id -u finance >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin finance

echo "== 3/9 Application files =="
mkdir -p "$APP_DIR"
# updates/ holds in-app update snapshots and uploaded packages — never clobber it
rsync -a --delete --exclude node_modules --exclude .env --exclude updates "$SRC_DIR"/ "$APP_DIR"/
chown -R finance:finance "$APP_DIR"

echo "== 4/9 Database (local socket, peer auth — no password) =="
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='finance'" | grep -q 1 || sudo -u postgres createuser finance
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='finance'" | grep -q 1 || sudo -u postgres createdb -O finance finance

echo "== 5/9 Environment file =="
if [ ! -f /etc/finance/.env ]; then
  mkdir -p /etc/finance
  sed -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" \
      "$APP_DIR/.env.example" > /etc/finance/.env
  chown root:finance /etc/finance/.env
  chmod 640 /etc/finance/.env
  echo "   Created /etc/finance/.env with a generated SESSION_SECRET."
else
  echo "   /etc/finance/.env already exists — left untouched."
fi

echo "== 6/9 Build =="
# npm workspaces: the lockfile lives at the repo root, so npm runs from there.
# Always build as the unprivileged service user, never as root.
(cd "$APP_DIR" && sudo -u finance -H npm ci --workspace backend --omit=dev)
if [ -f "$APP_DIR/frontend/dist/index.html" ]; then
  echo "   Using pre-built frontend shipped in the package (no server-side build)."
else
  (cd "$APP_DIR" && sudo -u finance -H npm ci --workspace frontend && sudo -u finance -H npm run build --workspace frontend)
fi
mkdir -p "$WEB_ROOT"
rsync -a --delete "$APP_DIR/frontend/dist/" "$WEB_ROOT"/
# The service user owns the web root so in-app updates (Settings → Software
# update) can publish new frontend builds without the console.
chown -R finance:finance "$WEB_ROOT"

echo "== 7/9 systemd service =="
cp "$APP_DIR/docs/finance-api.service" /etc/systemd/system/finance-api.service
systemctl daemon-reload
systemctl enable finance-api
# restart (not enable --now) so a re-run picks up new code and re-runs migrations
systemctl restart finance-api

echo "== 8/9 Nginx + firewall =="
if [ ! -f /etc/nginx/sites-available/finance ]; then
  # Ships with Ubuntu's snakeoil self-signed cert so HTTPS (and therefore the
  # app's secure session cookie) works immediately; certbot replaces it later.
  sed "s/finance\.example\.com/$DOMAIN/g" "$APP_DIR/docs/nginx.conf" > /etc/nginx/sites-available/finance
else
  echo "   /etc/nginx/sites-available/finance already exists — left untouched (preserves certbot edits)."
fi
ln -sf ../sites-available/finance /etc/nginx/sites-enabled/finance
rm -f /etc/nginx/sites-enabled/default  # this app is the server's default vhost
nginx -t
systemctl reload nginx
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "Nginx Full" >/dev/null
  echo "   ufw is active — allowed 'Nginx Full' (80/443)."
fi

echo "== 9/9 Backups + health check =="
install -d -m 750 -o postgres -g postgres /var/backups/finance
cat > /etc/cron.d/finance-backup <<CRON
# Daily finance DB dump to /var/backups/finance, 30-day rotation (docs/backup.sh)
0 2 * * * postgres bash $APP_DIR/docs/backup.sh
CRON
chmod 644 /etc/cron.d/finance-backup
for i in $(seq 1 30); do
  curl -fsS http://localhost:3000/api/health >/dev/null 2>&1 && { echo "   API healthy."; break; }
  [ "$i" -eq 30 ] && { echo "   API failed to start:"; journalctl -u finance-api -n 30 --no-pager; exit 1; }
  sleep 1
done
# End-to-end: through nginx, TLS and the /api/ proxy (-k: self-signed at first)
curl -fskS -H "Host: $DOMAIN" https://127.0.0.1/api/health >/dev/null \
  && echo "   Nginx → API proxy healthy." \
  || { echo "   Nginx proxy check failed — see: nginx -t && journalctl -u nginx"; exit 1; }

cat <<EOF

Install complete — https://$DOMAIN (also reachable by server IP).
  1. Point DNS for $DOMAIN at this server.
  2. The site currently uses a self-signed certificate (browser warning).
     Get a real one:  sudo apt-get install -y certbot python3-certbot-nginx
                      sudo certbot --nginx -d $DOMAIN
     (or edit /etc/nginx/sites-available/finance to point at an existing wildcard cert)
  3. Open the site — the first-run wizard creates your login, API key, and accounts.

Ongoing:  deploy updates   sudo bash $APP_DIR/docs/deploy.sh
          logs             journalctl -u finance-api -f
          backups          daily 02:00 via /etc/cron.d/finance-backup → /var/backups/finance
          restore          see $APP_DIR/docs/restore.md
          unlock login     cd $APP_DIR/backend && sudo -u finance npm run unlock -- <username>
EOF
