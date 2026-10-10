# Phase 4 report — media, stickers, GIFs and reactions (D-38)

Built on Phase 3.3.1 (branch `phase-4` from `c7f14a4`), on the D-36 architecture: everything runs in the one
Netlify site, with Supabase for the database, storage and realtime. There is no worker, so everything that needs
processing a file (resizing, previews, durations, waveforms) happens on the sending device before upload.

Decisions: **D-38** in `docs/DECISIONS.md` (O-09 GIFs, O-10 stickers, O-11 document previews, O-12 limits, O-30
malware scanning, and how deleted files are kept). They were taken from the blueprint's recommendations under the
owner's instruction of 2026-10-09 to finish Phases 4–12 back to back; they are listed here so they can be changed.

## What a student can do

| Feature | How it works |
| --- | --- |
| Photos | Picked or pasted into the composer (up to 10 at once, caption on the first). Resized on the device to at most 2560 px and sent as JPEG, with a 480-px preview; "Send as files (no compression)" keeps the original. Shown inline at their shape; tap for full size, with Save |
| Videos | Sent as they are (up to 50 MB) with a poster frame and the duration; play full screen |
| Voice messages | Microphone button when the composer is empty: recording bar with time and live level, cancel or send; stops by itself at 15 minutes. Opus (WebM/Ogg; MP4 on Safari) with a 100-bar waveform. Played with play/pause, waveform progress and 1x / 1.5x / 2x |
| Video messages | Camera button: round live preview, up to 60 seconds; shown as a round player |
| Audio and files | Any file except programs; a card with icon, name and size and a download button. Files always download under their own name; they are never opened by the browser |
| Upload progress | Every upload shows its percentage; a failed one can be retried (a refused file asks for a new upload) or cancelled |
| Emoji | A picker of the device's own emoji, inserted into the text |
| Stickers | The packs Super Admins uploaded; one tap sends |
| GIFs | Search (or trending) through Bedo Chat; one tap sends |
| Reactions | One per person per message from 👍 ❤️ 😂 😮 😢 🙏 🔥 👏 🎉 👎; counts under the message, the other side sees them live |
| Replies, forwards, pins, search | Work for media too: a reply shows "Photo", "Voice message", …; a forward carries the same file; captions are found by in-chat search and can be edited (a caption can also be added later) |
| Shared media | Chat menu → Shared media: tabs for photos and videos, files, voice messages; load more; jump to the message |
| Chat list | Shows "Photo", "File", "⭐ Sticker", … with the caption |

## Admin Dashboard

New section **Stickers and GIFs**. Every admin sees the packs and whether GIF search is on; Super Admins create
packs, add stickers (PNG or WebP, at most 512 KB and 512 × 512, with an emoji), take stickers out of a pack, archive
or restore packs, and set or remove the GIPHY key (shown only as "saved"). Every change is in the admin history.
Sticker images are shown as data URLs, so the dashboard's strict security policy is unchanged.

## How a file travels (blueprint: Media, upload path)

