#!/usr/bin/env node
/**
 * Builds docs/owner-sql/apply-updates.sql: the ONE script the owner runs in the Supabase SQL Editor to bring the
 * live database (migrations 1-6 applied by hand, login bedo_api created) up to the current release. It embeds every
 * later migration file exactly as delivered, in order, between safety checks and a final verification, and records
 * the migrations with their checksums so the migrator sees them as applied.
 *
 *   node scripts/build-owner-sql.mjs          writes the file
 *   node scripts/build-owner-sql.mjs --check  fails if the file is not up to date (run by the tests)
 *
 * Every release that adds a migration re-runs this script; the checks for each migration's result live below.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS_DIR = path.join(root, 'supabase/migrations');
export const OUTPUT = path.join(root, 'docs/owner-sql/apply-updates.sql');

/** Applied by hand on the live project before Phase 3.3 (versions, names and the checksums delivered then). */
const APPLIED = [
  ['20261004000000', 'baseline', 'b5e5d3cdea7f92cf9687530e892d01efaaf9c2c22b3399d684f625af8c4dd1d9'],
  ['20261004120000', 'phase2_accounts', '895f083bf26597405b30c2e04e6aa119747c430b394eece7804d74a5a42470af'],
  ['20261004130000', 'd24_phone_list_removal', 'd681767b521e38e614c813eb8ac537d08b056c0a50d32d49c9e767b0d2772e1f'],
  ['20261004135000', 'phase3_1_admin_bootstrap', '10f385bccdf962c9c309e5b43136931491adac58c4d6bb51cffec563c0fc4f28'],
  ['20261004140000', 'phase3_messaging', 'd973c91631e161e11d8faf7fbb8a0b18a190bd2e804e1df7b3679b8345cd95ac'],
  [
    '20261005120000',
    'phase3_2_admin_password',
    'af7c5f0af73f01b691c16cc721d72254958141e94a20d59c3dcfeff0d692478c',
  ],
];

