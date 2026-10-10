import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { type AdminRight, adminRightsFor, MEMBER_PERMISSIONS, type MemberPermission } from '@bedo/contracts';
import type { MemberRole, UserStatus, Visibility } from '@bedo/db';
import { sql } from 'kysely';
import type { Executor } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';

/** Everything a permission decision about another user needs, seen from one viewer. */
export interface Relation {
  user: {
    id: string;
    status: UserStatus;
    name: string | null;
    username: string | null;
    bio: string | null;
    photo_key: string | null;
    phone: string | null;
  };
  privacy: {
    phone: Visibility;
    lastSeen: Visibility;
    photo: Visibility;
    messagesFrom: Visibility;
  };
  /** The viewer blocked this user. */
  blockedByViewer: boolean;
  /** This user blocked the viewer. */
  blockedViewer: boolean;
}

export interface Visibilities {
  photo: boolean;
  phone: boolean;
  /** Last seen and online status (P-31: hidden together). */
  presence: boolean;
}

export type SendDecision = { allowed: true } | { allowed: false; code: 'CANNOT_MESSAGE' | 'USER_BLOCKED' | 'ACCOUNT_BLOCKED' };

/** Account states that may send (P-26: suspended and banned users cannot; deleted accounts are read-only). */
const SENDING_STATUSES: ReadonlySet<UserStatus> = new Set(['active', 'deletion_requested']);

export type ChatType = 'private' | 'group' | 'channel';

/**
 * A member's access to one chat as the permission service sees it (Phase 5: private chats and groups; Phase 6:
 * channels). For a group, `permissions` are what this member may do now: everything for the owner and admins,
 * otherwise the group's defaults minus an active restriction. In a channel only the owner and admins with the right to
 * post may post; subscribers read and react (D-40).
 */
export interface ChatAccess {
  conversationId: string;
  type: ChatType;
  /** Channels: anyone in the academy finds and joins it. */
  isPublic: boolean;
  /** The other participant of a private chat; null in groups. */
  peerId: string | null;
  role: MemberRole;
  adminRights: ReadonlySet<AdminRight>;
  permissions: ReadonlySet<MemberPermission>;
  restricted: boolean;
  restrictedUntil: Date | null;
  defaultPermissions: readonly MemberPermission[];
  hideMemberCount: boolean;
  hideMemberList: boolean;
}

/** @deprecated name kept for older call sites. */
export type PrivateChatAccess = ChatAccess;

/** What a message carries, for the group permission it needs (Phase 5). */
export type PostKind = 'text' | 'media' | 'sticker' | 'poll';
const POST_PERMISSION: Record<PostKind, MemberPermission | null> = { text: null, media: 'send_media', sticker: 'send_stickers', poll: 'send_polls' };

/** What a channel admin who may post (and the owner) may do; subscribers have none of it. */
const CHANNEL_POSTING: readonly MemberPermission[] = ['send_messages', 'send_media', 'send_stickers', 'send_polls'];

interface AccessRow {
  conversation_id: string;
  type: ChatType;
  is_public: boolean;
  role: MemberRole;
  admin_rights: string[];
  denied_permissions: string[];
  restricted_until: Date | null;
  default_permissions: string[] | null;
  hide_member_count: boolean | null;
  hide_member_list: boolean | null;
  peer_id: string | null;
}

export function accessFromRow(row: AccessRow, now = Date.now()): ChatAccess {
  const role = row.role;
  const staff = role === 'owner' || role === 'admin';
  const restricted = row.denied_permissions.length > 0 && (row.restricted_until === null || new Date(row.restricted_until).getTime() > now);
  const defaults = (row.default_permissions ?? []).filter((item): item is MemberPermission => (MEMBER_PERMISSIONS as readonly string[]).includes(item));
  const applicable = adminRightsFor(row.type);
  const adminRights =
    role === 'owner'
      ? new Set<AdminRight>(applicable)
      : new Set<AdminRight>(row.admin_rights.filter((item): item is AdminRight => (applicable as readonly string[]).includes(item)));
  let permissions: Set<MemberPermission>;
  if (row.type === 'channel') {
    permissions = new Set<MemberPermission>(staff && adminRights.has('post_messages') ? CHANNEL_POSTING : []);
  } else if (row.type === 'private' || staff) {
    permissions = new Set<MemberPermission>(MEMBER_PERMISSIONS);
  } else {
    permissions = new Set<MemberPermission>(defaults.filter((item) => !restricted || !row.denied_permissions.includes(item)));
  }
  const channel = row.type === 'channel';
  return {
    conversationId: row.conversation_id,
    type: row.type,
    isPublic: channel && row.is_public,
    peerId: row.type === 'private' ? row.peer_id : null,
    role,
    adminRights: staff ? adminRights : new Set(),
    permissions,
    restricted: !staff && !channel && restricted,
    restrictedUntil: !staff && !channel && restricted ? row.restricted_until : null,
    defaultPermissions: defaults,
    hideMemberCount: row.hide_member_count ?? false,
    hideMemberList: row.hide_member_list ?? false,
  };
}

