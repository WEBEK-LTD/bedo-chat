import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { DeletionRequestDetail } from '@bedo/contracts';
import type { Database } from '@bedo/db';
import { sql, type Transaction } from 'kysely';
import { AppError } from '../common/app-error.js';
import { normalizePhone } from '../common/phone.js';
import type { RequestInfo } from '../common/request-info.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions.service.js';
import { DatabaseService } from '../database/database.service.js';
import { PushService } from '../delivery/push.service.js';
import type { AdminContext } from './admin-auth.service.js';

const PAGE_SIZE = 50;
const IMPORT_MAX_LINES = 30_000;

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/** Phase 2 admin operations (D-06, D-12, D-14, D-20, P-11, P-12). Every change is audited in the same transaction. */
@Injectable()
export class AdminOperationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ---------------------------------------------------------------- academy phone list

  async listPhones(search: string | undefined, cursor: string | undefined) {
    const digits = search?.replace(/[^\d+]/g, '');
    const rows = await this.db
      .selectFrom('app.academy_phone_list')
      .leftJoin('app.users', 'app.users.phone', 'app.academy_phone_list.phone')
      .select([
        'app.academy_phone_list.phone',
        'app.academy_phone_list.note',
        'app.academy_phone_list.added_at',
        'app.users.status',
      ])
      .$if(Boolean(digits), (qb) => qb.where('app.academy_phone_list.phone', 'like', `%${digits}%`))
      .$if(Boolean(cursor), (qb) => qb.where('app.academy_phone_list.phone', '>', cursor!))
      .orderBy('app.academy_phone_list.phone')
      .limit(PAGE_SIZE + 1)
      .execute();
    const page = rows.slice(0, PAGE_SIZE);
    return {
      items: page.map((row) => ({
        phone: row.phone,
        note: row.note,
        addedAt: new Date(row.added_at).toISOString(),
        accountStatus: row.status ?? null,
      })),
      nextCursor: rows.length > PAGE_SIZE ? page.at(-1)!.phone : null,
    };
  }

  async addPhone(admin: AdminContext, input: string, note: string | undefined, info: RequestInfo) {
    const phone = normalizePhone(input);
    if (!phone) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('app.academy_phone_list')
        .values({ phone, note: note ?? null, added_by: admin.adminId })
        .onConflict((oc) => oc.column('phone').doNothing())
        .returning('phone')
        .executeTakeFirst();
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'phone_list.add',
        targetType: 'phone',
        targetId: phone,
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { added: Boolean(inserted), note: note ?? null },
      });
      return { phone, added: Boolean(inserted) };
    });
  }

  /** CSV: one number per line, optional note in the second column; a header line is ignored (P-11). */
  async importPhones(admin: AdminContext, csv: string, info: RequestInfo) {
    const lines = csv.split(/\r?\n/);
    if (lines.length > IMPORT_MAX_LINES) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    const valid = new Map<string, string | null>();
    const invalid: Array<{ line: number; value: string; reason: string }> = [];
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }
      const [rawPhone = '', ...rest] = trimmed.split(/[,;\t]/);
      const value = rawPhone.trim().replace(/^"|"$/g, '');
      if (index === 0 && /phone|number|mobile/i.test(value)) {
        return;
      }
      const phone = normalizePhone(value);
      if (!phone) {
        invalid.push({ line: index + 1, value: value.slice(0, 40), reason: 'not a valid international phone number' });
        return;
      }
      const note = rest.join(',').trim().replace(/^"|"$/g, '').slice(0, 200);
      valid.set(phone, note.length > 0 ? note : null);
    });

    return this.db.transaction().execute(async (trx) => {
      const entries = [...valid.entries()];
      const added = new Set<string>();
      for (let start = 0; start < entries.length; start += 1000) {
        const chunk = entries.slice(start, start + 1000);
        const rows = await trx
          .insertInto('app.academy_phone_list')
          .values(chunk.map(([phone, note]) => ({ phone, note, added_by: admin.adminId })))
          .onConflict((oc) => oc.column('phone').doNothing())
          .returning('phone')
          .execute();
        rows.forEach((row) => added.add(row.phone));
      }
      const duplicates = entries.map(([phone]) => phone).filter((phone) => !added.has(phone));
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'phone_list.import',
        targetType: 'phone_list',
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { added: added.size, duplicates: duplicates.length, invalid: invalid.length, addedPhones: [...added] },
      });
      return { added: added.size, duplicates, invalid };
    });
  }

  // ---------------------------------------------------------------- deletion requests (D-14)

  async listDeletionRequests(status: 'pending' | 'approved' | 'rejected') {
    const rows = await this.db
      .selectFrom('app.account_deletion_requests')
      .innerJoin('app.users', 'app.users.id', 'app.account_deletion_requests.user_id')
      .select([
        'app.account_deletion_requests.id',
        'app.account_deletion_requests.status',
        'app.account_deletion_requests.requested_at',
        'app.account_deletion_requests.decided_at',
        'app.users.id as user_id',
        'app.users.phone',
        'app.users.name',
        'app.users.username',
      ])
      .where('app.account_deletion_requests.status', '=', status)
      .orderBy('app.account_deletion_requests.requested_at', status === 'pending' ? 'asc' : 'desc')
      .limit(200)
      .execute();
    return {
      items: await Promise.all(rows.map((row) => this.withOriginalIdentity(row))),
    };
  }

  /** Approved requests show the identity the account had, taken from the audit history. */
  private async withOriginalIdentity(row: {
    id: string;
    status: 'pending' | 'approved' | 'rejected';
    requested_at: Date | string;
    decided_at: Date | null;
    user_id: string;
    phone: string | null;
    name: string | null;
    username: string | null;
  }) {
    let identity = { phone: row.phone, name: row.name, username: row.username };
    if (row.status === 'approved') {
      const snapshot = await this.db
        .selectFrom('audit.account_events')
        .select('details')
        .where('user_id', '=', row.user_id)
        .where('event', '=', 'deletion_approved')
        .orderBy('occurred_at', 'desc')
        .executeTakeFirst();
      const details = (snapshot?.details ?? {}) as { identity?: typeof identity };
      identity = details.identity ?? identity;
    }
    return {
      id: row.id,
      status: row.status,
      requestedAt: iso(row.requested_at)!,
      decidedAt: iso(row.decided_at),
      user: { id: row.user_id, ...identity },
    };
  }

  /** Everything an admin reviews before deciding: account, activity and history (D-14 dashboard area). */
  async deletionRequestDetail(requestId: string): Promise<DeletionRequestDetail> {
    const row = await this.db
      .selectFrom('app.account_deletion_requests')
      .innerJoin('app.users', 'app.users.id', 'app.account_deletion_requests.user_id')
      .leftJoin('app.admin_accounts', 'app.admin_accounts.id', 'app.account_deletion_requests.decided_by')
      .select([
        'app.account_deletion_requests.id',
        'app.account_deletion_requests.status',
        'app.account_deletion_requests.requested_at',
        'app.account_deletion_requests.decided_at',
        'app.account_deletion_requests.decision_reason',
        'app.admin_accounts.name as decided_by_name',
        'app.users.id as user_id',
        'app.users.phone',
        'app.users.name',
        'app.users.username',
        'app.users.bio',
        'app.users.status as user_status',
        'app.users.created_at as user_created_at',
      ])
      .where('app.account_deletion_requests.id', '=', requestId)
      .executeTakeFirst();
    if (!row) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    const [sessions, twoStep, identity, accountEvents, securityEvents] = await Promise.all([
      this.db
        .selectFrom('app.sessions')
        .select(['device_name', 'platform', 'last_used_at', 'ip'])
        .where('user_id', '=', row.user_id)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .orderBy('last_used_at', 'desc')
        .execute(),
      this.db.selectFrom('app.two_step').select('user_id').where('user_id', '=', row.user_id).executeTakeFirst(),
      this.db.selectFrom('audit.identity_history').selectAll().where('user_id', '=', row.user_id).orderBy('changed_at', 'desc').limit(200).execute(),
      this.db.selectFrom('audit.account_events').selectAll().where('user_id', '=', row.user_id).orderBy('occurred_at', 'desc').limit(200).execute(),
      this.db
        .selectFrom('audit.security_events')
        .selectAll()
        .where('subject_type', '=', 'user')
        .where('subject_id', '=', row.user_id)
        .orderBy('occurred_at', 'desc')
        .limit(200)
        .execute(),
    ]);
    const base = await this.withOriginalIdentity({
      id: row.id,
      status: row.status,
      requested_at: row.requested_at,
      decided_at: row.decided_at,
      user_id: row.user_id,
      phone: row.phone,
      name: row.name,
      username: row.username,
    });
    return {
      request: { ...base, decisionReason: row.decision_reason, decidedBy: row.decided_by_name ?? null },
      account: {
        status: row.user_status,
        createdAt: iso(row.user_created_at)!,
        bio: row.bio,
        twoStepEnabled: Boolean(twoStep),
        activeSessions: sessions.map((session) => ({
          deviceName: session.device_name,
          platform: session.platform,
          lastUsedAt: iso(session.last_used_at)!,
          ip: session.ip,
        })),
      },
      identityHistory: identity.map((entry) => ({
        at: iso(entry.changed_at)!,
        event: `${entry.field} changed`,
        detail: `${entry.old_value ?? '(none)'} → ${entry.new_value ?? '(none)'}`,
      })),
      accountEvents: accountEvents.map((entry) => ({ at: iso(entry.occurred_at)!, event: entry.event, detail: entry.reason })),
      securityEvents: securityEvents.map((entry) => ({
        at: iso(entry.occurred_at)!,
        event: entry.event,
        detail: [entry.ip, entry.user_agent].filter(Boolean).join(' · ') || null,
      })),
    };
  }

  async approveDeletion(admin: AdminContext, requestId: string, reason: string | undefined, info: RequestInfo) {
    const { userId, subscriptions } = await this.db.transaction().execute(async (trx) => {
      const request = await trx
        .selectFrom('app.account_deletion_requests')
        .select(['id', 'user_id', 'status'])
        .where('id', '=', requestId)
        .forUpdate()
        .executeTakeFirst();
      if (!request) {
        throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      }
      if (request.status !== 'pending') {
        throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      }
      return this.eraseAccount(trx, admin, request.user_id, reason ?? null, info, requestId);
    });
    this.tellDeleted(userId, subscriptions, 'Your request to delete your Bedo Chat account was approved. The account has been deleted.');
    return this.deletionRequestDetail(requestId);
  }

  /**
   * Phase 10: a Super Admin deletes an account directly (spec §22 "delete"), with a reason. The same steps as an
   * approved deletion request (D-14): the identity moves to the permanent history, the number leaves the academy
   * list, every session ends, and a pending request of the user is approved with it.
   */
  async deleteUserByAdmin(admin: AdminContext, userId: string, reason: string, info: RequestInfo): Promise<void> {
    const { subscriptions } = await this.db.transaction().execute(async (trx) => {
      const pending = await trx
        .selectFrom('app.account_deletion_requests')
        .select('id')
        .where('user_id', '=', userId)
        .where('status', '=', 'pending')
        .forUpdate()
        .executeTakeFirst();
      return this.eraseAccount(trx, admin, userId, reason, info, pending?.id ?? null);
    });
    this.tellDeleted(userId, subscriptions, 'An administrator deleted your Bedo Chat account.');
  }

  private tellDeleted(userId: string, subscriptions: Array<{ endpoint: string; p256dh: string; auth: string }>, body: string): void {
    if (subscriptions.length > 0) {
      this.push.notify({ userId, excludeSessionId: null, subscriptions, notification: { title: 'Account deleted', body, tag: 'account-deletion' } });
    }
  }

  private async eraseAccount(
    trx: Transaction<Database>,
    admin: AdminContext,
    userId: string,
    reason: string | null,
    info: RequestInfo,
    requestId: string | null,
  ) {
    const user = await trx.selectFrom('app.users').selectAll().where('id', '=', userId).forUpdate().executeTakeFirst();
    if (!user) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    if (user.status === 'deleted') {
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
    }
    const actor = { type: 'admin' as const, id: admin.adminId };
    const identity = { phone: user.phone, name: user.name, username: user.username, bio: user.bio, photo: user.photo_key };

    // The original identity stays in the permanent audit history (D-14, D-17)...
    await this.audit.account(trx, {
      userId: user.id,
      event: 'deletion_approved',
      actor,
      reason,
      details: { requestId, identity, ...(requestId ? {} : { byAdmin: true }) },
    });
    for (const field of ['phone', 'name', 'username', 'bio', 'photo'] as const) {
      await this.audit.identity(trx, { userId: user.id, field, oldValue: identity[field], newValue: null, actor });
    }
    // ...and the account itself no longer carries it; other users see "Deleted account".
    await trx
      .updateTable('app.users')
      .set({ status: 'deleted', phone: null, name: null, username: null, bio: null, photo_key: null, deleted_at: sql`now()` })
      .where('id', '=', user.id)
      .execute();
    await trx.deleteFrom('app.two_step').where('user_id', '=', user.id).execute();
    // D-24: the number can no longer sign in or create a new account; it stays in the history above.
    if (user.phone) {
      await this.audit.removeFromPhoneList(trx, { phone: user.phone, reason: 'account_deleted', actor, userId: user.id });
    }
    await this.audit.account(trx, { userId: user.id, event: 'deleted', actor });

    // Tell the user on every device, then end every session.
    const subscriptions = await trx.selectFrom('app.push_subscriptions').select(['endpoint', 'p256dh', 'auth']).where('user_id', '=', user.id).execute();
    const ended = await this.sessions.revokeAll(trx, user.id, 'account_deleted');
    await this.audit.security(trx, {
      subjectType: 'user',
      subjectId: user.id,
      event: 'sessions_ended_account_deleted',
      details: { count: ended.length },
    });

    if (requestId) {
      await trx
        .updateTable('app.account_deletion_requests')
        .set({ status: 'approved', decided_by: admin.adminId, decided_at: sql`now()`, decision_reason: reason })
        .where('id', '=', requestId)
        .execute();
    }
    await this.audit.admin(trx, {
      adminId: admin.adminId,
      action: requestId ? 'account.deletion_approved' : 'account.deleted_by_admin',
      targetType: 'user',
      targetId: user.id,
      ip: info.ip,
      userAgent: info.userAgent,
      metadata: { requestId, reason },
    });
    return { userId: user.id, subscriptions };
  }

  async rejectDeletion(admin: AdminContext, requestId: string, reason: string | undefined, info: RequestInfo) {
    const userId = await this.db.transaction().execute(async (trx) => {
      const request = await trx
        .selectFrom('app.account_deletion_requests')
        .select(['id', 'user_id', 'status'])
        .where('id', '=', requestId)
        .forUpdate()
        .executeTakeFirst();
      if (!request) {
        throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      }
      if (request.status !== 'pending') {
        throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      }
      await trx
        .updateTable('app.account_deletion_requests')
        .set({ status: 'rejected', decided_by: admin.adminId, decided_at: sql`now()`, decision_reason: reason ?? null })
        .where('id', '=', requestId)
        .execute();
      await trx
        .updateTable('app.users')
        .set({ status: 'active' })
        .where('id', '=', request.user_id)
        .where('status', '=', 'deletion_requested')
        .execute();
      await this.audit.account(trx, {
        userId: request.user_id,
        event: 'deletion_rejected',
        actor: { type: 'admin', id: admin.adminId },
        reason: reason ?? null,
        details: { requestId },
      });
      await trx.insertInto('app.security_notices').values({ user_id: request.user_id, kind: 'deletion_rejected', details: {} }).execute();
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'account.deletion_rejected',
        targetType: 'user',
        targetId: request.user_id,
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { requestId, reason: reason ?? null },
      });
      return request.user_id;
    });
    this.push.notify({
      userId,
      excludeSessionId: null,
      notification: {
        title: 'Deletion request rejected',
        body: 'Your request to delete your Bedo Chat account was rejected. Your account remains active.',
        tag: 'account-deletion',
      },
    });
    return this.deletionRequestDetail(requestId);
  }

  // ---------------------------------------------------------------- 2-Step reset (D-12)

  async resetTwoStep(admin: AdminContext, phoneInput: string, reason: string, info: RequestInfo) {
    const phone = normalizePhone(phoneInput);
    if (!phone) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    const userId = await this.db.transaction().execute(async (trx) => {
      const user = await trx.selectFrom('app.users').select(['id']).where('phone', '=', phone).executeTakeFirst();
      if (!user) {
        throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      }
      const removed = await trx.deleteFrom('app.two_step').where('user_id', '=', user.id).executeTakeFirst();
      if (Number(removed.numDeletedRows) === 0) {
        throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      }
      await this.audit.security(trx, {
        subjectType: 'user',
        subjectId: user.id,
        event: 'two_step_reset_by_admin',
        ip: info.ip,
        userAgent: info.userAgent,
        details: { adminId: admin.adminId, reason },
      });
      await trx.insertInto('app.security_notices').values({ user_id: user.id, kind: 'two_step_reset', details: {} }).execute();
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'user.two_step_reset',
        targetType: 'user',
        targetId: user.id,
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { reason },
      });
      return user.id;
    });
    this.push.notify({
      userId,
      excludeSessionId: null,
      notification: {
        title: '2-Step Verification was reset',
        body: 'An administrator reset your 2-Step Verification password at your request. You can set a new one in Settings.',
        tag: 'two-step-reset',
      },
    });
    return { reset: true as const };
  }
}
