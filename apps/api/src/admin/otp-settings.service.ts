import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { ADMIN_BOOTSTRAP_RULES, maskPhone, TOKEN_RULES, type WaabekTestResponse } from '@bedo/contracts';
import { encryptWaabekApiKey, parseAes256Key } from '@bedo/server-crypto';
import { AuditService, type Executor } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import type { RequestInfo } from '../common/request-info.js';
import { API_ENV } from '../config/tokens.js';
import { DatabaseService } from '../database/database.service.js';
import { OtpDeliveryService } from '../delivery/otp-delivery.service.js';
import { RateLimitService } from '../state/rate-limit.service.js';
import type { AdminContext } from './admin-auth.service.js';
import { decryptSecret, verifyTotp } from './totp.js';

/**
 * OTP delivery settings managed from the Admin Dashboard (D-32). The Waabek API key is encrypted here with
 * SETTINGS_ENCRYPTION_KEY (AES-256-GCM) before it reaches the database, and is never decrypted, returned,
 * logged or written to the audit history by the API: it is decrypted only to send a message (D-36: in the API, right before sending).
 */
@Injectable()
export class OtpSettingsService {
  private readonly settingsKey: Buffer;
  private readonly totpKey: Buffer;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OtpDeliveryService) private readonly delivery: OtpDeliveryService,
  ) {
    // Fails closed: configuration validation already refuses a missing or malformed key.
    this.settingsKey = parseAes256Key(env.SETTINGS_ENCRYPTION_KEY);
    this.totpKey = Buffer.from(env.ADMIN_TOTP_KEY, 'base64');
  }

  private get db() {
    return this.database.db;
  }

  /** Encrypts and stores a new key in the caller's transaction; returns the new settings version. */
  async storeKey(
    trx: Executor,
    apiKey: string,
    source: { via: 'initial_setup' | 'owner_recovery'; adminId: null } | { via: 'admin_dashboard'; adminId: string },
  ): Promise<number> {
    const row = await trx
      .updateTable('app.otp_settings')
      .set({ waabek_api_key_enc: encryptWaabekApiKey(this.settingsKey, apiKey), updated_by: source.adminId, updated_via: source.via })
      .returning('version')
      .executeTakeFirstOrThrow();
    return Number(row.version);
  }

  async get() {
    const row = await this.db
      .selectFrom('app.otp_settings')
      .leftJoin('app.admin_accounts', 'app.admin_accounts.id', 'app.otp_settings.updated_by')
      .select([
        'app.otp_settings.provider',
        'app.otp_settings.waabek_api_key_enc',
        'app.otp_settings.version',
        'app.otp_settings.updated_at',
        'app.otp_settings.updated_by',
        'app.otp_settings.updated_via',
        'app.admin_accounts.name as updated_by_name',
      ])
      .executeTakeFirstOrThrow();
    const configured = row.waabek_api_key_enc !== null;
    return {
      provider: row.provider,
      apiKeyConfigured: configured,
      version: Number(row.version),
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row.updated_by && row.updated_by_name ? { id: row.updated_by, name: row.updated_by_name } : null,
      updatedVia: configured ? row.updated_via : null,
    };
  }

  /**
   * Replaces the key. Needs a current authenticator code from the Super Admin (a stolen session alone
   * cannot redirect every sign-in code to another Waabek account); the code is used up like a sign-in code.
   */
  async replaceKey(admin: AdminContext, apiKey: string, totpCode: string, info: RequestInfo): Promise<{ version: number }> {
    const attempt = await this.rateLimit.reserveAttempt(
      `rl:otp-settings-totp:${admin.adminId}`,
      ADMIN_BOOTSTRAP_RULES.testMessageWindowSeconds * 1000,
    );
    if (attempt.count > TOKEN_RULES.maxTwoStepPasswordAttempts) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', attempt.retryAfterSeconds);
    }
    const result = await this.db.transaction().execute(async (trx) => {
      const account = await trx
        .selectFrom('app.admin_accounts')
        .select(['totp_secret_enc', 'totp_last_step'])
        .where('id', '=', admin.adminId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const lastStep = account.totp_last_step === null ? null : Number(account.totp_last_step);
      const step = account.totp_secret_enc ? verifyTotp(decryptSecret(this.totpKey, account.totp_secret_enc), totpCode, Date.now(), lastStep) : null;
      if (step === null) {
        await this.audit.security(trx, {
          subjectType: 'admin',
          subjectId: admin.adminId,
          event: 'admin_totp_failed',
          sessionId: admin.sessionId,
          ip: info.ip,
          userAgent: info.userAgent,
          details: { context: 'otp_settings', attempts: attempt.count },
        });
        return null;
      }
      await trx.updateTable('app.admin_accounts').set({ totp_last_step: step }).where('id', '=', admin.adminId).execute();
      const version = await this.storeKey(trx, apiKey, { via: 'admin_dashboard', adminId: admin.adminId });
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'otp_settings.waabek_key_replaced',
        targetType: 'otp_settings',
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { source: 'admin_dashboard', version },
      });
      await this.audit.security(trx, {
        subjectType: 'admin',
        subjectId: admin.adminId,
        event: 'waabek_key_replaced',
        sessionId: admin.sessionId,
        ip: info.ip,
        userAgent: info.userAgent,
        details: { version },
      });
      return { version };
    });
    if (!result) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'TOTP_INVALID');
    }
    return result;
  }

  /** Sends a WhatsApp test message to the signed-in admin's own number. */
  async sendTest(admin: AdminContext, info: RequestInfo): Promise<WaabekTestResponse> {
    const limit = await this.rateLimit.reserveAttempt(
      `rl:waabek-test:${admin.adminId}`,
      ADMIN_BOOTSTRAP_RULES.testMessageWindowSeconds * 1000,
    );
    if (limit.count > ADMIN_BOOTSTRAP_RULES.maxTestMessages) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', limit.retryAfterSeconds);
    }
    const { phone } = await this.db.selectFrom('app.admin_accounts').select('phone').where('id', '=', admin.adminId).executeTakeFirstOrThrow();
    const outcome = await this.delivery.sendTest(phone);
    const result: WaabekTestResponse = {
      delivered: outcome.delivered,
      sentTo: maskPhone(phone),
      reason: outcome.delivered ? null : outcome.reason,
      httpStatus: outcome.delivered ? null : outcome.httpStatus,
    };
    await this.audit.admin(this.db, {
      adminId: admin.adminId,
      action: 'otp_settings.test_message',
      targetType: 'admin',
      targetId: admin.adminId,
      ip: info.ip,
      userAgent: info.userAgent,
      metadata: { source: 'admin_dashboard', delivered: result.delivered, reason: result.reason, httpStatus: result.httpStatus },
    });
    return result;
  }
}
