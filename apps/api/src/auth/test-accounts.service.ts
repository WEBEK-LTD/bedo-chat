import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { type AdminTestAccounts, TEST_ACCOUNT_RULES } from '@bedo/contracts';
import { decryptAtRest, encryptAtRest, parseAes256Key } from '@bedo/server-crypto';
import { sql } from 'kysely';
import { AppError } from '../common/app-error.js';
import type { RequestInfo } from '../common/request-info.js';
import { API_ENV } from '../config/tokens.js';
import { AuditService, type Executor } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { SessionsService } from './sessions.service.js';

const CODE_PURPOSE = 'bedo test accounts code v1';

/** The tables come with update 20261029120000; before it runs, test accounts simply do not exist. */
function missingTable(error: unknown): boolean {
  return (error as { code?: string }).code === '42P01';
}

/** Digits of a number in +<digits> form, as a whole number (for range sizes). */
function digits(phone: string): bigint {
  return BigInt(phone.slice(1));
}

/**
 * D-59: test accounts. While a Super Admin has them turned on, every number in the ranges set in the Admin Dashboard
 * signs in to the student app with ONE fixed 6-digit code instead of a WhatsApp code. Each number is its own account,
 * like any student's. Separate from the store review account (D-56), which comes first and is never changed here.
 *
 * Never for a number on the academy phone list, and never for an existing account that was not created as a test
 * account: a real student whose number falls in a range keeps getting WhatsApp codes only.
 */