1. `POST /v1/files/uploads` with the chat, kind, declared type and size (and the device-made preview's size).
   The API checks membership and the right to send there (blocks, "who can message"), the per-kind size limit, the
   120-per-hour limit and refuses programs by name; it returns one-time signed upload URLs for the file and its
   preview in the private bucket `chat-media`. The slot is a `pending` row in `app.files`.
2. The browser uploads straight to Supabase Storage with progress. Signed uploads cannot overwrite an object.
3. `POST /v1/chats/{id}/messages` with `fileId` (and an optional caption and reply). Before the message exists the
   API reads the start of the stored object back: it must exist, have exactly the declared size, and be of a type
   the kind accepts (detected from its bytes: JPEG, PNG, WebP, GIF; MP4, WebM, QuickTime; MP3, Ogg, M4A, WAV, FLAC,
   AAC; programs refused for every kind). A mismatch removes the slot and the object (`FILE_INVALID`); a file not
   uploaded yet keeps its slot so the send can be retried. A preview that is not a JPEG or WebP up to 200 KB is
   dropped. Then, in the sending transaction, the file becomes `ready` and the message is created.
4. Message views carry the file's description and a signed preview link (an hour). The file itself comes from
   `GET /v1/messages/{id}/file` (signed, 5 minutes), only for someone who can see a message carrying it, and only
   while that message is not deleted.

## Data (migration `20261010120000_phase4_media.sql`)

| Object | Purpose |
| --- | --- |
| `app.files` | One row per file: owner, kind, detected type, size, name, object and preview paths, size in pixels, duration, waveform, `pending`/`ready`. A trigger refuses any change to a ready file and its removal (for every role); only unused slots may be removed |
| `app.messages` | `file_id`, `sticker_id`; kind `text` / `media` / `sticker`; a message has text, a file or a sticker until it is deleted, and its text is gone once deleted (the file reference stays, locked) |
| `audit.message_revisions` | `file_id`, `sticker_id`: an edit of a caption, or a deletion of a caption-less photo, has a complete record |
| `app.message_reactions` | One row per person per message |
| `app.sticker_packs`, `app.stickers` | Packs and stickers; never deleted (archived, taken out) |
| `app.gif_settings` | The GIPHY key, AES-256-GCM with `SETTINGS_ENCRYPTION_KEY`, bound to its purpose |
| `app.gif_files` | GIPHY id → the copy in `chat-media`, so a GIF is downloaded once |
| Buckets | `chat-media` (private, 50 MB per file) and `stickers` (public, 512 KB, PNG/WebP), created on Supabase only |

The runtime role gets exactly what this needs (no delete on stickers, packs, GIF copies or ready files).
Housekeeping removes upload slots unused for a day, with their objects.

## Owner SQL: one generated script

`docs/owner-sql/apply-phase-3.3.sql` is replaced by **`docs/owner-sql/apply-updates.sql`**, generated by
`node scripts/build-owner-sql.mjs` from `supabase/migrations`: it applies every migration after the six applied by
hand (7–10 now: D-35, Phase 3.3, private realtime, Phase 4 media), checks the result of each, sets the `bedo_api`
limits and records them, in one transaction. It refuses any other starting point and a second run. Tests check the
file matches the migrations and run it against a database in the live project's state (with stand-ins for
Supabase's realtime and storage tables). `apply-20261006120000.sql` (migration 7 alone) is removed. The owner's
deployment step 4 now names `apply-updates.sql`; nothing else about the owner steps changes.

## Security

| Area | What protects it |
| --- | --- |
| Who gets a file | Every download link is made after a permission check for one message; links last 5 minutes (previews an hour); a deleted message's file is refused; a person who hid a message cannot fetch its file through it |
| Upload abuse | Slots only for a chat the person may send to; per-kind sizes; 120 per hour; real size and type checked; the bucket refuses more than 50 MB; signed uploads cannot overwrite |
| Malicious files (O-30) | No scanning (needs a worker). Programs are refused by name and by bytes; every other file is served from the storage host (another origin than `bedochat.com`) and as a download |
| GIFs | GIPHY is called only by the API; previews come through `/api/v1/gifs/preview` with an HMAC-signed, hour-long link limited to GIPHY's media hosts (not an open proxy); the key is never returned or logged |
| Content-Security-Policy | The web app's policy adds `media-src 'self' blob: <Supabase project>`; images were already allowed from the project. The Admin Dashboard's policy is unchanged |
| Local cache | The cached message shape changed, so older caches are dropped and fetched again |

## API

New: `POST /v1/files/uploads`, `GET /v1/messages/{id}/file`, `PUT`/`DELETE /v1/messages/{id}/reaction`,
`GET /v1/chats/{id}/media`, `GET /v1/stickers`, `GET /v1/gifs/search`, `GET /v1/gifs/preview`, and for admins
`GET /v1/admin/stickers`, `GET /v1/admin/stickers/{id}/image`, `POST /v1/admin/stickers/packs`,
`PATCH /v1/admin/stickers/packs/{id}`, `POST /v1/admin/stickers/packs/{id}/stickers`, `DELETE /v1/admin/stickers/{id}`,
`GET`/`PUT /v1/admin/settings/gifs`. Changed: `POST /v1/chats/{id}/messages` takes `fileId`, `stickerId` or `gifId`
(text optional with a file, not allowed with a sticker or GIF); messages carry `kind`, `attachment`, `sticker`,
`reactions`, and a reply's `media`; the update kind `message.reactions`. New error codes `FILE_INVALID`,
`FEATURE_UNAVAILABLE`. New server setting `GIPHY_API_URL` (default `https://api.giphy.com/v1`; nothing to set).

## Tests

| Suite | What it proves |
| --- | --- |
| `apps/api/test/media.integration.test.ts` (9) | Slots only for members and senders; size, kind, waveform, duration and program checks; the photo round trip with preview and download links (inline vs download, 5 minutes); a second send of the same file refused; a non-member gets 404; a ZIP declared as a photo, a wrong size and a renamed program refused and removed; a late upload keeps its slot; an upload URL cannot overwrite; a bad preview is dropped; voice (WebM typed as audio), video messages and documents typed from their bytes; the media panel's tabs; forward by reference; caption added later with its revision; delete for both locks the file while the forwarded copy keeps working; revisions name the file; a ready file cannot be removed or changed, even by the owner; reactions (fixed set, change, take back, live through sync, blocked, deleted); sticker packs (Super Admin only, image checks, archive and removal, sent stickers keep showing, admin history); GIFs (off without a key, key stored encrypted and never returned, signed previews, forged links refused, one stored copy reused); housekeeping removes only unused slots |
| `packages/db/test/owner-sql-updates.integration.test.ts` (5) | The generated owner script matches the migrations, refuses an unsafe starting point, applies every update with all checks ok (buckets included), keeps realtime private, refuses a second run |
| `packages/e2e/test/media.e2e.test.ts` (8) | In Chromium with a fake camera and microphone and Supabase Storage / GIPHY stand-ins: a photo resized to JPEG with its preview, seen live and opened full size; a document downloaded under its name; a program refused; a voice message recorded, played and sped up; a reaction seen live and taken back; GIF search with previews through the API and a stored copy; a sticker uploaded in the Admin Dashboard and sent; the media panel; a deleted photo's file refused; no CSP violation |
| Updated | Messaging (reply previews carry `media`), CSP (`media-src`), OpenAPI (every new route documented, including the binary preview), the generated client |

## Not done in Phase 4 (and why)

| Item | Reason |
| --- | --- |
| PDF first-page thumbnails and an in-app page viewer, Word/PowerPoint previews | No server conversion without a worker (O-11); PDFs open in the device's own viewer after download |
| Malware scanning | Needs a worker (O-30); revisit with Phase 9 (security hardening) |
| Albums (several photos as one message) | Each file is its own message; the caption goes with the first |
| Push notifications for media | Phase 7 |
| Media in groups and channels | Phases 5 and 6 build on the same files, stickers and reactions |
