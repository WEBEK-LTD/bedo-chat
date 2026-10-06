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
Cloudflare and the routing Worker → first Super Admin and Waabek key (section 4a) → academy phone list.

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
| `SETTINGS_ENCRYPTION_KEY` | Secret, exactly 32 bytes base64 (`openssl rand -base64 32`), different from `ADMIN_TOTP_KEY`; the same value on the worker. Encrypts the Waabek API key that Super Admins set from the Admin Dashboard (D-32). Infrastructure only: never in the database, never in a browser, never set from the dashboard. Keep a copy in your secret store — if it changes, the saved Waabek key must be entered again |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | From step 1.5 (profile pictures) |
| `VAPID_PUBLIC_KEY` | Public half of the Web Push key pair (see the worker) |

**Phase 3: realtime (WebSocket).** The same container serves the WebSocket gateway at `/v1/realtime`
(publicly `wss://bedochat.com/api/v1/realtime`, through the Worker). No new variables: it accepts only
upgrades that carry the Worker's `EDGE_SECRET` and come from a `WEB_ORIGINS` page, and authenticates with the
access token in its first message. Requirements for the container host:

- WebSocket upgrades must reach the container (most hosts pass them through; check any load balancer in front).
- Idle timeout of any proxy in front of the API: more than 60 seconds (the apps send a heartbeat every 25
  seconds, P-18).
- Several API instances work together through Redis (pub/sub channel `<QUEUE_PREFIX>:realtime`); Redis must
  allow `PUBLISH`/`SUBSCRIBE` (managed Redis does by default).
- On deploys, give the container a stop timeout of at least 10 seconds: open connections are closed with
  code 1001 and each device's last seen is saved; devices reconnect and catch up through sync on their own.
- `API_TRUST_PROXY_HOPS` must be right (see above): the gateway allows at most 20 connections that have not
  signed in yet per client address, and with too few hops every visitor would share the Worker's address.

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
| `SETTINGS_ENCRYPTION_KEY` | The same value as the API's. The worker decrypts the Dashboard-managed Waabek key with it |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Generate once with `npx web-push generate-vapid-keys`; subject `mailto:<academy address>`. The private key is a secret |

No port. Give it a stop timeout of at least 30 seconds so jobs in progress finish on deploys.

**The Waabek API key is not an environment variable (D-32).** A Super Admin sets it from the Admin Dashboard
(section 4a for the first time, then *OTP / WhatsApp*); it is stored encrypted in `app.otp_settings`. The
worker refuses to start if `WAABEK_API_KEY` is still set: remove it from the host's settings. Before every
message the worker checks the stored settings' version and uses a changed key from the next message on, on
every worker instance, without a restart. If no key is saved or it cannot be decrypted, nothing is sent and the
failure is recorded in the security history (`otp_delivery_failed`, without the key).

Phase 3: the worker also keeps the monthly message partitions created three months ahead (at start-up and
every hour) and removes update-log entries and idempotency keys older than 30 days (P-17). Messages and the
audit history are never removed. Keep at least one worker running: without it, sending would stop once the
prepared partitions run out (more than three months later).

## 4a. First Super Admin (Phase 3.1, sign-in as amended by D-34)

Admin sign-in is **phone number + password → authenticator (TOTP) code → admin session** (D-34). The phone
number is the only admin identifier. No WhatsApp code is used for admin sign-in, and no admin session exists
without a valid authenticator code. Admin accounts are created by SQL; no command-line tool, container command
or environment variable is needed to create the first Super Admin, set its password or set the Waabek key.

1. In the Supabase SQL editor (the table owner, as for migrations), create the account and open the one-time
   initial setup:

   ```sql
   insert into app.admin_accounts (phone, name, role, status)
   values ('+905446731942', 'Academy Admin', 'super_admin', 'active');

   select * from app.open_admin_bootstrap();
   ```

   The second statement returns `setup_token` (valid 60 minutes) and `expires_at`. Only the token's hash is
   stored. Running it again before setup is complete replaces the token (needed after it expires, or after 5
   wrong tokens lock it).
