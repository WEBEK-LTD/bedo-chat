# Phase 13 report — launch as a website (D-46)

Built on Phase 10.1 (branch `phase-13`). Decision: **D-46** in `docs/DECISIONS.md`. The owner postponed the mobile
and desktop apps (Phase 12): Bedo Chat launches as a website first. Exit gate: **the website is ready to go live**
— installable, usable on a phone, notifications with nothing to configure, the database rights narrowed, and a load
test at the academy's size and above.

## What changed for people

- **Install on a phone or computer.** The site now has a web app manifest and icons: iPhone (Safari → Share → Add to
  Home Screen), Android (Chrome → Install app) and desktop Chrome/Edge (Install) put Bedo Chat on the Home Screen or
  in the app list, and it opens full screen like an app. On iPhone and iPad this is also what lets notifications
  arrive (iOS 16.4+).
- **Notifications work out of the box.** Settings → Notifications → Turn on notifications works on every deployment;
  before, it said "Notifications are not available yet" until three keys were generated and added to Netlify.
- **Phone screens.** Every main screen was checked at iPhone size (sign-in, chats, a chat, message actions, new
  group, group chat, settings, privacy, notifications, devices; the Admin Dashboard's sign-in, overview, users,
  groups and channels, reports, broadcasts). Fixes: message action menus stay inside the screen (they could run off
  the right edge); the Admin Dashboard's sections are behind a menu button on a phone (they were squeezed into one
  row); its lists and headings fit a phone width.

## Data (migration `20261017120000_phase13_launch.sql`)

- `app.push_keys`: the site's Web Push key pair, one row, made by the API on first use and never changed. The
  private key is stored only encrypted (SETTINGS_ENCRYPTION_KEY). Two instances starting together keep one pair.
- Database rights (from the Phase 9 review): the API's role may update only the account columns it changes (phone,
  name, username, bio, photo, status, deletion time) and the session columns it changes (tokens, device, address,
  activity, expiry, ending). An account's id and creation time, and a session's id, owner, platform and start, can
  no longer be changed by the application.

`docs/owner-sql/apply-updates.sql` now applies migrations 7–17 (Phase 13 checks included).

## Load test

`apps/api/test/load.integration.test.ts` (opt-in: `LOAD_TEST=1`). Six API instances (as Netlify runs several function
instances, each with 3 database connections) share one Postgres; 50 requests are in flight at all times. Times in
milliseconds, on the test machine with the database next to the API (production adds the Netlify–Supabase round
trips, both in Sydney, to each request).

| What | Requests | Failed | p50 | p95 | Max | Per second |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 200 students in 20 groups, 10 messages each | 2,000 | 0 | 328 | 607 | 755 | 148 |
| Chat list (200 students opening the app) | 200 | 0 | 221 | 308 | 324 | 217 |
| Catch-up from the start (sync) | 200 | 0 | 396 | 554 | 603 | 120 |
| Open a group's history | 200 | 0 | 189 | 234 | 249 | 260 |
| Search everywhere ("homework", 2,000 messages) | 100 | 0 | 193 | 227 | 244 | 243 |
| Online heartbeat | 200 | 0 | 86 | 126 | 152 | 548 |
| Channel post to 1,000 subscribers (one at a time) | 5 | 0 | 64 | 83 | 83 | — |

With 50 requests always waiting, most of each time is the queue (50 at once ÷ ~150 a second ≈ 330 ms); a single
message takes about 60 ms here. An academy of a few hundred students sends far fewer than 148 messages a second,
and every request succeeded. The Phase 6 question (a channel post to many subscribers) and the Phase 8 question
(whether search needs its own engine) are answered: not at this size. Signals and notifications to subscribers go
out after the response, so the poster does not wait for them.

## Tests

| Suite | What it proves |
| --- | --- |
| `apps/api/test/launch.integration.test.ts` (3) | One key pair made on first use even by two instances at once, stored encrypted, valid for a push service, never changed or removed by the application; the VAPID variables still win when all three are set; the runtime role cannot change account or session ids, owners, platforms or creation times, and can still do what the API does |
| `apps/api/test/load.integration.test.ts` (opt-in) | The numbers above |
| `packages/e2e/test/launch.e2e.test.ts` (3) | In a phone-sized browser: the manifest, icons and Home Screen tags are served; every main screen fits without sideways scrolling; an open message menu stays on screen; the Admin Dashboard's menu button |
| `scripts/csp.test.mjs` (updated) | The manifest and icons are static files, outside the page proxy |
| Every earlier suite | Passes |

## Not in this phase

- The mobile and desktop apps (Phase 12) are postponed (D-46); the website installs on phones instead.
- Checks that need the live site (the Supabase realtime policy against the live project, real phones receiving
  notifications) are in the go-live steps, `docs/DEPLOYMENT.md` section 0.
- The temporary release-age exemptions for `next`, `source-map-js` and `sharp` can be removed after 2026-10-14
  (nothing breaks on that date; it returns them to the normal 14-day rule).

## Phase 13.1 — the site's variables from the SQL Editor

On the first go-live the site's function logs said "Invalid environment configuration: DATABASE_URL ... is
required": the Netlify site had no server variables, and the five secret values had no documented way to be made
without a terminal. `docs/owner-sql/netlify-variables.sql` now makes them in the Supabase SQL Editor: it gives
`bedo_api` a new random password and shows the nine lines to import into Netlify (only the three Supabase keys are
copied by hand). It refuses, changing nothing, once the site has stored secrets encrypted with its keys (an admin's
authenticator, the Waabek, GIPHY or Web Push keys), since new keys could not read them. Tested in
`apps/api/test/netlify-variables.integration.test.ts` (the new password works, every value passes the API's own
checks, a second run makes new values, the refusal leaves the old password working). `docs/DEPLOYMENT.md` section 0,
step 3, uses it.
