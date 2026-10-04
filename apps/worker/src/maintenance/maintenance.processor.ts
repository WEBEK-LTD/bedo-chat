import { Inject, Injectable, Logger } from '@nestjs/common';
import { MESSAGING_RULES, TOKEN_RULES } from '@bedo/contracts';
import type { DbHandle } from '@bedo/db';
import { sql } from 'kysely';
import { WORKER_DB } from '../database.js';

/**
 * Housekeeping that keeps security bookkeeping from growing without bound. It never touches the audit
 * history (which the runtime role cannot delete anyway).
 */
/** Months of message partitions kept ready beyond the current one. */
export const MESSAGE_PARTITIONS_AHEAD = 3;
const PRUNE_BATCH_SIZE = 5_000;

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

  /**
   * Phase 3: monthly message partitions for the current month and the next three. Runs at start-up and
   * hourly; creating a partition that exists is a no-op. The function runs with the owner's rights, so the
   * runtime role needs no DDL privilege.
   */
  async ensureMessagePartitions(): Promise<number> {
    const { rows } = await sql<{ created: number }>`select app.ensure_message_partitions(${MESSAGE_PARTITIONS_AHEAD}) as created`.execute(this.database.db);
    const created = Number(rows[0]?.created ?? 0);
    if (created > 0) {
      this.logger.log(`Created ${created} message partitions`);
    }
    return created;
  }

  /**
   * Phase 3 (P-17): the update log is for syncing devices, not history; entries older than 30 days are
   * removed (a device that far behind re-fetches its chats instead), in batches so no run holds locks for
   * long. Each user's pruned position is recorded so sync can tell a device it is too far behind.
   * Idempotency keys of the same age go too. Messages and the audit history are never touched.
   */
  async pruneUpdateLog(batchSize = PRUNE_BATCH_SIZE): Promise<{ updates: number; requests: number }> {
    const cutoff = sql<Date>`now() - make_interval(days => ${MESSAGING_RULES.updateLogRetentionDays})`;
    let updates = 0;
    for (;;) {
      const { rows } = await sql<{ removed: string }>`
        with doomed as (
          select user_id, seq from app.update_log where created_at < ${cutoff} order by created_at limit ${batchSize}
        ), removed as (
          delete from app.update_log l using doomed d where l.user_id = d.user_id and l.seq = d.seq returning l.user_id, l.seq
        ), marked as (
          update app.user_sync_state s set pruned_through_seq = greatest(s.pruned_through_seq, m.max_seq)
          from (select user_id, max(seq) as max_seq from removed group by user_id) m
          where s.user_id = m.user_id
        )
        select count(*)::text as removed from removed
      `.execute(this.database.db);
      const removed = Number(rows[0]?.removed ?? 0);
      updates += removed;
      if (removed < batchSize) {
        break;
      }
    }
    let requests = 0;
    for (;;) {
      const { rows } = await sql<{ removed: string }>`
        with removed as (
          delete from app.message_requests r using (
            select sender_id, client_id from app.message_requests where created_at < ${cutoff} limit ${batchSize}
          ) d where r.sender_id = d.sender_id and r.client_id = d.client_id returning 1
        )
        select count(*)::text as removed from removed
      `.execute(this.database.db);
      const removed = Number(rows[0]?.removed ?? 0);
      requests += removed;
      if (removed < batchSize) {
        break;
      }
    }
    if (updates + requests > 0) {
      this.logger.log(`Pruned ${updates} update-log entries and ${requests} idempotency keys older than ${MESSAGING_RULES.updateLogRetentionDays} days`);
    }
    return { updates, requests };
  }
}
