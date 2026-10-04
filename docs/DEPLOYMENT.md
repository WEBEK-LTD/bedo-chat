# Deploying Bedo Chat

How each part of Bedo Chat is deployed (D-15). Provider, region, plan and domains for production are
confirmed with the owner before the production deployment (D-10); everything below is configured only
through environment variables.

| Part | Runs on | Defined by |
| --- | --- | --- |
| Public domain `https://bedochat.com` (D-25) | Cloudflare, with the routing Worker | `deploy/cloudflare/` |
| Web app (`apps/web`), served at `/` and `/login` | One Netlify site, `bedochat.netlify.app` (D-26) | `apps/web/netlify.toml` |
| Admin Dashboard (`apps/admin`), served at `/admin` and `/admin/login` | The same Netlify site: its static export is part of the web app's deploy (D-26) | `apps/web/netlify.toml`, `apps/admin/next.config.ts` |
| API, later also the WebSocket gateway (`apps/api`), served at `/api` | Persistent container hosting (not Netlify functions) | `apps/api/Dockerfile` |
| Worker (`apps/worker`) | Persistent container hosting | `apps/worker/Dockerfile` |
| Database and files | Supabase Postgres and Supabase Storage | `supabase/migrations` |
| Queues | Managed Redis | — |

Recommended order: Supabase → migrations → runtime database role → Redis → API → worker → Netlify site →
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
(WebSockets passed through), `/admin*` to the admin origin, everything else to the web origin. Since D-26 both
of those are the same Netlify site, which serves the student app and the Admin Dashboard.
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

## 5. Netlify site (one site for both apps, D-26)

Bedo Chat uses **one** Netlify site, `bedochat` (`https://bedochat.netlify.app`). It serves the student web app
and, under `/admin`, the Admin Dashboard. Do not create a second site.

