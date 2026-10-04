# Phase 3 report — Messaging core

Phase 3 makes private one-to-one messaging work end to end in the web app (blueprint steps 3.1–3.10,
decisions D-29 to D-31, parameters P-16 to P-31). It was built and verified from a fresh unpack of the
delivered ZIP on 2026-10-04. Everything below ran locally against real Postgres 16 and Redis 7; the real
Supabase, Redis, API host, Cloudflare and Netlify have **not** been exercised (see "Not verified here").
Phase 4 has not been started.

## What Phase 3 adds

| Step | Delivered |
| --- | --- |
| 3.1 Schema | Migration `20261004140000_phase3_messaging.sql`: conversations (one table with a type; `private` only for now), members with one read and one delivered position each, messages partitioned by month (time-ordered UUIDv7 ids, so a message's month follows from its id), idempotency keys, deleted-for-me, pinned messages, per-user chat state (pinned, archived, marked unread), folders, blocks, reports, the per-user update log and its counters, last seen; `audit.message_revisions` and `audit.screenshot_events`; full-text and trigram indexes |
| 3.2 Permissions | `PermissionService`, the one service HTTP routes, the realtime gateway and user search ask: membership (a chat you are not in looks exactly like one that does not exist), account status, blocks, "Who can message", deleted accounts; what another user's view may show (photo, phone, last seen and online) |
| 3.3 Messages | Send with a client-generated id (a retry never stores a duplicate), edit and delete for both sides without a time limit (O-27), delete for me, reply, forward (up to 100 messages to up to 10 chats, "Forwarded from" the original sender), pin and unpin; each change, its audit record and its update-log entries in one transaction |
| 3.4 Sync | `GET /v1/sync?since=` returns everything after a device's last update with the current state of the chats and messages involved; a device more than 1,000 updates behind, or behind the 30-day log, is told to re-fetch (chat list, then 50 messages per page) |
| 3.5 Realtime | WebSocket gateway at `/v1/realtime` (`wss://bedochat.com/api/v1/realtime`): edge secret and web-app origin checked at the handshake, access token in the first message, heartbeat every 25 s, online for 60 s per heartbeat, Redis fan-out between API instances, delivered acknowledgements, typing (6 s), presence and last seen to the minute |
| 3.6 Chat list | Pinned chats (up to 5), archived chats (stay archived when messages arrive), unread counts, mark as read and as unread, folders (up to 10, names of 1–12 characters, chats chosen by hand) |
| 3.7 In-chat search | Whole words (full text) and parts of words (trigrams) within one chat; never other chats, messages deleted for both sides or messages hidden for the searcher |
| 3.8 Safety | Block and unblock, reports on users and messages (stored permanently, no review screen until Phase 10), screenshot event intake for iOS and Android sessions only |
| 3.9 Worker | Monthly message partitions kept three months ahead (at start-up and hourly); update-log entries and idempotency keys older than 30 days removed in batches |
| 3.10 Web app | The chat interface inside `/`: chat list with folder tabs and archive, people search to start a chat, chat view with history paging, composer, replies, edits, message actions, multi-select (up to 100), share (share sheet, else copy), statuses (sending, sent, delivered, seen, failed with retry), typing and presence, pinned messages, in-chat search, block and report, local cache in IndexedDB. Strict Content-Security-Policy for the web app and the Admin Dashboard (D-31). Still exactly two routes: `/login` and `/` |

## Decisions applied

| Decision | Where it is enforced |
| --- | --- |
| Messages 30 per minute per user, edits counted (D-30) | `MessagingLimitsService.messages`; send, edit and forward. Every forwarded copy counts (forwarding N messages to T chats costs N × T); see "Points for the owner" |
| Reports 20 per day per user (D-30) | `MessagingLimitsService.reports` |
| P-16 text 1–4,096 characters | Contract (counted in Unicode characters, surrounding spaces removed) and a database check |
| P-17 update log 30 days; >1,000 behind → re-fetch; 50 per page | `SyncService`, worker pruning, `MessagingStore.fullFetch` in the web app |
| P-18 heartbeat 25 s, online 60 s, typing 6 s, last seen to the minute | Web realtime client, `PresenceService`, `lastSeenToMinute` |
| P-19 5 pinned chats, archived stays archived; mute in Phase 7 | `ChatsService.setState` (locked per user); nothing unarchives on new messages; no mute |
| P-20 unread counts, mark as read / unread | Chat summaries, `POST /v1/chats/{id}/read`, `PATCH .../state` |
| P-21 10 folders, names 1–12, manual only | `FoldersService` (locked per user), contracts |
| P-22 either participant pins, visible to both | `MessagesService.setPinned` |
| P-23 forward to 10 chats, "Forwarded from" (Deleted account), multi-select 100 | Contracts, `ViewsService.messages`, web multi-select |
| P-24 share sheet, else copy | `shareText` in the web chat view |
| P-25 name or username, 3+ characters, phone only if Everyone | `UsersService.search`; not the Phase 8 global search |
| P-26 Nobody blocks new chats and messages; history readable; block and Nobody give the same "You can't message this user"; deleted accounts read-only; suspended or banned cannot send | `PermissionService.sendDecision`, error code `CANNOT_MESSAGE` |
| P-27 four reasons, text up to 500, permanent, no admin screen | `SafetyService.report`; `app.reports` refuses update, delete and truncate |
| P-28 screenshot intake from iOS and Android only; the web app never sends | `SafetyService.screenshot` checks the session's platform; the web app has no screenshot code (browser test checks no event exists) |
| P-29 only the sender deletes for both sides; anyone deletes for themselves | `MessagesService.delete` |
| P-30 the blocker cannot send until unblocking | `USER_BLOCKED`; the web chat shows "You blocked this user." and Unblock |
| P-31 last seen Nobody hides online too | `PermissionService.visibilities` (one flag for both) |
| O-23, O-27, O-28 | Existing neutral tokens and Material Symbols only (24 symbols added); no time limits; web only |
| D-31 CSP | See "Content-Security-Policy" |

## Message history protection (D-17)

- Every edit, delete for me and delete for both sides writes `audit.message_revisions` (previous text, new
  text for edits, who, which session, when) in the same transaction as the change.
- The database itself refuses, at commit, a change of a message's text or deletion state without the matching
  revision row in the same transaction (deferred constraint triggers that compare the previous and new text),
  and a "deleted for me" without its revision. A message deleted for both sides can never change again.
- The runtime role has no DELETE on messages, hidden messages or reports, and triggers refuse it anyway; it
  can update only a message's text and deletion columns; audit tables are insert and read only, with update,
  delete and truncate refused by triggers; the monthly partitions are not accessible directly.
- Integration tests prove each of these as the runtime role (including a forged revision row).

## Content-Security-Policy (D-31)

| Pages | Policy |
| --- | --- |
| Student web app (`/`, `/login`, not-found) | Set per response by `apps/web/proxy.ts` (Next.js proxy, run by Netlify as an edge function before the pages) with a fresh nonce: `default-src 'none'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…'; img-src 'self' data: blob: <storage>; font-src 'self'; connect-src 'self' https://bedochat.com wss://bedochat.com <storage>; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests`. `<storage>` is exactly `NEXT_PUBLIC_STORAGE_ORIGIN` (the Supabase project URL, for profile pictures), or nothing when it is not set |
| Admin Dashboard (`/admin`, `/admin/*`) | Fixed in both `netlify.toml` files (D-28, identical): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'` |

How it works without weakening it: the web app's pages are now rendered per request so Next.js can put the
nonce on its scripts; the Admin Dashboard's static pages carry no inline scripts (the bundling step moves
Next.js's two small inline scripts per page into content-hashed files and fails the build if a page ever holds
inline styles, handlers or scripts it cannot move); both apps got a "not found" page without inline styles;
Zod is told not to probe for `eval` in browsers. No `unsafe-inline`, no `unsafe-eval` (except under
`next dev`), no wildcard. Browser tests run every Phase 2 and Phase 3 flow under these policies and record
every `securitypolicyviolation` event: none.

