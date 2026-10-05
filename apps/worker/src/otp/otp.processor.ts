import { Inject, Injectable, Logger } from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';
import {
  type OtpJobData,
  otpJobDataSchema,
  otpMessage,
  OTP_RULES,
  testOtpKey,
  testWaabekMessageKey,
  WAABEK_TEST_MESSAGE,
  waabekTestJobDataSchema,
} from '@bedo/contracts';
import type { DbHandle } from '@bedo/db';
import type { Redis } from 'ioredis';
import { WORKER_DB } from '../database.js';
import { WORKER_REDIS } from '../system/heartbeat.processor.js';
import { WORKER_ENV } from '../tokens.js';
import { WaabekClient } from './waabek.client.js';
import { WaabekKeyProvider } from './waabek-key.provider.js';

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
    @Inject(WaabekKeyProvider) private readonly keys: WaabekKeyProvider,
  ) {}

  private get testCapture(): boolean {
    return this.env.OTP_DELIVERY === 'test-capture' && this.env.NODE_ENV === 'test';
  }

  async process(raw: unknown): Promise<void> {
    const job: OtpJobData = otpJobDataSchema.parse(raw);
    if (this.testCapture) {
      await this.redis.set(testOtpKey(this.env.QUEUE_PREFIX, job.phone), job.code, 'EX', OTP_RULES.lifetimeSeconds);
      return;
    }
    await this.waabek.send(await this.keys.currentKey(), job.phone, otpMessage(job.code));
    this.logger.log(`Verification code delivered to ${maskPhone(job.phone)} (${job.purpose})`);
  }

  /** Admin Dashboard test message (Phase 3.1): the same settings, key and client as one-time codes. */
  async processTest(raw: unknown): Promise<{ delivered: true }> {
    const job = waabekTestJobDataSchema.parse(raw);
    if (this.testCapture) {
      await this.redis.set(testWaabekMessageKey(this.env.QUEUE_PREFIX, job.phone), WAABEK_TEST_MESSAGE, 'EX', OTP_RULES.lifetimeSeconds);
      return { delivered: true };
    }
    await this.waabek.send(await this.keys.currentKey(), job.phone, WAABEK_TEST_MESSAGE);
    this.logger.log(`Test message delivered to ${maskPhone(job.phone)}`);
    return { delivered: true };
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
