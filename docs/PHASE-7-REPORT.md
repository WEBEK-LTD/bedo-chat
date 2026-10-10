# Phase 7 report — notifications (D-41)

Built on Phase 6 (branch `phase-7`), on the D-36 architecture (no worker). Decision: **D-41** in `docs/DECISIONS.md`
(O-19, and the blueprint's notifications and push), from the blueprint's recommendations under the owner's
instruction of 2026-10-09.

## What people get

| Feature | How it works |
| --- | --- |
| Message notifications | New messages in private chats, groups and channels reach the person's other devices as notifications (Web Push, turned on per browser in Settings → Notifications). The sender is never notified |
| Mentions and replies | "Ana mentioned you: …", and replies to one's own messages, notify **even in a muted chat or a category turned off** (O-19) |
| Added to a group or channel | "Ana added you to the group" (also when a join request is approved) |
| What a notification shows | Private chat: the sender as title and the text. Group: the group as title, "Sender: text". Channel: the channel and the text, never the admin who posted. Media by name ("Photo", "Voice message", "📊 Exam day?"); several forwarded messages as "2 forwarded messages" |
| Previews off | Settings → Notifications → "Show sender and text" off: every notification says only "Bedo Chat — New message" |
| Categories | Private chats, Groups, Channels: each can be turned off (mentions and replies still come through) |
| Mute | Per chat, as in Phase 5 (1 hour, 8 hours, until turned on) |
| No duplicates | A device showing the chat (page visible) is not notified about it; one notification per chat is kept and replaced by the next, with the sound played again |
| Badge | The number of unread messages in chats that are not muted, the same on every device: in the tab title "(3) Bedo Chat", on the app icon where the browser supports it (installed web app), and in each push. Reading on one device clears it on the others |
| Opening a notification | Opens Bedo Chat on that chat (or switches the open window to it) |
| Sound | The device's default notification sound |

## How it works

- After a message is stored (sent, forwarded or scheduled), `NotificationsService` runs after the response (D-36):
  it reads the members with push subscriptions on signed-in sessions, drops the sender, devices showing the chat,
  people who blocked the sender, and people who muted the chat or turned the category off unless the message
  mentions or replies to them, then sends one push per device with that person's badge.
- The badge is computed in SQL from read positions (the same rule as each chat's unread count, capped like it) for
  all recipients at once; the apps compute the same number with `badgeCount()` from the chat summaries the server
  sends, so they always agree.
- A device reports the chat it shows (`POST /v1/realtime/viewing`) when a chat opens, when the page is hidden or shown,
  and every 45 seconds; it is stored with the device's online state and expires with it.
- The service worker shows the notification (tag = the chat, replaced and re-sounded), sets the app badge, and on a
  click focuses an open Bedo Chat window and tells it which chat to open, or opens `/?chat=<id>`. It still has no
  fetch handler and opens only paths of the student app (never `/admin`, never another site).

## Data (migration `20261013120000_phase7_notifications.sql`)

| Object | Purpose |
| --- | --- |
| `app.notification_settings` | Per user: private chats, groups, channels, previews (defaults when no row) |
| `app.presence_devices.viewing_chat_id` | The chat a device shows right now |

`docs/owner-sql/apply-updates.sql` is regenerated: it now applies migrations 7–13 (Phase 7 checks included).

## API

New: `GET`/`PATCH /v1/me/notification-settings`, `GET /v1/me/badge`, `POST /v1/realtime/viewing`. Push payloads now
carry `url` and `badge`.

## Tests

| Suite | What it proves |
| --- | --- |
| `apps/api/test/notifications.integration.test.ts` (4) | A private message pushes sender, text, link and badge to the recipient only; the badge equals `badgeCount()` of the chat list and `/v1/me/badge`, grows with each message and clears on reading; a device showing the chat is not pushed, and is again once it shows nothing; viewing a chat one is not in is refused; being added to a group notifies; group pushes name the group and the sender; a muted group stays silent except a mention and a reply (O-19); muted chats are out of the badge; groups turned off; previews off gives "New message" with no text anywhere in the push; settings round-trip and empty changes refused; channel posts show the channel; polls by their question; nothing from a blocked person; forwarding several messages is one notification |
| `packages/e2e/test/notifications.e2e.test.ts` (5) | In Chromium, one person on two devices: the same badge "(3) Bedo Chat" on both as messages arrive; reading on one clears both; a muted chat stays out of the badge on both and comes back when unmuted; `/?chat=<id>` opens that chat; the notification settings are saved and shown on the other device; no CSP violation |
| Updated | Owner SQL (Phase 7 checks), OpenAPI and the generated client; every earlier suite passes |

## Not done in Phase 7 (and why)

| Item | Reason |
| --- | --- |
| iOS and Android (APNs, FCM) and the desktop app | Phase 12: the same decision code will hand native devices their pushes |
| Admin "Push notifications" broadcasts (O-20) | Phase 10 |
| Per-chat sounds and notification exceptions lists | Not requested (blueprint: default sound only) |
| A real push delivered through Google's or Mozilla's push service in the automated tests | The tests run without network; the push sender is replaced by a recorder, and the browser test checks everything the page itself shows |

## Known limits

- A browser shows notifications only after the person turns them on for that browser; on iPhone and iPad only for
  the site added to the Home Screen (iOS 16.4+).
- The app icon badge needs a browser with the Badging API (installed web apps in Chrome, Edge and Safari); the tab
  title always shows it.
