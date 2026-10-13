# Phase 10.1 report — no calls (D-45)

Built on Phase 10 (branch `phase-10.1`). Decision: **D-45** in `docs/DECISIONS.md`.

The owner decided on 2026-10-10 that Bedo Chat has **no voice or video calls**. Phase 11 (calls with LiveKit) is
removed from the plan: no LiveKit account, no call service, nothing to configure. O-08 and O-26 are closed.

## What changed

- Settings → Privacy no longer shows "Who can call me". The API no longer returns or accepts `callsFrom`
  (`GET`/`PATCH /v1/me/privacy`); the OpenAPI document and the typed client are regenerated.
- The database is unchanged: the column `app.user_privacy.calls_from` stays, unused, so there is no SQL to run.
- Voice messages (Phase 4) are messages, not calls, and stay as they are.

## Tests

| Suite | What it proves |
| --- | --- |
| `apps/api/test/auth.integration.test.ts` (updated) | The privacy settings have four entries; a request that sets `callsFrom` is refused (400) |
| Every earlier suite | Passes unchanged |

## Next

Phase 12: the mobile and desktop apps (needs the Apple and Google developer accounts for store releases).
