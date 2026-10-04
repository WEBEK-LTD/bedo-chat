import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { ADMIN_SESSION_RULES, type AdminInfo, TOKEN_RULES } from '@bedo/contracts';
import type { AdminRole } from '@bedo/db';
import { sql } from 'kysely';
import { AppError } from '../common/app-error.js';
import { hashToken, randomToken } from '../common/crypto.js';
import type { RequestInfo } from '../common/request-info.js';
import { API_ENV } from '../config/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { OtpService } from '../auth/otp.service.js';
import { DatabaseService } from '../database/database.service.js';
import { RateLimitService } from '../redis/rate-limit.service.js';
import { RedisService } from '../redis/redis.service.js';
import { decryptSecret, verifyTotp } from './totp.js';

export interface AdminContext {
  adminId: string;
  sessionId: string;
  role: AdminRole;
  name: string;
}

interface PendingAdmin {
  adminId: string;
}

/**
 * Admin sign-in (D-19, P-13): phone code through Waabek, then a mandatory authenticator-app code.
 * Admin accounts and sessions are separate from student accounts and sessions.
 */
@Injectable()
export class AdminAuthService {
  private readonly totpKey: Buffer;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.totpKey = Buffer.from(env.ADMIN_TOTP_KEY, 'base64');
  }

  private get db() {
    return this.database.db;
  }

  private findActiveAdminByPhone(phone: string) {
    return this.db.selectFrom('app.admin_accounts').selectAll().where('phone', '=', phone).where('status', '=', 'active').executeTakeFirst();
  }

  async requestCode(phone: string, info: RequestInfo) {
    const admin = await this.findActiveAdminByPhone(phone);
    return this.otp.issue({
      purpose: 'admin_sign_in',
      phone,
      eligible: Boolean(admin),
      subject: admin ? { subjectType: 'admin', subjectId: admin.id } : { subjectType: 'phone', subjectId: null },
      info,
    });
  }

  async verifyCode(phone: string, code: string, info: RequestInfo): Promise<string> {
    const admin = await this.findActiveAdminByPhone(phone);
    await this.otp.check({
      purpose: 'admin_sign_in',
      phone,
      code,
      subject: admin ? { subjectType: 'admin', subjectId: admin.id } : { subjectType: 'phone', subjectId: null },
      info,
    });
    if (!admin) {
      // Unreachable in practice: codes are only issued to admin numbers.
      throw new AppError(HttpStatus.BAD_REQUEST, 'OTP_INVALID');
    }
    const pendingToken = randomToken();
    const pending: PendingAdmin = { adminId: admin.id };
    await this.redis.client.set(this.pendingKey(pendingToken), JSON.stringify(pending), 'EX', ADMIN_SESSION_RULES.pendingTokenSeconds);
    return pendingToken;
  }

  async verifyTotp(pendingToken: string, code: string, info: RequestInfo): Promise<{ admin: AdminInfo; sessionToken: string }> {
    const raw = await this.redis.client.get(this.pendingKey(pendingToken));
    if (!raw) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
    }
    const pending = JSON.parse(raw) as PendingAdmin;
    // Counted before the code is checked, so parallel guesses cannot share one count (P-13).
    const attempt = await this.rateLimit.reserveAttempt(this.attemptsKey(pendingToken), ADMIN_SESSION_RULES.pendingTokenSeconds * 1000);
    if (attempt.count > TOKEN_RULES.maxTwoStepPasswordAttempts) {
      await this.redis.client.del(this.pendingKey(pendingToken));
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
    }
    const admin = await this.db.selectFrom('app.admin_accounts').selectAll().where('id', '=', pending.adminId).executeTakeFirst();
    if (!admin || admin.status !== 'active') {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
    }
    const lastStep = admin.totp_last_step === null ? null : Number(admin.totp_last_step);
    const step = verifyTotp(decryptSecret(this.totpKey, admin.totp_secret_enc), code, Date.now(), lastStep);
    if (step === null) {
      if (attempt.count >= TOKEN_RULES.maxTwoStepPasswordAttempts) {
        await this.redis.client.del(this.pendingKey(pendingToken));
      }
      await this.audit.security(this.db, {
        subjectType: 'admin',
        subjectId: admin.id,
        event: 'admin_totp_failed',
        ip: info.ip,
        userAgent: info.userAgent,
        details: { attempts: attempt.count },
      });
      throw new AppError(HttpStatus.BAD_REQUEST, 'TOTP_INVALID');
    }
    // Only one request can consume the pending sign-in.
    if ((await this.redis.client.del(this.pendingKey(pendingToken))) !== 1) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
    }

    const sessionToken = randomToken();
    await this.db.transaction().execute(async (trx) => {
      // The step update only succeeds if no other sign-in used this or a later step meanwhile (no replay).
      const updated = await trx
        .updateTable('app.admin_accounts')
        .set({ totp_last_step: step, ...(admin.totp_confirmed_at ? {} : { totp_confirmed_at: sql`now()` }) })
        .where('id', '=', admin.id)
        .where((eb) => eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', String(step))]))
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'TOTP_INVALID');
      }
      const session = await trx
        .insertInto('app.admin_sessions')
        .values({
          admin_id: admin.id,
          token_hash: hashToken(sessionToken),
          expires_at: new Date(Date.now() + ADMIN_SESSION_RULES.absoluteHours * 60 * 60 * 1000),
          ip: info.ip,
          user_agent: info.userAgent,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.security(trx, {
        subjectType: 'admin',
        subjectId: admin.id,
        event: 'admin_login_succeeded',
        sessionId: session.id,
        ip: info.ip,
        userAgent: info.userAgent,
      });
      await this.audit.admin(trx, { adminId: admin.id, action: 'admin.signed_in', ip: info.ip, userAgent: info.userAgent });
    });
    return { admin: { id: admin.id, name: admin.name, role: admin.role }, sessionToken };
  }

  /** Session check on every admin request: absolute and idle limits (P-13). */
  async authenticate(sessionToken: string): Promise<AdminContext> {
    const row = await this.db
      .selectFrom('app.admin_sessions')
      .innerJoin('app.admin_accounts', 'app.admin_accounts.id', 'app.admin_sessions.admin_id')
      .select([
        'app.admin_sessions.id as session_id',
        'app.admin_sessions.expires_at',
        'app.admin_sessions.last_active_at',
        'app.admin_sessions.revoked_at',
        'app.admin_accounts.id as admin_id',
        'app.admin_accounts.name',
        'app.admin_accounts.role',
        'app.admin_accounts.status',
      ])
      .where('app.admin_sessions.token_hash', '=', hashToken(sessionToken))
      .executeTakeFirst();
    const now = Date.now();
    if (
      !row ||
      row.revoked_at ||
      row.status !== 'active' ||
      new Date(row.expires_at).getTime() <= now ||
      now - new Date(row.last_active_at).getTime() > ADMIN_SESSION_RULES.idleMinutes * 60 * 1000
    ) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED');
    }
    if (now - new Date(row.last_active_at).getTime() > 60_000) {
      await this.db.updateTable('app.admin_sessions').set({ last_active_at: sql`now()` }).where('id', '=', row.session_id).execute();
    }
    return { adminId: row.admin_id, sessionId: row.session_id, role: row.role, name: row.name };
  }

  async logout(context: AdminContext, info: RequestInfo): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('app.admin_sessions').set({ revoked_at: sql`now()` }).where('id', '=', context.sessionId).execute();
      await this.audit.admin(trx, { adminId: context.adminId, action: 'admin.signed_out', ip: info.ip, userAgent: info.userAgent });
    });
  }

  private pendingKey(token: string): string {
    return `${this.redis.prefix}:admin-pending:${hashToken(token)}`;
  }

  private attemptsKey(token: string): string {
    return `${this.redis.prefix}:admin-pending-attempts:${hashToken(token)}`;
  }
}
