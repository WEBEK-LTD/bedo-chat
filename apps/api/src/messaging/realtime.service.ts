import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { REALTIME_SIGNAL_EVENT, type RealtimeSignal } from '@bedo/contracts';
import { sql } from 'kysely';
import { API_ENV } from '../config/tokens.js';
import { DatabaseService } from '../database/database.service.js';
import { DeferredTasks } from '../runtime/deferred-tasks.service.js';
import { RealtimeBroadcaster } from './realtime-broadcaster.js';

/** A device's channel name changes every hour, so a name seen once is useful only until then. */
export const CHANNEL_PERIOD_MS = 60 * 60 * 1000;
/** After a change, signals also go to the previous name for this long, while devices move to the new one. */
const CHANNEL_OVERLAP_MS = 2 * 60 * 1000;

/**
 * Realtime signals to signed-in devices (D-36, replacing the WebSocket gateway and its Redis fan-out).
 *
 * Each session has its own channel, named by an HMAC of the session id and the current hour under a key derived
 * from ACCESS_TOKEN_SECRET: only that device learns the name (GET /v1/realtime/channel, authenticated), nobody
 * can derive another device's, and a name seen once stops receiving within the hour. Signals are sent only to
 * sessions that are still valid when they are sent, so a device that signed out or was removed receives nothing
 * more. Signals carry no message content: messages are
 * stored in Postgres before any signal, and the device fetches them over HTTP; a lost signal only delays a
 * device until its next heartbeat (every 25 s), which returns its current update position.
 */
@Injectable()
export class RealtimeService {
  private readonly topicKey: Buffer;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DeferredTasks) private readonly deferred: DeferredTasks,
    @Inject(RealtimeBroadcaster) private readonly broadcaster: RealtimeBroadcaster,
  ) {
    this.topicKey = createHmac('sha256', env.ACCESS_TOKEN_SECRET).update('bedo realtime channel names v1').digest();
  }

  get enabled(): boolean {
    return this.broadcaster.enabled;
  }

  get client(): { url: string; apiKey: string } | null {
    return this.broadcaster.client;
  }

  /** The token with which this device may receive on `topic` (and nowhere else) until shortly after `expiresAt`. */
  deviceToken(userId: string, channel: { topic: string; expiresAt: Date }): string | null {
    return this.broadcaster.deviceToken({ userId, topic: channel.topic, expiresAt: channel.expiresAt });
  }

  /** The device's channel for the period containing `at` (now by default), and when that period ends. */
  channelFor(sessionId: string, at = Date.now()): { topic: string; expiresAt: Date } {
    const period = Math.floor(at / CHANNEL_PERIOD_MS);
    return { topic: this.topic(sessionId, period), expiresAt: new Date((period + 1) * CHANNEL_PERIOD_MS) };
  }

  private topic(sessionId: string, period: number): string {
    return `bedo-${createHmac('sha256', this.topicKey).update(`${sessionId}:${period}`).digest('base64url')}`;
  }

  /** Where a signal for this session goes now: the current name, and just after a change also the previous one. */
  private topicsNow(sessionId: string): string[] {
    const now = Date.now();
    const period = Math.floor(now / CHANNEL_PERIOD_MS);
    const topics = [this.topic(sessionId, period)];
    if (now - period * CHANNEL_PERIOD_MS < CHANNEL_OVERLAP_MS) {
      topics.push(this.topic(sessionId, period - 1));
    }
    return topics;
  }

  /** These users' update logs moved on: their devices fetch the new entries. Sent after the response. */
  notifyUpdates(userIds: Iterable<string>): void {
    const users = [...new Set(userIds)];
    if (users.length > 0 && this.enabled) {
      this.deferred.defer('realtime-updates', () => this.signal(users, { type: 'updates' }));
    }
  }

  /** A short-lived event for one user's devices, already allowed by the permission service. */
  sendEvent(to: string, signal: RealtimeSignal): void {
    if (this.enabled) {
      this.deferred.defer('realtime-event', () => this.signal([to], signal));
    }
  }

  private async signal(userIds: string[], signal: RealtimeSignal): Promise<void> {
    const sessions = await this.database.db
      .selectFrom('app.sessions as s')
      .innerJoin('app.users as u', 'u.id', 's.user_id')
      .select('s.id')
      .where('s.user_id', 'in', userIds)
      .where('s.revoked_at', 'is', null)
      .where('s.expires_at', '>', sql<Date>`now()`)
      .where('u.status', 'not in', ['suspended', 'banned', 'deleted'])
      .execute();
    await this.broadcaster.send(
      sessions.flatMap((session) => this.topicsNow(session.id).map((topic) => ({ topic, event: REALTIME_SIGNAL_EVENT, payload: signal }))),
    );
  }
}
