import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { OTP_RULES, type OtpRequestResponse, TEST_ACCOUNT_RULES } from '@bedo/contracts';
import type { OtpPurpose } from '@bedo/db';
import { sql } from 'kysely';
import { AppError } from '../common/app-error.js';
import { hashOtp, randomOtpCode, safeEqualHex } from '../common/crypto.js';
import type { RequestInfo } from '../common/request-info.js';
import { API_ENV } from '../config/tokens.js';
import { AuditService, type SecurityEventInput } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { OtpDeliveryService } from '../delivery/otp-delivery.service.js';
import { RateLimitService } from '../state/rate-limit.service.js';
import { ReviewAccountService } from './review-account.service.js';
import { TestAccountsService } from './test-accounts.service.js';

export interface OtpIssueInput {
  purpose: OtpPurpose;
  phone: string;
  /** Whether this number may receive a code (academy list, admin list, number free). Never revealed. */
  eligible: boolean;
  /** Who the request concerns, for the audit history. */
  subject: Pick<SecurityEventInput, 'subjectType' | 'subjectId'>;
  /** Phone change: the signed-in account asking; only it can use the code. */
  requestedBy?: string;
  info: RequestInfo;
}

export interface OtpCheckInput {
  purpose: OtpPurpose;
  phone: string;
  code: string;
  subject: Pick<SecurityEventInput, 'subjectType' | 'subjectId'>;
  requestedBy?: string;
  info: RequestInfo;
}

type CheckOutcome = { result: 'ok'; challengeId: string } | { result: 'invalid' } | { result: 'locked' };

