# Deploying Bedo Chat

How each part of Bedo Chat is deployed (D-15). Provider, region, plan and domains for production are
confirmed with the owner before the production deployment (D-10); everything below is configured only
through environment variables.

| Part | Runs on | Defined by |
| --- | --- | --- |
| Public domain `https://bedochat.com` (D-25) | Cloudflare, with the routing Worker | `deploy/cloudflare/` |
| Web app (`apps/web`), served at `/` and `/login` | Netlify site (default `.netlify.app` address) | `apps/web/netlify.toml` |
| Admin Dashboard (`apps/admin`), served at `/admin` and `/admin/login` | A second Netlify site (default `.netlify.app` address) | `apps/admin/netlify.toml` |
| API, later also the WebSocket gateway (`apps/api`), served at `/api` | Persistent container hosting (not Netlify functions) | `apps/api/Dockerfile` |
| Worker (`apps/worker`) | Persistent container hosting | `apps/worker/Dockerfile` |
| Database and files | Supabase Postgres and Supabase Storage | `supabase/migrations` |
| Queues | Managed Redis | — |

Recommended order: Supabase → migrations → runtime database role → Redis → API → worker → Netlify sites →
Cloudflare and the routing Worker → first Super Admin → academy phone list.

**One public domain (D-25).** Everything is served from `https://bedochat.com`:

| Public URL | Served by |
| --- | --- |
| `https://bedochat.com/` | Student chat (web app) |
| `https://bedochat.com/login` | Student sign-in (web app) |
| `https://bedochat.com/admin` | Admin Dashboard (admin app) |
| `https://bedochat.com/admin/login` | Admin sign-in (admin app) |
| `https://bedochat.com/api/...` | API, and in Phase 3 its WebSocket connections |

There are no `chat.`, `admin.` or `api.` subdomains. Cloudflare holds the domain, and a small Worker
(`deploy/cloudflare/worker.js`) sends each path to its origin: `/api/*` to the API host with `/api` removed
(WebSockets passed through), `/admin*` to the admin Netlify site, everything else to the web Netlify site.
Netlify alone cannot do this: its proxy does not carry WebSockets. Because the apps and the API share one
origin, the session cookies are first-party (P-14 is met) and scoped under `/api`.

## 1. Supabase

1. Create a project in the region closest to the academy's students.
2. Find two connection strings under *Connect*:
   - **Direct connection** (`db.<ref>.supabase.co:5432`) — IPv6 only unless the IPv4 add-on is enabled.
   - **Session pooler** (`<pooler-host>:5432`) — works over IPv4. Use it when your container host has no IPv6.
   - **Never use the transaction pooler (port 6543)** for Bedo Chat: the migration runner and the API both refuse it.
3. Apply migrations as the table owner (`postgres`), from the API image:

   ```bash
   docker run --rm -e DATABASE_URL='postgresql://postgres:<password>@<host>:5432/postgres' \
     bedo-api node node_modules/@bedo/db/dist/cli.js migrate
   ```

   or from a checkout: `DATABASE_URL=... pnpm db:migrate`. Re-running is safe; it applies only new migrations.
4. Create the login role the API and worker use (once per environment, password from your secret store):

   ```sql
   create role bedo_api login password '<generated password>' in role bedo_runtime;
   ```

   On the session pooler the user name becomes `bedo_api.<project-ref>`.
5. The Phase 2 migration creates the private Storage bucket `profile-photos` (JPEG, PNG or WebP, 5 MB) on
   Supabase; nothing to do by hand. Copy the project URL and the **service_role** key (*Project settings →
   API*) for the API's `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The service_role key is a secret: API
   only, never a Netlify site.

## 2. Redis

Use a managed Redis 7+ that keeps data on restart. BullMQ needs the eviction policy **`noeviction`**;
with any other policy Redis may silently drop queued jobs. Use the `rediss://` (TLS) URL when offered.

