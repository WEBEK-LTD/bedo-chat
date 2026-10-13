import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ADMIN_BOOTSTRAP_RULES, maskPhone, OTP_RECOVERY_RULES, type WaabekTestResponse } from '@bedo/contracts';
import { sql } from 'kysely';
import { AuditService, type Executor } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { hashToken, safeEqualHex } from '../common/crypto.js';
import type { RequestInfo } from '../common/request-info.js';
import { DatabaseService } from '../database/database.service.js';
import { OtpDeliveryService } from '../delivery/otp-delivery.service.js';
import { ipBucket, RateLimitService } from '../state/rate-limit.service.js';
import { OtpSettingsService } from './otp-settings.service.js';

type RecoveryRow = { token_hash: string | null; expires_at: Date | null; failed_attempts: number; key_saved_at: Date | null };
type TokenCheck = 'ok' | 'unavailable' | 'wrong' | 'used';

function isOpen(row: RecoveryRow | undefined, now = Date.now()): row is RecoveryRow & { token_hash: string; expires_at: Date } {
  return Boolean(
    row &&
      row.token_hash !== null &&
      row.expires_at !== null &&
      new Date(row.expires_at).getTime() > now &&
      row.failed_attempts < OTP_RECOVERY_RULES.maxFailedTokenAttempts,
  );
}

function refuseUnless(check: TokenCheck): void {
  if (check === 'unavailable') {
    throw new AppError(HttpStatus.FORBIDDEN, 'RECOVERY_UNAVAILABLE');
  }
  if (check === 'used') {
    throw new AppError(HttpStatus.CONFLICT, 'RECOVERY_TOKEN_USED');
  }
  if (check === 'wrong') {
    throw new AppError(HttpStatus.BAD_REQUEST, 'RECOVERY_TOKEN_INVALID');
  }
}

/**
 * Owner-only Waabek key recovery (D-33). When the stored Waabek key no longer works (D-33 predates D-34,
 * when admin sign-in still needed a WhatsApp code; it is kept unchanged), the database owner runs
 * app.open_otp_settings_recovery() by SQL and gets a one-time recovery token. With it, the sign-in page can do
 * exactly two things: save ONE new Waabek key (the token is then used up for saving) (encrypted here with SETTINGS_ENCRYPTION_KEY, raising the settings
 * version checked before every message) and send a test message. It never signs anyone in, never creates a session and
 * never reads or changes admin accounts' credentials, roles, sessions or the initial-setup bootstrap.
 */
