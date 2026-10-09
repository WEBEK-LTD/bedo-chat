# Phase 3.3 report — one self-contained Netlify site (D-36)

Bedo Chat now runs from the single Netlify site at `https://bedochat.com`:

| Path | Served by |
| --- | --- |
| `/` | Student chat (web app) |
| `/login` | Student sign-in (web app) |
| `/admin` | Admin Dashboard (static export in the same deploy, D-26) |
| `/admin/login` | Admin sign-in (same) |
| `/api/*` | The API, run by the web app's own route `apps/web/app/api/[[...path]]/route.ts` in the site's server function |

Supabase stays the database, storage and realtime infrastructure. Nothing else is deployed: no API host, no
worker, no Redis, no Cloudflare Worker. Built on Phase 3.2.1 (branch `phase-3.3` from `dae69b4`). Phase 1 was
changed only where the architecture required it (the readiness check no longer reports Redis).

## Decision recorded

**D-36** (ordered 2026-10-06), in `docs/DECISIONS.md` and the Blueprint. It amends D-02 (no separate worker, no
Redis/BullMQ), D-07 (Supabase Realtime now carries realtime *signals*; every signal still passes the permission
service and no content is broadcast), D-10 and D-15 (no persistent backend host, no managed Redis) and D-25 (no
Cloudflare Worker; the domain points at Netlify directly).

## What was removed, and what replaced it

