import { type ColumnType, type Generated, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

export interface AuditLogTable {
  id: Generated<string>;
  occurred_at: ColumnType<Date, Date | string | undefined, never>;
  actor_type: 'user' | 'admin' | 'system';
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, never>;
}

/**
 * Typed view of the database. Tables are added here by the phase that creates them,
 * always together with their migration in supabase/migrations.
 */
export interface Database {
  'app.audit_log': AuditLogTable;
}

export interface CreateDbOptions {
  connectionString: string;
  poolMax?: number;
  applicationName?: string;
  /** Server-side limit for any single statement (Postgres statement_timeout). */
  statementTimeoutMs?: number;
  /**
   * Called when an idle pooled connection fails (database restart, network cut, idle-connection
   * reaping by a proxy). Without a listener, Node would treat it as an unhandled error and exit.
   * The pool discards the broken connection and opens a new one on the next query.
   */
  onPoolError?: (error: Error) => void;
}

export interface DbHandle {
  db: Kysely<Database>;
  pool: pg.Pool;
  /** Round trip to Postgres, abandoned client-side after `timeoutMs` so a probe never pins a connection. */
  ping(timeoutMs: number): Promise<void>;
}

export function createDb(options: CreateDbOptions): DbHandle {
  const statementTimeoutMs = options.statementTimeoutMs ?? 15_000;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    application_name: options.applicationName ?? 'bedo',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Client-side backstop for when the server cannot even be reached to enforce statement_timeout.
    query_timeout: statementTimeoutMs + 1_000,
    // Runs, and is awaited, before a new connection is handed out. Set here rather than as a startup
    // parameter, which some connection poolers reject. A failure discards the connection.
    onConnect: async (client) => {
      await client.query(`set statement_timeout = ${Math.trunc(statementTimeoutMs)}`);
    },
  });
  pool.on('error', (error: Error) => {
    options.onPoolError?.(error);
  });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const ping = async (timeoutMs: number): Promise<void> => {
    // query_timeout is a supported per-query option of node-postgres that its type definitions omit.
    await pool.query({ text: 'select 1', query_timeout: timeoutMs } as pg.QueryConfig);
  };
  return { db, pool, ping };
}
