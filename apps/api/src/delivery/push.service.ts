import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { isPushServiceUrl, type PushNotificationData, pushNotificationDataSchema } from '@bedo/contracts';
import { sql } from 'kysely';
import webpush from 'web-push';
import { API_ENV } from '../config/tokens.js';
import { DatabaseService } from '../database/database.service.js';
import { DeferredTasks } from '../runtime/deferred-tasks.service.js';

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Delivers one Web Push message. Replaced by a recording fake in automated tests. */
export abstract class PushSender {
  abstract readonly enabled: boolean;
  abstract send(target: PushTarget, payload: string): Promise<void>;
}

/** Real Web Push delivery (VAPID). Off when the VAPID keys are not configured. */
@Injectable()
export class WebPushSender extends PushSender {
  readonly enabled: boolean;
  private readonly vapid: { subject: string; publicKey: string; privateKey: string } | null;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    super();
    this.vapid =
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
        ? { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
        : null;
    this.enabled = this.vapid !== null;
  }

  async send(target: PushTarget, payload: string): Promise<void> {
    if (!this.vapid) {
      return;
    }
    await webpush.sendNotification(target, payload, { TTL: 60 * 60, urgency: 'high', timeout: 5_000, vapidDetails: this.vapid });
  }
}

/**
 * Web Push pipeline (D-21): login alerts and account notices to the user's web sessions. D-36: sent by the
 * API right after the response (no worker); subscriptions the push service reports as gone are removed.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @Inject(PushSender) private readonly sender: PushSender,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DeferredTasks) private readonly deferred: DeferredTasks,
  ) {}

  /** Queues a notification for delivery after the response. */
  notify(data: PushNotificationData): void {
    const job = pushNotificationDataSchema.parse(data);
    if (!this.sender.enabled) {
      return;
    }
    this.deferred.defer('push', () => this.deliver(job));
  }

  async deliver(job: PushNotificationData): Promise<{ delivered: number; removed: number }> {
    const db = this.database.db;
    const targets =
      job.subscriptions ??
      (await db
        .selectFrom('app.push_subscriptions')
        .innerJoin('app.sessions', 'app.sessions.id', 'app.push_subscriptions.session_id')
        .select(['app.push_subscriptions.endpoint', 'app.push_subscriptions.p256dh', 'app.push_subscriptions.auth'])
        .where('app.push_subscriptions.user_id', '=', job.userId)
        .where('app.sessions.revoked_at', 'is', null)
        .where('app.sessions.expires_at', '>', sql<Date>`now()`)
        .$if(job.excludeSessionId !== null, (qb) => qb.where('app.push_subscriptions.session_id', '<>', job.excludeSessionId!))
        .execute());

    const payload = JSON.stringify(job.notification);
    let delivered = 0;
    let removed = 0;
    await Promise.all(
      targets.map(async (target) => {
        if (!isPushServiceUrl(target.endpoint)) {
          // Only browser push services are ever contacted (the API also refuses other addresses).
          await db.deleteFrom('app.push_subscriptions').where('endpoint', '=', target.endpoint).execute();
          removed += 1;
          return;
        }
        try {
          await this.sender.send({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload);
          delivered += 1;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // The browser unsubscribed or the subscription expired.
            await db.deleteFrom('app.push_subscriptions').where('endpoint', '=', target.endpoint).execute();
            removed += 1;
          } else {
            this.logger.warn(`Push delivery failed (status ${status ?? 'none'})`);
          }
        }
      }),
    );
    return { delivered, removed };
  }
}
