import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, getMigrationStatus, runMigrations } from '../src/index.js';
import { createTempDatabase, type TempDatabase } from './temp-database.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const GENERATOR = new URL('../../../scripts/build-owner-sql.mjs', import.meta.url).href;
const APPLIED_BY_HAND = 6;

async function run(url: string, sql: string): Promise<pg.QueryResult[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = (await client.query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
    return Array.isArray(result) ? result : [result];
  } finally {
    await client.end();
  }
}

/**
 * The live project's state on 2026-10-10: migrations 7 to the live one were run in the SQL Editor without being
 * recorded (app_meta.schema_migrations lists 1-6), with Supabase's automatic row level security on new tables.
 * docs/owner-sql/record-live-migrations.sql checks and records them; the update scripts then follow.
 */
describe.runIf(enabled)('owner SQL: recording the updates already in the live database (real Postgres)', () => {
  let database: TempDatabase;
  let firstSix: string;
  let generator: {
    LIVE_APPLIED_THROUGH: string;
    RECORD_OUTPUT: string;
    buildRecordScript: () => string;
    buildUpdateScripts: () => Array<{ file: string; sql: string }>;
  };

  beforeAll(async () => {
    generator = (await import(GENERATOR)) as typeof generator;
    database = await createTempDatabase();
    firstSix = await mkdtemp(path.join(tmpdir(), 'bedo-rec6-'));
    const files = (await readdir(defaultMigrationsDir())).filter((name) => name.endsWith('.sql')).sort();
    for (const name of files.slice(0, APPLIED_BY_HAND)) {
      await copyFile(path.join(defaultMigrationsDir(), name), path.join(firstSix, name));
    }
    await runMigrations({ connectionString: database.url, migrationsDir: firstSix });
    await run(
      database.url,
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
         if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
         if not exists (select 1 from pg_roles where rolname = 'bedo_api') then create role bedo_api login password 'test-only'; end if;
       end $$;
       grant bedo_runtime to bedo_api;
       create schema realtime;
       create table realtime.messages (id bigserial primary key, topic text not null, extension text not null, event text, payload jsonb, private boolean);
       alter table realtime.messages enable row level security;
       create function realtime.topic() returns text language sql stable as $f$ select nullif(current_setting('realtime.topic', true), '') $f$;
       grant usage on schema realtime to authenticated;
       grant select, insert on realtime.messages to authenticated;
       grant usage on sequence realtime.messages_id_seq to authenticated;
       insert into realtime.messages (topic, extension, event) values
         ('bedo-device-a', 'broadcast', 'bedo'), ('bedo-device-a', 'presence', null), ('bedo-device-b', 'broadcast', 'bedo');
       create schema storage;
       create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
         file_size_limit bigint, allowed_mime_types text[]);
       insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
         values ('profile-photos', 'profile-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']);`,
    );
    await run(
      database.url,
      `create function public.test_auto_rls() returns event_trigger language plpgsql as $$
       declare item record;
       begin
         for item in select * from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE' and object_type = 'table' loop
           execute format('alter table %s enable row level security', item.object_identity);
         end loop;
       end $$;
       create event trigger test_auto_rls on ddl_command_end when tag in ('CREATE TABLE') execute function public.test_auto_rls();`,
    );
    // Each later migration run on its own in the SQL Editor, without being recorded.
    for (const name of files.slice(APPLIED_BY_HAND).filter((file) => file.slice(0, 14) <= generator.LIVE_APPLIED_THROUGH)) {
      await run(database.url, await readFile(path.join(defaultMigrationsDir(), name), 'utf8'));
    }
  });

  afterAll(async () => {
    await database?.drop();
    if (firstSix) await rm(firstSix, { recursive: true, force: true });
  });

  it('checks and records them, then the update scripts apply in order', async () => {
    const script = await readFile(generator.RECORD_OUTPUT, 'utf8');
    expect(script).toBe(generator.buildRecordScript());
    const report = (await run(database.url, script)).at(-1)!.rows as Array<{ check_name: string; result: string }>;
    expect(report.map((row) => [row.check_name, row.result])).toEqual(report.map((row) => [row.check_name, 'ok']));
    expect(report[0]).toEqual({ check_name: 'migrations recorded', result: 'ok' });
    // The API's login can use its tables (automatic row level security turned off).
    expect((await run(database.url, `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('app', 'audit', 'app_meta') and c.relrowsecurity`))[0]!.rows[0]).toEqual({ n: 0 });

    for (const update of generator.buildUpdateScripts()) {
      const rows = (await run(database.url, update.sql)).at(-1)!.rows as Array<{ result: string }>;
      expect(rows.map((row) => row.result)).toEqual(['ok', 'ok']);
    }
    const status = await getMigrationStatus({ connectionString: database.url, migrationsDir: defaultMigrationsDir() });
    expect(status.map((entry) => entry.state)).toEqual(status.map(() => 'applied'));
  });

  it('refuses a second run, changing nothing', async () => {
    await expect(run(database.url, await readFile(generator.RECORD_OUTPUT, 'utf8'))).rejects.toThrow(/does not hold exactly migrations 1-6/);
  });
});