/** What each migration must have produced; checked before anything is recorded (any failure keeps nothing). */
const RESULT_CHECKS = {
  '20261006120000': `
  if not exists (select 1 from pg_constraint
                 where conrelid = 'app.admin_accounts'::regclass and conname = 'admin_accounts_password_hash_check'
                   and pg_get_constraintdef(oid) like '%2a%') then
    raise exception 'Stopped: the D-35 password check was not applied (nothing was kept)';
  end if;`,
  '20261006180000': `
  if (select count(*) from pg_tables where schemaname = 'app'
      and tablename in ('ephemeral', 'rate_counters', 'rate_events', 'presence_devices', 'maintenance_runs')) <> 5 then
    raise exception 'Stopped: the Phase 3.3 tables are not all there (nothing was kept)';
  end if;
  if not has_table_privilege('bedo_runtime', 'app.ephemeral', 'select, insert, update, delete')
     or not has_table_privilege('bedo_runtime', 'app.presence_devices', 'select, insert, update, delete')
     or not has_table_privilege('bedo_runtime', 'app.maintenance_runs', 'select, insert, update')
     or has_table_privilege('bedo_runtime', 'app.maintenance_runs', 'delete') then
    raise exception 'Stopped: bedo_runtime privileges on the Phase 3.3 tables are not as expected (nothing was kept)';
  end if;`,
  '20261009120000': `
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
  end if;`,
  '20261010120000': `
  if (select count(*) from pg_tables where schemaname = 'app'
      and tablename in ('files', 'sticker_packs', 'stickers', 'gif_settings', 'gif_files', 'message_reactions')) <> 6 then
    raise exception 'Stopped: the Phase 4 tables are not all there (nothing was kept)';
  end if;
  if not exists (select 1 from storage.buckets where id = 'chat-media' and not public)
     or not exists (select 1 from storage.buckets where id = 'stickers' and public) then
    raise exception 'Stopped: the Phase 4 storage buckets are missing (nothing was kept)';
  end if;
  if has_table_privilege('bedo_runtime', 'app.stickers', 'delete') or has_table_privilege('bedo_runtime', 'app.gif_files', 'delete') then
    raise exception 'Stopped: bedo_runtime privileges on the Phase 4 tables are not as expected (nothing was kept)';
  end if;`,
  '20261011120000': `
  if (select count(*) from pg_tables where (schemaname = 'app' and tablename in ('group_settings', 'invite_links', 'join_requests', 'polls',
        'poll_votes', 'message_mentions', 'user_permissions')) or (schemaname = 'audit' and tablename = 'membership_events')) <> 8 then
    raise exception 'Stopped: the Phase 5 tables are not all there (nothing was kept)';
  end if;
  if to_regprocedure('app.group_members(uuid, uuid, uuid, integer)') is null or to_regprocedure('app.group_member_count(uuid, uuid)') is null
     or (case when exists (select 1 from pg_roles where rolname = 'anon')
              then has_function_privilege('anon', 'app.group_members(uuid, uuid, uuid, integer)', 'execute') else false end) then
    raise exception 'Stopped: the member-privacy functions are missing or open to anon (nothing was kept)';
  end if;
  if has_table_privilege('bedo_runtime', 'audit.membership_events', 'delete') or has_table_privilege('bedo_runtime', 'app.polls', 'delete') then
    raise exception 'Stopped: bedo_runtime privileges on the Phase 5 tables are not as expected (nothing was kept)';
  end if;`,
  '20261012120000': `
  if to_regclass('app.scheduled_messages') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = 'conversations' and column_name = 'is_public')
     or not exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = 'messages' and column_name = 'forward_from_chat_id') then
    raise exception 'Stopped: the Phase 6 table or columns are not all there (nothing was kept)';
  end if;
  if has_table_privilege('bedo_runtime', 'app.scheduled_messages', 'delete')
     or not has_table_privilege('bedo_runtime', 'app.scheduled_messages', 'update') then
    raise exception 'Stopped: bedo_runtime privileges on the Phase 6 table are not as expected (nothing was kept)';
  end if;`,
  '20261013120000': `
  if to_regclass('app.notification_settings') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = 'presence_devices' and column_name = 'viewing_chat_id') then
    raise exception 'Stopped: the Phase 7 table or column is not there (nothing was kept)';
  end if;
  if has_table_privilege('bedo_runtime', 'app.notification_settings', 'delete')
     or not has_table_privilege('bedo_runtime', 'app.notification_settings', 'update') then
    raise exception 'Stopped: bedo_runtime privileges on the Phase 7 table are not as expected (nothing was kept)';
  end if;`,
  '20261014120000': `
  if to_regclass('app.files_name_trgm_idx') is null or to_regclass('app.messages_sender_idx') is null then
    raise exception 'Stopped: the Phase 8 search indexes are not there (nothing was kept)';
  end if;`,
  '20261015120000': `
  if to_regclass('app.chat_bans') is null or has_table_privilege('bedo_runtime', 'app.chat_bans', 'update') then
    raise exception 'Stopped: the Phase 9 table or its privileges are not as expected (nothing was kept)';
  end if;`,
  '20261016120000': `
  if to_regclass('app.report_decisions') is null or to_regclass('app.broadcasts') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = 'messages' and column_name = 'removed_by_admin') then
    raise exception 'Stopped: the Phase 10 tables or columns are not all there (nothing was kept)';
  end if;
  if has_table_privilege('bedo_runtime', 'app.report_decisions', 'update') or has_table_privilege('bedo_runtime', 'app.broadcasts', 'delete') then
    raise exception 'Stopped: bedo_runtime privileges on the Phase 10 tables are not as expected (nothing was kept)';
  end if;`,
  '20261017120000': `
  if to_regclass('app.push_keys') is null then
    raise exception 'Stopped: the Phase 13 table app.push_keys is not there (nothing was kept)';
  end if;
  if has_table_privilege('bedo_runtime', 'app.push_keys', 'update') or has_table_privilege('bedo_runtime', 'app.users', 'update')
     or has_table_privilege('bedo_runtime', 'app.sessions', 'update') or has_column_privilege('bedo_runtime', 'app.sessions', 'user_id', 'update')
     or has_column_privilege('bedo_runtime', 'app.users', 'id', 'update')
     or not has_column_privilege('bedo_runtime', 'app.users', 'status', 'update')
     or not has_column_privilege('bedo_runtime', 'app.sessions', 'revoked_at', 'update') then
    raise exception 'Stopped: bedo_runtime privileges after Phase 13 are not as expected (nothing was kept)';
  end if;`,
  '20261018120000': `
  if (select count(*) from app.access_settings) <> 1 then
    raise exception 'Stopped: app.access_settings does not hold its one row (nothing was kept)';
  end if;
  if has_table_privilege('bedo_runtime', 'app.access_settings', 'delete') or has_table_privilege('bedo_runtime', 'app.access_settings', 'insert')
     or not has_column_privilege('bedo_runtime', 'app.access_settings', 'signup_mode', 'update') then
    raise exception 'Stopped: bedo_runtime privileges on app.access_settings are not as expected (nothing was kept)';
  end if;`,
  '20261019120000': `
  if (select count(*) from app.monitoring_settings) <> 1 then
    raise exception 'Stopped: app.monitoring_settings does not hold its one row (nothing was kept)';
  end if;
  if not has_table_privilege('bedo_runtime', 'app.site_checks', 'insert') or has_table_privilege('bedo_runtime', 'app.site_checks', 'update')
     or has_table_privilege('bedo_runtime', 'app.monitoring_settings', 'delete')
     or not has_column_privilege('bedo_runtime', 'app.site_incidents', 'ended_at', 'update')
     or has_column_privilege('bedo_runtime', 'app.site_incidents', 'kind', 'update') then
    raise exception 'Stopped: bedo_runtime privileges on the monitoring tables are not as expected (nothing was kept)';
  end if;`,
  '20261020120000': `
  if not exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = 'group_settings' and column_name = 'academy_wide')
     or not has_column_privilege('bedo_runtime', 'app.group_settings', 'academy_wide', 'update') then
    raise exception 'Stopped: app.group_settings.academy_wide is missing or bedo_runtime cannot set it (nothing was kept)';
  end if;
  if exists (select 1 from app.group_settings s join app.conversations c on c.id = s.conversation_id where s.academy_wide and c.type <> 'channel') then
    raise exception 'Stopped: a group was marked for everyone; only channels can be (nothing was kept)';
  end if;`,
  '20261021120000': `
  if (select count(*) from app.review_account_settings) <> 1 or exists (select 1 from app.review_account_settings where enabled) then
    raise exception 'Stopped: app.review_account_settings must hold its one row, turned off (nothing was kept)';
  end if;
  if has_table_privilege('bedo_runtime', 'app.review_account_settings', 'insert') or has_table_privilege('bedo_runtime', 'app.review_account_settings', 'delete')
     or not has_column_privilege('bedo_runtime', 'app.review_account_settings', 'code_enc', 'update') then
    raise exception 'Stopped: bedo_runtime privileges on app.review_account_settings are not as expected (nothing was kept)';
  end if;`,
};

