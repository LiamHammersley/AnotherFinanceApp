# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Self-hosted single-user personal finance tracker (AUD): CSV bank import, AI-assisted categorisation via the Anthropic API, transfers, recurring detection, P&L and net worth views.

This repo is an npm workspace monorepo with `backend/` (Node 20+, Fastify 5, ES modules, plain JS) and `frontend/` (React 18 + TypeScript + Vite + Tailwind 4). PostgreSQL 16, no ORM — raw SQL via `pg`.

## Commands

Run from the repo root:

```bash
createdb finance && cp .env.example .env   # one-time; set DATABASE_URL + SESSION_SECRET
npm install
npm run migrate                            # node-pg-migrate, raw SQL files in backend/migrations/
DATABASE_URL=postgresql:///finance npm run dev:backend   # Fastify on :3000 (localhost only)
npm run dev:frontend                       # Vite on :5173, proxies /api → :3000
npm test                                   # backend/test/*.test.js — plain node asserts, no test framework
npm run build                              # tsc -b && vite build (frontend)
npm run package                            # builds frontend + tars a release → ../finance-app-<version>.tar.gz
```

There is no linter. Test files are run directly with node (`node test/csv.test.js`) and chained in the backend's `test` script; there is no runner to filter individual tests. They cover the pure services only — csv, vendor, search, dedupe and the rules engine.

Production is Ubuntu + systemd + Nginx, no containers — see `INSTALL.md` and `docs/` (`install.sh` is idempotent; in-app updates upload a `npm run package` tarball via Settings). Bump the root `package.json` version when producing a release package — the update endpoint compares versions and snapshots the previous install.

## Architecture

**Backend** (`backend/src/`):
- `server.js` — app assembly: a single `preHandler` hook enforces cookie-session auth on everything except the `PUBLIC` list (`/api/health`, login, setup endpoints). All route modules register under the `/api` prefix. Binds to 127.0.0.1 only; Nginx is the sole public entry point in production.
- `db.js` — `q(text, params)` query helper, `audit()` (write-through audit log), `getSetting`/`setSetting` (key-value `settings` table), and `cleanup()` retention job (soft-deleted transactions purged after 30d, undo history 24h, audit 12mo). Note the DATE type parser override: Postgres DATEs come back as plain `'YYYY-MM-DD'` strings, never JS Dates — keep it that way to avoid timezone day-shift bugs.
- `routes/*.js` — one module per resource, default-exporting an async Fastify plugin. Handlers write SQL inline; mutations call `audit(action, entityType, id, previous, next)`, and bulk operations also insert into `undo_history` (24-hour undoable window, `POST /undo/:id` replays the saved rows).
- `services/` — `csv.js` is pure functions (parser, date/amount parsing, column mapping, transfer-fragment detection) with no DB access; this is what the tests cover. `ai.js` calls the Anthropic Messages API with plain `fetch` (deliberately no SDK), logs token usage to `ai_usage`, and resolves config as Settings-table value → env var → default (two models: cheap one for categorisation, bigger one for analysis/NL query).

**Frontend** (`frontend/src/`):
- `App.tsx` — no auth library: a state machine (`loading → setup | login | ready`) driven by `/setup/status` and `/auth/me`, then plain react-router routes inside `Layout`. No global state store; pages fetch directly.
- `lib/api.ts` — thin fetch wrappers (`get/post/patch/put/del`, plus `upload` for binary). 401s outside auth/setup redirect to `/login`. JSON content-type is only set when a body exists (Fastify 400s on an empty JSON body).
- `lib/vendor.ts` — display-only derivation of a clean merchant name from raw bank descriptions; the stored payee always keeps the full original text.
- `pages/` — one file per route; shared primitives in `components/ui.tsx`.

