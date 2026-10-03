import { Inject, Injectable } from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';
import { workerHeartbeatKey } from '@bedo/contracts';
import type { Redis } from 'ioredis';
import { WORKER_ENV } from '../tokens.js';

export const WORKER_REDIS = Symbol('WORKER_REDIS');

/**
 * Proves the worker is alive and consuming jobs: each run stores the current time in Redis with a
 * TTL of three intervals, so the key disappears if the worker stops processing.
 */
@Injectable()
export class HeartbeatProcessor {
  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(WORKER_REDIS) private readonly redis: Redis,
  ) {}

  async process(now: Date = new Date()): Promise<void> {
    const ttlSeconds = Math.ceil((this.env.WORKER_HEARTBEAT_INTERVAL_MS * 3) / 1000);
    await this.redis.set(workerHeartbeatKey(this.env.QUEUE_PREFIX), now.toISOString(), 'EX', ttlSeconds);
  }
}
