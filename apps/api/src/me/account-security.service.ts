import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { SecurityNotice } from '@bedo/contracts';
import { sql } from 'kysely';
import { AppError } from '../common/app-error.js';
import type { RequestInfo } from '../common/request-info.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountsService } from '../auth/accounts.service.js';
import { OtpService } from '../auth/otp.service.js';
import { SessionsService } from '../auth/sessions.service.js';
import { hintContainsPassword, TwoStepService } from '../auth/two-step.service.js';
import { DatabaseService } from '../database/database.service.js';

/** Phone change, sessions, 2-Step Verification, security notices, push subscriptions and deletion requests. */
@Injectable()
export class AccountSecurityService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(TwoStepService) private readonly twoStep: TwoStepService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ---------------------------------------------------------------- phone number change

  /** Same neutral answer whether or not the new number may be used (on the academy list and unused). */
  async requestPhoneChange(userId: string, newPhone: string, info: RequestInfo) {
    const [listed, holder, user] = await Promise.all([
      this.accounts.isOnAcademyList(this.db, newPhone),
      this.accounts.findByPhone(this.db, newPhone),
      this.accounts.findById(this.db, userId),
    ]);
    return this.otp.issue({
      purpose: 'change_phone',
      phone: newPhone,
      eligible: listed && !holder && user?.phone !== newPhone,
      subject: { subjectType: 'user', subjectId: userId },
      requestedBy: userId,
      info,
    });
  }

  async verifyPhoneChange(userId: string, newPhone: string, code: string, twoStepPassword: string | undefined, info: RequestInfo) {
    const record = await this.db.selectFrom('app.two_step').select('password_hash').where('user_id', '=', userId).executeTakeFirst();
    if (record) {
      if (!twoStepPassword) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'TWO_STEP_REQUIRED');
      }
      await this.twoStep.reserveSessionAttempt(userId);
      if (!(await this.twoStep.verifyPassword(record.password_hash, twoStepPassword))) {
        await this.audit.security(this.db, {
          subjectType: 'user',
          subjectId: userId,
          event: 'two_step_failed',
          ip: info.ip,
          userAgent: info.userAgent,
          details: { during: 'phone_change' },
        });
        throw new AppError(HttpStatus.BAD_REQUEST, 'TWO_STEP_INVALID');
      }
      await this.twoStep.clearFailures(userId);
    }
    await this.otp.check({
      purpose: 'change_phone',
      phone: newPhone,
      code,
      subject: { subjectType: 'user', subjectId: userId },
      requestedBy: userId,
      info,
    });
    await this.db
      .transaction()
      .execute(async (trx) => {
      const current = await trx.selectFrom('app.users').select('phone').where('id', '=', userId).forUpdate().executeTakeFirstOrThrow();
      // The number may have been taken by another account since the code was sent.
      const taken = await trx.selectFrom('app.users').select('id').where('phone', '=', newPhone).where('id', '<>', userId).executeTakeFirst();
      if (taken) {
        throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      }
      // Second check: the new number must still be on the academy list (D-06).
      if (!(await this.accounts.isOnAcademyList(trx, newPhone))) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'OTP_INVALID');
      }
      await trx.updateTable('app.users').set({ phone: newPhone }).where('id', '=', userId).execute();
      await this.audit.identity(trx, {
        userId,
        field: 'phone',
        oldValue: current.phone,
        newValue: newPhone,
        actor: { type: 'user', id: userId },
      });
      // D-24: the old number stops being a login number; it stays in identity history.
      if (current.phone && current.phone !== newPhone) {
        await this.audit.removeFromPhoneList(trx, {
          phone: current.phone,
          reason: 'phone_changed',
          actor: { type: 'user', id: userId },
          userId,
        });
      }
      await this.audit.security(trx, {
        subjectType: 'user',
        subjectId: userId,
        event: 'phone_changed',
        ip: info.ip,
        userAgent: info.userAgent,
      });
    })
      .catch((error: unknown) => {
        // Another account took the number at the same moment (unique index).
        if ((error as { code?: string }).code === '23505') {
          throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
        }
        throw error;
      });
  }

  // ---------------------------------------------------------------- sessions

  async endSession(userId: string, currentSessionId: string, sessionId: string, info: RequestInfo): Promise<void> {
    const target = await this.db
      .selectFrom('app.sessions')
      .select(['id'])
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (!target) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    await this.db.transaction().execute(async (trx) => {
      await this.sessions.revoke(trx, sessionId, sessionId === currentSessionId ? 'logout' : 'terminated_by_user');
      await this.audit.security(trx, {
        subjectType: 'user',
        subjectId: userId,
        event: 'session_ended',
        sessionId,
        ip: info.ip,
        userAgent: info.userAgent,
        details: { byUser: true, fromSession: currentSessionId },
      });
    });
  }

  async endOtherSessions(userId: string, currentSessionId: string, info: RequestInfo): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const ended = await this.sessions.revokeAll(trx, userId, 'terminated_other_sessions', currentSessionId);
      await this.audit.security(trx, {
        subjectType: 'user',
        subjectId: userId,
        event: 'other_sessions_ended',
        sessionId: currentSessionId,
        ip: info.ip,
        userAgent: info.userAgent,
        details: { count: ended.length },
      });
      return ended.length;
    });
  }

  // ---------------------------------------------------------------- 2-Step Verification (P-09)

  async twoStepStatus(userId: string) {
    const row = await this.db.selectFrom('app.two_step').select('hint').where('user_id', '=', userId).executeTakeFirst();
    return { enabled: Boolean(row), hint: row?.hint ?? null };
  }

  async setTwoStep(userId: string, body: { currentPassword?: string; newPassword: string; hint?: string }, info: RequestInfo) {
    if (hintContainsPassword(body.hint, body.newPassword)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    const existing = await this.db.selectFrom('app.two_step').select('password_hash').where('user_id', '=', userId).executeTakeFirst();
    if (existing) {
      await this.twoStep.reserveSessionAttempt(userId);
      if (!body.currentPassword || !(await this.twoStep.verifyPassword(existing.password_hash, body.currentPassword))) {
        await this.audit.security(this.db, {
          subjectType: 'user',
          subjectId: userId,
          event: 'two_step_failed',
          ip: info.ip,
          userAgent: info.userAgent,
          details: { during: 'change' },
        });
        throw new AppError(HttpStatus.BAD_REQUEST, 'TWO_STEP_INVALID');
      }
      await this.twoStep.clearFailures(userId);
    }
    const passwordHash = await this.twoStep.hashPassword(body.newPassword);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('app.two_step')
        .values({ user_id: userId, password_hash: passwordHash, hint: body.hint ?? null })
        .onConflict((oc) => oc.column('user_id').doUpdateSet({ password_hash: passwordHash, hint: body.hint ?? null }))
        .execute();
      await this.audit.security(trx, {
        subjectType: 'user',
        subjectId: userId,
        event: existing ? 'two_step_changed' : 'two_step_enabled',
        ip: info.ip,
        userAgent: info.userAgent,
      });
    });
    return this.twoStepStatus(userId);
  }

  async disableTwoStep(userId: string, currentPassword: string, info: RequestInfo) {
    await this.twoStep.reserveSessionAttempt(userId);
    const existing = await this.db.selectFrom('app.two_step').select('password_hash').where('user_id', '=', userId).executeTakeFirst();
    if (!existing || !(await this.twoStep.verifyPassword(existing.password_hash, currentPassword))) {
      await this.audit.security(this.db, {
        subjectType: 'user',
        subjectId: userId,
        event: 'two_step_failed',
        ip: info.ip,
        userAgent: info.userAgent,
        details: { during: 'disable' },
      });
      throw new AppError(HttpStatus.BAD_REQUEST, 'TWO_STEP_INVALID');
    }
    await this.twoStep.clearFailures(userId);
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('app.two_step').where('user_id', '=', userId).execute();
      await this.audit.security(trx, {
        subjectType: 'user',
        subjectId: userId,
        event: 'two_step_disabled',
        ip: info.ip,
        userAgent: info.userAgent,
      });
    });
    return this.twoStepStatus(userId);
  }

  // ---------------------------------------------------------------- security notices (D-13)

  async notices(userId: string, currentSessionId: string): Promise<{ notices: SecurityNotice[]; unreadCount: number }> {
    const rows = await this.db
      .selectFrom('app.security_notices')
      .select(['id', 'kind', 'created_at', 'read_at', 'details'])
      .where('user_id', '=', userId)
      .where((eb) => eb.or([eb('session_id', 'is', null), eb('session_id', '<>', currentSessionId)]))
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    const notices = rows.map((row) => {
      const details = row.details as { deviceName?: string | null; platform?: 'web' | 'ios' | 'android' | 'desktop'; ip?: string | null };
      return {
        id: String(row.id),
        kind: row.kind,
        createdAt: new Date(row.created_at).toISOString(),
        read: row.read_at !== null,
        details: {
          ...(details.deviceName !== undefined ? { deviceName: details.deviceName } : {}),
          ...(details.platform ? { platform: details.platform } : {}),
          ...(details.ip !== undefined ? { ip: details.ip } : {}),
        },
      };
    });
    return { notices, unreadCount: notices.filter((notice) => !notice.read).length };
  }

  async markNoticesRead(userId: string, currentSessionId: string, ids?: string[]) {
    let query = this.db
      .updateTable('app.security_notices')
      .set({ read_at: sql`now()` })
      .where('user_id', '=', userId)
      .where('read_at', 'is', null);
    if (ids && ids.length > 0) {
      query = query.where('id', 'in', ids);
    }
    await query.execute();
    return this.notices(userId, currentSessionId);
  }

  // ---------------------------------------------------------------- push subscriptions (D-21)

  async savePushSubscription(userId: string, sessionId: string, body: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    await this.db.transaction().execute(async (trx) => {
      // One subscription per session. The same browser endpoint may move from this user's older session,
      // or from any session that has ended, but never away from another user's live session.
      await trx
        .deleteFrom('app.push_subscriptions')
        .where((eb) =>
          eb.or([
            eb('session_id', '=', sessionId),
            eb.and([
              eb('endpoint', '=', body.endpoint),
              eb.or([
                eb('user_id', '=', userId),
                eb.exists(
                  eb
                    .selectFrom('app.sessions')
                    .select(sql`1`.as('one'))
                    .whereRef('app.sessions.id', '=', 'app.push_subscriptions.session_id')
                    .where((inner) =>
                      inner.or([inner('app.sessions.revoked_at', 'is not', null), inner('app.sessions.expires_at', '<=', sql<Date>`now()`)]),
                    ),
                ),
              ]),
            ]),
          ]),
        )
        .execute();
      await trx
        .insertInto('app.push_subscriptions')
        .values({ user_id: userId, session_id: sessionId, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth })
        .execute();
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === '23505') {
        throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      }
      throw error;
    });
  }

  async removePushSubscription(sessionId: string) {
    await this.db.deleteFrom('app.push_subscriptions').where('session_id', '=', sessionId).execute();
  }

  // ---------------------------------------------------------------- account deletion (D-14)

  async requestDeletion(userId: string, info: RequestInfo) {
    return this.db.transaction().execute(async (trx) => {
      const user = await trx.selectFrom('app.users').select(['status']).where('id', '=', userId).forUpdate().executeTakeFirstOrThrow();
      if (user.status !== 'active') {
        throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      }
      const request = await trx
        .insertInto('app.account_deletion_requests')
        .values({ user_id: userId })
        .returning(['requested_at'])
        .executeTakeFirstOrThrow();
      await trx.updateTable('app.users').set({ status: 'deletion_requested' }).where('id', '=', userId).execute();
      await this.audit.account(trx, {
        userId,
        event: 'deletion_requested',
        actor: { type: 'user', id: userId },
        details: { ip: info.ip },
      });
      await trx.insertInto('app.security_notices').values({ user_id: userId, kind: 'deletion_requested', details: {} }).execute();
      return { status: 'deletion_requested' as const, requestedAt: new Date(request.requested_at).toISOString() };
    });
  }
}