## Verification from a fresh unpack of the ZIP

Run by `verify.sh` from a fresh unpack, in this order (all on 2026-10-04):

| Step | Result |
| --- | --- |
| ZIP contents: no `.env`, build output or `node_modules` | Pass |
| Secret scan (gitleaks) of the unpacked source | Pass, no leaks |
| Clean install, frozen lockfile, install scripts blocked | Pass |
| Lint, typecheck | Pass (15 of 15 tasks each) |
| Unit tests | Pass: 105 tests (api 26, worker 9, config 17, db 12, contracts 5, ui 4, root scripts 32) |
| Production build, web route check (`/`, `/login` only) | Pass; routes `/` and `/login` only (source and build) |
| Client bundle check with sentinel values for every server secret | Pass: no server-only name or value in the web or admin client files |
| Generated API client matches the OpenAPI document | Pass |
| Migrations on an empty database (all three earlier ones plus Phase 3), re-run no-op, status | Pass: 4 applied (`20261004000000_baseline`, `20261004120000_phase2_accounts`, `20261004130000_d24_phone_list_removal`, `20261004140000_phase3_messaging`); re-run applies nothing; status 4 applied, 0 pending |
| Integration tests (Postgres + Redis, runtime role) | Pass: 140 tests (api 96, db 36, worker 8) |
| Dependency audit (`pnpm audit`) | Pass: no known vulnerabilities |
| Browser end-to-end tests (Chromium, local edge + one-site stand-in) | Pass: 22 tests (Phase 2: 16, Phase 3: 6), no CSP violation |
| Netlify build, Package directory `apps/web` (fresh unpack, `netlify build --offline`) + D-26 and D-31 artifact checks | Pass: build completes, the CSP proxy is bundled as an edge function whose route excludes `/admin`, `/api`, static files and `/sw.js`; the deploy config sends the admin policy for `/admin` and `/admin/*`; no admin page holds an inline script; every D-26 check passes |
| Netlify build, Package directory `apps/admin` (D-28) + D-26 and D-31 artifact checks; same static files as from `apps/web` | Pass: the same checks; the same static files as from `apps/web` (moved admin scripts carry the build id in their names, so they are compared by count) |

