import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskPhone, OTP_DELIVERY_ERRORS, type OtpDeliveryFailure, otpMessage, WAABEK_TEST_MESSAGE } from '@bedo/contracts';
import type { OtpPurpose } from '@bedo/db';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { DeferredTasks } from '../runtime/deferred-tasks.service.js';
import { WaabekError, WaabekSender } from './waabek.client.js';
import { OtpConfigurationError, WaabekKeyProvider } from './waabek-key.provider.js';

/**
 * Time allowed for one Waabek request, and for all attempts of one code together. Codes are sent after the
 * response within the same server-function invocation (D-36), so the whole delivery must finish well inside
 * the function's time limit.
 */
const ATTEMPT_TIMEOUT_MS = 6_000;
const CODE_BUDGET_MS = 9_000;
const RETRY_DELAY_MS = 1_000;

export type WaabekTestOutcome = { delivered: true } | { delivered: false; reason: OtpDeliveryFailure; httpStatus: number | null };

/** Maps a delivery error (never secret) to a reason for the Admin Dashboard. */
export function classifyDeliveryFailure(error: unknown): { reason: OtpDeliveryFailure; httpStatus: number | null } {
  if (error instanceof OtpConfigurationError) {
    return { reason: error.message === OTP_DELIVERY_ERRORS.keyUnreadable ? 'key_unreadable' : 'not_configured', httpStatus: null };
  }
  if (error instanceof WaabekError) {
    return error.status === null ? { reason: 'unreachable', httpStatus: null } : { reason: 'rejected', httpStatus: error.status };
  }
  return { reason: 'no_answer', httpStatus: null };
}

/**
 * WhatsApp delivery through Waabek (spec §1, D-05, D-22, D-32), inside the API (D-36: no worker). One-time
 * codes are sent right after the response, so a request for a number that may not sign in (no code sent)
 * takes the same time as one that may. A test message from the Admin Dashboard is sent while the admin waits.
 */
@Injectable()
export class OtpDeliveryService {
  private readonly logger = new Logger(OtpDeliveryService.name);

  constructor(
    @Inject(WaabekSender) private readonly sender: WaabekSender,
    @Inject(WaabekKeyProvider) private readonly keys: WaabekKeyProvider,
    @Inject(DeferredTasks) private readonly deferred: DeferredTasks,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Queues a code for delivery after the response. The code is never stored or logged. */
  sendCode(phone: string, code: string, purpose: OtpPurpose): void {
    this.deferred.defer('otp-delivery', () => this.deliverCode(phone, code, purpose));
  }

  private async deliverCode(phone: string, code: string, purpose: OtpPurpose): Promise<void> {
    const started = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.sender.send(await this.keys.currentKey(), phone, otpMessage(code), ATTEMPT_TIMEOUT_MS);
        this.logger.log(`Verification code delivered to ${maskPhone(phone)} (${purpose})`);
        return;
      } catch (error) {
        const retryable = error instanceof WaabekError && error.retryable;
        const timeLeft = CODE_BUDGET_MS - (Date.now() - started) - RETRY_DELAY_MS;
        if (attempt < 2 && retryable && timeLeft >= 2_000) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          continue;
        }
        await this.recordFailure(phone, purpose, error);
        return;
      }
    }
  }

  /** Recorded in the security history, without the code. */
  private async recordFailure(phone: string, purpose: OtpPurpose, error: unknown): Promise<void> {
    const message = error instanceof WaabekError || error instanceof OtpConfigurationError ? error.message : 'unexpected error';
    this.logger.error(`Verification code delivery failed for ${maskPhone(phone)}: ${message}`);
    await this.audit.security(this.database.db, {
      subjectType: 'phone',
      subjectId: null,
      phone,
      event: 'otp_delivery_failed',
      details: { purpose, error: message },
    });
  }

  /** Admin Dashboard test message (Phase 3.1): the same settings, key and client as one-time codes. */
  async sendTest(phone: string): Promise<WaabekTestOutcome> {
    try {
      await this.sender.send(await this.keys.currentKey(), phone, WAABEK_TEST_MESSAGE, ATTEMPT_TIMEOUT_MS);
      this.logger.log(`Test message delivered to ${maskPhone(phone)}`);
      return { delivered: true };
    } catch (error) {
      return { delivered: false, ...classifyDeliveryFailure(error) };
    }
  }
}
