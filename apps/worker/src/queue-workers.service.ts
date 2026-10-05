import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';
import { MAINTENANCE_JOB_NAMES, OTP_JOB_NAMES, QUEUE_NAMES } from '@bedo/contracts';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { DbHandle } from '@bedo/db';
import type { Redis } from 'ioredis';
import { WORKER_DB } from './database.js';
import { MaintenanceProcessor } from './maintenance/maintenance.processor.js';
import { OtpProcessor } from './otp/otp.processor.js';
import { PushProcessor } from './push/push.processor.js';
import { bullConnection } from './system/system-queue.service.js';
import { WORKER_ENV } from './tokens.js';

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Consumers for the feature queues (OTP delivery, push) and the hourly maintenance schedule (refresh-token
 * bookkeeping; Phase 3: message partitions and update-log pruning).
 */
@Injectable()
export class QueueWorkersService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(QueueWorkersService.name);
  private readonly workers: Worker[] = [];
  private maintenanceQueue: Queue | undefined;
  private readonly connections: Redis[] = [];

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(OtpProcessor) private readonly otp: OtpProcessor,
    @Inject(PushProcessor) private readonly push: PushProcessor,
    @Inject(MaintenanceProcessor) private readonly maintenance: MaintenanceProcessor,
    @Inject(WORKER_DB) private readonly database: DbHandle,
  ) {}

  private connection(name: string): Redis {
    const connection = bullConnection(this.env.REDIS_URL, name);
    connection.on('error', (error: Error) => this.logger.warn(`Redis error: ${error.message}`));
    this.connections.push(connection);
    return connection;
  }

  async onApplicationBootstrap(): Promise<void> {
    const otpWorker = new Worker(QUEUE_NAMES.otp, (job) => (job.name === OTP_JOB_NAMES.waabekTest ? this.otp.processTest(job.data) : this.otp.process(job.data)), {
      connection: this.connection('bedo-worker-otp'),
      prefix: this.env.QUEUE_PREFIX,
      concurrency: this.env.WORKER_CONCURRENCY,
    });
    otpWorker.on('failed', (job, error) => {
      // Test messages report their result to the Admin Dashboard, which records it; codes are recorded here
      // once retries are used up, or at once when retrying cannot help (settings not usable).
      if (job && job.name !== OTP_JOB_NAMES.waabekTest && (job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError)) {
        void this.otp.onFinalFailure(job.data, error).catch(() => undefined);
      }
    });
    const pushWorker = new Worker(QUEUE_NAMES.push, (job) => this.push.process(job.data), {
      connection: this.connection('bedo-worker-push'),
      prefix: this.env.QUEUE_PREFIX,
      concurrency: this.env.WORKER_CONCURRENCY,
    });
    this.maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, {
      connection: this.connection('bedo-worker-maintenance-queue'),
      prefix: this.env.QUEUE_PREFIX,
      defaultJobOptions: { removeOnComplete: 50, removeOnFail: 50 },
    });
    for (const name of [
      MAINTENANCE_JOB_NAMES.pruneRetiredRefreshTokens,
      MAINTENANCE_JOB_NAMES.ensureMessagePartitions,
      MAINTENANCE_JOB_NAMES.pruneUpdateLog,
    ]) {
      await this.maintenanceQueue.upsertJobScheduler(name, { every: MAINTENANCE_INTERVAL_MS }, { name, data: {} });
    }
    // Phase 3: message partitions are checked at start-up as well, not only after the first hour.
    await this.maintenance.ensureMessagePartitions().catch((error: unknown) => {
      this.logger.error(`Could not ensure message partitions: ${error instanceof Error ? error.message : String(error)}`);
    });
    const maintenanceWorker = new Worker(
      QUEUE_NAMES.maintenance,
      async (job) => {
        if (job.name === MAINTENANCE_JOB_NAMES.pruneRetiredRefreshTokens) {
          await this.maintenance.pruneRetiredRefreshTokens();
          return;
        }
        if (job.name === MAINTENANCE_JOB_NAMES.ensureMessagePartitions) {
          await this.maintenance.ensureMessagePartitions();
          return;
        }
        if (job.name === MAINTENANCE_JOB_NAMES.pruneUpdateLog) {
          await this.maintenance.pruneUpdateLog();
          return;
        }
        throw new Error(`No processor for job "${job.name}" on queue "${QUEUE_NAMES.maintenance}"`);
      },
      { connection: this.connection('bedo-worker-maintenance'), prefix: this.env.QUEUE_PREFIX, concurrency: 1 },
    );
    for (const worker of [otpWorker, pushWorker, maintenanceWorker]) {
      worker.on('error', (error) => this.logger.error(`Worker error: ${error.message}`));
      this.workers.push(worker);
    }
    this.logger.log(`Consuming queues "${QUEUE_NAMES.otp}", "${QUEUE_NAMES.push}" and "${QUEUE_NAMES.maintenance}"`);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await this.maintenanceQueue?.close();
    await Promise.all(this.connections.map((connection) => connection.quit().catch(() => connection.disconnect())));
    await this.database.db.destroy();
  }
}
