# Phase 9 report — security hardening (D-43)

Built on Phase 8 (branch `phase-9`). Decision: **D-43** in `docs/DECISIONS.md`. Exit gate: **security review
findings closed** — see `docs/SECURITY-REVIEW-PHASE-9.md` (7 confirmed findings, all fixed and tested; reviewed items
kept with their reasons).

## What changed for people

- Forwarding a poll now forwards a new poll: the copy has its own votes; voters and results of the original stay
  where they were. A quiz can be forwarded once it is closed (before, the copy would give away the answer).
- Someone removed from a group or channel cannot rejoin by link, by request or (public channels) by Join until an
  admin who may invite users adds them again; a member who may add people cannot bring them back.
- In channels, a reaction or vote shows at once for the person and the channel's admins; other subscribers see the
  new counts when they next open the post.
- New limits on a few actions (generous for normal use): changing a group picture, stopping polls, deleting
  messages, changing scheduled messages, opening files (300 a minute), looking up profiles, searching inside a chat.

## Data (migration `20261015120000_phase9_hardening.sql`)

`app.chat_bans` (who was removed from which group or channel, by whom, when). The runtime role may add and remove
rows, never change them. `docs/owner-sql/apply-updates.sql` now applies migrations 7–15.

## Tests

| Suite | What it proves |
| --- | --- |
| `apps/api/test/hardening.integration.test.ts` (9) | One test per review finding, including the gaps the reviewer found when checking the fixes, plus a sweep over every route in the OpenAPI document: user routes refuse no token, tampered, unsigned (`alg: none`) and wrong-scheme tokens (401); admin routes refuse user tokens; the dispatch route needs its token (404) |
| Updated | Owner SQL (Phase 9 check); every earlier suite passes |

## Session and token tests already in place (reviewed)

Access token required on every account route; refresh rotation and reuse detection (also after several rotations
and under parallel requests); refresh and logout refused without CSRF or from another origin; logout and "end
session" take effect at once; suspended and banned accounts stopped on existing sessions; 2-Step password and
authenticator guess limits under parallel requests; admin sessions with idle and absolute timeouts.
