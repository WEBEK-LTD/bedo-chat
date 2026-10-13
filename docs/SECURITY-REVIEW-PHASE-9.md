# Security review — Phase 9 (D-43)

An independent review of the whole API, web client, service worker, scheduled function and database grants, done
read-only by a separate reviewer on 2026-10-09 after Phase 8. The reviewer then checked the fixes: two were
incomplete (a forwarded quiz could still show its answer; a member allowed to add people could undo a removal), and
both were completed before this phase was delivered. Every confirmed finding is fixed and covered by
`apps/api/test/hardening.integration.test.ts`.

## Confirmed findings and their fixes

| # | Severity | Finding | Fix | Test |
| --- | --- | --- | --- | --- |
| 1 | High | A forwarded poll shared the original poll row: from a chat of their own, a member (or channel subscriber) could list the original's voters (breaking hidden member lists, §7), close it for everyone (revealing a quiz's answer) and vote into it | Forwarding a poll creates a new poll of the target chat (`PollsService.copy`); every poll action requires the poll to belong to the message's own chat; an **open quiz cannot be forwarded** (a copy would show its answer before the class answered; once closed, the answer is public and it can be) | 1 |
| 2 | Medium-high | `PATCH /v1/groups/{id}/members/{userId}` looked the target up before checking rights: 404 vs 403 told a plain member who is in a group with a hidden list, or a channel subscriber who else subscribed | The needed right is checked first; without it the answer is always 403 `NOT_ALLOWED`. Also (found when checking the fixes): adding people reports every addable person as "added" to a member who may not see the list, so it cannot tell who was already in or who was removed, and the group size check counts only people not yet in | 2 |
| 3 | Medium-high | Reports compared the named user with a message's author before counting the attempt: a channel subscriber could find which admin posted by naming candidates for free | The daily limit is taken first; in a chat where the reporter does not see senders, the named user is ignored and the real author is recorded (same answer for any name) | 3 |
| 4 | Medium-low | Pushes were skipped for blocked senders in channels too, so blocking a suspected admin revealed whether they posted | Blocks no longer filter channel pushes (they still do in private chats and groups) | 4 |
| 5 | Low-medium | Someone removed from a group or channel could come straight back by invite link, join request or public join | `app.chat_bans`: removal bans and declines their pending join request; links, requests and public joins refuse a banned person; only someone with the admin right "invite users" adding them lifts it (a removed person cannot ask again); a member allowed to add people cannot bring them back, and is not told who was removed | 5 |
| 6 | Low-medium | Several actions had no rate limit, and reactions and poll votes in channels wrote an update entry for every subscriber | Limits added: group/channel picture changes and uploads, poll closing, deleting messages, scheduled-message changes and "send now", file links (300/min), profile lookups, in-chat search, the viewing report (120/min). In channels, reactions and votes reach the actor and the staff at once; subscribers see the counts when the post is next loaded | 7, 8 |
| 7 | Low | Retrying a send or forward with a used client id returned the message without checking the person is still in the chat | Retries check membership first (404 otherwise) | 6 |

## Checked and found fine (summary of the review)

Membership checks on every chat route (and `deleted_at`); hidden and deleted messages excluded everywhere (history,
search, pins, previews, unread counts, badges, file links, replies, forwards); channel masking (sender, sender in
replies, search by sender, typing, pushes, forwards); the §7 database functions (security definer, fixed
`search_path`, execute revoked from public); membership events only to those allowed to see the list; scheduled
messages visible and changeable only by their author, with permissions checked again when sent; the dispatch endpoint
(HMAC, constant-time, 404 otherwise); no string-built SQL, escaped `LIKE` patterns, bounded inputs and pages; client
addresses only from Netlify's header; sessions checked on every request, rotating refresh tokens with reuse
detection, CSRF on every cookie-authenticated route; admin session timeouts and roles; one-time code and password
attempt limits; push endpoints limited to browser push services; the service worker opening only same-site paths
outside `/admin`; access tokens kept in memory only; GIF previews signed and limited to GIPHY.

Tests per finding: 1 (copies, closing, votes, open quizzes), 2 (groups, channels, adding people), 3, 4, 5 (links,
requests, public join, a member adding, pending requests), 6 (send and forward retries), 7 (reactions and poll votes
in channels), 8 (two of the new limits; the others use the same limiter).

A route-wide sweep (test 9) also checks that every one of the API's user routes refuses requests with no token, a
tampered token, an unsigned (`alg: none`) token or the wrong scheme, that admin routes refuse user tokens, and that
the dispatch route answers 404 without its token.

## Reviewed and kept (with the reason)

| Item | Decision |
| --- | --- |
| The realtime token is a Supabase token for the `authenticated` role | Only the device's own private channel is allowed by the `realtime.messages` policy; the `app` schema is closed to that role, there are no tables in `public`, and storage has no policies (private buckets). Re-checked in Phase 13 against the live project |
| The student app and the Admin Dashboard share one origin (D-25, D-36) | An injected script in the student app could call admin routes. The strict Content-Security-Policy (D-31, `apps/web/csp.mjs` and `proxy.ts`) with per-request nonces is the barrier; neither app's source contains `dangerouslySetInnerHTML`, `innerHTML` or `eval` (checked during the fixes and by the reviewer's re-check) |
| Upload content types | Media files are checked by their first bytes and served from Supabase's storage domain, never the site's |
| The 20-second refresh grace window | Kept: it lets two tabs refresh at once without ending the session; reuse after it ends the session (P-02) |
| Polls forwarded before Phase 9 | They would still show the original's results (they can no longer act on it). None exist: nothing has been deployed yet |
| Broad table grants to the runtime role (`delete` on `app.files`, all columns of `app.users` and `app.sessions`) | A trigger already refuses deleting or changing a file once it is part of the history; column-level grants for users and sessions are left for Phase 13's database review |
| An admin with "manage admins" can change other admins, including the one who promoted them | Telegram's model; the owner can always change everyone and the history records each change |