| Path on the site | Served by |
| --- | --- |
| `/`, `/login` | Student web app (`apps/web`, Next.js on Netlify's Next.js runtime) |
| `/sw.js` | Student web app (its notifications service worker) |
| `/admin`, `/admin/login` | Admin Dashboard (`apps/admin`), static files |
| `/admin/_next/...` | Admin Dashboard scripts, styles and page data |

`apps/web` and `apps/admin` stay separate applications. They are combined only at build time:

1. Turborepo builds the Admin Dashboard first (`turbo.json`: `@bedo/web#build` depends on `@bedo/admin#build`).
   The admin app is a static export (`output: 'export'` in `apps/admin/next.config.ts`) under its `/admin`
   base path, written to `apps/admin/out`.
2. The web app's build (`apps/web/package.json`) starts with `scripts/bundle-admin-into-web.mjs`, which checks
   that the export is complete and from the latest admin build, then replaces `apps/web/public/admin` with it.
   That folder is generated, never committed (`.gitignore`).
3. `next build` builds the web app. Netlify's Next.js runtime publishes the web app's `public/` folder as
   static files, so the Admin Dashboard goes out in the same deploy.
4. No routing rules are needed. Netlify answers a request with a matching static file before it runs the
   Next.js server function, and its static file matching finds `admin/index.html` for `/admin` and
   `admin/login.html` for `/admin/login` (with or without a trailing slash). Everything else goes to the web
   app's Next.js server, so other `/admin/...` paths answer 404 (no catch-all).
5. `apps/web/netlify.toml` sets the Admin Dashboard's security headers for `/admin` and everything under it
   (`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, and a `Permissions-Policy` that turns off camera,
   microphone, screen capture and location). On Netlify, headers in `next.config` do not apply to files from
   `public/`, so they live in `netlify.toml`.

Both builds always run in full (`"cache": false` in `turbo.json`): a build replayed from Turborepo's cache adds
files but never removes old ones, which could leave files from an earlier build in the deploy. Always build
through Turborepo (`pnpm turbo run build --filter=@bedo/web`, as Netlify does); running only the web app's
own build script would add whatever admin export was built last.

### How Netlify reads this monorepo

- The site's settings live in `apps/web/netlify.toml`. Netlify finds that file through the site's
  **Package directory** (`apps/web`). Netlify only allows the package directory to be set in its UI; there is
  no `netlify.toml` property for it.
- The **Base directory** stays empty (repository root). Netlify installs dependencies and runs the build
  command there, so pnpm sees the whole workspace.
- Every path inside `netlify.toml`, including `publish`, is resolved from the base directory (the repository
  root), not from the app's folder. That is why `publish` names the app folder (`apps/web/.next`).
  Phase 1.1 used `publish = ".next"`, which Netlify resolved to `<repo>/.next`, so the Next.js plugin
  failed with "publish directory was not found" after a successful build. Fixed in Phase 1.2;
  `scripts/checks.test.mjs` fails if the paths are wrong.
- **Either Package directory works (D-28).** `apps/admin/netlify.toml` is a byte-for-byte copy of
  `apps/web/netlify.toml` (a test keeps them identical; change both together). Netlify reads the copy in the
  site's Package directory, so a site set to `apps/web` (documented) or `apps/admin` (what Netlify's own app
  detection lists first) builds and publishes the same combined site. Netlify's Next.js runtime takes the app
  from the build output, not from the Package directory. This replaces the Phase 2.3.1 guard (D-27), which
  failed every build from `apps/admin`; before that, such a build published the Admin Dashboard alone.

### Exact site settings

| Netlify setting (site configuration → continuous deployment → Build settings) | `bedochat` |
| --- | --- |
| Base directory | *(empty)* |
| Package directory | `apps/web` (`apps/admin` builds the identical site, D-28) |
| Build command | *(empty: taken from netlify.toml)* |
| Publish directory | *(empty: taken from netlify.toml)* |
| Environment variable `NEXT_PUBLIC_API_URL` | Nothing to set: `apps/web/netlify.toml` sets `https://bedochat.com/api` for both apps' builds (D-27), and it takes precedence over a UI value |
| Custom domain | *none* (Cloudflare serves `bedochat.com`) |

What `apps/web/netlify.toml` (and its identical copy `apps/admin/netlify.toml`) sets (values in the file take
precedence over the UI):

| Setting | Value |
| --- | --- |
| `command` | `pnpm turbo run build --filter=@bedo/web` (builds the Admin Dashboard export first, then the web app) |
| `publish` | `apps/web/.next` |
| `NEXT_PUBLIC_API_URL` | `https://bedochat.com/api` (public address of the API, D-25; not a secret) |
| `NODE_VERSION` | `24` |
| `NEXT_TELEMETRY_DISABLED`, `TURBO_TELEMETRY_DISABLED` | `1` |
| `[[redirects]]` | none (not needed, see above) |
| `[[headers]]` | Admin Dashboard security headers for `/admin` and `/admin/*`; long-term caching for `/admin/_next/static/*` |

pnpm's version comes from `packageManager` in the root `package.json`. The Next.js runtime
(`@netlify/plugin-nextjs`) is added by Netlify automatically. Do not add or pin it.

### Deploying

One build and one deploy carry both applications. Netlify builds from a Git repository connected to the site.
Because Bedo Chat is delivered as a ZIP (D-11), either push the unzipped folder to a private repository you
control and connect the `bedochat` site to it, or deploy from your machine with the Netlify CLI, run from the
repository root:

```bash
netlify deploy --build --prod --filter @bedo/web --site bedochat
```

`--filter @bedo/web` selects the package directory (`apps/web`); `--site bedochat` names the site, so the
deploy cannot go to a different linked site. There is no separate admin deploy.

**Local deploys after a local build:** if you ran `pnpm build` in the same folder first, run the deploy as
`TURBO_FORCE=true netlify deploy --build --prod --filter @bedo/web --site bedochat`.
Netlify's Next.js runtime builds in "standalone" mode, which Turborepo's cache does not tell apart from a
plain local build; without `TURBO_FORCE=true` a cached local build could be reused and the deploy fails with
"publish directory does not contain expected Next.js build output". Since D-26 the web and admin builds are
never taken from the cache, but `TURBO_FORCE=true` is still the safe way to run it. Builds on Netlify itself
start from a fresh clone and are not affected.

**After deploying, check the site itself** before anything else:

| URL | Expected |
| --- | --- |
| `https://bedochat.netlify.app/` | 200, title "Bedo Chat" (redirects to `/login` in the browser when signed out) |
| `https://bedochat.netlify.app/login` | 200, title "Sign in · Bedo Chat" |
| `https://bedochat.netlify.app/sw.js` | 200, the student app's service worker |
| `https://bedochat.netlify.app/admin` | 200, title "Bedo Chat Admin" (or a redirect to `/admin/` first, if Netlify's Pretty URLs adds the slash) |
| `https://bedochat.netlify.app/admin/login` | 200, title "Sign in · Bedo Chat Admin" |

Signing in only works on `https://bedochat.com`: the API accepts only that origin.

Never set `DATABASE_URL`, `REDIS_URL`, `WAABEK_API_KEY` or any other server secret (`ACCESS_TOKEN_SECRET`,
`OTP_HMAC_SECRET`, `ADMIN_TOTP_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PRIVATE_KEY`, `EDGE_SECRET`) on the
Netlify site.

Do not add `bedochat.com` to the Netlify site: Cloudflare serves it (section 5a). If a separate admin-only
Netlify site was ever created before D-26, delete it or stop its builds: it is no longer used.

## 5a. Cloudflare: one domain for everything (D-25)

1. **Add `bedochat.com` to Cloudflare** and change the domain's nameservers at your registrar to the two
   Cloudflare gives you.
2. **Remove any existing `bedochat.com` (apex) record** in Cloudflare → DNS; the Worker's Custom Domain
   creates its own record and certificate in step 4.
3. **SSL/TLS**: encryption mode *Full (strict)*; turn on *Always Use HTTPS*. Network → *WebSockets* on (the
   default).
4. **Worker**: in `deploy/cloudflare/wrangler.toml` replace the three origins: `WEB_ORIGIN` and `ADMIN_ORIGIN`
   both with `https://bedochat.netlify.app` (the one Netlify site, D-26), and `API_ORIGIN` with the API's host
   address. Then from that folder run
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
