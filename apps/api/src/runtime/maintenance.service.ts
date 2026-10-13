import { Inject, Injectable, Logger } from '@nestjs/common';
import { MEDIA_RULES, MESSAGING_RULES, TOKEN_RULES } from '@bedo/contracts';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { CHAT_MEDIA_BUCKET, MediaStorage } from '../storage/media-storage.js';
import { DeferredTasks } from './deferred-tasks.service.js';
import { MonitoringService } from './monitoring.service.js';

/** Months of message partitions kept ready beyond the current one. */
export const MESSAGE_PARTITIONS_AHEAD = 3;
const PRUNE_BATCH_SIZE = 5_000;
const RUN_EVERY_MS = 60 * 60 * 1000;
/** How often one server instance asks the database whether the hourly run is due. */
const CHECK_EVERY_MS = 5 * 60 * 1000;
const RUN_NAME = 'hourly';

/**
 * Hourly housekeeping (D-36: no worker or scheduler). Any request can start it: at most every five minutes
 * per server instance it asks the database whether an hour has passed since the last run, and exactly one
 * request claims the run (an atomic update of app.maintenance_runs). It runs after that request's response.
 * It keeps security bookkeeping and short-lived state from growing without bound and keeps message
 * partitions ready; it never touches the audit history (which the runtime role cannot delete anyway).
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);
  private nextCheckAt = 0;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DeferredTasks) private readonly deferred: DeferredTasks,
    @Inject(MediaStorage) private readonly media: MediaStorage,
    @Inject(MonitoringService) private readonly monitoring: MonitoringService,
  ) {}

  /** Called for every request; cheap unless a check is due. */
  poke(): void {
    const now = Date.now();
    if (now < this.nextCheckAt) {
      return;
    }
    this.nextCheckAt = now + CHECK_EVERY_MS;
    this.deferred.defer('maintenance', () => this.runIfDue());
  }

  /** Runs the hourly tasks if no other instance ran them in the last hour. Returns whether it ran them. */
  async runIfDue(): Promise<boolean> {
    if (!(await this.claim())) {
      return false;
    }
    await this.runAll();
    return true;
  }

  private async claim(): Promise<boolean> {
    const { rows } = await sql<{ name: string }>`
      insert into app.maintenance_runs as m (name, last_run_at) values (${RUN_NAME}, now())
      on conflict (name) do update set last_run_at = excluded.last_run_at
      where m.last_run_at <= now() - make_interval(secs => ${RUN_EVERY_MS / 1000})
      returning m.name
    `.execute(this.database.db);
    return rows.length > 0;
  }

  async runAll(): Promise<void> {
    for (const [name, task] of [
      ['message partitions', () => this.ensureMessagePartitions()],
      ['retired refresh tokens', () => this.pruneRetiredRefreshTokens()],
      ['update log', () => this.pruneUpdateLog()],
      ['expired short-lived state', () => this.pruneExpiredState()],
      ['unused upload slots', () => this.pruneUnusedUploads()],
      ['site monitoring history', () => this.monitoring.prune()],
    ] as const) {
      try {
        await task();
      } catch (error) {
        this.logger.error(`Housekeeping (${name}) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Retired refresh-token hashes exist only for reuse detection. They stop mattering once their session
   * has ended (any token is refused then) or after 30 days (D-49).
   */
  async pruneRetiredRefreshTokens(): Promise<number> {
    const result = await this.database.db
      .deleteFrom('app.retired_refresh_tokens')
      .where((eb) =>
        eb.or([
          eb('retired_at', '<', sql<Date>`now() - make_interval(days => ${TOKEN_RULES.retiredTokenDays})`),
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
   * Phase 3: monthly message partitions for the current month and the next three; creating a partition that
   * exists is a no-op. The function runs with the owner's rights, so the runtime role needs no DDL privilege.
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

  /** D-36: expired pending sign-ins, counters, code-limit events and device presence rows. */
  async pruneExpiredState(): Promise<number> {
    const db = this.database.db;
    const results = await Promise.all([
      db.deleteFrom('app.ephemeral').where('expires_at', '<=', sql<Date>`now()`).executeTakeFirst(),
      db.deleteFrom('app.rate_counters').where('expires_at', '<=', sql<Date>`now()`).executeTakeFirst(),
      db.deleteFrom('app.rate_events').where('at', '<=', sql<Date>`now() - interval '1 hour'`).executeTakeFirst(),
    ]);
    return results.reduce((total, result) => total + Number(result.numDeletedRows), 0);
  }

  /**
   * Phase 4: upload slots never used within a day are removed with their objects. Files that were sent (ready)
   * are part of the history and are never touched (a database trigger refuses it).
   */
  async pruneUnusedUploads(): Promise<number> {
    let removed = 0;
    for (;;) {
      const rows = await this.database.db
        .deleteFrom('app.files')
        .where(
          'id',
          'in',
          this.database.db
            .selectFrom('app.files')
            .select('id')
            .where('status', '=', 'pending')
            .where('created_at', '<', sql<Date>`now() - make_interval(hours => ${MEDIA_RULES.uploadSlotHours})`)
            .limit(500),
        )
        .returning(['object_path', 'thumbnail_path'])
        .execute();
      if (rows.length === 0) {
        break;
      }
      removed += rows.length;
      if (this.media.enabled) {
        await this.media.remove(
          CHAT_MEDIA_BUCKET,
          rows.flatMap((row) => [row.object_path, row.thumbnail_path]).filter((path): path is string => path !== null),
        );
      }
      if (rows.length < 500) {
        break;
      }
    }
    if (removed > 0) {
      this.logger.log(`Removed ${removed} unused upload slots`);
    }
    return removed;
  }
}
