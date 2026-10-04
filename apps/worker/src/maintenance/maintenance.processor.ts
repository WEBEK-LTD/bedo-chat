import { Inject, Injectable, Logger } from '@nestjs/common';
import { TOKEN_RULES } from '@bedo/contracts';
import type { DbHandle } from '@bedo/db';
import { sql } from 'kysely';
import { WORKER_DB } from '../database.js';

/**
 * Housekeeping that keeps security bookkeeping from growing without bound. It never touches the audit
 * history (which the runtime role cannot delete anyway).
 */
@Injectable()
export class MaintenanceProcessor {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(@Inject(WORKER_DB) private readonly database: DbHandle) {}

  /**
   * Retired refresh-token hashes exist only for reuse detection. They stop mattering once their session
   * has ended (any token is refused then) or after the 30-day idle limit.
   */
  async pruneRetiredRefreshTokens(): Promise<number> {
    const result = await this.database.db
      .deleteFrom('app.retired_refresh_tokens')
      .where((eb) =>
        eb.or([
          eb('retired_at', '<', sql<Date>`now() - make_interval(days => ${TOKEN_RULES.refreshTokenIdleDays})`),
          eb.exists(
            eb
              .selectFrom('app.sessions')
              .select(sql`1`.as('one'))
              .whereRef('app.sessions.id', '=', 'app.retired_refresh_tokens.session_id')
              .where((inner) => inner.or([inner('app.sessions.revoked_at', 'is not', null), inner('app.sessions.expires_at', '<=', sql<Date>`now()`)])),
          ),
        ]),
      )
      .executeTakeFirst();
    const removed = Number(result.numDeletedRows);
    if (removed > 0) {
      this.logger.log(`Removed ${removed} retired refresh-token hashes`);
    }
    return removed;
  }
}
