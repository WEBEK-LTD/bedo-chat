# Phase 3.1 report — Admin bootstrap and Dashboard-managed OTP settings

Phase 3.1 lets the first Super Admin, created by SQL, receive the WhatsApp sign-in code, set up the
authenticator app at the first sign-in, and manage the Waabek API key from the Admin Dashboard (D-32). No
command-line tool, container command or environment variable is needed to create an admin or to set the key.
It is a separate delivery before the rest of Phase 3; it is built on Phase 2.3.2 so it can be deployed without
the Phase 3 messaging work, and its migration sorts before Phase 3's.

## Decisions recorded

- **D-32** (approved 2026-10-04): the Waabek API key is an Admin Dashboard-managed setting, encrypted at rest
  with AES-256-GCM, never returned to the browser, never in logs, audit metadata, error messages or API
  responses, replaced only by authorised Super Admins, every change audited without the key.
  `SETTINGS_ENCRYPTION_KEY` is an infrastructure-only 32-byte key on the API and worker: never in the
  database, never in a browser, never set from the dashboard, required, and the services fail closed without
  it. Supersedes the "key only in `WAABEK_API_KEY`" rule of D-05 and D-22.
- **D-33** (approved 2026-10-05): the first authenticator setup after the WhatsApp code is approved as
  implemented (no additional token); owner-only SQL recovery of the Waabek key when no admin can reach the
  dashboard (`app.open_otp_settings_recovery()`, one-time recovery token, key entered only on `/admin/login` and
  encrypted by the API; no sign-in, no change to admin credentials or authentication state, bootstrap stays
  closed).
- The Phase 3.1 scope is recorded in `docs/DECISIONS.md` and the blueprint. D-29 to D-31 (approved for
  Phase 3) are carried into this branch's decision log.

## What Phase 3.1 adds

| Area | What changed |
| --- | --- |
| Database (`20261004135000_phase3_1_admin_bootstrap.sql`) | `admin_accounts.totp_secret_enc` may be NULL (account created by SQL); a confirmed authenticator must have a secret; only the table owner can replace or remove an existing secret. `app.otp_settings` (one row): encrypted Waabek key, `version` raised by a trigger on every change, cannot be deleted. `app.admin_bootstrap` (one row): SHA-256 of the setup token, expiry, wrong attempts (can only go up for the runtime role), closed for good once closed. `app.open_admin_bootstrap()`: owner-only, returns a 60-minute setup token. D-33: `app.otp_settings_recovery` (one row: SHA-256 of the recovery token, expiry, wrong attempts that only go up for the runtime role) and `app.open_otp_settings_recovery()`: owner-only, only after the bootstrap has closed, returns a 30-minute recovery token; `app.otp_settings.updated_via` records how the key was last set |
| Encryption | New server-only package `@bedo/server-crypto` (AES-256-GCM, base64(iv \| tag \| ciphertext)), now also used for the Phase 2 authenticator secrets (same stored format). The Waabek key is bound to its field with additional authenticated data |
| Configuration | `SETTINGS_ENCRYPTION_KEY` required on API and worker (32 bytes, base64; on the API different from `ADMIN_TOTP_KEY`). The worker refuses to start if `WAABEK_API_KEY` is set |
| API | `GET /v1/admin/bootstrap`, `POST /v1/admin/bootstrap/waabek-key`, `POST /v1/admin/bootstrap/test-message` (setup token); `POST /v1/admin/auth/totp/setup` (first sign-in of an account without an authenticator); `otp/verify` answers `totp_setup_required` for those accounts; `totp/verify` confirms the new secret and closes the setup. Super Admin only: `GET /v1/admin/settings/otp`, `PUT /v1/admin/settings/otp/waabek-key` (needs a current authenticator code), `POST /v1/admin/settings/otp/test-message`. D-33: `GET /v1/admin/otp-recovery`, `POST /v1/admin/otp-recovery/waabek-key`, `POST /v1/admin/otp-recovery/test-message` (recovery token; no session) |
| Worker | `WaabekKeyProvider` reads the key from `app.otp_settings` before every message and decrypts only when it changed; test messages from the dashboard go through the same path |
| Admin Dashboard | *Initial setup* panel on `/admin/login` while the setup is open; authenticator setup step with a QR code (drawn in the page with `qrcode-generator` 2.0.4, MIT, no dependencies) and the setup key; *OTP / WhatsApp* section for Super Admins; *WhatsApp settings recovery* panel on `/admin/login` while the owner has opened a recovery |

## How the worker receives changed settings

The key lives only in Postgres. Before every message (codes and test messages) the worker runs one
single-row query by primary key for `version` and the stored value, and decrypts only when either changed
since its last message; the decrypted key stays in that process's memory. A dashboard change therefore
applies to the next message on every worker instance, with no restart and no message between instances that
could be missed (Redis publish/subscribe was not used for that reason). A cached key is never used without
confirming it is still current. Fail closed: no stored key, or a key that cannot be decrypted (wrong
`SETTINGS_ENCRYPTION_KEY`, damaged value), fails the job at once without retries and records
`otp_delivery_failed` without the key; an unreachable database fails the job and BullMQ retries it later.
Nothing about the key is put in Redis, job data or logs.

## Verification

