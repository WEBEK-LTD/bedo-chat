# Phase 5 report — groups (D-39)

Built on Phase 4 (branch `phase-5`), on the D-36 architecture (everything in the one Netlify site; Supabase for the
database, storage and realtime). Decisions: **D-39** in `docs/DECISIONS.md` (O-02, O-03, O-04, O-21, and the group
size from O-12), taken from the blueprint's recommendations under the owner's instruction of 2026-10-09.

## What a student can do

| Feature | How it works |
| --- | --- |
| Create a group | "New group" (next to search): a name, an optional description, people found by name or username. The creator is the owner. Needs the system permission "create groups" (on unless an admin turns it off); 10 per day |
| Group chat | Everything from private chats works in groups: replies, forwards, edits, deletions, pins, reactions, files, voice and video messages, stickers, GIFs, search, folders, archive. Messages show the sender's name |
| @mentions and #hashtags | `@username` of a member is highlighted for them (and will notify them from Phase 7); a `#hashtag` is a button that searches the chat for it |
| Polls and quizzes | The chart button: a question, 2–10 options, anonymous or public, one or several answers, or a quiz with one right answer and an explanation. Results appear after voting (or when the poll is stopped); a quiz answer is final; a regular vote can be taken back; the creator or an admin who may delete messages stops it; voters of public polls can be listed (not by normal members when the member list is hidden) |
| Group info | Header or menu → Group info: picture, name, description (editable with the right), members with Owner / Admin labels and actions, invite links, join requests, what members can do, member privacy, leave, delete |
| Admins and rights | The owner (and admins with "manage admins") make admins with chosen rights, edit or dismiss them; an admin gives only rights they hold. "Make owner" hands the group over |
| Restrictions | Admins who may restrict take permissions away from one member for 1 hour, 1 day, 1 week or until lifted; the member sees why they cannot send |
| Member privacy (§7) | Two switches: hide the member list, hide the member count. A normal member then sees "Group" instead of a count, "The admins keep the member list private", nobody's join or leave, and "someone is typing" |
| Invite links | `https://bedochat.com/?join=<code>`: plain or "needs admin approval", with optional expiry and use limit; copy and revoke. Opening a link while signed out remembers it until after sign-in; the preview shows the name, picture, description and the count only if the group shows it to members |
| Join requests | Approve or decline in Group info; the count shows for admins who may approve |
| Leave, remove, delete | Leaving drops the group from every device; the owner first makes someone else owner (or deletes the group). Removed members lose the chat at once. Deleting keeps the history |
| Mute | Chat menu or chat list: 1 hour, 8 hours, until turned on; a muted icon in the list (push follows in Phase 7) |

## Admin Dashboard

New section **User permissions**: look a student up by phone number and see (every admin) or change (Super Admins)
"create groups", "create channels" and "schedule messages" (O-21). Each change is in the admin history with before and
after.

## Member privacy enforcement (§7)

1. **One policy function** (`PermissionService.canViewMembers`): owner and admins always; members only when the
   group does not hide the list (or the count).
2. **Response shapes**: a group as a member sees it has `memberCount: null`, `canViewMembers: false`, `settings: null`,
   `pendingRequests: null` when hidden; the member list and voters endpoints refuse with `NOT_ALLOWED`.
3. **Database functions**: the member list and count are read only through `app.group_members(viewer, group, …)` and
   `app.group_member_count(viewer, group)`, which check the caller's role themselves and raise an error otherwise
   (tested directly as the runtime role). Internal permission checks still read membership rows directly.
4. **Events**: membership changes (`chat.members`) go only to members allowed to see the list; read positions in
   groups go only to the reader's own devices; typing carries no user id for members who may not see the list.
5. **Contract test**: `groups.integration.test.ts` collects everything a normal member can fetch about a private
   group (chat, chat list, history, sync, pins, media, invite preview, poll results, realtime signals) after joins,
   leaves, promotions and votes, and fails if the id or name of any member who never sent a message appears; the
   browser test checks the same on screen.

## Data (migration `20261011120000_phase5_groups.sql`)

