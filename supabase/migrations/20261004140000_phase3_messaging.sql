-- Bedo Chat - Phase 3: private messaging core.
--
-- Blueprint references: Messaging, sync and multi-device; Core data model; Security, permissions and rate
-- limits; Audit and activity history (D-17, D-18); D-29 to D-31 (Phase 3 decisions and parameters P-16 to
-- P-31).
--
-- Privileges: the API and worker connect as a member of bedo_runtime. Every table below grants it only
-- what the application needs. Message history is protected three ways:
--   * the runtime role has no DELETE on messages, hidden messages or reports, and triggers refuse it anyway;
--   * a message's text can change only together with an audit.message_revisions row written in the same
--     transaction (deferred constraint triggers check this at commit), and "deleted for me" likewise;
--   * the audit tables are INSERT + SELECT only and refuse UPDATE, DELETE and TRUNCATE through triggers.

-------------------------------------------------------------------------------------------------------
-- Helpers
-------------------------------------------------------------------------------------------------------

-- Time-ordered UUID (RFC 9562 version 7): the first 48 bits are the Unix time in milliseconds. Message ids
-- use it so the monthly partition of a message follows from its id alone.
create function app.uuid_v7()
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  bytes bytea := substring(int8send(ms) from 3 for 6) || extensions.gen_random_bytes(10);
begin
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);  -- version 7
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);  -- RFC 9562 variant
  return encode(bytes, 'hex')::uuid;
end;
$$;

-- The smallest version-7 UUID of a UTC month: the partition boundary for messages created from then on.
create function app.message_partition_bound(month_start date)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select (lpad(to_hex((extract(epoch from month_start::timestamp) * 1000)::bigint), 12, '0') || '00000000000000000000')::uuid;
$$;

-------------------------------------------------------------------------------------------------------
-- Conversations. One table for every conversation type (blueprint: Core data model); Phase 3 has
-- private one-to-one chats only, so the type check allows only 'private' until a later phase adds more.
-------------------------------------------------------------------------------------------------------
create table app.conversations (
  id               uuid primary key default extensions.gen_random_uuid(),
  type             text not null check (type in ('private')),
  -- Private chats: the two participants, lower id first, so a pair of users has exactly one chat.
  private_low      uuid references app.users (id),
  private_high     uuid references app.users (id),
  created_by       uuid not null references app.users (id),
  -- Message sequence: the seq of the newest message (1, 2, 3, ... per conversation).
  last_seq         bigint not null default 0 check (last_seq >= 0),
  last_message_at  timestamptz,
  created_at       timestamptz not null default now(),
  constraint conversations_private_pair check (
    type <> 'private' or (private_low is not null and private_high is not null and private_low < private_high)
  )
);
create unique index conversations_private_pair_key on app.conversations (private_low, private_high) where type = 'private';