Run from a fresh unpack of `bedo-chat-phase-3.1.zip` (see the delivery message for the full step list and
results): secret scan, frozen install, lint, typecheck, unit tests, production build, route check, client
bundle check with sentinel values for every server secret including `SETTINGS_ENCRYPTION_KEY`, generated API
client check, migrations on an empty database (apply, re-run, status), all integration tests, dependency
audit, browser tests, and the one-site Netlify build from both Package directories (D-26, D-28).

### New tests

| Where | What it proves |
| --- | --- |
| `packages/server-crypto` | Round trip, fresh IV, wrong key / tampered / truncated / other-purpose values refused, no secret in errors, Phase 2 format still decrypts, 32-byte keys only |
| `packages/config` | `SETTINGS_ENCRYPTION_KEY` required in every environment, 32 bytes, different from `ADMIN_TOTP_KEY` (by key bytes); `WAABEK_API_KEY` refused without echoing it |
| `apps/api/test/admin-bootstrap.integration.test.ts` (31) | Runtime-role limits; setup token (hash only, CSRF, validation without echo, wrong tokens counted also in parallel, lock after 5, expiry, per-IP limit, owner re-issue); key stored encrypted and audited without it; test messages; WhatsApp code then authenticator setup (same secret per attempt, encrypted until confirmed, wrong code, confirmation, closure); setup closed for good; normal sign-in and replay protection afterwards; 5 wrong setup codes end the attempt; later SQL-created admins; Phase 2 accounts unchanged; Super Admin settings view, step-up replacement with replay protection, test messages and limits; moderators refused and audited; no key in any response or history. D-33 (9 tests): runtime role cannot run the recovery function, set or replace the token, lower the counter or delete the row; refused before the bootstrap closes; owner opening stores only the hash and is audited; the recovery token signs nobody in and is not a setup or sign-in token; saving raises the settings version, stores the key encrypted, records `owner_recovery` without the key; test message; admin accounts, authenticator secrets, roles, sessions and the closed bootstrap byte-for-byte unchanged; sign-in still needs WhatsApp code and authenticator; one key per token (a second save, also in parallel, is refused and recorded); lock after 5, expiry, re-issue, per-IP limit |
| `apps/api/test/delivery-failure.test.ts` | Worker failure texts mapped to dashboard reasons; number masking |
| `apps/worker/test/waabek-key.provider.test.ts` | Query before every message, decrypt only on change, fail closed (no key, unreadable key, database down), re-decrypt when the value changes |
| `apps/worker/test/queues.integration.test.ts` (5 new) | Real worker: stored key used, replaced key used from the next message without restart; no key / unreadable key fail at once without retries and are audited; **two worker instances** both use the new key from the next message on; the recovery write raises the version and both instances use the recovered key; dashboard test messages through the same path |
| `packages/e2e/test/admin-bootstrap.e2e.test.ts` (5) | In Chromium: initial setup panel saves the key, WhatsApp code, QR / setup-key authenticator setup, setup no longer offered, OTP settings without the key, replacement with an authenticator code; owner recovery panel saves a new key without signing in |

## Independent security review

A separate reviewer examined the Phase 3.1 changes, including a probe of the runtime database role. No Critical or High findings. Fixed:
the runtime role could lower the wrong-token counter (now refused by the trigger); the "different from
`ADMIN_TOTP_KEY`" check compared text, now key bytes. Its two design points were decided by the owner in
D-33. A second review of the D-33 recovery found no Critical or High issues; its Medium finding (a recovery
token could save more than one key while unexpired) is fixed: each token now saves one key only, enforced by
the database (`key_saved_at`, which the runtime role can set but never clear).

## Phase 1 and Phase 2 files extended (R-02)

- `packages/config/src/index.ts` and its test, `turbo.json`, `.github/workflows/ci.yml` (new server-only
  variable).
- `apps/api/src/admin/*`, `apps/api/src/audit/audit.service.ts` (system actions),
  `apps/api/src/common/all-exceptions.filter.ts` (two error codes), `apps/api/src/queues/queues.service.ts`.
- `apps/worker/src/otp/*`, `apps/worker/src/queue-workers.service.ts`, `apps/worker/src/worker.module.ts`.
- `packages/contracts` (new schemas, error codes, job names), `packages/db/src/database.ts` (types),
  generated API client and OpenAPI document.
- Admin app sign-in page, dashboard navigation, API error texts.
- Test helpers (`integration-env.ts`, `helpers.ts`, e2e `stack.ts`): new key, code jobs filtered by name.
- `README.md`, `docs/DEPLOYMENT.md`, `apps/*/.env.example`.

The Phase 2 `admin:create` command still exists and still works, but nothing requires it.

## Not verified here (part of your real-world test)

- A real Waabek key and a real WhatsApp delivery (tests use fake keys and a stand-in Waabek server).
- Running `app.open_admin_bootstrap()` in the Supabase SQL editor (tested on PostgreSQL 16 as the table
  owner, which is how the Supabase SQL editor runs).
- The deployed API, worker, Netlify site and Cloudflare Worker.

## Open points for the owner

1. Anyone can use up the 5 wrong setup-token or recovery-token attempts (denial of service only); you then run
   the same SQL function again for a new token.
2. A test message that times out is withdrawn from the queue, but if the worker had already started it, it may
   still arrive later.
