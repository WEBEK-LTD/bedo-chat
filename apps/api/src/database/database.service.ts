import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { createDb, type Database, type DbHandle } from '@bedo/db';
import type { Kysely } from 'kysely';
import { API_ENV } from '../config/tokens.js';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  readonly db: Kysely<Database>;
  private readonly pingDatabase: DbHandle['ping'];

  constructor(@Inject(API_ENV) env: ApiEnv) {
    const handle = createDb({
      connectionString: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      applicationName: 'bedo-api',
      // A dropped idle connection must never crash the process; the pool replaces it.
      onPoolError: (error) => this.logger.warn(`Idle database connection failed: ${error.message}`),
    });
    this.db = handle.db;
    this.pingDatabase = handle.ping;
  }

  /** Round trip to Postgres, abandoned client-side after `timeoutMs` so a probe never pins a connection. */
  async ping(timeoutMs: number): Promise<void> {
    await this.pingDatabase(timeoutMs);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
