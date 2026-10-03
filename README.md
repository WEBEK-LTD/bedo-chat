# Bedo Chat

Private messaging platform for the academy. Users get exactly **Login → Chat Interface**; system
administrators get a separate **Admin Dashboard**. The full requirements, architecture, decision log and
phase plan live in the *Bedo Chat — Phase 0 Blueprint*; `docs/DECISIONS.md` mirrors the approved decisions.

**Current state: Phase 1 (Foundation).** The repository contains the verified skeleton every later phase
plugs into. No messaging feature exists yet; the two user screens and the admin screen are layout shells.

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/api` | NestJS 12 HTTP API on Fastify 5: configuration, health checks, error envelope, response contracts, OpenAPI document |
| `apps/worker` | NestJS background worker with BullMQ queues (system queue + heartbeat job in Phase 1) |
| `apps/web` | Next.js 16 user app with exactly two routes: `/login` and `/` (chat interface) |
| `apps/admin` | Next.js 16 admin dashboard, separate app and domain |
| `packages/config` | Zod-validated environment variables for every service; list of server-only variables |
| `packages/contracts` | Zod schemas shared by API, worker and clients; builds the OpenAPI 3.1 document |
| `packages/db` | Kysely database access and the checksummed SQL migration runner |
| `packages/ui` | Design tokens and the Material Symbols icon component |
| `supabase/migrations` | SQL migrations (Supabase file naming), applied by `@bedo/db` |
| `scripts` | Repository checks: allowed web routes, client-bundle secret guard |
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
pnpm --filter @bedo/admin dev         # http://localhost:3001
```

`pnpm stack:down` stops the containers (data is kept in Docker volumes).

## Deployment

Web app and Admin Dashboard deploy to Netlify (`apps/*/netlify.toml`); the API and worker run as containers
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

Server-only variables (`DATABASE_URL`, `REDIS_URL`, `WAABEK_API_KEY`) must never be placed in a web or
admin app (spec §1: the Waabek key is never exposed). Every server variable must be classified as
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
