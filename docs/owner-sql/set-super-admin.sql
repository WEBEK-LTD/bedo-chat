-- Bedo Chat: create or update ONE Super Admin with a password, from the Supabase SQL Editor (D-35).
-- Change the three values below, then Run once. Afterwards, delete this query from the SQL Editor.
--
-- The account becomes an active super_admin with this password. Every existing session of the admin ends and
-- any unused password setup token is closed. The authenticator (TOTP) is not touched: it is still required at
-- every sign-in (an account without one sets it up at the first sign-in). The password is never written to the
-- audit or security history. Needs migration 20261006120000_d35_admin_password_owner_sql.sql.
--
-- The password is stored as a temporary bcrypt hash; at the first successful sign-in the API checks the full
-- password rules (including the common-password list) and replaces it with its normal Argon2id hash. A password
-- that breaks a rule is refused at that sign-in like a wrong one (security history: admin_password_upgrade_refused).
-- If the password contains an apostrophe ', type it twice ('').
-- A sign-in lock on this number (after 5 wrong passwords) is not lifted by this script; it ends by itself
-- within 15 minutes.
do $set_admin$
declare
  input_phone    constant text := '+905446731942';
  input_name     constant text := 'Academy Admin';
  input_password constant text := 'MY_PASSWORD_HERE';   -- <<< PUT YOUR PASSWORD HERE (12-128 characters)

  phone_e164 text;
  compact    text;
  pw_hash    text;
  existing   app.admin_accounts%rowtype;
  target_id  uuid;
  ended      integer := 0;
  closed     integer := 0;
begin
  if current_user <> 'postgres' then
    raise exception 'Stopped: run this as postgres, not %', current_user;
  end if;

  phone_e164 := regexp_replace(btrim(input_phone), '[[:space:]().-]', '', 'g');
  if phone_e164 like '00%' then phone_e164 := '+' || substr(phone_e164, 3); end if;
  if phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'Stopped: the phone number must be in international form, for example +905446731942';
  end if;
  if char_length(btrim(input_name)) not between 1 and 64 then
    raise exception 'Stopped: the name must be 1 to 64 characters';
  end if;
  if input_password = 'MY_PASSWORD_HERE' then
    raise exception 'Stopped: replace MY_PASSWORD_HERE with your password';
  end if;
  if char_length(input_password) not between 12 and 128 then
    raise exception 'Stopped: the password must be 12 to 128 characters';
  end if;
  -- Not the phone number in any spelling (+90..., 90..., 0090..., 0544..., with spaces or dashes).
  compact := regexp_replace(btrim(normalize(input_password, NFKC)), '[[:space:]().\-/]', '', 'g');
  if compact ~ '^\+?[0-9]+$' and char_length(ltrim(compact, '+0')) >= 7
     and right(substr(phone_e164, 2), char_length(ltrim(compact, '+0'))) = ltrim(compact, '+0') then
    raise exception 'Stopped: the password cannot be your phone number';
  end if;

  -- bcrypt (cost 12) of the password's SHA-256, made by pgcrypto. The API accepts it once and replaces it
  -- with its own Argon2id hash at the first sign-in (after checking the common-password list).
  pw_hash := extensions.crypt(encode(extensions.digest(convert_to(input_password, 'UTF8'), 'sha256'), 'base64'),
                              extensions.gen_salt('bf', 12));

  select * into existing from app.admin_accounts a where a.phone = phone_e164 for update;
  if not found then
    insert into app.admin_accounts (phone, name, role, status, password_hash)
    values (phone_e164, btrim(input_name), 'super_admin', 'active', pw_hash)
    returning id into target_id;
  else
    target_id := existing.id;
    -- The authenticator (TOTP) is not touched: it stays mandatory at every sign-in.
    update app.admin_accounts
       set name = btrim(input_name), role = 'super_admin', status = 'active', password_hash = pw_hash
     where id = target_id;
    update app.admin_sessions set revoked_at = now() where admin_id = target_id and revoked_at is null;
    get diagnostics ended = row_count;
  end if;
  update app.admin_password_setup set used_at = now() where admin_id = target_id and used_at is null;
  get diagnostics closed = row_count;

  insert into app.audit_log (actor_type, actor_id, action, target_type, target_id, metadata)
  values ('system', null, 'admin.password_set', 'admin', target_id::text,
          jsonb_build_object('source', 'owner_sql', 'created', existing.id is null,
                             'previousRole', existing.role, 'previousStatus', existing.status,
                             'sessionsEnded', ended, 'setupTokensClosed', closed));
  insert into audit.security_events (subject_type, subject_id, phone, event, details)
  values ('admin', target_id, phone_e164, 'admin_password_set',
          jsonb_build_object('source', 'owner_sql', 'sessionsEnded', ended));

  -- For the result below (this run only).
  perform set_config('bedo.owner_sql_phone', phone_e164, true);
end
$set_admin$;

-- The admin just created or updated:
select phone, name, role, status,
       password_hash is not null   as has_password,
       totp_secret_enc is not null as authenticator_set_up,
       updated_at
from app.admin_accounts
where phone = current_setting('bedo.owner_sql_phone', true);
