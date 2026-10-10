import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checksumOf, defaultMigrationsDir, getMigrationStatus, runMigrations } from '../src/index.js';
import { createTempDatabase, type TempDatabase } from './temp-database.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const SCRIPT = fileURLToPath(new URL('../../../docs/owner-sql/apply-updates.sql', import.meta.url));
const GENERATOR = new URL('../../../scripts/build-owner-sql.mjs', import.meta.url).href;
/** Migrations the live project applied by hand (through Phase 3.2). */
const APPLIED_BY_HAND = 6;

/** One request with several statements, as the Supabase SQL Editor sends it: one implicit transaction. */
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
 * docs/owner-sql/apply-updates.sql (D-36) against a database in the live project's state: migrations 1-6 applied,
 * the login bedo_api created in the SQL Editor, Supabase's realtime.messages (stand-in: the columns that matter, row
 * level security on, realtime.topic() returning the channel being joined, the role "authenticated") and Supabase
 * Storage's bucket table with the Phase 2 bucket.
 */
describe.runIf(enabled)('owner SQL: every update in one run (real Postgres)', () => {
  let database: TempDatabase;
  let firstSix: string;
  let later: string[];

  beforeAll(async () => {
    database = await createTempDatabase();
    firstSix = await mkdtemp(path.join(tmpdir(), 'bedo-mig6-'));
    const files = (await readdir(defaultMigrationsDir())).filter((name) => name.endsWith('.sql')).sort();
    later = files.slice(APPLIED_BY_HAND);
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
  });

  afterAll(async () => {
    await database?.drop();
    if (firstSix) await rm(firstSix, { recursive: true, force: true });
  });

  it('is generated from the current migrations and embeds each later one exactly, with its checksum', async () => {
    const script = await readFile(SCRIPT, 'utf8');
    const { buildOwnerSql } = (await import(GENERATOR)) as { buildOwnerSql: () => string };
    expect(script).toBe(buildOwnerSql());
    expect(later.length).toBeGreaterThanOrEqual(4);
    for (const name of later) {
      const sql = await readFile(path.join(defaultMigrationsDir(), name), 'utf8');
      expect(script, name).toContain(sql.replace(/\r\n/g, '\n').trimEnd());
      expect(script, name).toContain(`'${checksumOf(sql)}'`);
    }
  });

  it('refuses to start, changing nothing, while another policy could open realtime.messages', async () => {
    await run(database.url, `create policy any_authenticated on realtime.messages for select to authenticated using (true)`);
    await expect(run(database.url, await readFile(SCRIPT, 'utf8'))).rejects.toThrow(/Stopped: realtime.messages already has other policies \(any_authenticated\)/);
    const count = await run(database.url, 'select count(*)::int as n from app_meta.schema_migrations');
    expect(count[0]!.rows[0]).toEqual({ n: APPLIED_BY_HAND });
    await run(database.url, 'drop policy any_authenticated on realtime.messages');
  });

  it('applies every later migration, sets the login limits and reports every check ok', async () => {
    const results = await run(database.url, await readFile(SCRIPT, 'utf8'));
    const report = results.at(-1)!.rows as Array<{ check_name: string; result: string }>;
    expect(report).toEqual([
      { check_name: 'migrations recorded', result: 'ok' },
      { check_name: 'bedo_api limits', result: 'ok' },
      { check_name: 'private realtime policy', result: 'ok' },
      { check_name: 'other realtime.messages policies (should be none)', result: 'ok' },
      { check_name: 'storage buckets (profile-photos, chat-media private; stickers public)', result: 'ok' },
    ]);
    // The migrator now sees every migration applied, with matching checksums.
    const status = await getMigrationStatus({ connectionString: database.url, migrationsDir: defaultMigrationsDir() });
    expect(status.map((entry) => entry.state)).toEqual(status.map(() => 'applied'));
    expect(status).toHaveLength(APPLIED_BY_HAND + later.length);
    const buckets = await run(database.url, 'select id, public, file_size_limit::int as limit from storage.buckets order by id');
    expect(buckets[0]!.rows).toEqual([
      { id: 'chat-media', public: false, limit: 52428800 },
      { id: 'profile-photos', public: false, limit: 5242880 },
      { id: 'stickers', public: true, limit: 524288 },
    ]);
  });

  it('lets a device receive only broadcasts on the one channel its token names, and send nothing', async () => {
    const asDevice = (claims: string | null, joining: string) =>
      `set local role authenticated;
       ${claims === null ? '' : `set local request.jwt.claims = '${claims}';`}
       set local realtime.topic = '${joining}';
       select topic, extension from realtime.messages order by id;`;
    const read = async (claims: string | null, joining: string) => {
      const results = await run(database.url, `begin; ${asDevice(claims, joining)} commit;`);
      return results.find((result) => result.command === 'SELECT')!.rows;
    };
    // Its own channel: the broadcast only (no presence).
    expect(await read('{"role":"authenticated","bedo_topic":"bedo-device-a"}', 'bedo-device-a')).toEqual([{ topic: 'bedo-device-a', extension: 'broadcast' }]);
    // Another device's channel, with its own token: nothing.
    expect(await read('{"role":"authenticated","bedo_topic":"bedo-device-a"}', 'bedo-device-b')).toEqual([]);
    // A token without the claim, or no claims at all: nothing.
    expect(await read('{"role":"authenticated","sub":"someone"}', 'bedo-device-a')).toEqual([]);
    expect(await read(null, 'bedo-device-a')).toEqual([]);
    // Sending (insert) is refused even on its own channel: no policy allows it.
    await expect(
      run(
        database.url,
        `begin; set local role authenticated; set local request.jwt.claims = '{"bedo_topic":"bedo-device-a"}'; set local realtime.topic = 'bedo-device-a';
         insert into realtime.messages (topic, extension, event) values ('bedo-device-a', 'broadcast', 'bedo'); commit;`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('refuses a second run and changes nothing', async () => {
    await expect(run(database.url, await readFile(SCRIPT, 'utf8'))).rejects.toThrow(/Stopped: app_meta.schema_migrations does not hold exactly migrations 1-6/);
    const count = await run(database.url, 'select count(*)::int as n from app_meta.schema_migrations');
    expect(count[0]!.rows[0]).toEqual({ n: APPLIED_BY_HAND + later.length });
  });
});
