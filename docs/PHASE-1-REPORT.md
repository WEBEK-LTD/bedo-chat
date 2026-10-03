# Phase 1 report — Foundation

Phase 1 is complete: the empty, verified skeleton of Bedo Chat builds, tests and runs against real
Postgres and Redis. It contains no user-facing feature beyond the two layout shells the spec allows
(`/login`, `/`) and the admin shell. Verified on 2026-10-04.

## Acceptance checklist

| Criterion | Result | How it was checked |
| --- | --- | --- |
| Clean install from the lockfile with install scripts blocked | Pass | `pnpm install --frozen-lockfile` after deleting every `node_modules`; `strictDepBuilds` on, one reviewed exception (`msgpackr-extract`, not run) |
| Lint, typecheck, unit tests and production builds pass | Pass | `pnpm verify`: 12/12 lint, 12/12 typecheck, 50 unit tests, 8 repository-check tests, 8/8 builds |
| Migrations apply to an empty database, re-run as a no-op, refuse an edited migration | Pass | `pnpm db:migrate` twice on a new database; 18 integration tests (edited, missing and out-of-order files, failed migration rolls back, concurrent runners, lock timeout, CLI exit code, pooler port refused) |
| API readiness reports real Postgres and Redis status; worker processes its heartbeat | Pass | 3 API integration tests (both up; Redis down; Postgres down) and 1 worker integration test (schedule registered, heartbeat written, every connection closed on shutdown); compiled API and worker started as real processes and stopped with SIGTERM |
| Client-bundle guard fails if a server-only name or value reaches web or admin output | Pass | Guard tests, plus a deliberately leaky page built through `pnpm build`: the guard reported the key in four prerendered files; the page was then removed |
| Web app exposes only `/login` and `/` | Pass | `pnpm check:routes` checks source files, metadata files, forbidden route folders and the build's route manifest |
| ZIP contains project, docs, `.env.example` files, migrations, tests, build instructions | Pass | Built from the committed files (`git archive`), so no `node_modules`, build output or local `.env` files |

## Test inventory

| Package | Unit | Integration |
| --- | --- | --- |
| `@bedo/config` | 10 | — |
| `@bedo/contracts` | 4 | — |
| `@bedo/db` | 12 | 18 |
| `@bedo/ui` | 4 | — |
| `@bedo/api` | 19 | 3 |
| `@bedo/worker` | 1 | 1 |
| `scripts` (route and bundle guards) | 8 | — |

## Independent review

A separate reviewing agent that had not seen the work being written audited the code twice. The first
review found one critical issue (an unhandled Postgres pool error would have crashed the API), eight
important issues and a set of minor ones; the second confirmed the fixes and found that Turborepo's
strict environment mode hid `WAABEK_API_KEY` from the build, which made the CI leak check ineffective.
All of these are fixed and covered by tests, including:

- the API survives a dropped database connection and reconnects;
- statement and query timeouts protect the connection pool;
- the API and worker connect as a least-privilege `bedo_runtime` member that cannot alter tables, disable
  triggers or change the append-only audit log;
- the worker closes every Redis connection on shutdown;
- proxy trust is an explicit hop count, and client-supplied request ids are ignored unless a proxy is trusted;
- every server variable must be classified as secret or non-secret, so the bundle guard cannot miss a new secret.

Deliberately left open: GitHub Actions are pinned to major versions rather than commit SHAs (SHAs could not
be verified from this environment), and nothing reads the worker heartbeat key yet (monitoring is Phase 13).

## Security scans

- `pnpm audit`: no known vulnerabilities, after two fixes recorded in `docs/DECISIONS.md` (Next.js pinned to
  16.3.6 for a critical advisory, under a temporary exception to the 14-day rule until 2026-10-06; Fastify
  forced to ≥ 5.12.5).
- gitleaks 8.24.0 over the repository history: no leaks.
- osv-scanner 2.0.0 could not reach its vulnerability database from the build environment; CI runs it on
  every push.

## Environment differences to know

- Local verification used Postgres 16; Docker Compose and CI use Postgres 17 (Supabase's current major).
  The baseline migration uses nothing version-specific.
- The GitHub Actions workflow was written and its commands were run locally, but the workflow itself has
  not run on GitHub, since delivery is by ZIP (D-11).

## Phase 1.1 — deployment readiness (D-15, D-16)

Added after D-15 and D-16 were approved, so Phase 1 can be deployed as well as tested:

| Item | What it is | How it was checked |
| --- | --- | --- |
| Netlify configuration | `apps/web/netlify.toml`, `apps/admin/netlify.toml`; `output: 'standalone'` removed, since Netlify's adapter handles packaging | Each build command run from its package folder after deleting the build output |
| API and worker containers | `apps/api/Dockerfile`, `apps/worker/Dockerfile`, `.dockerignore`; non-root, production dependencies only, health check on the API | Docker Hub is blocked from the build environment, so the images themselves were not built. Every step they run was executed natively in a clean copy: install, build, `pnpm deploy` of the production folder, migrations from it, the API serving `/health/ready` while connected as the least-privilege `bedo_api` role, the worker writing its heartbeat and stopping cleanly on SIGTERM |
| Transaction-pooler guard | The API refuses a `DATABASE_URL` on port 6543, like the migration runner | Unit test |
| Statement timeout | Now applied through `pg-pool`'s awaited `onConnect` hook instead of a startup parameter that some poolers reject | Integration test |
| Deployment guide | `docs/DEPLOYMENT.md` | — |

## Next

Phase 2 (Accounts) needs answers to O-14 (2-Step password recovery), O-15 (login alert channel) and O-16
(what happens to a deleted account's messages).