2. Open `https://bedochat.com/admin/login`. While the setup is open the page shows **Initial setup**: enter
   the setup token and the Waabek API key, then **Save key**. The key is encrypted on the server and never shown
   again; it is used for the students' WhatsApp sign-in codes. **Send test message** sends a WhatsApp test to
   the Super Admin's number and shows Waabek's answer. Then **Continue to sign in**.
3. Create the admin's **password setup token** in the SQL editor (table owner):

   ```sql
   select * from app.issue_admin_password_setup('+905446731942');
   ```

   It returns `setup_token` (one-time, valid 60 minutes) and `expires_at`. Only its hash is stored. Give the
   token to the admin by a private channel. It is a different token from step 1's.
4. On `/admin/login`, choose **Set password with a setup token**, enter the phone number, the password setup
   token and the new password twice, then **Set password**. Password rules: 12–128 characters, no required
   mix of character types, not the admin's phone number, and not on the built-in list of common passwords
   (checked on the server; no network calls). The password is stored only as an Argon2id hash. This does
   **not** sign anyone in.
5. Sign in with the phone number and the password. The first time, the page asks you to **set up your
   authenticator app**: scan the QR code (or type the setup key) in an authenticator app and enter the 6-digit
   code it shows. The secret is generated on the server, kept encrypted with `ADMIN_TOTP_KEY`, and saved to
   the account only once this code is confirmed.
6. You are signed in. The initial setup is now closed for good: the page no longer offers it,
   `app.open_admin_bootstrap()` refuses, and the closure is in the audit log (`admin.bootstrap_closed`).

Neither setup token signs anyone in. More admins are created the same way: the `insert` statement (role
`super_admin` or `moderator`), then step 3 for their own password setup token, step 4, and the authenticator
setup at their first sign-in.

To change the Waabek key later: *OTP / WhatsApp* in the dashboard (Super Admins), enter the new key and a
current authenticator code, then **Send test message**.

## 4b. Waabek key recovery (D-33)

Use this when the saved Waabek key no longer works and you want to replace it without signing in to the
dashboard (since D-34, admins can still sign in without WhatsApp and replace it in *OTP / WhatsApp*). It
replaces the key and nothing else: it signs nobody in, creates no session, and does not change admin accounts,
passwords, roles, authenticator secrets or sessions. The initial setup stays closed.

1. In the Supabase SQL editor (table owner):

   ```sql
   select * from app.open_otp_settings_recovery();
   ```

   It returns `recovery_token` (valid 30 minutes) and `expires_at`; only the token's hash is stored, and the
   opening is recorded in the audit log. Running it again replaces the token (needed after it expires or after
   5 wrong tokens lock it). It is refused before the initial setup is complete (use section 4a instead).
2. Open `https://bedochat.com/admin/login`. The page shows **WhatsApp settings recovery**: enter the recovery
   token and the new Waabek API key, then **Save key**. The API encrypts it with `SETTINGS_ENCRYPTION_KEY`; every
   worker uses it from the next message on. Each token saves one key only; to save a different key, run the
   SQL again for a new token.
3. **Send test message** sends a WhatsApp test to the first Super Admin's number.
4. Sign in as usual (phone + password, then authenticator code). *OTP / WhatsApp* shows the key as changed "by
   owner recovery".

The key is never typed into SQL: it goes only through the sign-in page to the API.

## 4c. Admin passwords (D-34)

- **Sign-in limits.** 5 wrong passwords for one phone number within 15 minutes lock password sign-in for that
  number for 15 minutes (also for numbers that are not admins, so the answers do not reveal which numbers are).
  Each IP address can make 20 password attempts per 15 minutes. Attempts are counted before the password is
  checked. Unknown numbers, accounts without a password, disabled accounts and wrong passwords all get the
  same answer ("The phone number or password is incorrect.") after the same hashing work.
- **Change password (any admin).** Dashboard → *Account* → *Change password*: the current password, the new
  password twice and a current authenticator code. Every other session of that admin ends; the current session
  stays signed in. 5 attempts per 15 minutes.
