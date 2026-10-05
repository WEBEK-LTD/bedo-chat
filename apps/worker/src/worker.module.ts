import { type DynamicModule, Logger, Module } from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';
import { Redis } from 'ioredis';
import { HeartbeatProcessor, WORKER_REDIS } from './system/heartbeat.processor.js';
import { SystemQueueService } from './system/system-queue.service.js';
import { WORKER_ENV } from './tokens.js';
import { createWorkerDb, WORKER_DB } from './database.js';
import { MaintenanceProcessor } from './maintenance/maintenance.processor.js';
import { OtpProcessor } from './otp/otp.processor.js';
import { WaabekClient } from './otp/waabek.client.js';
import { WaabekKeyProvider } from './otp/waabek-key.provider.js';
import { createWebPushSender, PUSH_SENDER, PushProcessor } from './push/push.processor.js';
import { QueueWorkersService } from './queue-workers.service.js';
import type { DbHandle } from '@bedo/db';

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
        {
          provide: WORKER_DB,
          // Closed by QueueWorkersService after the consumers stop, so in-flight jobs keep their connection.
          useFactory: (): DbHandle => createWorkerDb(env),
        },
        { provide: PUSH_SENDER, useFactory: () => createWebPushSender(env) },
        WaabekClient,
        WaabekKeyProvider,
        OtpProcessor,
        PushProcessor,
        MaintenanceProcessor,
        QueueWorkersService,
      ],
    };
  }
}
