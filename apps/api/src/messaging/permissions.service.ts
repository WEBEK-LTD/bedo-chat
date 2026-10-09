import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { UserStatus, Visibility } from '@bedo/db';
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

/** Private-chat membership as the permission service sees it. */
export interface PrivateChatAccess {
  conversationId: string;
  peerId: string;
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
   * The viewer's private chat and the other participant. Not being a member and a chat that does not
   * exist look the same (404), so chat ids reveal nothing.
   */
  async chatAccess(db: Executor, viewerId: string, conversationId: string): Promise<PrivateChatAccess> {
    const access = await this.findChatAccess(db, viewerId, conversationId);
    if (!access) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    return access;
  }

  async findChatAccess(db: Executor, viewerId: string, conversationId: string): Promise<PrivateChatAccess | null> {
    const row = await db
      .selectFrom('app.conversation_members as me')
      .innerJoin('app.conversation_members as peer', (join) =>
        join.onRef('peer.conversation_id', '=', 'me.conversation_id').onRef('peer.user_id', '<>', 'me.user_id'),
      )
      .select(['me.conversation_id', 'peer.user_id as peer_id'])
      .where('me.conversation_id', '=', conversationId)
      .where('me.user_id', '=', viewerId)
      .executeTakeFirst();
    return row ? { conversationId: row.conversation_id, peerId: row.peer_id } : null;
  }

  /** Accesses for several chats at once; ids the viewer is not a member of are left out. */
  async chatAccesses(db: Executor, viewerId: string, conversationIds: readonly string[]): Promise<Map<string, PrivateChatAccess>> {
    const ids = [...new Set(conversationIds)];
    const result = new Map<string, PrivateChatAccess>();
    if (ids.length === 0) {
      return result;
    }
    const rows = await db
      .selectFrom('app.conversation_members as me')
      .innerJoin('app.conversation_members as peer', (join) =>
        join.onRef('peer.conversation_id', '=', 'me.conversation_id').onRef('peer.user_id', '<>', 'me.user_id'),
      )
      .select(['me.conversation_id', 'peer.user_id as peer_id'])
      .where('me.conversation_id', 'in', ids)
      .where('me.user_id', '=', viewerId)
      .execute();
    for (const row of rows) {
      result.set(row.conversation_id, { conversationId: row.conversation_id, peerId: row.peer_id });
    }
    return result;
  }
}