/**
 * The live project after Phase 13 (go-live, 2026-10-10): every migration through this one is applied there. Each later
 * migration gets its own small update script, docs/owner-sql/update-<version>.sql, run once in the SQL Editor, in order.
 */
export const LIVE_APPLIED_THROUGH = '20261017120000';
export const UPDATES_DIR = path.join(root, 'docs/owner-sql');

const RLS_OFF = `do $bedo_rls$
declare
  item record;
begin
  for item in
    select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'audit', 'app_meta') and c.relkind in ('r', 'p') and (c.relrowsecurity or c.relforcerowsecurity)
  loop
    execute format('alter table %I.%I no force row level security', item.nspname, item.relname);
    execute format('alter table %I.%I disable row level security', item.nspname, item.relname);
  end loop;
end
$bedo_rls$;`;

export const RECORD_OUTPUT = path.join(UPDATES_DIR, 'record-live-migrations.sql');

/**
 * One-time catch-up for the live project (2026-10-10): migrations 7 up to LIVE_APPLIED_THROUGH are in the database
 * (they were run without being recorded), but app_meta.schema_migrations lists only 1-6. This script checks every
 * one of them with the same result checks apply-updates.sql uses, then records them, so the update scripts can follow.
 */
export function buildRecordScript() {
  const all = migrations();
  const liveCount = all.findIndex((migration) => migration.version === LIVE_APPLIED_THROUGH) + 1;
  const toRecord = all.slice(APPLIED.length, liveCount);
  const appliedValues = APPLIED.map(
    // Checksum on its own line, as in apply-updates.sql (a name such as "...password" next to a long hex value reads
    // like a secret to the secret scanner).
    ([version, name, checksum], index) => `           ('${version}', '${name}',\n            '${checksum}')${index === APPLIED.length - 1 ? '' : ','}`,
  ).join('\n');
  const recorded = toRecord
    .map((migration, index) => `    ('${migration.version}', '${migration.name}',\n     '${migration.checksum}')${index === toRecord.length - 1 ? ';' : ','}`)
    .join('\n');
  const list = toRecord.map((migration) => `--   ${migration.version}_${migration.name}`).join('\n');
  return `-- =====================================================================================================
-- Bedo Chat: record the database updates that are already in the live database (one time, 2026-10-10).
-- GENERATED by scripts/build-owner-sql.mjs: do not edit by hand.
--
-- The live database has these updates in place, but its list of applied updates (app_meta.schema_migrations)
-- still shows only the first six:
${list}
-- This script changes no table. It checks that each update's result is there (the same checks as apply-updates.sql),
-- sets the API login's two limits and Bedo Chat's row level security as apply-updates.sql does, then records them.
--
-- How: SQL Editor -> New query -> paste this whole file -> Run ONCE (role: postgres). No values to change.
-- If any check fails, NOTHING is kept and the message says why. Expected result: every line says "ok".
-- Afterwards, run the update scripts (docs/owner-sql/update-<version>.sql) in order.
-- =====================================================================================================

do $preflight$
begin
  if current_user <> 'postgres' then
    raise exception 'Stopped: run this as postgres, not %', current_user;
  end if;
  if (select count(*) from app_meta.schema_migrations) <> ${APPLIED.length}
     or (select count(*) from app_meta.schema_migrations m
         join (values
${appliedValues}
         ) as e(version, name, checksum)
           on e.version = m.version and e.name = m.name and e.checksum = m.checksum) <> ${APPLIED.length} then
    raise exception 'Stopped: app_meta.schema_migrations does not hold exactly migrations 1-${APPLIED.length} (already recorded, or another state): nothing was changed';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'bedo_api' and rolcanlogin) or not pg_has_role('bedo_api', 'bedo_runtime', 'member') then
    raise exception 'Stopped: the login bedo_api does not exist or is not a member of bedo_runtime';
  end if;
  if exists (select 1 from information_schema.role_table_grants
             where grantee in ('anon', 'authenticated') and table_schema in ('app', 'app_meta', 'audit')) then
    raise exception 'Stopped: the roles anon/authenticated can reach Bedo Chat tables';
  end if;
end
$preflight$;

alter role bedo_api set statement_timeout = '15s';
alter role bedo_api set idle_in_transaction_session_timeout = '30s';

${RLS_OFF}

do $verify$
begin${toRecord.map((migration) => RESULT_CHECKS[migration.version]).join('')}
  insert into app_meta.schema_migrations (version, name, checksum) values
${recorded}
end
$verify$;

-- The result: every line should say "ok".
select 'migrations recorded' as check_name,
       case when (select count(*) from app_meta.schema_migrations) = ${liveCount} then 'ok' else 'NOT OK' end as result
union all
${RESULT_ROWS};
`;
}

