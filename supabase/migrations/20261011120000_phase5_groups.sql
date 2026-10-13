-- Bedo Chat - Phase 5: groups (D-39).
--
-- Groups are conversations of type 'group' in the same tables as private chats, so messages, media, pins, reactions,
-- search and sync work unchanged. Each member has a role (owner, admin, member); admins hold a set of admin rights;
-- every member's permissions are the group's defaults minus any restriction an admin placed on them. Member privacy
-- (O-04: two switches) hides the member count and/or the member list from normal members: the API decides through
-- one policy function, and the member list and count are read only through the functions below, which check the
-- caller's role themselves and refuse otherwise.
--
-- Also: invite links and join requests, polls (with quiz mode), mentions, mute (per user and chat), the system
-- permissions an admin manages per user (O-21: create groups, create channels, schedule messages), and the
-- permanent membership history (D-17).

-------------------------------------------------------------------------------------------------------
-- Conversations and members
-------------------------------------------------------------------------------------------------------
alter table app.conversations drop constraint conversations_type_check;
alter table app.conversations add constraint conversations_type_check check (type in ('private', 'group'));
alter table app.conversations add column title text check (title is null or char_length(title) between 1 and 128);
alter table app.conversations add column description text check (description is null or char_length(description) <= 255);
alter table app.conversations add column photo_key text check (photo_key is null or length(photo_key) <= 300);
-- A deleted group keeps its messages (history) but nobody can open it any more.
alter table app.conversations add column deleted_at timestamptz;
alter table app.conversations add constraint conversations_group_title check (type <> 'group' or title is not null);

alter table app.conversation_members add column role text not null default 'member' check (role in ('owner', 'admin', 'member'));
-- Admin rights (groups): only for admins; the owner holds every right.
alter table app.conversation_members add column admin_rights text[] not null default '{}' check (
  admin_rights <@ array['change_info', 'delete_messages', 'restrict_members', 'invite_users', 'approve_requests', 'pin_messages', 'manage_admins', 'change_privacy']::text[]
);
-- Restrictions (groups): permissions taken from this member until a time (null: until lifted).
alter table app.conversation_members add column denied_permissions text[] not null default '{}' check (
  denied_permissions <@ array['send_messages', 'send_media', 'send_stickers', 'send_polls', 'add_members', 'pin_messages', 'change_info']::text[]
);
alter table app.conversation_members add column restricted_until timestamptz;
alter table app.conversation_members add constraint conversation_members_admin_rights check (role = 'admin' or admin_rights = '{}');
create unique index conversation_members_one_owner on app.conversation_members (conversation_id) where role = 'owner';
create index conversation_members_staff_idx on app.conversation_members (conversation_id) where role in ('owner', 'admin');

create table app.group_settings (
  conversation_id      uuid primary key references app.conversations (id),
  -- What every member may do (an admin can restrict one member further).
  default_permissions  text[] not null default array['send_messages', 'send_media', 'send_stickers', 'send_polls', 'add_members', 'pin_messages']::text[] check (
    default_permissions <@ array['send_messages', 'send_media', 'send_stickers', 'send_polls', 'add_members', 'pin_messages', 'change_info']::text[]
  ),
  -- O-04: member privacy, two switches. Owners and admins always see both.
  hide_member_count    boolean not null default false,
  hide_member_list     boolean not null default false,
  updated_at           timestamptz not null default now()
);
create trigger group_settings_set_updated_at before update on app.group_settings
  for each row execute function app.set_updated_at();

-------------------------------------------------------------------------------------------------------
-- Invite links and join requests
-------------------------------------------------------------------------------------------------------
create table app.invite_links (
  id                 uuid primary key default extensions.gen_random_uuid(),
  conversation_id    uuid not null references app.conversations (id),
  -- The secret part of https://bedochat.com/?join=<code>; only admins who may invite see it.
  code               text not null unique check (code ~ '^[A-Za-z0-9_-]{22}$'),
  name               text check (name is null or char_length(name) between 1 and 32),
  created_by         uuid not null references app.users (id),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz,
  usage_limit        integer check (usage_limit is null or usage_limit between 1 and 100000),
  usage_count        integer not null default 0 check (usage_count >= 0),
  -- Joining through this link creates a join request an admin approves.
  requires_approval  boolean not null default false,
  revoked_at         timestamptz
);
create index invite_links_conversation_idx on app.invite_links (conversation_id, created_at desc);

