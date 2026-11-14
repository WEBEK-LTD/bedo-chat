-- Bedo Family - topics in groups (D-63).
--
-- A group's owner, or an admin with the right to change the group's info, can turn Topics on for the group (like the
-- forum topics of Telegram): messages are then posted into a topic, or into "General" (no topic). Groups only, never
-- channels or private chats. Off for every group until an admin turns it on; turning it off hides topics again and
-- keeps everything. Topics are never deleted in this version: an admin closes one (then only the owner and admins post
-- in it) and can reopen it. Unread counts, read positions, sync and search stay per group, as before.
--
-- Additive only: two new tables, one new nullable column on app.messages (no default, so adding it changes no stored
-- row) and one partial index on it. Nothing existing changes behaviour; the API keeps working without this update.

-- Whether a group shows topics. A group without a row has them off.
create table app.group_topic_settings (
  conversation_id  uuid primary key references app.conversations (id),
  enabled          boolean not null default false,
  updated_by       uuid references app.users (id),
  updated_at       timestamptz not null default now()
);
comment on table app.group_topic_settings is
  'Topics in groups (D-63): whether a group shows topics. Off by default; a group without a row has them off.';
create trigger group_topic_settings_no_delete before delete on app.group_topic_settings
  for each row execute function app.forbid_mutation();
create trigger group_topic_settings_no_truncate before truncate on app.group_topic_settings
  for each statement execute function app.forbid_mutation();

-- The topics of a group. "General" is not a row: it is the messages without a topic.
create table app.group_topics (
  id               uuid primary key default app.uuid_v7(),
  conversation_id  uuid not null references app.conversations (id),
  title            text not null check (char_length(title) between 1 and 128),
  -- One of the seven avatar tones (0 to 6), the dot shown next to the title.
  color            smallint not null default 0 check (color between 0 and 6),
  created_by       uuid not null references app.users (id),
  created_at       timestamptz not null default now(),
  -- Closed: only the owner and admins post in it. Reopening clears both.
  closed_at        timestamptz,
  closed_by        uuid references app.users (id),
  constraint group_topics_closed check ((closed_at is null) = (closed_by is null))
);
comment on table app.group_topics is
  'Topics in groups (D-63): a group''s topics. Never deleted (closed instead); messages point at them through app.messages.topic_id.';
create index group_topics_conversation_idx on app.group_topics (conversation_id, created_at);
create trigger group_topics_no_delete before delete on app.group_topics
  for each row execute function app.forbid_mutation();
create trigger group_topics_no_truncate before truncate on app.group_topics
  for each statement execute function app.forbid_mutation();

-- The topic a message was posted in; null: General (every message before this update, and every message in private
-- chats, channels and groups without topics). No default, so adding it rewrites nothing. The API checks that the topic
-- belongs to the message's group. The foreign key is part of the new column, so no stored message is scanned for it.
alter table app.messages add column topic_id uuid references app.group_topics (id);
-- A topic's messages in order, and its last message and count, for the topic list. Only messages with a topic are in
-- it, so it starts empty.
create index messages_topic_seq_idx on app.messages (conversation_id, topic_id, seq) where topic_id is not null;

-- No one but the API reaches the new tables.
revoke all on app.group_topic_settings from public;
revoke all on app.group_topics from public;
do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = client_role) then
      execute format('revoke all on app.group_topic_settings from %I', client_role);
      execute format('revoke all on app.group_topics from %I', client_role);
    end if;
  end loop;
end
$$;

-- Runtime privileges (bedo_runtime). app.messages keeps its grants: select and insert cover the new column, and it is
-- never updated (a message stays in its topic).
grant select, insert on app.group_topic_settings to bedo_runtime;
grant update (enabled, updated_by, updated_at) on app.group_topic_settings to bedo_runtime;
grant select, insert on app.group_topics to bedo_runtime;
grant update (title, color, closed_at, closed_by) on app.group_topics to bedo_runtime;
