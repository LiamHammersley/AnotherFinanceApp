#!/usr/bin/env bash
# Daily pg_dump backup, 30-day retention. Installed by install.sh as
# /etc/cron.d/finance-backup:  0 2 * * * postgres bash /opt/finance-app/docs/backup.sh
set -euo pipefail
umask 027  # dumps contain full financial history — no world access

BACKUP_DIR=/var/backups/finance
mkdir -p "$BACKUP_DIR"

pg_dump finance | gzip > "$BACKUP_DIR/finance-$(date +%F).sql.gz"

# Rotate: delete backups older than 30 days
find "$BACKUP_DIR" -name 'finance-*.sql.gz' -mtime +30 -delete
