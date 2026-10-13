# Phase 8 report — global search (D-42)

Built on Phase 7 (branch `phase-8`). Decision: **D-42** in `docs/DECISIONS.md` (blueprint: Search §10), from the
blueprint's recommendations under the owner's instruction of 2026-10-09.

## What people can do

| Feature | How it works |
| --- | --- |
| Search everything | The search box above the chat list now shows, below Chats, Public channels and People, a **Messages** section: messages from every chat the person is in that match the words (whole words or parts of words), newest first, 30 at a time with "Show more" |
| Files and images | Chips: Messages, Photos and videos, Files, Voice. Files are also found by their name ("syllabus" finds "Course syllabus 2026.pdf"); with a chip chosen, no words are needed (all photos and videos, newest first) |
| Dates | Any time, past week, past month, past year |
| From a person | In People, the search button next to a person: "Messages from <name>" (with or without words) |
| Open a result | Opens the chat and scrolls to the message (loading older messages until it is there), highlighted briefly |
| Chats and people | As before: the person's own chats by name or username, people by name or username (P-25), public channels (Phase 6) |

## Results never include inaccessible content (exit gate)

- Every query is built from the person's own memberships (`conversation_members` of that user, chats not deleted);
  a chat id the person is not in returns nothing.
- Messages deleted for both sides and messages the person deleted for themselves are excluded.
- Results are built by the same view code as chat history: a channel's posts show the channel, never the admin, and
  "from a person" is not applied in channels where the person does not see who posts.
- Leaving a group, being removed, or a deleted group removes its messages from the results at once.

## Data (migration `20261014120000_phase8_search.sql`)

Indexes only: file names (trigram), messages by sender, ready files by kind. Messages already had full-text and
trigram indexes (Phase 3). `docs/owner-sql/apply-updates.sql` now applies migrations 7–14.

## API

New: `GET /v1/search?q=&kind=messages|media|files|voice&chatId=&fromUserId=&after=&before=&cursor=` →
`{ messages, nextCursor }`. Something must be searched for (words, a kind other than messages, a sender or dates);
words up to 100 characters; 60 searches per minute.

## Tests

| Suite | What it proves |
| --- | --- |
| `apps/api/test/search.integration.test.ts` (3) | Words across the person's chats only (whole words and parts); nothing deleted for both; what one person hid is hidden only for them; another pair's chat never appears, even by chat id; empty and too-long queries refused; sender and date filters; channel posts as from the channel, no sender filter for subscribers, the owner can; leaving and deleting a group removes its results; files by name and kind, photos without words, nothing for someone not in the chat; paging 35 results as 30 + 5 |
| `packages/e2e/test/search.e2e.test.ts` (3) | In Chromium: a message found from the chat list search and opened at it; another pair's conversation nowhere on the page; the Files chip; "Messages from Ben" chosen from People; no CSP violation |

## Known limits

- Full-text matching uses the "simple" configuration (no language stemming), so "exams" does not find "exam"; parts
  of words still match. Arabic and English are treated alike.
- At the academy's size Postgres answers quickly; Phase 13 load tests decide whether a dedicated search engine is
  needed (the service boundary is ready for it).