/**
 * The one permission service for messaging (blueprint: Security, permissions; D-07). HTTP routes, the
 * realtime signals and user search all ask it, so a rule is written once:
 *  - membership: only members see or change a conversation;
 *  - sending: the sender's account may send, the recipient is not deleted, neither has blocked the other
 *    and the recipient accepts messages (P-26, P-30);
 *  - views of another user: blocks and photo, phone and last-seen privacy (P-31) decide what is shown.
 */
@Injectable()
export class PermissionService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  get db() {
    return this.database.db;
  }

  /** Relations from `viewerId` to each of `userIds` (unknown ids are left out). */
  async relations(db: Executor, viewerId: string, userIds: readonly string[]): Promise<Map<string, Relation>> {
    const ids = [...new Set(userIds)];
    const result = new Map<string, Relation>();
    if (ids.length === 0) {
      return result;
    }
    const rows = await db
      .selectFrom('app.users as u')
      .leftJoin('app.user_privacy as p', 'p.user_id', 'u.id')
      .select([
        'u.id',
        'u.status',
        'u.name',
        'u.username',
        'u.bio',
        'u.photo_key',
        'u.phone',
        'p.phone_visibility',
        'p.last_seen_visibility',
        'p.photo_visibility',
        'p.messages_from',
        sql<boolean>`exists (select 1 from app.blocks b where b.blocker_id = ${viewerId} and b.blocked_id = u.id)`.as('blocked_by_viewer'),
        sql<boolean>`exists (select 1 from app.blocks b where b.blocker_id = u.id and b.blocked_id = ${viewerId})`.as('blocked_viewer'),
      ])
      .where('u.id', 'in', ids)
      .execute();
    for (const row of rows) {
      result.set(row.id, {
        user: {
          id: row.id,
          status: row.status,
          name: row.name,
          username: row.username,
          bio: row.bio,
          photo_key: row.photo_key,
          phone: row.phone,
        },
        // Defaults match the Phase 2 privacy defaults for an account without a privacy row.
        privacy: {
          phone: row.phone_visibility ?? 'nobody',
          lastSeen: row.last_seen_visibility ?? 'everyone',
          photo: row.photo_visibility ?? 'everyone',
          messagesFrom: row.messages_from ?? 'everyone',
        },
        blockedByViewer: row.blocked_by_viewer,
        blockedViewer: row.blocked_viewer,
      });
    }
    return result;
  }

  /**
   * The relation from each of `viewerIds` to one user (for telling a user's chat partners about their
   * presence): the same facts as `relations`, gathered in one query.
   */
  async relationsToward(db: Executor, userId: string, viewerIds: readonly string[]): Promise<Map<string, Relation>> {
    const result = new Map<string, Relation>();
    const viewers = [...new Set(viewerIds)];
    if (viewers.length === 0) {
      return result;
    }
    const target = await this.relation(db, userId, userId);
    if (!target) {
      return result;
    }
    const blocks = await db
      .selectFrom('app.blocks')
      .select(['blocker_id', 'blocked_id'])
      .where((eb) =>
        eb.or([
          eb.and([eb('blocker_id', '=', userId), eb('blocked_id', 'in', viewers)]),
          eb.and([eb('blocked_id', '=', userId), eb('blocker_id', 'in', viewers)]),
        ]),
      )
      .execute();
    for (const viewerId of viewers) {
      result.set(viewerId, {
        user: target.user,
        privacy: target.privacy,
        blockedByViewer: blocks.some((block) => block.blocker_id === viewerId && block.blocked_id === userId),
        blockedViewer: blocks.some((block) => block.blocker_id === userId && block.blocked_id === viewerId),
      });
    }
    return result;
  }

  async relation(db: Executor, viewerId: string, userId: string): Promise<Relation | null> {
    return (await this.relations(db, viewerId, [userId])).get(userId) ?? null;
  }

  /**
   * What the viewer may see of another user. A user who blocked the viewer hides their photo, phone,
   * last seen and online status from them (blueprint: Other controls); deleted accounts show nothing.
   */
  visibilities(relation: Relation): Visibilities {
    if (relation.user.status === 'deleted' || relation.blockedViewer) {
      return { photo: false, phone: false, presence: false };
    }
    return {
      photo: relation.privacy.photo === 'everyone',
      phone: relation.privacy.phone === 'everyone' && relation.user.phone !== null,
      presence: relation.privacy.lastSeen === 'everyone',
    };
  }

  /**
   * Whether `senderStatus` may send to the related user now. A block by the recipient and "Who can message:
   * Nobody" give the same answer (P-26); the sender's own block asks them to unblock first (P-30).
   */
  sendDecision(senderStatus: UserStatus, relation: Relation): SendDecision {
    if (!SENDING_STATUSES.has(senderStatus)) {
      return { allowed: false, code: 'ACCOUNT_BLOCKED' };
    }
    if (relation.blockedByViewer) {
      return { allowed: false, code: 'USER_BLOCKED' };
    }
    if (relation.user.status === 'deleted' || relation.blockedViewer || relation.privacy.messagesFrom === 'nobody') {
      return { allowed: false, code: 'CANNOT_MESSAGE' };
    }
    return { allowed: true };
  }

  async userStatus(db: Executor, userId: string): Promise<UserStatus | null> {
    const row = await db.selectFrom('app.users').select('status').where('id', '=', userId).executeTakeFirst();
    return row?.status ?? null;
  }

  /** Throws the neutral error when the sender may not send to the recipient (P-26, P-30). */
  async assertCanSend(db: Executor, senderId: string, recipientId: string): Promise<void> {
    const [status, relation] = await Promise.all([this.userStatus(db, senderId), this.relation(db, senderId, recipientId)]);
    if (!status || !relation) {
      throw new AppError(HttpStatus.FORBIDDEN, 'CANNOT_MESSAGE');
    }
    const decision = this.sendDecision(status, relation);
    if (!decision.allowed) {
      throw new AppError(HttpStatus.FORBIDDEN, decision.code);
    }
  }

  /** Whether the sender may send to the recipient, without throwing (typing indicators). */
  async canSend(db: Executor, senderId: string, recipientId: string): Promise<boolean> {
    const [status, relation] = await Promise.all([this.userStatus(db, senderId), this.relation(db, senderId, recipientId)]);
    return Boolean(status && relation && this.sendDecision(status, relation).allowed);
  }

  /**
   * The viewer's access to a chat (private or group). Not being a member, a chat that does not exist and a deleted
   * group look the same (404), so chat ids reveal nothing.
   */
  async chatAccess(db: Executor, viewerId: string, conversationId: string): Promise<ChatAccess> {
    const access = await this.findChatAccess(db, viewerId, conversationId);
    if (!access) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    return access;
  }

  async findChatAccess(db: Executor, viewerId: string, conversationId: string): Promise<ChatAccess | null> {
    return (await this.chatAccesses(db, viewerId, [conversationId])).get(conversationId) ?? null;
  }

  /** Accesses for several chats at once; ids the viewer is not a member of are left out. */
  async chatAccesses(db: Executor, viewerId: string, conversationIds: readonly string[]): Promise<Map<string, ChatAccess>> {
    const ids = [...new Set(conversationIds)];
    const result = new Map<string, ChatAccess>();
    if (ids.length === 0) {
      return result;
    }
    const { rows } = await sql<AccessRow>`
      select me.conversation_id, c.type, c.is_public, me.role, me.admin_rights, me.denied_permissions, me.restricted_until,
        s.default_permissions, s.hide_member_count, s.hide_member_list,
        case when c.type = 'private' then (
          select p.user_id from app.conversation_members p where p.conversation_id = c.id and p.user_id <> me.user_id limit 1
        ) end as peer_id
      from app.conversation_members me
      join app.conversations c on c.id = me.conversation_id and c.deleted_at is null
      left join app.group_settings s on s.conversation_id = c.id
      where me.user_id = ${viewerId} and me.conversation_id in (${sql.join(ids)})
    `.execute(db);
    for (const row of rows) {
      if (row.type === 'private' && !row.peer_id) {
        continue;
      }
      result.set(row.conversation_id, accessFromRow(row));
    }
    return result;
  }

  /** A group or a channel (chats with roles, rights and a member list). */
  isCommunity(access: ChatAccess): boolean {
    return access.type === 'group' || access.type === 'channel';
  }

  isStaff(access: ChatAccess): boolean {
    return access.role === 'owner' || access.role === 'admin';
  }

  /**
   * Whether this member may see the member list (or count): owner, admins, or the group does not hide it (§7). In a
   * channel every subscriber sees the count and only the owner and admins see the list (D-40).
   */
  canViewMembers(access: ChatAccess, what: 'list' | 'count' = 'list'): boolean {
    if (!this.isCommunity(access)) {
      return false;
    }
    if (this.isStaff(access)) {
      return true;
    }
    if (access.type === 'channel') {
      return what === 'count';
    }
    return what === 'list' ? !access.hideMemberList : !access.hideMemberCount;
  }

  /**
   * Whether this viewer sees who sent each message: everywhere except a channel, where subscribers see posts as sent
   * by the channel (D-40).
   */
  seesSenders(access: ChatAccess): boolean {
    return access.type !== 'channel' || this.isStaff(access);
  }

  hasRight(access: ChatAccess, right: AdminRight): boolean {
    return this.isCommunity(access) && access.adminRights.has(right);
  }

  /** A right as an admin, or the same thing allowed to every member (pin, add members, change info). */
  may(access: ChatAccess, permission: MemberPermission, right?: AdminRight): boolean {
    return access.permissions.has(permission) || (right !== undefined && this.hasRight(access, right));
  }

  assertRight(access: ChatAccess, right: AdminRight): void {
    if (!this.hasRight(access, right)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ALLOWED');
    }
  }

  /** Every member of a chat (internal: who hears about a change). Never sent to a client. */
  async memberIds(db: Executor, conversationId: string): Promise<string[]> {
    const rows = await db.selectFrom('app.conversation_members').select('user_id').where('conversation_id', '=', conversationId).execute();
    return rows.map((row) => row.user_id);
  }

  /** The members who may see the member list (owner and admins, or everyone when it is not hidden). */
  async memberListViewers(db: Executor, access: ChatAccess): Promise<string[]> {
    const rows = await db
      .selectFrom('app.conversation_members')
      .select('user_id')
      .where('conversation_id', '=', access.conversationId)
      .$if(access.hideMemberList || access.type === 'channel', (query) => query.where('role', 'in', ['owner', 'admin']))
      .execute();
    return rows.map((row) => row.user_id);
  }

  /** The owner and admins of a group or channel. */
  async staffIds(db: Executor, conversationId: string): Promise<string[]> {
    const rows = await db.selectFrom('app.conversation_members').select('user_id').where('conversation_id', '=', conversationId).where('role', 'in', ['owner', 'admin']).execute();
    return rows.map((row) => row.user_id);
  }

  /** Who hears about a change in this chat: both participants, or every member of the group or channel. */
  async audienceOf(db: Executor, viewerId: string, access: ChatAccess): Promise<string[]> {
    return access.type === 'private' ? [viewerId, access.peerId!] : this.memberIds(db, access.conversationId);
  }

  /**
   * Throws unless the member may post this kind of message here: in a private chat the P-26/P-30 rules; in a group the
   * account may send and the member holds the permission (owner and admins always do); in a channel the member is the
   * owner or an admin with the right to post.
   */
  async assertCanPost(db: Executor, senderId: string, access: ChatAccess, kind: PostKind): Promise<void> {
    if (access.type === 'private') {
      await this.assertCanSend(db, senderId, access.peerId!);
      return;
    }
    const status = await this.userStatus(db, senderId);
    if (!status || !SENDING_STATUSES.has(status)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
    }
    const needed = POST_PERMISSION[kind];
    if (!access.permissions.has('send_messages') || (needed && !access.permissions.has(needed))) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ALLOWED');
    }
  }

  /** The same, without throwing (typing indicators). */
  async canPost(db: Executor, senderId: string, access: ChatAccess): Promise<boolean> {
    if (access.type === 'private') {
      return this.canSend(db, senderId, access.peerId!);
    }
    const status = await this.userStatus(db, senderId);
    return Boolean(status && SENDING_STATUSES.has(status) && access.permissions.has('send_messages'));
  }
}
