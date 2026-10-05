import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ADMIN_BOOTSTRAP_RULES, maskPhone, type WaabekTestResponse } from '@bedo/contracts';
import { sql } from 'kysely';
import { AuditService, type Executor } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { hashToken, safeEqualHex } from '../common/crypto.js';
import type { RequestInfo } from '../common/request-info.js';
import { DatabaseService } from '../database/database.service.js';
import { QueuesService } from '../queues/queues.service.js';
import { ipBucket, RateLimitService } from '../redis/rate-limit.service.js';
import { RedisService } from '../redis/redis.service.js';
import { OtpSettingsService } from './otp-settings.service.js';

type BootstrapRow = {
  token_hash: string | null;
  expires_at: Date | null;
  failed_attempts: number;
  closed_at: Date | null;
};

function isOpen(row: BootstrapRow | undefined, now = Date.now()): row is BootstrapRow & { token_hash: string; expires_at: Date } {
  return Boolean(
    row &&
      row.closed_at === null &&
      row.token_hash !== null &&
      row.expires_at !== null &&
      new Date(row.expires_at).getTime() > now &&
      row.failed_attempts < ADMIN_BOOTSTRAP_RULES.maxFailedTokenAttempts,
  );
}

/**
 * The one-time initial setup of the first Super Admin (Phase 3.1). The owner opens it by SQL
 * (app.open_admin_bootstrap(), which returns a setup token); with that token the Admin Dashboard's sign-in
 * page can store the first Waabek API key and send a test message, so the Super Admin can then receive the
 * WhatsApp sign-in code. It closes for good when the first Super Admin confirms their authenticator.
 * The setup token never signs anyone in: the WhatsApp code and the authenticator are still required.
 */
@Injectable()
export class AdminBootstrapService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OtpSettingsService) private readonly settings: OtpSettingsService,
    @Inject(QueuesService) private readonly queues: QueuesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async status(): Promise<{ setupOpen: boolean }> {
    const row = await this.db.selectFrom('app.admin_bootstrap').selectAll().executeTakeFirst();
    return { setupOpen: isOpen(row) };
  }

  /** Stores the first Waabek API key (encrypted, D-32). */
  async saveWaabekKey(setupToken: string, apiKey: string, info: RequestInfo): Promise<void> {
    await this.limitIp(info);
    const check = await this.db.transaction().execute(async (trx) => {
      const result = await this.checkToken(trx, setupToken, info);
      if (result !== 'ok') {
        return result;
      }
      const version = await this.settings.storeKey(trx, apiKey, { via: 'initial_setup', adminId: null });
      await this.audit.system(trx, {
        action: 'otp_settings.waabek_key_replaced',
        targetType: 'otp_settings',
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { source: 'initial_setup', version },
      });
      return result;
    });
    refuseUnless(check);
  }

  /** Sends a WhatsApp test message to the Super Admin waiting for the initial setup. */
  async sendTestMessage(setupToken: string, info: RequestInfo): Promise<WaabekTestResponse> {
    await this.limitIp(info);
    const { check, target } = await this.db.transaction().execute(async (trx) => {
      const result = await this.checkToken(trx, setupToken, info);
      if (result !== 'ok') {
        return { check: result, target: undefined };
      }
      const admin = await trx
        .selectFrom('app.admin_accounts')
        .select(['id', 'phone'])
        .where('role', '=', 'super_admin')
        .where('status', '=', 'active')
        .where('totp_secret_enc', 'is', null)
        .orderBy('created_at')
        .limit(1)
        .executeTakeFirst();
      return { check: result, target: admin };
    });
    refuseUnless(check);
    if (!target) {
      throw new AppError(HttpStatus.FORBIDDEN, 'SETUP_UNAVAILABLE');
    }
    const limit = await this.rateLimit.reserveAttempt(
      `${this.redis.prefix}:rl:waabek-test:bootstrap`,
      ADMIN_BOOTSTRAP_RULES.testMessageWindowSeconds * 1000,
    );
    if (limit.count > ADMIN_BOOTSTRAP_RULES.maxTestMessages) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', limit.retryAfterSeconds);
    }
    const outcome = await this.queues.sendWaabekTest({ phone: target.phone });
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
      metadata: { source: 'initial_setup', delivered: result.delivered, reason: result.reason, httpStatus: result.httpStatus },
    });
    return result;
  }

  /**
   * Closes the setup for good, in the transaction that confirms a Super Admin's authenticator. Does nothing
   * if it is already closed. Returns whether this call closed it.
   */
  async closeIfOpen(trx: Executor, adminId: string): Promise<boolean> {
    const closed = await trx
      .updateTable('app.admin_bootstrap')
      .set({ closed_at: sql<Date>`now()`, closed_by: adminId })
      .where('closed_at', 'is', null)
      .executeTakeFirst();
    return Number(closed.numUpdatedRows) === 1;
  }

  private async limitIp(info: RequestInfo): Promise<void> {
    const attempt = await this.rateLimit.reserveAttempt(
      `${this.redis.prefix}:rl:admin-bootstrap:ip:${ipBucket(info.ip ?? 'unknown')}`,
      ADMIN_BOOTSTRAP_RULES.ipWindowSeconds * 1000,
    );
    if (attempt.count > ADMIN_BOOTSTRAP_RULES.maxRequestsPerIp) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', attempt.retryAfterSeconds);
    }
  }

  /**
   * Checks the setup token inside the caller's transaction, with the bootstrap row locked so parallel
   * guesses are counted one by one. A wrong token is counted and recorded (the caller commits, then
   * refuses); after ADMIN_BOOTSTRAP_RULES.maxFailedTokenAttempts wrong tokens the token stops working.
   */
  private async checkToken(trx: Executor, setupToken: string, info: RequestInfo): Promise<TokenCheck> {
    const row = await trx.selectFrom('app.admin_bootstrap').selectAll().forUpdate().executeTakeFirst();
    if (!isOpen(row)) {
      await this.audit.security(trx, {
        subjectType: 'admin',
        subjectId: null,
        event: 'admin_bootstrap_refused',
        ip: info.ip,
        userAgent: info.userAgent,
        details: { reason: row?.closed_at ? 'closed' : 'not_open' },
      });
      return 'unavailable';
    }
    if (!safeEqualHex(hashToken(setupToken), row.token_hash)) {
      const attempts = row.failed_attempts + 1;
      await trx.updateTable('app.admin_bootstrap').set({ failed_attempts: attempts }).execute();
      await this.audit.security(trx, {
        subjectType: 'admin',
        subjectId: null,
        event: 'admin_bootstrap_token_failed',
        ip: info.ip,
        userAgent: info.userAgent,
        details: { attempts, locked: attempts >= ADMIN_BOOTSTRAP_RULES.maxFailedTokenAttempts },
      });
      return 'wrong';
    }
    await this.audit.security(trx, {
      subjectType: 'admin',
      subjectId: null,
      event: 'admin_bootstrap_token_used',
      ip: info.ip,
      userAgent: info.userAgent,
    });
    return 'ok';
  }
}

type TokenCheck = 'ok' | 'unavailable' | 'wrong';

function refuseUnless(check: TokenCheck): void {
  if (check === 'unavailable') {
    throw new AppError(HttpStatus.FORBIDDEN, 'SETUP_UNAVAILABLE');
  }
  if (check === 'wrong') {
    throw new AppError(HttpStatus.BAD_REQUEST, 'SETUP_TOKEN_INVALID');
  }
}