| Before | After (D-36) |
| --- | --- |
| Separate NestJS API host (`apps/api/Dockerfile`, `main.ts` listening on a port) | `apps/api/src/serverless.ts`: the same NestJS/Fastify application, created once per server instance, answering each `/api` request in-process (`fastify.inject`, `/api` prefix removed). The web app's route hands every method to it; Next.js bundles it into the site's server function (native password hashing and `pg` stay Node.js packages) |
| Cloudflare Worker (`deploy/cloudflare/`), `API_ORIGIN`, `WEB_ORIGIN`, `ADMIN_ORIGIN`, `EDGE_SECRET`, edge guard | Gone. Same origin, so no routing layer and no edge secret. CSRF: cookie-authenticated requests must come from a page whose Origin host equals the request's own Host (over HTTPS, an `https` page), plus the custom header — nothing to configure. CORS removed (no other origin is ever allowed) |
| `CORS_ALLOWED_ORIGINS`, `ADMIN_ORIGINS`, `WEB_ORIGINS`, `API_PUBLIC_PATH`, `API_TRUST_PROXY_HOPS`, `API_HOST`, `API_PORT`, `NEXT_PUBLIC_API_URL` | Gone. The API is always at `/api` (`API_BASE_PATH` in contracts); both apps call it relative. The client address is Netlify's `x-nf-client-connection-ip` (any client value is replaced by Netlify); request ids are always minted |
| Redis: pending sign-ins, authenticator setup secrets, photo-upload tickets, 2-Step attempts | `app.ephemeral` (Postgres): values with an expiry, set / set-if-absent / take-once; expired rows read as absent. Upload tickets are now stored as hashes like every other token |
| Redis Lua rate limits (sign-in, setup tokens, admin passwords, messaging limits, one-time-code gate) | `app.rate_counters` (reserve-first and fixed-window counters, one atomic statement each) and `app.rate_events` (the one-time-code sliding windows: cooldown, per number, per address — checked and recorded in one transaction under advisory locks). Same limits and semantics as before |
| Redis presence sorted sets | `app.presence_devices` (one row per signed-in device, 60 s per heartbeat) and the existing `app.user_presence` |
| BullMQ OTP queue + worker → Waabek | `OtpDeliveryService` in the API: the code is sent right after the response (Next.js `after()`, Netlify `waitUntil`), so an eligible and an ineligible number get the same answer in the same time. One more try on a temporary failure (network, timeout, 429, 5xx) within 9 s; a final failure is recorded (`otp_delivery_failed`, no code). The Dashboard-managed key (D-32) is read and checked before every message, as before |
| BullMQ "waabek-test" job awaited by the API | The Admin Dashboard's test message is sent directly while the admin waits |
| BullMQ push queue + worker | `PushService`: Web Push right after the response; expired subscriptions removed as before |
| Worker maintenance (partitions, pruning) | `MaintenanceService`: at most once an hour across all instances (atomic claim in `app.maintenance_runs`), started by ordinary requests, run after the response; also prunes expired short-lived state |
| WebSocket gateway + Redis pub/sub fan-out | Supabase Realtime broadcast (HTTP `POST /realtime/v1/api/broadcast` with the service key). Each session listens on its own channel, named by an HMAC of the session id and the current hour under a key derived from `ACCESS_TOKEN_SECRET` (unguessable; changes hourly). Signals: `updates` (fetch `/v1/sync` over HTTP), `typing`, `presence` — no message content, only to sessions still valid when sent, typing and presence only where the permission service allows (blocks, last-seen privacy). Heartbeat (every 25 s, also returns the update position), typing and going offline are HTTP endpoints. The browser uses `@supabase/realtime-js` (protocol 1.0.0) |
| `REDIS_URL`, `QUEUE_PREFIX`, `OTP_DELIVERY`, `WORKER_*` | Gone. New: `SUPABASE_ANON_KEY` (public; for listening), `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `WAABEK_API_URL` (moved from the worker) |
| `apps/worker`, `deploy/cloudflare`, `scripts/cloudflare-worker.test.mjs`, both Dockerfiles, Redis in `docker-compose.yml` and CI | Deleted |

Also: the common-password list (D-34) is compiled into the API (`src/admin/common-passwords.list.ts`) because
the server function reads no files at run time; `@bedo/db/runtime` exposes only the database access (no
migration files) to the API; the transaction pooler (port 6543) is now accepted for the API (the server-side
statement timeout is then set on the login role, `docs/DEPLOYMENT.md` 1.3); the migration runner still
refuses it.

## Database change

Migration `20261006180000_phase3_3_single_site.sql` (SHA-256
`97aa585eaa4badc396d1f176a44f197f2fec978160afacfc210d1f1dd3f856c8`) adds five tables in `app` (`ephemeral`,
`rate_counters`, `rate_events`, `presence_devices`, `maintenance_runs`) with grants for `bedo_runtime` only
(`maintenance_runs` without delete). No existing table changes. For your project (migrations applied by hand):
superseded by `docs/owner-sql/apply-phase-3.3.sql` (Phase 3.3.1, below), which applies migrations 7, 8 and 9 in
one run.

## Verification

| Check | Result |
| --- | --- |
| lint, typecheck (17 tasks) | pass |
| unit tests | pass: API 45, config 12, db 12, server-crypto 6, contracts 5, ui 4; scripts 26 |
| integration tests (real Postgres, runtime role) | pass: db 36, API 174 |
| browser end-to-end (the built site behind a local stand-in for Netlify; local HTTPS stand-ins for Waabek and Supabase Realtime speaking their real protocols) | pass: 6 files, 33 tests |
| The **Netlify build output** (`netlify build --offline`), its server function run like AWS Lambda (laid out at `/var/task`, Netlify request context with `waitUntil`, Netlify Blobs) | pass: `/login` and `/` pages; `/api/health/ready`; sign-in code sent to Waabek after the response with the stored key; student sign-in with an `/api`-scoped Secure cookie; realtime channel and heartbeat; a new message signalled over Supabase broadcast without content and fetched over HTTP; Netlify's client address used for limits; admin: owner SQL password → phone + password → authenticator setup → session cookie → dashboard session; owner-SQL hash upgraded to Argon2id inside the function; another site refused |
| fresh-unpack harness on the ZIP (gitleaks, frozen install, all of the above, route and bundle checks, client = OpenAPI, migrations from an empty database twice + status, `pnpm audit`, D-26/D-28/D-31/D-36 Netlify build checks from both package directories, no runtime reference to `API_ORIGIN`/`EDGE_SECRET`/`REDIS_URL`/the Worker in source or deploy) | see the delivery message |

New or rewritten tests: `single-domain.integration.test.ts` (the website handler with public URLs: no edge,
cookies under `/api`, same-origin CSRF incl. scheme, Netlify client address, code after the response),
`realtime.integration.test.ts` (private hourly channels, content-free signals, revoked sessions, heartbeats,
presence with privacy and blocks, expiry sweep, typing limits), `delivery.integration.test.ts` (key changes
across instances, failures recorded, one code from 12 parallel requests across instances, 20 per address,
push, hourly housekeeping claimed once, short-lived state and counters under parallel load),
`ready.integration.test.ts`, `waabek.test.ts`, `deferred-tasks.test.ts`, `realtime-broadcaster.test.ts`,
`waabek-key.provider.test.ts`; browser: `single-domain.e2e.test.ts` (no API port anywhere, the browser listens
on its Supabase channel and opens no socket to the site), live delivery and typing within 5 seconds through
realtime in `messaging.e2e.test.ts`.

## Independent security review

A separate reviewer agent reviewed the change read-only with its own probes. No Critical or High findings.

| Finding | Status |
| --- | --- |
| M1: every Netlify preview/branch deploy would run the API with production variables | **Documented** (`DEPLOYMENT.md` 2): set every server variable for the **Production** context only (previews then answer 503 for `/api`) and turn on deploy protection for non-production deploys if the plan allows. Residual: older production deploys stay reachable at their permalink addresses, as with any Netlify deploy |
| M2: realtime uses public Supabase channels: a leaked channel name could be listened to, and the anon key lets anyone use the project's Realtime (quota) | **Reduced**: channel names now change every hour; signals carry no content. **Open decision** below |
| L1: the CSP's `wss://<project>.supabase.co` adds a way out for injected script | Open with M2 (https to the same project was already allowed for pictures) |
| L2: no server-side statement timeout through the transaction pooler | **Fixed** in the setup: `alter role bedo_api set statement_timeout = '15s'` and `idle_in_transaction_session_timeout = '30s'` (`DEPLOYMENT.md` 1.3) |
| L3: swapped Supabase keys were not caught | **Fixed**: refused at start-up from the keys' own role claim or prefix |
| L4: typing endpoint could write many rows / broadcasts | **Fixed**: membership checked before the per-chat throttle; at most 60 per device per minute |
| Low: missing client-address header would make everyone share one budget | Netlify always sets it; a missing header is now logged once in production |
| Info: `http://` page accepted on an https host | **Fixed** (scheme must match over HTTPS) |
| Info: misleading comment in the admin guard | **Fixed** |