**Database conventions** (see `backend/migrations/0001_init.sql`):
- All money is signed integer cents (`amount_cents BIGINT`): expenses negative, income positive. Never floats.
- UUIDs generated in app code (`uuid()` from `db.js`), not by the DB.
- Transactions are soft-deleted (`deleted_at`); transfers are two linked rows sharing a `transfer_group`, with `type='transfer'` and no category.
- `type` is the "how does this count" axis. The P&L and dashboard select `type IN ('income','expense','interest')`, so `transfer`, `adjustment` and `excluded` are invisible to them while still moving account balances and net worth. `excluded` is the per-transaction escape hatch for real money that is neither income nor spending (a mortgage principal leg, an owner drawing) — set via the row menu or the bulk bar, never automatically. For the recurring case, `categories.excluded` does the same job for a whole category or group (set on a group, it cascades to its sub-categories); `IN_PNL()` in `routes/views.js` is the single predicate combining both, so any new P&L-style query should use it rather than `PNL_TYPES` alone.
- `assign_source` tracks categorisation provenance: `'manual'`, `'rule:<name>'`, `'ai'`, or `'ai_suggested:<categoryId>'` for pending suggestions.
- Rules are a named, ordered, toggleable list. Conditions live in `rules.conditions` (JSONB array of `{field, op, value, value2?}` over payee/amount/account/direction) combined by `match_all`. `services/rules.js` holds the one definition of matching — `matchesRule()` for a single row and `conditionsSql()` for previews and bulk application — and `test/rules-engine.test.js` proves the two agree. Actions: assign a category (only ever fills a blank, never overwrites) and/or `rename_to`, which sets the display `vendor` and applies to every match.
- Budgets are a dated series, not a mutable number: `budgets(category_id, period, amount_cents, effective_from)` with the row in force for a month being the most recent at or before it, so raising this month's target never rewrites last month's report. `amount_cents NULL` means "stop budgeting from here", leaving 0 free to mean "spend nothing". Period maths lives in `services/budget.js` (`windowFor`, `elapsed`, `status`, `perMonth`) — every budget is measured over its OWN window, so a yearly target compares against the financial year, not a twelfth of it. A group's own target is authoritative for the whole group; sub-targets are limits inside it and the two are never summed.
- The AI budget planner (`routes/budget-ai.js`) runs on Fable 5 with extended thinking (`ai_model_budget` / `ai_budget_effort` settings; effort is off/low/medium/high). Models express thinking two different ways — a token budget (`thinking.type: enabled`) or adaptive plus `output_config.effort` — so `callClaude` picks the likely shape per model and RETRIES with the other if the API rejects it (`test/ai-thinking.test.js` proves both directions). Don't hardcode one dialect. Its output is untrusted input: `services/budget-plan.js` validates every proposal against the categories actually offered and computes all totals itself, because a plan whose arithmetic disagrees with its own line items is worse than no plan. `ANTHROPIC_BASE_URL` can point the API call at a stub or proxy — that's how the round trip is tested without tokens.
- The Budgets screen has a fixed design contract: two tabs, every bar carrying a shared pace notch at day-of-month ÷ days-in-month, trailing averages (never this month's spend) as the reference number on unbudgeted rows, and the AI plan rendered as a verdict banner + per-category change rows. `budget_plans.summary` is JSONB — it was TEXT holding JSON for one release, which is how the raw payload leaked into the history list, so always read it through `planResponse()`.
- Migrations are raw SQL files with `-- Up Migration` / `-- Down Migration` sections, run by node-pg-migrate.

**PWA**: the app is installable. `frontend/public/` holds `manifest.webmanifest`, `sw.js`, and icons (regenerate icons with `node scripts/make-icons.mjs` in `frontend/`). The service worker is registered in `main.tsx` (production only) and is deliberately minimal: network-first for navigations (so in-app software updates roll out immediately), cache-first for hashed `/assets/`, and it never touches `/api/`. Keep pages usable at 390px: tables live inside `overflow-x-auto` wrappers with a `min-w-*` on the table, wide flex rows get `flex-wrap`, and the header nav is a horizontal scroll strip.

**CSV import**: two layouts (headerless with a single signed amount column; header row with separate Debit/Credit columns) are auto-detected/mapped, and the chosen mapping persists per account in `accounts.csv_mapping`. Dates are dd/mm/yyyy (Australian). Credit-card debits negate (money owed increases).