## 3. API container

```bash
docker build -f apps/api/Dockerfile -t bedo-api .     # from the repository root
```

| Variable | Production value |
| --- | --- |
| `NODE_ENV` | `production` (set in the image) |
| `API_PORT` | `4000` unless the host assigns a port |
| `API_TRUST_PROXY_HOPS` | `1` for the Cloudflare Worker, plus any proxy or load balancer your container host puts in front of the API (usually `2` in total). It decides which address the per-IP code limits count |
| `CORS_ALLOWED_ORIGINS` | `https://bedochat.com` |
| `ADMIN_ORIGINS` | `https://bedochat.com` (the Admin Dashboard's origin) |
| `WEB_ORIGINS` | `https://bedochat.com` (the web app's origin; required because both apps share it) |
| `API_PUBLIC_PATH` | `/api` (the path in front of the API; session cookies are scoped under it) |
| `EDGE_SECRET` | Secret, at least 32 characters (`openssl rand -base64 32`); the same value is set as the Worker's secret (section 5a). The API answers only requests that carry it |
| `DATABASE_URL` | `bedo_api` login (step 1.4), direct connection or session pooler |
| `DATABASE_POOL_MAX` | `10` per instance; keep total connections within the Supabase plan |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000` |
| `REDIS_URL` | Managed Redis URL |
| `QUEUE_PREFIX` | `bedo` (must match the worker); use a different value per environment sharing one Redis |
| `LOG_LEVEL` | `info` |
| `ACCESS_TOKEN_SECRET` | Secret, at least 32 characters (`openssl rand -base64 32`) |
| `OTP_HMAC_SECRET` | Secret, at least 32 characters, different from the one above |
| `ADMIN_TOTP_KEY` | Secret, exactly 32 bytes base64 (`openssl rand -base64 32`); keep a copy in your secret store — admin authenticator setups depend on it |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | From step 1.5 (profile pictures) |
| `VAPID_PUBLIC_KEY` | Public half of the Web Push key pair (see the worker) |

Health checks: liveness `GET /health/live`, readiness `GET /health/ready` (returns 503 while Postgres or Redis
is unreachable); publicly `https://bedochat.com/api/health/ready`. The image runs as a non-root user and includes
its own `HEALTHCHECK`.

**Only your Worker reaches the API.** Browsers use `https://bedochat.com/api`; the API's own host name is the
Worker's target, not a public address. With `EDGE_SECRET` set, the API refuses every request that does not
carry the Worker's secret header (the health checks excepted), so nobody can call it directly and supply their
own `X-Forwarded-For` to get around the per-IP code limits. Allowing only Cloudflare's IP ranges is not
enough on its own: any Cloudflare customer's Worker comes from those ranges.

## 4. Worker container

```bash
docker build -f apps/worker/Dockerfile -t bedo-worker .
```

Variables: `NODE_ENV` (set in the image), `REDIS_URL`, `QUEUE_PREFIX` (same as the API), `WORKER_CONCURRENCY`,
`WORKER_HEARTBEAT_INTERVAL_MS`, `LOG_LEVEL`, and from Phase 2:

| Variable | Production value |
| --- | --- |
| `DATABASE_URL` | The same `bedo_api` login as the API (or a second `bedo_runtime` member) |
| `DATABASE_POOL_MAX` | `5` |
| `OTP_DELIVERY` | `waabek` (the default; the only value allowed in production) |
| `WAABEK_API_KEY` | Your Waabek key, entered only in the host's secret settings |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Generate once with `npx web-push generate-vapid-keys`; subject `mailto:<academy address>`. The private key is a secret |

No port. Give it a stop timeout of at least 30 seconds so jobs in progress finish on deploys.

## 4a. First Super Admin

Admins are created from the command line until admin management arrives in Phase 10. Use the table-owner
connection (as for migrations) and the API's `ADMIN_TOTP_KEY`:

```bash
docker run --rm -e DATABASE_URL='postgresql://postgres:<password>@<host>:5432/postgres' \
  -e ADMIN_TOTP_KEY='<same as the API>' \
  bedo-api node dist/scripts/admin-create.js --phone +2010XXXXXXXX --name "Academy Admin" --role super_admin
```

The command prints an authenticator setup link and secret once. Add it to the admin's authenticator app
right away; it cannot be shown again. Use `--role moderator` for read-only admins.

## 5. Netlify sites

Two Netlify sites are created from the same repository: one for the web app, one for the Admin Dashboard.

### How Netlify reads this monorepo

- Each site's settings live in its own `netlify.toml`: `apps/web/netlify.toml` and `apps/admin/netlify.toml`.
- Netlify finds that file through the site's **Package directory**. Netlify only allows the package
  directory to be set in its UI; there is no `netlify.toml` property for it. It is the one setting that has to
  be entered by hand, once per site.
- The **Base directory** stays empty (repository root). Netlify installs dependencies and runs the build
  command there, so pnpm sees the whole workspace.
- Every path inside `netlify.toml`, including `publish`, is resolved from the base directory (the repository
  root), not from the app's folder. That is why `publish` names the app folder (`apps/admin/.next`).
  Phase 1.1 used `publish = ".next"`, which Netlify resolved to `<repo>/.next`, so the Next.js plugin
  failed with "publish directory was not found" after a successful build. Fixed in Phase 1.2;
  `scripts/checks.test.mjs` now fails if either file has the wrong paths.

### Exact site settings

| Netlify setting (site configuration → continuous deployment → Build settings) | Web app site | Admin Dashboard site |
| --- | --- | --- |
| Base directory | *(empty)* | *(empty)* |
| Package directory | `apps/web` | `apps/admin` |
| Build command | *(empty: taken from netlify.toml)* | *(empty: taken from netlify.toml)* |
| Publish directory | *(empty: taken from netlify.toml)* | *(empty: taken from netlify.toml)* |
| Environment variable `NEXT_PUBLIC_API_URL` | `https://bedochat.com/api` | `https://bedochat.com/api` |
| Custom domain | *none* (Cloudflare serves `bedochat.com`) | *none* |

What the two `netlify.toml` files set (values in the files take precedence over the UI):

| | `apps/web/netlify.toml` | `apps/admin/netlify.toml` |
| --- | --- | --- |
| `command` | `pnpm turbo run build --filter=@bedo/web` | `pnpm turbo run build --filter=@bedo/admin` |
| `publish` | `apps/web/.next` | `apps/admin/.next` |
| `NODE_VERSION` | `24` | `24` |
| `NEXT_TELEMETRY_DISABLED`, `TURBO_TELEMETRY_DISABLED` | `1` | `1` |

pnpm's version comes from `packageManager` in the root `package.json`. The Next.js runtime
(`@netlify/plugin-nextjs`) is added by Netlify automatically. Do not add or pin it.

### Deploying

Netlify builds from a Git repository connected to the site. Because Bedo Chat is delivered as a ZIP (D-11),
either push the unzipped folder to a private repository you control and connect both sites to it, or deploy
from your machine with the Netlify CLI, run from the repository root:

```bash
netlify deploy --build --prod --filter @bedo/web      # web app site
netlify deploy --build --prod --filter @bedo/admin    # Admin Dashboard site
```

`--filter` tells the CLI which package directory to use, the same as the UI setting.

**Local deploys after a local build:** if you ran `pnpm build` in the same folder first, run the deploy as
`TURBO_FORCE=true netlify deploy --build --prod --filter @bedo/web` (and the same for `@bedo/admin`).
Netlify's Next.js runtime builds in "standalone" mode, which Turborepo's cache does not tell apart from a
plain local build; without `TURBO_FORCE=true` the cached local build is reused and the deploy fails with
"publish directory does not contain expected Next.js build output". Builds on Netlify itself start from a
fresh clone and are not affected. (A one-line `turbo.json` fix is on hold while Phase 1 is frozen, R-02.)

Never set `DATABASE_URL`, `REDIS_URL`, `WAABEK_API_KEY` or any other server secret (`ACCESS_TOKEN_SECRET`,
`OTP_HMAC_SECRET`, `ADMIN_TOTP_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PRIVATE_KEY`) on a Netlify site.

Do not add `bedochat.com` to either Netlify site: Cloudflare serves it (section 5a). The admin app is built
under the `/admin` base path, so its site answers at `https://<admin-site>.netlify.app/admin`; opening either
`.netlify.app` address directly shows the app, but it cannot sign in there (the API accepts only
`https://bedochat.com`).

## 5a. Cloudflare: one domain for everything (D-25)

1. **Add `bedochat.com` to Cloudflare** and change the domain's nameservers at your registrar to the two
   Cloudflare gives you.
2. **Remove any existing `bedochat.com` (apex) record** in Cloudflare → DNS; the Worker's Custom Domain
   creates its own record and certificate in step 4.
3. **SSL/TLS**: encryption mode *Full (strict)*; turn on *Always Use HTTPS*. Network → *WebSockets* on (the
   default).
4. **Worker**: in `deploy/cloudflare/wrangler.toml` replace the three origins with the web site's and the
   admin site's `.netlify.app` addresses and the API's host address, then from that folder run
   `npx wrangler login`, `npx wrangler secret put EDGE_SECRET` (paste the API's `EDGE_SECRET`) and
   `npx wrangler deploy`. This attaches `bedochat.com` to the Worker as a Custom
   Domain (Cloudflare's recommended setup); every request to it is answered by the Worker.
4a. **www**: add a DNS record `CNAME www → bedochat.com`, Proxied, and a Redirect Rule (Rules → Redirect
   Rules) from `https://www.bedochat.com/*` to `https://bedochat.com/${1}`, status 301, preserving the query.
5. **Plan**: the Free plan includes 100,000 Worker requests a day; when real use exceeds that, switch on
   Workers Paid (check Cloudflare's current pricing). A WebSocket connection counts once, not per message.
6. **Phase 3 note**: Cloudflare closes WebSocket connections that stay silent too long and during API
   restarts, so the Phase 3 realtime client must send heartbeats and reconnect.
7. **Browsers**: the Admin Dashboard needs a browser that sends Fetch Metadata headers (Chrome, Edge,
   Firefox 90+, Safari 16.4+). Older browsers are refused, not let through.
8. **Admins**: because the student app and the Admin Dashboard share one origin (D-25), sign in to the
   dashboard in a separate browser profile from any student account.
9. **Service worker**: the student app's service worker (`/sw.js`, notifications only) has the scope `/`,
   which also covers `/admin`. It has no fetch handler and caches nothing; keep it that way, since the same
   origin means it would sit in front of the Admin Dashboard too.

## 6. Check the deployment

- `GET https://bedochat.com/api/health/ready` returns `{"status":"ok", ...}` with both checks `up`.
- Open `https://bedochat.com/admin`: it sends you to `/admin/login`. Sign in with the Super Admin's phone and
  authenticator app; the dashboard opens at `/admin` and stays after a reload. Add your own number to the
  academy phone list.
- Open `https://bedochat.com/`: it sends you to `/login`. Sign in with that number: the WhatsApp code
  arrives, a new account asks for a name, and the chat interface opens at `/`. A reload keeps you signed in
  (if not, check `WEB_ORIGINS` and `API_PUBLIC_PATH`).
- Sign in on a second browser: the first one shows a login alert (and a notification, if turned on).
- A number not on the list gets the same "code sent" answer, and no WhatsApp message.
- In Redis, the key `<QUEUE_PREFIX>:worker:heartbeat` is refreshed every 15 seconds.
