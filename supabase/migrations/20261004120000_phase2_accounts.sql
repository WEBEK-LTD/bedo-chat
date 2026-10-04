-- Bedo Chat - Phase 2: accounts, sessions, admin accounts and the permanent audit history.
--
-- Blueprint references: D-06 (academy phone list), D-08 (custom auth), D-12 (2-Step reset by admin),
-- D-13 (login alerts), D-14 (deletion with admin approval), D-17 (permanent audit history),
-- D-19 (admin accounts), D-21 (push), D-23 (Phase 2 parameters P-01..P-15).
--
-- Privileges: the API and worker connect as a member of bedo_runtime (baseline migration). Every table
-- below grants bedo_runtime only what the application needs. Audit tables are INSERT + SELECT only and
-- additionally refuse UPDATE, DELETE and TRUNCATE through triggers, so history can never be rewritten.

-------------------------------------------------------------------------------------------------------
-- Academy phone list (D-06): only these numbers can create or activate an account.
-------------------------------------------------------------------------------------------------------
create table app.academy_phone_list (
  phone       text primary key check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  note        text check (note is null or length(note) between 1 and 200),
  added_by    uuid not null,
  added_at    timestamptz not null default now()
);
comment on table app.academy_phone_list is 'Phone numbers (E.164) allowed to sign in. Added or imported by system admins only.';

