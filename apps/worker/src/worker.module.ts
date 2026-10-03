import { type DynamicModule, Logger, Module } from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';
import { Redis } from 'ioredis';
import { HeartbeatProcessor, WORKER_REDIS } from './system/heartbeat.processor.js';
import { SystemQueueService } from './system/system-queue.service.js';
import { WORKER_ENV } from './tokens.js';

@Module({})
export class WorkerModule {
  static forRoot(env: WorkerEnv): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: WORKER_ENV, useValue: env },
        {
          provide: WORKER_REDIS,
          useFactory: () => {
            const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, connectionName: 'bedo-worker' });
            // Listen from creation so a Redis outage during start-up is logged, not an unhandled event.
            const logger = new Logger('Redis');
            redis.on('error', (error: Error) => logger.warn(`Redis error: ${error.message}`));
            return redis;
          },
        },
        HeartbeatProcessor,
        SystemQueueService,
      ],
    };
  }
}
