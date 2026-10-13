import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { PushService } from '../delivery/push.service.js';
import { DeferredTasks } from '../runtime/deferred-tasks.service.js';

/** Devices reached per batch, and how long one run keeps sending (a function has 30 to 60 seconds). */
const BATCH = 200;
/** Users pushed at the same time within a batch. */
const CONCURRENCY = 20;
const RUN_BUDGET_MS = 15_000;

/**
 * Broadcast notifications (Phase 10, O-20): an admin's notification to every user, or to the members of one group or
 * channel, delivered as Web Push to their signed-in devices. With no worker (D-36) it goes out in batches: right
 * after the admin sends it, then on every run of the scheduled function (each minute) until every device was reached.
 * A broadcast that is cut off continues from the last device reached; a device is never pushed twice by one run.
 */
@Injectable()
export class BroadcastsService {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PushService) private readonly push: PushService,
    @Inject(DeferredTasks) private readonly deferred: DeferredTasks,
  ) {}

  /** Starts delivering after the response. */
  kick(): void {
    this.deferred.defer('broadcasts', () => this.dispatch());
  }

  /** Sends the next batches of every broadcast still sending, for about 15 seconds. Returns the devices reached. */
  async dispatch(): Promise<number> {
    const started = Date.now();
    let reached = 0;
    while (Date.now() - started < RUN_BUDGET_MS) {
      const sent = await this.batch();
      if (sent === null) break;
      reached += sent;
    }
    return reached;
  }

  /**
   * One batch of the oldest broadcast still sending; null when none is. The batch is claimed first (the broadcast's
   * position moves past it in a short transaction), then sent without holding the database: each device is pushed at
   * most once, even if two runs overlap or one stops half-way.
   */
  private async batch(): Promise<number | null> {
    const claimed = await this.database.db.transaction().execute(async (trx) => {
      const broadcast = await trx.selectFrom('app.broadcasts').selectAll().where('status', '=', 'sending').orderBy('created_at').limit(1).forUpdate().skipLocked().executeTakeFirst();
      if (!broadcast) return null;
      const { rows: devices } = await sql<{ id: string; user_id: string; endpoint: string; p256dh: string; auth: string }>`
        select ps.id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth
        from app.push_subscriptions ps
        join app.sessions se on se.id = ps.session_id and se.revoked_at is null and se.expires_at > now()
        join app.users u on u.id = ps.user_id and u.status in ('active', 'deletion_requested')
        where ${broadcast.last_subscription_id ? sql`ps.id > ${broadcast.last_subscription_id}` : sql`true`}
          ${
            broadcast.audience === 'chat'
              ? sql`and exists (select 1 from app.conversation_members m join app.conversations c on c.id = m.conversation_id and c.deleted_at is null
                                where m.conversation_id = ${broadcast.conversation_id} and m.user_id = ps.user_id)`
              : sql``
          }
        order by ps.id
        limit ${BATCH}
      `.execute(trx);
      const done = devices.length < BATCH;
      await trx
        .updateTable('app.broadcasts')
        .set({
          ...(devices.length > 0 ? { last_subscription_id: devices[devices.length - 1]!.id } : {}),
          ...(done ? { status: 'sent' as const, finished_at: sql`now()` } : {}),
        })
        .where('id', '=', broadcast.id)
        .execute();
      return { broadcast, devices };
    });
    if (!claimed) return null;
    const { broadcast, devices } = claimed;
    const byUser = new Map<string, typeof devices>();
    for (const device of devices) byUser.set(device.user_id, [...(byUser.get(device.user_id) ?? []), device]);
    const users = [...byUser];
    let delivered = 0;
    for (let start = 0; start < users.length; start += CONCURRENCY) {
      await Promise.all(
        users.slice(start, start + CONCURRENCY).map(async ([userId, list]) => {
          try {
            const result = await this.push.deliver({
              userId,
              excludeSessionId: null,
              notification: { title: broadcast.title, body: broadcast.body, tag: `broadcast-${broadcast.id.slice(0, 8)}`, url: '/' },
              subscriptions: list.map((device) => ({ endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth })),
            });
            delivered += result.delivered;
          } catch (error) {
            this.logger.warn(`Broadcast ${broadcast.id}: delivery failed (${error instanceof Error ? error.message : String(error)})`);
          }
        }),
      );
    }
    if (delivered > 0) {
      await this.database.db.updateTable('app.broadcasts').set({ devices: sql`devices + ${delivered}` }).where('id', '=', broadcast.id).execute();
    }
    return delivered;
  }
}
