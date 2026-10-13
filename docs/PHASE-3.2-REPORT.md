# Phase 3.2 report — Admin password sign-in (D-34)

Admin sign-in is now **phone number + password → authenticator (TOTP) code → admin session**. Admin WhatsApp
codes are gone from the admin flow; student WhatsApp sign-in is unchanged. Phase 3.2 is a separately approved
change on top of Phase 3 (branch `phase-3.2`, built from `phase-3-messaging` 1bc5196). It does not depend on
the API or Cloudflare deployment and changes no infrastructure.

## Decision recorded

**D-34** (approved 2026-10-05) is in `docs/DECISIONS.md` and the Blueprint with the approved wording: TOTP
mandatory for every admin session; WhatsApp OTP removed from admin login; phone number the only admin
identifier; initial password through the owner-only SQL setup token entered on the `/admin/login` Set Password
panel, which never signs in; password reset by owner SQL only; password rules (12–128 characters, no forced
character mix, not the phone number, not on a local built-in common-password list, no network calls);
lockout (5 failures in 15 minutes lock that admin's password login for 15 minutes; 20 attempts per IP per 15
minutes; counted before verification; uniform answers and timing); session handling (a change ends all other
sessions of the account, an owner reset ends all sessions, the current session may stay after a self-service
change, 12-hour absolute / 30-minute idle kept, no rotation); existing TOTP, replay protection, CSRF,
admin-origin checks, authorisation, audit and security controls kept; student OTP, worker/Waabek settings,
D-32, D-33, Phase 1 and unrelated Phase 3.1 functionality unchanged.

## What Phase 3.2 adds

| Area | Change |
| --- | --- |
| Migration `20261005120000_phase3_2_admin_password.sql` | `app.admin_accounts.password_hash` (Argon2id PHC string only, checked by the database) and `password_changed_at` (set by a trigger; the application cannot choose it). `app.admin_password_setup`: one row per admin with the token's SHA-256 hash, expiry, wrong-attempt count, reset flag and used time. A guard trigger lets the runtime role only count wrong tokens upward and mark a token used once. `app.issue_admin_password_setup(admin_phone)`: owner only (revoked from `public`, `bedo_runtime`, `anon`, `authenticated`, `service_role`); returns a one-time 43-character token valid 60 minutes; for an admin who has a password it is a reset that removes the password and ends every session at once; audited without the token |
| API `POST /v1/admin/auth/password/login` | Phone + password → `{status: totp_required \| totp_setup_required, pendingToken}`. Per-IP limit, per-number lock, per-number counter reserved before the check, then exactly one Argon2id verification on every path (a prepared dummy hash for unknown numbers, disabled accounts and accounts without a password). One answer for every failure: 401 `CREDENTIALS_INVALID` "The phone number or password is incorrect." No cookie, no session |
| API `POST /v1/admin/auth/password/setup` | Phone + setup token + new password. Every problem with the number or token (unknown, no token, expired, used, locked, wrong) answers 400 `PASSWORD_SETUP_INVALID`; a wrong token is counted (5 lock it). The rules are checked only after a correct token and a refused password does not use it up (`PASSWORD_IS_PHONE`, `PASSWORD_TOO_COMMON`). Success stores the hash, uses up the token, ends every session of that admin and lifts a sign-in lock. Never signs anyone in. Own per-IP limit |
| API `POST /v1/admin/account/password` | Any signed-in admin: current password + new password + current authenticator code (replay-protected, used up like a sign-in code; the rules are checked first so a refused password does not use the code). Ends every other session of the account, keeps the current one; `{changed: true, otherSessionsEnded}`. 5 attempts per 15 minutes per admin |
| Pending sign-ins | A pending sign-in remembers when the password that started it was set; the authenticator steps refuse it (`SESSION_INVALID`) if the password was changed or reset meanwhile |
| Removed | `POST /v1/admin/auth/otp/request` and `otp/verify` (now 404), their contracts and the generated client functions |
| Password rules | Length counted in characters (`[...value].length`) by the contract; phone-number spellings (E.164, without `+`, `00…`, national, with spaces/dots/dashes/brackets, full-width digits) and the common list (46,146 entries of 12+ characters from SecLists, MIT, `apps/api/assets/`, NFKC + case-insensitive) checked on the server. The API refuses to start if the list is missing |
| Admin UI | `/admin/login`: phone + password, then the existing authenticator steps; *Set password with a setup token* panel (phone, token, new password twice, rules hint, mismatch check); the password field is emptied after every attempt. Dashboard *Account* → *Change password*. New error messages. The Phase 3.1 Initial setup and D-33 recovery panels no longer say admins receive WhatsApp codes (text only) |
| Docs | `docs/DEPLOYMENT.md` sections 4a (first Super Admin with the password step), 4b (wording), new 4c (limits, change, owner reset SQL, setup tokens, audit events, upgrading from 3.1), 6 (checks); README |

## Verification

All on the committed tree, Postgres 16 and Redis 7 local, Node 24:

| Check | Result |
| --- | --- |
| lint, typecheck (17 tasks) | pass |
| unit tests | pass (API 31 incl. new `password-policy.test.ts`; config 19, db 12, contracts 5, ui 4, server-crypto 6, worker 15; scripts) |
| integration tests | pass: db 36, API 150 (incl. 23 new), worker 13 |
| browser end-to-end (real API process, one Netlify site, local edge) | pass: 5 files, 31 tests |
| fresh-unpack harness (`verify-3.sh`: gitleaks, frozen install, lint, typecheck, tests, build, route and bundle checks, client = OpenAPI, migrations from an empty database twice + status, integration, `pnpm audit`, e2e, D-26 / D-31 / D-28 dual-path Netlify builds) | see the delivery message (run on the ZIP itself) |