/**
 * One-time codes (spec §1, D-05, D-06). Identical behaviour whether or not a number may sign in:
 * every allowed request creates a challenge with the same lifetime and attempt counter; an ineligible
 * number's challenge holds the hash of a random code that is never sent, so it can only fail and lock
 * exactly like a real one. Only eligible numbers are sent a code.
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(OtpDeliveryService) private readonly delivery: OtpDeliveryService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ReviewAccountService) private readonly review: ReviewAccountService,
    @Inject(TestAccountsService) private readonly tests: TestAccountsService,
  ) {}

  private scope(purpose: OtpPurpose): string {
    // Admin sign-in has its own limits so students cannot exhaust an admin's allowance, and vice versa.
    return purpose === 'admin_sign_in' ? 'otp-admin' : 'otp';
  }

  async issue(input: OtpIssueInput): Promise<OtpRequestResponse> {
    const db = this.database.db;
    // D-59: a test account number gets the test accounts' fixed code (never the review number, never a real student).
    const testCode = input.purpose === 'sign_in' ? await this.tests.codeFor(db, input.phone) : null;
    const gate = await this.rateLimit.otpGate(this.scope(input.purpose), input.phone, input.info.ip ?? 'unknown', {
      perPhonePerHour: OTP_RULES.maxCodesPerPhonePerHour,
      perIpPerHour: testCode ? TEST_ACCOUNT_RULES.maxCodesPerIpPerHour : OTP_RULES.maxCodesPerIpPerHour,
      cooldownSeconds: OTP_RULES.resendCooldownSeconds,
      ...(testCode ? { ipScope: 'otp-ip-test' as const } : {}),
    });
    const auditBase = {
      ...input.subject,
      phone: input.phone,
      ip: input.info.ip,
      userAgent: input.info.userAgent,
    };
    if (!gate.allowed) {
      await this.audit.security(db, {
        ...auditBase,
        event: 'otp_rate_limited',
        details: { purpose: input.purpose, reason: gate.reason },
      });
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', gate.retryAfterSeconds);
    }

    const challengeId = randomUUID();
    // D-56: the store review account's number gets its fixed code instead of a WhatsApp message (student sign-in only).
    const reviewCode = input.purpose === 'sign_in' ? await this.review.codeFor(db, input.phone) : null;
    const fixedCode = reviewCode ?? testCode;
    const code = fixedCode ?? randomOtpCode();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('app.otp_challenges')
        .values({
          id: challengeId,
          phone: input.phone,
          purpose: input.purpose,
          code_hash: hashOtp(this.env.OTP_HMAC_SECRET, challengeId, code),
          expires_at: new Date(Date.now() + OTP_RULES.lifetimeSeconds * 1000),
          ip: input.info.ip,
          requested_by: input.requestedBy ?? null,
          delivered: input.eligible,
        })
        .execute();
      await this.audit.security(trx, {
        ...auditBase,
        event: input.eligible ? 'otp_requested' : 'otp_requested_not_eligible',
        details: { purpose: input.purpose, ...(reviewCode ? { reviewAccount: true } : testCode ? { testAccount: true } : {}) },
      });
    });
    if (input.eligible && !fixedCode) {
      this.delivery.sendCode(input.phone, code, input.purpose);
    }

    return {
      status: 'accepted',
      resendAfterSeconds: OTP_RULES.resendCooldownSeconds,
      expiresInSeconds: OTP_RULES.lifetimeSeconds,
    };
  }

  /** Verifies a code; throws OTP_INVALID or OTP_LOCKED. Consumes the challenge on success. */
  async check(input: OtpCheckInput): Promise<{ challengeId: string }> {
    const auditBase = {
      ...input.subject,
      phone: input.phone,
      ip: input.info.ip,
      userAgent: input.info.userAgent,
    };
    const outcome = await this.database.db.transaction().execute(async (trx): Promise<CheckOutcome | null> => {
      const challenge = await trx
        .selectFrom('app.otp_challenges')
        .selectAll()
        .where('phone', '=', input.phone)
        .where('purpose', '=', input.purpose)
        .where('consumed_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .where((eb) => (input.requestedBy ? eb('requested_by', '=', input.requestedBy) : eb('requested_by', 'is', null)))
        .orderBy('created_at', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();

      if (!challenge) {
        return null;
      }
      if (challenge.locked_at) {
        await this.audit.security(trx, { ...auditBase, event: 'otp_locked_attempt', details: { purpose: input.purpose } });
        return { result: 'locked' };
      }
      // A challenge whose code was never sent can only fail, exactly like a wrong code.
      const matches = safeEqualHex(hashOtp(this.env.OTP_HMAC_SECRET, challenge.id, input.code), challenge.code_hash);
      if (challenge.delivered && matches) {
        await trx.updateTable('app.otp_challenges').set({ consumed_at: sql`now()` }).where('id', '=', challenge.id).execute();
        await this.audit.security(trx, { ...auditBase, event: 'otp_verified', details: { purpose: input.purpose } });
        return { result: 'ok', challengeId: challenge.id };
      }
      const attempts = challenge.attempts + 1;
      const locked = attempts >= OTP_RULES.maxWrongAttempts;
      await trx
        .updateTable('app.otp_challenges')
        .set({ attempts, ...(locked ? { locked_at: sql`now()` } : {}) })
        .where('id', '=', challenge.id)
        .execute();
      await this.audit.security(trx, {
        ...auditBase,
        event: locked ? 'otp_locked' : 'otp_failed',
        details: { purpose: input.purpose, attempts },
      });
      return { result: locked ? 'locked' : 'invalid' };
    });

    const result = outcome ?? (await this.failWithoutChallenge(input, auditBase));
    if (result.result === 'ok') {
      return { challengeId: result.challengeId };
    }
    throw new AppError(HttpStatus.BAD_REQUEST, result.result === 'locked' ? 'OTP_LOCKED' : 'OTP_INVALID');
  }

  /** No live challenge (never requested, expired or used): the same answer for every number. */
  private async failWithoutChallenge(input: OtpCheckInput, auditBase: Omit<SecurityEventInput, 'event'>): Promise<CheckOutcome> {
    await this.audit.security(this.database.db, {
      ...auditBase,
      event: 'otp_failed',
      details: { purpose: input.purpose, challenge: false },
    });
    return { result: 'invalid' };
  }
}
