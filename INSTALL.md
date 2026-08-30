# Installing on Ubuntu Server

Tested target: a fresh Ubuntu Server 22.04 or 24.04 LTS with internet access.
The installer assumes the finance app owns this server (it becomes nginx's
default site).

## Quick install

Either clone on the server, or build a package locally and copy it across. Both
end at the same `install.sh` — it installs whatever directory it was run from.

**From a clone** (simplest; also lets `docs/deploy.sh` update via `git pull` later):

```bash
git clone https://github.com/LiamHammersley/AnotherFinanceApp.git
sudo bash AnotherFinanceApp/docs/install.sh finance.yourdomain.com
```

The frontend is built on the server in this case, since a clone carries no
`frontend/dist`.

**From a release package** (no git or build toolchain needed on the server —
the tarball ships a pre-built frontend):

```bash
# On your development machine
npm run package                       # → ../finance-app-<version>.tar.gz
scp finance-app-<version>.tar.gz you@your-server:

# On the server
tar xzf finance-app-<version>.tar.gz
sudo bash finance-app/docs/install.sh finance.yourdomain.com
```

The installer is idempotent (safe to re-run; it never overwrites
`/etc/finance/.env` or a certbot-edited nginx site) and handles everything:

1. Node 22 (NodeSource), PostgreSQL 16 (PGDG), and Nginx via apt — apt runs
   non-interactively and waits for unattended-upgrades to release the dpkg lock
2. `finance` system user (no shell, no sudo)
3. App copied to `/opt/finance-app`, frontend built to `/var/www/finance`
   (builds run as the `finance` user, never root)
4. `finance` database over local Unix socket (peer auth — no password anywhere)
5. `/etc/finance/.env` created with a generated `SESSION_SECRET` (root:finance, mode 640)
6. `finance-api.service` installed and started — migrations run automatically before boot
7. Nginx site installed with your domain, HTTPS from the start via Ubuntu's
   self-signed "snakeoil" cert (the session cookie is Secure-only, so plain
   HTTP would break logins), proxying `/api/` to localhost:3000; port 80
   redirects to HTTPS. If ufw is active, 80/443 are allowed.
8. Daily 02:00 DB backup installed at `/etc/cron.d/finance-backup`
   (dumps to `/var/backups/finance`, mode 750, 30-day rotation)
9. Health check: the API directly, then end-to-end through nginx

## After install

- **SSL**: the site works immediately at `https://your-server` with a browser
  warning (self-signed cert). Replace it with a real cert once DNS points here:
  `sudo apt-get install -y certbot python3-certbot-nginx && sudo certbot --nginx -d finance.yourdomain.com`
  — or edit `/etc/nginx/sites-available/finance` to point at an existing wildcard cert.
- **First run**: open the site — the one-time wizard creates your login (10+ char
  password), optionally stores your Anthropic API key, and sets up bank accounts.
  Then import your bank CSVs from the Import page (both common Australian layouts
  are auto-detected and mapped on first use).
- **Backups**: already scheduled — verify with `ls /var/backups/finance` after 02:00,
  or run one now: `sudo -u postgres bash /opt/finance-app/docs/backup.sh`.
  Restore steps: `docs/restore.md`.

## Updates — no console needed

Build a new package on your development machine (`npm run package`), then upload
it in the app: **Settings → Software update → Upload & install**. The server
validates the package, snapshots the running version to `/opt/finance-app/updates/previous`,
installs files and dependencies, publishes the new frontend, restarts itself, and
runs any new database migrations. Roll back by re-uploading an older package
(note: database migrations are not reversed automatically).

## Day-2 operations

| Task | Command |
|---|---|
| Deploy an update (console alternative) | replace files in `/opt/finance-app`, then `sudo bash /opt/finance-app/docs/deploy.sh` |
| Live logs | `journalctl -u finance-api -f` |
| Health check | `curl http://localhost:3000/api/health` |
| Unlock after failed logins | `cd /opt/finance-app/backend && sudo -u finance npm run unlock -- <username>` |
| Reset a forgotten password | `cd /opt/finance-app/backend && sudo -u finance npm run set-password -- <username> '<new password>'` |
| Restart API | `sudo systemctl restart finance-api` |
