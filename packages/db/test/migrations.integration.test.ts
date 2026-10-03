import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, defaultMigrationsDir, getMigrationStatus, MigrationIntegrityError, runMigrations } from '../src/index.js';
import { createTempDatabase, type TempDatabase } from './temp-database.js';

const BASELINE = '20261004000000_baseline.sql';

async function query<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    await client.end();
  }
}

describe('migrations against a real Postgres', () => {
  let database: TempDatabase;

  beforeAll(async () => {
    database = await createTempDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('reports every migration as pending on an empty database without changing it', async () => {
    const status = await getMigrationStatus({ connectionString: database.url, migrationsDir: defaultMigrationsDir() });
    expect(status.every((entry) => entry.state === 'pending')).toBe(true);
    const meta = await query(database.url, "select to_regclass('app_meta.schema_migrations') as t");
    expect(meta.rows[0]?.t).toBeNull();
  });

  it('applies the baseline to an empty database', async () => {
    const result = await runMigrations({ connectionString: database.url, migrationsDir: defaultMigrationsDir() });
    expect(result.applied).toContain(BASELINE);

    const tables = await query<{ name: string }>(
      database.url,
      "select table_schema || '.' || table_name as name from information_schema.tables where table_schema in ('app', 'app_meta') order by 1",
    );
    expect(tables.rows.map((row) => row.name)).toEqual(['app.audit_log', 'app_meta.schema_migrations']);

    const extensions = await query<{ extname: string }>(database.url, 'select extname from pg_extension');
    expect(extensions.rows.map((row) => row.extname)).toEqual(expect.arrayContaining(['citext', 'pg_trgm', 'pgcrypto']));
  });

  it('is a no-op when run again', async () => {
    const result = await runMigrations({ connectionString: database.url, migrationsDir: defaultMigrationsDir() });
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toBeGreaterThanOrEqual(1);
  });

  it('serialises concurrent runners so each migration is applied once', async () => {
    const fresh = await createTempDatabase();
    try {
      const results = await Promise.all(
        [1, 2, 3].map(() => runMigrations({ connectionString: fresh.url, migrationsDir: defaultMigrationsDir() })),
      );
      expect(results.filter((result) => result.applied.includes(BASELINE))).toHaveLength(1);
      const rows = await query(fresh.url, 'select count(*)::int as n from app_meta.schema_migrations');
      expect(rows.rows[0]?.n).toBeGreaterThanOrEqual(1);
    } finally {
      await fresh.drop();
    }
  });

  it('refuses to continue when an applied migration was edited', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bedo-tamper-'));
    try {
      await copyFile(path.join(defaultMigrationsDir(), BASELINE), path.join(dir, BASELINE));
      await writeFile(path.join(dir, BASELINE), '\n-- edited after being applied\n', { flag: 'a' });
      await expect(runMigrations({ connectionString: database.url, migrationsDir: dir })).rejects.toBeInstanceOf(
        MigrationIntegrityError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to continue when an applied migration file is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bedo-missing-'));
    try {
      await writeFile(path.join(dir, '20261010000000_other.sql'), 'select 1;');
      await expect(runMigrations({ connectionString: database.url, migrationsDir: dir })).rejects.toThrow(
        /missing from the migrations directory/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a failing migration completely', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bedo-failing-'));
    try {
      await copyFile(path.join(defaultMigrationsDir(), BASELINE), path.join(dir, BASELINE));
      await writeFile(
        path.join(dir, '20991231000000_broken.sql'),
        'create table app.half_done (id int);\nselect * from table_that_does_not_exist;',
      );
      await expect(runMigrations({ connectionString: database.url, migrationsDir: dir })).rejects.toThrow();
      const leftover = await query(database.url, "select to_regclass('app.half_done') as t");
      expect(leftover.rows[0]?.t).toBeNull();
      const recorded = await query(database.url, "select 1 from app_meta.schema_migrations where version = '20991231000000'");
      expect(recorded.rowCount).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a new migration that is older than the newest applied one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bedo-order-'));
    try {
      await copyFile(path.join(defaultMigrationsDir(), BASELINE), path.join(dir, BASELINE));
      await writeFile(path.join(dir, '20200101000000_too_old.sql'), 'select 1;');
      await expect(runMigrations({ connectionString: database.url, migrationsDir: dir })).rejects.toThrow(
        /older than the newest applied migration/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs a no-transaction migration outside a transaction', async () => {
    const fresh = await createTempDatabase();
    const dir = await mkdtemp(path.join(tmpdir(), 'bedo-notx-'));
    try {
      await copyFile(path.join(defaultMigrationsDir(), BASELINE), path.join(dir, BASELINE));
      await writeFile(
        path.join(dir, '20991231000000_concurrent_index.sql'),
        '-- bedo:no-transaction\ncreate index concurrently if not exists audit_log_action_idx on app.audit_log (action);',
      );
      const result = await runMigrations({ connectionString: fresh.url, migrationsDir: dir });
      expect(result.applied).toContain('20991231000000_concurrent_index.sql');
      const index = await query(fresh.url, "select to_regclass('app.audit_log_action_idx') as i");
      expect(index.rows[0]?.i).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it('gives up when another runner holds the lock for too long', async () => {
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      await holder.query('select pg_advisory_lock(4802201001)');
      await expect(
        runMigrations({ connectionString: database.url, migrationsDir: defaultMigrationsDir(), lockWaitMs: 500 }),
      ).rejects.toThrow(/migration lock/);
    } finally {
      await holder.end();
    }
  });

  it('exits the CLI with a non-zero code when integrity checks fail', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bedo-cli-'));
    try {
      await copyFile(path.join(defaultMigrationsDir(), BASELINE), path.join(dir, BASELINE));
      await writeFile(path.join(dir, BASELINE), '\n-- edited\n', { flag: 'a' });
      const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
      const run = promisify(execFile)(process.execPath, [cli, 'status'], {
        env: { ...process.env, DATABASE_URL: database.url, MIGRATIONS_DIR: dir },
      });
      await expect(run).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('MigrationIntegrityError') });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('database roles', () => {
    it('gives Supabase client roles no access to the application schema', async () => {
      // Supabase creates these roles; recreate them here so the revocation is actually exercised.
      const adminUrl = process.env.TEST_DATABASE_URL!;
      const created: string[] = [];
      for (const role of ['anon', 'authenticated']) {
        const exists = await query(adminUrl, 'select 1 from pg_roles where rolname = $1', [role]);
        if (exists.rowCount === 0) {
          await query(adminUrl, `create role ${role} nologin`);
          created.push(role);
        }
      }
      const fresh = await createTempDatabase();
      try {
        await query(fresh.url, 'grant usage on schema public to anon, authenticated');
        await runMigrations({ connectionString: fresh.url, migrationsDir: defaultMigrationsDir() });
        const result = await query<{ role: string; schema_usage: boolean; table_select: boolean }>(
          fresh.url,
          `select r as role,
                  has_schema_privilege(r, 'app', 'USAGE') as schema_usage,
                  has_table_privilege(r, 'app.audit_log', 'SELECT') as table_select
             from unnest(array['anon', 'authenticated']) as r`,
        );
        for (const row of result.rows) {
          expect(row, row.role).toMatchObject({ schema_usage: false, table_select: false });
        }
      } finally {
        await fresh.drop();
        // Leave the server as it was: remove roles this test created.
        for (const role of created) {
          await query(adminUrl, `drop role if exists ${role}`);
        }
      }
    });

    it('lets the runtime role insert and read audit entries but never change or bypass them', async () => {
      const adminUrl = process.env.TEST_DATABASE_URL!;
      const login = `bedo_test_api_${randomBytes(4).toString('hex')}`;
      const password = randomBytes(12).toString('hex');
      await query(adminUrl, `create role ${login} login password '${password}' in role bedo_runtime`);
      const runtimeUrl = new URL(database.url);
      runtimeUrl.username = login;
      runtimeUrl.password = password;
      try {
        await query(
          runtimeUrl.toString(),
          "insert into app.audit_log (actor_type, action) values ('system', 'runtime.insert')",
        );
        const rows = await query(runtimeUrl.toString(), "select count(*)::int as n from app.audit_log where action = 'runtime.insert'");
        expect(rows.rows[0]?.n).toBe(1);

        const ext = await query<{ ok: boolean }>(
          runtimeUrl.toString(),
          "select has_schema_privilege('extensions', 'USAGE') as ok",
        );
        expect(ext.rows[0]?.ok).toBe(true);
        await expect(query(runtimeUrl.toString(), "update app.audit_log set action = 'x'")).rejects.toThrow(/permission denied/);
        await expect(query(runtimeUrl.toString(), 'delete from app.audit_log')).rejects.toThrow(/permission denied/);
        await expect(query(runtimeUrl.toString(), 'alter table app.audit_log disable trigger all')).rejects.toThrow(
          /must be owner/,
        );
        await expect(query(runtimeUrl.toString(), 'create table app.sneaky (id int)')).rejects.toThrow(/permission denied/);
        await expect(query(runtimeUrl.toString(), 'select * from app_meta.schema_migrations')).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await query(adminUrl, `drop role if exists ${login}`);
      }
    });
  });

  describe('connection pool', () => {
    it('survives a dropped idle connection and reconnects', async () => {
      const errors: Error[] = [];
      const appName = `bedo-pool-test-${randomBytes(3).toString('hex')}`;
      const { db, pool } = createDb({ connectionString: database.url, poolMax: 1, applicationName: appName, onPoolError: (error) => errors.push(error) });
      try {
        await pool.query('select 1');
        await query(
          process.env.TEST_DATABASE_URL!,
          'select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1',
          [appName],
        );
        for (let attempt = 0; attempt < 40 && errors.length === 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(errors.length).toBeGreaterThan(0);
        const again = await pool.query<{ ok: number }>('select 1 as ok');
        expect(again.rows[0]?.ok).toBe(1);
      } finally {
        await db.destroy();
      }
    });

    it('cancels statements that exceed the statement timeout', async () => {
      const { db, pool } = createDb({ connectionString: database.url, poolMax: 1, statementTimeoutMs: 1_000 });
      try {
        await expect(pool.query('select pg_sleep(3)')).rejects.toThrow(/statement timeout/);
      } finally {
        await db.destroy();
      }
    });
  });

  describe('app.audit_log', () => {
    it('accepts inserts through the typed Kysely client', async () => {
      const { db } = createDb({ connectionString: database.url, poolMax: 1 });
      try {
        const row = await db
          .insertInto('app.audit_log')
          .values({ actor_type: 'system', actor_id: null, action: 'test.inserted', target_type: null, target_id: null, ip: null, user_agent: null })
          .returning(['id', 'action', 'metadata'])
          .executeTakeFirstOrThrow();
        expect(row.action).toBe('test.inserted');
        expect(row.metadata).toEqual({});
      } finally {
        await db.destroy();
      }
    });

    it('requires an actor id for user and admin actions', async () => {
      await expect(
        query(database.url, "insert into app.audit_log (actor_type, action) values ('admin', 'x')"),
      ).rejects.toThrow(/audit_log_actor_id_required/);
    });

    it('rejects updates, deletes and truncation', async () => {
      await expect(query(database.url, "update app.audit_log set action = 'changed'")).rejects.toThrow(/append-only/);
      await expect(query(database.url, 'delete from app.audit_log')).rejects.toThrow(/append-only/);
      await expect(query(database.url, 'truncate app.audit_log')).rejects.toThrow(/append-only/);
    });
  });
});