create table app.conversation_members (
  conversation_id  uuid not null references app.conversations (id),
  user_id          uuid not null references app.users (id),
  joined_at        timestamptz not null default now(),
  -- One read and one delivered position per member (blueprint: Message status), never one row per message.
  read_seq         bigint not null default 0 check (read_seq >= 0),
  delivered_seq    bigint not null default 0 check (delivered_seq >= 0),
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on app.conversation_members (user_id);

-------------------------------------------------------------------------------------------------------
-- Messages, partitioned by month (range of the version-7 id). The worker creates partitions ahead of
-- time through app.ensure_message_partitions; this migration creates the current month and three more.
-------------------------------------------------------------------------------------------------------
create table app.messages (
  id                    uuid not null default app.uuid_v7(),
  conversation_id       uuid not null references app.conversations (id),
  seq                   bigint not null check (seq > 0),
  sender_id             uuid not null references app.users (id),
  -- The sender's client-generated id (idempotency key, see app.message_requests).
  client_id             uuid not null,
  kind                  text not null default 'text' check (kind in ('text')),
  -- Null only once deleted for both sides; the text is kept in audit.message_revisions.
  text                  text check (text is null or char_length(text) between 1 and 4096),
  reply_to_id           uuid,
  -- Forwarded messages: the original sender (shown as "Forwarded from").
  forward_from_user_id  uuid references app.users (id),
  created_at            timestamptz not null default now(),
  edited_at             timestamptz,
  deleted_at            timestamptz,
  deleted_by            uuid references app.users (id),
  search_vector         tsvector generated always as (to_tsvector('simple'::regconfig, coalesce(text, ''))) stored,
  primary key (id),
  constraint messages_deleted_state check ((deleted_at is null) = (text is not null)),
  constraint messages_deleted_by check ((deleted_at is null) = (deleted_by is null))
) partition by range (id);

alter table app.messages add constraint messages_reply_to_fkey foreign key (reply_to_id) references app.messages (id);

create index messages_conversation_seq_idx on app.messages (conversation_id, seq);
create index messages_reply_to_idx on app.messages (reply_to_id) where reply_to_id is not null;
-- In-chat search (blueprint: Search): whole words through full text, parts of words through trigrams.
create index messages_search_idx on app.messages using gin (search_vector);
create index messages_text_trgm_idx on app.messages using gin (text extensions.gin_trgm_ops);

-- Creates the monthly partitions from the current month up to `months_ahead` months later. Runs as the
-- owner (security definer), so the runtime role can keep partitions ahead without any DDL privilege.
create function app.ensure_message_partitions(months_ahead integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_month date := date_trunc('month', now() at time zone 'utc')::date;
  month_start date;
  partition_name text;
  created integer := 0;
begin
  if months_ahead < 0 or months_ahead > 24 then
    raise exception 'months_ahead must be between 0 and 24';
  end if;
  for i in 0..months_ahead loop
    month_start := (first_month + make_interval(months => i))::date;
    partition_name := 'messages_' || to_char(month_start, 'YYYY_MM');
    if to_regclass('app.' || partition_name) is null then
      execute format(
        'create table app.%I partition of app.messages for values from (%L) to (%L)',
        partition_name,
        app.message_partition_bound(month_start),
        app.message_partition_bound((month_start + interval '1 month')::date));
      created := created + 1;
    end if;
  end loop;
  return created;
end;
$$;
revoke all on function app.ensure_message_partitions(integer) from public;

do $$
begin
  perform app.ensure_message_partitions(3);
end
$$;

-- Idempotency (blueprint: Write path): one row per client-generated id, so a retried send or forward never
-- stores a duplicate. Pruned with the update log after 30 days (P-17).
create table app.message_requests (
  sender_id        uuid not null references app.users (id),
  client_id        uuid not null,
  kind             text not null check (kind in ('send', 'forward')),
  conversation_id  uuid not null references app.conversations (id),
  message_ids      uuid[] not null check (cardinality(message_ids) between 1 and 100),
  created_at       timestamptz not null default now(),
  primary key (sender_id, client_id)
);
create index message_requests_created_idx on app.message_requests (created_at);

-- "Delete for me" (P-29): the message stays for the other participant. Permanent for the user.
create table app.message_hidden (
  user_id          uuid not null references app.users (id),
  message_id       uuid not null references app.messages (id),
  conversation_id  uuid not null references app.conversations (id),
  hidden_at        timestamptz not null default now(),
  primary key (user_id, message_id)
);
create index message_hidden_conversation_idx on app.message_hidden (user_id, conversation_id);

-- Pinned messages (P-22): either participant pins; visible to both.
create table app.message_pins (
  conversation_id  uuid not null references app.conversations (id),
  message_id       uuid not null references app.messages (id),
  pinned_by        uuid not null references app.users (id),
  pinned_at        timestamptz not null default now(),
  primary key (conversation_id, message_id)
);

-------------------------------------------------------------------------------------------------------
-- Per-user chat list state (P-19, P-20), folders (P-21), blocks (P-26, P-30) and reports (P-27).
-------------------------------------------------------------------------------------------------------
create table app.user_chat_state (
  user_id          uuid not null references app.users (id),
  conversation_id  uuid not null references app.conversations (id),
  pinned_at        timestamptz,
  archived_at      timestamptz,
  marked_unread    boolean not null default false,
  updated_at       timestamptz not null default now(),
  primary key (user_id, conversation_id)
);
create index user_chat_state_pinned_idx on app.user_chat_state (user_id) where pinned_at is not null;
create trigger user_chat_state_set_updated_at before update on app.user_chat_state
  for each row execute function app.set_updated_at();

create table app.chat_folders (
  id          uuid primary key default extensions.gen_random_uuid(),
  user_id     uuid not null references app.users (id),
  name        text not null check (char_length(name) between 1 and 12 and name = btrim(name)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index chat_folders_user_idx on app.chat_folders (user_id, created_at);
create trigger chat_folders_set_updated_at before update on app.chat_folders
  for each row execute function app.set_updated_at();

create table app.chat_folder_chats (
  folder_id        uuid not null references app.chat_folders (id) on delete cascade,
  conversation_id  uuid not null references app.conversations (id),
  primary key (folder_id, conversation_id)
);

create table app.blocks (
  blocker_id  uuid not null references app.users (id),
  blocked_id  uuid not null references app.users (id),
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on app.blocks (blocked_id);

-- Reports are kept permanently and never changed (P-27); the admin review (Phase 10) records its
-- decisions separately.
create table app.reports (
  id                uuid primary key default extensions.gen_random_uuid(),
  reporter_id       uuid not null references app.users (id),
  reported_user_id  uuid not null references app.users (id),
  conversation_id   uuid references app.conversations (id),
  message_id        uuid references app.messages (id),
  reason            text not null check (reason in ('spam', 'harassment', 'inappropriate_content', 'other')),
  details           text check (details is null or char_length(details) between 1 and 500),
  -- The reported message's text when the report was filed (null once deleted for both sides).
  message_text      text,
  created_at        timestamptz not null default now(),
  constraint reports_message_has_conversation check (message_id is null or conversation_id is not null)
);
create index reports_created_idx on app.reports (created_at desc);
create index reports_reported_user_idx on app.reports (reported_user_id, created_at desc);
create index reports_reporter_idx on app.reports (reporter_id, created_at desc);

-------------------------------------------------------------------------------------------------------
-- Sync (P-17): a per-user sequence of changes. Not history: pruned after 30 days; a device that is too
-- far behind re-fetches its chats instead.
-------------------------------------------------------------------------------------------------------
create table app.user_sync_state (
  user_id             uuid primary key references app.users (id),
  last_seq            bigint not null default 0 check (last_seq >= 0),
  -- Every entry up to this seq has been pruned.
  pruned_through_seq  bigint not null default 0 check (pruned_through_seq >= 0),
  constraint user_sync_state_pruned check (pruned_through_seq <= last_seq)
);

create table app.update_log (
  user_id          uuid not null references app.users (id),
  seq              bigint not null check (seq > 0),
  kind             text not null check (kind ~ '^[a-z_.]{1,40}$'),
  conversation_id  uuid references app.conversations (id),
  message_id       uuid,
  data             jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at       timestamptz not null default now(),
  primary key (user_id, seq)
);
create index update_log_created_idx on app.update_log (created_at);

-- Last seen (P-18), written when a user's last device disconnects; minute precision is applied on read.
create table app.user_presence (
  user_id       uuid primary key references app.users (id),
  last_seen_at  timestamptz not null
);

-------------------------------------------------------------------------------------------------------
-- Permanent audit history (D-17): message revisions and screenshot events.
-------------------------------------------------------------------------------------------------------
create table audit.message_revisions (
  id               bigint generated always as identity primary key,
  message_id       uuid not null,
  conversation_id  uuid not null,
  sender_id        uuid not null,
  action           text not null check (action in ('edited', 'deleted_for_me', 'deleted_for_both')),
  -- The message text before the change. Null only when a message already deleted for both sides is then
  -- hidden for one user.
  previous_text    text,
  -- The text after an edit; null for deletions.
  new_text         text,
  actor_type       text not null check (actor_type in ('user', 'admin', 'system')),
  actor_id         uuid,
  session_id       uuid,
  -- Transaction that wrote the row (set by trigger); lets the message tables prove that a change and its
  -- record committed together.
  tx_id            xid8 not null,
  occurred_at      timestamptz not null default now(),
  constraint message_revisions_new_text check ((action = 'edited') = (new_text is not null)),
  constraint message_revisions_previous_text check (action = 'deleted_for_me' or previous_text is not null)
);
create index message_revisions_message_idx on audit.message_revisions (message_id, occurred_at);
create index message_revisions_conversation_idx on audit.message_revisions (conversation_id, occurred_at desc);

create function app.stamp_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.tx_id := pg_catalog.pg_current_xact_id();
  return new;
end;
$$;
create trigger message_revisions_stamp_transaction before insert on audit.message_revisions
  for each row execute function app.stamp_transaction();

create table audit.screenshot_events (
  id               bigint generated always as identity primary key,
  user_id          uuid not null,
  session_id       uuid not null,
  platform         text not null check (platform in ('ios', 'android')),
  device_name      text check (device_name is null or length(device_name) <= 100),
  conversation_id  uuid,
  -- What Bedo Chat was showing (no platform hands the app the image).
  screen           text not null check (screen ~ '^[a-z_]{1,40}$'),
  message_ids      uuid[] not null default '{}' check (cardinality(message_ids) <= 100),
  occurred_at      timestamptz not null,
  received_at      timestamptz not null default now()
);
create index screenshot_events_user_idx on audit.screenshot_events (user_id, received_at desc);
create index screenshot_events_conversation_idx on audit.screenshot_events (conversation_id, received_at desc)
  where conversation_id is not null;

do $$
declare
  t text;
begin
  foreach t in array array['message_revisions', 'screenshot_events'] loop
    execute format(
      'create trigger %I before update or delete on audit.%I for each row execute function app.forbid_mutation()',
      t || '_no_update_delete', t);
    execute format(
      'create trigger %I before truncate on audit.%I for each statement execute function app.forbid_mutation()',
      t || '_no_truncate', t);
  end loop;
end
$$;

-------------------------------------------------------------------------------------------------------
-- History protection on the message tables.
-------------------------------------------------------------------------------------------------------

-- Messages, hidden messages and reports are never removed or truncated (the runtime role has no DELETE).
create trigger messages_no_delete before delete on app.messages
  for each row execute function app.forbid_mutation();
create trigger messages_no_truncate before truncate on app.messages
  for each statement execute function app.forbid_mutation();
create trigger message_hidden_no_update_delete before update or delete on app.message_hidden
  for each row execute function app.forbid_mutation();
create trigger message_hidden_no_truncate before truncate on app.message_hidden
  for each statement execute function app.forbid_mutation();
create trigger reports_no_update_delete before update or delete on app.reports
  for each row execute function app.forbid_mutation();
create trigger reports_no_truncate before truncate on app.reports
  for each statement execute function app.forbid_mutation();

-- A message deleted for both sides never changes again.
create function app.messages_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    raise exception 'message % was deleted and cannot change', old.id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger messages_guard_update before update on app.messages
  for each row execute function app.messages_guard_update();

-- At commit: an edit or a deletion for both sides must have its revision in the same transaction, recording
-- exactly the text before and (for an edit) after the change.
create function app.require_message_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  expected text := case when new.deleted_at is not null then 'deleted_for_both' else 'edited' end;
begin
  if not exists (
    select 1 from audit.message_revisions r
    where r.message_id = new.id
      and r.action = expected
      and r.previous_text is not distinct from old.text
      and (expected <> 'edited' or r.new_text is not distinct from new.text)
      and r.tx_id = pg_catalog.pg_current_xact_id()
  ) then
    raise exception 'message % changed without its audit record', new.id using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end;
$$;
create constraint trigger messages_require_revision
  after update on app.messages
  deferrable initially deferred
  for each row
  when (old.text is distinct from new.text or old.deleted_at is distinct from new.deleted_at)
  execute function app.require_message_revision();

-- At commit: "delete for me" must have its revision in the same transaction.
create function app.require_hidden_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from audit.message_revisions r
    where r.message_id = new.message_id
      and r.action = 'deleted_for_me'
      and r.actor_id = new.user_id
      and r.tx_id = pg_catalog.pg_current_xact_id()
  ) then
    raise exception 'message % hidden without its audit record', new.message_id using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end;
$$;
create constraint trigger message_hidden_require_revision
  after insert on app.message_hidden
  deferrable initially deferred
  for each row
  execute function app.require_hidden_revision();

-------------------------------------------------------------------------------------------------------
-- Starting a private chat (P-25): partial-match search on names and usernames.
-------------------------------------------------------------------------------------------------------
create index users_name_trgm_idx on app.users using gin (name extensions.gin_trgm_ops);
create index users_username_trgm_idx on app.users using gin ((username::text) extensions.gin_trgm_ops);

-------------------------------------------------------------------------------------------------------
-- Runtime privileges (bedo_runtime).
-------------------------------------------------------------------------------------------------------
grant execute on function app.uuid_v7() to bedo_runtime;
grant execute on function app.ensure_message_partitions(integer) to bedo_runtime;

grant select, insert on app.conversations to bedo_runtime;
grant update (last_seq, last_message_at) on app.conversations to bedo_runtime;
grant select, insert on app.conversation_members to bedo_runtime;
grant update (read_seq, delivered_seq) on app.conversation_members to bedo_runtime;
grant select, insert on app.messages to bedo_runtime;
grant update (text, edited_at, deleted_at, deleted_by) on app.messages to bedo_runtime;
-- Delete: the worker prunes idempotency keys after 30 days.
grant select, insert, delete on app.message_requests to bedo_runtime;
grant select, insert on app.message_hidden to bedo_runtime;
grant select, insert, delete on app.message_pins to bedo_runtime;
grant select, insert, update on app.user_chat_state to bedo_runtime;
grant select, insert, update, delete on app.chat_folders to bedo_runtime;
grant select, insert, delete on app.chat_folder_chats to bedo_runtime;
grant select, insert, delete on app.blocks to bedo_runtime;
grant select, insert on app.reports to bedo_runtime;
grant select, insert, update on app.user_sync_state to bedo_runtime;
-- Delete: the worker prunes entries older than 30 days (P-17).
grant select, insert, delete on app.update_log to bedo_runtime;
grant select, insert, update on app.user_presence to bedo_runtime;
grant select, insert on audit.message_revisions, audit.screenshot_events to bedo_runtime;
