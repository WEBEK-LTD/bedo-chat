-- Bedo Chat - Phase 3.1: initial Super Admin bootstrap and Admin Dashboard-managed OTP settings (D-32).
--
-- 1. Admin accounts are created by SQL without an authenticator secret. The server generates the secret
--    at the first sign-in (after the WhatsApp code) and stores it, encrypted with ADMIN_TOTP_KEY, only once
--    the admin has confirmed it with a code from the authenticator app.
-- 2. app.otp_settings holds the Waabek API key, encrypted by the application with AES-256-GCM
--    (SETTINGS_ENCRYPTION_KEY, which is never stored in the database). Every change raises `version`; the
--    worker compares it before each send, so a change applies everywhere without a restart.
-- 3. app.admin_bootstrap is the one-time initial setup: the owner runs app.open_admin_bootstrap() to get a
--    setup token (only its SHA-256 hash is stored) that lets the Admin Dashboard's sign-in page store the
--    first Waabek key. It closes permanently when the first Super Admin confirms their authenticator.
--
-- Privileges: the API and worker (members of bedo_runtime) get only what Phase 3.1 needs. They cannot open
-- the bootstrap, change a token, reopen a closed bootstrap, delete a settings row, or replace an existing
-- authenticator secret. The table owner (the migration / SQL editor role) keeps full control.

-------------------------------------------------------------------------------------------------------
-- Helpers
-------------------------------------------------------------------------------------------------------
-- True when the current role owns the table the trigger fired on (the migration / SQL editor role).
create or replace function app.is_table_owner(relid oid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from pg_catalog.pg_class c where c.oid = relid and c.relowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
  );
$$;

-- Refuses DELETE and TRUNCATE on single-row configuration tables.
create or replace function app.forbid_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'rows of %.% cannot be deleted', tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

-------------------------------------------------------------------------------------------------------
-- Admin accounts: no authenticator secret until the admin sets it up.
-------------------------------------------------------------------------------------------------------
alter table app.admin_accounts alter column totp_secret_enc drop not null;
comment on column app.admin_accounts.totp_secret_enc is
  'Authenticator-app secret, AES-256-GCM encrypted by the application (key ADMIN_TOTP_KEY). NULL for an account created by SQL until the admin sets up the authenticator at the first sign-in.';
alter table app.admin_accounts
  add constraint admin_accounts_confirmed_has_secret check (totp_confirmed_at is null or totp_secret_enc is not null);

-- The application may store a secret only where there is none; replacing or removing one is reserved for
-- the table owner (for example to reset a lost authenticator by SQL).
create or replace function app.admin_accounts_keep_totp_secret()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.totp_secret_enc is not null
     and new.totp_secret_enc is distinct from old.totp_secret_enc
     and not app.is_table_owner(tg_relid) then
    raise exception 'an admin authenticator secret can only be replaced by the table owner'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger admin_accounts_keep_totp_secret before update on app.admin_accounts
  for each row execute function app.admin_accounts_keep_totp_secret();

grant update (totp_secret_enc) on app.admin_accounts to bedo_runtime;

-------------------------------------------------------------------------------------------------------
-- OTP delivery settings (D-32): exactly one row.
-------------------------------------------------------------------------------------------------------
create table app.otp_settings (
  id                  boolean primary key default true check (id),
  provider            text not null default 'waabek' check (provider = 'waabek'),
  -- AES-256-GCM, base64(iv | tag | ciphertext), purpose-bound; encrypted and decrypted only by the API and
  -- the worker with SETTINGS_ENCRYPTION_KEY. NULL until the first key is set.
  waabek_api_key_enc  text check (waabek_api_key_enc is null or length(waabek_api_key_enc) between 40 and 4000),
  -- Raised by the trigger on every change; the worker re-reads the key only when it changes.
  version             bigint not null default 0,
  -- The Super Admin who set the key; NULL when it was set during the initial setup (bootstrap).
  updated_by          uuid references app.admin_accounts (id),
  -- How the key was last set: initial setup, a Super Admin in the dashboard, or an owner recovery (D-33).
  updated_via         text check (updated_via is null or updated_via in ('initial_setup', 'admin_dashboard', 'owner_recovery')),
  updated_at          timestamptz
);
comment on table app.otp_settings is
  'OTP delivery settings managed from the Admin Dashboard (D-32). One row. The Waabek API key is stored only encrypted.';
insert into app.otp_settings (id) values (true);

create or replace function app.otp_settings_bump_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;
create trigger otp_settings_bump_version before update on app.otp_settings
  for each row execute function app.otp_settings_bump_version();
