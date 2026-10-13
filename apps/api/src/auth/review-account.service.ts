import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import type { AdminReviewAccount } from '@bedo/contracts';
import { decryptAtRest, encryptAtRest, parseAes256Key } from '@bedo/server-crypto';
import { sql } from 'kysely';
import { AppError } from '../common/app-error.js';
import type { RequestInfo } from '../common/request-info.js';
import { API_ENV } from '../config/tokens.js';
import { AuditService, type Executor } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { SessionsService } from './sessions.service.js';

const CODE_PURPOSE = 'bedo store review code v1';

/**
 * D-56: the store review account. While a Super Admin has it turned on, ONE phone number signs in to the student app
 * with a fixed 6-digit code set in the Admin Dashboard, so Google Play and Apple reviewers (who cannot receive a
 * WhatsApp code) can review the apps. Only student sign-in; every limit and lock of ordinary codes still applies.
 */
@Injectable()
export class ReviewAccountService {
  private readonly key: Buffer;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.key = parseAes256Key(env.SETTINGS_ENCRYPTION_KEY);
  }

  /** The fixed code for this number while the review account is on, else null (the number gets a WhatsApp code). */
  async codeFor(db: Executor, phone: string): Promise<string | null> {
    const row = await db
      .selectFrom('app.review_account_settings')
      .select(['enabled', 'phone', 'code_enc'])
      .executeTakeFirst()
      .catch((error: unknown) => {
        // Update 20261021120000 not run yet: sign-in works as before, with WhatsApp codes only.
        if ((error as { code?: string }).code === '42P01') return undefined;
        throw error;
      });
    if (!row?.enabled || row.phone !== phone || !row.code_enc) return null;
    return decryptAtRest(this.key, row.code_enc, CODE_PURPOSE).toString('utf8');
  }

  async settings(): Promise<AdminReviewAccount> {
    const row = await this.database.db
      .selectFrom('app.review_account_settings as s')
      .leftJoin('app.admin_accounts as a', 'a.id', 's.updated_by')
      .select(['s.enabled', 's.phone', 's.code_enc', 's.updated_at', 'a.name'])
      .executeTakeFirstOrThrow();
    return {
      enabled: row.enabled,
      phone: row.phone,
      code: row.code_enc ? decryptAtRest(this.key, row.code_enc, CODE_PURPOSE).toString('utf8') : null,
      updatedBy: row.name ?? null,
      updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    };
  }

  /**
   * Saves the number and code and turns the account on or off, recorded in the admin history (never the code).
   * Turning it off, or moving it to another number, ends the sessions of the account that had it.
   */
  async update(admin: { adminId: string }, body: { enabled: boolean; phone: string; code: string }, info: RequestInfo): Promise<AdminReviewAccount> {
    if (!/^\d{6}$/.test(body.code)) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    await this.database.db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('app.review_account_settings').select(['enabled', 'phone']).forUpdate().executeTakeFirstOrThrow();
      await trx
        .updateTable('app.review_account_settings')
        .set({
          enabled: body.enabled,
          phone: body.phone,
          code_enc: encryptAtRest(this.key, Buffer.from(body.code, 'utf8'), CODE_PURPOSE),
          updated_by: admin.adminId,
          updated_at: sql`now()`,
        })
        .execute();
      let ended = 0;
      if (before.enabled && before.phone && (!body.enabled || before.phone !== body.phone)) {
        const user = await trx.selectFrom('app.users').select('id').where('phone', '=', before.phone).executeTakeFirst();
        if (user) {
          ended = (await this.sessions.revokeAll(trx, user.id, 'ended_by_admin')).length;
          await this.audit.security(trx, { subjectType: 'user', subjectId: user.id, event: 'sessions_ended_review_account_off', details: { count: ended, adminId: admin.adminId } });
        }
      }
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'settings.review_account',
        targetType: 'setting',
        targetId: 'review_account',
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { enabled: body.enabled, phone: body.phone, wasEnabled: before.enabled, previousPhone: before.phone, sessionsEnded: ended },
      });
    });
    return this.settings();
  }
}
