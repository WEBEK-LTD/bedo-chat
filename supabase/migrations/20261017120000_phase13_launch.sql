-- Bedo Chat - Phase 13: launch as a website (D-46).
--
-- Web Push keys made by the API itself (no variables to set), and narrower database rights for the runtime role
-- on accounts and sessions (left from the Phase 9 security review).

-- The Web Push (VAPID) key pair of the site: one row, made by the API the first time a notification or a browser
-- needs it, then never changed (browsers subscribed with this public key). The private key is encrypted with
-- SETTINGS_ENCRYPTION_KEY like the Waabek and GIPHY keys.
create table app.push_keys (
  id               boolean primary key default true check (id),
  public_key       text not null check (public_key ~ '^[A-Za-z0-9_-]{80,100}$'),
  private_key_enc  text not null check (length(private_key_enc) between 40 and 1000),
  created_at       timestamptz not null default now()
);
comment on table app.push_keys is
  'The site''s Web Push key pair (D-46). One row, never changed; the private key is stored only encrypted.';
create trigger push_keys_no_update_delete before update or delete on app.push_keys
  for each row execute function app.forbid_mutation();
create trigger push_keys_no_truncate before truncate on app.push_keys
  for each statement execute function app.forbid_mutation();
grant select, insert on app.push_keys to bedo_runtime;

-- Accounts and sessions: the runtime role may change only the columns the API changes. An account's id and
-- creation time, and a session's id, owner, platform and start, can no longer be changed by the application.
revoke update on app.users from bedo_runtime;
grant update (phone, name, username, bio, photo_key, status, updated_at, deleted_at) on app.users to bedo_runtime;
revoke update on app.sessions from bedo_runtime;
grant update (refresh_hash, previous_refresh_hash, device_name, ip, user_agent, last_used_at, expires_at, revoked_at, revoke_reason)
  on app.sessions to bedo_runtime;
