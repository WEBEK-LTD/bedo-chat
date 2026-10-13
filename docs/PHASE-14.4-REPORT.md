# Phase 14.4 report — faster sending, opening from the browser

Built on Phase 14.3 (branch `phase-14-4-speed`). The owner reported that sending and receiving take seconds, and
asked that the browser keep the data so the site does not load from the beginning.

## Why sending is slow

The website's server functions run in Netlify's default region, US East (Ohio); the database is in Sydney. Every
database step crosses the Pacific (about a quarter of a second there and back), and a message needed about 25 of
them, one after the other: about five seconds. Opening a new server instance also has to connect to the database
across that distance. The real fix is running the server functions in Sydney (Netlify → Cloud compute → Functions →
Region, a Pro plan feature, then a new deploy). This phase also needs fewer steps.

## What changed

- **Fewer database steps per message (25 → 17, of which the reply waits for 15).** A text, sticker or poll message
  no longer checks for a retry before sending (the retry is recognised inside the send itself) or checks the chat
  twice; the message id is made in the API (same time-ordered format as the database's); the per-user update log
  is written in one statement instead of four. Files and GIFs keep the early checks. Sync reads its counter and its
  entries at the same time.
- **Speed check in the Admin Dashboard (Overview).** It shows where the website's server runs and where the
  database is, and how long one database step takes, with the fix when they are far apart.
  `GET /v1/admin/speed-check` returns region names and a number only.
- **The site opens from this browser.** The signed-in account is kept with the local chat cache, so on the next
  visit the chat list and messages show at once while the session is checked with the server in the background.
  If the session has ended (signed out elsewhere, blocked), the app signs out and erases everything it kept, as
  before. Offline, it shows what it has.
- **Pictures are kept in the browser.** Profile photos, stickers and photo previews are kept after their first
  download (up to 3,000, oldest out first) and shown again without the network; sticker grids load a picture only
  when it comes into view. Storage links change on every visit, so pictures are kept under the stored object's
  address. Signing out erases them.

## Checks

- `apps/api/test/uuid-v7.test.ts`: the ids carry the time and the version and variant bits like `app.uuid_v7()`.
- `admin-console.integration.test.ts`: the speed check reports the regions and a round trip, and shows nothing secret.
- All integration tests pass with the shorter send and the single-statement update log (retries, duplicates,
  groups, channels, broadcasts, scheduled messages).
- New `packages/e2e/test/browser-cache.e2e.test.ts`: a picture is shown again with storage unreachable; the chat list
  shows before the session check answers and messages arrive after; a session ended elsewhere still signs out and
  erases the kept account and pictures.
- Typecheck, lint, unit, integration and all browser tests pass.

## For the owner

No SQL. Upload with GitHub Desktop. To make sending fast: Netlify → this site → Cloud compute → Functions → Region →
Asia Pacific (Sydney) → Save, then Deploys → Trigger deploy. The Overview's speed check then turns green.
