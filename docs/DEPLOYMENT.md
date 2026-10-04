# Deploying Bedo Chat

How each part of Bedo Chat is deployed (D-15). Provider, region, plan and domains for production are
confirmed with the owner before the production deployment (D-10); everything below is configured only
through environment variables.

| Part | Runs on | Defined by |
| --- | --- | --- |
| Web app (`apps/web`) | Netlify site | `apps/web/netlify.toml` |
| Admin Dashboard (`apps/admin`) | A second Netlify site, own domain | `apps/admin/netlify.toml` |
| API, later also the WebSocket gateway (`apps/api`) | Persistent container hosting (not Netlify functions) | `apps/api/Dockerfile` |
| Worker (`apps/worker`) | Persistent container hosting | `apps/worker/Dockerfile` |
| Database and files | Supabase Postgres and Supabase Storage | `supabase/migrations` |
| Queues | Managed Redis | — |

Recommended order: Supabase → migrations → runtime database role → Redis → API → worker → Netlify sites →
custom domains → set the API's allowed origins to the final URLs → first Super Admin → academy phone list.

**One registrable domain (P-14).** The web app keeps its session in an httpOnly cookie set by the API, and
browsers only send it when the app and the API share one registrable domain. Give the API, the web app and
the Admin Dashboard custom domains under the same domain, for example `api.academy.example`,
`chat.academy.example` and `admin.academy.example`. The default `*.netlify.app` addresses cannot hold a
session.

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
| `API_TRUST_PROXY_HOPS` | Number of proxies in front of the container — usually `1` |
| `CORS_ALLOWED_ORIGINS` | The two Netlify URLs, comma-separated, e.g. `https://chat.example.com,https://admin.example.com` |
| `ADMIN_ORIGINS` | The Admin Dashboard's URL only, e.g. `https://admin.example.com` (Phase 2: keeps the two apps from acting for each other) |
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
is unreachable). The image runs as a non-root user and includes its own `HEALTHCHECK`.

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
| Environment variable `NEXT_PUBLIC_API_URL` | `https://<api host>` | `https://<api host>` |

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

After deploying, add the custom domains (P-14) to both sites and put their final URLs in the API's
`CORS_ALLOWED_ORIGINS`, and the Admin Dashboard's URL also in `ADMIN_ORIGINS`.

## 6. Check the deployment

- `GET https://<api host>/health/ready` returns `{"status":"ok", ...}` with both checks `up`.
- Sign in to the Admin Dashboard with the Super Admin's phone and authenticator app; add your own number to
  the academy phone list.
- Sign in to the web app with that number: the WhatsApp code arrives, a new account asks for a name, and
  the chat interface opens. A reload keeps you signed in (if not, check the shared domain, P-14).
- Sign in on a second browser: the first one shows a login alert (and a notification, if turned on).
- A number not on the list gets the same "code sent" answer, and no WhatsApp message.
- In Redis, the key `<QUEUE_PREFIX>:worker:heartbeat` is refreshed every 15 seconds.