- **Forgotten password / reset (owner only, SQL).** There is no reset page and no reset by another admin. The
  owner can set a new password directly with the one-script method in section 4d, or run, in the SQL editor:

  ```sql
  select * from app.issue_admin_password_setup('<admin-phone>');
  ```

  For an admin who already has a password this is a reset: the old password stops working at once and **every
  session of that admin ends**, including sign-ins in progress. It returns a new one-time setup token (60
  minutes); the admin sets a new password with it on `/admin/login` → **Set password with a setup token**, as in
  section 4a step 4. Setting it also lifts a sign-in lockout on that number. The authenticator app is unchanged.
- **Setup tokens.** One per admin (running the function again replaces it). A token sets one password only,
  expires after 60 minutes and stops working after 5 wrong tokens; a refused password (too common, the phone
  number) does not use it up. A wrong number, a wrong, used, expired or locked token all get the same answer.
  20 attempts per IP address per 15 minutes.
- **Disabling an admin** stays as before: `update app.admin_accounts set status = 'disabled' where phone = …`.
  A disabled admin's password answers like a wrong one, and `issue_admin_password_setup` refuses the account.
- **What is recorded.** Security history: `admin_password_setup_issued` / `admin_password_reset_issued`,
  `admin_password_set`, `admin_password_verified`, `admin_password_failed`, `admin_password_locked`,
  `admin_password_locked_attempt`, `admin_password_setup_refused`, `admin_password_setup_token_failed`,
  `admin_password_changed`. Audit log: `admin.password_setup_issued` / `admin.password_reset_issued`,
  `admin.password_set`, `admin.password_changed`. No password, hash or token is ever written to them, to the
  logs or to a response.
- **Upgrading from Phase 3.1.** The migration `20261005120000_phase3_2_admin_password.sql` adds the password
  columns and the setup-token table; existing admins keep their authenticator and get no password. Before they
  can sign in again, the owner runs `app.issue_admin_password_setup` for each admin, and each admin sets a
  password with their token. Existing admin sessions are not ended by the migration. Alternatively the owner sets each
  password directly with the one-script method in section 4d.

## 4d. Admin password with one SQL script (D-35)

The owner can create or update an admin and set the password in one step, from the Supabase SQL Editor,
without a setup token. Requires migration `20261006120000_d35_admin_password_owner_sql.sql` (`pnpm db:migrate`,
or, for a database whose migrations were applied by hand in the SQL Editor,
[`docs/owner-sql/apply-20261006120000.sql`](owner-sql/apply-20261006120000.sql) run once).

1. Supabase → **SQL Editor** → **New query**. Paste the whole of
   [`docs/owner-sql/set-super-admin.sql`](owner-sql/set-super-admin.sql).
2. Change the three values at the top: `input_phone` (international form, for example `+905446731942`),
   `input_name`, and `input_password` (the line marked `<<< PUT YOUR PASSWORD HERE`). If the password contains an
   apostrophe `'`, type it twice (`''`).
3. Click **Run** once. The last result shows the admin: `super_admin`, `active`, `has_password = true`.
4. Delete the query from the SQL Editor's saved queries: it contains the password in plain text.

What it does: the account becomes an active Super Admin with that password; every existing session of the
admin ends; an unused password setup token is closed; `admin.password_set` (audit log) and `admin_password_set`
(security history) are recorded without the password. The authenticator is not touched: every sign-in still
needs the authenticator code, and an account without one sets it up at its first sign-in.

The script checks the length (12–128 characters) and that the password is not the phone number. The database
cannot produce the API's Argon2id hash, so the script stores a temporary bcrypt hash (pgcrypto, cost 12, of the
password's SHA-256). At the first successful sign-in the API checks the full password rules, including the
common-password list, and replaces it with its normal Argon2id hash (`admin_password_upgraded` in the security
history). A password that breaks a rule is refused at that sign-in exactly like a wrong password (so a refusal
never confirms a guessed password); the reason is recorded in the security history as
`admin_password_upgrade_refused`. Run the script again with another password. A sign-in lock on the number (5
wrong passwords) is not lifted by the script; it ends by itself within 15 minutes. Until that first sign-in, checking this account's password takes about 250 ms instead of
about 11 ms.