### Test inventory

| Suite | Tests |
| --- | --- |
| API unit (`apps/api`) | 26 |
| API integration: auth 26, admin 14, security 11, single domain 6, photo 5, ready 3, **messaging 23**, **realtime 8** | 96 |
| Worker unit / integration (**+2 Phase 3 maintenance tests**) | 9 / 8 |
| Database unit / integration | 12 / 36 |
| Config, contracts, UI | 17, 5, 4 |
| Root scripts (`scripts/*.test.mjs`, **CSP 6 new**) | 32 |
| Browser (Chromium): Phase 2 accounts and single domain 16, **Phase 3 messaging 6** | 22 |

New in Phase 3:

- `apps/api/test/messaging.integration.test.ts`: chats and visibility, idempotent sends (in parallel too),
  length limits in characters, history paging, replies, statuses and unread, edits and deletions with their
  audit rows, 100-message selection limit, the runtime role refused at every attempt to rewrite history,
  forwarding (original sender, all-or-nothing, cost per copy, over-limit answer), pins, in-chat search,
  pinned-chat and folder limits, archive, block versus Nobody with identical answers, privacy of photo, phone,
  last seen and online, deleted and suspended accounts, reports and their limit, screenshot intake by
  platform, user search, the message rate limit with edits, sync and re-fetch.
- `apps/api/test/realtime.integration.test.ts`: handshake checks (path, origin, edge secret), token
  authentication, delivery to every device of both users, catch-up after a disconnect, typing and presence
  with blocks and privacy, delivery stopping at once when a session ends, connection caps.
- `apps/worker/test/queues.integration.test.ts`: partitions ahead, pruning without touching messages.
- `packages/e2e/test/messaging.e2e.test.ts`: CSP headers and zero violations, starting a chat by name,
  live delivery to three browsers, seen status, typing, a closed browser catching up from its cache and sync,
  edits and deletions on every device with the history in the database, block with the neutral answer, no
  screenshot events from the web.
- `scripts/csp.test.mjs`: both policies, the storage origin rule, the proxy matcher, moving admin inline
  scripts.

## Independent review

A separate reviewer examined Phase 3 in three rounds (the code, then each set of fixes), with its own probes
against real Postgres and Redis.

| Finding | Severity | Status |
| --- | --- | --- |
| Forwarding was charged per destination chat, allowing about 100 × the message rate | High | Fixed: every copy counts; a forward larger than a whole minute's budget is refused with `LIMIT_REACHED` instead of "try again"; the web forward dialog shows the budget |
| A revoked session kept receiving realtime messages until its next heartbeat (≤ 25–70 s) | High | Fixed: session checked before every sync read, before typing and delivered and before short-lived events (each with a session check at most 2 s old), plus a 5-second sweep; a test proves a message sent after revocation never arrives |
| Block and "Nobody" distinguishable through photo, last seen and phone search | Medium | Phone search made consistent; the remaining difference follows the blueprint's block rule. **Owner decision**, below |
| No connection limits on the gateway | Medium | Fixed: 10 connections per account per instance, 20 unauthenticated per client address (IPv6 per /64), lower message rate per connection |
| Web CSP allowed every Supabase project | Medium | Fixed: exactly `NEXT_PUBLIC_STORAGE_ORIGIN` |
| Edit revision did not have to match the new text | Low | Fixed in the database trigger |
| Pin, block and people search had no limits | Low | Fixed with guards (below) |
| Text limit counted UTF-16 units, not characters | Low | Fixed |
| Local cache could be written again just after sign-out | Low | Fixed |
| Sending depends on the worker creating partitions | Low | Fixed: the API creates a missing partition and retries |

