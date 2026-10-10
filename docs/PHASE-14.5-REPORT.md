# Phase 14.5 report — site monitoring in the Admin Dashboard (D-50)

Built on Phase 14.4 (branch `phase-14-5-monitoring`). Decision: **D-50**. The owner asked for monitoring inside the
Admin Dashboard, built in, with no outside service.

## How it works

- **The minute check.** The site's scheduled function (Phase 6, sends scheduled messages) already calls the site
  through its public address every minute. Each call that gets through now also records a check in
  `app.site_checks`: how long one database step takes and, every 5 minutes, whether file storage answers (a lookup
  of an object that never exists, signed with the server key). The server's region is kept with each check.
- **Incidents** (`app.site_incidents`):
  - **Site not reachable** — no check for more than 3 minutes; recorded when checks return, with start, end and length.
  - **File storage failing** — two failed storage checks in a row; closed when storage answers.
  - **WhatsApp codes failing** — 3 or more sign-in codes not delivered within 15 minutes; closed when none fail.
  - **Database slow** — one step over 1.5 seconds; closed under 0.5 seconds.
- **WhatsApp alerts.** Every active Super Admin gets a WhatsApp message (the academy's Waabek key) when an incident
  opens and when it is fixed; an outage message says from when to when and how long. On by default; a Super Admin
  can turn it off (`app.monitoring_settings`). While the whole site is down nothing inside it can send a message, so
  that alert arrives the moment the site is back.
- **Admin Dashboard → Site monitoring** (every admin): the status (up, problem, no check for N minutes, starting
  soon), uptime for 24 hours, 7 days and 30 days, the database step (last and 24-hour average), file storage, sign-in
  codes not delivered in 24 hours, a 24-hour timeline in 10-minute bars, the incidents, "Check now", and the WhatsApp
  alerts switch (Super Admins). The page refreshes every minute.
- Housekeeping keeps checks 30 days and finished incidents 180 days.

## Data (migration `20261019120000_site_monitoring.sql`)

`app.site_checks`, `app.site_incidents` (one open incident per kind), `app.monitoring_settings` (one row). The API's
role may add and remove checks, add incidents and update only their end, detail and alert times, and change only
the alerts switch. For the live project: `docs/owner-sql/update-20261019120000.sql`.

## Checks

- `apps/api/test/monitoring.integration.test.ts` (7 tests): before the first check; a check per minute call with
  the database time and storage; a gap becomes an outage with a WhatsApp alert to the Super Admin; storage failing
  twice opens an incident and the fix closes it, both told; failing WhatsApp codes open an incident; every admin can
  check now, only a Super Admin can turn alerts off, and with alerts off nothing is sent; the minute call needs the
  scheduler's token; checks older than 30 days are removed.
- `packages/e2e/test/monitoring.e2e.test.ts`: the dashboard page through the real site, from "starting soon" to up,
  an outage as an incident told on WhatsApp, and "Check now".
- Typecheck, lint, unit, integration and all browser tests pass.

## For the owner

1. Supabase → SQL Editor → paste `docs/owner-sql/update-20261019120000.sql` → Run (every line says "ok").
2. Upload the repository with GitHub Desktop; Netlify publishes it.
3. Admin Dashboard → Site monitoring: within a minute it shows "Bedo Chat is up".
