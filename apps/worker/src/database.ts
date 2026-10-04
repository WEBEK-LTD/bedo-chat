import { Logger } from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';
import { createDb, type DbHandle } from '@bedo/db';

export const WORKER_DB = Symbol('WORKER_DB');

export function createWorkerDb(env: WorkerEnv): DbHandle {
  const logger = new Logger('Database');
  return createDb({
    connectionString: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: 'bedo-worker',
    onPoolError: (error) => logger.warn(`Idle database connection failed: ${error.message}`),
  });
}
