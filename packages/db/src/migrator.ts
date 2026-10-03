import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/** File names follow the Supabase convention: <14-digit timestamp>_<snake_case_name>.sql */
const MIGRATION_FILE_PATTERN = /^(\d{14})_([a-z0-9_]+)\.sql$/;

/**
 * A migration whose first line is this marker runs outside a transaction. It must contain exactly one
 * statement (e.g. CREATE INDEX CONCURRENTLY), because Postgres wraps multi-statement strings in an
 * implicit transaction.
 */
const NO_TRANSACTION_MARKER = '-- bedo:no-transaction';

/** Arbitrary but fixed key so only one runner applies migrations at a time. */
const MIGRATION_LOCK_KEY = 4_802_201_001;
const DEFAULT_LOCK_WAIT_MS = 60_000;

/** Explicit transaction control inside a transactional migration would break the runner's own transaction. */
const TRANSACTION_CONTROL = /^\s*(begin|commit|rollback|abort|start\s+transaction)\s*(transaction|work)?\s*;/im;

/** Supabase's transaction-mode pooler (Supavisor) listens on 6543 and cannot hold session advisory locks. */
const TRANSACTION_POOLER_PORT = '6543';

export interface MigrationFile {
  version: string;
  name: string;
  fileName: string;
  checksum: string;
  sql: string;
  transactional: boolean;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationLogger {
  info(message: string): void;
}

export interface RunMigrationsOptions {
  connectionString: string;
  migrationsDir: string;
  logger?: MigrationLogger;
  /** How long to wait for another runner to finish before giving up. */
  lockWaitMs?: number;
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: number;
}

export type MigrationState = 'applied' | 'pending';

export interface MigrationStatusEntry {
  version: string;
  name: string;
  state: MigrationState;
  appliedAt: Date | null;
}

export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationIntegrityError';
  }
}

const silentLogger: MigrationLogger = { info: () => undefined };

export function checksumOf(sql: string): string {
  // Normalise line endings so a checkout on Windows produces the same checksum.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export async function readMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  const seenVersions = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) {
      continue;
    }
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (!match) {
      throw new MigrationIntegrityError(
        `Migration file "${entry.name}" must be named <14-digit timestamp>_<snake_case_name>.sql`,
      );
    }
    const [, version, name] = match as unknown as [string, string, string];
    const previous = seenVersions.get(version);
    if (previous) {
      throw new MigrationIntegrityError(`Migrations "${previous}" and "${entry.name}" share version ${version}`);
    }
    seenVersions.set(version, entry.name);

    const sql = await readFile(path.join(migrationsDir, entry.name), 'utf8');
    if (sql.trim().length === 0) {
      throw new MigrationIntegrityError(`Migration file "${entry.name}" is empty`);
    }
    const transactional = !sql.trimStart().startsWith(NO_TRANSACTION_MARKER);
    if (transactional && TRANSACTION_CONTROL.test(sql)) {
      throw new MigrationIntegrityError(
        `Migration "${entry.name}" contains BEGIN/COMMIT/ROLLBACK. The runner wraps each migration in a ` +
          'transaction itself; remove them (or use the no-transaction marker for a single statement).',
      );
    }
    files.push({
      version,
      name,
      fileName: entry.name,
      checksum: checksumOf(sql),
      sql,
      transactional,
    });
  }

  return files.sort((a, b) => a.version.localeCompare(b.version));
}

async function ensureBookkeeping(client: pg.Client): Promise<void> {
  await client.query('create schema if not exists app_meta');
  await client.query(`
    create table if not exists app_meta.schema_migrations (
      version    text primary key,
      name       text not null,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )
  `);
  await client.query('revoke all on schema app_meta from public');
}

