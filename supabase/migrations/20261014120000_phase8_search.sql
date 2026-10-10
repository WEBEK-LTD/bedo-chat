-- Bedo Chat - Phase 8: global search (D-42).
--
-- Search across every chat a person is in: words in messages (full text and parts of words, already indexed in
-- Phase 3), file names, messages from one person, and date ranges. Access filtering comes first in every query (the
-- person's own memberships); these indexes only make the filters fast. No data changes.

-- File names, matched by parts of words (documents found by name).
create index files_name_trgm_idx on app.files using gin (file_name extensions.gin_trgm_ops) where file_name is not null;
-- "Messages from this person", newest first.
create index messages_sender_idx on app.messages (sender_id, id);
-- Files of one kind across chats, newest first (photos and videos, documents, voice messages).
create index files_kind_idx on app.files (kind) where status = 'ready';
