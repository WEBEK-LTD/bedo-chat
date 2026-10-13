-- Bedo Chat - Phase 10: the rest of the Admin Dashboard (D-44; spec §22, O-18, O-20).
--
-- Users: suspend, ban, reactivate, end sessions, delete (with the permanent account history). Messages: reports get
-- a decision (dismissed, message removed, user suspended or banned) in an append-only table, and a moderator can
-- remove a reported message for everyone (recorded in the message history with the admin who did it; O-18: admins
-- read reported messages and the audit history only). System: broadcast notifications to everyone or to the members
-- of one group or channel (O-20), sent in batches by the scheduled function.

-- Account history: an admin suspends, bans or reactivates an account.
alter table audit.account_events drop constraint account_events_event_check;
alter table audit.account_events add constraint account_events_event_check check (event in (
  'created', 'deletion_requested', 'deletion_approved', 'deletion_rejected', 'deleted', 'suspended', 'banned', 'reactivated'));

-- An admin ends a user's sessions.
alter table app.sessions drop constraint sessions_revoke_reason_check;
alter table app.sessions add constraint sessions_revoke_reason_check check (revoke_reason is null or revoke_reason in
  ('logout', 'terminated_by_user', 'terminated_other_sessions', 'refresh_reuse', 'account_deleted', 'account_blocked',
   'phone_changed', 'ended_by_admin'));

-- A message an admin removed: deleted for everyone, by that admin (not by a user).
alter table app.messages add column removed_by_admin uuid references app.admin_accounts (id);
alter table app.messages drop constraint messages_deleted_by;
alter table app.messages add constraint messages_deleted_by check (
  (deleted_at is null) = (deleted_by is null and removed_by_admin is null) and (deleted_by is null or removed_by_admin is null)
);
grant update (removed_by_admin) on app.messages to bedo_runtime;

-- The decision on a report (reports themselves never change). One decision per report.
create table app.report_decisions (
  report_id   uuid primary key references app.reports (id),
  admin_id    uuid not null references app.admin_accounts (id),
  decision    text not null check (decision in ('dismissed', 'message_removed', 'user_suspended', 'user_banned')),
  note        text check (note is null or char_length(note) between 1 and 500),
  decided_at  timestamptz not null default now()
);
create trigger report_decisions_no_update_delete before update or delete on app.report_decisions
  for each row execute function app.forbid_mutation();
create trigger report_decisions_no_truncate before truncate on app.report_decisions
  for each statement execute function app.forbid_mutation();
grant select, insert on app.report_decisions to bedo_runtime;

-- A system admin removing someone from a group or channel bans them too (D-43), as that admin.
alter table app.chat_bans alter column banned_by drop not null;
alter table app.chat_bans add column banned_by_admin uuid references app.admin_accounts (id);
alter table app.chat_bans add constraint chat_bans_by check ((banned_by is null) <> (banned_by_admin is null));

-- O-20: notifications an admin sends to everyone or to one group's or channel's members.
create table app.broadcasts (
  id                    uuid primary key default extensions.gen_random_uuid(),
  admin_id              uuid not null references app.admin_accounts (id),
  title                 text not null check (char_length(title) between 1 and 100),
  body                  text not null check (char_length(body) between 1 and 300),
  audience              text not null check (audience in ('all', 'chat')),
  conversation_id       uuid references app.conversations (id),
  status                text not null default 'sending' check (status in ('sending', 'sent')),
  -- Sent in batches: the last push subscription reached, and how many devices were reached.
  last_subscription_id  uuid,
  devices               integer not null default 0,
  created_at            timestamptz not null default now(),
  finished_at           timestamptz,
  constraint broadcasts_audience_chat check ((audience = 'chat') = (conversation_id is not null))
);
create index broadcasts_sending_idx on app.broadcasts (created_at) where status = 'sending';
grant select, insert on app.broadcasts to bedo_runtime;
grant update (status, last_subscription_id, devices, finished_at) on app.broadcasts to bedo_runtime;
