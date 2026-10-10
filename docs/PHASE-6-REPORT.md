# Phase 6 report — channels and scheduled messages (D-40)

Built on Phase 5 (branch `phase-6`), on the D-36 architecture (everything in the one Netlify site; Supabase for the
database, storage and realtime; no worker). Decisions: **D-40** in `docs/DECISIONS.md` (O-22, and the blueprint's
channels and scheduled posts), taken from the blueprint's recommendations under the owner's instruction of 2026-10-09.

## What people can do

| Feature | How it works |
| --- | --- |
| Create a channel | The megaphone button next to search (only for people an admin allowed to "create channels", O-21; 5 per day): a name, an optional description, **public** or **private**. The creator is the owner |
| Public channels (O-22) | Typing two or more letters in the chat list search also shows **Public channels** with their subscriber count and a **Join** button. A private channel never appears there; it is joined only with an invite link (`?join=`) |
| Reading a channel | Subscribers read, react, forward, search, see shared media and pins, mute, and leave from Channel info. The composer is replaced by **Mute / Unmute**. Posts appear as from the channel: subscribers never learn which admin posted, who else subscribed (only how many), or who is typing |
| Posting | The owner and admins with the new right **Post messages** post text, files, voice and video messages, stickers, GIFs and polls. Admins without it can still pin, invite, approve requests or remove subscribers, as their rights say |
| Channel info | Picture, name, description, public / private switch (owner or admins who may change info), subscribers (owner and admins only), invite links, join requests, admins and their rights, leave, delete |
| Forwarding a post | The copy says "Forwarded from <channel>", never the admin's name |
| Schedule a message | The clock button next to Send (for channel admins who may post, in their channels; anywhere else for people an admin allowed to "schedule messages", O-21): "In 1 hour", "This evening at 20:00", "Tomorrow at 09:00", or any date and time up to a year ahead. Text, and files with a caption, can be scheduled |
| Scheduled messages | A clock button with the count appears in the composer; the list (also in the chat menu) shows each message's time and content: **Send now**, **Change time**, **Delete**. One that could not be sent stays as **Not sent** with the reason (for example "You can no longer post here") |

## Sending on time without a worker

1. **Scheduled function.** `apps/web/netlify/functions/scheduler.mts` runs every minute on the published production
   deploy (`[functions] directory` in both `netlify.toml` copies). It sends `POST /api/v1/internal/dispatch` with
   the header `x-bedo-dispatch` = HMAC-SHA256(`ACCESS_TOKEN_SECRET`, "bedo scheduled dispatch v1"), compared in
   constant time. Without the right header the route answers 404.
2. **Ordinary requests.** Every API request also checks, at most every 5 seconds per server instance and after the
   response, whether something is due, so a message usually goes out within seconds; at most about a minute late
   when nobody uses the site.
3. **Exactly once.** Due rows are claimed with `for update skip locked` and sent with the client id stored when they
   were scheduled, which the message table refuses to use twice; a run that stopped half-way is claimed again after
   two minutes. Temporary failures are retried up to 5 times; a refusal (no longer allowed, chat gone, replied
   message deleted) marks the entry failed at once.
4. **Same checks as sending.** The API sends as the author through the normal send path: membership, the right to
   post this kind of message, blocks and privacy are checked at that moment. Files are checked (size and type) and
   kept when scheduled, and GIFs copied then, so nothing outside can fail later.

## Data (migration `20261012120000_phase6_channels.sql`)

| Object | Purpose |
| --- | --- |
| `app.conversations` | Type `channel`; `is_public` (channels only); a title for every group and channel |
| `app.conversation_members` | Role `subscriber`; admin right `post_messages` |
| `app.messages.forward_from_chat_id` | A forwarded channel post names the channel (never together with a user origin) |
| `app.can_view_members` | Now also for channels: list for the owner and admins, count for everyone in it |
| `app.scheduled_messages` | Author, session, client id, time, what to send (JSON, checked when scheduled), status (pending, sending, sent, cancelled, failed), attempts, reason, the message sent. Never deleted; the runtime role cannot delete it |
| Index on public channel titles | Trigram index for the public channel search |

`docs/owner-sql/apply-updates.sql` is regenerated: it now applies migrations 7–12 (Phase 6 checks included).

## API

New: `POST /v1/channels`, `GET /v1/channels/search?q=`, `POST /v1/channels/{id}/join`,
`POST`/`GET /v1/chats/{id}/scheduled`, `PATCH`/`DELETE /v1/scheduled/{id}`, `POST /v1/scheduled/{id}/send`,
`POST /v1/internal/dispatch` (scheduled function only). Channels are managed with the groups' endpoints
(`/v1/groups/{id}/...`); `PATCH /v1/groups/{id}/settings` accepts `isPublic` for channels. Changed: chats may be of type
`channel`, carry `scheduledCount`, and their `group` has `public`; roles include `subscriber`; admin rights include
`post_messages`; invite previews carry `type`; forward origins carry `kind` (`user` or `channel`); new update kind
`scheduled`. Typing is never relayed in channels.

## Tests

| Suite | What it proves |
| --- | --- |
| `apps/api/test/channels.integration.test.ts` (6) | Creating needs the permission; the owner's rights and posting permissions; groups never get the posting right; public search and join (twice is a no-op), private channels neither found nor joinable; subscribers cannot post, upload, list subscribers (also refused by the database function) or change settings; group-only settings refused; posts masked for subscribers (no owner id anywhere in the view) but not for the owner; subscribers react; forwarding shows the channel; going private hides it; admins post only with the right, rights and restrictions of the other chat type refused, demotion back to subscriber, removal, membership history; a scheduled post: idempotent scheduling, author-only list, nothing early, wrong or missing dispatch token = 404, two dispatch runs at once send it once, subscribers see it as from the channel, `sent` with the message id, a `scheduled` update, a used client id refused; the system permission outside channels, time limits, edit, send now, delete, and a block before it was due making it **failed** with `CANNOT_MESSAGE` and nothing sent; a scheduled photo checked and kept when scheduled (cannot be sent elsewhere meanwhile) and sent when due |
| `packages/e2e/test/channels.e2e.test.ts` (4) | In Chromium: creating a public channel and posting; a student finding it in search, joining, reading without a composer and without the teacher's name anywhere on the page; scheduling a post in the browser (date and time picker), the list, and the site sending it by itself on ordinary requests once due; no CSP violation |
| `scripts/checks.test.mjs` | Both `netlify.toml` copies deploy the functions folder; the scheduler runs every minute, calls the dispatch route with the header, uses the same purpose string as the API, and contains no secret |
| Updated | Owner SQL (Phase 6 checks), OpenAPI (every new route), the generated client, forward-origin expectations in the messaging suite; every earlier suite passes |

## Not done in Phase 6 (and why)

| Item | Reason |
| --- | --- |
| Channel discussion groups and comments under posts | Not in the specification |
| Post view counts and "signed" posts | Not in the specification; posts show no author to subscribers by design (D-40) |
| Admin Dashboard "Channels" area | Phase 10 (remaining §22 areas) |
| Notifications for new posts | Phase 7 (muting already works) |
| Scheduling stickers, GIFs and polls from the web app | The API accepts them; the web app schedules text and files (the common case) |
| Files of deleted scheduled messages | Stay stored (ready, never shown); housekeeping of such files can follow in Phase 9 |

## Known limits

- A post in a channel with 5,000 subscribers writes 5,000 update-log entries and signals every online device; fine at
  the academy's size, revisited in Phase 13 load tests.
- Scheduled functions run on the published production deploy only (Netlify); deploy previews rely on ordinary requests.