@Injectable()
export class TestAccountsService {
  private readonly key: Buffer;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.key = parseAes256Key(env.SETTINGS_ENCRYPTION_KEY);
  }

  /** The fixed code for this number while test accounts are on and it is a test number, else null. */
  async codeFor(db: Executor, phone: string): Promise<string | null> {
    try {
      const settings = await db.selectFrom('app.test_account_settings').select(['enabled', 'code_enc']).executeTakeFirst();
      if (!settings?.enabled || !settings.code_enc) return null;
      const range = await db
        .selectFrom('app.test_number_ranges')
        .select('id')
        .where('first_phone', '<=', phone)
        .where('last_phone', '>=', phone)
        .where(sql<boolean>`length(first_phone) = length(${phone})`)
        .executeTakeFirst();
      if (!range) return null;
      // The store review account's number is never a test number (D-56 stays exactly as it is).
      const review = await db.selectFrom('app.review_account_settings').select('phone').where('phone', '=', phone).executeTakeFirst();
      if (review) return null;
      const listed = await db.selectFrom('app.academy_phone_list').select('phone').where('phone', '=', phone).executeTakeFirst();
      if (listed) return null;
      const user = await db
        .selectFrom('app.users as u')
        .leftJoin('app.test_accounts as t', 't.user_id', 'u.id')
        .select(['u.id', 't.user_id as test'])
        .where('u.phone', '=', phone)
        .executeTakeFirst();
      if (user && !user.test) return null;
      return decryptAtRest(this.key, settings.code_enc, CODE_PURPOSE).toString('utf8');
    } catch (error) {
      if (missingTable(error)) return null;
      throw error;
    }
  }

  /** A new account created by signing in with the test code is recorded as a test account. */
  async markTestAccount(db: Executor, userId: string): Promise<void> {
    await db.insertInto('app.test_accounts').values({ user_id: userId }).onConflict((oc) => oc.column('user_id').doNothing()).execute();
  }

  async settings(): Promise<AdminTestAccounts> {
    const db = this.database.db;
    const row = await db
      .selectFrom('app.test_account_settings as s')
      .leftJoin('app.admin_accounts as a', 'a.id', 's.updated_by')
      .select(['s.enabled', 's.code_enc', 's.updated_at', 'a.name'])
      .executeTakeFirstOrThrow();
    const ranges = await db
      .selectFrom('app.test_number_ranges as r')
      .leftJoin('app.admin_accounts as a', 'a.id', 'r.added_by')
      .select([
        'r.id',
        'r.first_phone',
        'r.last_phone',
        'r.added_at',
        'a.name',
        (eb) =>
          eb
            .selectFrom('app.test_accounts as t')
            .innerJoin('app.users as u', 'u.id', 't.user_id')
            .select(sql<string>`count(*)::text`.as('n'))
            .whereRef('u.phone', '>=', 'r.first_phone')
            .whereRef('u.phone', '<=', 'r.last_phone')
            .where(sql<boolean>`length(u.phone) = length(r.first_phone)`)
            .as('accounts'),
      ])
      .orderBy('r.first_phone')
      .execute();
    return {
      enabled: row.enabled,
      code: row.code_enc ? decryptAtRest(this.key, row.code_enc, CODE_PURPOSE).toString('utf8') : null,
      ranges: ranges.map((range) => ({
        id: range.id,
        firstPhone: range.first_phone,
        lastPhone: range.last_phone,
        size: Number(digits(range.last_phone) - digits(range.first_phone)) + 1,
        accounts: Number(range.accounts ?? 0),
        addedBy: range.name ?? null,
        addedAt: range.added_at.toISOString(),
      })),
      updatedBy: row.name ?? null,
      updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    };
  }

  /** Ends the sessions of the test accounts (all, or those in one range). Returns how many sessions ended. */
  private async endSessions(trx: Executor, adminId: string, range?: { first: string; last: string }): Promise<number> {
    const users = await trx
      .selectFrom('app.test_accounts as t')
      .innerJoin('app.users as u', 'u.id', 't.user_id')
      .select('u.id')
      .$if(Boolean(range), (qb) =>
        qb
          .where('u.phone', '>=', range!.first)
          .where('u.phone', '<=', range!.last)
          .where(sql<boolean>`length(u.phone) = length(${range!.first})`),
      )
      .execute();
    let ended = 0;
    for (const user of users) {
      const count = (await this.sessions.revokeAll(trx, user.id, 'ended_by_admin')).length;
      if (count > 0) {
        await this.audit.security(trx, { subjectType: 'user', subjectId: user.id, event: 'sessions_ended_test_accounts_off', details: { count, adminId } });
      }
      ended += count;
    }
    return ended;
  }

  /** Saves the code and turns test accounts on or off; turning them off ends every test account's sessions. */
  async update(admin: { adminId: string }, body: { enabled: boolean; code: string }, info: RequestInfo): Promise<AdminTestAccounts> {
    if (!/^\d{6}$/.test(body.code)) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    await this.database.db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('app.test_account_settings').select(['enabled']).forUpdate().executeTakeFirstOrThrow();
      await trx
        .updateTable('app.test_account_settings')
        .set({
          enabled: body.enabled,
          code_enc: encryptAtRest(this.key, Buffer.from(body.code, 'utf8'), CODE_PURPOSE),
          updated_by: admin.adminId,
          updated_at: sql`now()`,
        })
        .execute();
      const ended = before.enabled && !body.enabled ? await this.endSessions(trx, admin.adminId) : 0;
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'settings.test_accounts',
        targetType: 'setting',
        targetId: 'test_accounts',
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { enabled: body.enabled, wasEnabled: before.enabled, sessionsEnded: ended },
      });
    });
    return this.settings();
  }

  /**
   * Adds a range: same length numbers, first <= last, at most 1000 numbers (VALIDATION_FAILED), at most 50 ranges
   * (LIMIT_REACHED), not overlapping another range (CONFLICT). The Admin Dashboard checks the same first.
   */
  async addRange(admin: { adminId: string }, firstPhone: string, lastPhone: string, info: RequestInfo): Promise<AdminTestAccounts> {
    if (firstPhone.length !== lastPhone.length || firstPhone > lastPhone) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    const size = digits(lastPhone) - digits(firstPhone) + 1n;
    if (size > BigInt(TEST_ACCOUNT_RULES.maxRangeSize)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    await this.database.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended('bedo-test-number-ranges', 0))`.execute(trx);
      const count = await trx.selectFrom('app.test_number_ranges').select(sql<string>`count(*)::text`.as('n')).executeTakeFirstOrThrow();
      if (Number(count.n) >= TEST_ACCOUNT_RULES.maxRanges) {
        throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
      }
      const overlap = await trx
        .selectFrom('app.test_number_ranges')
        .select('id')
        .where(sql<boolean>`length(first_phone) = length(${firstPhone})`)
        .where('first_phone', '<=', lastPhone)
        .where('last_phone', '>=', firstPhone)
        .executeTakeFirst();
      if (overlap) {
        throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      }
      const added = await trx
        .insertInto('app.test_number_ranges')
        .values({ first_phone: firstPhone, last_phone: lastPhone, added_by: admin.adminId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'settings.test_accounts.range_added',
        targetType: 'setting',
        targetId: 'test_accounts',
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { rangeId: added.id, firstPhone, lastPhone, size: Number(size) },
      });
    });
    return this.settings();
  }

  /** Removes a range; its test accounts can no longer sign in with the code, and their sessions end. */
  async removeRange(admin: { adminId: string }, id: string, info: RequestInfo): Promise<AdminTestAccounts> {
    await this.database.db.transaction().execute(async (trx) => {
      const removed = await trx.deleteFrom('app.test_number_ranges').where('id', '=', id).returning(['first_phone', 'last_phone']).executeTakeFirst();
      if (!removed) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      const ended = await this.endSessions(trx, admin.adminId, { first: removed.first_phone, last: removed.last_phone });
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'settings.test_accounts.range_removed',
        targetType: 'setting',
        targetId: 'test_accounts',
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { rangeId: id, firstPhone: removed.first_phone, lastPhone: removed.last_phone, sessionsEnded: ended },
      });
    });
    return this.settings();
  }
}
