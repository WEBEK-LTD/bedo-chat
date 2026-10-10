import { Inject, Injectable, Logger } from '@nestjs/common';
import type { UpdateKind } from '@bedo/contracts';
import type { Database } from '@bedo/db';
import { type RawBuilder, sql, type Transaction } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { RealtimeService } from './realtime.service.js';

export interface UpdateEntry {
  userId: string;
  kind: UpdateKind;
  chatId?: string | null;
  messageId?: string | null;
  data?: Record<string, unknown>;
}

/** Collects the update-log entries of one change; they are written at the end of its transaction. */
export class UpdateCollector {
  readonly entries: UpdateEntry[] = [];

  add(entry: UpdateEntry): void {
    this.entries.push(entry);
  }

  /** The same entry for several users. */
  addFor(userIds: Iterable<string>, entry: Omit<UpdateEntry, 'userId'>): void {
    for (const userId of userIds) {
      this.entries.push({ ...entry, userId });
    }
  }
}

/** Postgres errors that mean "try the whole transaction again". */
const RETRYABLE = new Set(['40001', '40P01']);
const MAX_ATTEMPTS = 3;

/**
 * The write path of every messaging change (blueprint: Messaging, sync and multi-device): one transaction
 * makes the change, writes its audit records and appends an entry to each affected user's update log
 * (P-17); only after it commits are the users' devices signalled to fetch the new entries (D-36: after the
 * response, through Supabase Realtime).
 *
 * Lock order, kept by every change: conversation rows (by id), then member rows, then the users'
 * update-log counters (by user id, taken last, here).
 */
@Injectable()
export class UpdateLogService {
  private readonly logger = new Logger(UpdateLogService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  async run<T>(change: (trx: Transaction<Database>, updates: UpdateCollector) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const updates = new UpdateCollector();
      try {
        const result = await this.database.db.transaction().execute(async (trx) => {
          const value = await change(trx, updates);
          await this.append(trx, updates.entries);
          return value;
        });
        this.realtime.notifyUpdates(updates.entries.map((entry) => entry.userId));
        return result;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (attempt < MAX_ATTEMPTS && typeof code === 'string' && RETRYABLE.has(code)) {
          this.logger.warn(`Retrying a messaging change after ${code}`);
          continue;
        }
        // The hourly housekeeping keeps message partitions three months ahead; if it has not run for that long
        // (no traffic), the missing month is created here (owner-rights function) and the change retried.
        if (attempt < MAX_ATTEMPTS && code === '23514' && /no partition of relation/.test(String((error as Error).message))) {
          this.logger.warn('No message partition for the current month: creating it');
          await sql`select app.ensure_message_partitions(3)`.execute(this.database.db);
          continue;
        }
        throw error;
      }
    }
  }

  /** Appends entries to the users' logs with consecutive per-user sequence numbers. */
  private async append(trx: Transaction<Database>, entries: UpdateEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const byUser = new Map<string, UpdateEntry[]>();
    for (const entry of entries) {
      const list = byUser.get(entry.userId) ?? [];
      list.push(entry);
      byUser.set(entry.userId, list);
    }
    // Phase 14.4: one statement instead of four. Each user's counter is created or moved on by the number of new
    // entries (rows taken in user-id order, so concurrent changes cannot deadlock), and the entries get the numbers
    // just below the new counter value.
    const userIds = [...byUser.keys()].sort();
    const counts = sql.join(userIds.map((userId) => sql`(${userId}::uuid, ${byUser.get(userId)!.length}::bigint)`));
    const rows: RawBuilder<unknown>[] = [];
    for (const userId of userIds) {
      const list = byUser.get(userId)!;
      list.forEach((entry, index) => {
        rows.push(
          sql`(${userId}::uuid, ${index + 1}::bigint, ${list.length}::bigint, ${entry.kind}::text, ${entry.chatId ?? null}::uuid, ${entry.messageId ?? null}::uuid, ${JSON.stringify(entry.data ?? {})}::jsonb)`,
        );
      });
    }
    if (rows.length <= 1000) {
      await sql`
        with counters as (
          insert into app.user_sync_state as s (user_id, last_seq)
          select v.user_id, v.n from (values ${counts}) as v (user_id, n) order by v.user_id
          on conflict (user_id) do update set last_seq = s.last_seq + excluded.last_seq
          returning s.user_id, s.last_seq
        )
        insert into app.update_log (user_id, seq, kind, conversation_id, message_id, data)
        select e.user_id, c.last_seq - e.total + e.ord, e.kind, e.conversation_id, e.message_id, e.data
        from (values ${sql.join(rows)}) as e (user_id, ord, total, kind, conversation_id, message_id, data)
        join counters as c on c.user_id = e.user_id
      `.execute(trx);
      return;
    }
    // Very large changes (over 1000 entries, e.g. a broadcast to many members): counters first, then the entries in
    // chunks.
    const allocated = await sql<{ user_id: string; last_seq: string }>`
      insert into app.user_sync_state as s (user_id, last_seq)
      select v.user_id, v.n from (values ${counts}) as v (user_id, n) order by v.user_id
      on conflict (user_id) do update set last_seq = s.last_seq + excluded.last_seq
      returning s.user_id, s.last_seq
    `.execute(trx);
    const lastByUser = new Map(allocated.rows.map((row) => [row.user_id, BigInt(row.last_seq)]));
    const logRows: Array<{ user_id: string; seq: string; kind: string; conversation_id: string | null; message_id: string | null; data: Record<string, unknown> }> = [];
    for (const userId of userIds) {
      const list = byUser.get(userId)!;
      const first = lastByUser.get(userId)! - BigInt(list.length);
      list.forEach((entry, index) => {
        logRows.push({
          user_id: userId,
          seq: (first + BigInt(index + 1)).toString(),
          kind: entry.kind,
          conversation_id: entry.chatId ?? null,
          message_id: entry.messageId ?? null,
          data: entry.data ?? {},
        });
      });
    }
    for (let index = 0; index < logRows.length; index += 1000) {
      await trx.insertInto('app.update_log').values(logRows.slice(index, index + 1000)).execute();
    }
  }
}
