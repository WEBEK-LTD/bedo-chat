-- Bedo Chat - Phase 7: notifications (D-41).
--
-- Push notifications for new messages in private chats, groups and channels, mentions, replies, and being added to
-- a group or channel; built on the Phase 2 Web Push pipeline (D-21) and sent by the API right after the change
-- (D-36: no worker). O-19: mentions and replies still notify inside a muted chat; pushes show the sender and the text
-- unless the person turns previews off. A device showing the chat is not pushed; every push carries the badge count
-- (unread messages in chats that are not muted), computed on the server so every device shows the same number.

-- Which chat a device is showing right now (its page visible), so it is not pushed about that chat. Like the rest
-- of the row it expires 60 seconds after the device's last heartbeat.
alter table app.presence_devices add column viewing_chat_id uuid;

-- Per-user notification settings (a user without a row has the defaults).
create table app.notification_settings (
  user_id        uuid primary key references app.users (id),
  private_chats  boolean not null default true,
  groups         boolean not null default true,
  channels       boolean not null default true,
  -- O-19: show the sender and the text in pushes (off: "New message" only).
  previews       boolean not null default true,
  updated_at     timestamptz not null default now()
);
create trigger notification_settings_set_updated_at before update on app.notification_settings
  for each row execute function app.set_updated_at();
comment on table app.notification_settings is
  'Notification settings per user (Phase 7, D-41). Mentions and replies notify even where a category is off or a chat is muted (O-19).';

grant select, insert, update on app.notification_settings to bedo_runtime;