create trigger otp_settings_no_delete before delete on app.otp_settings
  for each row execute function app.forbid_delete();
create trigger otp_settings_no_truncate before truncate on app.otp_settings
  for each statement execute function app.forbid_delete();

grant select on app.otp_settings to bedo_runtime;
grant update (waabek_api_key_enc, updated_by, updated_via) on app.otp_settings to bedo_runtime;

-------------------------------------------------------------------------------------------------------
-- Initial Super Admin setup (bootstrap): exactly one row, closed for good after first use.
-------------------------------------------------------------------------------------------------------
create table app.admin_bootstrap (
  id               boolean primary key default true check (id),
  -- SHA-256 (hex) of the setup token; the token itself is shown once to the owner and never stored.
  token_hash       text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  expires_at       timestamptz,
  failed_attempts  integer not null default 0 check (failed_attempts >= 0),
  opened_at        timestamptz,
  closed_at        timestamptz,
  -- The Super Admin whose authenticator confirmation closed the bootstrap.
  closed_by        uuid references app.admin_accounts (id),
  check ((token_hash is null) = (expires_at is null))
);
comment on table app.admin_bootstrap is
  'One-time initial setup of the first Super Admin (Phase 3.1). Opened only by the owner with app.open_admin_bootstrap(); closed permanently when the first Super Admin confirms their authenticator.';
insert into app.admin_bootstrap (id) values (true);

create or replace function app.admin_bootstrap_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.closed_at is not null then
    raise exception 'the initial admin setup is closed permanently'
      using errcode = 'insufficient_privilege';
  end if;
  if (new.token_hash is distinct from old.token_hash
      or new.expires_at is distinct from old.expires_at
      or new.opened_at is distinct from old.opened_at
      -- Wrong-token attempts can only be counted up; only a new token (owner) starts again at 0.
      or new.failed_attempts < old.failed_attempts)
     and not app.is_table_owner(tg_relid) then
    raise exception 'only the table owner can open the initial admin setup'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger admin_bootstrap_guard before update on app.admin_bootstrap
  for each row execute function app.admin_bootstrap_guard();
create trigger admin_bootstrap_no_delete before delete on app.admin_bootstrap
  for each row execute function app.forbid_delete();
create trigger admin_bootstrap_no_truncate before truncate on app.admin_bootstrap
  for each statement execute function app.forbid_delete();

grant select on app.admin_bootstrap to bedo_runtime;
grant update (failed_attempts, closed_at, closed_by) on app.admin_bootstrap to bedo_runtime;

-- Run by the owner in the SQL editor after creating the Super Admin account:
--   select * from app.open_admin_bootstrap();
-- Returns a setup token valid for 60 minutes. Running it again (before setup is complete) replaces the
-- token. Refused once any active Super Admin has a confirmed authenticator, and after the setup closed.
create or replace function app.open_admin_bootstrap()
returns table (setup_token text, expires_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  token text;
  expiry timestamptz := now() + interval '60 minutes';
  state app.admin_bootstrap%rowtype;
begin
  select * into state from app.admin_bootstrap where id for update;
  if state.closed_at is not null then
    raise exception 'The initial admin setup was completed on % and cannot be opened again.', state.closed_at;
  end if;
  if exists (
    select 1 from app.admin_accounts
    where role = 'super_admin' and status = 'active' and totp_confirmed_at is not null
  ) then
    raise exception 'A Super Admin with a confirmed authenticator already exists; the initial admin setup is not available.';
  end if;
  if not exists (
    select 1 from app.admin_accounts
    where role = 'super_admin' and status = 'active' and totp_secret_enc is null
  ) then
    raise exception 'Create the Super Admin account first (role super_admin, status active, no authenticator secret).';
  end if;

  -- 32 random bytes, URL-safe base64 without padding (43 characters).
  token := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  update app.admin_bootstrap
     set token_hash = encode(extensions.digest(token, 'sha256'), 'hex'),
         expires_at = expiry,
         failed_attempts = 0,
         opened_at = now()
   where id;
  insert into app.audit_log (actor_type, actor_id, action, target_type, metadata)
  values ('system', null, 'admin.bootstrap_opened', 'admin_bootstrap', jsonb_build_object('expiresAt', expiry));

  setup_token := token;
  expires_at := expiry;
  return next;
end;
$$;
revoke all on function app.open_admin_bootstrap() from public;
revoke all on function app.open_admin_bootstrap() from bedo_runtime;
comment on function app.open_admin_bootstrap() is
  'Owner only. Opens the one-time initial admin setup and returns its setup token (valid 60 minutes).';

-------------------------------------------------------------------------------------------------------
-- Owner-only Waabek key recovery (D-33): exactly one row.
-------------------------------------------------------------------------------------------------------
create table app.otp_settings_recovery (
  id               boolean primary key default true check (id),
  -- SHA-256 (hex) of the recovery token; the token itself is shown once to the owner and never stored.
  token_hash       text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  expires_at       timestamptz,
  failed_attempts  integer not null default 0 check (failed_attempts >= 0),
  opened_at        timestamptz,
  -- Set when the token has saved a key: each token saves one key only (test messages stay possible until it
  -- expires). Only the owner's function clears it, together with a new token.
  key_saved_at     timestamptz,
  check ((token_hash is null) = (expires_at is null))
);
comment on table app.otp_settings_recovery is
  'Owner-only recovery of the Waabek API key (D-33). Opened only by the owner with app.open_otp_settings_recovery(); allows saving a new key from the sign-in page, nothing else.';
insert into app.otp_settings_recovery (id) values (true);

create or replace function app.otp_settings_recovery_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.token_hash is distinct from old.token_hash
      or new.expires_at is distinct from old.expires_at
      or new.opened_at is distinct from old.opened_at
      -- Wrong-token attempts can only be counted up; only a new token (owner) starts again at 0.
      or new.failed_attempts < old.failed_attempts
      -- A used token stays used: the runtime role may only mark it used, never clear or move the mark.
      or (old.key_saved_at is not null and new.key_saved_at is distinct from old.key_saved_at))
     and not app.is_table_owner(tg_relid) then
    raise exception 'only the table owner can open a Waabek key recovery'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger otp_settings_recovery_guard before update on app.otp_settings_recovery
  for each row execute function app.otp_settings_recovery_guard();
