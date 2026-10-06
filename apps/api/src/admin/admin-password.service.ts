import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { ADMIN_PASSWORD_RULES } from '@bedo/contracts';
import { sql } from 'kysely';
import { AuditService, type Executor } from '../audit/audit.service.js';
import { TwoStepService } from '../auth/two-step.service.js';
import { AppError } from '../common/app-error.js';
import { hashToken, safeEqualHex } from '../common/crypto.js';
import type { RequestInfo } from '../common/request-info.js';
import { API_ENV } from '../config/tokens.js';
import { DatabaseService } from '../database/database.service.js';
import { ipBucket, RateLimitService } from '../redis/rate-limit.service.js';
import { RedisService } from '../redis/redis.service.js';
import { type AdminContext, AdminAuthService, type AdminPendingSignIn } from './admin-auth.service.js';
import { isCommonPassword, isPhoneNumberPassword, loadCommonPasswords } from './password-policy.js';
import { decryptSecret, verifyTotp } from './totp.js';

type SetupCheck = 'ok' | 'invalid';

/**
 * Admin passwords (D-34). Sign-in is phone + password, then the mandatory authenticator code (AdminAuthService);
 * no admin session exists without the authenticator. Passwords are hashed with the existing Argon2id parameters
 * (TwoStepService) and never stored, logged, audited or returned. Unknown numbers, accounts without a password,
 * disabled accounts and wrong passwords get the same answer after the same hashing work. The initial password and
 * every reset use an owner-issued one-time setup token (app.issue_admin_password_setup, SQL only), which never
 * signs anyone in.
 */
