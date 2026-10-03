import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';
import { QUEUE_NAMES, SYSTEM_JOB_NAMES } from '@bedo/contracts';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { WORKER_ENV } from '../tokens.js';
import { HeartbeatProcessor, WORKER_REDIS } from './heartbeat.processor.js';

/** BullMQ needs connections that retry forever instead of failing commands while Redis restarts. */
export function bullConnection(url: string, name: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, connectionName: name });
}

/**
 * Owns the "system" queue: registers the repeating heartbeat schedule and consumes its jobs.
 * Feature queues (OTP delivery, push, media, schedules, search indexing) are added by later phases
 * with the same structure.
 */
@Injectable()
export class SystemQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SystemQueueService.name);
  private queue: Queue | undefined;
  private worker: Worker | undefined;
  /** BullMQ never closes connections it was handed, so this service closes them itself. */
  private readonly connections: Redis[] = [];

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(HeartbeatProcessor) private readonly heartbeat: HeartbeatProcessor,
    @Inject(WORKER_REDIS) private readonly sharedRedis: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('Connecting to Redis and registering schedules');
    this.queue = new Queue(QUEUE_NAMES.system, {
      connection: this.track(bullConnection(this.env.REDIS_URL, 'bedo-worker-system-queue')),
      prefix: this.env.QUEUE_PREFIX,
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
    });
    this.queue.on('error', (error) => this.logger.error(`Queue error: ${error.message}`));
    await this.queue.upsertJobScheduler(
      SYSTEM_JOB_NAMES.heartbeat,
      { every: this.env.WORKER_HEARTBEAT_INTERVAL_MS },
      { name: SYSTEM_JOB_NAMES.heartbeat, data: {} },
    );

    this.worker = new Worker(QUEUE_NAMES.system, (job) => this.dispatch(job), {
      connection: this.track(bullConnection(this.env.REDIS_URL, 'bedo-worker-system')),
      prefix: this.env.QUEUE_PREFIX,
      concurrency: this.env.WORKER_CONCURRENCY,
    });
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Job ${job?.name ?? 'unknown'} (${job?.id ?? '-'}) failed: ${error.message}`);
    });
    this.worker.on('error', (error) => {
      this.logger.error(`Worker error: ${error.message}`);
    });
    this.logger.log(`Consuming queue "${QUEUE_NAMES.system}" with concurrency ${this.env.WORKER_CONCURRENCY}`);
  }

  private track(connection: Redis): Redis {
    connection.on('error', (error: Error) => this.logger.warn(`Redis error: ${error.message}`));
    this.connections.push(connection);
    return connection;
  }

  private async dispatch(job: Job): Promise<void> {
    switch (job.name) {
      case SYSTEM_JOB_NAMES.heartbeat:
        await this.heartbeat.process();
        return;
      default:
        throw new Error(`No processor for job "${job.name}" on queue "${QUEUE_NAMES.system}"`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // Let in-flight jobs finish, then release Redis connections (the shared client last,
    // because job processors use it).
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((connection) => connection.quit().catch(() => connection.disconnect())));
    await this.sharedRedis.quit().catch(() => this.sharedRedis.disconnect());
    this.logger.log('Stopped consuming; Redis connections closed');
  }
}