## Phase 3.3.1 (2026-10-09): the open points closed

The owner chose this architecture again on 2026-10-09 (D-36 revised; D-37, the Render deployment, superseded) and
asked for its drawbacks to be closed before delivery.

| Point | Now |
| --- | --- |
| M2 private realtime channels | **Closed.** Supabase Realtime Authorization: each device joins its channel with a short-lived token (HS256, signed with the project's JWT secret, role `authenticated`, claim `bedo_topic` = that channel, valid until 5 minutes after the hourly change). Policy `bedo_device_receives_own_channel` on `realtime.messages` (migration `20261009120000`): receive broadcasts on the channel the token names, nothing else; no insert policy, so no device can send or fake a signal. Broadcasts are `private: true`. "Allow public access" is turned off. Checked against the Supabase Realtime server source (how it checks joins and private batch broadcasts) |
| L1 the CSP's `wss://` to the project | With M2: the socket only reaches the device's own channel |
| Database TLS | **Closed.** Every connection to a Supabase host is encrypted and verified against Supabase Root 2021 CA (built into `packages/db`, fingerprint pinned in a test), host name included; the host is read as node-postgres reads it; a Supabase URL that turns verification off is refused |
| Functions far from the database | Netlify functions region **Sydney** (Netlify Pro), next to the Supabase project |
| WhatsApp code time limit | Netlify's function limit is 60 seconds (Netlify documentation); a code is given at most 9 seconds after the response; failures are recorded |
| Client address behind Cloudflare | `bedochat.com` records set to DNS only, so Netlify sees each visitor |
| Owner setup | One SQL file from the live state (`apply-phase-3.3.sql`: migrations 7-9, the `bedo_api` limits, refusing any other policy or grant that would widen a device token), one `.env` import (`netlify-production.env`, placeholders refused at start-up), the Supabase origin preset in `netlify.toml` |

An independent review of 3.3.1 found no Critical, High or Medium issues; its Low findings were fixed (the owner
script now refuses other `realtime.messages` policies and any table access for `anon`/`authenticated`; the TLS host
is read as the driver reads it; channel changes are timed by the server's clock).

Still open: the newer `sb_publishable_`/`sb_secret_` keys and the newer JWT signing keys were not tested (the
legacy keys and legacy JWT secret are used); the `next` release-age exemption in `pnpm-workspace.yaml` is unrelated.

## Not verified here

Nothing was deployed and the live Supabase database was not changed. Real Supabase Realtime, real Waabek and the
real Netlify platform were not reachable from this environment: realtime and Waabek were tested against local
stand-ins that speak their documented protocols (Phoenix protocol 1.0.0 for the browser library, the HTTP
broadcast endpoint, Waabek's `POST {to, message}` with `X-API-Key`), and the Netlify server function was run
from the real Netlify build output with a Lambda-style layout and a local Blobs server.

## Costs and limits to know

- Every signed-in, open tab sends a heartbeat to `/api` every 25 seconds: about 144 function invocations per
  open tab per hour (they are short). Netlify counts function invocations and run time per plan.
- Work after the response (codes, push, signals) runs within the same invocation, so it counts toward the
  function's time limit; a code delivery is bounded to about 9 seconds.
- One-time-code retries: one more attempt (was up to three with back-off in the worker).
- Without `NEXT_PUBLIC_STORAGE_ORIGIN` and the three Supabase variables, realtime is off and devices check for
  changes every 20 seconds and with every heartbeat.
- Groups and channels do not exist in this codebase (only private chats); nothing was removed from them.
