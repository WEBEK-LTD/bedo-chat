import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import {
  ADMIN_BOOTSTRAP_RULES,
  OTP_DELIVERY_ERRORS,
  OTP_JOB_NAMES,
  type OtpDeliveryFailure,
  type OtpJobData,
  type PushJobData,
  QUEUE_NAMES,
  type WaabekTestJobData,
} from '@bedo/contracts';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { API_ENV } from '../config/tokens.js';

/**
 * Producers for the worker's queues. Jobs that carry a one-time code are removed from Redis as soon as
 * they finish (completed or failed), so codes do not linger.
 */
export type WaabekTestOutcome = { delivered: true } | { delivered: false; reason: OtpDeliveryFailure; httpStatus: number | null };

/** Maps the worker's failure text (never secret, see OTP_DELIVERY_ERRORS) to a reason for the dashboard. */
export function classifyDeliveryFailure(message: string): { reason: OtpDeliveryFailure; httpStatus: number | null } {
  if (message.startsWith(OTP_DELIVERY_ERRORS.notConfigured)) {
    return { reason: 'not_configured', httpStatus: null };
  }
  if (message.startsWith(OTP_DELIVERY_ERRORS.keyUnreadable)) {
    return { reason: 'key_unreadable', httpStatus: null };
  }
  if (message.startsWith(OTP_DELIVERY_ERRORS.waabekPrefix)) {
    const status = /HTTP (\d{3})$/.exec(message);
    return status ? { reason: 'rejected', httpStatus: Number(status[1]) } : { reason: 'unreachable', httpStatus: null };
  }
  return { reason: 'no_answer', httpStatus: null };
}

@Injectable()
export class QueuesService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueuesService.name);
  private readonly connection: Redis;
  readonly otp: Queue<OtpJobData>;
  readonly push: Queue<PushJobData>;
  private readonly redisUrl: string;
  private readonly prefix: string;
  private otpEvents: Promise<QueueEvents> | undefined;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.redisUrl = env.REDIS_URL;
    this.prefix = env.QUEUE_PREFIX;
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
    await this.otp.add(OTP_JOB_NAMES.send, data);
  }

  /** Completion events of the OTP queue, opened on first use (only test messages wait for a result). */
  private events(): Promise<QueueEvents> {
    this.otpEvents ??= (async () => {
      const connection = new Redis(this.redisUrl, { maxRetriesPerRequest: null, connectionName: 'bedo-api-queue-events' });
      connection.on('error', (error: Error) => this.logger.warn(`Queue events Redis error: ${error.message}`));
      const events = new QueueEvents(QUEUE_NAMES.otp, { connection, prefix: this.prefix });
      await events.waitUntilReady();
      return events;
    })().catch((error: unknown) => {
      this.otpEvents = undefined;
      throw error;
    });
    return this.otpEvents;
  }

  /**
   * Sends a WhatsApp test message through the worker (the same path, settings and key as one-time codes)
   * and waits for the result. The job carries only the number; the worker reads the key itself.
   */
  async sendWaabekTest(data: WaabekTestJobData): Promise<WaabekTestOutcome> {
    const events = await this.events();
    const job = await this.otp.add(OTP_JOB_NAMES.waabekTest, data as never, {
      attempts: 1,
      // Kept briefly so the result can be read; the job holds no secret.
      removeOnComplete: { age: 300 },
      removeOnFail: { age: 300 },
    });
    try {
      await job.waitUntilFinished(events, ADMIN_BOOTSTRAP_RULES.testMessageTimeoutSeconds * 1000);
      return { delivered: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const failure = classifyDeliveryFailure(message);
      if (failure.reason === 'no_answer') {
        // Not processed in time (no worker running?): withdraw it so it is not sent later.
        await job.remove().catch(() => undefined);
      }
      return { delivered: false, ...failure };
    }
  }

  async enqueuePush(data: PushJobData): Promise<void> {
    await this.push.add('notify', data);
  }

  async onApplicationShutdown(): Promise<void> {
    const events = await this.otpEvents?.catch(() => undefined);
    await events?.close();
    await (events?.opts.connection as Redis | undefined)?.quit().catch(() => undefined);
    await this.otp.close();
    await this.push.close();
    await this.connection.quit().catch(() => this.connection.disconnect());
  }
}