### New tests

| File | Covers |
| --- | --- |
| `apps/api/test/admin-password.integration.test.ts` (23) | Argon2id hash format and parameters, unique salts, database refuses non-Argon2id values; owner-only function and runtime-role limits (no insert/delete, no expiry or hash change, attempts only upward, `password_changed_at` not writable); length 12–128 in characters, no echo; phone number in every spelling; common passwords; uniform answers (status, body, no cookie) and timing for unknown / no password / disabled / wrong password; unknown numbers lock like admin numbers; lock after 5 even for the right password, `retryAfterSeconds`, audited; 30 parallel guesses → at most 5 checks; success clears the count; 20 per IP, then refused even with the right password, other IPs unaffected; setup endpoint IP limit; setup token one-time, never signs in, expiry 60 minutes, 5 wrong (in parallel) lock it, uniform answers, cross-account token refused, re-issue; owner reset (password removed, all sessions and an in-progress sign-in ended, lock lifted, audited); mandatory TOTP (no session from the password, pending token is no session, setup required for accounts without authenticator, no WhatsApp code); change (wrong current password, replayed code, rules before code, success, other session ended, this one kept, same code refused again, in-progress sign-in with old password refused, old password refused, audit); change open to Moderators, 5 per 15 minutes, needs a session; CSRF header and admin origin on all three routes; no password in any response, audit row, setup row, account row or Redis value |
| `apps/api/test/password-policy.test.ts` (3) | List loaded from disk; case/width/space-insensitive matching; phone spellings, and longer text that merely contains the number is allowed |
| Existing API tests | Admin sign-in switched to password + TOTP everywhere; admin OTP routes answer 404; student budget unaffected by admin sign-in |
| Browser tests | `admin-bootstrap`: no-password answer, Set Password panel (wrong token, short, mismatch, common, phone number, success, not signed in, hash stored, token single-use), sign-in with password then authenticator setup, Account → Change password (wrong current password, code field emptied, success, other session signed out, this one kept, old password refused, new accepted), **no password, token or Waabek key in the real API process's logs (level info)**; `admin-csp`: Set Password and Account screens under the admin CSP without violations; `accounts`, `single-domain`: password sign-in, wrong password message, password field emptied |

## Independent security review

A separate reviewer agent reviewed the implementation read-only (working commit 73d5f02, later squashed; the
final commit adds only the I1 fix, this report and test constants written without a literal password), with
its own probes against a throwaway database.
No Critical or High findings. All requested checks passed (enumeration and timing, lockout and IP limit under
parallel requests, setup-token concurrency and runtime-role privileges, TOTP replay in the change flow,
session ending, pending sign-ins after reset/change, no password leakage, CSRF/origin, no effect on 3.1, D-33
or student OTP).

| Finding | Status |
| --- | --- |
| **M1 (availability)**: the per-number lock also refuses the correct password, so anyone who knows an admin's number can keep that admin's password login locked by sending 5 wrong passwords every 15 minutes; the owner's reset lifts it but it can be re-locked | Not changed: this is the approved D-34 behaviour. Reported below for an owner decision |
| L1: anyone can use up an open setup token with 5 wrong tokens for that number (uniform answer, no leak) | Not changed: by design (D-34 failed-attempt limit); the owner re-issues |
| I1: the first failed sign-in per API process also computed the dummy hash | **Fixed**: the dummy hash is prepared at start-up |
| I2: pending sign-ins compare password times to the millisecond | No change (two changes in one millisecond are not practically possible) |
| I3: setting up an authenticator for an SQL-created account now needs a password that only an owner-issued token can create (closes a Phase 3.1 review note) | Positive |

## Files changed outside the new admin-password code

- Phase 3.1 code: `admin-auth.service.ts` (OTP steps replaced by `startPendingSignIn` and the password binding),
  `admin.controller.ts`, `admin.module.ts`, comments in `admin-bootstrap.service.ts` and
  `otp-recovery.service.ts`, text in `initial-setup.tsx` and `otp-recovery.tsx`, `admin-login.tsx`,
  `dashboard.tsx`, `_lib/api.ts`. Behaviour of the bootstrap, the D-32 settings and D-33 recovery is unchanged.
- Shared: `packages/contracts` (admin schemas, 4 error codes, OpenAPI routes), `packages/db` (types),
  generated API client, `all-exceptions.filter.ts` (messages for the new codes), `apps/api/package.json`
  (ships `assets/`). Phase 1 files are not changed.

## Not verified here (part of your real-world test)

- Nothing is deployed. The migration, the owner SQL and the sign-in were run only against local Postgres and
  Redis and the local stack.

## Open points for the owner

1. **M1 lockout (decision needed only if you want to change D-34).** As approved, the lock is per phone number
   and refuses the correct password. Options if you want it changed: count failures per number *and* source
   address, or let a correct password through during a lock (the authenticator step still protects the
   account). No change has been made.
2. **Existing admins after the upgrade** have no password: before they can sign in again, run
   `select * from app.issue_admin_password_setup('<admin-phone>');` for each and let them set a password
   (DEPLOYMENT.md 4c). Their authenticator apps stay valid.
3. The OTP service still contains the unused `admin_sign_in` purpose value (a database enum shared with the
   student code path). It is unreachable now; it was left in place so the student OTP code stays unchanged.