Signing in needs the API (section 3); running the script does not.

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
| Environment variable `NEXT_PUBLIC_STORAGE_ORIGIN` (Phase 3, D-31) | The API's `SUPABASE_URL`, e.g. `https://<project>.supabase.co` (public, not a secret). The Content-Security-Policy allows profile pictures and their upload from this exact origin only. Required when profile pictures are set up; without it pictures do not load and uploads fail. A wrong value (not an https origin) fails the build. Redeploy after setting it |
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
| `[[headers]]` | Admin Dashboard security headers, including its Content-Security-Policy (D-31), for `/admin` and `/admin/*`; long-term caching for `/admin/_next/static/*` |

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
`OTP_HMAC_SECRET`, `ADMIN_TOTP_KEY`, `SETTINGS_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PRIVATE_KEY`,
`EDGE_SECRET`) on the Netlify site.

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
6. **WebSockets (Phase 3)**: the Worker passes `wss://bedochat.com/api/v1/realtime` through to the API with
   the edge secret (no change to the Worker). Cloudflare closes connections that stay silent too long and
   during API restarts; the web app sends a heartbeat every 25 seconds and reconnects on its own, and nothing
   is lost: every change is also fetched by sync after a reconnect.
7. **Browsers**: the Admin Dashboard needs a browser that sends Fetch Metadata headers (Chrome, Edge,
   Firefox 90+, Safari 16.4+). Older browsers are refused, not let through.
8. **Admins**: because the student app and the Admin Dashboard share one origin (D-25), sign in to the
   dashboard in a separate browser profile from any student account.
9. **Content-Security-Policy (D-31, Phase 3)**: the student app's pages send a strict policy with a fresh
   nonce per response (`apps/web/proxy.ts`; Netlify runs it as an edge function before the pages), and the
   Admin Dashboard's pages send the fixed policy in `netlify.toml`. Both allow scripts and styles from
   `bedochat.com` only and the API and its WebSocket on `bedochat.com`; the student app also allows profile
   pictures from the one Supabase project in `NEXT_PUBLIC_STORAGE_ORIGIN` (section 5). Do not add Cloudflare features that inject
   scripts into pages (Rocket Loader, Zaraz, Web Analytics auto-injection, email obfuscation, Bot Fight Mode's
   JavaScript challenge on page routes): the policy blocks them. The student app's pages are now rendered per
   request (a nonce cannot be in a page built ahead of time).
10. **Service worker**: the student app's service worker (`/sw.js`, notifications only) has the scope `/`,
   which also covers `/admin`. It has no fetch handler and caches nothing; keep it that way, since the same
   origin means it would sit in front of the Admin Dashboard too.

## 6. Check the deployment

- `GET https://bedochat.com/api/health/ready` returns `{"status":"ok", ...}` with both checks `up`.
- Open `https://bedochat.com/admin`: it sends you to `/admin/login`. Sign in with the Super Admin's phone
  number, password and authenticator app (the first time: section 4a); the dashboard opens at `/admin` and
  stays after a reload. A wrong password answers "The phone number or password is incorrect." and no WhatsApp
  message is sent for admin sign-in.
  In *OTP / WhatsApp*, **Send test message** reports that Waabek accepted it. Add your own number to the
  academy phone list.
- Open `https://bedochat.com/`: it sends you to `/login`. Sign in with that number: the WhatsApp code
  arrives, a new account asks for a name, and the chat interface opens at `/`. A reload keeps you signed in
  (if not, check `WEB_ORIGINS` and `API_PUBLIC_PATH`).
- Sign in on a second browser: the first one shows a login alert (and a notification, if turned on).
- A number not on the list gets the same "code sent" answer, and no WhatsApp message.
- In Redis, the key `<QUEUE_PREFIX>:worker:heartbeat` is refreshed every 15 seconds.
- Phase 3: sign in on two browsers with two academy numbers, find the other by name and send a message: it
  appears on the other browser at once (WebSocket through Cloudflare), and the sender's message shows
  delivered, then seen. In the browser's developer tools, the Network panel shows the connection to
  `wss://bedochat.com/api/v1/realtime` and the Console shows no Content-Security-Policy errors on `/`,
  `/login`, `/admin` and `/admin/login`.
