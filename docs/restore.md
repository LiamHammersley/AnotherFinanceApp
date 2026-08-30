# Restore runbook

1. Stop the API so nothing writes during restore:
   ```bash
   sudo systemctl stop finance-api
   ```
2. Recreate the database:
   ```bash
   sudo -u postgres dropdb finance
   sudo -u postgres createdb -O finance finance
   ```
3. Restore from the chosen backup. The whole pipeline must run as `postgres` —
   dumps are mode 640 `postgres:postgres`, so `gunzip` run as anyone else fails
   (and a failed gunzip would otherwise feed psql empty input that "succeeds"):
   ```bash
   sudo -u postgres bash -c \
     'gunzip -c /var/backups/finance/finance-YYYY-MM-DD.sql.gz | psql -v ON_ERROR_STOP=1 -q finance'
   ```
4. Verify the data actually landed before starting the API:
   ```bash
   sudo -u postgres psql -tAc 'SELECT count(*) FROM transactions' finance
   ```
5. Start the API (migrations run automatically and are no-ops if the dump is current):
   ```bash
   sudo systemctl start finance-api
   curl -fsS http://localhost:3000/api/health
   ```