Checked as correct by the reviewer: membership on every chat and message path, hidden and deleted messages
on every read path (history, search, pins, last message, unread, sync, forward sources, reply previews),
history protection, privacy rules, gateway handshake, idempotency and lock order, parameterised SQL, the
proxy matcher and the Netlify edge function, scope (no Phase 4 or excluded feature).

## Security and secret handling

- No new secret. New public build variable: `NEXT_PUBLIC_STORAGE_ORIGIN`. The Waabek key and every server
  secret remain absent from client bundles (sentinel check) and from the repository (gitleaks).
- The realtime token travels in the first WebSocket message, never in a URL or log.
- gitleaks: the unpacked ZIP has no findings. The repository history (not part of the ZIP) shows only two
  fixed test values from earlier phases (`scripts/cloudflare-worker.test.mjs`, `packages/config/src/index.test.ts`),
  which are not secrets; Phase 3 tests generate their edge secret at random.
- The local cache (IndexedDB) holds one account's recent chats and messages only and is erased whenever the
  session ends (sign-out, session ended, account blocked or deleted) and when another account signs in.

## Phase 1 and Phase 2 files extended (R-02)

The seven extensions identified in the plan, plus the small wiring they need:

| Extension | Files |
| --- | --- |
| 1. Web chat interface | `apps/web/app/_components/chat-shell.tsx` (the empty list became the chat list and chat view; settings, alerts and deletion notice unchanged), `apps/web/app/_lib/api.ts` (bearer token for the messaging routes, realtime token, messages for the new error codes), `apps/web/app/_lib/session.tsx` (cache erased when the session ends) |
| 2. Other users' profiles | `apps/api/src/auth/accounts.service.ts`: `toPublicUser` takes `photoVisible` (default unchanged) |
| 3. Contracts and API client | `packages/contracts` (`common.ts` three error codes, `index.ts`, `openapi.ts` 26 routes, `queues.ts` two job names), `packages/api-client/src/generated.ts` (regenerated), `apps/api/openapi/openapi.json` |
| 4. Worker jobs | `apps/worker/src/maintenance/maintenance.processor.ts`, `apps/worker/src/queue-workers.service.ts` |
| 5. Browser tests | New `packages/e2e/test/messaging.e2e.test.ts`; the local stack already passed WebSocket upgrades through |
| 6. Deployment notes | `docs/DEPLOYMENT.md` (realtime, worker, CSP, `NEXT_PUBLIC_STORAGE_ORIGIN`, checks) |
| 7. Content-Security-Policy | `apps/web/netlify.toml` and `apps/admin/netlify.toml` (same CSP lines in both, D-28 kept), `apps/web/app/layout.tsx` (rendered per request), `apps/web/next.config.ts` (storage origin check), new `apps/web/app/not-found.tsx` and `apps/admin/app/not-found.tsx`, `scripts/bundle-admin-into-web.mjs` (moves admin inline scripts), `scripts/one-netlify-site.test.mjs` (expected admin headers) |
| Wiring | `apps/api/src/app.module.ts` (MessagingModule), `apps/api/src/auth/auth.module.ts` (exports TokenService and UserAuthGuard), `apps/api/src/auth/user-auth.guard.ts` (its checks split into `authenticate` and `checkSession` for the gateway; HTTP behaviour unchanged), `apps/api/src/audit/audit.service.ts` (two writers), `apps/api/src/common/all-exceptions.filter.ts` (messages for the new codes), `packages/db/src/database.ts` (types), `packages/ui` (24 Material Symbols), `apps/api/package.json` (`ws` 8.21.3, older than 14 days) |

Unchanged: D-26 and D-28 (one Netlify site, identical configuration files), the Cloudflare Worker and DNS,
the routes `/login` and `/`.

## Implementation limits and choices

Values the decisions did not fix, chosen to be safe and listed here for your review:

