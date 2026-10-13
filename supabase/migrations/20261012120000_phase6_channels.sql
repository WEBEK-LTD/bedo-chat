-- Bedo Chat - Phase 6: channels and scheduled messages (D-40).
--
-- Channels are conversations of type 'channel': the owner and admins with the right to post publish; subscribers
-- read, react and leave. A public channel is found by any academy user in search and joined directly (O-22); a
-- private channel is joined only with an invite link. Only owners and admins see who subscribed; everyone sees how
-- many did.
--
-- Scheduled messages: a message saved with a time is sent then by the API (a scheduled Netlify function asks every
-- minute, and any request in between does too), as if its sender sent it at that moment, after the same permission
-- checks. Channel admins who may post can schedule posts; anyone else needs the system permission "schedule
-- messages" (O-21).

alter table app.conversations drop constraint conversations_type_check;
alter table app.conversations add constraint conversations_type_check check (type in ('private', 'group', 'channel'));
alter table app.conversations drop constraint conversations_group_title;
alter table app.conversations add constraint conversations_group_title check (type = 'private' or title is not null);
-- Channels: findable and joinable by every academy user (public) or by invite link only (private).
alter table app.conversations add column is_public boolean not null default false;
alter table app.conversations add constraint conversations_public_channel check (type = 'channel' or not is_public);
grant update (is_public) on app.conversations to bedo_runtime;
create index conversations_public_channels_title_idx on app.conversations using gin (title extensions.gin_trgm_ops)
  where type = 'channel' and is_public and deleted_at is null;

alter table app.conversation_members drop constraint conversation_members_role_check;
alter table app.conversation_members add constraint conversation_members_role_check check (role in ('owner', 'admin', 'member', 'subscriber'));
alter table app.conversation_members drop constraint conversation_members_admin_rights_check;
alter table app.conversation_members add constraint conversation_members_admin_rights_check check (
  admin_rights <@ array['change_info', 'delete_messages', 'restrict_members', 'invite_users', 'approve_requests', 'pin_messages', 'manage_admins', 'change_privacy', 'post_messages']::text[]
);

-- A channel post forwarded elsewhere shows the channel as its origin, never the admin who posted it.
alter table app.messages add column forward_from_chat_id uuid references app.conversations (id);
alter table app.messages add constraint messages_forward_origin check (forward_from_user_id is null or forward_from_chat_id is null);

-- Member privacy for channels: the subscriber count is shown to every subscriber, the list only to owners and admins.
create or replace function app.can_view_members(p_viewer uuid, p_group uuid, p_what text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.conversation_members m
    join app.conversations c on c.id = m.conversation_id and c.type in ('group', 'channel') and c.deleted_at is null
    left join app.group_settings s on s.conversation_id = c.id
    where m.conversation_id = p_group and m.user_id = p_viewer
      and (m.role in ('owner', 'admin')
           or (c.type = 'channel' and p_what = 'count')
           or (c.type = 'group' and p_what = 'list' and not coalesce(s.hide_member_list, false))
           or (c.type = 'group' and p_what = 'count' and not coalesce(s.hide_member_count, false)))
  );
$$;

-------------------------------------------------------------------------------------------------------
-- Scheduled messages
-------------------------------------------------------------------------------------------------------
create table app.scheduled_messages (
  id               uuid primary key default extensions.gen_random_uuid(),
  conversation_id  uuid not null references app.conversations (id),
  sender_id        uuid not null references app.users (id),
  -- The session that scheduled it (recorded with the message's history).
  session_id       uuid not null,
  -- The client id the message is sent with (sending twice is impossible: app.message_requests).
  client_id        uuid not null,
  send_at          timestamptz not null,
  -- What to send: text, a file (checked when scheduled), a sticker, a GIF or a poll, and an optional reply.
  payload          jsonb not null check (jsonb_typeof(payload) = 'object' and length(payload::text) <= 20000),
  status           text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  attempts         smallint not null default 0,
  error_code       text check (error_code is null or length(error_code) <= 40),
  message_id       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  sent_at          timestamptz,
  unique (sender_id, client_id)
);
create index scheduled_messages_due_idx on app.scheduled_messages (send_at) where status in ('pending', 'sending');
-- The author's list per chat (pending and failed ones stay until sent or removed).
create index scheduled_messages_author_idx on app.scheduled_messages (sender_id, conversation_id, send_at) where status in ('pending', 'sending', 'failed');
create trigger scheduled_messages_set_updated_at before update on app.scheduled_messages
  for each row execute function app.set_updated_at();
comment on table app.scheduled_messages is
  'Messages to send at a set time (Phase 6). Sent by the API with the same checks as any message; never deleted.';

grant select, insert, update on app.scheduled_messages to bedo_runtime;
