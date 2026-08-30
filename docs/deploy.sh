#!/usr/bin/env bash
# Deploy an update: pull, build, copy static files, restart API (runs migrations), health check.
#   sudo bash /opt/finance-app/docs/deploy.sh
set -euo pipefail

APP_DIR=/opt/finance-app
WEB_ROOT=/var/www/finance

[ "$EUID" -eq 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }

cd "$APP_DIR"
# Files may have been replaced as root (tarball installs) — restore ownership
# before building so npm/git run cleanly as the service user.
chown -R finance:finance "$APP_DIR"

# Tarball installs have no git checkout — update files manually, then re-run this
if sudo -u finance -H git rev-parse --git-dir >/dev/null 2>&1; then
  sudo -u finance -H git pull
  HAS_GIT=1
else
  echo "Not a git checkout — skipping pull."
  HAS_GIT=0
fi

# Workspace lockfile is at the repo root — run npm from here, not per-package.
# Always build as the unprivileged service user, never as root.
sudo -u finance -H npm ci --workspace backend --omit=dev
if [ -f frontend/dist/index.html ] && [ "$HAS_GIT" -eq 0 ]; then
  echo "Using pre-built frontend from the package."
else
  sudo -u finance -H npm ci --workspace frontend
  sudo -u finance -H npm run build --workspace frontend
fi

rsync -a --delete frontend/dist/ "$WEB_ROOT"/
chown -R finance:finance "$WEB_ROOT" # keep in-app updates able to publish the frontend

systemctl restart finance-api

for i in $(seq 1 30); do
  if curl -fsS http://localhost:3000/api/health > /dev/null; then
    echo "Deploy OK — health endpoint returned 200."
    exit 0
  fi
  sleep 1
done
echo "Deploy FAILED — health endpoint did not return 200 within 30s." >&2
journalctl -u finance-api -n 30 --no-pager >&2
exit 1
