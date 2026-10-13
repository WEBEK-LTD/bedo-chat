-- Bedo Chat - Phase 3.2: admin password sign-in (D-34).
--
-- Admin login is Phone + Password -> authenticator (TOTP) code -> admin session. The password is hashed by
-- the API with Argon2id (the same parameters as the 2-Step Verification passwords); the database stores only
-- the encoded hash. The initial password and every reset go through a one-time setup token that only the
-- table owner can issue (app.issue_admin_password_setup); the token is entered on the /admin/login Set Password
-- panel, which never signs anyone in. A reset revokes the old password and ends all of the admin's sessions.
--
-- Privileges: the runtime role (API) may store a password hash and mark a setup token as used or count a wrong
-- token; it cannot issue, extend or reopen a token, lower the attempt count, or run the owner function.

-------------------------------------------------------------------------------------------------------
-- Admin accounts: password hash.
-------------------------------------------------------------------------------------------------------
alter table app.admin_accounts
  add column password_hash text check (password_hash is null or (password_hash like '$argon2id$%' and length(password_hash) <= 512)),
  add column password_changed_at timestamptz;
comment on column app.admin_accounts.password_hash is
  'Argon2id hash (PHC string) of the admin password (D-34). NULL until the admin sets one with an owner-issued setup token.';

-- Every change of the hash records when it happened; the application cannot choose the time.
create or replace function app.admin_accounts_password_changed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.password_hash is distinct from old.password_hash then
    new.password_changed_at := now();
  else
    new.password_changed_at := old.password_changed_at;
  end if;
  return new;
end;
$$;
create trigger admin_accounts_password_changed before update on app.admin_accounts
  for each row execute function app.admin_accounts_password_changed();

grant update (password_hash) on app.admin_accounts to bedo_runtime;

-------------------------------------------------------------------------------------------------------
-- Owner-issued password setup tokens: at most one per admin.
-------------------------------------------------------------------------------------------------------
create table app.admin_password_setup (
  admin_id         uuid primary key references app.admin_accounts (id),
  -- SHA-256 (hex) of the setup token; the token itself is shown once to the owner and never stored.
  token_hash       text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at       timestamptz not null,
  failed_attempts  integer not null default 0 check (failed_attempts >= 0),
  issued_at        timestamptz not null default now(),
  -- Whether the token replaced an existing password (a reset) rather than setting the first one.
  is_reset         boolean not null default false,
  -- Set when the token has set a password: each token sets one password only.
  used_at          timestamptz
);
comment on table app.admin_password_setup is
  'One-time admin password setup tokens (D-34), issued only by the owner with app.issue_admin_password_setup().';

create or replace function app.admin_password_setup_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.is_table_owner(tg_relid) then
    return new;
  end if;
  if new.admin_id is distinct from old.admin_id
     or new.token_hash is distinct from old.token_hash
     or new.expires_at is distinct from old.expires_at
     or new.issued_at is distinct from old.issued_at
     or new.is_reset is distinct from old.is_reset
     -- Wrong-token attempts can only be counted up.
     or new.failed_attempts < old.failed_attempts
     -- A used token stays used.
     or (old.used_at is not null and new.used_at is distinct from old.used_at) then
    raise exception 'only the table owner can issue an admin password setup token'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger admin_password_setup_guard before update on app.admin_password_setup
  for each row execute function app.admin_password_setup_guard();

grant select on app.admin_password_setup to bedo_runtime;
grant update (failed_attempts, used_at) on app.admin_password_setup to bedo_runtime;

-- Run by the owner in the SQL editor:
--   select * from app.issue_admin_password_setup('<admin-phone>');
-- Returns a one-time setup token valid for 60 minutes for that active admin. If the admin already has a
-- password, this is a reset: the old password stops working and every session of that admin ends at once.
-- Running it again replaces the token. It never sees, sets or returns a password.
create or replace function app.issue_admin_password_setup(admin_phone text)
returns table (setup_token text, expires_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  token text;
  expiry timestamptz := now() + interval '60 minutes';
  account app.admin_accounts%rowtype;
  reset boolean;
  ended integer;
begin
  select * into account from app.admin_accounts where phone = admin_phone for update;
  if not found then
    raise exception 'No admin account has the phone number %. Use the E.164 form, for example +905xxxxxxxxx.', admin_phone;
  end if;
  if account.status <> 'active' then
    raise exception 'The admin account % is not active.', admin_phone;
  end if;
  reset := account.password_hash is not null;

  -- 32 random bytes, URL-safe base64 without padding (43 characters).
  token := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  insert into app.admin_password_setup as s (admin_id, token_hash, expires_at, failed_attempts, issued_at, is_reset, used_at)
  values (account.id, encode(extensions.digest(token, 'sha256'), 'hex'), expiry, 0, now(), reset, null)
  on conflict (admin_id) do update
    set token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        failed_attempts = 0,
        issued_at = excluded.issued_at,
        is_reset = excluded.is_reset,
        used_at = null;

  ended := 0;
  if reset then
    update app.admin_accounts set password_hash = null where id = account.id;
    update app.admin_sessions set revoked_at = now() where admin_id = account.id and revoked_at is null;
    get diagnostics ended = row_count;
  end if;

  insert into app.audit_log (actor_type, actor_id, action, target_type, target_id, metadata)
  values ('system', null, case when reset then 'admin.password_reset_issued' else 'admin.password_setup_issued' end,
          'admin', account.id::text, jsonb_build_object('expiresAt', expiry, 'sessionsEnded', ended));
  insert into audit.security_events (subject_type, subject_id, event, details)
  values ('admin', account.id, case when reset then 'admin_password_reset_issued' else 'admin_password_setup_issued' end,
          jsonb_build_object('sessionsEnded', ended));

  setup_token := token;
  expires_at := expiry;
  return next;
end;
$$;
revoke all on function app.issue_admin_password_setup(text) from public;
revoke all on function app.issue_admin_password_setup(text) from bedo_runtime;
comment on function app.issue_admin_password_setup(text) is
  'Owner only (D-34). Issues a one-time admin password setup token (valid 60 minutes); a reset also ends the old password and all sessions.';

do $$
declare
  client_role text;
begin
  foreach client_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = client_role) then
      execute format('revoke all on function app.issue_admin_password_setup(text) from %I', client_role);
    end if;
  end loop;
end
$$;
