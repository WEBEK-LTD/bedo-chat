import { randomBytes, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type AdminRight,
  adminRightsFor,
  CHANNEL_RULES,
  type Chat,
  GROUP_RULES,
  type GroupMembersResponse,
  type InviteLink,
  type InvitePreview,
  type MemberPermission,
  type PhotoUploadResponse,
  PROFILE_RULES,
  type PublicChannel,
  type PublicUser,
  type UserPermissions,
} from '@bedo/contracts';
import type { Database } from '@bedo/db';
import { sql, type Transaction } from 'kysely';
import { type Actor, AuditService, type Executor } from '../audit/audit.service.js';
import { AccountsService } from '../auth/accounts.service.js';
import type { AuthContext } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { hashToken, randomToken } from '../common/crypto.js';
import { DatabaseService } from '../database/database.service.js';
import { ChatsService } from '../messaging/chats.service.js';
import { likePattern } from '../messaging/messages.service.js';
import { MessagingLimitsService } from '../messaging/messaging-limits.service.js';
import { type ChatAccess, PermissionService } from '../messaging/permissions.service.js';
import { type UpdateCollector, UpdateLogService } from '../messaging/update-log.service.js';
import { EphemeralStore } from '../state/ephemeral.store.js';
import { detectImageType, ProfilePhotoStorage } from '../storage/profile-photo-storage.js';
import { NotificationsService } from '../messaging/notifications.service.js';
import { UserPermissionsService } from './user-permissions.service.js';

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
const notAllowed = () => new AppError(HttpStatus.FORBIDDEN, 'NOT_ALLOWED');
const PHOTO_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
const UPLOAD_TTL_MS = 15 * 60 * 1000;

interface InviteRow {
  id: string;
  conversation_id: string;
  code: string;
  name: string | null;
  created_at: Date;
  expires_at: Date | null;
  usage_limit: number | null;
  usage_count: number;
  requires_approval: boolean;
  revoked_at: Date | null;
}

type CommunityType = 'group' | 'channel';
/** Members of a group, subscribers of a channel (D-40). */
const memberRoleOf = (type: CommunityType) => (type === 'channel' ? ('subscriber' as const) : ('member' as const));
const memberLimitOf = (type: CommunityType) => (type === 'channel' ? CHANNEL_RULES.maxSubscribers : GROUP_RULES.maxMembers);
/** Rights a new admin gets by default (when the request names none): those the promoting admin holds. */
const DEFAULT_ADMIN_RIGHTS: Record<CommunityType, readonly AdminRight[]> = {
  group: ['change_info', 'delete_messages', 'restrict_members', 'invite_users', 'approve_requests', 'pin_messages'],
  channel: ['change_info', 'post_messages', 'delete_messages', 'invite_users', 'approve_requests', 'pin_messages'],
};
const invalid = () => new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');

const linkUsable = (link: InviteRow): boolean =>
  link.revoked_at === null && (link.expires_at === null || new Date(link.expires_at).getTime() > Date.now()) && (link.usage_limit === null || link.usage_count < link.usage_limit);

/**
 * Groups (Phase 5, D-39) and channels (Phase 6, D-40, the same model with subscribers): creating, editing, member management with roles, admin rights and restrictions, member
 * privacy (§7), invite links and join requests, leaving and deleting. Every change is checked by the permission
 * service, recorded in the membership history when it concerns membership (D-17), and announced through the update
 * log: membership changes only to members who may see the member list.
 */
