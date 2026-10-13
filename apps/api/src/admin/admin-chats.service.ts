import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  ADMIN_CONSOLE_RULES,
  type AdminChatDetail,
  type AdminChatMember,
  type AdminRight,
  adminRightsFor,
  CHANNEL_RULES,
  GROUP_RULES,
  type MemberPermission,
} from '@bedo/contracts';
import type { Database } from '@bedo/db';
import { sql, type Transaction } from 'kysely';
import { type Actor, AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import type { RequestInfo } from '../common/request-info.js';
import { DatabaseService } from '../database/database.service.js';
import { NotificationsService } from '../messaging/notifications.service.js';
import { joinEveryoneChannels } from '../groups/everyone-channels.js';
import { likePattern } from '../messaging/messages.service.js';
import { type UpdateCollector, UpdateLogService } from '../messaging/update-log.service.js';
import type { AdminContext } from './admin-auth.service.js';

type ChatType = 'group' | 'channel';
const PAGE = ADMIN_CONSOLE_RULES.pageSize;
const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
const invalid = () => new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

/**
 * Phase 10 (D-44; spec §22 Groups and Channels): system admins create, edit and delete groups and channels and
 * manage their admins, members or subscribers, permissions and member privacy, as the owner could, with every change
 * in the membership history (actor: the admin) and the admin audit log, and announced to the members' devices like
 * their own changes. O-18: no messages are read here. A user always owns the chat (admins are not chat members).
 */
@Injectable()
export class AdminChatsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ------------------------------------------------------------------------------------------ reads

  async list(query: { type?: ChatType | undefined; q?: string | undefined; cursor?: string | undefined; id?: string }) {
    const after = query.cursor ? query.cursor.split('|') : null;
    const rows = await this.db
      .selectFrom('app.conversations as c')
      .select([
        'c.id',
        'c.type',
        'c.title',
        'c.is_public',
        'c.created_at',
        'c.last_message_at',
        'c.deleted_at',
        sql<number>`(select count(*)::int from app.conversation_members m where m.conversation_id = c.id)`.as('members'),
        sql<boolean>`coalesce((select s.academy_wide from app.group_settings s where s.conversation_id = c.id), false)`.as('everyone'),
        sql<string | null>`(select m.user_id::text from app.conversation_members m where m.conversation_id = c.id and m.role = 'owner')`.as('owner_id'),
      ])
      .where('c.type', 'in', query.type ? [query.type] : ['group', 'channel'])
      .$if(Boolean(query.id), (b) => b.where('c.id', '=', query.id!))
      .$if(Boolean(query.q), (b) => b.where('c.title', 'ilike', likePattern(query.q!)))
      .$if(after !== null, (b) =>
        b.where((eb) => eb.or([eb('c.created_at', '<', new Date(after![0]!)), eb.and([eb('c.created_at', '=', new Date(after![0]!)), eb('c.id', '<', after![1]!)])])),
      )
      .orderBy('c.created_at', 'desc')
      .orderBy('c.id', 'desc')
      .limit(PAGE + 1)
      .execute();
    const page = rows.slice(0, PAGE);
    const owners = await this.users(page.map((row) => row.owner_id).filter((id): id is string => id !== null));
    return {
      chats: page.map((row) => ({
        id: row.id,
        type: row.type as ChatType,
        title: row.title ?? '',
        public: row.is_public,
        everyone: row.type === 'channel' && row.everyone,
        memberCount: row.members,
        owner: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
        createdAt: iso(row.created_at)!,
        lastMessageAt: iso(row.last_message_at),
        deleted: row.deleted_at !== null,
      })),
      nextCursor: rows.length > PAGE ? `${new Date(page.at(-1)!.created_at).toISOString()}|${page.at(-1)!.id}` : null,
    };
  }

  private async users(ids: readonly string[]) {
    if (ids.length === 0) return new Map<string, AdminChatMember['user']>();
    const rows = await this.db.selectFrom('app.users').select(['id', 'name', 'username', 'phone', 'status']).where('id', 'in', [...new Set(ids)]).execute();
    return new Map(rows.map((row) => [row.id, { id: row.id, name: row.name, username: row.username, phone: row.phone, status: row.status }]));
  }

  private memberView(row: { user_id: string; role: string; admin_rights: string[]; denied_permissions: string[]; restricted_until: Date | null; joined_at: Date }, user: AdminChatMember['user']): AdminChatMember {
    return {
      user,
      role: row.role as AdminChatMember['role'],
      adminRights: row.admin_rights as AdminRight[],
      deniedPermissions: row.denied_permissions as MemberPermission[],
      restrictedUntil: iso(row.restricted_until),
      joinedAt: iso(row.joined_at)!,
    };
  }

  async detail(chatId: string): Promise<AdminChatDetail> {
    const { chats } = await this.list({ id: chatId });
    const chat = chats[0];
    if (!chat) throw notFound();
    const [row, settings, staff] = await Promise.all([
      this.db.selectFrom('app.conversations').select('description').where('id', '=', chatId).executeTakeFirstOrThrow(),
      this.db.selectFrom('app.group_settings').selectAll().where('conversation_id', '=', chatId).executeTakeFirst(),
      this.db.selectFrom('app.conversation_members').selectAll().where('conversation_id', '=', chatId).where('role', 'in', ['owner', 'admin']).orderBy('role', 'desc').execute(),
    ]);
    const users = await this.users(staff.map((member) => member.user_id));
    return {
      ...chat,
      description: row.description,
      settings: {
        defaultPermissions: (settings?.default_permissions ?? []) as MemberPermission[],
        hideMemberCount: settings?.hide_member_count ?? false,
        hideMemberList: settings?.hide_member_list ?? false,
      },
      admins: staff.filter((member) => users.has(member.user_id)).map((member) => this.memberView(member, users.get(member.user_id)!)),
    };
  }

  async members(chatId: string, after?: string) {
    await this.chatRow(this.db, chatId);
    const rows = await this.db
      .selectFrom('app.conversation_members')
      .select(['user_id', 'role', 'admin_rights', 'denied_permissions', 'restricted_until', 'joined_at'])
      .where('conversation_id', '=', chatId)
      .$if(Boolean(after), (b) => b.where('user_id', '>', after!))
      .orderBy('user_id')
      .limit(PAGE)
      .execute();
    const users = await this.users(rows.map((row) => row.user_id));
    return {
      members: rows.filter((row) => users.has(row.user_id)).map((row) => this.memberView(row, users.get(row.user_id)!)),
      nextAfter: rows.length === PAGE ? rows.at(-1)!.user_id : null,
    };
  }

  // ---------------------------------------------------------------------------------------- changes

  private async chatRow(db: Transaction<Database> | DatabaseService['db'], chatId: string) {
    const chat = await db.selectFrom('app.conversations').select(['id', 'type', 'title', 'deleted_at']).where('id', '=', chatId).where('type', 'in', ['group', 'channel']).executeTakeFirst();
    if (!chat) throw notFound();
    return { ...chat, type: chat.type as ChatType };
  }

  private async lockLive(trx: Transaction<Database>, chatId: string) {
    const chat = await trx.selectFrom('app.conversations').select(['id', 'type', 'deleted_at']).where('id', '=', chatId).where('type', 'in', ['group', 'channel']).forUpdate().executeTakeFirst();
    if (!chat) throw notFound();
    if (chat.deleted_at !== null) throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
    return { ...chat, type: chat.type as ChatType };
  }

  private async announce(trx: Transaction<Database>, updates: UpdateCollector, chatId: string, members: boolean): Promise<void> {
    const rows = await trx
      .selectFrom('app.conversation_members as m')
      .innerJoin('app.conversations as c', 'c.id', 'm.conversation_id')
      .leftJoin('app.group_settings as s', 's.conversation_id', 'm.conversation_id')
      .select(['m.user_id', 'm.role', 'c.type', 's.hide_member_list'])
      .where('m.conversation_id', '=', chatId)
      .execute();
    updates.addFor(
      rows.map((row) => row.user_id),
      { kind: 'chat.info', chatId },
    );
    if (members) {
      // §7 and D-40: membership changes only to those who may see the member list.
      const viewers = rows.filter((row) => row.role === 'owner' || row.role === 'admin' || (row.type === 'group' && !row.hide_member_list));
      updates.addFor(
        viewers.map((row) => row.user_id),
        { kind: 'chat.members', chatId },
      );
    }
  }

  private async record(trx: Transaction<Database>, admin: AdminContext, action: string, chatId: string, info: RequestInfo, metadata: Record<string, unknown>): Promise<void> {
    await this.audit.admin(trx, { adminId: admin.adminId, action, targetType: 'conversation', targetId: chatId, ip: info.ip, userAgent: info.userAgent, metadata });
  }

  async create(
    admin: AdminContext,
    body: { type: ChatType; title: string; description?: string | undefined; ownerUserId: string; isPublic: boolean; everyone?: boolean | undefined; memberIds: string[]; reason: string },
    info: RequestInfo,
  ): Promise<AdminChatDetail> {
    if (body.type === 'group' && (body.isPublic || body.everyone)) throw invalid();
    const everyone = body.type === 'channel' && body.everyone === true;
    const limit = body.type === 'channel' ? CHANNEL_RULES.maxSubscribers : GROUP_RULES.maxMembers;
    if (body.memberIds.length + 1 > limit) throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
    const actor: Actor = { type: 'admin', id: admin.adminId };
    const { chatId, added } = await this.updateLog.run(async (trx, updates) => {
      const people = await trx
        .selectFrom('app.users')
        .select(['id', 'status'])
        .where('id', 'in', [body.ownerUserId, ...body.memberIds])
        .where('status', 'in', ['active', 'deletion_requested'])
        .execute();
      const usable = new Set(people.map((row) => row.id));
      if (!usable.has(body.ownerUserId)) throw notFound();
      const chat = await trx
        .insertInto('app.conversations')
        .values({ type: body.type, title: body.title, description: body.description || null, is_public: body.type === 'channel' && body.isPublic, created_by: body.ownerUserId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.group_settings')
        .values({ conversation_id: chat.id, ...(body.type === 'channel' ? { default_permissions: [], academy_wide: everyone } : {}) })
        .execute();
      await trx.insertInto('app.conversation_members').values({ conversation_id: chat.id, user_id: body.ownerUserId, role: 'owner' }).execute();
      await this.audit.membership(trx, { conversationId: chat.id, userId: body.ownerUserId, action: 'created', actor, details: { title: body.title, byAdmin: true } });
      const members = body.memberIds.filter((id) => id !== body.ownerUserId && usable.has(id));
      if (members.length > 0) {
        await trx
          .insertInto('app.conversation_members')
          .values(members.map((userId) => ({ conversation_id: chat.id, user_id: userId, role: body.type === 'channel' ? ('subscriber' as const) : ('member' as const) })))
          .execute();
        for (const userId of members) await this.audit.membership(trx, { conversationId: chat.id, userId, action: 'added', actor });
      }
      // D-52: a channel for everyone gets every academy account now (no notification each; it shows in their list).
      const joined = everyone ? (await joinEveryoneChannels(trx, { chatId: chat.id }, actor)).map((row) => row.userId) : [];
      await this.record(trx, admin, `${body.type}.created`, chat.id, info, {
        title: body.title,
        ownerUserId: body.ownerUserId,
        members: members.length + joined.length,
        ...(everyone ? { everyone: true } : {}),
        reason: body.reason,
      });
      updates.addFor([body.ownerUserId, ...members, ...joined], { kind: 'chat.info', chatId: chat.id });
      return { chatId: chat.id, added: members };
    });
    this.notifications.addedToChat(chatId, [body.ownerUserId, ...added], null);
    return this.detail(chatId);
  }

  async update(
    admin: AdminContext,
    chatId: string,
    body: {
      title?: string | undefined;
      description?: string | undefined;
      isPublic?: boolean | undefined;
      everyone?: boolean | undefined;
      defaultPermissions?: MemberPermission[] | undefined;
      hideMemberCount?: boolean | undefined;
      hideMemberList?: boolean | undefined;
      reason: string;
    },
    info: RequestInfo,
  ): Promise<AdminChatDetail> {
    await this.updateLog.run(async (trx, updates) => {
      const chat = await this.lockLive(trx, chatId);
      const groupOnly = body.defaultPermissions !== undefined || body.hideMemberCount !== undefined || body.hideMemberList !== undefined;
      if ((chat.type === 'channel' && groupOnly) || (chat.type === 'group' && (body.isPublic !== undefined || body.everyone !== undefined))) throw invalid();
      if (body.title !== undefined || body.description !== undefined || body.isPublic !== undefined) {
        await trx
          .updateTable('app.conversations')
          .set({
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.description !== undefined ? { description: body.description || null } : {}),
            ...(body.isPublic !== undefined ? { is_public: body.isPublic } : {}),
          })
          .where('id', '=', chatId)
          .execute();
      }
      if (groupOnly) {
        await trx
          .updateTable('app.group_settings')
          .set({
            ...(body.defaultPermissions !== undefined ? { default_permissions: body.defaultPermissions } : {}),
            ...(body.hideMemberCount !== undefined ? { hide_member_count: body.hideMemberCount } : {}),
            ...(body.hideMemberList !== undefined ? { hide_member_list: body.hideMemberList } : {}),
          })
          .where('conversation_id', '=', chatId)
          .execute();
      }
      let joined: string[] = [];
      if (body.everyone !== undefined) {
        await trx.updateTable('app.group_settings').set({ academy_wide: body.everyone }).where('conversation_id', '=', chatId).execute();
        // D-52: turning it on adds every academy account now; turning it off removes nobody.
        if (body.everyone) joined = (await joinEveryoneChannels(trx, { chatId }, { type: 'admin', id: admin.adminId })).map((row) => row.userId);
      }
      const { reason, ...change } = body;
      await this.record(trx, admin, `${chat.type}.updated`, chatId, info, { change, ...(joined.length > 0 ? { joined: joined.length } : {}), reason });
      await this.announce(trx, updates, chatId, joined.length > 0);
    });
    return this.detail(chatId);
  }

  /** Deletes the chat for everyone; its messages stay in the history (D-17). */
  async remove(admin: AdminContext, chatId: string, reason: string, info: RequestInfo): Promise<AdminChatDetail> {
    await this.updateLog.run(async (trx, updates) => {
      const chat = await this.lockLive(trx, chatId);
      const members = await trx.selectFrom('app.conversation_members').select('user_id').where('conversation_id', '=', chatId).execute();
      await trx.updateTable('app.conversations').set({ deleted_at: sql`now()` }).where('id', '=', chatId).execute();
      await this.record(trx, admin, `${chat.type}.deleted`, chatId, info, { reason, members: members.length });
      updates.addFor(
        members.map((row) => row.user_id),
        { kind: 'chat.removed', chatId },
      );
    });
    return this.detail(chatId);
  }

  async addMembers(admin: AdminContext, chatId: string, userIds: string[], reason: string, info: RequestInfo) {
    const actor: Actor = { type: 'admin', id: admin.adminId };
    const added = await this.updateLog.run(async (trx, updates) => {
      const chat = await this.lockLive(trx, chatId);
      const usable = (await trx.selectFrom('app.users').select('id').where('id', 'in', userIds).where('status', 'in', ['active', 'deletion_requested']).execute()).map((row) => row.id);
      const count = await trx.selectFrom('app.conversation_members').select(sql<number>`count(*)::int`.as('n')).where('conversation_id', '=', chatId).executeTakeFirstOrThrow();
      if (count.n + usable.length > (chat.type === 'channel' ? CHANNEL_RULES.maxSubscribers : GROUP_RULES.maxMembers)) throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
      const inserted = usable.length
        ? await trx
            .insertInto('app.conversation_members')
            .values(usable.map((userId) => ({ conversation_id: chatId, user_id: userId, role: chat.type === 'channel' ? ('subscriber' as const) : ('member' as const) })))
            .onConflict((conflict) => conflict.columns(['conversation_id', 'user_id']).doNothing())
            .returning('user_id')
            .execute()
        : [];
      const ids = inserted.map((row) => row.user_id);
      for (const userId of ids) await this.audit.membership(trx, { conversationId: chatId, userId, action: 'added', actor });
      if (ids.length > 0) {
        // An admin adding someone removed earlier lets them back in (D-43).
        await trx.deleteFrom('app.chat_bans').where('conversation_id', '=', chatId).where('user_id', 'in', ids).execute();
        updates.addFor(ids, { kind: 'chat.info', chatId });
        await this.announce(trx, updates, chatId, true);
      }
      await this.record(trx, admin, 'chat.members_added', chatId, info, { userIds: ids, reason });
      return ids;
    });
    this.notifications.addedToChat(chatId, added, null);
    return { added, notAdded: userIds.filter((id) => !added.includes(id)) };
  }

  async removeMember(admin: AdminContext, chatId: string, userId: string, reason: string, info: RequestInfo): Promise<void> {
    await this.updateLog.run(async (trx, updates) => {
      await this.lockLive(trx, chatId);
      const target = await trx.selectFrom('app.conversation_members').select('role').where('conversation_id', '=', chatId).where('user_id', '=', userId).forUpdate().executeTakeFirst();
      if (!target) throw notFound();
      // The owner hands the chat over first (or the chat is deleted).
      if (target.role === 'owner') throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      await trx.deleteFrom('app.conversation_members').where('conversation_id', '=', chatId).where('user_id', '=', userId).execute();
      await trx
        .insertInto('app.chat_bans')
        .values({ conversation_id: chatId, user_id: userId, banned_by: null, banned_by_admin: admin.adminId })
        .onConflict((conflict) => conflict.columns(['conversation_id', 'user_id']).doNothing())
        .execute();
      await this.audit.membership(trx, { conversationId: chatId, userId, action: 'removed', actor: { type: 'admin', id: admin.adminId }, details: { reason } });
      await this.record(trx, admin, 'chat.member_removed', chatId, info, { userId, reason });
      updates.add({ userId, kind: 'chat.removed', chatId });
      await this.announce(trx, updates, chatId, true);
    });
  }

  async updateMember(
    admin: AdminContext,
    chatId: string,
    userId: string,
    body: { role?: 'owner' | 'admin' | 'member' | undefined; adminRights?: AdminRight[] | undefined; deniedPermissions?: MemberPermission[] | undefined; restrictedUntil?: string | null | undefined; reason: string },
    info: RequestInfo,
  ): Promise<AdminChatMember> {
    const actor: Actor = { type: 'admin', id: admin.adminId };
    await this.updateLog.run(async (trx, updates) => {
      const chat = await this.lockLive(trx, chatId);
      const target = await trx.selectFrom('app.conversation_members').selectAll().where('conversation_id', '=', chatId).where('user_id', '=', userId).forUpdate().executeTakeFirst();
      if (!target) throw notFound();
      const applicable = adminRightsFor(chat.type);
      if (body.role === 'owner') {
        if (target.role === 'owner') return;
        await trx
          .updateTable('app.conversation_members')
          .set({ role: 'admin', admin_rights: applicable })
          .where('conversation_id', '=', chatId)
          .where('role', '=', 'owner')
          .execute();
        await trx.updateTable('app.conversation_members').set({ role: 'owner', admin_rights: [], denied_permissions: [], restricted_until: null }).where('conversation_id', '=', chatId).where('user_id', '=', userId).execute();
        await this.audit.membership(trx, { conversationId: chatId, userId, action: 'ownership_received', actor, details: { byAdmin: true } });
      } else if (body.role !== undefined || body.adminRights !== undefined) {
        if (target.role === 'owner') throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
        const role = body.role === 'member' ? (chat.type === 'channel' ? 'subscriber' : 'member') : (body.role ?? target.role);
        const rights = role === 'admin' ? (body.adminRights ?? (target.role === 'admin' ? (target.admin_rights as AdminRight[]) : applicable.filter((right) => right !== 'manage_admins'))) : [];
        if (rights.some((right) => !applicable.includes(right))) throw invalid();
        await trx
          .updateTable('app.conversation_members')
          .set({ role, admin_rights: rights, ...(role === 'admin' ? { denied_permissions: [], restricted_until: null } : {}) })
          .where('conversation_id', '=', chatId)
          .where('user_id', '=', userId)
          .execute();
        await this.audit.membership(trx, { conversationId: chatId, userId, action: target.role !== role ? (role === 'admin' ? 'promoted' : 'demoted') : 'rights_changed', actor, details: { rights } });
      }
      if (body.deniedPermissions !== undefined || body.restrictedUntil !== undefined) {
        if (chat.type === 'channel' || body.role === 'admin' || body.role === 'owner' || (body.role === undefined && target.role !== 'member')) throw invalid();
        const denied = body.deniedPermissions ?? (target.denied_permissions as MemberPermission[]);
        const until = body.restrictedUntil === undefined ? target.restricted_until : body.restrictedUntil === null ? null : new Date(body.restrictedUntil);
        await trx
          .updateTable('app.conversation_members')
          .set({ denied_permissions: denied, restricted_until: denied.length > 0 ? until : null })
          .where('conversation_id', '=', chatId)
          .where('user_id', '=', userId)
          .execute();
        await this.audit.membership(trx, { conversationId: chatId, userId, action: denied.length > 0 ? 'restricted' : 'unrestricted', actor, details: { denied } });
      }
      const { reason, ...change } = body;
      await this.record(trx, admin, 'chat.member_updated', chatId, info, { userId, change, reason });
      updates.add({ userId, kind: 'chat.info', chatId });
      await this.announce(trx, updates, chatId, true);
    });
    const row = await this.db.selectFrom('app.conversation_members').selectAll().where('conversation_id', '=', chatId).where('user_id', '=', userId).executeTakeFirstOrThrow();
    return this.memberView(row, (await this.users([userId])).get(userId)!);
  }
}
