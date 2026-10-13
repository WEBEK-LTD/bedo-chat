import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type AdminAccessSettings,
  type SignupMode,
  ADMIN_CONSOLE_RULES,
  type AdminReport,
  type AdminSpeedCheck,
  type AdminStats,
  type AdminUserDetail,
  type AdminUserRef,
  type AdminUserSummary,
  type AuditKind,
} from '@bedo/contracts';
import type { ApiEnv } from '@bedo/config';
import type { Database, UserStatus } from '@bedo/db';
import { sql, type Transaction } from 'kysely';
import { type Actor, AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions.service.js';
import { AppError } from '../common/app-error.js';
import { API_ENV } from '../config/tokens.js';
import type { RequestInfo } from '../common/request-info.js';
import { DatabaseService } from '../database/database.service.js';
import { PushService } from '../delivery/push.service.js';
import { UserPermissionsService } from '../groups/user-permissions.service.js';
import { BroadcastsService } from '../messaging/broadcasts.service.js';
import { likePattern } from '../messaging/messages.service.js';
import { PermissionService } from '../messaging/permissions.service.js';
import { UpdateLogService } from '../messaging/update-log.service.js';
import type { AdminContext } from './admin-auth.service.js';
import { AdminOperationsService } from './admin-operations.service.js';

const PAGE = ADMIN_CONSOLE_RULES.pageSize;
const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

/** "2026-10-09T10:00:00.000Z|<id>" cursors for lists ordered newest first. */
const encodeCursor = (at: Date | string, id: string) => `${new Date(at).toISOString()}|${id}`;
function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split('|');
  const date = new Date(at ?? '');
  if (Number.isNaN(date.getTime()) || !id) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
  return { at: date, id };
}

type UserRow = { id: string; phone: string | null; name: string | null; username: string | null; status: UserStatus };
const userRef = (row: UserRow): AdminUserRef => ({ id: row.id, name: row.name, username: row.username, phone: row.phone, status: row.status });

/**
 * Phase 10 (D-44; spec §22): users, reported messages, the audit history, broadcasts and statistics in the Admin
 * Dashboard. O-18: admins see the reported message only (as reported and as it is now), never the chat around it,
 * and read the permanent history only for an investigation with a stated reason, each view recorded.
 */