| Object | Purpose |
| --- | --- |
| `app.conversations` | Type `group`; title, description, picture, `deleted_at` |
| `app.conversation_members` | Role, admin rights, denied permissions and until when; one owner per group |
| `app.group_settings` | Default member permissions, the two privacy switches |
| `app.invite_links`, `app.join_requests` | Links (code, name, expiry, use limit, approval, revoked) and requests |
| `app.polls`, `app.poll_votes`, `app.messages.poll_id` | Polls and quizzes; messages of kind `poll` |
| `app.message_mentions` | Members mentioned in a message |
| `app.user_chat_state.muted_until` | Mute per user and chat |
| `app.user_permissions` | O-21 system permissions |
| `audit.membership_events` | Permanent membership history: created, joined, added, left, removed, restricted, unrestricted, promoted, demoted, rights changed, ownership given and received, requests approved and declined |
| `app.can_view_members`, `app.group_members`, `app.group_member_count` | §7 database functions (security definer, runtime role only) |

`docs/owner-sql/apply-updates.sql` is regenerated: it now applies migrations 7–11.

## API

New: `POST /v1/groups`, `PATCH`/`DELETE /v1/groups/{id}`, `PATCH /v1/groups/{id}/settings`, group picture upload,
confirm and removal, `GET`/`POST /v1/groups/{id}/members`, `PATCH`/`DELETE /v1/groups/{id}/members/{userId}`,
`POST /v1/groups/{id}/owner`, `POST /v1/groups/{id}/leave`, invite links (`GET`/`POST /v1/groups/{id}/invites`,
`DELETE …/{linkId}`), join requests (`GET /v1/groups/{id}/requests`, approve, decline), `GET /v1/invites/{code}`,
`POST /v1/invites/{code}/join`, poll vote, retract, close and voters under `/v1/messages/{id}/poll`,
`GET /v1/me/permissions`, `GET`/`PUT /v1/admin/users/permissions`. Changed: chats carry `type` `group`, a nullable
`peer`, `group` and `mutedUntil`; messages carry `poll`, `sender` (groups) and `mentionsMe`; sending accepts `poll`;
chat state accepts `mutedUntil`; typing signals may have no user id; new update kinds `chat.info`, `chat.members`,
`chat.removed`, `message.poll`; new error code `NOT_ALLOWED`.

## Tests

| Suite | What it proves |
| --- | --- |
| `apps/api/test/groups.integration.test.ts` (8) | Creation and membership history; messages to all members with sender names; mentions only of members; hashtags found by search; default permissions, restrictions (and their expiry), admin rights (no granting rights one lacks), pins and deleting others' messages; the §7 contract test (and the database refusing the list and count); invite links with use limits, approval, preview and revocation; polls and quizzes (results after voting, final quiz answers, retracting, closing, anonymous voters hidden, groups only); remove, leave, transfer ownership, delete, removed members losing the chat; O-21 permissions in the Admin Dashboard; mute |
| `packages/e2e/test/groups.e2e.test.ts` (6) | In Chromium: creating a group with two people, sender names, a highlighted mention and a hashtag search; a poll voted with results; privacy switched on by the owner and seen as private by a member (no hidden member on the page); an invite link opened before signing in and joined; restricting a member who then cannot send; no CSP violation |
| Updated | Owner SQL (Phase 5 checks), OpenAPI (every new route), the generated client; every earlier suite passes unchanged in behaviour |

## Not done in Phase 5 (and why)

| Item | Reason |
| --- | --- |
| Admin Dashboard "Groups" area (create, edit, delete groups as a system admin) | Phase 10 (remaining §22 areas) |
| Notifications for mentions, replies and group events | Phase 7 |
| "Seen by" in groups | Read positions in groups stay on the reader's devices (privacy); the furthest position shows the status of one's own messages |
| Membership service messages in the chat ("Ana joined") | They would show joins to members when the list is hidden; members see changes in Group info when allowed |
| A ban list (removed members rejoining by link) | Not in the specification; revoke the link instead |