@Injectable()
export class AdminPasswordService {
  private readonly totpKey: Buffer;
  /** Hash of a random password, verified when there is no real hash, so every answer costs the same. */
  private dummyHash: Promise<string> | undefined;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TwoStepService) private readonly hasher: TwoStepService,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
  ) {
    this.totpKey = Buffer.from(env.ADMIN_TOTP_KEY, 'base64');
    // Fails closed at start-up if the common-password list cannot be read.
    loadCommonPasswords();
    // Prepared at start-up so that even the first failed sign-in costs exactly one Argon2id verification.
    void this.dummy();
  }

  private get db() {
    return this.database.db;
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= this.hasher.hashPassword(randomBytes(32).toString('base64'));
    return this.dummyHash;
  }

  /** Step 1 of admin sign-in. Answers the authenticator step, or CREDENTIALS_INVALID, or RATE_LIMITED. */
  async login(phone: string, password: string, info: RequestInfo): Promise<AdminPendingSignIn> {
    await this.limitIp('admin-password', info);
    const lockKey = this.lockKey(phone);
    const lockedFor = await this.redis.client.pttl(lockKey);
    if (lockedFor > 0) {
      await this.audit.security(this.db, {
        subjectType: 'phone',
        phone,
        event: 'admin_password_locked_attempt',
        ip: info.ip,
        userAgent: info.userAgent,
      });
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', Math.ceil(lockedFor / 1000));
    }
    // Counted before the password is checked, per phone number (also unknown ones), so parallel guesses cannot
    // share one count and the answers do not reveal whether the number belongs to an admin.
    const attempt = await this.rateLimit.reserveAttempt(this.failKey(phone), ADMIN_PASSWORD_RULES.failureWindowMinutes * 60_000);
    if (attempt.count > ADMIN_PASSWORD_RULES.maxFailedPerAccount) {
      await this.lock(phone, info);
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', ADMIN_PASSWORD_RULES.lockMinutes * 60);
    }

    const admin = await this.db.selectFrom('app.admin_accounts').selectAll().where('phone', '=', phone).executeTakeFirst();
    const usable = admin && admin.status === 'active' && admin.password_hash !== null;
    // Exactly one Argon2id verification on every path.
    const matches = await this.hasher.verifyPassword(usable ? admin.password_hash! : await this.dummy(), password);
    if (!usable || !matches) {
      await this.audit.security(this.db, {
        subjectType: admin ? 'admin' : 'phone',
        subjectId: admin?.id ?? null,
        phone,
        event: 'admin_password_failed',
        ip: info.ip,
        userAgent: info.userAgent,
        details: {
          attempts: attempt.count,
          reason: !admin ? 'unknown_number' : admin.status !== 'active' ? 'disabled' : admin.password_hash === null ? 'no_password' : 'wrong_password',
        },
      });
      if (attempt.count >= ADMIN_PASSWORD_RULES.maxFailedPerAccount) {
        await this.lock(phone, info);
      }
      throw new AppError(HttpStatus.UNAUTHORIZED, 'CREDENTIALS_INVALID');
    }

    await this.redis.client.del(this.failKey(phone));
    await this.audit.security(this.db, {
      subjectType: 'admin',
      subjectId: admin.id,
      phone,
      event: 'admin_password_verified',
      ip: info.ip,
      userAgent: info.userAgent,
    });
    return this.auth.startPendingSignIn(admin);
  }

  /**
   * Sets a password with an owner-issued one-time setup token. Never signs anyone in. Every problem with the
   * number or the token gets the same answer (PASSWORD_SETUP_INVALID); the password rules are checked only once
   * the token is right, and a refused password does not use the token up.
   */
  async setWithToken(phone: string, setupToken: string, password: string, info: RequestInfo): Promise<void> {
    await this.limitIp('admin-password-setup', info);
    const result = await this.db.transaction().execute(async (trx): Promise<SetupCheck | 'is_phone' | 'too_common' | 'ok'> => {
      const admin = await trx.selectFrom('app.admin_accounts').select(['id', 'status']).where('phone', '=', phone).forUpdate().executeTakeFirst();
      const row = admin
        ? await trx.selectFrom('app.admin_password_setup').selectAll().where('admin_id', '=', admin.id).forUpdate().executeTakeFirst()
        : undefined;
      const open =
        admin &&
        admin.status === 'active' &&
        row &&
        row.used_at === null &&
        new Date(row.expires_at).getTime() > Date.now() &&
        row.failed_attempts < ADMIN_PASSWORD_RULES.maxFailedSetupTokenAttempts;
      if (!open) {
        await this.audit.security(trx, {
          subjectType: admin ? 'admin' : 'phone',
          subjectId: admin?.id ?? null,
          phone,
          event: 'admin_password_setup_refused',
          ip: info.ip,
          userAgent: info.userAgent,
        });
        return 'invalid';
      }
      if (!safeEqualHex(hashToken(setupToken), row.token_hash)) {
        const attempts = row.failed_attempts + 1;
        await trx.updateTable('app.admin_password_setup').set({ failed_attempts: attempts }).where('admin_id', '=', admin.id).execute();
        await this.audit.security(trx, {
          subjectType: 'admin',
          subjectId: admin.id,
          phone,
          event: 'admin_password_setup_token_failed',
          ip: info.ip,
          userAgent: info.userAgent,
          details: { attempts, locked: attempts >= ADMIN_PASSWORD_RULES.maxFailedSetupTokenAttempts },
        });
        return 'invalid';
      }
      const rule = this.ruleViolation(password, phone);
      if (rule) {
        return rule;
      }
      const passwordHash = await this.hasher.hashPassword(password);
      await trx.updateTable('app.admin_accounts').set({ password_hash: passwordHash }).where('id', '=', admin.id).execute();
      await trx.updateTable('app.admin_password_setup').set({ used_at: sql<Date>`now()` }).where('admin_id', '=', admin.id).execute();
      // A setup token ends every session of the account (an owner reset; the first password has none).
      const ended = await this.endSessions(trx, admin.id, null);
      await this.audit.security(trx, {
        subjectType: 'admin',
        subjectId: admin.id,
        phone,
        event: 'admin_password_set',
        ip: info.ip,
        userAgent: info.userAgent,
        details: { reset: row.is_reset, sessionsEnded: ended },
      });
      await this.audit.system(trx, {
        action: 'admin.password_set',
        targetType: 'admin',
        targetId: admin.id,
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { source: 'owner_setup_token', reset: row.is_reset, sessionsEnded: ended },
      });
      return 'ok';
    });
    if (result === 'invalid') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'PASSWORD_SETUP_INVALID');
    }
    this.refuseRule(result);
    // The owner's reset also lifts a password-login lock on that number.
    await this.redis.client.del(this.lockKey(phone), this.failKey(phone));
  }

  /**
   * A signed-in admin changes their own password: the current password and a current authenticator code (used
   * up like a sign-in code). Ends every other session of the account; the current one stays.
   */
  async change(admin: AdminContext, currentPassword: string, newPassword: string, totpCode: string, info: RequestInfo): Promise<{ otherSessionsEnded: number }> {
    const attempt = await this.rateLimit.reserveAttempt(
      `${this.redis.prefix}:rl:admin-password-change:${admin.adminId}`,
      ADMIN_PASSWORD_RULES.failureWindowMinutes * 60_000,
    );
    if (attempt.count > ADMIN_PASSWORD_RULES.maxChangeAttempts) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', attempt.retryAfterSeconds);
    }
    const account = await this.db.selectFrom('app.admin_accounts').select(['phone']).where('id', '=', admin.adminId).executeTakeFirstOrThrow();
    // The rules first, so a refused new password does not use up the authenticator code.
    this.refuseRule(this.ruleViolation(newPassword, account.phone));
    const newHash = await this.hasher.hashPassword(newPassword);

    const result = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('app.admin_accounts')
        .select(['password_hash', 'totp_secret_enc', 'totp_last_step'])
        .where('id', '=', admin.adminId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const passwordOk = await this.hasher.verifyPassword(row.password_hash ?? (await this.dummy()), currentPassword);
      const lastStep = row.totp_last_step === null ? null : Number(row.totp_last_step);
      const step = row.totp_secret_enc ? verifyTotp(decryptSecret(this.totpKey, row.totp_secret_enc), totpCode, Date.now(), lastStep) : null;
      if (!passwordOk || row.password_hash === null || step === null) {
        await this.audit.security(trx, {
          subjectType: 'admin',
          subjectId: admin.adminId,
          event: 'admin_password_failed',
          sessionId: admin.sessionId,
          ip: info.ip,
          userAgent: info.userAgent,
          details: { context: 'change', attempts: attempt.count, passwordOk, totpOk: step !== null },
        });
        return null;
      }
      await trx.updateTable('app.admin_accounts').set({ password_hash: newHash, totp_last_step: step }).where('id', '=', admin.adminId).execute();
      const ended = await this.endSessions(trx, admin.adminId, admin.sessionId);
      await this.audit.security(trx, {
        subjectType: 'admin',
        subjectId: admin.adminId,
        event: 'admin_password_changed',
        sessionId: admin.sessionId,
        ip: info.ip,
        userAgent: info.userAgent,
        details: { otherSessionsEnded: ended },
      });
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'admin.password_changed',
        targetType: 'admin',
        targetId: admin.adminId,
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { otherSessionsEnded: ended },
      });
      return { otherSessionsEnded: ended };
    });
    if (!result) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'CREDENTIALS_INVALID');
    }
    await this.redis.client.del(`${this.redis.prefix}:rl:admin-password-change:${admin.adminId}`);
    return result;
  }

  private ruleViolation(password: string, phone: string): 'is_phone' | 'too_common' | null {
    if (isPhoneNumberPassword(password, phone)) {
      return 'is_phone';
    }
    if (isCommonPassword(password)) {
      return 'too_common';
    }
    return null;
  }

  private refuseRule(rule: 'is_phone' | 'too_common' | 'ok' | null): void {
    if (rule === 'is_phone') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'PASSWORD_IS_PHONE');
    }
    if (rule === 'too_common') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'PASSWORD_TOO_COMMON');
    }
  }

  /** Ends the account's sessions, except `keep` (the current session after a self-service change). */
  private async endSessions(trx: Executor, adminId: string, keep: string | null): Promise<number> {
    let query = trx.updateTable('app.admin_sessions').set({ revoked_at: sql<Date>`now()` }).where('admin_id', '=', adminId).where('revoked_at', 'is', null);
    if (keep) {
      query = query.where('id', '!=', keep);
    }
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  private async lock(phone: string, info: RequestInfo): Promise<void> {
    const created = await this.redis.client.set(this.lockKey(phone), '1', 'EX', ADMIN_PASSWORD_RULES.lockMinutes * 60, 'NX');
    if (created === 'OK') {
      await this.audit.security(this.db, {
        subjectType: 'phone',
        phone,
        event: 'admin_password_locked',
        ip: info.ip,
        userAgent: info.userAgent,
        details: { minutes: ADMIN_PASSWORD_RULES.lockMinutes },
      });
    }
  }

  private async limitIp(scope: string, info: RequestInfo): Promise<void> {
    const attempt = await this.rateLimit.reserveAttempt(
      `${this.redis.prefix}:rl:${scope}:ip:${ipBucket(info.ip ?? 'unknown')}`,
      ADMIN_PASSWORD_RULES.ipWindowMinutes * 60_000,
    );
    if (attempt.count > ADMIN_PASSWORD_RULES.maxAttemptsPerIp) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', attempt.retryAfterSeconds);
    }
  }

  private failKey(phone: string): string {
    return `${this.redis.prefix}:rl:admin-password-fail:${phone}`;
  }

  private lockKey(phone: string): string {
    return `${this.redis.prefix}:rl:admin-password-lock:${phone}`;
  }
}
