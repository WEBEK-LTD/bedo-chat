import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { type SessionInfo, TOKEN_RULES } from '@bedo/contracts';
import type { Platform, SessionRevokeReason } from '@bedo/db';
import { sql } from 'kysely';
import { AppError } from '../common/app-error.js';
import { hashToken, randomToken } from '../common/crypto.js';
import type { RequestInfo } from '../common/request-info.js';
import { AuditService, type Executor } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Two browser tabs can refresh with the same cookie at the same moment. A rotated-out token presented
 * again within this window is treated as that race (no new token, no revocation); later, as theft.
 */
const ROTATION_GRACE_MS = 20_000;

export interface NewSession {
  sessionId: string;
  refreshToken: string;
}

export type RotateResult =
  | { kind: 'rotated'; userId: string; sessionId: string; refreshToken: string }
  | { kind: 'concurrent'; userId: string; sessionId: string };

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private expiry(): Date {
    return new Date(Date.now() + TOKEN_RULES.refreshTokenIdleDays * DAY_MS);
  }

  async create(
    trx: Executor,
    input: { userId: string; platform: Platform; deviceName: string | null; info: RequestInfo },
  ): Promise<NewSession> {
    const refreshToken = randomToken();
    const row = await trx
      .insertInto('app.sessions')
      .values({
        user_id: input.userId,
        refresh_hash: hashToken(refreshToken),
        platform: input.platform,
        device_name: input.deviceName,
        ip: input.info.ip,
        user_agent: input.info.userAgent,
        expires_at: this.expiry(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { sessionId: row.id, refreshToken };
  }

  /**
   * Rotates a refresh token (P-02). Every rotated-out token is remembered for its session; presenting one
   * again ends the whole session (reuse detection), except the most recent one within the short grace
   * window, which is two tabs refreshing at the same moment.
   */
  async rotate(refreshToken: string, info: RequestInfo): Promise<RotateResult> {
    const hash = hashToken(refreshToken);
    return this.database.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('app.sessions')
        .innerJoin('app.users', 'app.users.id', 'app.sessions.user_id')
        .select([
          'app.sessions.id',
          'app.sessions.user_id',
          'app.sessions.expires_at',
          'app.sessions.revoked_at',
          'app.sessions.revoke_reason',
          'app.users.status',
        ])
        .where('app.sessions.refresh_hash', '=', hash)
        .forUpdate()
        .executeTakeFirst();

      if (current) {
        this.assertUsable(current);
        const next = randomToken();
        await trx
          .updateTable('app.sessions')
          .set({
            refresh_hash: hashToken(next),
            previous_refresh_hash: hash,
            last_used_at: sql`now()`,
            expires_at: this.expiry(),
            ip: info.ip,
          })
          .where('id', '=', current.id)
          .execute();
        await trx.insertInto('app.retired_refresh_tokens').values({ token_hash: hash, session_id: current.id }).execute();
        return { kind: 'rotated' as const, userId: current.user_id, sessionId: current.id, refreshToken: next };
      }

      const retired = await trx.selectFrom('app.retired_refresh_tokens').select('session_id').where('token_hash', '=', hash).executeTakeFirst();
      if (!retired) {
        throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
      }
      const reused = await trx
        .selectFrom('app.sessions')
        .innerJoin('app.users', 'app.users.id', 'app.sessions.user_id')
        .select([
          'app.sessions.id',
          'app.sessions.user_id',
          'app.sessions.expires_at',
          'app.sessions.revoked_at',
          'app.sessions.revoke_reason',
          'app.sessions.last_used_at',
          'app.sessions.previous_refresh_hash',
          'app.users.status',
        ])
        .where('app.sessions.id', '=', retired.session_id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      this.assertUsable(reused);
      if (reused.previous_refresh_hash === hash && Date.now() - new Date(reused.last_used_at).getTime() <= ROTATION_GRACE_MS) {
        return { kind: 'concurrent' as const, userId: reused.user_id, sessionId: reused.id };
      }
      // A token that was already exchanged is being used again: someone has a copy. End the session.
      await this.revoke(trx, reused.id, 'refresh_reuse');
      await this.audit.security(trx, {
        subjectType: 'user',
        subjectId: reused.user_id,
        event: 'refresh_reuse_detected',
        sessionId: reused.id,
        ip: info.ip,
        userAgent: info.userAgent,
      });
      return null;
    }).then((result) => {
      if (!result) {
        throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
      }
      return result;
    });
  }

  private assertUsable(session: {
    expires_at: Date | string;
    revoked_at: Date | null;
    revoke_reason: SessionRevokeReason | null;
    status: string;
  }): void {
    if (session.revoked_at) {
      if (session.revoke_reason === 'account_deleted') {
        throw new AppError(HttpStatus.UNAUTHORIZED, 'ACCOUNT_DELETED');
      }
      if (session.revoke_reason === 'account_blocked') {
        throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
      }
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
    }
    if (session.status === 'suspended' || session.status === 'banned') {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
    }
  }

  async revoke(db: Executor, sessionId: string, reason: SessionRevokeReason): Promise<void> {
    await db
      .updateTable('app.sessions')
      .set({ revoked_at: sql`now()`, revoke_reason: reason })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
    await db.deleteFrom('app.push_subscriptions').where('session_id', '=', sessionId).execute();
  }

  /** Ends every active session of a user, optionally keeping one. Returns the ended session ids. */
  async revokeAll(db: Executor, userId: string, reason: SessionRevokeReason, keepSessionId?: string): Promise<string[]> {
    let query = db
      .updateTable('app.sessions')
      .set({ revoked_at: sql`now()`, revoke_reason: reason })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null);
    if (keepSessionId) {
      query = query.where('id', '<>', keepSessionId);
    }
    const ended = await query.returning('id').execute();
    const ids = ended.map((row) => row.id);
    if (ids.length > 0) {
      await db.deleteFrom('app.push_subscriptions').where('session_id', 'in', ids).execute();
    }
    return ids;
  }

  /** The session a current or retired refresh token belongs to (used by logout). */
  async findByRefresh(refreshToken: string) {
    const hash = hashToken(refreshToken);
    return this.database.db
      .selectFrom('app.sessions')
      .select(['id', 'user_id', 'revoked_at'])
      .where((eb) =>
        eb.or([
          eb('refresh_hash', '=', hash),
          eb('id', 'in', eb.selectFrom('app.retired_refresh_tokens').select('session_id').where('token_hash', '=', hash)),
        ]),
      )
      .executeTakeFirst();
  }

  /** Session and account check on every authenticated request (logout and revocation take effect at once). */
  async loadActive(sessionId: string, userId: string) {
    return this.database.db
      .selectFrom('app.sessions')
      .innerJoin('app.users', 'app.users.id', 'app.sessions.user_id')
      .select([
        'app.sessions.id as session_id',
        'app.sessions.revoked_at',
        'app.sessions.revoke_reason',
        'app.sessions.expires_at',
        'app.users.id as user_id',
        'app.users.status',
      ])
      .where('app.sessions.id', '=', sessionId)
      .where('app.sessions.user_id', '=', userId)
      .executeTakeFirst();
  }

  async list(userId: string, currentSessionId: string): Promise<SessionInfo[]> {
    const rows = await this.database.db
      .selectFrom('app.sessions')
      .select(['id', 'device_name', 'platform', 'ip', 'created_at', 'last_used_at'])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .orderBy('last_used_at', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      deviceName: row.device_name,
      platform: row.platform,
      ip: row.ip,
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: new Date(row.last_used_at).toISOString(),
      current: row.id === currentSessionId,
    }));
  }
}
