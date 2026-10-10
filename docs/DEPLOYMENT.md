# Deploying Bedo Chat

Bedo Chat is **one Netlify site** (D-36). The site serves the student web app, the Admin Dashboard and the API;
Supabase provides the database, file storage and realtime. There is no API server, worker, Redis, Cloudflare
Worker or any other host to deploy.

| Part | Runs on | Defined by |
| --- | --- | --- |
| Student web app (`apps/web`): `/`, `/login` | The Netlify site `bedochat` (Next.js on Netlify's Next.js runtime) | `apps/web/netlify.toml` |
| Admin Dashboard (`apps/admin`): `/admin`, `/admin/login` | The same site: its static export is part of the web app's deploy (D-26) | `apps/web/netlify.toml`, `apps/admin/next.config.ts` |
| API (`apps/api`): `/api/*` | The same site: the web app's route `app/api/[[...path]]` runs the API in the site's server function (D-36) | `apps/web/app/api/[[...path]]/route.ts`, `apps/api/src/serverless.ts` |
| Database, short-lived state and rate limits | Supabase Postgres | `supabase/migrations` |
| Profile pictures | Supabase Storage (private bucket) | `supabase/migrations` |
| Realtime signals (new messages, typing, online) | Supabase Realtime (broadcast) | `apps/api/src/messaging/realtime*.ts` |
| WhatsApp codes, Web Push | Sent by the API right after the response that needs them | `apps/api/src/delivery` |

| Public URL | Served by |
| --- | --- |
| `https://bedochat.com/` | Student chat |
| `https://bedochat.com/login` | Student sign-in |
| `https://bedochat.com/admin` | Admin Dashboard |
| `https://bedochat.com/admin/login` | Admin sign-in |
| `https://bedochat.com/api/...` | API (the same site, the same origin) |

Because everything is one origin, the session cookies are first-party and scoped under `/api` (P-14), the API
accepts cookie-authenticated requests only from pages of that same site (no origin list to configure), and no
CORS is needed.

## 0. Go live (owner steps)

For the Bedo Chat project as it stands: Supabase in Sydney with migrations 1-6 and the login `bedo_api` already
created, the Netlify site `bedochat`, and `bedochat.com` on Cloudflare pointing at Netlify. No terminal is needed.

1. **GitHub** (GitHub Desktop, repository `WEBEK-LTD/bedo-chat`, branch `main`): *Fetch origin*, then
   *Repository → Show in Explorer/Finder*. Delete everything in that folder **except the hidden `.git` folder**,
   copy in everything inside the unzipped `bedo-chat` folder, then *Commit to main* and *Push origin*. (Deleting
   first matters: Phase 3.3 removes earlier files, such as `apps/worker`, which would otherwise stay and break the
   build.) Netlify starts a deploy; it cannot sign anyone in until steps 2-4 are done.
2. **Netlify plan and region**: the site's team on **Pro**, then Site configuration → **Functions** → **Region** →
   **Asia Pacific (Sydney)** → Save. The API runs in the functions, next to the database in Sydney; in another
   region every request waits for several round trips across the Pacific. (Choosing the region needs Pro.)
3. **Netlify variables** (without them every page of the API answers an error and the logs say "Invalid environment
   configuration ... is required"):
   1. Supabase → **SQL Editor** → paste the whole of
      [`docs/owner-sql/netlify-variables.sql`](owner-sql/netlify-variables.sql) → **Run**. The result is 9 lines:
      the database address with a new password for `bedo_api`, and the site's four keys, all made for you.
   2. In those lines replace the three `PASTE_` values with the Supabase keys (Project Settings → **API Keys** →
      *Legacy API keys*: `anon` and `service_role`; **JWT Keys** → *Legacy JWT Secret*).
   3. Netlify → Site configuration → **Environment variables** → **Add a variable** → **Import from a .env file** →
      paste the 9 lines → **Import** (scopes: all; the same value for every deploy context).
   4. Deploys → **Trigger deploy** → **Deploy site**. Variables reach the site only with a new deploy.
   5. Keep the 9 lines in your password manager and delete the query from the SQL Editor. Run the script again only
      to replace all of them (it refuses once the site has stored encrypted secrets with its keys).
4. **Supabase SQL Editor** (role `postgres`):
   1. Paste the whole of [`docs/owner-sql/apply-updates.sql`](owner-sql/apply-updates.sql) → **Run** once.
      Every line of the result says `ok`. It applies every migration after the first six, in order (D-35 admin
      password, the tables that replace Redis, the private realtime policy, then each later phase: media, ...;
      the file lists them), sets the limits of `bedo_api` and records them; if anything is not as expected it stops
      and keeps nothing. The file is generated from `supabase/migrations` (`node scripts/build-owner-sql.mjs`).
   2. If requests fail with "new row violates row-level security policy" (newer Supabase projects switch row level
      security on for every new table), paste
      [`docs/owner-sql/fix-row-level-security.sql`](owner-sql/fix-row-level-security.sql) → **Run**: both lines say
      `ok`. It turns it off on Bedo Chat's own tables only, after checking no Supabase API role can reach them; safe
      to run again. (`apply-updates.sql` now does the same at its end.)
   3. **Updates after go-live**: each later release that changes the database brings one file per change,
      `docs/owner-sql/update-<version>.sql`. Run each once, in order of the number in its name; every line of the
      result says `ok`. A file that was already run, or one whose earlier updates are missing, stops and changes
      nothing.
   4. Paste [`docs/owner-sql/set-super-admin.sql`](owner-sql/set-super-admin.sql), change the three values at the
      top (section 4d) → **Run** → delete the query afterwards (it holds the password).
5. **Supabase settings**: Project Settings → **Realtime** → turn **off** "Allow public access" (only devices with a
   token from the API can then listen, each on its own channel). Authentication → Sign In / Providers → turn off
   **Allow new users to sign up** (Bedo Chat never uses Supabase Auth).
6. **Cloudflare** → `bedochat.com` → **DNS**: set both records (`bedochat.com` A and `www` CNAME) to **DNS only**
   (click the orange cloud so it turns grey). Values unchanged. Behind Cloudflare's proxy every visitor would reach
   the API as one of a few Cloudflare addresses and share their sign-in limits; it also injects a script the
   site's security policy blocks. Then Netlify → Domain management → **HTTPS**: the certificate for `bedochat.com`
   is issued within minutes (*Verify DNS configuration* / *Provision certificate* if it asks).
7. **Check**: `https://bedochat.com/api/health/ready` → `{"status":"ok", ...}` with the database `up`; then
   `https://bedochat.com/admin/login` → phone and password → set up the authenticator app → the dashboard opens.
8. **Admin Dashboard**: OTP / WhatsApp → save the Waabek API key and send a test message; Academy phone list → add
   the students' numbers (or import them).
9. **On a phone**: open `https://bedochat.com` → sign in with a number from the list (the code comes by WhatsApp) →
   add the site to the Home Screen (iPhone: Safari → Share → **Add to Home Screen**; Android: Chrome → menu →
   **Install app**) → open it from the Home Screen → Settings → **Notifications** → **Turn on notifications**.

Nothing else is deployed: no API server, worker, Redis or Cloudflare Worker. A Render account or Cloudflare Worker
is not needed.

## 1. Supabase

1. **Project.** One Supabase project (Bedo Chat: `cspnnzoyuyxjiyhwzgqj`, region Sydney `ap-southeast-2`).
2. **Migrations.** Applied as the table owner (`postgres`), either from a checkout with
   `DATABASE_URL=<session-pooler URL> pnpm db:migrate`, or, for a database whose migrations were applied by hand in
   the SQL Editor (as Bedo Chat's were), with [`docs/owner-sql/apply-updates.sql`](owner-sql/apply-updates.sql)
   (every later migration in one run from 1-6; it refuses any other starting point and a second run). The migration
   runner never uses the transaction pooler (port 6543): migrations take a session lock.
3. **The API's login role** `bedo_api` (member of `bedo_runtime`), with `statement_timeout = '15s'` and
   `idle_in_transaction_session_timeout = '30s'` set on the role (the apply script sets both): through the
   transaction pooler the API cannot set them per connection itself. The API connects as this role, never as the
   table owner.
4. **The API's connection string** (`DATABASE_URL`): the **transaction pooler**, port **6543**, user
   `bedo_api.<project-ref>` (already filled in, apart from the password, in `docs/netlify-production.env`). The
   site's server functions start and stop with traffic, and the transaction pooler shares a few database
   connections among all of them. **TLS is automatic**: every connection to a Supabase host is encrypted and fully
   verified against Supabase's root certificate (`Supabase Root 2021 CA`, built into `packages/db`), including the
   host name; a server Supabase did not sign is refused. Nothing to configure, and no `sslmode` is needed.
5. **Keys** (Project Settings → **API Keys** → *Legacy API keys*): the **anon** (public) key and the
   **service_role** key; and Project Settings → **JWT Keys** → *Legacy JWT Secret*. The service_role key and the
   JWT secret are secrets: only in the site's server variables, never in a page. The API checks at start-up that
   the anon key is signed with the JWT secret (a secret from another project is refused by name).
6. **Realtime: private channels** (D-36, Realtime Authorization). Each signed-in device listens on its own
   channel, named on the server from its session and the current hour. The API gives the device a short-lived
   token (signed with the JWT secret, role `authenticated`) naming that one channel; the policy
   `bedo_device_receives_own_channel` on `realtime.messages` (migration 9) lets a device **receive** broadcasts on
   the channel its token names and nothing else, and no policy lets a device send. The API sends with the
   service_role key. Turn **off** Project Settings → Realtime → **Allow public access**, so that no channel can be
   used without such a token. Turn off **Authentication → Allow new users to sign up**: Bedo Chat never uses
   Supabase Auth (D-08), and the baseline migration keeps the `anon` role out of the `app` schema.
7. **Storage**: the Phase 2 migration created the private bucket `profile-photos`; nothing to do by hand.

## 2. Netlify site (one site, D-26, D-36)

The site `bedochat` (`https://bedochat.netlify.app`) is the whole of Bedo Chat. Do not create a second site.

| Path on the site | Served by |
| --- | --- |
| `/`, `/login` | Student web app (`apps/web`, Next.js on Netlify's Next.js runtime) |
| `/sw.js` | Student web app (its notifications service worker) |
| `/admin`, `/admin/login`, `/admin/_next/...` | Admin Dashboard (`apps/admin`), static files from the same deploy |
| `/api/*` | The API, inside the site's Next.js server function (route `apps/web/app/api/[[...path]]`) |

### Exact site settings

| Netlify setting | `bedochat` |
| --- | --- |
| Base directory | *(empty)* |
| Package directory | `apps/web` (`apps/admin` builds the identical site, D-28) |
| Build command | *(empty: taken from netlify.toml)* |
| Publish directory | *(empty: taken from netlify.toml)* |
| Functions → Region | **Asia Pacific (Sydney)**, next to the Supabase project (Netlify Pro). It applies to the Next.js server function that runs the API |

`apps/web/netlify.toml` (and its byte-identical copy `apps/admin/netlify.toml`) sets the build command
`pnpm turbo run build --filter=@bedo/web`, `publish = "apps/web/.next"`, `NODE_VERSION = "24"`,
`NEXT_PUBLIC_STORAGE_ORIGIN = "https://cspnnzoyuyxjiyhwzgqj.supabase.co"` (public: the pages' Content-Security-Policy
allows profile pictures and the realtime WebSocket from this exact origin only, D-31, D-36) and the Admin Dashboard's
security headers. No API address is configured anywhere: both apps call `/api` on the site itself.

### Environment variables

Site configuration → **Environment variables**, imported in one go from
[`docs/netlify-production.env`](netlify-production.env) with its 8 `PASTE_` values filled in (section 0, step 3).
After adding or changing a variable, run a new deploy (Deploys → Trigger deploy → Deploy site). The API refuses to
start, naming the variable, while any value is missing, malformed or still a `PASTE_` placeholder.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Section 1.4 (transaction pooler, `bedo_api.<project-ref>`, its password). Secret |
| `ACCESS_TOKEN_SECRET` | Secret, at least 32 characters. Also names each device's realtime channel |
| `OTP_HMAC_SECRET` | Secret, at least 32 characters, different from the one above |
| `ADMIN_TOTP_KEY` | Secret, exactly 32 bytes base64; keep a copy — admin authenticator setups depend on it |
| `SETTINGS_ENCRYPTION_KEY` | Secret, exactly 32 bytes base64, different from `ADMIN_TOTP_KEY`. Encrypts the Waabek API key that Super Admins set from the dashboard (D-32). Keep a copy |
| `SUPABASE_URL` | `https://cspnnzoyuyxjiyhwzgqj.supabase.co` |
| `SUPABASE_ANON_KEY` | The anon key (section 1.5). Public; handed to signed-in browsers, which can only use it with their own channel token |
| `SUPABASE_SERVICE_ROLE_KEY` | The service_role key (section 1.5). Secret |
| `SUPABASE_JWT_SECRET` | The legacy JWT secret (section 1.5). Secret: signs each device's realtime token. It can sign any Supabase token, so keep it only here. Rotating or revoking the legacy JWT secret in Supabase also changes the legacy anon and service_role keys: update all three here together, or devices fall back to checking every 20 seconds |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | **Leave unset.** Since Phase 13 (D-46) the API makes the Web Push keys itself and keeps them in the database. Setting all three replaces them, and every browser must then turn notifications on again |

Optional tuning: `LOG_LEVEL` (default `info`), `DATABASE_POOL_MAX` (default `3` per function instance),
`DATABASE_STATEMENT_TIMEOUT_MS` (default `15000`), `WAABEK_API_URL` (default `https://waabek.com/api/v1/send`).
`WAABEK_API_KEY` must not be set: the API refuses to start with it (D-32); the key is set from the Admin Dashboard
(section 4a the first time, then *OTP / WhatsApp*).

**Previews.** Every deploy of the site runs the API. Do not open pull requests or branch deploys against this site
while the variables apply to all deploy contexts: a preview would be a second, unreviewed API on the production
database. If previews are wanted later, give the server variables a value for the **Production** context only.

### What runs where, at run time

- **Every API request** runs in the site's server function (Sydney): the API application is created on the first
  request of an instance and kept for the next ones. Postgres is its only dependency.
- **Work after the response** (WhatsApp codes, Web Push, realtime signals, housekeeping) runs in the same
  invocation right after the response is sent (Next.js `after()`, kept alive by Netlify with `waitUntil`), within
  Netlify's 60-second limit for a function; a one-time code is given at most 9 seconds. A code therefore never
  delays the answer, and a number that may not sign in gets the same answer in the same time. A code that Waabek
  refuses is tried once more when the failure is temporary, then recorded in the security history
  (`otp_delivery_failed`).
- **Housekeeping** (message partitions three months ahead, pruning the 30-day update log, retired refresh tokens
  and expired short-lived state) runs at most once an hour, started by ordinary requests. With no traffic nothing
  needs doing; a missing message partition is also created on the spot.
- **Scheduled messages and channel posts** (Phase 6, D-40) go out on time without a worker: the site's scheduled
  function `scheduler` (in `apps/web/netlify/functions`, set by `[functions] directory` in `netlify.toml`) runs every
  minute and asks `/api/v1/internal/dispatch` to send what is due; ordinary requests also send due messages within
  seconds. It needs `ACCESS_TOKEN_SECRET` to be available to **Functions** (the default "All scopes" when the
  variables are imported) and uses Netlify's own `URL`. Netlify runs scheduled functions on the **published
  production deploy** only. Logs → Functions → `scheduler` shows each run ("Scheduled messages: {"sent":…}").
- **Broadcast notifications** (Phase 10, O-20) from the Admin Dashboard start right after the admin sends them and
  continue on each run of the same `scheduler` function until every device is reached (200 devices a batch). They
  are Web Push messages. Nothing to set up.
- **Notifications** (Phase 7, D-41) are Web Push messages sent by the API right after the message that causes them;
  need nothing to set up: the API makes its Web Push keys the first time they are needed (Phase 13, D-46). Each
  person turns them on per browser in Settings → Notifications; on iPhone and iPad after adding the site to the Home
  Screen (Safari → Share → **Add to Home Screen**, iOS 16.4+), which the site's manifest and icons allow.
- **Realtime.** Signed-in browsers listen on their private Supabase Realtime channel and send a heartbeat to `/api`
  every 25 seconds (online for 60 seconds each, P-18). Each heartbeat also returns the device's update position,
  so a device that missed a signal catches up within 25 seconds.
- **Client address.** Per-address limits (one-time codes, admin passwords) count the address Netlify reports in
  `x-nf-client-connection-ip`. Nothing may proxy in front of the site (section 3).
- **Cost.** Netlify bills requests and function time; every open tab sends a heartbeat every 25 seconds. Watch
  the team's usage page in the first weeks.

Health: `https://bedochat.com/api/health/ready` returns `{"status":"ok","checks":{"database":{"status":"up",…}}}`.

## 3. Domain: bedochat.com straight to Netlify

`bedochat.com`'s DNS is on Cloudflare; its records point at Netlify (`bedochat.com` A `75.2.60.5`, `www` CNAME
`bedochat.netlify.app`). Both must be **DNS only** (grey cloud), not proxied: a proxied record puts Cloudflare in front
of Netlify, so every visitor would reach the API as one of a few Cloudflare addresses and share their per-address
limits, and Cloudflare would inject scripts the pages' security policy blocks. Netlify issues and renews the HTTPS
certificate itself (Domain management → HTTPS). No Cloudflare Worker, Render service or Redis is used (D-36).

Notes kept from earlier phases:
- **Browsers**: the Admin Dashboard needs a browser that sends Fetch Metadata headers (Chrome, Edge,
  Firefox 90+, Safari 16.4+). Older browsers are refused, not let through.
- **Admins**: the student app and the Admin Dashboard share one origin, so sign in to the dashboard in a
  separate browser profile from any student account.
- **Content-Security-Policy (D-31)**: the student app's pages send a strict policy with a fresh nonce per
  response (`apps/web/proxy.ts`, run by Netlify as an edge function), the Admin Dashboard's pages the fixed
  policy in `netlify.toml`. Scripts and styles come from the site only; data from the site itself (which
  includes the API) and, with `NEXT_PUBLIC_STORAGE_ORIGIN`, from the Supabase project (pictures and the
  realtime WebSocket).
- **Service worker**: `/sw.js` (notifications only) has the scope `/`, which also covers `/admin`. It has no
  fetch handler and caches nothing; keep it that way.

## 4. Admins and the Waabek key

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
   token and the new Waabek API key, then **Save key**. The API encrypts it with `SETTINGS_ENCRYPTION_KEY` and
   uses it from the next message on. Each token saves one key only; to save a different key, run the
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
or, for Bedo Chat's database, [`docs/owner-sql/apply-updates.sql`](owner-sql/apply-updates.sql), which applies it
with every later migration).

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

Signing in needs the site (section 2) and migration `20261006180000` (section 1); running the script does not.

## 5. Check the deployment

- `https://bedochat.com/api/health/ready` returns `"status":"ok"` with the database `up`.
- `https://bedochat.com/admin` sends you to `/admin/login`. Sign in with the Super Admin's phone number,
  password and authenticator app (the first time: section 4a or 4d); the dashboard opens at `/admin` and stays
  after a reload. A wrong password answers "The phone number or password is incorrect." In *OTP / WhatsApp*,
  **Send test message** reports that Waabek accepted it. Add your own number to the academy phone list.
- `https://bedochat.com/` sends you to `/login`. Sign in with that number: the WhatsApp code arrives, a new
  account asks for a name, the chat interface opens at `/`, and a reload keeps you signed in.
- A number not on the list gets the same "code sent" answer, and no WhatsApp message.
- Sign in on two browsers with two academy numbers, find the other by name and send a message: it appears on
  the other browser within a second or two, with typing shown while the other person writes. In the browser's
  developer tools, the Network panel shows the WebSocket to `wss://<ref>.supabase.co/realtime/v1/websocket`
  joining a private channel (a refused join means "Allow public access" or the JWT secret is wrong; the device then
  still gets every change by checking every 20 seconds)
  and a `POST /api/v1/realtime/heartbeat` every 25 seconds; the Console shows no Content-Security-Policy
  errors on `/`, `/login`, `/admin` and `/admin/login`.
- Netlify → Logs → Functions shows the API's request logs (no passwords, codes or keys).
