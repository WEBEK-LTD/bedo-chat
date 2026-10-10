# Bedo Chat

Private messaging platform for the academy. Users get exactly **Login → Chat Interface**; system
administrators get a separate **Admin Dashboard**. The full requirements, architecture, decision log and
phase plan live in the *Bedo Chat — Phase 0 Blueprint*; `docs/DECISIONS.md` mirrors the approved decisions.

**Current state: Phase 3.3 (one Netlify site, D-36).** Students sign in with a WhatsApp code (academy phone
list only), chat privately with realtime delivery, and manage their profile, privacy, devices, 2-Step
Verification, notifications and account deletion requests inside the chat interface. Admins sign in with their
phone number, a password and an authenticator app (D-34) and manage the academy phone list, deletion requests,
2-Step resets and the WhatsApp settings. Every identity, account, security and admin action is kept in an
append-only history. The whole system is one Netlify site plus Supabase: the API runs inside the website's
server functions at `/api`. Phase reports: `docs/PHASE-*-REPORT.md`; the latest is
[`docs/PHASE-3.3-REPORT.md`](docs/PHASE-3.3-REPORT.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/api` | NestJS 12 API on Fastify 5, run inside the website (D-36: `src/serverless.ts`, no port): accounts, admin, messaging, realtime signals, WhatsApp (Waabek) and Web Push delivery, hourly housekeeping, OpenAPI document |
| `apps/web` | Next.js 16 website: the user app with exactly two pages, `/login` and `/` (chat interface), and the route `/api/[[...path]]` that serves the API |
| `apps/admin` | Next.js 16 Admin Dashboard, a separate app; its static export is served by the same site under `/admin` |
| `packages/config` | Zod-validated environment variables; list of server-only variables |
| `packages/contracts` | Zod schemas shared by the API and the apps; builds the OpenAPI 3.1 document |
| `packages/db` | Kysely database access and the checksummed SQL migration runner |
| `packages/ui` | Design tokens and the Material Symbols icon component |
| `packages/e2e` | Browser tests of the built site (web app, Admin Dashboard and API) against real Postgres (`pnpm e2e`) |
| `supabase/migrations` | SQL migrations (Supabase file naming), applied by `@bedo/db` |
| `scripts` | Repository checks: allowed web routes, client-bundle secret guard, one-site and CSP tests |
| `docs` | Decision log, phase reports and the deployment guide |

## Prerequisites

- **Node.js 24** (`.nvmrc`). With nvm: `nvm use`.
- **pnpm 10.28** (`corepack enable` picks the version pinned in `package.json`).
- **Docker** for the local Postgres (or your own Postgres 16+). Nothing else: no Redis (D-36).

## Quick start

```bash
pnpm install --frozen-lockfile        # install scripts are blocked by policy (see below)
pnpm stack:up                         # Postgres on 127.0.0.1:5432

cp packages/db/.env.example packages/db/.env
cp apps/web/.env.example apps/web/.env.local   # the site's variables, including the API's (server-only)

pnpm build                            # builds packages, API (+ OpenAPI file), admin export and web app
pnpm db:migrate                       # applies supabase/migrations to DATABASE_URL

pnpm --filter @bedo/admin dev         # the Admin Dashboard's dev server (port 3001)
pnpm --filter @bedo/web dev           # the site: http://localhost:3000 (/, /login, /admin via the admin
                                      # dev server, and the API at http://localhost:3000/api/health/ready)
```

In development the web app's dev server shows the Admin Dashboard's dev server under `/admin`, so the two apps
and the API share one origin, as in production.

Before the first sign-in, fill in the Phase 2 variables (see "Accounts (Phase 2)" below), create the first
Super Admin, sign in to the admin app and add the students' numbers to the academy phone list.

`pnpm stack:down` stops the containers (data is kept in Docker volumes).

## Deployment

One Netlify site is the whole of Bedo Chat (D-36): the web app, the Admin Dashboard under `/admin` (D-26) and
the API under `/api`, built and deployed together (`apps/web/netlify.toml`). Supabase provides Postgres,
Storage and Realtime. There is no API host, worker, Redis or Cloudflare Worker. Step-by-step instructions:
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm lint` | ESLint across every package |
| `pnpm typecheck` | TypeScript in strict mode across every package |
| `pnpm test` | Unit tests (Vitest) + repository check tests (`node --test`) |
| `pnpm build` | Production builds; also writes `apps/api/openapi/openapi.json` |
| `pnpm test:integration` | Tests against real Postgres (needs `TEST_DATABASE_URL`) |
| `pnpm db:migrate` / `pnpm db:status` | Apply / list migrations for `DATABASE_URL` |
| `pnpm check:routes` | Fails if the web app has any page other than `/` and `/login` (spec §23), or any route other than those and the API route handler `/api/[[...path]]` (D-36): checks page, route and metadata files, forbids `pages/` and `src/` route folders, and checks the last build's route manifest |
| `pnpm check:bundles` | After `pnpm build`: fails if server-only variable names or values appear in any file served to browsers (see below) |
| `pnpm verify` | lint + typecheck + test + build + both checks |
| `pnpm e2e` | Builds the site and runs the browser tests against it (`next start` behind a local stand-in for Netlify, with local stand-ins for Waabek and Supabase Realtime; needs `TEST_DATABASE_URL`, `openssl` and Chromium; set `E2E_CHROMIUM` to its path if it is not `/opt/pw-browsers/chromium`) |
| `pnpm --filter @bedo/api admin:create` | Phase 2 tool that creates an admin with an authenticator secret. Optional and not needed: admins are created by SQL (see below). Such an admin still needs a password set with an owner setup token (D-34) |
| `pnpm --filter @bedo/api test:live` | Sends one real WhatsApp code through Waabek with a key from your shell (opt-in developer check, see below) |

Integration tests need a Postgres role that may create databases and roles (the Docker Compose
`postgres` user can). They create and drop their own temporary databases.

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres pnpm test:integration
```

## Environment variables

The API validates its environment on its first request and answers 503 (naming the invalid variables in the
log only; values are never printed) until it is right. Templates: `apps/web/.env.example` (the site, including
the API's server variables), `packages/db/.env.example` (migrations). Production values: Netlify site
variables, see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) section 2.

Server-only variables (`DATABASE_URL`, `WAABEK_API_KEY`, `ACCESS_TOKEN_SECRET`, `OTP_HMAC_SECRET`,
`ADMIN_TOTP_KEY`, `SETTINGS_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PRIVATE_KEY`) are read only by
the API on the server and must never reach a page (spec §1: the Waabek key is never exposed). Every server
variable must be classified as secret or non-secret in `packages/config` — a test fails otherwise.

`pnpm check:bundles` scans every file the web and admin apps serve to browsers (`.next/static`,
prerendered pages in `.next/server/app`, and `public/`) for those variable names, the Waabek host, and the
actual secret values found in the environment and in `apps/web/.env*`, `apps/api/.env` and
`packages/db/.env`. It cannot see pages rendered per request or values that were encoded or split, so the
rule still holds in code review: browser code never reads server variables.

No hosting provider, region or domain is hard-coded (D-10): production values are supplied through these
variables and confirmed with the owner before deployment.

## Database migrations

- Files live in `supabase/migrations` and are named `<YYYYMMDDHHMMSS>_<snake_case_name>.sql`.
- `pnpm db:migrate` applies pending files in order, each in its own transaction, under an advisory lock so
  only one runner works at a time. Each applied file is recorded with its SHA-256 checksum in
  `app_meta.schema_migrations`.
- **Never edit an applied migration.** The runner refuses to continue if an applied file changed, is
  missing, or if an unapplied file is older than the newest applied one. Add a new migration instead.
- A migration whose first line is `-- bedo:no-transaction` runs outside a transaction; it must contain
  exactly one statement (for example `CREATE INDEX CONCURRENTLY`).
- Explicit `BEGIN`/`COMMIT`/`ROLLBACK` in a transactional migration is rejected; the runner owns the
  transaction. A no-transaction migration is not atomic with its bookkeeping, so make it idempotent
  (`IF NOT EXISTS`).
- If another run holds the lock for more than 60 seconds, the runner stops with an error instead of waiting
  forever.
- The runner works on any Postgres, including Supabase. Do not mix it with `supabase db push`.
- **Supabase: run migrations over the direct connection or the session-mode pooler (port 5432).** The
  transaction-mode pooler (port 6543) cannot hold the migration lock; the runner refuses it. (The API itself
  should use the transaction pooler, D-36.)
- Application tables live in the `app` schema. Browsers never connect to the database (D-08); the baseline
  revokes access for Supabase's `anon` and `authenticated` roles.

## Database roles

| Who | Connects as | Can |
| --- | --- | --- |
| Migrations (`pnpm db:migrate`) | The table owner, e.g. `postgres` | Everything: create and alter tables, grants |
| API (`DATABASE_URL` of the site) | A login role that is a member of `bedo_runtime` | Only what each migration grants `bedo_runtime` (for the audit log: `SELECT`, `INSERT`) |

The baseline migration creates the `bedo_runtime` group role. Create the login role once per environment,
with the password taken from your secret store:

```sql
create role bedo_api login password '<from secret store>' in role bedo_runtime;
```

Because the application never connects as the owner, it cannot disable triggers or alter tables — so the
append-only audit log cannot be bypassed from application code. There are no default privileges: every
migration that adds a table also grants `bedo_runtime` exactly what that table needs. Locally, the
Docker Compose superuser may be used for convenience.

## Accounts (Phase 2)

**Secrets.** The API needs `ACCESS_TOKEN_SECRET`, `OTP_HMAC_SECRET`, `ADMIN_TOTP_KEY` and
`SETTINGS_ENCRYPTION_KEY` (D-32). Generate each with `openssl rand -base64 32` and keep them only in the
Netlify site's variables or in local `.env` files (ignored by git). Profile pictures and realtime need
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY`; notifications need a VAPID key pair
(`npx web-push generate-vapid-keys`) with `VAPID_SUBJECT`.

**Verification codes** always go through Waabek in development, testing and production (D-22). The Waabek
API key is an Admin Dashboard setting (D-32): a Super Admin saves it under *OTP / WhatsApp*, it is stored
encrypted with `SETTINGS_ENCRYPTION_KEY` (AES-256-GCM), and the API checks it in the database before every
message, so a change applies to the next message everywhere without a redeploy. It is never an environment
variable: the API refuses to start if `WAABEK_API_KEY` is set. Automated tests replace Waabek with a local
stand-in; nothing in the application can switch it off. The dashboard's **Send test message** checks the saved
key. A developer can also check a key directly from a
shell (the key is not stored anywhere by this):

```bash
WAABEK_LIVE_TEST_KEY=... WAABEK_LIVE_TEST_PHONE=+2010XXXXXXXX pnpm --filter @bedo/api test:live
```

**Admin sign-in (D-34, Phase 3.2).** Phone number + password, then the authenticator (TOTP) code; no admin
session exists without it, and no WhatsApp code is used for admin sign-in. Passwords are 12–128 characters,
not the admin's phone number and not on the built-in common-password list; they are stored only as Argon2id
hashes. The owner gives each admin a one-time password setup token by SQL
(`select * from app.issue_admin_password_setup('<admin-phone>');`), entered on `/admin/login` → *Set password with
a setup token*; it never signs anyone in. The same SQL is the only password reset (it ends all of that admin's
sessions). Signed-in admins change their password under *Account*. The owner can also set an admin's password
directly with one SQL script, `docs/owner-sql/set-super-admin.sql` (D-35, Phase 3.2.1). Details: `docs/DEPLOYMENT.md`,
sections 4c and 4d.

**First admin (Phase 3.1).** Admin accounts are created by SQL, without an authenticator secret; each admin
sets up the authenticator app at the first sign-in, after the password. For the very first Super Admin the
owner also opens a one-time initial setup by SQL (`select * from app.open_admin_bootstrap();`), whose setup
token lets `/admin/login` save the first Waabek key; it closes for good when that Super Admin confirms the
authenticator. Exact steps: `docs/DEPLOYMENT.md`, section 4a. If the Waabek key stops working, the owner can
also run `select * from app.open_otp_settings_recovery();` for a one-time recovery token that lets
`/admin/login` save a new key only (D-33, section 4b). Roles: `super_admin` (changes) and `moderator`
(read-only).

**One site, one domain (D-25, D-26, D-36).** In production everything is served by one Netlify site at
`https://bedochat.com`: the student chat at `/` and `/login`, the Admin Dashboard at `/admin` and
`/admin/login`, the API at `/api` (the web app's own route, in the same server functions). Both apps and the
API share one origin, so the session cookies are first-party (P-14) and scoped under `/api`, and the API
accepts cookie-authenticated requests only from pages of that same origin, with nothing to configure. Realtime
goes through Supabase Realtime: each signed-in device listens on its own private channel for content-free
signals and fetches the data over HTTP. On one origin the API cannot tell the two apps apart, so admins should
use a separate browser profile for the dashboard. Setup: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

**Phone numbers leaving the list (D-24).** When an admin approves an account deletion, or a user changes
their phone number, the old number is removed from the academy phone list so it can no longer sign in or
create an account. The number stays in identity history, and the removed list entry is recorded in the admin
audit log.

**History.** Identity changes (`audit.identity_history`), account events (`audit.account_events`), security
events (`audit.security_events`) and admin actions, including what admins viewed (`app.audit_log`), can be
inserted and read by the application but never changed or deleted: the runtime role has no such privilege,
and triggers reject it even for the table owner.

## Dependency policy

Set in `pnpm-workspace.yaml`:

- **14-day minimum release age**: a package version must be at least 14 days old to be installed.
  Security exceptions are listed with their reason and removal date.
- **Install scripts blocked** (`strictDepBuilds`): any dependency with an install script fails the
  install until it is reviewed and listed in `allowBuilds`.
- **Overrides** force patched versions of vulnerable transitive dependencies.

## Product rules that apply to every change

- Nothing outside the approved specification is added; nothing in it is reduced without approval.
- No AI features, AI branding, AI artwork or AI-generated icons or illustrations.
- Icons come only from Google Material Symbols: add the name to `packages/ui/scripts/icons.json`, then run
  `pnpm --filter @bedo/ui icons`. The test suite fails if the generated file drifts from the official source.
- The user app stays **Login → Chat Interface**; the Admin Dashboard stays separate.
- Every API route declares a response contract (`@ResponseSchema`). Fields not in the contract are removed
  before the response is sent, and a route without a contract returns an error instead of data.
- Permissions are enforced in the backend for every request and realtime event; apps only display what the
  server already allowed.