/** The update scripts for migrations after the live state: { file, sql } for each, in order. */
export function buildUpdateScripts() {
  const all = migrations();
  const liveCount = all.findIndex((migration) => migration.version === LIVE_APPLIED_THROUGH) + 1;
  if (liveCount === 0) throw new Error(`Migration ${LIVE_APPLIED_THROUGH} not found`);
  return all.slice(liveCount).map((migration, index) => {
    const before = all.slice(0, liveCount + index);
    if (!RESULT_CHECKS[migration.version]) {
      throw new Error(`scripts/build-owner-sql.mjs has no result check for ${migration.file}: add one to RESULT_CHECKS`);
    }
    const expected = before
      .map((item, position) => `           ('${item.version}', '${item.checksum}')${position === before.length - 1 ? '' : ','}`)
      .join('\n');
    const body = migration.sql.replace(/\r\n/g, '\n').trimEnd();
    const sql = `-- =====================================================================================================
-- Bedo Chat: database update ${migration.version}_${migration.name}, from the Supabase SQL Editor.
-- GENERATED by scripts/build-owner-sql.mjs from supabase/migrations: do not edit by hand.
--
-- How: SQL Editor -> New query -> paste this whole file -> Run ONCE (role: postgres). No values to change.
-- It needs every earlier update applied (it checks), and refuses to run twice. One request = one transaction:
-- if any check fails, NOTHING is kept and the message says why. Expected result: every line says "ok".
-- If Supabase asks about row level security before running, choose to run it WITHOUT turning row level security on
-- (Bedo Chat's tables keep it off; if it was turned on, docs/owner-sql/fix-row-level-security.sql turns it off again).
-- =====================================================================================================

do $preflight$
begin
  if current_user <> 'postgres' then
    raise exception 'Stopped: run this as postgres, not %', current_user;
  end if;
  if exists (select 1 from app_meta.schema_migrations where version = '${migration.version}') then
    raise exception 'Stopped: this update is already applied (nothing was changed)';
  end if;
  if (select count(*) from app_meta.schema_migrations) <> ${before.length}
     or (select count(*) from app_meta.schema_migrations m
         join (values
${expected}
         ) as e(version, checksum) on e.version = m.version and e.checksum = m.checksum) <> ${before.length} then
    raise exception 'Stopped: the database does not hold exactly the ${before.length} earlier migrations: run the earlier updates first';
  end if;
  if exists (select 1 from information_schema.role_table_grants
             where grantee in ('anon', 'authenticated') and table_schema in ('app', 'app_meta', 'audit')) then
    raise exception 'Stopped: the roles anon/authenticated can reach Bedo Chat tables';
  end if;
end
$preflight$;

-- The delivered migration, exactly as in supabase/migrations/${migration.file} -----------------------------
${body}
-- End of the delivered migration -------------------------------------------------------------------------

-- Newer Supabase projects switch row level security on for every new table: off on Bedo Chat's tables only.
${RLS_OFF}

do $verify$
begin${RESULT_CHECKS[migration.version]}
  insert into app_meta.schema_migrations (version, name, checksum) values
    ('${migration.version}', '${migration.name}', '${migration.checksum}');
end
$verify$;

select 'update ${migration.version} recorded' as check_name,
       case when (select count(*) from app_meta.schema_migrations) = ${before.length + 1} then 'ok' else 'NOT OK' end as result
union all
select 'Bedo Chat tables with row level security on (should be none)',
       case when not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                             where n.nspname in ('app', 'audit', 'app_meta') and c.relkind in ('r', 'p') and c.relrowsecurity)
            then 'ok' else 'NOT OK' end;
`;
    return { file: path.join(UPDATES_DIR, `update-${migration.version}.sql`), sql };
  });
}