create table app.join_requests (
  id               uuid primary key default extensions.gen_random_uuid(),
  conversation_id  uuid not null references app.conversations (id),
  user_id          uuid not null references app.users (id),
  invite_link_id   uuid references app.invite_links (id),
  requested_at     timestamptz not null default now(),
  status           text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  decided_by       uuid references app.users (id),
  decided_at       timestamptz,
  constraint join_requests_decided check ((status = 'pending') = (decided_at is null))
);
create unique index join_requests_one_pending on app.join_requests (conversation_id, user_id) where status = 'pending';
create index join_requests_pending_idx on app.join_requests (conversation_id, requested_at) where status = 'pending';

-------------------------------------------------------------------------------------------------------
-- Polls (with quiz mode) and mentions
-------------------------------------------------------------------------------------------------------
create table app.polls (
  id               uuid primary key default extensions.gen_random_uuid(),
  conversation_id  uuid not null references app.conversations (id),
  created_by       uuid not null references app.users (id),
  question         text not null check (char_length(question) between 1 and 300),
  options          text[] not null check (cardinality(options) between 2 and 10),
  kind             text not null check (kind in ('regular', 'quiz')),
  -- Anonymous polls never expose who voted (blueprint: data model).
  anonymous        boolean not null,
  multiple         boolean not null,
  -- Quiz: the index of the right answer and an optional explanation, shown after answering.
  correct_option   smallint,
  explanation      text check (explanation is null or char_length(explanation) <= 200),
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  constraint polls_quiz check (
    (kind = 'quiz') = (correct_option is not null)
    and (kind = 'quiz' or explanation is null)
    and (kind <> 'quiz' or (not multiple and correct_option between 0 and cardinality(options) - 1))
  )
);

create table app.poll_votes (
  poll_id     uuid not null references app.polls (id),
  user_id     uuid not null references app.users (id),
  options     smallint[] not null check (cardinality(options) between 1 and 10),
  voted_at    timestamptz not null default now(),
  primary key (poll_id, user_id)
);

alter table app.messages add column poll_id uuid references app.polls (id);
alter table app.messages drop constraint messages_kind_check;
alter table app.messages add constraint messages_kind_check check (kind in ('text', 'media', 'sticker', 'poll'));
alter table app.messages drop constraint messages_kind_content;
alter table app.messages add constraint messages_kind_content check (
  (kind = 'media') = (file_id is not null)
  and (kind = 'sticker') = (sticker_id is not null)
  and (kind = 'poll') = (poll_id is not null)
  and (kind not in ('sticker', 'poll') or text is null)
);
alter table app.messages drop constraint messages_content;
alter table app.messages add constraint messages_content check (
  deleted_at is not null or text is not null or file_id is not null or sticker_id is not null or poll_id is not null
);
alter table audit.message_revisions add column poll_id uuid;
alter table audit.message_revisions drop constraint message_revisions_previous_text;
alter table audit.message_revisions add constraint message_revisions_previous_text check (
  action = 'deleted_for_me' or previous_text is not null or file_id is not null or sticker_id is not null or poll_id is not null
);

-- Who a message mentions (@username of a member): highlights and, from Phase 7, notifications.
create table app.message_mentions (
  message_id       uuid not null references app.messages (id),
  conversation_id  uuid not null references app.conversations (id),
  user_id          uuid not null references app.users (id),
  primary key (message_id, user_id)
);
create index message_mentions_user_idx on app.message_mentions (user_id, conversation_id);

-------------------------------------------------------------------------------------------------------
-- Mute, system permissions (O-21)
-------------------------------------------------------------------------------------------------------
alter table app.user_chat_state add column muted_until timestamptz;

create table app.user_permissions (
  user_id            uuid primary key references app.users (id),
  create_groups      boolean not null default true,
  create_channels    boolean not null default false,
  schedule_messages  boolean not null default false,
  updated_by         uuid references app.admin_accounts (id),
  updated_at         timestamptz not null default now()
);
comment on table app.user_permissions is
  'System permissions per user (O-21), changed by admins. A user without a row has the defaults.';

