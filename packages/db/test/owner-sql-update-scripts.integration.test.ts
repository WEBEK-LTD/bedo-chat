import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, getMigrationStatus, runMigrations } from '../src/index.js';
import { createTempDatabase, type TempDatabase } from './temp-database.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const GENERATOR = new URL('../../../scripts/build-owner-sql.mjs', import.meta.url).href;
const OWNER_SQL = fileURLToPath(new URL('../../../docs/owner-sql/', import.meta.url));

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
 * docs/owner-sql/update-<version>.sql (after go-live): each migration after the live state, applied on its own from the
 * Supabase SQL Editor, in order, against a database in the live state (every migration through the live one applied),
 * with Supabase's automatic row level security switched on for new tables.
 */
describe.runIf(enabled)('owner SQL: one update script per later migration (real Postgres)', () => {
  let database: TempDatabase;
  let liveDir: string;
  let updates: Array<{ file: string; sql: string }>;

  beforeAll(async () => {
    const generator = (await import(GENERATOR)) as { LIVE_APPLIED_THROUGH: string; buildUpdateScripts: () => Array<{ file: string; sql: string }> };
    updates = generator.buildUpdateScripts();
    database = await createTempDatabase();
    liveDir = await mkdtemp(path.join(tmpdir(), 'bedo-live-'));
    const files = (await readdir(defaultMigrationsDir())).filter((name) => name.endsWith('.sql')).sort();
    for (const name of files.filter((file) => file.slice(0, 14) <= generator.LIVE_APPLIED_THROUGH)) {
      await copyFile(path.join(defaultMigrationsDir(), name), path.join(liveDir, name));
    }
    await runMigrations({ connectionString: database.url, migrationsDir: liveDir });
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
  });

  afterAll(async () => {
    await database?.drop();
    if (liveDir) await rm(liveDir, { recursive: true, force: true });
  });

  it('applies each update in order, every check ok, and the migrator sees them all applied', async () => {
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(await readFile(path.join(OWNER_SQL, path.basename(update.file)), 'utf8')).toBe(update.sql);
      const report = (await run(database.url, update.sql)).at(-1)!.rows as Array<{ check_name: string; result: string }>;
      expect(report.map((row) => row.result)).toEqual(['ok', 'ok']);
    }
    const status = await getMigrationStatus({ connectionString: database.url, migrationsDir: defaultMigrationsDir() });
    expect(status.map((entry) => entry.state)).toEqual(status.map(() => 'applied'));
  });

  it('refuses to run twice, changing nothing', async () => {
    await expect(run(database.url, updates.at(-1)!.sql)).rejects.toThrow(/already applied/);
  });
});
