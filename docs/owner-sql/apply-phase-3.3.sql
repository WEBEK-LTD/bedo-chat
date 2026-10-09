-- =====================================================================================================
-- Bedo Chat: bring the live database to Phase 3.3 in ONE run from the Supabase SQL Editor (D-35, D-36).
--
-- For the Bedo Chat project, whose migrations 1-6 were applied by hand and whose runtime login bedo_api already
-- exists (created in the SQL Editor, member of bedo_runtime). It applies, exactly as delivered and in order:
--   7  20261006120000_d35_admin_password_owner_sql   (admin password set by the owner, D-35)
--   8  20261006180000_phase3_3_single_site           (short-lived state, rate limits, presence; replaces Redis)
--   9  20261009120000_phase3_3_private_realtime      (private realtime channels: Realtime Authorization policy)
-- then sets the two limits on bedo_api, checks everything and records the three migrations.
--
-- How: SQL Editor -> New query -> paste this whole file -> Run ONCE (role: postgres). No values to change.
-- One request = one transaction: if any check or statement fails, NOTHING is kept and the message says why.
-- Expected result: a list of checks, every one "ok".
-- =====================================================================================================

-- Part 1: safety checks (change nothing) ------------------------------------------------------------------
do $preflight$
begin
  if current_user <> 'postgres' then
    raise exception 'Stopped: run this as postgres, not %', current_user;
  end if;
  if to_regclass('app_meta.schema_migrations') is null then
    raise exception 'Stopped: app_meta.schema_migrations does not exist';
  end if;
  -- Exactly migrations 1-6 (through Phase 3.2) with the delivered checksums.
  if (select count(*) from app_meta.schema_migrations) <> 6
     or (select count(*) from app_meta.schema_migrations m
         join (values
           ('20261004000000', 'baseline',                 'b5e5d3cdea7f92cf9687530e892d01efaaf9c2c22b3399d684f625af8c4dd1d9'),
           ('20261004120000', 'phase2_accounts',          '895f083bf26597405b30c2e04e6aa119747c430b394eece7804d74a5a42470af'),
           ('20261004130000', 'd24_phone_list_removal',   'd681767b521e38e614c813eb8ac537d08b056c0a50d32d49c9e767b0d2772e1f'),
           ('20261004135000', 'phase3_1_admin_bootstrap', '10f385bccdf962c9c309e5b43136931491adac58c4d6bb51cffec563c0fc4f28'),
           ('20261004140000', 'phase3_messaging',         'd973c91631e161e11d8faf7fbb8a0b18a190bd2e804e1df7b3679b8345cd95ac'),
           ('20261005120000', 'phase3_2_admin_password',
            'af7c5f0af73f01b691c16cc721d72254958141e94a20d59c3dcfeff0d692478c')
         ) as e(version, name, checksum)
           on e.version = m.version and e.name = m.name and e.checksum = m.checksum) <> 6 then
    raise exception 'Stopped: app_meta.schema_migrations does not hold exactly migrations 1-6 with the delivered checksums';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'app.admin_accounts'::regclass and conname = 'admin_accounts_password_hash_check'
                   and pg_get_constraintdef(oid) not like '%2a%') then
    raise exception 'Stopped: the Phase 3.2 password_hash check is missing or already changed';
  end if;
  if exists (select 1 from pg_tables where schemaname = 'app'
             and tablename in ('ephemeral', 'rate_counters', 'rate_events', 'presence_devices', 'maintenance_runs')) then
    raise exception 'Stopped: a Phase 3.3 table already exists';
  end if;
  if (select tableowner from pg_tables where schemaname = 'app' and tablename = 'users') <> 'postgres'
     or (select tableowner from pg_tables where schemaname = 'app' and tablename = 'admin_accounts') <> 'postgres' then
    raise exception 'Stopped: the app tables are not owned by postgres';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'bedo_api' and rolcanlogin) then
    raise exception 'Stopped: the login bedo_api does not exist (create it first: docs/DEPLOYMENT.md, section 0)';
  end if;
  if not pg_has_role('bedo_api', 'bedo_runtime', 'member') then
    raise exception 'Stopped: bedo_api is not a member of bedo_runtime';
  end if;
  if to_regclass('realtime.messages') is null then
    raise exception 'Stopped: realtime.messages does not exist (this must be the Supabase project)';
  end if;
  -- A device's realtime token is a Supabase token for the role "authenticated". It must grant nothing except
  -- receiving on its own channel, so nothing else may be open to that role (or to anon).
  if exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
             and policyname <> 'bedo_device_receives_own_channel') then
    raise exception 'Stopped: realtime.messages already has other policies (%): delete them first (they would let other tokens read private channels)',
      (select string_agg(policyname, ', ') from pg_policies where schemaname = 'realtime' and tablename = 'messages'
       and policyname <> 'bedo_device_receives_own_channel');
  end if;
  if exists (select 1 from information_schema.role_table_grants
             where grantee in ('anon', 'authenticated') and table_schema in ('app', 'app_meta', 'audit')) then
    raise exception 'Stopped: the roles anon/authenticated can reach Bedo Chat tables';
  end if;
  if to_regclass('storage.objects') is not null
     and exists (select 1 from pg_policies where schemaname = 'storage'
                 and (roles && array['anon', 'authenticated', 'public']::name[])) then
    raise exception 'Stopped: Supabase Storage has policies for anon/authenticated (Bedo Chat uses none): delete them first';
  end if;
