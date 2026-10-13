-- Bedo Chat: makes the Netlify site's server variables (D-36), from the Supabase SQL Editor. Run once, as postgres.
--
-- It gives the database login bedo_api a new random password and makes the four secret keys of the site, then shows
-- every line to import into Netlify (Site configuration -> Environment variables -> Add a variable -> Import from a
-- .env file). Only the three Supabase keys on the last lines are filled in by hand, from Supabase -> Project Settings:
--   API Keys -> "Legacy API keys": anon (public) and service_role (secret);  JWT Keys -> "Legacy JWT Secret".
--
-- The result is secret: copy it straight into Netlify, keep a copy in your password manager, and delete this query
-- from the SQL Editor afterwards. Running it again makes a new password and new keys (import them again; the old
-- password stops working at once).
--
-- It stops without changing anything if data is already encrypted with the site's keys (an admin's authenticator
-- app, the Waabek, GIPHY or Web Push keys): new keys could not read it. Then keep the keys already in Netlify.
create temp table if not exists netlify_variables (line integer primary key, value text not null);
truncate netlify_variables;

do $netlify$
declare
  login_role   constant text := 'bedo_api';
  project_ref  constant text := 'cspnnzoyuyxjiyhwzgqj';
  pooler_host  constant text := 'aws-0-ap-southeast-2.pooler.supabase.com';
  db_password  text := encode(extensions.gen_random_bytes(24), 'hex');
  encrypted    boolean := false;
begin
  if current_user <> 'postgres' then
    raise exception 'Stopped: run this as postgres, not %', current_user;
  end if;
  if not exists (select 1 from pg_roles where rolname = login_role and rolcanlogin) then
    raise exception 'Stopped: the login % does not exist (docs/DEPLOYMENT.md, section 1)', login_role;
  end if;
  -- Secrets already stored encrypted with ADMIN_TOTP_KEY or SETTINGS_ENCRYPTION_KEY.
  if to_regclass('app.admin_accounts') is not null then
    execute 'select exists (select 1 from app.admin_accounts where totp_secret_enc is not null)' into encrypted;
  end if;
  if not encrypted and to_regclass('app.otp_settings') is not null then
    execute 'select exists (select 1 from app.otp_settings where waabek_api_key_enc is not null)' into encrypted;
  end if;
  if not encrypted and to_regclass('app.gif_settings') is not null then
    execute 'select exists (select 1 from app.gif_settings where giphy_key_enc is not null)' into encrypted;
  end if;
  if not encrypted and to_regclass('app.push_keys') is not null then
    execute 'select exists (select 1 from app.push_keys)' into encrypted;
  end if;
  if encrypted then
    raise exception 'Stopped: the site has already stored secrets with its keys. Keep the variables already in Netlify (nothing was changed)';
  end if;

  execute format('alter role %I with password %L', login_role, db_password);

  insert into netlify_variables values
    (1, format('DATABASE_URL=postgresql://%s.%s:%s@%s:6543/postgres', login_role, project_ref, db_password, pooler_host)),
    (2, 'ACCESS_TOKEN_SECRET=' || encode(extensions.gen_random_bytes(48), 'base64')),
    (3, 'OTP_HMAC_SECRET=' || encode(extensions.gen_random_bytes(48), 'base64')),
    (4, 'ADMIN_TOTP_KEY=' || encode(extensions.gen_random_bytes(32), 'base64')),
    (5, 'SETTINGS_ENCRYPTION_KEY=' || encode(extensions.gen_random_bytes(32), 'base64')),
    (6, format('SUPABASE_URL=https://%s.supabase.co', project_ref)),
    (7, 'SUPABASE_ANON_KEY=PASTE_anon_key'),
    (8, 'SUPABASE_SERVICE_ROLE_KEY=PASTE_service_role_key'),
    (9, 'SUPABASE_JWT_SECRET=PASTE_legacy_jwt_secret');
end
$netlify$;

select value as "Netlify variables (replace the three PASTE_ values, then import)" from netlify_variables order by line;
