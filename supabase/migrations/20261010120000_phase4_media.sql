-- Bedo Chat - Phase 4: media, stickers, GIFs and reactions (D-38).
--
-- Files. A browser asks the API for an upload slot (kind, type, size, the chat), uploads straight to the private
-- bucket "chat-media" with a one-time signed URL, then sends the message. Before the message exists the API reads
-- the stored object back (real size, real type from its first bytes); only then is the file marked ready and
-- attached. A file is never replaced (signed uploads cannot overwrite) and a ready file never changes or goes away:
-- forwarding a message references the same file, and deleting a message only hides it (D-38: the object stays in
-- the private bucket, locked, as part of the permanent history; no user can download it any more). Upload slots
-- that were never used are removed by the hourly housekeeping after a day.
--
-- Stickers are packs that Super Admins upload (O-10), stored in the public bucket "stickers". GIFs come from GIPHY
-- through the API (O-09): sending one copies it into "chat-media" once, and later sends of the same GIF reuse it.
-- Reactions: one emoji per person per message, from a fixed set.
--
-- Storage buckets exist only on Supabase; on any other Postgres (local development, tests) they are skipped.

-------------------------------------------------------------------------------------------------------
-- Files
-------------------------------------------------------------------------------------------------------
create table app.files (
  id              uuid primary key default app.uuid_v7(),
  -- Who asked for the upload slot (for a GIF: who first sent it).
  owner_id        uuid not null references app.users (id),
  kind            text not null check (kind in ('photo', 'video', 'audio', 'voice', 'video_note', 'file', 'gif')),
  -- For photos, videos, audio, voice and video messages: the type detected from the stored bytes.
  mime_type       text not null check (mime_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$' and length(mime_type) <= 100),
  size_bytes      bigint not null check (size_bytes between 1 and 52428800),
  file_name       text check (file_name is null or char_length(file_name) between 1 and 255),
  object_path     text not null unique check (object_path ~ '^[a-z_]+/[0-9a-f-]{36}(\.[a-z0-9]{1,8})?$'),
  thumbnail_path  text unique check (thumbnail_path is null or thumbnail_path ~ '^thumbs/[0-9a-f-]{36}\.(jpg|webp)$'),
  width           integer check (width is null or width between 1 and 20000),
  height          integer check (height is null or height between 1 and 20000),
  duration_ms     integer check (duration_ms is null or duration_ms between 0 and 86400000),
  -- Voice messages: up to 100 bars, each 0-100.
  waveform        smallint[] check (waveform is null or (cardinality(waveform) between 1 and 100 and 0 <= all (waveform) and 100 >= all (waveform))),
  status          text not null default 'pending' check (status in ('pending', 'ready')),
  created_at      timestamptz not null default now(),
  ready_at        timestamptz,
  constraint files_ready_at check ((status = 'ready') = (ready_at is not null))
);
create index files_pending_idx on app.files (created_at) where status = 'pending';
comment on table app.files is
  'Files in chats (Phase 4). Objects live in the private bucket chat-media; ready files never change or go away (D-38).';

-- A ready file never changes and is never removed; only an unused upload slot (pending) may be removed or become ready.
create function app.files_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'ready' then
      raise exception 'file % is part of the history and cannot be removed', old.id using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status = 'ready'
     or new.id <> old.id or new.owner_id <> old.owner_id or new.kind <> old.kind or new.object_path <> old.object_path
     or new.thumbnail_path is distinct from old.thumbnail_path and new.thumbnail_path is not null
     or new.created_at <> old.created_at then
    raise exception 'file % cannot change this way', old.id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger files_guard before update or delete on app.files
  for each row execute function app.files_guard();
create trigger files_no_truncate before truncate on app.files
  for each statement execute function app.forbid_mutation();

-------------------------------------------------------------------------------------------------------
-- Stickers (O-10): packs uploaded by Super Admins
-------------------------------------------------------------------------------------------------------
create table app.sticker_packs (
  id           uuid primary key default app.uuid_v7(),
  name         text not null check (char_length(name) between 1 and 64),
  created_by   uuid references app.admin_accounts (id),
  created_at   timestamptz not null default now(),
  -- Archived packs are not offered any more; stickers already sent keep showing.
  archived_at  timestamptz
);

create table app.stickers (
  id           uuid primary key default app.uuid_v7(),
  pack_id      uuid not null references app.sticker_packs (id),
  emoji        text not null check (char_length(emoji) between 1 and 16),
  object_path  text not null unique check (object_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|webp)$'),
  mime_type    text not null check (mime_type in ('image/png', 'image/webp')),
  width        integer not null check (width between 1 and 1024),
  height       integer not null check (height between 1 and 1024),
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  removed_at   timestamptz
);
create index stickers_pack_idx on app.stickers (pack_id, position);

-- Stickers are referenced by messages: never removed, only taken out of the pack.
create trigger stickers_no_delete before delete on app.stickers
  for each row execute function app.forbid_mutation();
create trigger sticker_packs_no_delete before delete on app.sticker_packs
  for each row execute function app.forbid_mutation();

-------------------------------------------------------------------------------------------------------
-- GIFs (O-09): GIPHY through the API
-------------------------------------------------------------------------------------------------------
create table app.gif_settings (
  id              boolean primary key default true check (id),
  -- AES-256-GCM, base64(iv | tag | ciphertext), purpose-bound, with SETTINGS_ENCRYPTION_KEY (like the Waabek key).
  giphy_key_enc   text check (giphy_key_enc is null or length(giphy_key_enc) between 40 and 4000),
  updated_by      uuid references app.admin_accounts (id),
  updated_at      timestamptz
);
insert into app.gif_settings (id) values (true);
comment on table app.gif_settings is 'GIF search settings (O-09). One row. The GIPHY API key is stored only encrypted.';

-- A GIF copied into chat-media once; later sends of the same GIF reference the same file.
create table app.gif_files (
  giphy_id    text primary key check (giphy_id ~ '^[A-Za-z0-9]{1,64}$'),
  file_id     uuid not null unique references app.files (id),
  created_at  timestamptz not null default now()
);

-------------------------------------------------------------------------------------------------------
-- Messages: a file (media) or a sticker, with an optional caption for files
-------------------------------------------------------------------------------------------------------
alter table app.messages add column file_id uuid references app.files (id);
alter table app.messages add column sticker_id uuid references app.stickers (id);

alter table app.messages drop constraint messages_kind_check;
alter table app.messages add constraint messages_kind_check check (kind in ('text', 'media', 'sticker'));
alter table app.messages add constraint messages_kind_content check (
  (kind = 'media') = (file_id is not null)
  and (kind = 'sticker') = (sticker_id is not null)
  and (kind <> 'sticker' or text is null)
);
-- Until deleted for both sides a message has text, a file or a sticker; once deleted its text is gone (kept in
-- audit.message_revisions) while the file or sticker reference stays, locked (D-38).
alter table app.messages drop constraint messages_deleted_state;
alter table app.messages add constraint messages_content check (
  deleted_at is not null or text is not null or file_id is not null or sticker_id is not null
);
alter table app.messages add constraint messages_deleted_text check (deleted_at is null or text is null);

-- The chat's media panel (photos and videos, files, voice messages).
create index messages_files_idx on app.messages (conversation_id, seq) where file_id is not null;

-- Revisions record which file or sticker the message carried, so a caption-less photo can be edited (a caption
-- added) or deleted with a complete record.
alter table audit.message_revisions add column file_id uuid;
alter table audit.message_revisions add column sticker_id uuid;
alter table audit.message_revisions drop constraint message_revisions_previous_text;
alter table audit.message_revisions add constraint message_revisions_previous_text check (
  action = 'deleted_for_me' or previous_text is not null or file_id is not null or sticker_id is not null
);

-------------------------------------------------------------------------------------------------------
-- Reactions: one per person per message
-------------------------------------------------------------------------------------------------------
create table app.message_reactions (
  message_id       uuid not null references app.messages (id),
  conversation_id  uuid not null references app.conversations (id),
  user_id          uuid not null references app.users (id),
  emoji            text not null check (char_length(emoji) between 1 and 16),
  created_at       timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index message_reactions_conversation_idx on app.message_reactions (conversation_id);

-------------------------------------------------------------------------------------------------------
-- Runtime privileges (bedo_runtime)
-------------------------------------------------------------------------------------------------------
-- Delete and update: only unused upload slots (the trigger refuses anything else).
grant select, insert, update, delete on app.files to bedo_runtime;
grant select, insert, update on app.sticker_packs, app.stickers to bedo_runtime;
grant select, update on app.gif_settings to bedo_runtime;
grant select, insert on app.gif_files to bedo_runtime;
grant select, insert, update, delete on app.message_reactions to bedo_runtime;

-------------------------------------------------------------------------------------------------------
-- Storage buckets (Supabase only)
-------------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    -- Private: every download is a short-lived signed URL given after a permission check. 50 MB per file (O-12).
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('chat-media', 'chat-media', false, 52428800)
    on conflict (id) do nothing;
    -- Public: sticker images (no personal data), uploaded only by the API.
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('stickers', 'stickers', true, 524288, array['image/png', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end
$$;