@Injectable()
export class AdminConsoleService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(PushService) private readonly push: PushService,
    @Inject(UserPermissionsService) private readonly permissionsOfUsers: UserPermissionsService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
    @Inject(BroadcastsService) private readonly broadcasts: BroadcastsService,
    @Inject(AdminOperationsService) private readonly operations: AdminOperationsService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * Phase 14.4: the server's cloud region (AWS_REGION, set by the platform on every server function), the
   * database's region read from the Supabase pooler's host name (aws-0-ap-southeast-2.pooler.supabase.com), and the
   * time of one database round trip. No secret leaves: only region names and a number.
   */
  async speedCheck(): Promise<AdminSpeedCheck> {
    const times: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now();
      await sql`select 1`.execute(this.db);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const serverRegion = process.env.AWS_REGION?.trim() || null;
    let databaseRegion: string | null;
    try {
      databaseRegion = /^aws-\d+-([a-z]{2}-[a-z]+-\d)\.pooler\.supabase\.com$/.exec(new URL(this.env.DATABASE_URL).hostname)?.[1] ?? null;
    } catch {
      databaseRegion = null;
    }
    return {
      serverRegion,
      databaseRegion,
      databaseRoundTripMs: Math.round(times[1]! * 10) / 10,
      sameRegion: serverRegion && databaseRegion ? serverRegion === databaseRegion : null,
    };
  }

  private get db() {
    return this.database.db;
  }

  // --------------------------------------------------------------------------------------- users

  async users(query: { q?: string | undefined; status?: UserStatus | undefined; cursor?: string | undefined }) {
    const after = decodeCursor(query.cursor);
    const q = query.q?.trim();
    const digits = q?.replace(/[^\d]/g, '') ?? '';
    const rows = await this.db
      .selectFrom('app.users as u')
      .leftJoin('app.user_presence as p', 'p.user_id', 'u.id')
      .select(['u.id', 'u.phone', 'u.name', 'u.username', 'u.status', 'u.created_at', 'p.last_seen_at'])
      .$if(Boolean(q), (builder) =>
        builder.where((eb) =>
          eb.or([
            ...(digits.length >= 3 ? [eb('u.phone', 'like', `%${digits}%`)] : []),
            eb('u.name', 'ilike', likePattern(q!)),
            eb(sql<string>`u.username::text`, 'ilike', likePattern(q!.replace(/^@/, ''))),
          ]),
        ),
      )
      .$if(Boolean(query.status), (builder) => builder.where('u.status', '=', query.status!))
      .$if(after !== null, (builder) =>
        builder.where((eb) => eb.or([eb('u.created_at', '<', after!.at), eb.and([eb('u.created_at', '=', after!.at), eb('u.id', '<', after!.id)])])),
      )
      .orderBy('u.created_at', 'desc')
      .orderBy('u.id', 'desc')
      .limit(PAGE + 1)
      .execute();
    const page = rows.slice(0, PAGE);
    return {
      users: page.map(
        (row): AdminUserSummary => ({
          id: row.id,
          phone: row.phone,
          name: row.name,
          username: row.username,
          status: row.status,
          createdAt: iso(row.created_at)!,
          lastSeenAt: iso(row.last_seen_at),
        }),
      ),
      nextCursor: rows.length > PAGE ? encodeCursor(page.at(-1)!.created_at, page.at(-1)!.id) : null,
    };
  }

  async user(userId: string): Promise<AdminUserDetail> {
    const db = this.db;
    const row = await db
      .selectFrom('app.users as u')
      .leftJoin('app.user_presence as p', 'p.user_id', 'u.id')
      .select(['u.id', 'u.phone', 'u.name', 'u.username', 'u.bio', 'u.status', 'u.created_at', 'p.last_seen_at'])
      .where('u.id', '=', userId)
      .executeTakeFirst();
    if (!row) throw notFound();
    const [twoStep, permissions, sessions, counts, request, events] = await Promise.all([
      db.selectFrom('app.two_step').select('user_id').where('user_id', '=', userId).executeTakeFirst(),
      this.permissionsOfUsers.forUser(db, userId),
      db
        .selectFrom('app.sessions')
        .select(['id', 'device_name', 'platform', 'created_at', 'last_used_at', 'ip'])
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .orderBy('last_used_at', 'desc')
        .execute(),
      sql<{ groups: number; channels: number; messages: number; against: number; made: number }>`
        select
          (select count(*)::int from app.conversation_members m join app.conversations c on c.id = m.conversation_id and c.deleted_at is null
            where m.user_id = ${userId} and c.type = 'group') as groups,
          (select count(*)::int from app.conversation_members m join app.conversations c on c.id = m.conversation_id and c.deleted_at is null
            where m.user_id = ${userId} and c.type = 'channel') as channels,
          (select count(*)::int from app.messages where sender_id = ${userId}) as messages,
          (select count(*)::int from app.reports where reported_user_id = ${userId}) as against,
          (select count(*)::int from app.reports where reporter_id = ${userId}) as made
      `.execute(db),
      db.selectFrom('app.account_deletion_requests').select(['id', 'status', 'requested_at']).where('user_id', '=', userId).orderBy('requested_at', 'desc').limit(1).executeTakeFirst(),
      db.selectFrom('audit.account_events').select(['occurred_at', 'event', 'reason']).where('user_id', '=', userId).orderBy('occurred_at', 'desc').limit(50).execute(),
    ]);
    const count = counts.rows[0]!;
    return {
      user: { id: row.id, phone: row.phone, name: row.name, username: row.username, bio: row.bio, status: row.status, createdAt: iso(row.created_at)!, lastSeenAt: iso(row.last_seen_at) },
      twoStepEnabled: Boolean(twoStep),
      permissions,
      sessions: sessions.map((session) => ({
        id: session.id,
        deviceName: session.device_name,
        platform: session.platform,
        createdAt: iso(session.created_at)!,
        lastUsedAt: iso(session.last_used_at)!,
        ip: session.ip,
      })),
      counts: { groups: count.groups, channels: count.channels, messagesSent: count.messages, reportsAgainst: count.against, reportsMade: count.made },
      deletionRequest: request ? { id: request.id, status: request.status, requestedAt: iso(request.requested_at)! } : null,
      accountEvents: events.map((event) => ({ at: iso(event.occurred_at)!, event: event.event, detail: event.reason })),
    };
  }

  /** Suspend, ban, reactivate, end sessions or delete (who may do which is checked by the controller's roles). */
  async userAction(admin: AdminContext, userId: string, action: 'suspend' | 'ban' | 'reactivate' | 'end_sessions' | 'delete', reason: string, info: RequestInfo): Promise<AdminUserDetail> {
    // Moderators suspend, reactivate suspended accounts and end sessions; banning and deleting are for Super Admins.
    if ((action === 'ban' || action === 'delete') && admin.role !== 'super_admin') throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN');
    if (action === 'delete') {
      await this.operations.deleteUserByAdmin(admin, userId, reason, info);
      return this.user(userId);
    }
    const notice = await this.db.transaction().execute((trx) => this.applyUserAction(trx, admin, userId, action, reason, info));
    if (notice) {
      this.push.notify({ userId, excludeSessionId: null, notification: notice, ...(notice.subscriptions ? { subscriptions: notice.subscriptions } : {}) });
    }
    return this.user(userId);
  }

  private async applyUserAction(
    trx: Transaction<Database>,
    admin: AdminContext,
    userId: string,
    action: 'suspend' | 'ban' | 'reactivate' | 'end_sessions',
    reason: string,
    info: RequestInfo,
  ): Promise<{ title: string; body: string; tag: string; subscriptions?: Array<{ endpoint: string; p256dh: string; auth: string }> } | null> {
    const user = await trx.selectFrom('app.users').select(['id', 'status']).where('id', '=', userId).forUpdate().executeTakeFirst();
    if (!user) throw notFound();
    if (user.status === 'deleted') throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
    const actor: Actor = { type: 'admin', id: admin.adminId };
    let notice: { title: string; body: string; tag: string; subscriptions?: Array<{ endpoint: string; p256dh: string; auth: string }> } | null = null;
    if (action === 'suspend' || action === 'ban') {
      const status = action === 'suspend' ? 'suspended' : 'banned';
      if (user.status === status) throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      // The user is told on every device before the sessions end.
      const subscriptions = await trx.selectFrom('app.push_subscriptions').select(['endpoint', 'p256dh', 'auth']).where('user_id', '=', userId).execute();
      await trx.updateTable('app.users').set({ status }).where('id', '=', userId).execute();
      await this.audit.account(trx, { userId, event: status, actor, reason });
      const ended = await this.sessions.revokeAll(trx, userId, 'account_blocked');
      await this.audit.security(trx, { subjectType: 'user', subjectId: userId, event: 'sessions_ended_account_blocked', details: { count: ended.length, status } });
      notice = {
        title: action === 'suspend' ? 'Account suspended' : 'Account banned',
        body: action === 'suspend' ? 'An administrator suspended your Bedo Chat account. Contact the academy.' : 'An administrator banned your Bedo Chat account.',
        tag: 'account-status',
        subscriptions,
      };
    } else if (action === 'reactivate') {
      if (user.status !== 'suspended' && user.status !== 'banned') throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      if (user.status === 'banned' && admin.role !== 'super_admin') throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN');
      const pending = await trx.selectFrom('app.account_deletion_requests').select('id').where('user_id', '=', userId).where('status', '=', 'pending').executeTakeFirst();
      await trx.updateTable('app.users').set({ status: pending ? 'deletion_requested' : 'active' }).where('id', '=', userId).execute();
      await this.audit.account(trx, { userId, event: 'reactivated', actor, reason });
    } else {
      const ended = await this.sessions.revokeAll(trx, userId, 'ended_by_admin');
      await this.audit.security(trx, { subjectType: 'user', subjectId: userId, event: 'sessions_ended_by_admin', details: { count: ended.length, adminId: admin.adminId } });
    }
    await this.audit.admin(trx, { adminId: admin.adminId, action: `user.${action}`, targetType: 'user', targetId: userId, ip: info.ip, userAgent: info.userAgent, metadata: { reason } });
    return notice;
  }

  // ---------------------------------------------------------------------- who can create an account

  async accessSettings(): Promise<AdminAccessSettings> {
    const row = await this.db
      .selectFrom('app.access_settings as s')
      .leftJoin('app.admin_accounts as a', 'a.id', 's.updated_by')
      .select(['s.signup_mode', 's.updated_at', 'a.name'])
      .executeTakeFirstOrThrow();
    return { signupMode: row.signup_mode, updatedBy: row.name ?? null, updatedAt: iso(row.updated_at) };
  }

  /** D-47: recorded in the admin history with the previous mode. */
  async setSignupMode(admin: AdminContext, mode: SignupMode, info: RequestInfo): Promise<AdminAccessSettings> {
    await this.db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('app.access_settings').select('signup_mode').forUpdate().executeTakeFirstOrThrow();
      if (before.signup_mode === mode) return;
      await trx.updateTable('app.access_settings').set({ signup_mode: mode, updated_by: admin.adminId, updated_at: sql`now()` }).execute();
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'settings.signup_mode',
        targetType: 'setting',
        targetId: 'signup_mode',
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { from: before.signup_mode, to: mode },
      });
    });
    return this.accessSettings();
  }

  // ------------------------------------------------------------------------------------- reports

  async reports(status: 'open' | 'decided', cursor: string | undefined) {
    const after = decodeCursor(cursor);
    const rows = await this.db
      .selectFrom('app.reports as r')
      .leftJoin('app.report_decisions as d', 'd.report_id', 'r.id')
      .select(['r.id', 'r.created_at'])
      .$if(status === 'open', (builder) => builder.where('d.report_id', 'is', null))
      .$if(status === 'decided', (builder) => builder.where('d.report_id', 'is not', null))
      .$if(after !== null, (builder) =>
        builder.where((eb) => eb.or([eb('r.created_at', '<', after!.at), eb.and([eb('r.created_at', '=', after!.at), eb('r.id', '<', after!.id)])])),
      )
      .orderBy('r.created_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(PAGE + 1)
      .execute();
    const page = rows.slice(0, PAGE);
    return {
      reports: await this.reportViews(page.map((row) => row.id)),
      nextCursor: rows.length > PAGE ? encodeCursor(page.at(-1)!.created_at, page.at(-1)!.id) : null,
    };
  }

  private async reportViews(ids: readonly string[]): Promise<AdminReport[]> {
    if (ids.length === 0) return [];
    const db = this.db;
    const rows = await db
      .selectFrom('app.reports as r')
      .leftJoin('app.report_decisions as d', 'd.report_id', 'r.id')
      .leftJoin('app.admin_accounts as a', 'a.id', 'd.admin_id')
      .leftJoin('app.conversations as c', 'c.id', 'r.conversation_id')
      .leftJoin('app.messages as m', 'm.id', 'r.message_id')
      .leftJoin('app.files as f', 'f.id', 'm.file_id')
      .select([
        'r.id',
        'r.reason',
        'r.details',
        'r.created_at',
        'r.reporter_id',
        'r.reported_user_id',
        'r.conversation_id',
        'r.message_id',
        'r.message_text',
        'c.type as chat_type',
        'c.title as chat_title',
        'm.text as current_text',
        'm.kind as message_kind',
        'm.deleted_at as message_deleted_at',
        'm.removed_by_admin',
        'm.created_at as message_created_at',
        'f.kind as file_kind',
        'd.decision',
        'd.note',
        'd.decided_at',
        'a.name as admin_name',
        sql<number>`(select count(*)::int from app.reports o where o.reported_user_id = r.reported_user_id and o.id <> r.id)`.as('other_reports'),
      ])
      .where('r.id', 'in', [...ids])
      .execute();
    const userIds = [...new Set(rows.flatMap((row) => [row.reporter_id, row.reported_user_id]))];
    const users = new Map(
      (await db.selectFrom('app.users').select(['id', 'phone', 'name', 'username', 'status']).where('id', 'in', userIds).execute()).map((user) => [user.id, userRef(user)]),
    );
    const byId = new Map<string, AdminReport>(
      rows.map((row): [string, AdminReport] => [
        row.id,
        {
          id: row.id,
          reason: row.reason,
          details: row.details,
          createdAt: iso(row.created_at)!,
          reporter: users.get(row.reporter_id)!,
          reportedUser: users.get(row.reported_user_id)!,
          chat: row.conversation_id ? { id: row.conversation_id, type: row.chat_type ?? 'private', title: row.chat_title ?? null } : null,
          message:
            row.message_id && row.message_created_at
              ? {
                  id: row.message_id,
                  reportedText: row.message_text,
                  currentText: row.message_deleted_at ? null : row.current_text,
                  kind: row.message_kind ?? 'text',
                  attachmentKind: row.file_kind ?? null,
                  deleted: row.message_deleted_at !== null,
                  removedByAdmin: row.removed_by_admin !== null,
                  sentAt: iso(row.message_created_at)!,
                }
              : null,
          decision: row.decision ? { decision: row.decision, note: row.note, admin: row.admin_name ?? 'Admin', decidedAt: iso(row.decided_at)! } : null,
          otherReports: row.other_reports,
        },
      ]),
    );
    return ids.map((id) => byId.get(id)).filter((report): report is AdminReport => report !== undefined);
  }

  /**
   * Decide a report: dismiss it, remove the reported message for everyone (O-18: only a reported message), or suspend
   * or ban the reported user (banning: Super Admins). Recorded with the admin, never changed afterwards.
   */
  async decideReport(admin: AdminContext, reportId: string, decision: 'dismissed' | 'message_removed' | 'user_suspended' | 'user_banned', note: string | undefined, info: RequestInfo): Promise<AdminReport> {
    if (decision === 'user_banned' && admin.role !== 'super_admin') throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN');
    let notice: Awaited<ReturnType<AdminConsoleService['applyUserAction']>> = null;
    let reportedUserId = '';
    await this.updateLog.run(async (trx, updates) => {
      const report = await trx.selectFrom('app.reports').select(['id', 'reported_user_id', 'message_id', 'conversation_id']).where('id', '=', reportId).executeTakeFirst();
      if (!report) throw notFound();
      reportedUserId = report.reported_user_id;
      // The decision is recorded first: a second decision (even a concurrent one) finds it and changes nothing.
      const recorded = await trx
        .insertInto('app.report_decisions')
        .values({ report_id: reportId, admin_id: admin.adminId, decision, note: note ?? null })
        .onConflict((oc) => oc.column('report_id').doNothing())
        .returning('report_id')
        .executeTakeFirst();
      if (!recorded) throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      if (decision === 'message_removed') {
        if (!report.message_id) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
        await this.removeMessage(trx, updates, admin, report.message_id);
      }
      if (decision === 'user_suspended' || decision === 'user_banned') {
        const status = await trx.selectFrom('app.users').select('status').where('id', '=', report.reported_user_id).executeTakeFirstOrThrow();
        const wanted = decision === 'user_suspended' ? 'suspended' : 'banned';
        if (status.status !== wanted && status.status !== 'deleted') {
          notice = await this.applyUserAction(trx, admin, report.reported_user_id, decision === 'user_suspended' ? 'suspend' : 'ban', note ?? `Report ${reportId}`, info);
        }
      }
      await this.audit.admin(trx, { adminId: admin.adminId, action: `report.${decision}`, targetType: 'report', targetId: reportId, ip: info.ip, userAgent: info.userAgent, metadata: { note: note ?? null } });
    });
    const sent = notice as Awaited<ReturnType<AdminConsoleService['applyUserAction']>>;
    if (sent) {
      this.push.notify({ userId: reportedUserId, excludeSessionId: null, notification: { title: sent.title, body: sent.body, tag: sent.tag }, ...(sent.subscriptions ? { subscriptions: sent.subscriptions } : {}) });
    }
    return (await this.reportViews([reportId]))[0]!;
  }

  /** Removes one message for everyone, by an admin (recorded in the message history with the admin). */
  private async removeMessage(trx: Transaction<Database>, updates: Parameters<Parameters<UpdateLogService['run']>[0]>[1], admin: AdminContext, messageId: string): Promise<void> {
    const message = await trx
      .selectFrom('app.messages')
      .select(['id', 'conversation_id', 'sender_id', 'text', 'file_id', 'sticker_id', 'poll_id', 'deleted_at'])
      .where('id', '=', messageId)
      .forUpdate()
      .executeTakeFirst();
    if (!message) throw notFound();
    if (message.deleted_at !== null) return;
    await this.audit.messageRevision(trx, {
      messageId,
      conversationId: message.conversation_id,
      senderId: message.sender_id,
      action: 'deleted_for_both',
      previousText: message.text,
      fileId: message.file_id,
      stickerId: message.sticker_id,
      pollId: message.poll_id,
      actor: { type: 'admin', id: admin.adminId },
    });
    await trx.updateTable('app.messages').set({ text: null, deleted_at: sql`now()`, removed_by_admin: admin.adminId }).where('id', '=', messageId).execute();
    const members = await this.permissions.memberIds(trx, message.conversation_id);
    const hidden = new Set((await trx.selectFrom('app.message_hidden').select('user_id').where('message_id', '=', messageId).execute()).map((row) => row.user_id));
    const audience = members.filter((id) => !hidden.has(id));
    updates.addFor(audience, { kind: 'message.deleted', chatId: message.conversation_id, messageId });
    const unpinned = await trx.deleteFrom('app.message_pins').where('message_id', '=', messageId).executeTakeFirst();
    if (Number(unpinned.numDeletedRows) > 0) updates.addFor(audience, { kind: 'message.unpinned', chatId: message.conversation_id, messageId });
  }

  // --------------------------------------------------------------------------------- audit history

  /**
   * The permanent history for an investigation (D-17, D-18), Super Admins only. A person or a chat must be named
   * (the admin log can also be read as a whole), a reason given, and the view itself is recorded first.
   */
  async auditHistory(admin: AdminContext, query: { kind: AuditKind; userId?: string | undefined; chatId?: string | undefined; reason: string; cursor?: string | undefined }, info: RequestInfo) {
    if (query.kind !== 'admin' && !query.userId && !query.chatId) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    if ((query.kind === 'identity' || query.kind === 'account' || query.kind === 'security') && !query.userId) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    await this.audit.admin(this.db, {
      adminId: admin.adminId,
      action: 'audit.viewed',
      targetType: query.userId ? 'user' : query.chatId ? 'conversation' : null,
      targetId: query.userId ?? query.chatId ?? null,
      ip: info.ip,
      userAgent: info.userAgent,
      metadata: { kind: query.kind, userId: query.userId ?? null, chatId: query.chatId ?? null, reason: query.reason, cursor: query.cursor ?? null },
    });
    const before = query.cursor ? new Date(query.cursor) : null;
    if (before && Number.isNaN(before.getTime())) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    const db = this.db;
    const limit = PAGE + 1;
    const actor = (type: string, id: string | null) => (type === 'system' ? 'system' : `${type} ${id ?? ''}`.trim());
    let entries: Array<{ at: Date; event: string; actor: string | null; subject: string | null; detail: string | null }>;
    switch (query.kind) {
      case 'messages': {
        const rows = await db
          .selectFrom('audit.message_revisions')
          .selectAll()
          .$if(Boolean(query.userId), (b) => b.where('sender_id', '=', query.userId!))
          .$if(Boolean(query.chatId), (b) => b.where('conversation_id', '=', query.chatId!))
          .$if(before !== null, (b) => b.where('occurred_at', '<', before!))
          .orderBy('occurred_at', 'desc')
          .limit(limit)
          .execute();
        entries = rows.map((row) => ({
          at: row.occurred_at,
          event: `message ${row.action.replace(/_/g, ' ')}`,
          actor: actor(row.actor_type, row.actor_id),
          subject: `message ${row.message_id} (sender ${row.sender_id}) in chat ${row.conversation_id}`,
          detail: [row.previous_text !== null ? `before: ${row.previous_text}` : null, row.new_text !== null ? `after: ${row.new_text}` : null, row.file_id ? `file ${row.file_id}` : null]
            .filter(Boolean)
            .join(' · ') || null,
        }));
        break;
      }
      case 'identity': {
        const rows = await db
          .selectFrom('audit.identity_history')
          .selectAll()
          .where('user_id', '=', query.userId!)
          .$if(before !== null, (b) => b.where('changed_at', '<', before!))
          .orderBy('changed_at', 'desc')
          .limit(limit)
          .execute();
        entries = rows.map((row) => ({ at: row.changed_at, event: `${row.field} changed`, actor: actor(row.actor_type, row.actor_id), subject: `user ${row.user_id}`, detail: `${row.old_value ?? '(none)'} → ${row.new_value ?? '(none)'}` }));
        break;
      }
      case 'membership': {
        const rows = await db
          .selectFrom('audit.membership_events')
          .selectAll()
          .$if(Boolean(query.userId), (b) => b.where('user_id', '=', query.userId!))
          .$if(Boolean(query.chatId), (b) => b.where('conversation_id', '=', query.chatId!))
          .$if(before !== null, (b) => b.where('occurred_at', '<', before!))
          .orderBy('occurred_at', 'desc')
          .limit(limit)
          .execute();
        entries = rows.map((row) => ({
          at: row.occurred_at,
          event: row.action.replace(/_/g, ' '),
          actor: actor(row.actor_type, row.actor_id),
          subject: `user ${row.user_id} in chat ${row.conversation_id}`,
          detail: Object.keys(row.details ?? {}).length > 0 ? JSON.stringify(row.details) : null,
        }));
        break;
      }
      case 'account': {
        const rows = await db
          .selectFrom('audit.account_events')
          .selectAll()
          .where('user_id', '=', query.userId!)
          .$if(before !== null, (b) => b.where('occurred_at', '<', before!))
          .orderBy('occurred_at', 'desc')
          .limit(limit)
          .execute();
        entries = rows.map((row) => ({ at: row.occurred_at, event: row.event.replace(/_/g, ' '), actor: actor(row.actor_type, row.actor_id), subject: `user ${row.user_id}`, detail: row.reason }));
        break;
      }
      case 'security': {
        const rows = await db
          .selectFrom('audit.security_events')
          .selectAll()
          .where('subject_type', '=', 'user')
          .where('subject_id', '=', query.userId!)
          .$if(before !== null, (b) => b.where('occurred_at', '<', before!))
          .orderBy('occurred_at', 'desc')
          .limit(limit)
          .execute();
        entries = rows.map((row) => ({ at: row.occurred_at, event: row.event.replace(/_/g, ' '), actor: null, subject: `user ${row.subject_id}`, detail: [row.ip, row.user_agent].filter(Boolean).join(' · ') || null }));
        break;
      }
      case 'screenshots': {
        const rows = await db
          .selectFrom('audit.screenshot_events')
          .selectAll()
          .$if(Boolean(query.userId), (b) => b.where('user_id', '=', query.userId!))
          .$if(Boolean(query.chatId), (b) => b.where('conversation_id', '=', query.chatId!))
          .$if(before !== null, (b) => b.where('received_at', '<', before!))
          .orderBy('received_at', 'desc')
          .limit(limit)
          .execute();
        entries = rows.map((row) => ({
          at: row.received_at,
          event: `screenshot on ${row.platform}`,
          actor: `user ${row.user_id}`,
          subject: row.conversation_id ? `chat ${row.conversation_id}` : null,
          detail: [`screen ${row.screen}`, row.device_name, row.message_ids.length > 0 ? `messages ${row.message_ids.join(', ')}` : null].filter(Boolean).join(' · '),
        }));
        break;
      }
      case 'admin': {
        const rows = await db
          .selectFrom('app.audit_log as l')
          .leftJoin('app.admin_accounts as a', 'a.id', 'l.actor_id')
          .select(['l.occurred_at', 'l.action', 'l.actor_type', 'l.actor_id', 'l.target_type', 'l.target_id', 'l.metadata', 'a.name'])
          .where('l.actor_type', '=', 'admin')
          .$if(Boolean(query.userId || query.chatId), (b) => b.where('l.target_id', '=', (query.userId ?? query.chatId)!))
          .$if(before !== null, (b) => b.where('l.occurred_at', '<', before!))
          .orderBy('l.occurred_at', 'desc')
          .limit(limit)
          .execute();
        entries = rows.map((row) => ({
          at: row.occurred_at,
          event: row.action,
          actor: `admin ${row.name ?? row.actor_id ?? ''}`.trim(),
          subject: row.target_type ? `${row.target_type} ${row.target_id ?? ''}`.trim() : null,
          detail: Object.keys(row.metadata ?? {}).length > 0 ? JSON.stringify(row.metadata) : null,
        }));
        break;
      }
    }
    const page = entries.slice(0, PAGE);
    const names = await this.actorNames(page.map((entry) => entry.actor));
    return {
      entries: page.map((entry) => ({ ...entry, actor: entry.actor ? (names.get(entry.actor) ?? entry.actor) : null, at: iso(entry.at)! })),
      nextCursor: entries.length > PAGE ? iso(page.at(-1)!.at) : null,
    };
  }

  /** "admin <id>" becomes "admin <name>"; "user <id>" becomes "user <name> (<id>)", so investigators read names. */
  private async actorNames(actors: Array<string | null>): Promise<Map<string, string>> {
    const ids = { admin: new Set<string>(), user: new Set<string>() };
    for (const actor of actors) {
      const match = actor?.match(/^(admin|user) ([0-9a-f-]{36})$/);
      if (match) ids[match[1] as 'admin' | 'user'].add(match[2]!);
    }
    const names = new Map<string, string>();
    if (ids.admin.size > 0) {
      const rows = await this.db.selectFrom('app.admin_accounts').select(['id', 'name']).where('id', 'in', [...ids.admin]).execute();
      for (const row of rows) names.set(`admin ${row.id}`, `admin ${row.name}`);
    }
    if (ids.user.size > 0) {
      const rows = await this.db.selectFrom('app.users').select(['id', 'name']).where('id', 'in', [...ids.user]).execute();
      for (const row of rows) names.set(`user ${row.id}`, `user ${row.name ?? 'Deleted account'} (${row.id})`);
    }
    return names;
  }

  // ------------------------------------------------------------------------------------ broadcasts

  async createBroadcast(admin: AdminContext, body: { title: string; body: string; audience: 'all' | 'chat'; chatId?: string | undefined }, info: RequestInfo) {
    const id = await this.db.transaction().execute(async (trx) => {
      if (body.audience === 'chat') {
        const chat = await trx.selectFrom('app.conversations').select('id').where('id', '=', body.chatId!).where('type', 'in', ['group', 'channel']).where('deleted_at', 'is', null).executeTakeFirst();
        if (!chat) throw notFound();
      }
      const row = await trx
        .insertInto('app.broadcasts')
        .values({ admin_id: admin.adminId, title: body.title, body: body.body, audience: body.audience, conversation_id: body.audience === 'chat' ? body.chatId! : null })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.admin(trx, {
        adminId: admin.adminId,
        action: 'broadcast.sent',
        targetType: body.audience === 'chat' ? 'conversation' : 'all',
        targetId: body.chatId ?? null,
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { broadcastId: row.id, title: body.title, body: body.body },
      });
      return row.id;
    });
    this.broadcasts.kick();
    return (await this.listBroadcasts()).broadcasts.find((item) => item.id === id)!;
  }

  async listBroadcasts() {
    const rows = await this.db
      .selectFrom('app.broadcasts as b')
      .innerJoin('app.admin_accounts as a', 'a.id', 'b.admin_id')
      .leftJoin('app.conversations as c', 'c.id', 'b.conversation_id')
      .select(['b.id', 'b.title', 'b.body', 'b.audience', 'b.conversation_id', 'c.title as chat_title', 'b.status', 'b.devices', 'a.name as admin_name', 'b.created_at', 'b.finished_at'])
      .orderBy('b.created_at', 'desc')
      .limit(PAGE)
      .execute();
    return {
      broadcasts: rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        audience: row.audience,
        chat: row.conversation_id ? { id: row.conversation_id, title: row.chat_title } : null,
        status: row.status,
        devices: row.devices,
        admin: row.admin_name,
        createdAt: iso(row.created_at)!,
        finishedAt: iso(row.finished_at),
      })),
    };
  }

  // ------------------------------------------------------------------------------------ statistics

  async stats(): Promise<AdminStats> {
    const { rows } = await sql<Record<string, number>>`
      select
        (select count(*)::int from app.users) as users_total,
        (select count(*)::int from app.users where status = 'active') as users_active,
        (select count(*)::int from app.users where status = 'suspended') as users_suspended,
        (select count(*)::int from app.users where status = 'banned') as users_banned,
        (select count(*)::int from app.users where status = 'deletion_requested') as users_deletion,
        (select count(*)::int from app.users where status = 'deleted') as users_deleted,
        (select count(distinct user_id)::int from app.presence_devices where expires_at > now()) as online_now,
        (select count(*)::int from app.user_presence where last_seen_at > now() - interval '24 hours') as active_24h,
        (select count(*)::int from app.messages where created_at > now() - interval '24 hours') as messages_24h,
        (select count(*)::int from app.messages where created_at > now() - interval '7 days') as messages_7d,
        (select count(*)::int from app.conversations where type = 'group' and deleted_at is null) as groups,
        (select count(*)::int from app.conversations where type = 'channel' and deleted_at is null) as channels,
        (select count(*)::int from app.reports r where not exists (select 1 from app.report_decisions d where d.report_id = r.id)) as open_reports,
        (select count(*)::int from app.account_deletion_requests where status = 'pending') as pending_deletions,
        (select count(*)::int from app.sessions where revoked_at is null and expires_at > now()) as active_sessions,
        (select count(*)::int from app.push_subscriptions) as push_devices,
        (select count(*)::int from app.scheduled_messages where status in ('pending', 'sending')) as scheduled
    `.execute(this.db);
    const row = rows[0]!;
    return {
      users: { total: row.users_total!, active: row.users_active!, suspended: row.users_suspended!, banned: row.users_banned!, deletionRequested: row.users_deletion!, deleted: row.users_deleted! },
      onlineNow: row.online_now!,
      activeLast24h: row.active_24h!,
      messages: { last24h: row.messages_24h!, last7Days: row.messages_7d! },
      groups: row.groups!,
      channels: row.channels!,
      openReports: row.open_reports!,
      pendingDeletionRequests: row.pending_deletions!,
      activeSessions: row.active_sessions!,
      pushDevices: row.push_devices!,
      pendingScheduledMessages: row.scheduled!,
    };
  }
}
