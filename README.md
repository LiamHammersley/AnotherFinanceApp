# Another Finance App

Self-hosted single-user personal finance tracker (AUD) with AI-assisted categorisation,
recurring detection, CSV import, P&L and net worth views.

Your data stays on your own server: PostgreSQL on the same box, no third-party
analytics, and no outbound calls except the Anthropic API when you enable the
optional AI features (which is server-side only — your API key never reaches the
browser).

## Screenshots

Every figure below is generated demo data — invented merchants, invented employer,
invented balances. Reproduce it with `node seed-demo.mjs` against a throwaway database
(see [Demo data](#demo-data)).

### Dashboard

Net position for the month, per-account sparklines, what needs attention, and where
the money actually went.

![Dashboard](docs/screenshots/dashboard.png)

### Transactions

Grouped by day with running net, the raw bank description kept under the cleaned-up
payee, and inline categorisation.

![Transactions](docs/screenshots/transactions.png)

### Budgets

Targets measured over their own period, with a shared pace notch marking how far
through the month you are — so "spent 88%" reads against "96% of the month gone"
rather than against nothing.

![Budgets](docs/screenshots/budgets.png)

### Net worth

Accounts plus the things that aren't accounts — super, property, vehicles, private
loans — valued over time, so a revaluation never rewrites history.

![Net worth](docs/screenshots/networth.png)

### Profit & loss

Rolling 12 months or a financial year, by category, with transfers and mortgage
principal excluded so the totals mean what they say.

![Profit and loss](docs/screenshots/pnl.png)

<details>
<summary>More screens — accounts, recurring, rules</summary>

![Accounts](docs/screenshots/accounts.png)

![Recurring](docs/screenshots/recurring.png)

![Rules](docs/screenshots/rules.png)

</details>

## Stack

React 18 + TypeScript + Vite + Tailwind (frontend) · Node 20+ + Fastify (backend) ·
PostgreSQL 16+ · Anthropic Claude API (server-side only) · Nginx + systemd (deploy).

## Installation

### Requirements

- **Node.js 20 or newer** (developed on 20, verified on 24)
- **PostgreSQL 16 or newer** (verified on 17)
- For the server install: **Ubuntu Server 22.04 or 24.04 LTS**

No Docker, no containers, no external services. The only outbound call the app
ever makes is to the Anthropic API, and only if you turn the AI features on.

### On a server (the intended way to run it)

One command on a fresh Ubuntu box installs Node, PostgreSQL, Nginx, a locked-down
`finance` system user, a systemd unit, HTTPS, and a nightly backup cron:

```bash
git clone https://github.com/LiamHammersley/AnotherFinanceApp.git
```

```bash
sudo bash AnotherFinanceApp/docs/install.sh finance.yourdomain.com
```

The installer is idempotent — safe to re-run, and it never overwrites your
`/etc/finance/.env` or a certbot-edited nginx site. Full detail, including the
self-signed-to-real certificate swap and day-2 operations, is in
[INSTALL.md](INSTALL.md).

### On your own machine

To try it locally, or to develop against it:

```bash
git clone https://github.com/LiamHammersley/AnotherFinanceApp.git
```

```bash
cd AnotherFinanceApp && npm install
```

```bash
createdb finance
```

```bash
cp .env.example .env
```

Set `DATABASE_URL` and `SESSION_SECRET` in `.env` — generate a secret with
`openssl rand -hex 32`. Then create the schema and start both halves:

```bash
npm run migrate
```

```bash
DATABASE_URL=postgresql:///finance npm run dev:backend
```

```bash
npm run dev:frontend
```

The API listens on `:3000` (localhost only) and Vite serves the UI on `:5173`,
proxying `/api` through to it. Open <http://localhost:5173>.

The tests need no database — they cover the pure services (csv, vendor, search,
dedupe, rules, budgets) and run directly under node:

```bash
npm test
```

### First run

The first visit shows a one-time setup wizard: it creates your login (minimum
10 characters), optionally stores an Anthropic API key, and sets up your accounts.
After that you can import bank CSVs from the Import page, or load the
[demo data](#demo-data) to look around first.

## Demo data

`seed-demo.mjs` fills an empty database with twelve months of invented activity —
four accounts, ~380 transactions, holdings, budgets, goals, recurring entries and
rules. It's what the screenshots above show, and it's the fastest way to see whether
the app is worth your time before importing anything real.

It **truncates every table first**, so point it at a throwaway database only:

```bash
DATABASE_URL=postgresql:///finance_demo node seed-demo.mjs
```

Then sign in as `demo` / `demo-password-2026`.

## Running it day to day

Once installed, the pieces live in `docs/`: `nginx.conf`, `finance-api.service`,
`deploy.sh`, `backup.sh`, `restore.md`. Secrets live in `/etc/finance/.env`
(root-owned, mode 640, group `finance`) — never in the repo.

- Health: `GET /api/health`
- Logs: `journalctl -u finance-api -f`
- Locked out after failed logins: `npm run unlock -- <username>` in `backend/`
- Forgotten password: `npm run set-password -- <username> '<new password>'` in `backend/`
- Backups: Settings → Backup downloads a full dump; `docs/backup.sh` still runs on cron

## CHANGELOG

### 1.0.0
Initial release: accounts, transactions, CSV import (signed-amount and Debit/Credit presets),
transfers, categories, rules, AI categorisation/analysis/NL query, recurring detection,
alerts, bulk ops with undo, dashboard, P&L, net worth, audit log, first-run wizard.

## CSV import

Two layouts are auto-detected, covering most Australian bank exports:

- **Signed amount** — no header row, one amount column, expenses negative
- **Debit / Credit** — header row, separate debit and credit columns

The column mapping you confirm is remembered per account. Dates are read as
dd/mm/yyyy. Credit-card debits negate, so a purchase increases what you owe.

## Licence

MIT — see [LICENSE](LICENSE).