end
$preflight$;

-- Part 2: supabase/migrations/20261006120000_d35_admin_password_owner_sql.sql, exactly as delivered ------------
-- Bedo Chat - D-35: admin password set by the owner from the SQL editor (docs/owner-sql/set-super-admin.sql).
--
-- The database cannot produce the API's Argon2id hash, so the owner script stores a temporary bcrypt hash
-- (pgcrypto crypt(), cost 12) of the password's SHA-256 (base64). The API accepts it once and, on the first
-- successful sign-in, replaces it with its own Argon2id hash after checking the full password rules (D-34).
-- Only that exact bcrypt form is allowed besides Argon2id; nothing else about admin accounts changes.

alter table app.admin_accounts drop constraint admin_accounts_password_hash_check;
alter table app.admin_accounts add constraint admin_accounts_password_hash_check check (
  password_hash is null
  or (password_hash like '$argon2id$%' and length(password_hash) <= 512)
  or password_hash ~ '^\$2a\$12\$[./A-Za-z0-9]{53}$'
);

comment on column app.admin_accounts.password_hash is
  'Argon2id hash (PHC string) of the admin password (D-34), or until the first sign-in a bcrypt hash written by the owner SQL script (D-35). NULL until a password is set.';
-- End of the delivered migration file 20261006120000 ----------------------------------------------------------

-- Part 3: supabase/migrations/20261006180000_phase3_3_single_site.sql, exactly as delivered --------------------
-- Bedo Chat - Phase 3.3 (D-36): one Netlify site, no separate API host, no Redis.
--
-- The API now runs inside the website's server functions, which keep no state between requests. What Redis
-- held moves here, all short-lived and owned by the runtime role:
--   app.ephemeral        pending sign-ins (2-Step, admin), authenticator setup secrets (encrypted), photo uploads
--   app.rate_counters    fixed-window attempt counters (sign-in, setup tokens, messaging limits, ...)
--   app.rate_events      sliding-window events for the one-time-code limits (per number, per address)
--   app.presence_devices which signed-in devices are online right now (heartbeat every 25 s, 60 s each, P-18)
--   app.maintenance_runs when the hourly housekeeping last ran (it runs from ordinary requests)
-- Expired rows are ignored by every read and removed by the hourly housekeeping. Nothing here is audit
-- history; the audit tables are unchanged.

create table app.ephemeral (
  key        text primary key check (length(key) between 1 and 300),
  value      text not null check (length(value) <= 16384),
  expires_at timestamptz not null
);
create index ephemeral_expires_idx on app.ephemeral (expires_at);
comment on table app.ephemeral is
  'Short-lived server state with an expiry (D-36): pending sign-ins, setup secrets (encrypted), upload tickets. Never audit history.';

create table app.rate_counters (
  key        text primary key check (length(key) between 1 and 300),
  count      integer not null check (count >= 0),
  expires_at timestamptz not null
);
create index rate_counters_expires_idx on app.rate_counters (expires_at);
comment on table app.rate_counters is 'Fixed-window rate-limit counters (D-36). A row past expires_at counts as zero.';

create table app.rate_events (
  bucket text not null check (length(bucket) between 1 and 300),
  at     timestamptz not null
);
create index rate_events_bucket_at_idx on app.rate_events (bucket, at);
comment on table app.rate_events is 'Sliding-window events for the one-time-code limits (D-36), one row per code sent.';

create table app.presence_devices (
  user_id    uuid not null references app.users (id),
  session_id uuid not null,
  expires_at timestamptz not null,
  primary key (user_id, session_id)
);
create index presence_devices_expires_idx on app.presence_devices (expires_at);
comment on table app.presence_devices is
  'Signed-in devices that sent a heartbeat in the last 60 seconds (P-18, D-36). A user is online while one is unexpired.';

create table app.maintenance_runs (
  name        text primary key check (length(name) between 1 and 100),
  last_run_at timestamptz not null
);
comment on table app.maintenance_runs is 'When each hourly housekeeping task last ran (D-36).';

grant select, insert, update, delete on app.ephemeral, app.rate_counters, app.rate_events, app.presence_devices to bedo_runtime;
grant select, insert, update on app.maintenance_runs to bedo_runtime;
-- End of the delivered migration file 20261006180000 ----------------------------------------------------------