| Item | Value |
| --- | --- |
| Sync page | 200 updates per response (the device asks again while `hasMore`) |
| In-chat search | 1–100 characters, 20 results per page |
| Chat list | All of a user's chats in one response; unread counts shown up to 999+ |
| Chats per folder | 200 |
| Reply preview | First 200 characters |
| Screenshot intake guard | 60 events per hour per user |
| Pin, unpin, block, unblock | 60 per minute per user (each notifies the other person) |
| People search | 60 searches per minute per user; deleted accounts and oneself never found; `@username` accepted |
| Realtime | Authenticate within 10 s; 10 connections per account per API instance; 20 not-yet-authenticated per client address; 20-message burst, 10 per second per connection; 16 KB per message; typing relayed at most every 2 s per chat (the app sends every 3 s while typing) |
| Presence | Chat partners are told when someone comes online or goes offline (where privacy allows); an open chat refreshes the other person every minute |
| Delivered | "Delivered" when any device of the recipient acknowledges; reading also counts as delivered |
| A new chat | Appears for the other person with its first message |
| Recipients | Messages to suspended or banned accounts are accepted (they read them if restored); deleted accounts receive nothing |
| Edits and pins | Need the right to send now (refused after a block or "Nobody"), so a blocked person cannot change what the blocker sees; deleting stays possible |
| Idempotency keys | Kept 30 days, like the update log |
| Partitions | Created three months ahead by the worker; the API creates a missing month if the worker was down |
| Local cache | Chat list, folders, the newest 50 messages per chat and the outbox; it gives a fast start and keeps chats readable when the connection drops. Opening the app while offline still shows the sign-in screen, because restoring the session (Phase 2) needs the network |

## Points for the owner

1. **Forwarding and the rate limit.** D-30 counts edits with messages; this build also counts every forwarded
   copy, so one forward can carry at most 30 copies a minute (for example 30 messages to one chat, or 3
   messages to 10 chats), although P-23 lets you select 100 messages. If you want larger forwards, approve a
   separate forward budget (for example "a forward counts once per destination chat") and it is a one-line
   change.
2. **Block versus "Nobody" (P-26 and the blueprint's block rule).** The send answer is identical, but a
   blocked person also stops seeing the blocker's photo, phone, last seen and online status (blueprint:
   "Other controls"), while "Nobody" for messages hides none of those. Someone who watches the profile before
   and after can therefore guess a block. Options: (a) keep this (as Telegram does) or (b) let a block affect
   messaging only. Please choose; (b) is a small change.
3. **Editing after a block or "Nobody"** is refused (stricter than "no new messages"). Say if edits should stay
   allowed.
4. **Last seen "Nobody" and live signals.** With last-seen privacy Nobody, online status is hidden (P-31), but
   the other person can still notice someone is active from "delivered" and "seen" statuses and the typing
   indicator, which those features need. Accepted unless you decide otherwise.
5. **`NEXT_PUBLIC_STORAGE_ORIGIN`** must be set in the Netlify site's environment variables (the Supabase
   project URL) when profile pictures are used, or pictures will not load under the new policy.

## Not verified here (part of your real-world test)

- The real Netlify runtime of the CSP proxy: Netlify's build tooling builds it into an edge function whose
  route excludes `/admin`, `/api` and static files (checked from both Package directories), but the edge
  runtime itself needs Netlify's servers. After deploying, check that `/` and `/login` answer with a
  `Content-Security-Policy` header containing a nonce, `/admin` and `/admin/login` with the fixed admin policy,
  and that the browser console shows no CSP errors.
- WebSocket upgrades through the real Cloudflare Worker and your API host (idle timeouts, load balancer), and
  several API instances sharing your managed Redis's pub/sub.
- The migration on your Supabase project (partition creation by the `postgres` role, the security-definer
  function, `xid8` triggers), and the worker's jobs there.
- Profile pictures under the CSP with your real storage origin.
- Presence and last seen across API restarts and Cloudflare's connection limits; reconnect behaviour on
  mobile browsers.

## Phase 4 — remaining scope (not started)

From the blueprint ("Phased delivery"), Phase 4 Media: uploads and downloads with progress (resumable,
private storage, signed URLs checked by the permission service); previews per type (images, videos, PDF,
Word and PowerPoint, ZIP and other files, audio); voice messages and video messages; the chat media panel;
emojis (platform set), GIFs, stickers and reactions; deleted files kept in the private audit bucket.
Acceptance: every file type in §4 sends, previews and deletes correctly. Decisions to settle before it
starts: O-09 GIF source, O-10 sticker source, O-11 Word and PowerPoint previews, O-12 size and length limits,
O-30 malware scanning of uploads.
