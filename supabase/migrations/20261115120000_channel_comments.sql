-- Bedo Family - comments on channel posts.
--
-- Like the comments under a Telegram channel post, but stored in Bedo Family itself: the channel's owner, or an admin
-- with the right to change the channel's info, turns comments on for one channel; then every subscriber who can see a
-- post may comment on it, and reply to another comment of the same post. Comments are OFF for every channel until
-- someone turns them on, so nothing changes for anyone until then.
--
-- Comments are history like messages (D-17): never removed (soft delete only), and the text before every edit and
-- deletion is kept in audit.channel_comment_revisions, written in the same transaction (checked at commit), so admins
-- can review edited and deleted comments. No per-user update log entries and no notifications are made for comments
-- (a channel has up to 5000 subscribers); the apps fetch them when a post's comments are open.
--
-- Additive only: three new tables, their indexes, triggers and grants. No existing table, function or grant changes.

-------------------------------------------------------------------------------------------------------
-- The switch, one row per channel that ever had it changed (no row: off).
-------------------------------------------------------------------------------------------------------
create table app.channel_comment_settings (
  conversation_id  uuid primary key references app.conversations (id),
  enabled          boolean not null default false,
  updated_by       uuid references app.users (id),
  updated_at       timestamptz not null default now()
);
comment on table app.channel_comment_settings is
  'Comments on channel posts: on or off per channel, set by the owner or an admin who may change the channel info. No row: off.';
create trigger channel_comment_settings_no_delete before delete on app.channel_comment_settings
  for each row execute function app.forbid_mutation();
create trigger channel_comment_settings_no_truncate before truncate on app.channel_comment_settings
  for each statement execute function app.forbid_mutation();

-------------------------------------------------------------------------------------------------------
-- Comments. Listed per post, oldest first (ids are version-7 UUIDs, ordered by time).
-------------------------------------------------------------------------------------------------------
create table app.channel_comments (
  id                   uuid primary key default app.uuid_v7(),
  conversation_id      uuid not null references app.conversations (id),
  -- The channel post (a message of that channel).
  post_message_id      uuid not null references app.messages (id),
  author_id            uuid not null references app.users (id),
  -- The author's client-generated id (idempotency key: a retried comment is never stored twice).
  client_id            uuid not null,
  -- Null only once deleted; the text is kept in audit.channel_comment_revisions. Same length rule as messages (P-16).
  text                 text check (text is null or char_length(text) between 1 and 4096),
  -- A reply to another comment of the same post (checked by the foreign key below).
  reply_to_comment_id  uuid,
  created_at           timestamptz not null default now(),
  edited_at            timestamptz,
  deleted_at           timestamptz,
  deleted_by           uuid references app.users (id),
  constraint channel_comments_author_client_key unique (author_id, client_id),
  constraint channel_comments_post_id_key unique (post_message_id, id),
  constraint channel_comments_reply_same_post foreign key (post_message_id, reply_to_comment_id)
    references app.channel_comments (post_message_id, id),
  constraint channel_comments_reply_not_self check (reply_to_comment_id is null or reply_to_comment_id <> id),
  constraint channel_comments_deleted_state check ((deleted_at is null) = (text is not null)),
  constraint channel_comments_deleted_by check ((deleted_at is null) = (deleted_by is null))
);
comment on table app.channel_comments is
  'Comments on channel posts. Never removed: a deleted comment keeps its row, its text goes to audit.channel_comment_revisions.';
-- Listing a post's comments (oldest first, by id) and counting them, for comments that are not deleted.
create index channel_comments_post_live_idx on app.channel_comments (post_message_id, id) where deleted_at is null;

-------------------------------------------------------------------------------------------------------
-- Permanent history (D-17): the text before every edit and deletion.
-------------------------------------------------------------------------------------------------------
create table audit.channel_comment_revisions (
  id               bigint generated always as identity primary key,
  comment_id       uuid not null,
  conversation_id  uuid not null,
  post_message_id  uuid not null,
  author_id        uuid not null,
  action           text not null check (action in ('edited', 'deleted')),
  -- The comment text before the change.
  previous_text    text not null,
  -- The text after an edit; null for deletions.
  new_text         text,
  actor_type       text not null check (actor_type in ('user', 'admin', 'system')),
  actor_id         uuid,
  session_id       uuid,
  -- Transaction that wrote the row (set by trigger): the comment table proves a change and its record committed together.
  tx_id            xid8 not null,
  occurred_at      timestamptz not null default now(),
  constraint channel_comment_revisions_new_text check ((action = 'edited') = (new_text is not null))
);
comment on table audit.channel_comment_revisions is
  'Comments on channel posts: the text before every edit and deletion (D-17). Append-only.';
create index channel_comment_revisions_comment_idx on audit.channel_comment_revisions (comment_id, occurred_at);
create index channel_comment_revisions_conversation_idx on audit.channel_comment_revisions (conversation_id, occurred_at desc);
create trigger channel_comment_revisions_stamp_transaction before insert on audit.channel_comment_revisions
  for each row execute function app.stamp_transaction();
create trigger channel_comment_revisions_no_update_delete before update or delete on audit.channel_comment_revisions
  for each row execute function app.forbid_mutation();
create trigger channel_comment_revisions_no_truncate before truncate on audit.channel_comment_revisions
  for each statement execute function app.forbid_mutation();

-------------------------------------------------------------------------------------------------------
-- History protection on the comments.
-------------------------------------------------------------------------------------------------------
create trigger channel_comments_no_delete before delete on app.channel_comments
  for each row execute function app.forbid_mutation();
create trigger channel_comments_no_truncate before truncate on app.channel_comments
  for each statement execute function app.forbid_mutation();

-- A deleted comment never changes again.
create function app.channel_comments_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    raise exception 'comment % was deleted and cannot change', old.id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger channel_comments_guard_update before update on app.channel_comments
  for each row execute function app.channel_comments_guard_update();

-- At commit: an edit or a deletion must have its revision in the same transaction, recording exactly the text before
-- and (for an edit) after the change.
create function app.require_channel_comment_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  expected text := case when new.deleted_at is not null then 'deleted' else 'edited' end;
begin
  if not exists (
    select 1 from audit.channel_comment_revisions r
    where r.comment_id = new.id
      and r.action = expected
      and r.previous_text is not distinct from old.text
      and (expected <> 'edited' or r.new_text is not distinct from new.text)
      and r.tx_id = pg_catalog.pg_current_xact_id()
  ) then
    raise exception 'comment % changed without its audit record', new.id using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end;
$$;
create constraint trigger channel_comments_require_revision
  after update on app.channel_comments
  deferrable initially deferred
  for each row
  when (old.text is distinct from new.text or old.deleted_at is distinct from new.deleted_at)
  execute function app.require_channel_comment_revision();

-------------------------------------------------------------------------------------------------------
-- Privileges: only the API's runtime role, only what it needs; nothing for Supabase's client roles.
-------------------------------------------------------------------------------------------------------
revoke all on app.channel_comment_settings, app.channel_comments, audit.channel_comment_revisions from public;
do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = client_role) then
      execute format('revoke all on app.channel_comment_settings, app.channel_comments, audit.channel_comment_revisions from %I', client_role);
    end if;
  end loop;
end
$$;

grant select, insert on app.channel_comment_settings to bedo_runtime;
grant update (enabled, updated_by, updated_at) on app.channel_comment_settings to bedo_runtime;
grant select, insert on app.channel_comments to bedo_runtime;
grant update (text, edited_at, deleted_at, deleted_by) on app.channel_comments to bedo_runtime;
grant select, insert on audit.channel_comment_revisions to bedo_runtime;
