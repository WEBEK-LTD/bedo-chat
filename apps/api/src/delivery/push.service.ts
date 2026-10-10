import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { isPushServiceUrl, type PushNotificationData, pushNotificationDataSchema } from '@bedo/contracts';
import { decryptAtRest, encryptAtRest, parseAes256Key } from '@bedo/server-crypto';
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
  /** The public key browsers subscribe with (base64url), or null when push is off. */
  abstract publicKey(): Promise<string | null>;
  abstract send(target: PushTarget, payload: string): Promise<void>;
}

interface Vapid {
  subject: string;
  publicKey: string;
  privateKey: string;
}

const VAPID_KEY_PURPOSE = 'bedo vapid private key v1';
/** The contact a push service sees with every message (VAPID "sub"); VAPID_SUBJECT overrides it. */
const DEFAULT_VAPID_SUBJECT = 'https://bedochat.com';

/**
 * Real Web Push delivery (VAPID). Phase 13 (D-46): the key pair is made by the API the first time it is needed and
 * kept in the database (app.push_keys, one row that never changes; the private key encrypted with
 * SETTINGS_ENCRYPTION_KEY), so notifications work with no extra variable to set. The three VAPID_* variables, when
 * all are set, are used instead (as before Phase 13).
 */
@Injectable()
export class WebPushSender extends PushSender {
  readonly enabled = true;
  private readonly configured: Vapid | null;
  private readonly subject: string;
  private readonly settingsKey: Buffer;
  private stored: Promise<Vapid> | null = null;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {
    super();
    this.configured =
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
        ? { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
        : null;
    this.subject = env.VAPID_SUBJECT ?? DEFAULT_VAPID_SUBJECT;
    this.settingsKey = parseAes256Key(env.SETTINGS_ENCRYPTION_KEY);
  }

  async publicKey(): Promise<string> {
    return (await this.vapid()).publicKey;
  }

  async send(target: PushTarget, payload: string): Promise<void> {
    const vapid = await this.vapid();
    await webpush.sendNotification(target, payload, { TTL: 60 * 60, urgency: 'high', timeout: 5_000, vapidDetails: vapid });
  }

  private vapid(): Promise<Vapid> {
    if (this.configured) return Promise.resolve(this.configured);
    this.stored ??= this.loadOrCreate().catch((error: unknown) => {
      this.stored = null;
      throw error;
    });
    return this.stored;
  }

  /** Reads the stored pair, or makes one. Two instances starting together keep whichever was saved first. */
  private async loadOrCreate(): Promise<Vapid> {
    const db = this.database.db;
    let row = await db.selectFrom('app.push_keys').select(['public_key', 'private_key_enc']).executeTakeFirst();
    if (!row) {
      const generated = webpush.generateVAPIDKeys();
      await db
        .insertInto('app.push_keys')
        .values({ public_key: generated.publicKey, private_key_enc: encryptAtRest(this.settingsKey, Buffer.from(generated.privateKey, 'utf8'), VAPID_KEY_PURPOSE) })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      row = await db.selectFrom('app.push_keys').select(['public_key', 'private_key_enc']).executeTakeFirstOrThrow();
    }
    return { subject: this.subject, publicKey: row.public_key, privateKey: decryptAtRest(this.settingsKey, row.private_key_enc, VAPID_KEY_PURPOSE).toString('utf8') };
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
