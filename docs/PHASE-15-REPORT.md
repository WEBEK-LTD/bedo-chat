# Phase 15 report — sender pictures, join approval, country picker (D-51)

Built on Phase 14.5 (branch `phase-15-groups-login`). Decision: **D-51**. No database change.

## What changed for people

- **Who sent it, with their picture.** In private chats and groups, the sender's picture (or their coloured initials)
  is shown next to their messages, once under each run of messages in a row. One's own messages and channel posts
  have none.
- **Joining through a link needs approval unless the admin says otherwise.** Group (and channel) info → Invite
  links → New link: "Admins approve each person who joins" is on; turned off, anyone with the link joins at once.
  Each link has the same switch, so a link can be changed without sending a new one. Someone who opens an approval
  link presses "Ask to join"; admins who may approve see "N people asked to join" at the top of the chat, open it and
  accept or decline. Every such admin's count updates when one of them decides.
- **Channels** where only admins post, and adding people to them, were already there (Phase 6): a user allowed to
  create channels (Admin Dashboard → User permissions) uses "New channel", or a Super Admin uses Admin Dashboard →
  Groups and channels → New group or channel → Channel and adds the subscribers.
- **Phone numbers with a country picker** on the sign-in page, Change phone number, and every phone field in the
  Admin Dashboard (sign-in, phone list, 2-Step reset, user permissions, password setup):
  - a flag and calling code button, Australia first, then the last country chosen on that browser;
  - a search by country name (accents ignored, common other names such as "Turkey" or "UAE") or by code ("90",
    "+90");
  - the person types only the rest of the number; "0532 123 45 67" with Türkiye chosen becomes +905321234567;
  - typing or pasting a whole international number ("+61 412 345 678") switches the country by itself.
  The server, and so WhatsApp (Waabek), always receive the full international number.

- **A blocked account keeps its explanation.** When an account is suspended or banned while it is open, the server
  ends the session at once; a reload of that tab still says "This account is blocked" instead of a plain sign-in
  page (the reason is kept in that tab only, and forgotten at the next sign-in). This also made a browser test that
  sometimes failed (depending on whether the live sign-out or the reload came first) reliable.

## Where it lives

- `packages/ui/src/phone.ts` (country list, search, building the full number with libphonenumber-js) and
  `PhoneField.tsx`, shared by both apps; `apps/web/public/flags/` (245 flags, 64 x 48 WebP, 135 KB in all, from
  flag-icons, MIT — notice in `packages/ui/THIRD_PARTY_NOTICES.md`); the site's request handler skips them.
- `PATCH /v1/groups/{id}/invites/{linkId}` (`requiresApproval`), for admins with the invite right.

## Checks

- `packages/ui/src/phone.test.ts`: country code added and national 0 dropped (Türkiye, Australia, Egypt), full
  numbers kept, search by name, code and other names.
- `groups.integration.test.ts`: switching approval on a link keeps it the same; a member cannot; joining then
  becomes a request; the owner's waiting count goes up and down; a revoked link cannot be switched.
- `groups.e2e.test.ts`: a new link has approval on; the joiner asks to join; the owner sees "1 person asked to
  join", approves, and the joiner gets the group.
- New `phase15.e2e.test.ts`: Australia first with its flag; Türkiye found by "tur" and by "+90"; "0532 123 45 67"
  reaches WhatsApp as +905321234567; a pasted "+61 …" switches to Australia; the sender's picture shows once under a
  run of their messages and never on one's own.
- Typecheck, lint, unit, integration and all browser tests pass.

## For the owner

No SQL. Upload the repository with GitHub Desktop.

## Phase 15.1 — channels for everyone (D-52)

The owner asked that the channels the admin makes show for every student, including new accounts, without adding
anyone by hand; groups stay as they are.

- Migration `20261020120000_everyone_channels.sql`: `app.group_settings.academy_wide`. Channels already made in the
  Admin Dashboard (recorded as `channel.created` by an admin) are switched on.
- `apps/api/src/groups/everyone-channels.ts`: one statement adds every active account missing from an academy-wide
  channel as a subscriber, with the membership history (`details.everyone`); not people who left or were removed, and
  never past the channel's subscriber limit. Used when an admin makes the channel or turns the switch on, when an
  account is created, and on the site's minute call (catches up on accounts active again and the channels switched on
  by the update).
- Admin Dashboard → Groups and channels: "Everyone in the academy" on a new channel (on by default; the subscriber
  picker is not needed then) and in a channel's settings; the list and the channel say "Channel for everyone".
- API: `everyone` in the admin chat create, update and read bodies (super admin only, channels only).
- Owner SQL: `docs/owner-sql/update-20261020120000.sql`. Every update script now also says what to choose if
  Supabase asks about row level security (what turned it on for the monitoring tables).

Checks: new `everyone-channels.integration.test.ts` (made with everyone in it; a new account joins at once; leavers
and removed people stay out; an account active again joins on the minute call; off and on again; plain channels and
groups untouched, a group cannot have it); `admin-console.e2e.test.ts` makes a channel for everyone in the dashboard
and a student who was never added sees it. Typecheck, lint, unit, integration and all browser tests pass.

For the owner: run `docs/owner-sql/update-20261020120000.sql` once in the Supabase SQL Editor, then upload the
repository with GitHub Desktop.

## Phase 15.2 — channels for everyone without waiting for the scheduler

On the live site the channel switched on by the database update did not show for students. Joining no longer
depends on the scheduled function alone: the whole chat list (`GET /v1/chats`) first adds the account to every
channel for everyone it is missing from, and every server instance catches up on all of them at most once a minute
while requests come in (next to the scheduled messages check). Each join is announced in the update log, so the
person's other devices show the channel too. Test: a channel switched on directly in the database shows in a
student's chat list at once, and their other devices are told.
