import { Inject, Injectable, Logger } from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';
import { isPushServiceUrl, type PushJobData, pushJobDataSchema } from '@bedo/contracts';
import type { DbHandle } from '@bedo/db';
import { sql } from 'kysely';
import webpush from 'web-push';
import { WORKER_DB } from '../database.js';

export interface PushSender {
  send(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string): Promise<void>;
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/** Real Web Push delivery (VAPID). */
export function createWebPushSender(env: WorkerEnv): PushSender | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    return null;
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  return {
    async send(subscription, payload) {
      await webpush.sendNotification(subscription, payload, { TTL: 60 * 60, urgency: 'high' });
    },
  };
}

/**
 * Web Push pipeline (D-21). Phase 2 sends login alerts and account notices to the user's web sessions;
 * Phase 7 adds message notifications and Phase 12 native APNs/FCM delivery to the same pipeline.
 */
@Injectable()
export class PushProcessor {
  private readonly logger = new Logger(PushProcessor.name);

  constructor(
    @Inject(WORKER_DB) private readonly database: DbHandle,
    @Inject(PUSH_SENDER) private readonly sender: PushSender | null,
  ) {}

  async process(raw: unknown): Promise<{ delivered: number; removed: number }> {
    const job: PushJobData = pushJobDataSchema.parse(raw);
    if (!this.sender) {
      this.logger.warn('Push is not configured (VAPID keys missing); notification skipped');
      return { delivered: 0, removed: 0 };
    }
    const targets =
      job.subscriptions ??
      (await this.database.db
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
    for (const target of targets) {
      if (!isPushServiceUrl(target.endpoint)) {
        // Only browser push services are ever contacted (the API also refuses other addresses).
        await this.database.db.deleteFrom('app.push_subscriptions').where('endpoint', '=', target.endpoint).execute();
        removed += 1;
        continue;
      }
      try {
        await this.sender.send({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload);
        delivered += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // The browser unsubscribed or the subscription expired.
          await this.database.db.deleteFrom('app.push_subscriptions').where('endpoint', '=', target.endpoint).execute();
          removed += 1;
        } else {
          this.logger.warn(`Push delivery failed (status ${status ?? 'none'})`);
        }
      }
    }
    return { delivered, removed };
  }
}
