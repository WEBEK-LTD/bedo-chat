import { Inject, Injectable, Logger } from '@nestjs/common';
import type { UpdateKind } from '@bedo/contracts';
import type { Database } from '@bedo/db';
import { sql, type Transaction } from 'kysely';
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
    const userIds = [...byUser.keys()].sort();
    await trx
      .insertInto('app.user_sync_state')
      .values(userIds.map((userId) => ({ user_id: userId })))
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    // Lock the counters in a fixed order so concurrent changes for the same users cannot deadlock.
    const counters = await trx
      .selectFrom('app.user_sync_state')
      .select(['user_id', 'last_seq'])
      .where('user_id', 'in', userIds)
      .orderBy('user_id')
      .forUpdate()
      .execute();
    const rows: Array<{ user_id: string; seq: string; kind: string; conversation_id: string | null; message_id: string | null; data: Record<string, unknown> }> = [];
    const newLast: Array<{ userId: string; last: bigint }> = [];
    for (const counter of counters) {
      let seq = BigInt(counter.last_seq);
      for (const entry of byUser.get(counter.user_id) ?? []) {
        seq += 1n;
        rows.push({
          user_id: counter.user_id,
          seq: seq.toString(),
          kind: entry.kind,
          conversation_id: entry.chatId ?? null,
          message_id: entry.messageId ?? null,
          data: entry.data ?? {},
        });
      }
      newLast.push({ userId: counter.user_id, last: seq });
    }
    for (let index = 0; index < rows.length; index += 1000) {
      await trx.insertInto('app.update_log').values(rows.slice(index, index + 1000)).execute();
    }
    const values = sql.join(newLast.map((item) => sql`(${item.userId}::uuid, ${item.last.toString()}::bigint)`));
    await sql`
      update app.user_sync_state as s set last_seq = v.last_seq
      from (values ${values}) as v(user_id, last_seq)
      where s.user_id = v.user_id
    `.execute(trx);
  }
}
