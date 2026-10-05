# Bedo Chat

Private messaging platform for the academy. Users get exactly **Login → Chat Interface**; system
administrators get a separate **Admin Dashboard**. The full requirements, architecture, decision log and
phase plan live in the *Bedo Chat — Phase 0 Blueprint*; `docs/DECISIONS.md` mirrors the approved decisions.

**Current state: Phase 2 (Accounts and audit foundation).** Students sign in with a WhatsApp code
(academy phone list only), manage their profile, privacy, devices, 2-Step Verification, notifications and
account deletion requests inside the chat interface. Admins sign in with a phone code and an authenticator
app and manage the academy phone list, deletion requests and 2-Step resets. Every identity, account,
security and admin action is kept in an append-only history. Messaging starts in Phase 3.
What Phase 2 contains and how it was verified: [`docs/PHASE-2-REPORT.md`](docs/PHASE-2-REPORT.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/api` | NestJS 12 HTTP API on Fastify 5: configuration, health checks, error envelope, response contracts, OpenAPI document |
| `apps/worker` | NestJS background worker with BullMQ queues: heartbeat, verification codes (Waabek WhatsApp), Web Push |
| `apps/web` | Next.js 16 user app with exactly two routes: `/login` and `/` (chat interface) |
| `apps/admin` | Next.js 16 admin dashboard, separate app and domain |
| `packages/config` | Zod-validated environment variables for every service; list of server-only variables |
| `packages/contracts` | Zod schemas shared by API, worker and clients; builds the OpenAPI 3.1 document |
| `packages/db` | Kysely database access and the checksummed SQL migration runner |
| `packages/ui` | Design tokens and the Material Symbols icon component |
| `packages/e2e` | Browser tests of the web and admin apps against the real API, Postgres and Redis (`pnpm e2e`) |
| `supabase/migrations` | SQL migrations (Supabase file naming), applied by `@bedo/db` |
| `scripts` | Repository checks: allowed web routes, client-bundle secret guard, edge router tests |
| `deploy/cloudflare` | The Cloudflare Worker that serves everything from `https://bedochat.com` (D-25) |
| `docs` | Decision log, phase reports and the deployment guide |

## Prerequisites

- **Node.js 24** (`.nvmrc`). With nvm: `nvm use`.
- **pnpm 10.28** (`corepack enable` picks the version pinned in `package.json`).
- **Docker** for the local Postgres and Redis (or your own Postgres 16+ and Redis 7+).

## Quick start

```bash
pnpm install --frozen-lockfile        # install scripts are blocked by policy (see below)
pnpm stack:up                         # Postgres on 127.0.0.1:5432, Redis on 127.0.0.1:6379

cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
cp packages/db/.env.example packages/db/.env
cp apps/web/.env.example apps/web/.env.local
cp apps/admin/.env.example apps/admin/.env.local

pnpm build                            # builds packages, API (+ OpenAPI file), worker, web, admin
pnpm db:migrate                       # applies supabase/migrations to DATABASE_URL

pnpm --filter @bedo/api start         # http://localhost:4000/health/ready
pnpm --filter @bedo/worker start
pnpm --filter @bedo/web dev           # http://localhost:3000
pnpm --filter @bedo/admin dev         # http://localhost:3001/admin
```

Before the first sign-in, fill in the Phase 2 variables (see "Accounts (Phase 2)" below), create the first
Super Admin, sign in to the admin app and add the students' numbers to the academy phone list.

`pnpm stack:down` stops the containers (data is kept in Docker volumes).

## Deployment

Web app and Admin Dashboard deploy together as one Netlify site (D-26, `apps/web/netlify.toml`: the admin
app's static export is included under `/admin`); the API and worker run as containers
on persistent hosting (`apps/api/Dockerfile`, `apps/worker/Dockerfile`); data lives in Supabase and queues
in managed Redis. Step-by-step instructions: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm lint` | ESLint across every package |
| `pnpm typecheck` | TypeScript in strict mode across every package |
| `pnpm test` | Unit tests (Vitest) + repository check tests (`node --test`) |
| `pnpm build` | Production builds; also writes `apps/api/openapi/openapi.json` |
| `pnpm test:integration` | Tests against real Postgres and Redis (needs `TEST_DATABASE_URL`, `REDIS_URL`) |
| `pnpm db:migrate` / `pnpm db:status` | Apply / list migrations for `DATABASE_URL` |
| `pnpm check:routes` | Fails if the web app has any route other than `/` and `/login` (spec §23): checks page, route and metadata files, forbids `pages/` and `src/` route folders, and checks the last build's route manifest |
| `pnpm check:bundles` | After `pnpm build`: fails if server-only variable names or values appear in any file served to browsers (see below) |
| `pnpm verify` | lint + typecheck + test + build + both checks |
| `pnpm e2e` | Builds API, web and admin for a local API on port 4100 and runs the browser tests (needs `TEST_DATABASE_URL`, `REDIS_URL` and Chromium; set `E2E_CHROMIUM` to its path if it is not `/opt/pw-browsers/chromium`) |
| `pnpm --filter @bedo/api admin:create` | Phase 2 tool that creates an admin with an authenticator secret. Optional and not needed: admins are created by SQL (see below) |
| `pnpm --filter @bedo/worker test:live` | Sends one real WhatsApp code through Waabek with a key from your shell (opt-in developer check, see below) |

Integration tests need a Postgres role that may create databases and roles (the Docker Compose
`postgres` user can) and a Redis instance. The database tests create and drop their own temporary
databases; the API tests use `TEST_DATABASE_URL` directly; the worker tests use a random queue prefix and
delete only their own keys.

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
REDIS_URL=redis://localhost:6379 \
pnpm test:integration
```

## Environment variables

Every service validates its environment at start-up and refuses to start with a list of the invalid
variable names (values are never printed). Templates: `apps/api/.env.example`,
`apps/worker/.env.example`, `packages/db/.env.example`, `apps/web/.env.example`, `apps/admin/.env.example`.

Server-only variables (`DATABASE_URL`, `REDIS_URL`, `WAABEK_API_KEY`, `ACCESS_TOKEN_SECRET`,
`OTP_HMAC_SECRET`, `ADMIN_TOTP_KEY`, `SETTINGS_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PRIVATE_KEY`,
`EDGE_SECRET`) must never be placed
in a web or admin app (spec §1: the Waabek key is never exposed). Every server variable must be classified as
secret or non-secret in `packages/config` — a test fails otherwise.

`pnpm check:bundles` scans every file the web and admin apps serve to browsers (`.next/static`,
prerendered pages in `.next/server/app`, and `public/`) for those variable names, the Waabek host, and the
actual secret values found in the environment and in `apps/api/.env`, `apps/worker/.env` and
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
- **Supabase: use the direct connection or the session-mode pooler (port 5432).** The transaction-mode
  pooler (port 6543) cannot hold the migration lock; the runner refuses it.
- Application tables live in the `app` schema. Browsers never connect to the database (D-08); the baseline
  revokes access for Supabase's `anon` and `authenticated` roles.

## Database roles

| Who | Connects as | Can |
| --- | --- | --- |
| Migrations (`pnpm db:migrate`) | The table owner, e.g. `postgres` | Everything: create and alter tables, grants |
| API and worker (`DATABASE_URL` in their `.env`) | A login role that is a member of `bedo_runtime` | Only what each migration grants `bedo_runtime` (for the audit log: `SELECT`, `INSERT`) |

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
`SETTINGS_ENCRYPTION_KEY`; the worker needs the same `SETTINGS_ENCRYPTION_KEY` (D-32). Generate each with
`openssl rand -base64 32` and keep them only in the host's secret
settings or in local `.env` files (ignored by git). Profile pictures need `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`; notifications need a VAPID key pair (`npx web-push generate-vapid-keys`): the
public key goes to both API and worker, the private key and `VAPID_SUBJECT` to the worker only.

**Verification codes** always go through Waabek in development, testing and production (D-22). The Waabek
API key is an Admin Dashboard setting (D-32): a Super Admin saves it under *OTP / WhatsApp*, it is stored
encrypted with `SETTINGS_ENCRYPTION_KEY` (AES-256-GCM), and the worker reads it from the database before every
message, so a change applies to the next message on every worker without a restart. It is never an
environment variable: the worker refuses to start if `WAABEK_API_KEY` is set. The test code sender
(`OTP_DELIVERY=test-capture`) exists only for automated tests: configuration rejects it unless `NODE_ENV=test`.
The dashboard's **Send test message** checks the saved key. A developer can also check a key directly from a
shell (the key is not stored anywhere by this):

```bash
WAABEK_LIVE_TEST_KEY=... WAABEK_LIVE_TEST_PHONE=+2010XXXXXXXX pnpm --filter @bedo/worker test:live
```

**First admin (Phase 3.1).** Admin accounts are created by SQL, without an authenticator secret; each admin
sets up the authenticator app at the first sign-in, after the WhatsApp code. For the very first Super Admin the
owner also opens a one-time initial setup by SQL (`select * from app.open_admin_bootstrap();`), whose setup
token lets `/admin/login` save the first Waabek key; it closes for good when that Super Admin confirms the
authenticator. Exact steps: `docs/DEPLOYMENT.md`, section 4a. If the Waabek key stops working while no admin
can sign in, the owner runs `select * from app.open_otp_settings_recovery();` for a one-time recovery token that
lets `/admin/login` save a new key only (D-33, section 4b). Roles: `super_admin` (changes) and `moderator`
(read-only).

**One public domain (D-25).** In production everything is served from `https://bedochat.com`: the student
chat at `/` and `/login`, the Admin Dashboard at `/admin` and `/admin/login`, the API at `/api`. Cloudflare
and a small Worker (`deploy/cloudflare/`) route the paths to the one Netlify site (D-26: student app, with the
Admin Dashboard under `/admin`) and the API host, which
also carries Phase 3's WebSocket connections. Both apps and the API share one origin, so the API's session
cookies are first-party (P-14) and scoped under `/api`. Set the API's `CORS_ALLOWED_ORIGINS`, `ADMIN_ORIGINS`
and `WEB_ORIGINS` to `https://bedochat.com`, `API_PUBLIC_PATH=/api`, and an `EDGE_SECRET` shared with the
Worker (the API then answers only requests that came through it). On one origin the API cannot tell the
two apps apart, so admins should use a separate browser profile for the dashboard. Setup:
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), sections 5 and 5a.

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
