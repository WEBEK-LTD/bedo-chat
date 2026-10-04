import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { RealtimeServerMessage } from '@bedo/contracts';
import type { Redis } from 'ioredis';
import { RedisService } from '../redis/redis.service.js';

/** What one API instance tells every other instance (and itself) through Redis. */
export type BusMessage =
  /** These users' update logs moved on: their connected devices fetch the new entries (permission-checked). */
  | { t: 'updates'; users: string[] }
  /** A short-lived event for one user's devices, already checked by the permission service. */
  | { t: 'event'; to: string; event: RealtimeServerMessage };

type Listener = (message: BusMessage) => void;

/**
 * Fan-out across API instances (blueprint: Gateway, horizontally scaled through Redis). Messages are
 * stored in Postgres before anything is published, so a lost publish only delays a device until its next
 * sync; nothing depends on Redis delivering it.
 */
@Injectable()
export class RealtimeBusService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeBusService.name);
  private subscriber: Redis | null = null;
  private readonly listeners = new Set<Listener>();
  readonly channel: string;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    this.channel = `${redis.prefix}:realtime`;
  }

  onModuleInit(): void {
    if (!this.redis.client) {
      // Unit tests replace Redis with a stand-in that has no client; there is nothing to subscribe to.
      return;
    }
    // A subscriber connection cannot run other commands; it reconnects and resubscribes on its own.
    const subscriber = this.redis.client.duplicate({ lazyConnect: true, enableOfflineQueue: true, maxRetriesPerRequest: null, connectionName: 'bedo-api-realtime' });
    subscriber.on('error', (error: Error) => this.logger.warn(`Realtime subscriber error: ${error.message}`));
    subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== this.channel) {
        return;
      }
      let message: BusMessage;
      try {
        message = JSON.parse(raw) as BusMessage;
      } catch {
        return;
      }
      for (const listener of this.listeners) {
        listener(message);
      }
    });
    this.subscriber = subscriber;
    subscriber
      .connect()
      .then(() => subscriber.subscribe(this.channel))
      .catch((error: unknown) => {
        this.logger.warn(`Realtime subscriber not connected at start-up: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Best effort: a failed publish is logged; devices still catch up on their next sync. */
  publish(message: BusMessage): void {
    this.redis.client.publish(this.channel, JSON.stringify(message)).catch((error: unknown) => {
      this.logger.warn(`Realtime publish failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  notifyUpdates(userIds: Iterable<string>): void {
    const users = [...new Set(userIds)];
    if (users.length > 0) {
      this.publish({ t: 'updates', users });
    }
  }

  sendEvent(to: string, event: RealtimeServerMessage): void {
    this.publish({ t: 'event', to, event });
  }

  async onApplicationShutdown(): Promise<void> {
    this.listeners.clear();
    this.subscriber?.disconnect();
  }
}