-------------------------------------------------------------------------------------------------------
-- System admin accounts (D-19), separate from student accounts.
-------------------------------------------------------------------------------------------------------
create table app.admin_accounts (
  id                  uuid primary key default extensions.gen_random_uuid(),
  phone               text not null unique check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  name                text not null check (length(name) between 1 and 64),
  role                text not null check (role in ('super_admin', 'moderator')),
  -- Authenticator-app secret, encrypted by the application (AES-256-GCM, key ADMIN_TOTP_KEY).
  totp_secret_enc     text not null,
  totp_confirmed_at   timestamptz,
  -- Last accepted TOTP time step; a code can never be used twice.
  totp_last_step      bigint,
  status              text not null default 'active' check (status in ('active', 'disabled')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger admin_accounts_set_updated_at before update on app.admin_accounts
  for each row execute function app.set_updated_at();

create table app.admin_sessions (
  id              uuid primary key default extensions.gen_random_uuid(),
  admin_id        uuid not null references app.admin_accounts (id),
  token_hash      text not null unique,
  created_at      timestamptz not null default now(),
  last_active_at  timestamptz not null default now(),
  expires_at      timestamptz not null,
  ip              inet,
  user_agent      text check (user_agent is null or length(user_agent) <= 1000),
  revoked_at      timestamptz
);
create index admin_sessions_admin_idx on app.admin_sessions (admin_id) where revoked_at is null;

-------------------------------------------------------------------------------------------------------
-- Student accounts.
-------------------------------------------------------------------------------------------------------
create table app.users (
  id          uuid primary key default extensions.gen_random_uuid(),
  -- Cleared when a deletion is approved; the original identity is kept in audit.identity_history.
  phone       text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  name        text check (name is null or length(name) between 1 and 64),
  username    extensions.citext check (username is null or username::text ~ '^[A-Za-z][A-Za-z0-9_]{4,31}$'),
  bio         text check (bio is null or length(bio) <= 140),
  photo_key   text check (photo_key is null or length(photo_key) <= 300),
  status      text not null default 'active'
                check (status in ('active', 'suspended', 'banned', 'deletion_requested', 'deleted')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint users_phone_required check (status = 'deleted' or phone is not null),
  constraint users_deleted_has_no_identity check (
    status <> 'deleted' or (phone is null and name is null and username is null and bio is null and photo_key is null)
  )
);
create unique index users_phone_key on app.users (phone) where phone is not null;
create unique index users_username_key on app.users (username) where username is not null;
create trigger users_set_updated_at before update on app.users
  for each row execute function app.set_updated_at();

create table app.user_privacy (
  user_id               uuid primary key references app.users (id),
  phone_visibility      text not null default 'nobody'   check (phone_visibility in ('everyone', 'nobody')),
  last_seen_visibility  text not null default 'everyone' check (last_seen_visibility in ('everyone', 'nobody')),
  photo_visibility      text not null default 'everyone' check (photo_visibility in ('everyone', 'nobody')),
  messages_from         text not null default 'everyone' check (messages_from in ('everyone', 'nobody')),
  calls_from            text not null default 'everyone' check (calls_from in ('everyone', 'nobody')),
  updated_at            timestamptz not null default now()
);
create trigger user_privacy_set_updated_at before update on app.user_privacy
  for each row execute function app.set_updated_at();

create table app.sessions (
  id                     uuid primary key default extensions.gen_random_uuid(),
  user_id                uuid not null references app.users (id),
  refresh_hash           text not null unique,
  -- The token that was rotated out last; presenting it again means it was stolen (reuse detection).
  previous_refresh_hash  text,
  device_name            text check (device_name is null or length(device_name) <= 100),
  platform               text not null check (platform in ('web', 'ios', 'android', 'desktop')),
  ip                     inet,
  user_agent             text check (user_agent is null or length(user_agent) <= 1000),
  created_at             timestamptz not null default now(),
  last_used_at           timestamptz not null default now(),
  expires_at             timestamptz not null,
  revoked_at             timestamptz,
  revoke_reason          text check (revoke_reason is null or revoke_reason in
                           ('logout', 'terminated_by_user', 'terminated_other_sessions', 'refresh_reuse',
                            'account_deleted', 'account_blocked', 'phone_changed'))
);
create index sessions_user_active_idx on app.sessions (user_id) where revoked_at is null;
create index sessions_previous_refresh_idx on app.sessions (previous_refresh_hash) where previous_refresh_hash is not null;

-- Every refresh token a session has rotated out. Presenting any of them again (after the short grace
-- window for the most recent one) means a copy exists, and the session is ended (reuse detection).
create table app.retired_refresh_tokens (
  token_hash  text primary key,
  session_id  uuid not null references app.sessions (id),
  retired_at  timestamptz not null default now()
);
create index retired_refresh_tokens_session_idx on app.retired_refresh_tokens (session_id);

create table app.otp_challenges (
  id           uuid primary key default extensions.gen_random_uuid(),
  phone        text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  purpose      text not null check (purpose in ('sign_in', 'change_phone', 'admin_sign_in')),
  -- HMAC-SHA256 of the code; the plain code is never stored.
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     integer not null default 0 check (attempts >= 0),
  locked_at    timestamptz,
  consumed_at  timestamptz,
  ip           inet,
  -- Phone change: the account that asked for the code; only that account can use it.
  requested_by uuid references app.users (id),
  -- False for a number that may not receive a code: the challenge exists only so that answers and
  -- limits are identical, and it can never succeed.
  delivered    boolean not null,
  created_at   timestamptz not null default now()
);
create index otp_challenges_phone_idx on app.otp_challenges (phone, purpose, created_at desc);

create table app.two_step (
  user_id        uuid primary key references app.users (id),
  password_hash  text not null,
  hint           text check (hint is null or length(hint) between 1 and 64),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger two_step_set_updated_at before update on app.two_step
  for each row execute function app.set_updated_at();

create table app.account_deletion_requests (
  id               uuid primary key default extensions.gen_random_uuid(),
  user_id          uuid not null references app.users (id),
  requested_at     timestamptz not null default now(),
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by       uuid references app.admin_accounts (id),
  decided_at       timestamptz,
  decision_reason  text check (decision_reason is null or length(decision_reason) between 1 and 500),
  constraint deletion_decision_complete check (
    (status = 'pending' and decided_by is null and decided_at is null)
    or (status <> 'pending' and decided_by is not null and decided_at is not null)
  )
);
create unique index deletion_requests_one_pending on app.account_deletion_requests (user_id) where status = 'pending';

create table app.security_notices (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references app.users (id),
  kind        text not null check (kind in ('new_login', 'deletion_requested', 'deletion_rejected', 'two_step_reset')),
  -- Session that caused the notice (e.g. the new login); that session does not show it.
  session_id  uuid references app.sessions (id),
  details     jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index security_notices_user_idx on app.security_notices (user_id, created_at desc);

create table app.push_subscriptions (
  id          uuid primary key default extensions.gen_random_uuid(),
  user_id     uuid not null references app.users (id),
  session_id  uuid not null references app.sessions (id),
  endpoint    text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 2000),
  p256dh      text not null check (length(p256dh) <= 200),
  auth        text not null check (length(auth) <= 100),
  created_at  timestamptz not null default now()
);
create index push_subscriptions_user_idx on app.push_subscriptions (user_id);
create unique index push_subscriptions_session_key on app.push_subscriptions (session_id);

-------------------------------------------------------------------------------------------------------
-- Permanent audit history (D-17). Append-only; never references rows with foreign keys, so nothing
-- that happens to an account can remove its history.
-------------------------------------------------------------------------------------------------------
create schema if not exists audit;
revoke all on schema audit from public;

create table audit.identity_history (
  id          bigint generated always as identity primary key,
  user_id     uuid not null,
  field       text not null check (field in ('phone', 'name', 'username', 'bio', 'photo')),
  old_value   text,
  new_value   text,
  actor_type  text not null check (actor_type in ('user', 'admin', 'system')),
  actor_id    uuid,
  changed_at  timestamptz not null default now()
);
create index identity_history_user_idx on audit.identity_history (user_id, changed_at desc);

create table audit.account_events (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  event        text not null check (event in (
                 'created', 'deletion_requested', 'deletion_approved', 'deletion_rejected', 'deleted')),
  actor_type   text not null check (actor_type in ('user', 'admin', 'system')),
  actor_id     uuid,
  reason       text check (reason is null or length(reason) <= 500),
  details      jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  occurred_at  timestamptz not null default now()
);
create index account_events_user_idx on audit.account_events (user_id, occurred_at desc);

create table audit.security_events (
  id           bigint generated always as identity primary key,
  subject_type text not null check (subject_type in ('user', 'admin', 'phone')),
  -- user id, admin id, or null for events about a phone number with no account
  subject_id   uuid,
  phone        text,
  event        text not null check (length(event) between 1 and 60),
  session_id   uuid,
  ip           inet,
  user_agent   text check (user_agent is null or length(user_agent) <= 1000),
  details      jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  occurred_at  timestamptz not null default now()
);
create index security_events_subject_idx on audit.security_events (subject_type, subject_id, occurred_at desc);
create index security_events_phone_idx on audit.security_events (phone, occurred_at desc) where phone is not null;

-- Admin actions use app.audit_log (baseline migration, actor_type = 'admin').

do $$
declare
  t text;
begin
  foreach t in array array['identity_history', 'account_events', 'security_events'] loop
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
-- Runtime privileges (bedo_runtime). Nothing here allows DELETE on accounts or any history.
-------------------------------------------------------------------------------------------------------
grant usage on schema audit to bedo_runtime;
grant select, insert on audit.identity_history, audit.account_events, audit.security_events to bedo_runtime;

grant select, insert on app.academy_phone_list to bedo_runtime;
grant select on app.admin_accounts to bedo_runtime;
grant update (totp_confirmed_at, totp_last_step) on app.admin_accounts to bedo_runtime;
grant select, insert on app.admin_sessions to bedo_runtime;
grant update (last_active_at, revoked_at) on app.admin_sessions to bedo_runtime;
grant select, insert, update on app.users to bedo_runtime;
grant select, insert, update on app.user_privacy to bedo_runtime;
grant select, insert, update on app.sessions to bedo_runtime;
-- Delete: the worker removes retired token hashes once they can no longer matter (session ended, or
-- older than the 30-day idle limit). They are security bookkeeping, not history.
grant select, insert, delete on app.retired_refresh_tokens to bedo_runtime;
grant select, insert, update on app.otp_challenges to bedo_runtime;
grant select, insert, update, delete on app.two_step to bedo_runtime;
grant select, insert on app.account_deletion_requests to bedo_runtime;
grant update (status, decided_by, decided_at, decision_reason) on app.account_deletion_requests to bedo_runtime;
grant select, insert on app.security_notices to bedo_runtime;
grant update (read_at) on app.security_notices to bedo_runtime;
grant select, insert, delete on app.push_subscriptions to bedo_runtime;

-------------------------------------------------------------------------------------------------------
-- Profile pictures (P-07, P-15): private Supabase Storage bucket. Only on Supabase, where the storage
-- schema exists; plain Postgres (local development, CI) skips this block.
-------------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('profile-photos', 'profile-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end
$$;