/** Rows of the final result besides "migrations recorded" (each must say ok). */
const RESULT_ROWS = `select 'bedo_api limits',
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
                                and tablename = 'messages' and policyname <> 'bedo_device_receives_own_channel') end
union all
select 'Bedo Chat tables with row level security on (should be none)',
       case when not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                             where n.nspname in ('app', 'audit', 'app_meta') and c.relkind in ('r', 'p') and c.relrowsecurity)
            then 'ok' else 'NOT OK' end
union all
select 'storage buckets (profile-photos, chat-media private; stickers public)',
       case when (select count(*) from storage.buckets where (id in ('profile-photos', 'chat-media') and not public)
                  or (id = 'stickers' and public)) = 3 then 'ok' else 'NOT OK' end`;

const checksumOf = (sql) => createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

export function migrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((file) => {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const [, version, name] = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(file);
      return { file, version, name, sql, checksum: checksumOf(sql) };
    });
}

export function buildOwnerSql() {
  const all = migrations();
  APPLIED.forEach(([version, name, checksum], index) => {
    const delivered = all[index];
    if (!delivered || delivered.version !== version || delivered.name !== name || delivered.checksum !== checksum) {
      throw new Error(`Migration ${index + 1} is not the one applied on the live project (${version}_${name})`);
    }
  });
  const updates = all.slice(APPLIED.length);
  for (const migration of updates) {
    if (!RESULT_CHECKS[migration.version]) {
      throw new Error(`scripts/build-owner-sql.mjs has no result check for ${migration.file}: add one to RESULT_CHECKS`);
    }
  }
  const total = all.length;
  const list = updates.map((migration, index) => `--   ${String(APPLIED.length + index + 1).padStart(2)}  ${migration.version}_${migration.name}`).join('\n');
  const appliedValues = APPLIED.map(
    ([version, name, checksum], index) =>
      `           ('${version}', '${name}',\n            '${checksum}')${index === APPLIED.length - 1 ? '' : ','}`,
  ).join('\n');
  const parts = updates
    .map((migration, index) => {
      const body = migration.sql.replace(/\r\n/g, '\n').trimEnd();
      const title = `-- Part ${index + 2}: supabase/migrations/${migration.file}, exactly as delivered `;
      return `${title.padEnd(114, '-')}\n${body}\n${`-- End of the delivered migration file ${migration.version} `.padEnd(114, '-')}`;
    })
    .join('\n\n');
  const recorded = updates
    .map(
      (migration, index) =>
        `    ('${migration.version}', '${migration.name}',\n     '${migration.checksum}')${index === updates.length - 1 ? ';' : ','}`,
    )
    .join('\n');

  return `-- =====================================================================================================
-- Bedo Chat: bring the live database up to date in ONE run from the Supabase SQL Editor (D-35, D-36).
-- GENERATED by scripts/build-owner-sql.mjs from supabase/migrations: do not edit by hand.
--
-- For the Bedo Chat project, whose migrations 1-6 were applied by hand and whose runtime login bedo_api already
-- exists (created in the SQL Editor, member of bedo_runtime). It applies, exactly as delivered and in order:
${list}
-- then sets the two limits on bedo_api, checks everything and records the ${updates.length} migrations.
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
  if (select count(*) from app_meta.schema_migrations) <> ${APPLIED.length}
     or (select count(*) from app_meta.schema_migrations m
         join (values
${appliedValues}
         ) as e(version, name, checksum)
           on e.version = m.version and e.name = m.name and e.checksum = m.checksum) <> ${APPLIED.length} then
    raise exception 'Stopped: app_meta.schema_migrations does not hold exactly migrations 1-6 with the delivered checksums';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'app.admin_accounts'::regclass and conname = 'admin_accounts_password_hash_check'
                   and pg_get_constraintdef(oid) not like '%2a%') then
    raise exception 'Stopped: the Phase 3.2 password_hash check is missing or already changed';
  end if;
  if exists (select 1 from pg_tables where schemaname = 'app'
             and tablename in ('ephemeral', 'rate_counters', 'rate_events', 'presence_devices', 'maintenance_runs', 'files')) then
    raise exception 'Stopped: a table of a later release already exists';
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
  if to_regclass('storage.buckets') is null then
    raise exception 'Stopped: storage.buckets does not exist (this must be the Supabase project)';
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

${parts}

-- Part ${updates.length + 2}: the runtime login's limits. Through the transaction pooler the API cannot set them per connection, so
-- they are set on the login itself: no statement runs longer than 15 seconds, and no connection stays idle inside
-- an open transaction longer than 30 seconds.
alter role bedo_api set statement_timeout = '15s';
alter role bedo_api set idle_in_transaction_session_timeout = '30s';

-- Newer Supabase projects switch row level security on for every new table. Bedo Chat's tables have no policies (no
-- Supabase API role can reach them, checked above), so with it on the API's own login could not use them: turned off
-- on Bedo Chat's tables only (docs/owner-sql/fix-row-level-security.sql does the same on its own).
do $bedo_rls$
declare
  item record;
begin
  for item in
    select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('app', 'audit', 'app_meta') and c.relkind in ('r', 'p') and (c.relrowsecurity or c.relforcerowsecurity)
  loop
    execute format('alter table %I.%I no force row level security', item.nspname, item.relname);
    execute format('alter table %I.%I disable row level security', item.nspname, item.relname);
  end loop;
end
$bedo_rls$;

-- Part ${updates.length + 3}: check the result, then the bookkeeping rows ---------------------------------------------------
do $verify$
begin${updates.map((migration) => RESULT_CHECKS[migration.version]).join('')}
  insert into app_meta.schema_migrations (version, name, checksum) values
${recorded}
end
$verify$;

-- The result: every line should say "ok".
select 'migrations recorded' as check_name,
       case when (select count(*) from app_meta.schema_migrations) = ${total} then 'ok' else 'NOT OK' end as result
union all
${RESULT_ROWS};
`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const sql = buildOwnerSql();
  const updates = [...buildUpdateScripts(), { file: RECORD_OUTPUT, sql: buildRecordScript() }];
  if (process.argv.includes('--check')) {
    for (const update of updates) {
      let current = '';
      try {
        current = readFileSync(update.file, 'utf8');
      } catch {
        // missing
      }
      if (current !== update.sql) {
        console.error(`${path.relative(root, update.file)} is out of date: run node scripts/build-owner-sql.mjs`);
        process.exit(1);
      }
    }
    let current = '';
    try {
      current = readFileSync(OUTPUT, 'utf8');
    } catch {
      // missing
    }
    if (current !== sql) {
      console.error(`${path.relative(root, OUTPUT)} is out of date: run node scripts/build-owner-sql.mjs`);
      process.exit(1);
    }
    console.log(`${path.relative(root, OUTPUT)} is up to date`);
  } else {
    writeFileSync(OUTPUT, sql);
    console.log(`Wrote ${path.relative(root, OUTPUT)}`);
    for (const update of updates) {
      writeFileSync(update.file, update.sql);
      console.log(`Wrote ${path.relative(root, update.file)}`);
    }
  }
}