-------------------------------------------------------------------------------------------------------
-- Membership history (D-17): permanent, append-only, ids only (no foreign keys that could remove it).
-------------------------------------------------------------------------------------------------------
create table audit.membership_events (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null,
  user_id          uuid not null,
  action           text not null check (action in (
                     'created', 'joined', 'added', 'left', 'removed', 'restricted', 'unrestricted',
                     'promoted', 'demoted', 'rights_changed', 'ownership_received', 'ownership_given', 'request_approved',
                     'request_declined')),
  actor_type       text not null check (actor_type in ('user', 'admin', 'system')),
  actor_id         uuid,
  details          jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  occurred_at      timestamptz not null default now()
);
create index membership_events_conversation_idx on audit.membership_events (conversation_id, occurred_at desc);
create index membership_events_user_idx on audit.membership_events (user_id, occurred_at desc);
create trigger membership_events_no_update_delete before update or delete on audit.membership_events
  for each row execute function app.forbid_mutation();
create trigger membership_events_no_truncate before truncate on audit.membership_events
  for each statement execute function app.forbid_mutation();

-------------------------------------------------------------------------------------------------------
-- Member privacy (§7): the member list and count are read only through these functions. Each checks that the
-- caller is the owner or an admin of the group, or that the group shows that information to members; otherwise
-- it raises an error. They run with the owner's rights, so they work the same for every caller.
-------------------------------------------------------------------------------------------------------
create function app.can_view_members(p_viewer uuid, p_group uuid, p_what text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.conversation_members m
    join app.conversations c on c.id = m.conversation_id and c.type = 'group' and c.deleted_at is null
    left join app.group_settings s on s.conversation_id = c.id
    where m.conversation_id = p_group and m.user_id = p_viewer
      and (m.role in ('owner', 'admin')
           or (p_what = 'list' and not coalesce(s.hide_member_list, false))
           or (p_what = 'count' and not coalesce(s.hide_member_count, false)))
  );
$$;

create function app.group_member_count(p_viewer uuid, p_group uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.can_view_members(p_viewer, p_group, 'count') then
    raise exception 'member count of % is hidden from %', p_group, p_viewer using errcode = 'insufficient_privilege';
  end if;
  return (select count(*)::integer from app.conversation_members where conversation_id = p_group);
end;
$$;

create function app.group_members(p_viewer uuid, p_group uuid, p_after_user uuid, p_limit integer)
returns table (user_id uuid, role text, admin_rights text[], denied_permissions text[], restricted_until timestamptz, joined_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.can_view_members(p_viewer, p_group, 'list') then
    raise exception 'member list of % is hidden from %', p_group, p_viewer using errcode = 'insufficient_privilege';
  end if;
  return query
    select m.user_id, m.role, m.admin_rights, m.denied_permissions, m.restricted_until, m.joined_at
    from app.conversation_members m
    where m.conversation_id = p_group and (p_after_user is null or m.user_id > p_after_user)
    order by m.user_id
    limit least(greatest(p_limit, 1), 200);
end;
$$;

-------------------------------------------------------------------------------------------------------
-- Runtime privileges (bedo_runtime)
-------------------------------------------------------------------------------------------------------
grant update (title, description, photo_key, deleted_at) on app.conversations to bedo_runtime;
grant update (role, admin_rights, denied_permissions, restricted_until) on app.conversation_members to bedo_runtime;
-- Delete: a member leaves or is removed (recorded in audit.membership_events in the same transaction).
grant delete on app.conversation_members to bedo_runtime;
grant select, insert, update on app.group_settings to bedo_runtime;
grant select, insert, update on app.invite_links to bedo_runtime;
grant select, insert, update on app.join_requests to bedo_runtime;
grant select, insert, update on app.polls to bedo_runtime;
grant select, insert, delete on app.poll_votes to bedo_runtime;
grant select, insert on app.message_mentions to bedo_runtime;
grant select, insert, update on app.user_permissions to bedo_runtime;
grant select, insert on audit.membership_events to bedo_runtime;
grant execute on function app.can_view_members(uuid, uuid, text) to bedo_runtime;
grant execute on function app.group_member_count(uuid, uuid) to bedo_runtime;
grant execute on function app.group_members(uuid, uuid, uuid, integer) to bedo_runtime;
-- Default privileges give new functions to PUBLIC; these are for the runtime role only.
revoke execute on function app.can_view_members(uuid, uuid, text) from public;
revoke execute on function app.group_member_count(uuid, uuid) from public;
revoke execute on function app.group_members(uuid, uuid, uuid, integer) from public;
