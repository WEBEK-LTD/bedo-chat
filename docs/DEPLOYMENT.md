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
set the API's allowed origins to the final Netlify URLs.

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
5. Storage buckets are created by the phase that needs them (private media from Phase 4).

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
| `DATABASE_URL` | `bedo_api` login (step 1.4), direct connection or session pooler |
| `DATABASE_POOL_MAX` | `10` per instance; keep total connections within the Supabase plan |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000` |
| `REDIS_URL` | Managed Redis URL |
| `QUEUE_PREFIX` | `bedo` (must match the worker); use a different value per environment sharing one Redis |
| `LOG_LEVEL` | `info` |

Health checks: liveness `GET /health/live`, readiness `GET /health/ready` (returns 503 while Postgres or Redis
is unreachable). The image runs as a non-root user and includes its own `HEALTHCHECK`.

## 4. Worker container

```bash
docker build -f apps/worker/Dockerfile -t bedo-worker .
```

Variables: `NODE_ENV` (set in the image), `REDIS_URL`, `QUEUE_PREFIX` (same as the API), `WORKER_CONCURRENCY`,
`WORKER_HEARTBEAT_INTERVAL_MS`, `LOG_LEVEL`. No port. Give it a stop timeout of at least 30 seconds so jobs in
progress finish on deploys.

## 5. Netlify sites

Create two sites from the same repository:

| Setting | Web app | Admin Dashboard |
| --- | --- | --- |
| Base directory | *(empty — repository root)* | *(empty — repository root)* |
| Package directory | `apps/web` | `apps/admin` |
| Build command / publish | From `netlify.toml` | From `netlify.toml` |
| Environment | `NEXT_PUBLIC_API_URL=https://<api host>` | `NEXT_PUBLIC_API_URL=https://<api host>` |

Netlify reads Node 24 and pnpm from `netlify.toml` and `package.json`, applies its Next.js adapter
automatically (do not pin it), and builds only the packages each app needs.

Netlify builds from a Git repository connected to the site. Because Bedo Chat is delivered as a ZIP (D-11),
either push the unzipped folder to a private repository you control and connect it, or deploy from your
machine with the Netlify CLI from the repository root:

```bash
netlify deploy --build --prod --filter @bedo/web     # and again with --filter @bedo/admin
```

Never set `DATABASE_URL`, `REDIS_URL` or `WAABEK_API_KEY` on a Netlify site.

## 6. Check the deployment

- `GET https://<api host>/health/ready` returns `{"status":"ok", ...}` with both checks `up`.
- The web app shows the login screen at `/login` and the chat layout at `/`.
- The Admin Dashboard shows its shell at its own domain.
- In Redis, the key `<QUEUE_PREFIX>:worker:heartbeat` is refreshed every 15 seconds.
