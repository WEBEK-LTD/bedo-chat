import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { Redis } from 'ioredis';
import { API_ENV } from '../config/tokens.js';

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      // Fail fast instead of queueing commands while Redis is unreachable;
      // the client keeps reconnecting in the background.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectionName: 'bedo-api',
    });
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis connection error: ${error.message}`);
    });
  }

  onModuleInit(): void {
    // Start-up does not wait for Redis: liveness stays up and /health/ready reports the outage.
    this.client.connect().catch((error: unknown) => {
      this.logger.warn(`Redis not reachable at start-up: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async ping(): Promise<void> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') {
      throw new Error(`Unexpected Redis PING reply: ${reply}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.client.disconnect();
  }
}
