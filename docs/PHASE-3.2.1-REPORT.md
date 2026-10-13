# Phase 3.2.1 report — Admin password with one SQL script (D-35)

The owner can now make an admin usable from the Supabase SQL Editor with ONE script: paste
`docs/owner-sql/set-super-admin.sql`, change `input_phone`, `input_name` and `input_password` at the top, Run.
The account becomes an active `super_admin` with that password. Sign-in is unchanged: phone + password, then the
mandatory authenticator code (D-34). Built on Phase 3.2 (branch `phase-3.2.1` from `phase-3.2` 8bee5a2).

## Decision recorded

**D-35** (approved 2026-10-06), in `docs/DECISIONS.md` and the Blueprint: one owner SQL script with the three
inputs; the database cannot produce the API's Argon2id hash, so the script stores a temporary bcrypt hash
(pgcrypto, cost 12, of the password's base64 SHA-256) that the API accepts and replaces with its normal Argon2id
hash at the first successful sign-in, after checking the full D-34 rules (a password that breaks one is refused
like a wrong password). The script ends every session of the admin, closes any unused setup token, records the
change without the password and never touches the authenticator. Accepted trade-offs: the password is typed into
the SQL Editor (delete the saved query afterwards); until the first sign-in, checking that account's password
takes about 250 ms instead of about 11 ms. Amends D-34 decisions 4 and 5; the setup token and owner reset remain.

## Changes

| Change | What |
| --- | --- |
| Migration `20261006120000_d35_admin_password_owner_sql.sql` | `app.admin_accounts.password_hash` CHECK: Argon2id as before, or exactly `^\$2a\$12\$[./A-Za-z0-9]{53}$` (pgcrypto bcrypt, cost 12). Nothing else |
| `docs/owner-sql/set-super-admin.sql` | The owner script. Runs only as `postgres`; checks phone (international form), name (1–64), password (12–128 characters, not the placeholder, not the phone number in any spelling); hashes with `extensions.crypt(encode(extensions.digest(convert_to(password,'UTF8'),'sha256'),'base64'), extensions.gen_salt('bf',12))`; creates or updates the admin (`super_admin`, `active`); ends its sessions; closes an unused setup token; writes `admin.password_set` (audit log) and `admin_password_set` (security history) without the password; shows the admin. One `DO` block: all or nothing |
| `apps/api/src/admin/owner-sql-hash.ts` (new) | Recognises the exact owner-SQL form and verifies it with `@node-rs/bcrypt` against the same SHA-256 pre-hash |
| `apps/api/src/admin/admin-password.service.ts` | Sign-in and change-password verify Argon2id or the owner-SQL form. After a correct password with the owner-SQL form, the full D-34 rules are checked (length, phone number, common-password list); a violation is refused as `CREDENTIALS_INVALID` (reason only in the security history, `admin_password_upgrade_refused`); otherwise the hash is replaced with Argon2id (compare-and-set on the checked hash) and recorded (`admin_password_upgraded`, `admin.password_hash_upgraded`). Unknown, disabled and password-less accounts still take one dummy Argon2id check |
| `apps/api/package.json`, `pnpm-lock.yaml` | `@node-rs/bcrypt` ^1.10.9 (same family as `@node-rs/argon2`; prebuilt binaries, no install script) |
| Docs | `docs/DEPLOYMENT.md` new section 4d (and pointers in 4c), README, D-35 |
| `pnpm-workspace.yaml`, `pnpm-lock.yaml` (security) | A high advisory published after Phase 3.2, GHSA-68fv-2mgg-jv7q in `source-map-js` < 1.2.2, made `pnpm audit` fail (also on the delivered Phase 3.2 ZIP). It is reached only through development tools (`vite > postcss`). Override to `^1.2.2`, which is 6 days old, so it is exempted from the 14-day release-age rule until 2026-10-14, recorded under "Security exceptions" in `docs/DECISIONS.md` as the policy requires |

Unchanged: Phase 1, the frontend, contracts/OpenAPI, the setup-token flow, student sign-in, worker, Netlify and
the Cloudflare Worker.

## Verification

| Check | Result |
| --- | --- |
| lint, typecheck (17 tasks) | pass |
| unit tests | pass: API 31, worker 15, config 19, db 12, server-crypto 6, contracts 5, ui 4; scripts 32 |
| integration tests (Postgres + Redis, runtime role) | pass: db 36, API 161 (11 new), worker 13 |
| browser end-to-end (real API process, one Netlify site, local edge) | pass: 6 files, 33 tests (2 new) |
| fresh-unpack harness on the ZIP (gitleaks, frozen install, lint, typecheck, tests, build, route and bundle checks, client = OpenAPI, migrations from an empty database twice + status, integration, `pnpm audit`, e2e, D-26 / D-31 / D-28 dual-path Netlify builds) | see the delivery message |

### New tests

| File | Covers |
| --- | --- |
| `apps/api/test/admin-owner-sql.integration.test.ts` (11) | Migration applied from an empty database; CHECK allows only Argon2id or the exact `$2a$12$` form (refuses other costs, `$2b$`, extra characters, plain text, `$argon2i$`). Script refusals: placeholder, short, 129 characters, phone without `+`, empty name, phone number as password in five spellings, non-owner — nothing written. New admin: active `super_admin`, `$2a$12$` hash, no authenticator, audit row; wrong password `CREDENTIALS_INVALID`; password alone gives no session (authenticator setup required). First successful sign-in upgrades to Argon2id `m=19456,t=2,p=1`, recorded once; later sign-ins unchanged. Password change afterwards. Apostrophes (typed twice), non-ASCII, and a 107-character password that differs only after 72 bytes. Existing admin: role/status/name/password updated in place (no duplicate), authenticator kept, 2 live sessions ended, a sign-in in progress refused, an open setup token closed and refused, audit with before/after; old password refused; new password then a wrong code (`TOTP_INVALID`) then the right code → Super Admin session; hash upgraded. Re-running the script ends a live dashboard session. Common password refused at first sign-in like a wrong one, not upgraded, reason recorded; the owner sets another and it works. D-34 setup-token passwords stay Argon2id and are never "upgraded". No password in audit log, security history, setup rows, Redis or any response |
| `packages/e2e/test/admin-owner-sql.e2e.test.ts` (2) | In a real browser: a common password set by SQL is refused at sign-in with the normal message; the right password signs in only after authenticator setup (no cookie before), the dashboard opens as Super Admin, the hash becomes Argon2id; the password is not in the API's logs |
| Existing D-34 tests | All pass unchanged (`admin-password`, `admin`, `admin-bootstrap`, `security`, `single-domain` integration; `admin-bootstrap`, `admin-csp`, `accounts`, `single-domain` browser) |

## Independent security review

A separate reviewer agent reviewed the change read-only (commit eca7e48, later squashed; the final commit adds
the fixes below, this report and the Blueprint/decision wording), with its own probes against real pgcrypto. No
Critical, High or Medium findings; compatibility (UTF-8, quotes, >72 bytes, normalisation), no session without
TOTP, no new runtime-role capability, the upgrade compare-and-set, lockout counting, enumeration, session and
pending-sign-in invalidation, leakage, script safety and D-34/student regressions all checked.

| Finding | Status |
| --- | --- |
| L1: a correct but rule-breaking password got `PASSWORD_TOO_COMMON`, confirming a guessed password | **Fixed**: refused as `CREDENTIALS_INVALID`; reason only in the security history |
| L2: the script cannot lift a Redis sign-in lock on the number | Documented in the script header and DEPLOYMENT 4d (the lock ends by itself within 15 minutes) |
| I1: the final result row was "most recently updated admin" | **Fixed**: selected by the exact phone the script used (transaction-local setting) |
| I2: apostrophes must be typed twice | Documented in the script header and DEPLOYMENT 4d (an unescaped one makes the whole script fail; nothing is applied) |
| I3: timing until the first sign-in | The accepted D-35 trade-off |

## Open point

The existing `next` / `@next/*` release-age exemption says "Remove after 2026-10-06" (today). It is unrelated
to this change and left as it is; removing it (returning `next` to a caret range) is a separate step.

## Not verified here

Nothing is deployed and the live Supabase database was not changed. On your project the order is: apply
migration `20261006120000_d35_admin_password_owner_sql.sql`, then run the script; signing in needs the API.

## Applying the migration on your project (SQL Editor, as for Phase 3.2)

`docs/owner-sql/apply-20261006120000.sql`: safety checks (runs as `postgres`; `app_meta.schema_migrations`
holds exactly migrations 1–6 with their checksums; the Phase 3.2 check is unchanged; not applied yet), the
migration file word for word (SHA-256 `ce35f75dc26b4277f010930fb95a29994ff2a5bc2ccaa91970c3e6349bdb7961`), a check
of the result, then the bookkeeping row. One request, one transaction. Tested on a database brought to Phase 3.2
exactly the way yours was (migrations 1–5 pasted, bookkeeping recorded, Phase 3.2 applied with the earlier
script): the owner script is refused before it and works after it; a second run refuses; a Phase 3.1-only
database refuses; a forced failure keeps nothing; the migration runner then reports 7 applied, 0 pending; the
schema is identical to a database built entirely by the migration runner.
