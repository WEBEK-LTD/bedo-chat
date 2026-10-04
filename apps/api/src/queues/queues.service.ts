import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { type OtpJobData, type PushJobData, QUEUE_NAMES } from '@bedo/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { API_ENV } from '../config/tokens.js';

/**
 * Producers for the worker's queues. Jobs that carry a one-time code are removed from Redis as soon as
 * they finish (completed or failed), so codes do not linger.
 */
@Injectable()
export class QueuesService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueuesService.name);
  private readonly connection: Redis;
  readonly otp: Queue<OtpJobData>;
  readonly push: Queue<PushJobData>;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, connectionName: 'bedo-api-queues' });
    this.connection.on('error', (error: Error) => this.logger.warn(`Queue Redis error: ${error.message}`));
    this.otp = new Queue<OtpJobData>(QUEUE_NAMES.otp, {
      connection: this.connection,
      prefix: env.QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    this.push = new Queue<PushJobData>(QUEUE_NAMES.push, {
      connection: this.connection,
      prefix: env.QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      },
    });
  }

  async enqueueOtp(data: OtpJobData): Promise<void> {
    await this.otp.add('send', data);
  }

  async enqueuePush(data: PushJobData): Promise<void> {
    await this.push.add('notify', data);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.otp.close();
    await this.push.close();
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}
