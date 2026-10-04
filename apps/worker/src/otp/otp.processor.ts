import { Inject, Injectable, Logger } from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';
import { type OtpJobData, otpJobDataSchema, otpMessage, OTP_RULES, testOtpKey } from '@bedo/contracts';
import type { DbHandle } from '@bedo/db';
import type { Redis } from 'ioredis';
import { WORKER_DB } from '../database.js';
import { WORKER_REDIS } from '../system/heartbeat.processor.js';
import { WORKER_ENV } from '../tokens.js';
import { WaabekClient } from './waabek.client.js';

function maskPhone(phone: string): string {
  return phone.length <= 6 ? '***' : `${phone.slice(0, 3)}${'*'.repeat(phone.length - 6)}${phone.slice(-3)}`;
}

/**
 * Delivers one-time codes. Production and real testing use Waabek (D-22). The test code sender
 * ("test-capture") only exists for automated tests: configuration refuses it unless NODE_ENV=test,
 * and it never replaces Waabek outside tests.
 */
@Injectable()
export class OtpProcessor {
  private readonly logger = new Logger(OtpProcessor.name);

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(WaabekClient) private readonly waabek: WaabekClient,
    @Inject(WORKER_REDIS) private readonly redis: Redis,
    @Inject(WORKER_DB) private readonly database: DbHandle,
  ) {}

  async process(raw: unknown): Promise<void> {
    const job: OtpJobData = otpJobDataSchema.parse(raw);
    if (this.env.OTP_DELIVERY === 'test-capture' && this.env.NODE_ENV === 'test') {
      await this.redis.set(testOtpKey(this.env.QUEUE_PREFIX, job.phone), job.code, 'EX', OTP_RULES.lifetimeSeconds);
      return;
    }
    await this.waabek.send(job.phone, otpMessage(job.code));
    this.logger.log(`Verification code delivered to ${maskPhone(job.phone)} (${job.purpose})`);
  }

  /** Called once all retries are used up: recorded in the audit history, without the code. */
  async onFinalFailure(raw: unknown, error: Error): Promise<void> {
    const parsed = otpJobDataSchema.safeParse(raw);
    const phone = parsed.success ? parsed.data.phone : null;
    this.logger.error(`Verification code delivery failed for ${phone ? maskPhone(phone) : 'unknown'}: ${error.message}`);
    await this.database.db
      .insertInto('audit.security_events')
      .values({
        subject_type: 'phone',
        subject_id: null,
        phone,
        event: 'otp_delivery_failed',
        details: { purpose: parsed.success ? parsed.data.purpose : null, error: error.message },
      })
      .execute();
  }
}
