-- =====================================================================================================
-- Bedo Chat: apply ONLY migration 20261006120000_d35_admin_password_owner_sql.sql (D-35) from the Supabase
-- SQL Editor, then record it in the project's bookkeeping (app_meta.schema_migrations). For a database whose
-- migrations were applied by hand (as for Phase 3.2). Paste the whole file into ONE new query, Run ONCE.
-- One request = one transaction: if any check or statement fails, nothing is kept.
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
  if exists (select 1 from app_meta.schema_migrations where version = '20261006120000') then
    raise exception 'Stopped: 20261006120000_d35_admin_password_owner_sql is already recorded as applied';
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
  -- The Phase 3.2 password check must be there, unchanged.
  if not exists (select 1 from pg_constraint
                 where conrelid = 'app.admin_accounts'::regclass and conname = 'admin_accounts_password_hash_check'
                   and pg_get_constraintdef(oid) not like '%2a%') then
    raise exception 'Stopped: the Phase 3.2 password_hash check is missing or already changed';
  end if;
  if (select tableowner from pg_tables where schemaname = 'app' and tablename = 'admin_accounts') <> 'postgres' then
    raise exception 'Stopped: app.admin_accounts is not owned by postgres';
  end if;
end
$preflight$;

-- Part 2: supabase/migrations/20261006120000_d35_admin_password_owner_sql.sql, exactly as delivered ----------
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
-- End of the delivered migration file ----------------------------------------------------------------------

-- Part 3: check the result, then the bookkeeping row --------------------------------------------------------
do $verify$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'app.admin_accounts'::regclass and conname = 'admin_accounts_password_hash_check'
                   and pg_get_constraintdef(oid) like '%argon2id%' and pg_get_constraintdef(oid) like '%2a%') then
    raise exception 'Stopped: the new password_hash check is not as expected (nothing was kept)';
  end if;
  insert into app_meta.schema_migrations (version, name, checksum)
  values ('20261006120000', 'd35_admin_password_owner_sql',
          'ce35f75dc26b4277f010930fb95a29994ff2a5bc2ccaa91970c3e6349bdb7961');
end
$verify$;

select version, name from app_meta.schema_migrations order by version;