@Injectable()
export class OtpRecoveryService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OtpSettingsService) private readonly settings: OtpSettingsService,
    @Inject(OtpDeliveryService) private readonly delivery: OtpDeliveryService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async status(): Promise<{ recoveryOpen: boolean }> {
    const row = await this.db.selectFrom('app.otp_settings_recovery').selectAll().executeTakeFirst();
    return { recoveryOpen: isOpen(row) };
  }

  /** Stores a new Waabek API key (encrypted, D-32), recorded as an owner recovery without the key. */
  async saveWaabekKey(recoveryToken: string, apiKey: string, info: RequestInfo): Promise<void> {
    await this.limitIp(info);
    const check = await this.db.transaction().execute(async (trx): Promise<TokenCheck> => {
      const result = await this.checkToken(trx, recoveryToken, info, { forSaving: true });
      if (result !== 'ok') {
        return result;
      }
      // One key per token: marked used in the same transaction, with the recovery row locked.
      await trx.updateTable('app.otp_settings_recovery').set({ key_saved_at: sql<Date>`now()` }).where('key_saved_at', 'is', null).execute();
      const version = await this.settings.storeKey(trx, apiKey, { via: 'owner_recovery', adminId: null });
      await this.audit.system(trx, {
        action: 'otp_settings.waabek_key_replaced',
        targetType: 'otp_settings',
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { source: 'owner_recovery', version },
      });
      await this.audit.security(trx, {
        subjectType: 'admin',
        subjectId: null,
        event: 'waabek_key_recovered',
        ip: info.ip,
        userAgent: info.userAgent,
        details: { version },
      });
      return result;
    });
    refuseUnless(check);
  }

  /** Sends a WhatsApp test message to the longest-standing active Super Admin. */
  async sendTestMessage(recoveryToken: string, info: RequestInfo): Promise<WaabekTestResponse> {
    await this.limitIp(info);
    const { check, target } = await this.db.transaction().execute(async (trx) => {
      const result = await this.checkToken(trx, recoveryToken, info);
      if (result !== 'ok') {
        return { check: result, target: undefined };
      }
      const admin = await trx
        .selectFrom('app.admin_accounts')
        .select(['id', 'phone'])
        .where('role', '=', 'super_admin')
        .where('status', '=', 'active')
        .where('totp_confirmed_at', 'is not', null)
        .orderBy('created_at')
        .limit(1)
        .executeTakeFirst();
      return { check: result, target: admin };
    });
    refuseUnless(check);
    if (!target) {
      throw new AppError(HttpStatus.FORBIDDEN, 'RECOVERY_UNAVAILABLE');
    }
    const limit = await this.rateLimit.reserveAttempt(
      `rl:waabek-test:recovery`,
      ADMIN_BOOTSTRAP_RULES.testMessageWindowSeconds * 1000,
    );
    if (limit.count > ADMIN_BOOTSTRAP_RULES.maxTestMessages) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', limit.retryAfterSeconds);
    }
    const outcome = await this.delivery.sendTest(target.phone);
    const result: WaabekTestResponse = {
      delivered: outcome.delivered,
      sentTo: maskPhone(target.phone),
      reason: outcome.delivered ? null : outcome.reason,
      httpStatus: outcome.delivered ? null : outcome.httpStatus,
    };
    await this.audit.system(this.db, {
      action: 'otp_settings.test_message',
      targetType: 'admin',
      targetId: target.id,
      ip: info.ip,
      userAgent: info.userAgent,
      metadata: { source: 'owner_recovery', delivered: result.delivered, reason: result.reason, httpStatus: result.httpStatus },
    });
    return result;
  }

  private async limitIp(info: RequestInfo): Promise<void> {
    const attempt = await this.rateLimit.reserveAttempt(
      `rl:otp-recovery:ip:${ipBucket(info.ip ?? 'unknown')}`,
      OTP_RECOVERY_RULES.ipWindowSeconds * 1000,
    );
    if (attempt.count > OTP_RECOVERY_RULES.maxRequestsPerIp) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', attempt.retryAfterSeconds);
    }
  }

  /**
   * Checks the recovery token with the recovery row locked, so parallel guesses are counted one by one. A
   * wrong token is counted and recorded (the caller commits, then refuses); after
   * OTP_RECOVERY_RULES.maxFailedTokenAttempts wrong tokens the token stops working.
   */
  private async checkToken(trx: Executor, recoveryToken: string, info: RequestInfo, options: { forSaving?: boolean } = {}): Promise<TokenCheck> {
    const row = await trx.selectFrom('app.otp_settings_recovery').selectAll().forUpdate().executeTakeFirst();
    if (!isOpen(row)) {
      await this.audit.security(trx, {
        subjectType: 'admin',
        subjectId: null,
        event: 'otp_recovery_refused',
        ip: info.ip,
        userAgent: info.userAgent,
      });
      return 'unavailable';
    }
    if (!safeEqualHex(hashToken(recoveryToken), row.token_hash)) {
      const attempts = row.failed_attempts + 1;
      await trx.updateTable('app.otp_settings_recovery').set({ failed_attempts: attempts }).execute();
      await this.audit.security(trx, {
        subjectType: 'admin',
        subjectId: null,
        event: 'otp_recovery_token_failed',
        ip: info.ip,
        userAgent: info.userAgent,
        details: { attempts, locked: attempts >= OTP_RECOVERY_RULES.maxFailedTokenAttempts },
      });
      return 'wrong';
    }
    if (options.forSaving && row.key_saved_at !== null) {
      await this.audit.security(trx, {
        subjectType: 'admin',
        subjectId: null,
        event: 'otp_recovery_token_reused',
        ip: info.ip,
        userAgent: info.userAgent,
      });
      return 'used';
    }
    await this.audit.security(trx, {
      subjectType: 'admin',
      subjectId: null,
      event: 'otp_recovery_token_used',
      ip: info.ip,
      userAgent: info.userAgent,
    });
    return 'ok';
  }
}