async function readApplied(client: pg.Client): Promise<AppliedMigration[]> {
  const result = await client.query<{ version: string; name: string; checksum: string; applied_at: Date }>(
    'select version, name, checksum, applied_at from app_meta.schema_migrations order by version',
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

/**
 * Every migration recorded in the database must still exist on disk with an identical checksum,
 * and nothing on disk may be older than the newest applied migration without being applied itself.
 */
function verifyIntegrity(files: MigrationFile[], applied: AppliedMigration[]): void {
  const filesByVersion = new Map(files.map((file) => [file.version, file]));
  for (const record of applied) {
    const file = filesByVersion.get(record.version);
    if (!file) {
      throw new MigrationIntegrityError(
        `Applied migration ${record.version}_${record.name} is missing from the migrations directory`,
      );
    }
    if (file.checksum !== record.checksum) {
      throw new MigrationIntegrityError(
        `Applied migration ${file.fileName} has been modified since it was applied. ` +
          'Restore the original file and add a new migration for the change.',
      );
    }
  }

  const newestApplied = applied.at(-1)?.version;
  if (newestApplied) {
    const appliedVersions = new Set(applied.map((record) => record.version));
    const outOfOrder = files.filter((file) => file.version < newestApplied && !appliedVersions.has(file.version));
    if (outOfOrder.length > 0) {
      throw new MigrationIntegrityError(
        `Migrations ${outOfOrder.map((file) => file.fileName).join(', ')} are older than the newest applied ` +
          `migration (${newestApplied}) but were never applied. Rename them with a newer timestamp.`,
      );
    }
  }
}

/**
 * Migrations need a direct or session-mode connection: they take a session advisory lock and run
 * multi-statement transactions, which a transaction-mode pooler cannot guarantee.
 */
export function assertMigrationConnection(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new MigrationIntegrityError('DATABASE_URL is not a valid URL');
  }
  if (url.port === TRANSACTION_POOLER_PORT) {
    throw new MigrationIntegrityError(
      'DATABASE_URL points at port 6543 (Supabase transaction pooler). Run migrations over the direct ' +
        'connection or the session-mode pooler (port 5432).',
    );
  }
}

async function acquireLock(client: pg.Client, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [
      MIGRATION_LOCK_KEY,
    ]);
    if (result.rows[0]?.locked) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new MigrationIntegrityError(
        `Another migration run has held the migration lock for more than ${Math.round(waitMs / 1000)}s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function withClient<T>(connectionString: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'bedo-migrations' });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const logger = options.logger ?? silentLogger;
  assertMigrationConnection(options.connectionString);
  const files = await readMigrationFiles(options.migrationsDir);

  return withClient(options.connectionString, async (client) => {
    await acquireLock(client, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
    try {
      await ensureBookkeeping(client);
      const applied = await readApplied(client);
      verifyIntegrity(files, applied);

      const appliedVersions = new Set(applied.map((record) => record.version));
      const pending = files.filter((file) => !appliedVersions.has(file.version));
      const appliedNow: string[] = [];

      for (const file of pending) {
        logger.info(`Applying ${file.fileName}`);
        const record = [file.version, file.name, file.checksum];
        if (file.transactional) {
          await client.query('begin');
          try {
            await client.query(file.sql);
            await client.query(
              'insert into app_meta.schema_migrations (version, name, checksum) values ($1, $2, $3)',
              record,
            );
            await client.query('commit');
          } catch (error) {
            await client.query('rollback');
            throw error;
          }
        } else {
          // Not atomic with its bookkeeping row: if the process dies between the two, the statement
          // runs again next time, so no-transaction migrations must be idempotent (IF NOT EXISTS).
          await client.query(file.sql);
          await client.query(
            'insert into app_meta.schema_migrations (version, name, checksum) values ($1, $2, $3)',
            record,
          );
        }
        appliedNow.push(file.fileName);
      }

      return { applied: appliedNow, alreadyApplied: applied.length };
    } finally {
      // Never let a failed unlock (e.g. the connection already died) hide the original error;
      // the lock is released with the session anyway.
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  });
}

export async function getMigrationStatus(
  options: Omit<RunMigrationsOptions, 'logger'>,
): Promise<MigrationStatusEntry[]> {
  const files = await readMigrationFiles(options.migrationsDir);
  return withClient(options.connectionString, async (client) => {
    // Read-only: an empty database simply reports every migration as pending.
    const exists = await client.query<{ table_name: string | null }>(
      "select to_regclass('app_meta.schema_migrations')::text as table_name",
    );
    const applied = exists.rows[0]?.table_name ? await readApplied(client) : [];
    verifyIntegrity(files, applied);
    const appliedByVersion = new Map(applied.map((record) => [record.version, record]));
    return files.map((file) => {
      const record = appliedByVersion.get(file.version);
      return {
        version: file.version,
        name: file.name,
        state: record ? 'applied' : 'pending',
        appliedAt: record?.appliedAt ?? null,
      };
    });
  });
}