@Injectable()
export class GroupsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
    @Inject(EphemeralStore) private readonly store: EphemeralStore,
    @Inject(ProfilePhotoStorage) private readonly photos: ProfilePhotoStorage,
    @Inject(UserPermissionsService) private readonly systemPermissions: UserPermissionsService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ------------------------------------------------------------------------------------ helpers

  /** The viewer's access to a group or channel (a private chat is not one: 404). */
  private async groupAccess(db: Executor, viewerId: string, groupId: string): Promise<ChatAccess & { type: CommunityType }> {
    const access = await this.permissions.chatAccess(db, viewerId, groupId);
    if (access.type === 'private') {
      throw notFound();
    }
    return access as ChatAccess & { type: CommunityType };
  }

  /** Locks the group row: membership changes of one group run one at a time (size limit, single owner). */
  private async lockGroup(trx: Transaction<Database>, groupId: string): Promise<void> {
    await trx.selectFrom('app.conversations').select('id').where('id', '=', groupId).forUpdate().executeTakeFirst();
  }

  private async memberCount(db: Executor, groupId: string): Promise<number> {
    const row = await db.selectFrom('app.conversation_members').select(sql<number>`count(*)::int`.as('n')).where('conversation_id', '=', groupId).executeTakeFirstOrThrow();
    return row.n;
  }

  /** Tells every member the group changed (their devices fetch its summary). */
  private async announceInfo(trx: Executor, updates: UpdateCollector, access: ChatAccess): Promise<void> {
    updates.addFor(await this.permissions.memberIds(trx, access.conversationId), { kind: 'chat.info', chatId: access.conversationId });
  }

  /** Tells the members allowed to see the member list that it changed (§7: nobody else hears of joins and leaves). */
  private async announceMembers(trx: Executor, updates: UpdateCollector, access: ChatAccess): Promise<void> {
    updates.addFor(await this.permissions.memberListViewers(trx, access), { kind: 'chat.members', chatId: access.conversationId });
  }

  /** Which of `userIds` the actor may put into a group: existing accounts that would accept a message from them. */
  private async addable(db: Executor, actorId: string, userIds: readonly string[]): Promise<Set<string>> {
    const [status, relations] = await Promise.all([this.permissions.userStatus(db, actorId), this.permissions.relations(db, actorId, userIds)]);
    const result = new Set<string>();
    if (!status) return result;
    for (const [userId, relation] of relations) {
      if (userId !== actorId && this.permissions.sendDecision(status, relation).allowed) {
        result.add(userId);
      }
    }
    return result;
  }

  private async insertMembers(
    trx: Transaction<Database>,
    groupId: string,
    userIds: readonly string[],
    action: 'added' | 'joined',
    actor: Actor,
    details: Record<string, unknown> = {},
    type: CommunityType = 'group',
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const inserted = await trx
      .insertInto('app.conversation_members')
      .values(userIds.map((userId) => ({ conversation_id: groupId, user_id: userId, role: memberRoleOf(type) })))
      .onConflict((conflict) => conflict.columns(['conversation_id', 'user_id']).doNothing())
      .returning('user_id')
      .execute();
    for (const row of inserted) {
      await this.audit.membership(trx, { conversationId: groupId, userId: row.user_id, action, actor, details });
    }
    return inserted.map((row) => row.user_id);
  }

  /** Group members, by id and in pages of 50, for members allowed to see them (checked again by the database). */
  private async publicUsers(db: Executor, viewerId: string, userIds: readonly string[]): Promise<Map<string, PublicUser>> {
    const relations = await this.permissions.relations(db, viewerId, userIds);
    const result = new Map<string, PublicUser>();
    for (const [userId, relation] of relations) {
      const base = await this.accounts.toPublicUser(relation.user, { photoVisible: false });
      result.set(userId, { ...base, photoUrl: this.permissions.visibilities(relation).photo && !base.deleted ? await this.accounts.photoUrl(relation.user.photo_key) : null });
    }
    return result;
  }

  // ------------------------------------------------------------------------------- permissions

  userPermissions(db: Executor, userId: string): Promise<UserPermissions> {
    return this.systemPermissions.forUser(db, userId);
  }

  // ------------------------------------------------------------------------------------- create

  async create(auth: AuthContext, body: { title: string; description?: string | undefined; memberIds: string[] }): Promise<Chat> {
    const db = this.db;
    if (!(await this.userPermissions(db, auth.userId)).createGroups) {
      throw notAllowed();
    }
    const status = await this.permissions.userStatus(db, auth.userId);
    if (status !== 'active' && status !== 'deletion_requested') {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
    }
    await this.limits.groupsCreated(auth.userId);
    const addable = await this.addable(db, auth.userId, body.memberIds);
    const groupId = await this.updateLog.run(async (trx, updates) => {
      const group = await trx
        .insertInto('app.conversations')
        .values({ type: 'group', title: body.title, description: body.description || null, created_by: auth.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('app.group_settings').values({ conversation_id: group.id }).execute();
      await trx.insertInto('app.conversation_members').values({ conversation_id: group.id, user_id: auth.userId, role: 'owner' }).execute();
      const actor: Actor = { type: 'user', id: auth.userId };
      await this.audit.membership(trx, { conversationId: group.id, userId: auth.userId, action: 'created', actor, details: { title: body.title } });
      const members = await this.insertMembers(trx, group.id, body.memberIds.filter((id) => addable.has(id)), 'added', actor);
      updates.addFor([auth.userId, ...members], { kind: 'chat.info', chatId: group.id });
      return { id: group.id, members };
    }).then(({ id, members }) => {
      this.notifications.addedToChat(id, members, auth.userId);
      return id;
    });
    return this.chats.get(auth.userId, groupId);
  }

  // ------------------------------------------------------------------------------------ channels

  /** Phase 6: a channel, with its creator as owner (system permission "create channels", O-21). */
  async createChannel(auth: AuthContext, body: { title: string; description?: string | undefined; isPublic: boolean }): Promise<Chat> {
    const db = this.db;
    if (!(await this.userPermissions(db, auth.userId)).createChannels) {
      throw notAllowed();
    }
    const status = await this.permissions.userStatus(db, auth.userId);
    if (status !== 'active' && status !== 'deletion_requested') {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
    }
    await this.limits.channelsCreated(auth.userId);
    const channelId = await this.updateLog.run(async (trx, updates) => {
      const channel = await trx
        .insertInto('app.conversations')
        .values({ type: 'channel', title: body.title, description: body.description || null, is_public: body.isPublic, created_by: auth.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      // Channels keep no member permissions: subscribers read, react and leave (D-40).
      await trx.insertInto('app.group_settings').values({ conversation_id: channel.id, default_permissions: [] }).execute();
      await trx.insertInto('app.conversation_members').values({ conversation_id: channel.id, user_id: auth.userId, role: 'owner' }).execute();
      await this.audit.membership(trx, { conversationId: channel.id, userId: auth.userId, action: 'created', actor: { type: 'user', id: auth.userId }, details: { title: body.title, channel: true } });
      updates.add({ userId: auth.userId, kind: 'chat.info', chatId: channel.id });
      return channel.id;
    });
    return this.chats.get(auth.userId, channelId);
  }

  /** Public channels whose title matches (O-22): any signed-in academy user may search them. */
  async searchChannels(viewerId: string, q: string): Promise<PublicChannel[]> {
    await this.limits.channelSearches(viewerId);
    const db = this.db;
    const rows = await db
      .selectFrom('app.conversations as c')
      .select([
        'c.id',
        'c.title',
        'c.description',
        'c.photo_key',
        sql<number>`(select count(*)::int from app.conversation_members m where m.conversation_id = c.id)`.as('subscribers'),
        sql<boolean>`exists (select 1 from app.conversation_members m where m.conversation_id = c.id and m.user_id = ${viewerId})`.as('subscribed'),
      ])
      .where('c.type', '=', 'channel')
      .where('c.is_public', '=', true)
      .where('c.deleted_at', 'is', null)
      .where('c.title', 'ilike', likePattern(q))
      // Titles that start with the words first, then alphabetical.
      .orderBy(sql`strpos(lower(c.title), lower(${q}))`)
      .orderBy('c.title')
      .orderBy('c.id')
      .limit(CHANNEL_RULES.searchResults)
      .execute();
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        title: row.title ?? '',
        description: row.description,
        photoUrl: await this.accounts.photoUrl(row.photo_key),
        subscriberCount: row.subscribers,
        subscribed: row.subscribed,
      })),
    );
  }

  /** Subscribe to a public channel (O-22). A private channel, a group, or no such chat: 404. */
  async joinChannel(auth: AuthContext, channelId: string): Promise<Chat> {
    await this.limits.groupActions(auth.userId);
    const status = await this.permissions.userStatus(this.db, auth.userId);
    if (status !== 'active' && status !== 'deletion_requested') throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
    await this.updateLog.run(async (trx, updates) => {
      const channel = await trx
        .selectFrom('app.conversations')
        .select('id')
        .where('id', '=', channelId)
        .where('type', '=', 'channel')
        .where('is_public', '=', true)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!channel) throw notFound();
      if (await this.permissions.findChatAccess(trx, auth.userId, channelId)) return;
      await this.assertNotBanned(trx, channelId, auth.userId);
      if ((await this.memberCount(trx, channelId)) >= CHANNEL_RULES.maxSubscribers) throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
      await this.insertMembers(trx, channelId, [auth.userId], 'joined', { type: 'user', id: auth.userId }, { public: true }, 'channel');
      updates.add({ userId: auth.userId, kind: 'chat.info', chatId: channelId });
      await this.announceMembers(trx, updates, await this.permissions.chatAccess(trx, auth.userId, channelId));
    });
    return this.chats.get(auth.userId, channelId);
  }

  // ---------------------------------------------------------------------------------- info, settings

  async update(auth: AuthContext, groupId: string, body: { title?: string | undefined; description?: string | undefined }): Promise<Chat> {
    await this.limits.groupActions(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.groupAccess(trx, auth.userId, groupId);
      if (!this.permissions.may(access, 'change_info', 'change_info')) {
        throw notAllowed();
      }
      await trx
        .updateTable('app.conversations')
        .set({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description || null } : {}),
        })
        .where('id', '=', groupId)
        .execute();
      await this.announceInfo(trx, updates, access);
    });
    return this.chats.get(auth.userId, groupId);
  }

  async updateSettings(
    auth: AuthContext,
    groupId: string,
    body: { defaultPermissions?: MemberPermission[] | undefined; hideMemberCount?: boolean | undefined; hideMemberList?: boolean | undefined; isPublic?: boolean | undefined },
  ): Promise<Chat> {
    await this.limits.groupActions(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.groupAccess(trx, auth.userId, groupId);
      const groupOnly = body.defaultPermissions !== undefined || body.hideMemberCount !== undefined || body.hideMemberList !== undefined;
      // Channels have no member permissions or member privacy switches (subscribers never see the list); only
      // channels are public or private.
      if ((access.type === 'channel' && groupOnly) || (access.type === 'group' && body.isPublic !== undefined)) {
        throw invalid();
      }
      if (body.isPublic !== undefined) {
        this.permissions.assertRight(access, 'change_info');
        await trx.updateTable('app.conversations').set({ is_public: body.isPublic }).where('id', '=', groupId).execute();
      }
      if (!groupOnly) {
        await this.announceInfo(trx, updates, access);
        return;
      }
      // Member permissions: admins who restrict members. Member privacy (O-04): admins with that right.
      if (body.defaultPermissions !== undefined) this.permissions.assertRight(access, 'restrict_members');
      if (body.hideMemberCount !== undefined || body.hideMemberList !== undefined) this.permissions.assertRight(access, 'change_privacy');
      await trx
        .updateTable('app.group_settings')
        .set({
          ...(body.defaultPermissions !== undefined ? { default_permissions: body.defaultPermissions } : {}),
          ...(body.hideMemberCount !== undefined ? { hide_member_count: body.hideMemberCount } : {}),
          ...(body.hideMemberList !== undefined ? { hide_member_list: body.hideMemberList } : {}),
        })
        .where('conversation_id', '=', groupId)
        .execute();
      await this.announceInfo(trx, updates, access);
    });
    return this.chats.get(auth.userId, groupId);
  }

  async startPhotoUpload(auth: AuthContext, groupId: string, contentType: keyof typeof PHOTO_EXTENSIONS): Promise<PhotoUploadResponse> {
    await this.limits.groupActions(auth.userId);
    const access = await this.groupAccess(this.db, auth.userId, groupId);
    if (!this.permissions.may(access, 'change_info', 'change_info')) throw notAllowed();
    if (!this.photos.enabled) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
    const key = `groups/${groupId}/${randomUUID()}.${PHOTO_EXTENSIONS[contentType]}`;
    const upload = await this.photos.createUpload(key, contentType);
    const uploadId = randomToken();
    await this.store.set(`group-photo:${hashToken(uploadId)}`, JSON.stringify({ userId: auth.userId, groupId, key }), UPLOAD_TTL_MS);
    return { uploadId, uploadUrl: upload.url, method: 'PUT', headers: upload.headers };
  }

  async confirmPhoto(auth: AuthContext, groupId: string, uploadId: string): Promise<Chat> {
    const raw = await this.store.take(`group-photo:${hashToken(uploadId)}`);
    const pending = raw ? (JSON.parse(raw) as { userId: string; groupId: string; key: string }) : null;
    if (!pending || pending.userId !== auth.userId || pending.groupId !== groupId) throw notFound();
    const stored = await this.photos.read(pending.key);
    if (!stored || stored.size > PROFILE_RULES.photoMaxBytes || !detectImageType(stored.head)) {
      if (stored) await this.photos.remove(pending.key);
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    return this.setPhoto(auth, groupId, pending.key);
  }

  async setPhoto(auth: AuthContext, groupId: string, key: string | null): Promise<Chat> {
    // Phase 9: a new picture notifies every member's devices.
    await this.limits.groupActions(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.groupAccess(trx, auth.userId, groupId);
      if (!this.permissions.may(access, 'change_info', 'change_info')) throw notAllowed();
      await trx.updateTable('app.conversations').set({ photo_key: key }).where('id', '=', groupId).execute();
      await this.announceInfo(trx, updates, access);
    });
    return this.chats.get(auth.userId, groupId);
  }

  // -------------------------------------------------------------------------------------- members

  async members(viewerId: string, groupId: string, after?: string): Promise<GroupMembersResponse> {
    const db = this.db;
    const access = await this.groupAccess(db, viewerId, groupId);
    if (!this.permissions.canViewMembers(access, 'list')) {
      throw notAllowed();
    }
    // The database checks the caller again and refuses if the list is hidden from them (§7).
    const { rows } = await sql<{ user_id: string; role: 'owner' | 'admin' | 'member' | 'subscriber'; admin_rights: string[]; denied_permissions: string[]; restricted_until: Date | null; joined_at: Date }>`
      select * from app.group_members(${viewerId}, ${groupId}, ${after ?? null}, ${GROUP_RULES.membersPageSize})
    `.execute(db);
    const users = await this.publicUsers(db, viewerId, rows.map((row) => row.user_id));
    const count = this.permissions.canViewMembers(access, 'count')
      ? Number((await sql<{ n: number }>`select app.group_member_count(${viewerId}, ${groupId}) as n`.execute(db)).rows[0]?.n ?? 0)
      : null;
    return {
      members: rows
        .filter((row) => users.has(row.user_id))
        .map((row) => ({
          user: users.get(row.user_id)!,
          role: row.role,
          adminRights: row.role === 'owner' ? [] : (row.admin_rights as AdminRight[]),
          deniedPermissions: row.denied_permissions as MemberPermission[],
          restrictedUntil: row.restricted_until ? new Date(row.restricted_until).toISOString() : null,
          joinedAt: new Date(row.joined_at).toISOString(),
        })),
      count,
      nextAfter: rows.length === GROUP_RULES.membersPageSize ? rows[rows.length - 1]!.user_id : null,
    };
  }

  async addMembers(auth: AuthContext, groupId: string, userIds: string[]): Promise<{ added: string[]; notAdded: string[] }> {
    await this.limits.groupActions(auth.userId);
    const addable = await this.addable(this.db, auth.userId, userIds);
    const { inserted, reported } = await this.updateLog.run(async (trx, updates) => {
      const access = await this.groupAccess(trx, auth.userId, groupId);
      if (!this.permissions.may(access, 'add_members', 'invite_users')) throw notAllowed();
      await this.lockGroup(trx, groupId);
      // Phase 9: someone an admin removed comes back only when an admin (right "invite users") adds them; a member
      // adding people cannot undo a removal.
      const banned = new Set(
        (await trx.selectFrom('app.chat_bans').select('user_id').where('conversation_id', '=', groupId).where('user_id', 'in', userIds).execute()).map((row) => row.user_id),
      );
      const mayUnban = this.permissions.hasRight(access, 'invite_users');
      const candidates = userIds.filter((id) => addable.has(id) && (mayUnban || !banned.has(id)));
      const present = new Set(
        candidates.length > 0
          ? (await trx.selectFrom('app.conversation_members').select('user_id').where('conversation_id', '=', groupId).where('user_id', 'in', candidates).execute()).map((row) => row.user_id)
          : [],
      );
      if ((await this.memberCount(trx, groupId)) + candidates.filter((id) => !present.has(id)).length > memberLimitOf(access.type)) {
        throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
      }
      const added = await this.insertMembers(trx, groupId, candidates, 'added', { type: 'user', id: auth.userId }, {}, access.type);
      if (added.length > 0) await trx.deleteFrom('app.chat_bans').where('conversation_id', '=', groupId).where('user_id', 'in', added).execute();
      if (added.length > 0) {
        updates.addFor(added, { kind: 'chat.info', chatId: groupId });
        await this.announceMembers(trx, updates, access);
      }
      // §7: someone who may not see the member list must not learn who was already in it, so people already in the
      // group are reported as added too.
      // Likewise someone removed earlier is reported as added (they are not), so the answer does not tell who was removed.
      const seesList = this.permissions.canViewMembers(access, 'list');
      return { inserted: added, reported: seesList ? added : userIds.filter((id) => addable.has(id)) };
    });
    this.notifications.addedToChat(groupId, inserted, auth.userId);
    const addedSet = new Set(reported);
    return { added: reported, notAdded: userIds.filter((id) => !addedSet.has(id)) };
  }

  /** Phase 9: someone an admin removed does not come back without an admin (by link, request or public join). */
  private async assertNotBanned(db: Executor, groupId: string, userId: string): Promise<void> {
    const ban = await db.selectFrom('app.chat_bans').select('user_id').where('conversation_id', '=', groupId).where('user_id', '=', userId).executeTakeFirst();
    if (ban) throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ALLOWED');
  }

  /** The member row of `userId` in the group, locked. */
  private async targetMember(trx: Transaction<Database>, groupId: string, userId: string) {
    const row = await trx.selectFrom('app.conversation_members').selectAll().where('conversation_id', '=', groupId).where('user_id', '=', userId).forUpdate().executeTakeFirst();
    if (!row) throw notFound();
    return row;
  }

  async removeMember(auth: AuthContext, groupId: string, userId: string): Promise<void> {
    if (userId === auth.userId) {
      return this.leave(auth, groupId);
    }
    await this.limits.groupActions(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.groupAccess(trx, auth.userId, groupId);
      this.permissions.assertRight(access, 'restrict_members');
      await this.lockGroup(trx, groupId);
      const target = await this.targetMember(trx, groupId, userId);
      if (target.role === 'owner' || (target.role === 'admin' && !this.permissions.hasRight(access, 'manage_admins'))) throw notAllowed();
      await trx.deleteFrom('app.conversation_members').where('conversation_id', '=', groupId).where('user_id', '=', userId).execute();
      // Phase 9: a removed member cannot come back by link, request or (public channels) by joining; an admin may add
      // them again. A request they made before is declined.
      await trx
        .updateTable('app.join_requests')
        .set({ status: 'declined', decided_by: auth.userId, decided_at: sql`now()` })
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', userId)
        .where('status', '=', 'pending')
        .execute();
      await trx
        .insertInto('app.chat_bans')
        .values({ conversation_id: groupId, user_id: userId, banned_by: auth.userId })
        .onConflict((conflict) => conflict.columns(['conversation_id', 'user_id']).doNothing())
        .execute();
      await this.audit.membership(trx, { conversationId: groupId, userId, action: 'removed', actor: { type: 'user', id: auth.userId } });
      updates.add({ userId, kind: 'chat.removed', chatId: groupId });
      await this.announceMembers(trx, updates, access);
    });
  }

  async updateMember(
    auth: AuthContext,
    groupId: string,
    userId: string,
    body: { role?: 'admin' | 'member' | undefined; adminRights?: AdminRight[] | undefined; deniedPermissions?: MemberPermission[] | undefined; restrictedUntil?: string | null | undefined },
  ): Promise<void> {
    if (userId === auth.userId) throw notAllowed();
    await this.limits.groupActions(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.groupAccess(trx, auth.userId, groupId);
      // Phase 9: the rights first, so someone without them cannot learn who is a member from the answer (§7, D-40).
      if (access.type === 'channel' && (body.deniedPermissions !== undefined || body.restrictedUntil !== undefined)) throw invalid();
      if (body.role !== undefined || body.adminRights !== undefined) this.permissions.assertRight(access, 'manage_admins');
      if (body.deniedPermissions !== undefined || body.restrictedUntil !== undefined) this.permissions.assertRight(access, 'restrict_members');
      await this.lockGroup(trx, groupId);
      const target = await this.targetMember(trx, groupId, userId);
      if (target.role === 'owner') throw notAllowed();
      const actor: Actor = { type: 'user', id: auth.userId };
      const promoting = body.role === 'admin' || (body.adminRights !== undefined && (body.role ?? target.role) === 'admin');
      if (access.type === 'channel' && (body.deniedPermissions !== undefined || body.restrictedUntil !== undefined)) {
        // Subscribers cannot post anyway: channels have no restrictions (remove a subscriber instead).
        throw invalid();
      }
      if (body.role !== undefined || body.adminRights !== undefined) {
        this.permissions.assertRight(access, 'manage_admins');
        // "member" in a channel: a subscriber again.
        const role = body.role === 'member' ? memberRoleOf(access.type) : (body.role ?? target.role);
        // An admin gives only rights they hold themselves (the owner holds all).
        const rights =
          role === 'admin'
            ? (body.adminRights ?? (target.role === 'admin' ? (target.admin_rights as AdminRight[]) : DEFAULT_ADMIN_RIGHTS[access.type].filter((right) => access.adminRights.has(right))))
            : [];
        // Rights of the other kind of chat (posting in a group, member privacy in a channel) do not exist there.
        if (rights.some((right) => !adminRightsFor(access.type).includes(right as AdminRight))) throw invalid();
        if (rights.some((right) => !access.adminRights.has(right as AdminRight))) throw notAllowed();
        await trx
          .updateTable('app.conversation_members')
          .set({ role, admin_rights: rights, ...(role === 'admin' ? { denied_permissions: [], restricted_until: null } : {}) })
          .where('conversation_id', '=', groupId)
          .where('user_id', '=', userId)
          .execute();
        const action = target.role !== role ? (role === 'admin' ? 'promoted' : 'demoted') : 'rights_changed';
        await this.audit.membership(trx, { conversationId: groupId, userId, action, actor, details: { rights } });
      }
      if (body.deniedPermissions !== undefined || body.restrictedUntil !== undefined) {
        this.permissions.assertRight(access, 'restrict_members');
        if (promoting || (body.role === undefined && target.role === 'admin')) throw notAllowed();
        const denied = body.deniedPermissions ?? (target.denied_permissions as MemberPermission[]);
        const until = body.restrictedUntil === undefined ? target.restricted_until : body.restrictedUntil === null ? null : new Date(body.restrictedUntil);
        await trx
          .updateTable('app.conversation_members')
          .set({ denied_permissions: denied, restricted_until: denied.length > 0 ? until : null })
          .where('conversation_id', '=', groupId)
          .where('user_id', '=', userId)
          .execute();
        await this.audit.membership(trx, {
          conversationId: groupId,
          userId,
          action: denied.length > 0 ? 'restricted' : 'unrestricted',
          actor,
          details: { denied, until: denied.length > 0 && until ? new Date(until).toISOString() : null },
        });
      }
      updates.add({ userId, kind: 'chat.info', chatId: groupId });
      await this.announceMembers(trx, updates, access);
    });
  }

  async transferOwnership(auth: AuthContext, groupId: string, userId: string): Promise<Chat> {
    if (userId === auth.userId) throw notAllowed();
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.groupAccess(trx, auth.userId, groupId);
      if (access.role !== 'owner') throw notAllowed();
      await this.lockGroup(trx, groupId);
      await this.targetMember(trx, groupId, userId);
      await trx
        .updateTable('app.conversation_members')
        .set({ role: 'admin', admin_rights: adminRightsFor(access.type) })
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', auth.userId)
        .execute();
      await trx
        .updateTable('app.conversation_members')
        .set({ role: 'owner', admin_rights: [], denied_permissions: [], restricted_until: null })
        .where('conversation_id', '=', groupId)
        .where('user_id', '=', userId)
        .execute();
      const actor: Actor = { type: 'user', id: auth.userId };
      await this.audit.membership(trx, { conversationId: groupId, userId: auth.userId, action: 'ownership_given', actor, details: { to: userId } });
      await this.audit.membership(trx, { conversationId: groupId, userId, action: 'ownership_received', actor, details: { from: auth.userId } });
      updates.addFor([auth.userId, userId], { kind: 'chat.info', chatId: groupId });
      await this.announceMembers(trx, updates, access);
    });
    return this.chats.get(auth.userId, groupId);
  }

  /** Leaving. The owner first gives the group to another member (or, alone in it, the group is deleted). */
  async leave(auth: AuthContext, groupId: string): Promise<void> {
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.groupAccess(trx, auth.userId, groupId);
      await this.lockGroup(trx, groupId);
      if (access.role === 'owner') {
        if ((await this.memberCount(trx, groupId)) > 1) {
          throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
        }
        await trx.updateTable('app.conversations').set({ deleted_at: sql`now()` }).where('id', '=', groupId).execute();
      }
      await trx.deleteFrom('app.conversation_members').where('conversation_id', '=', groupId).where('user_id', '=', auth.userId).execute();
      await this.audit.membership(trx, { conversationId: groupId, userId: auth.userId, action: 'left', actor: { type: 'user', id: auth.userId } });
      updates.add({ userId: auth.userId, kind: 'chat.removed', chatId: groupId });
      await this.announceMembers(trx, updates, access);
    });
  }

  /** Deleting a group (owner): nobody can open it any more; its messages stay in the history. */
  async deleteGroup(auth: AuthContext, groupId: string): Promise<void> {
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.groupAccess(trx, auth.userId, groupId);
      if (access.role !== 'owner') throw notAllowed();
      const members = await this.permissions.memberIds(trx, groupId);
      await trx.updateTable('app.conversations').set({ deleted_at: sql`now()` }).where('id', '=', groupId).execute();
      await this.audit.membership(trx, { conversationId: groupId, userId: auth.userId, action: 'left', actor: { type: 'user', id: auth.userId }, details: { groupDeleted: true } });
      updates.addFor(members, { kind: 'chat.removed', chatId: groupId });
    });
  }

  // --------------------------------------------------------------------------------- invite links

  private linkView(link: InviteRow): InviteLink {
    return {
      id: link.id,
      code: link.code,
      name: link.name,
      createdAt: new Date(link.created_at).toISOString(),
      expiresAt: link.expires_at ? new Date(link.expires_at).toISOString() : null,
      usageLimit: link.usage_limit,
      usageCount: link.usage_count,
      requiresApproval: link.requires_approval,
      revoked: link.revoked_at !== null,
    };
  }

  async inviteLinks(viewerId: string, groupId: string): Promise<InviteLink[]> {
    const access = await this.groupAccess(this.db, viewerId, groupId);
    this.permissions.assertRight(access, 'invite_users');
    const rows = await this.db.selectFrom('app.invite_links').selectAll().where('conversation_id', '=', groupId).orderBy('created_at', 'desc').limit(100).execute();
    return rows.map((row) => this.linkView(row));
  }

  async createInviteLink(auth: AuthContext, groupId: string, body: { name?: string | undefined; expiresAt?: string | undefined; usageLimit?: number | undefined; requiresApproval: boolean }): Promise<InviteLink> {
    await this.limits.groupActions(auth.userId);
    const access = await this.groupAccess(this.db, auth.userId, groupId);
    this.permissions.assertRight(access, 'invite_users');
    const active = await this.db
      .selectFrom('app.invite_links')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('conversation_id', '=', groupId)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (active.n >= GROUP_RULES.maxInviteLinks) throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
    const row = await this.db
      .insertInto('app.invite_links')
      .values({
        conversation_id: groupId,
        code: randomBytes(16).toString('base64url'),
        name: body.name ?? null,
        created_by: auth.userId,
        expires_at: body.expiresAt ? new Date(body.expiresAt) : null,
        usage_limit: body.usageLimit ?? null,
        requires_approval: body.requiresApproval,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.linkView(row);
  }

  /** Phase 15: an admin who may invite switches approval on or off for a link; the link itself stays the same. */
  async updateInviteLink(auth: AuthContext, groupId: string, linkId: string, requiresApproval: boolean): Promise<InviteLink> {
    await this.limits.groupActions(auth.userId);
    const access = await this.groupAccess(this.db, auth.userId, groupId);
    this.permissions.assertRight(access, 'invite_users');
    const row = await this.db
      .updateTable('app.invite_links')
      .set({ requires_approval: requiresApproval })
      .where('id', '=', linkId)
      .where('conversation_id', '=', groupId)
      .where('revoked_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw notFound();
    return this.linkView(row);
  }

  async revokeInviteLink(auth: AuthContext, groupId: string, linkId: string): Promise<InviteLink[]> {
    const access = await this.groupAccess(this.db, auth.userId, groupId);
    this.permissions.assertRight(access, 'invite_users');
    await this.db.updateTable('app.invite_links').set({ revoked_at: sql`coalesce(revoked_at, now())` }).where('id', '=', linkId).where('conversation_id', '=', groupId).execute();
    return this.inviteLinks(auth.userId, groupId);
  }

  private async usableLink(db: Executor, code: string): Promise<InviteRow & { type: CommunityType; title: string; description: string | null; photo_key: string | null }> {
    const row = await db
      .selectFrom('app.invite_links as l')
      .innerJoin('app.conversations as c', 'c.id', 'l.conversation_id')
      .selectAll('l')
      .select(['c.type', 'c.title', 'c.description', 'c.photo_key'])
      .where('l.code', '=', code)
      .where('c.deleted_at', 'is', null)
      .where('c.type', 'in', ['group', 'channel'])
      .executeTakeFirst();
    if (!row || !linkUsable(row)) throw notFound();
    return { ...row, type: row.type as CommunityType, title: row.title ?? '' };
  }

  async preview(viewerId: string, code: string): Promise<InvitePreview> {
    await this.limits.groupActions(viewerId);
    const db = this.db;
    const link = await this.usableLink(db, code);
    const membership = await this.permissions.findChatAccess(db, viewerId, link.conversation_id);
    const settings = await db.selectFrom('app.group_settings').select('hide_member_count').where('conversation_id', '=', link.conversation_id).executeTakeFirst();
    const pending = await db
      .selectFrom('app.join_requests')
      .select('id')
      .where('conversation_id', '=', link.conversation_id)
      .where('user_id', '=', viewerId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return {
      type: link.type,
      title: link.title,
      description: link.description,
      photoUrl: await this.accounts.photoUrl(link.photo_key),
      // §7: the count on a link preview only when the group shows it to members (a channel always shows it).
      memberCount: link.type === 'group' && settings?.hide_member_count ? null : await this.memberCount(db, link.conversation_id),
      requiresApproval: link.requires_approval,
      chatId: membership ? link.conversation_id : null,
      requested: pending !== undefined,
    };
  }

  /** The members who may approve join requests: the owner and admins with that right. */
  private async approvers(db: Executor, groupId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('app.conversation_members')
      .select('user_id')
      .where('conversation_id', '=', groupId)
      .where((eb) => eb.or([eb('role', '=', 'owner'), eb.and([eb('role', '=', 'admin'), eb(sql`'approve_requests' = any(admin_rights)`, '=', sql`true`)])]))
      .execute();
    return rows.map((row) => row.user_id);
  }

  async join(auth: AuthContext, code: string): Promise<{ status: 'joined' | 'requested'; chatId: string | null }> {
    await this.limits.groupActions(auth.userId);
    const status = await this.permissions.userStatus(this.db, auth.userId);
    if (status !== 'active' && status !== 'deletion_requested') throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
    return this.updateLog.run(async (trx, updates) => {
      const link = await this.usableLink(trx, code);
      const groupId = link.conversation_id;
      await this.lockGroup(trx, groupId);
      if (await this.permissions.findChatAccess(trx, auth.userId, groupId)) {
        return { status: 'joined' as const, chatId: groupId };
      }
      await this.assertNotBanned(trx, groupId, auth.userId);
      if (link.requires_approval) {
        await trx
          .insertInto('app.join_requests')
          .values({ conversation_id: groupId, user_id: auth.userId, invite_link_id: link.id })
          .onConflict((conflict) => conflict.columns(['conversation_id', 'user_id']).where('status', '=', 'pending').doNothing())
          .execute();
        updates.addFor(await this.approvers(trx, groupId), { kind: 'chat.info', chatId: groupId });
        return { status: 'requested' as const, chatId: null };
      }
      if ((await this.memberCount(trx, groupId)) >= memberLimitOf(link.type)) throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
      const counted = await trx
        .updateTable('app.invite_links')
        .set({ usage_count: sql`usage_count + 1` })
        .where('id', '=', link.id)
        .where((eb) => eb.or([eb('usage_limit', 'is', null), eb('usage_count', '<', eb.ref('usage_limit'))]))
        .executeTakeFirst();
      if (Number(counted.numUpdatedRows) === 0) throw notFound();
      await this.insertMembers(trx, groupId, [auth.userId], 'joined', { type: 'user', id: auth.userId }, { inviteLinkId: link.id }, link.type);
      updates.add({ userId: auth.userId, kind: 'chat.info', chatId: groupId });
      const access = await this.permissions.chatAccess(trx, auth.userId, groupId);
      await this.announceMembers(trx, updates, access);
      return { status: 'joined' as const, chatId: groupId };
    });
  }

  async joinRequests(viewerId: string, groupId: string) {
    const access = await this.groupAccess(this.db, viewerId, groupId);
    this.permissions.assertRight(access, 'approve_requests');
    const rows = await this.db
      .selectFrom('app.join_requests')
      .select(['id', 'user_id', 'requested_at'])
      .where('conversation_id', '=', groupId)
      .where('status', '=', 'pending')
      .orderBy('requested_at')
      .limit(200)
      .execute();
    const users = await this.publicUsers(this.db, viewerId, rows.map((row) => row.user_id));
    return rows.filter((row) => users.has(row.user_id)).map((row) => ({ id: row.id, user: users.get(row.user_id)!, requestedAt: new Date(row.requested_at).toISOString() }));
  }

  async decideRequest(auth: AuthContext, groupId: string, requestId: string, approve: boolean) {
    await this.limits.groupActions(auth.userId);
    let approvedUser: string | null = null;
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.groupAccess(trx, auth.userId, groupId);
      this.permissions.assertRight(access, 'approve_requests');
      await this.lockGroup(trx, groupId);
      const request = await trx
        .selectFrom('app.join_requests')
        .selectAll()
        .where('id', '=', requestId)
        .where('conversation_id', '=', groupId)
        .where('status', '=', 'pending')
        .forUpdate()
        .executeTakeFirst();
      if (!request) throw notFound();
      const actor: Actor = { type: 'user', id: auth.userId };
      if (approve && (await this.memberCount(trx, groupId)) >= memberLimitOf(access.type)) throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
      await trx
        .updateTable('app.join_requests')
        .set({ status: approve ? 'approved' : 'declined', decided_by: auth.userId, decided_at: sql`now()` })
        .where('id', '=', requestId)
        .execute();
      await this.audit.membership(trx, { conversationId: groupId, userId: request.user_id, action: approve ? 'request_approved' : 'request_declined', actor });
      if (approve) {
        await this.insertMembers(trx, groupId, [request.user_id], 'joined', actor, { requestId }, access.type);
        approvedUser = request.user_id;
        updates.add({ userId: request.user_id, kind: 'chat.info', chatId: groupId });
        await this.announceMembers(trx, updates, access);
      }
      // Phase 15: every admin who approves sees the waiting count go down, not only the one who decided.
      updates.addFor(new Set([auth.userId, ...(await this.approvers(trx, groupId))]), { kind: 'chat.info', chatId: groupId });
    });
    if (approvedUser) this.notifications.addedToChat(groupId, [approvedUser], auth.userId);
    return this.joinRequests(auth.userId, groupId);
  }
}