-- Part 4: supabase/migrations/20261009120000_phase3_3_private_realtime.sql, exactly as delivered ---------------
-- Bedo Chat - D-36: private realtime channels (Supabase Realtime Authorization).
--
-- Each signed-in device receives realtime signals on its own channel. The API gives the device a short-lived token
-- (a JWT signed with the project's JWT secret, role "authenticated") whose claim "bedo_topic" names that one channel.
-- This policy is the only permission on realtime.messages for devices: a device may RECEIVE broadcasts on the channel
-- its token names, and nothing else. There is no insert policy, so no device can send (or fake) a signal; there is no
-- presence policy, so devices cannot see who else listens. The API sends with the service key, which bypasses
-- policies. With "Allow public access" turned off in the Realtime settings, every channel needs such a token.
--
-- How Supabase checks it: when a device joins a channel, Realtime sets realtime.topic (the channel), the device's JWT
-- claims and its role, then checks whether a broadcast row for that channel would be visible under these policies.
--
-- realtime.messages exists only on Supabase; on any other Postgres (local development, tests) nothing is created.

do $private_realtime$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.topic()') is null then
    raise notice 'realtime.messages not found (not a Supabase database): no realtime policy created';
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'Stopped: the role "authenticated" does not exist';
  end if;

  execute 'drop policy if exists bedo_device_receives_own_channel on realtime.messages';
  execute $policy$
    create policy bedo_device_receives_own_channel on realtime.messages
      as permissive
      for select
      to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and realtime.messages.topic = (select realtime.topic())
        and (select realtime.topic()) = (
          select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'bedo_topic'
        )
      )
  $policy$;
end
$private_realtime$;
-- End of the delivered migration file 20261009120000 ----------------------------------------------------------

-- Part 5: the runtime login's limits. Through the transaction pooler the API cannot set them per connection, so
-- they are set on the login itself: no statement runs longer than 15 seconds, and no connection stays idle inside
-- an open transaction longer than 30 seconds.
alter role bedo_api set statement_timeout = '15s';
alter role bedo_api set idle_in_transaction_session_timeout = '30s';

-- Part 6: check the result, then the bookkeeping rows -------------------------------------------------------
do $verify$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'app.admin_accounts'::regclass and conname = 'admin_accounts_password_hash_check'
                   and pg_get_constraintdef(oid) like '%2a%') then
    raise exception 'Stopped: the D-35 password check was not applied (nothing was kept)';
  end if;
  if (select count(*) from pg_tables where schemaname = 'app'
      and tablename in ('ephemeral', 'rate_counters', 'rate_events', 'presence_devices', 'maintenance_runs')) <> 5 then
    raise exception 'Stopped: the Phase 3.3 tables are not all there (nothing was kept)';
  end if;
  if not has_table_privilege('bedo_runtime', 'app.ephemeral', 'select, insert, update, delete')
     or not has_table_privilege('bedo_runtime', 'app.presence_devices', 'select, insert, update, delete')
     or not has_table_privilege('bedo_runtime', 'app.maintenance_runs', 'select, insert, update')
     or has_table_privilege('bedo_runtime', 'app.maintenance_runs', 'delete') then
    raise exception 'Stopped: bedo_runtime privileges on the Phase 3.3 tables are not as expected (nothing was kept)';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
                 and policyname = 'bedo_device_receives_own_channel' and cmd = 'SELECT' and roles = '{authenticated}') then
    raise exception 'Stopped: the private realtime policy was not created (nothing was kept)';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass) then
    raise exception 'Stopped: row level security is off on realtime.messages (nothing was kept)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
             and policyname <> 'bedo_device_receives_own_channel') then
    raise exception 'Stopped: realtime.messages has other policies (nothing was kept)';
  end if;
  insert into app_meta.schema_migrations (version, name, checksum) values
    ('20261006120000', 'd35_admin_password_owner_sql',
     'ce35f75dc26b4277f010930fb95a29994ff2a5bc2ccaa91970c3e6349bdb7961'),
    ('20261006180000', 'phase3_3_single_site',         '97aa585eaa4badc396d1f176a44f197f2fec978160afacfc210d1f1dd3f856c8'),
    ('20261009120000', 'phase3_3_private_realtime',    '26b809e836de0fa9b8445b84b8176af620ed8d7245e7eec391f35e4d1f7ddefb');
end
$verify$;

-- The result: every line should say "ok".
select 'migrations recorded' as check_name,
       case when (select count(*) from app_meta.schema_migrations) = 9 then 'ok' else 'NOT OK' end as result
union all
select 'bedo_api limits',
       case when (select setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                  where r.rolname = 'bedo_api' and s.setdatabase = 0)
                 @> array['statement_timeout=15s', 'idle_in_transaction_session_timeout=30s'] then 'ok' else 'NOT OK' end
union all
select 'private realtime policy',
       case when exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
                         and policyname = 'bedo_device_receives_own_channel') then 'ok' else 'NOT OK' end
union all
select 'other realtime.messages policies (should be none)',
       case when not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
                             and policyname <> 'bedo_device_receives_own_channel') then 'ok'
            else 'NOT OK: ' || (select string_agg(policyname, ', ') from pg_policies where schemaname = 'realtime'
                                and tablename = 'messages' and policyname <> 'bedo_device_receives_own_channel') end;