create trigger otp_settings_recovery_no_delete before delete on app.otp_settings_recovery
  for each row execute function app.forbid_delete();
create trigger otp_settings_recovery_no_truncate before truncate on app.otp_settings_recovery
  for each statement execute function app.forbid_delete();

grant select on app.otp_settings_recovery to bedo_runtime;
grant update (failed_attempts, key_saved_at) on app.otp_settings_recovery to bedo_runtime;

-- Run by the owner in the SQL editor when the Waabek key no longer works and no admin can sign in:
--   select * from app.open_otp_settings_recovery();
-- Returns a one-time recovery token valid for 30 minutes: it can save one new key (and send test messages
-- until it expires). Running it again replaces the token. Available only after
-- the initial admin setup has closed (before that, app.open_admin_bootstrap() is the way in), and only
-- while an active Super Admin with a confirmed authenticator exists. It never opens or changes the
-- bootstrap, admin accounts, authenticator secrets or sessions, and it never sees or returns a key.
create or replace function app.open_otp_settings_recovery()
returns table (recovery_token text, expires_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  token text;
  expiry timestamptz := now() + interval '30 minutes';
begin
  perform 1 from app.otp_settings_recovery where id for update;
  if not exists (select 1 from app.admin_bootstrap where id and closed_at is not null) then
    raise exception 'The initial admin setup is not complete; use app.open_admin_bootstrap() instead.';
  end if;
  if not exists (
    select 1 from app.admin_accounts
    where role = 'super_admin' and status = 'active' and totp_confirmed_at is not null
  ) then
    raise exception 'No active Super Admin with a confirmed authenticator exists.';
  end if;

  -- 32 random bytes, URL-safe base64 without padding (43 characters).
  token := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  update app.otp_settings_recovery
     set token_hash = encode(extensions.digest(token, 'sha256'), 'hex'),
         expires_at = expiry,
         failed_attempts = 0,
         opened_at = now(),
         key_saved_at = null
   where id;
  insert into app.audit_log (actor_type, actor_id, action, target_type, metadata)
  values ('system', null, 'otp_settings.recovery_opened', 'otp_settings', jsonb_build_object('expiresAt', expiry));

  recovery_token := token;
  expires_at := expiry;
  return next;
end;
$$;
revoke all on function app.open_otp_settings_recovery() from public;
revoke all on function app.open_otp_settings_recovery() from bedo_runtime;
comment on function app.open_otp_settings_recovery() is
  'Owner only (D-33). Opens a Waabek key recovery and returns its one-time token (valid 30 minutes). Signs nobody in.';

-- On Supabase, make sure no Data API role can run either function (the app schema is already closed to them).
do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = client_role) then
      execute format('revoke all on function app.open_admin_bootstrap() from %I', client_role);
      execute format('revoke all on function app.open_otp_settings_recovery() from %I', client_role);
    end if;
  end loop;
end
$$;
