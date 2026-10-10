# Phase 10 report — Admin Dashboard (D-44)

Built on Phase 9 (branch `phase-10`). Decision: **D-44** in `docs/DECISIONS.md` (O-18 and O-20 decided with the
blueprint recommendations). Exit gate: **the rest of spec §22 in the Admin Dashboard**, every action checked on the
server and written to the admin history, with integration and browser tests.

## What changed for admins

The dashboard now opens on an **Overview** and has six new areas (the Phase 2–5 areas are unchanged):

| Area | Every admin | Super Admin only |
| --- | --- | --- |
| Overview | Counts: accounts by status, online now, active in 24 hours, messages in 24 hours and 7 days, groups, channels, scheduled messages waiting, open reports, deletion requests, signed-in devices, devices with notifications. No content. | — |
| Users | Search by phone, name or username; account, permissions, devices, counts and account history; **suspend**, **reactivate** a suspended account, **end all sessions** | **Ban**, lift a ban, **delete the account** (identity kept in the history, D-14) |
| Groups and channels | List and search, details, settings, admins and members | **Create** (a user owns it), change name, description, public or private (channels), member permissions and member privacy (groups); **add** and **remove** people (removal is a ban, D-43); make admin with chosen rights, restrict, **transfer ownership**; **delete** |
| Reports | The reported message only (as reported, and as it is now), who reported whom and why, other reports about the same person. Decide once: **dismiss**, **remove the message for everyone**, **suspend the user** | **Ban the user** |
| Audit history | — | Message edits and deletions, identity changes, membership, account, security, screenshot and admin events, for a named person or chat, with a **reason**; every view is recorded first |
| Broadcast notifications | — | A notification to **everyone** or to the members of **one group or channel** (O-20), with the history of what was sent and to how many devices |

Every change asks for a reason (kept in the admin history) and a second click. Suspending or banning ends every
session at once and tells the person's devices; their app shows "This account is blocked. Contact the academy."

**O-18 (what admins may read):** a report shows the reported message and nothing else from the chat; the group and
channel pages never show messages. Reading anything more is the audit history: Super Admins only, for a named
person or chat, with a recorded reason.

**O-20 (broadcasts):** a Web Push notification on signed-in devices that allow notifications, not a chat message.
With no worker (D-36) it is sent in batches of 200 devices: right after the admin sends it, then on each run of the
scheduled function until every device is reached; each device gets it once even if two runs overlap.

## For students

Nothing new to learn. A message removed after a report shows as "This message was deleted." for everyone; a group
an admin creates or adds them to appears at once.

## Data (migration `20261016120000_phase10_admin.sql`)

- `app.report_decisions`: one decision per report, append-only (dismissed, message removed, user suspended or banned,
  with the admin and an optional note).
- `app.broadcasts`: what was sent, to whom (everyone or one chat), how far delivery got, how many devices.
- `app.messages.removed_by_admin`: a message removed after a report is recorded as removed by that admin (with its
  revision in the message history, as for any deletion).
- `app.chat_bans.banned_by_admin`: removals by an admin.
- Account events `suspended`, `banned`, `reactivated`; the session end reason `ended_by_admin`.

`docs/owner-sql/apply-updates.sql` is regenerated: it now applies migrations 7–16 (Phase 10 checks included).

## API

18 admin routes under `/v1/admin` (`stats`, `users`, `users/{id}`, `users/{id}/action`, `chats` and its members,
`reports`, `reports/{id}/decision`, `audit`, `broadcasts`), all in the OpenAPI document and the typed client. The
role is checked on the server for every route and action; a Moderator's refused attempt is recorded (Phase 2).

## Tests

| Suite | What it proves |
| --- | --- |
| `apps/api/test/admin-console.integration.test.ts` (5) | Search and account details; suspend (sessions end, 403 `ACCOUNT_BLOCKED`), reactivate, end sessions, ban and lift a ban, delete (number off the list, identity in the history), with the role limits; groups and channels created for a user, settings, admins, restrictions, owner transfer, removal (ban by the admin), deletion, no messages in any answer; reports showing only the reported message, removal for everyone with its revision, a single decision (409 for a second one); the audit history (Super Admin, reason required, every view recorded); broadcasts to everyone and to one channel, and 450 devices in three batches, each once; statistics |
| `packages/e2e/test/admin-console.e2e.test.ts` (5) | In a browser: a student reports a message, the admin sees only that message and removes it (gone on both students' screens); a group created for a student appears on their devices, a member removed and banned; suspending signs the student out, reactivating lets them back; a broadcast is sent; the audit history shows the removal by name with the recorded view; a Moderator does not see the Super Admin areas or actions |
| Updated | The dashboard opens on the Overview (sign-in tests); every earlier suite passes |

## Not in this phase

- The mobile and desktop apps (Phase 12) are still to come. Calls are out of scope (D-45).
- Broadcasts reach browsers with notifications turned on; phones get them through the apps in Phase 12.
