import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ADMIN_RIGHTS, type Chat, type GroupInfo, MEMBER_PERMISSIONS, MESSAGING_RULES } from '@bedo/contracts';
import { AccountsService } from '../auth/accounts.service.js';
import { sql } from 'kysely';
import type { Executor } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { accessFromRow, PermissionService } from './permissions.service.js';
import { UpdateLogService } from './update-log.service.js';
import { MESSAGE_COLUMNS, ViewsService } from './views.service.js';

interface ChatRow {
  id: string;
  type: 'private' | 'group' | 'channel';
  is_public: boolean;
  title: string | null;
  description: string | null;
  photo_key: string | null;
  created_at: Date;
  last_seq: string;
  last_message_at: Date | null;
  read_seq: string;
  role: 'owner' | 'admin' | 'member' | 'subscriber';
  admin_rights: string[];
  denied_permissions: string[];
  restricted_until: Date | null;
  default_permissions: string[] | null;
  hide_member_count: boolean | null;
  hide_member_list: boolean | null;
  peer_id: string | null;
  peer_read_seq: string;
  peer_delivered_seq: string;
  muted_until: Date | null;
  pinned_at: Date | null;
  archived_at: Date | null;
  marked_unread: boolean;
  folder_ids: string[];
  unread_count: string;
  scheduled_count: number;
  last_message_id: string | null;
}

/** Unread counts stop at this number (the list shows "999+"-style values from it). */
const UNREAD_COUNT_CAP = 1000;

@Injectable()
export class ChatsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(ViewsService) private readonly views: ViewsService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {}

  /**
   * Chat summaries for one viewer: only chats they are a member of. Without `chatIds` this is the chat
   * list: chats with at least one message, plus empty chats the viewer started.
   */
  async summaries(db: Executor, viewerId: string, chatIds?: readonly string[]): Promise<Chat[]> {
    if (chatIds && chatIds.length === 0) {
      return [];
    }
    const filter = chatIds ? sql`and c.id in (${sql.join(chatIds)})` : sql`and (c.type <> 'private' or c.last_seq > 0 or c.created_by = ${viewerId})`;
    const { rows } = await sql<ChatRow>`
      select c.id, c.type, c.is_public, c.title, c.description, c.photo_key, c.created_at, c.last_seq, c.last_message_at,
        me.read_seq, me.role, me.admin_rights, me.denied_permissions, me.restricted_until,
        gs.default_permissions, gs.hide_member_count, gs.hide_member_list,
        peer.user_id as peer_id,
        coalesce(peer.read_seq, others.read_seq, 0) as peer_read_seq,
        coalesce(peer.delivered_seq, others.delivered_seq, 0) as peer_delivered_seq,
        s.pinned_at, s.archived_at, coalesce(s.marked_unread, false) as marked_unread, s.muted_until,
        coalesce((
          select array_agg(fc.folder_id::text order by f.created_at)
          from app.chat_folder_chats fc join app.chat_folders f on f.id = fc.folder_id
          where f.user_id = ${viewerId} and fc.conversation_id = c.id
        ), '{}') as folder_ids,
        (
          select count(*) from (
            select 1 from app.messages m
            where m.conversation_id = c.id and m.seq > me.read_seq and m.sender_id <> ${viewerId} and m.deleted_at is null
              and not exists (select 1 from app.message_hidden h where h.user_id = ${viewerId} and h.message_id = m.id)
            limit ${UNREAD_COUNT_CAP}
          ) unread
        ) as unread_count,
        (
          select count(*)::int from app.scheduled_messages sm
          where sm.conversation_id = c.id and sm.sender_id = ${viewerId} and sm.status in ('pending', 'sending', 'failed')
        ) as scheduled_count,
        lm.id as last_message_id
      from app.conversation_members me
      join app.conversations c on c.id = me.conversation_id and c.deleted_at is null
      left join app.group_settings gs on gs.conversation_id = c.id
      left join app.conversation_members peer on c.type = 'private' and peer.conversation_id = c.id and peer.user_id <> me.user_id
      -- Groups: how far any other member has read and received (for the status of one's own messages).
      left join lateral (
        select max(o.read_seq) as read_seq, max(o.delivered_seq) as delivered_seq
        from app.conversation_members o
        where c.type <> 'private' and o.conversation_id = c.id and o.user_id <> me.user_id
      ) others on true
      left join app.user_chat_state s on s.user_id = me.user_id and s.conversation_id = c.id
      left join lateral (
        select m.id from app.messages m
        where m.conversation_id = c.id
          and not exists (select 1 from app.message_hidden h where h.user_id = ${viewerId} and h.message_id = m.id)
        order by m.seq desc limit 1
      ) lm on true
      where me.user_id = ${viewerId} and (c.type <> 'private' or peer.user_id is not null) ${filter}
      order by coalesce(c.last_message_at, c.created_at) desc
    `.execute(db);
    if (rows.length === 0) {
      return [];
    }
    const lastIds = rows.map((row) => row.last_message_id).filter((id): id is string => id !== null);
    const [peers, lastRows, groups] = await Promise.all([
      this.views.peers(db, viewerId, rows.map((row) => row.peer_id).filter((id): id is string => id !== null)),
      lastIds.length > 0 ? db.selectFrom('app.messages').select(MESSAGE_COLUMNS).where('id', 'in', lastIds).execute() : Promise.resolve([]),
      this.groupInfos(db, viewerId, rows.filter((row) => row.type !== 'private')),
    ]);
    const lastMessages = new Map((await this.views.messages(db, viewerId, lastRows)).map((message) => [message.id, message]));
    const chats: Chat[] = [];
    for (const row of rows) {
      const peer = row.peer_id ? (peers.get(row.peer_id) ?? null) : null;
      const group = groups.get(row.id) ?? null;
      if ((row.type === 'private' && !peer) || (row.type !== 'private' && !group)) {
        continue;
      }
      chats.push({
        id: row.id,
        type: row.type,
        peer,
        group,
        lastMessage: row.last_message_id ? (lastMessages.get(row.last_message_id) ?? null) : null,
        lastSeq: Number(row.last_seq),
        readSeq: Number(row.read_seq),
        unreadCount: Number(row.unread_count),
        markedUnread: row.marked_unread,
        peerReadSeq: Number(row.peer_read_seq),
        peerDeliveredSeq: Number(row.peer_delivered_seq),
        mutedUntil: row.muted_until && new Date(row.muted_until).getTime() > Date.now() ? new Date(row.muted_until).toISOString() : null,
        pinned: row.pinned_at !== null,
        pinnedAt: row.pinned_at ? new Date(row.pinned_at).toISOString() : null,
        archived: row.archived_at !== null,
        folderIds: row.folder_ids,
        scheduledCount: row.scheduled_count,
        createdAt: new Date(row.created_at).toISOString(),
        lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      });
    }
    return chats;
  }

  /**
   * The group (or channel) part of chat summaries, as each member may see it (§7): the member count only through the
   * database's own check (app.group_member_count) and only when this member may see it; settings and join requests
   * only for owners and admins.
   */
  private async groupInfos(db: Executor, viewerId: string, rows: ChatRow[]): Promise<Map<string, GroupInfo>> {
    const result = new Map<string, GroupInfo>();
    for (const row of rows) {
      const access = accessFromRow({ ...row, conversation_id: row.id, peer_id: null });
      const staff = access.role === 'owner' || access.role === 'admin';
      const [count, pending, photoUrl] = await Promise.all([
        this.permissions.canViewMembers(access, 'count')
          ? sql<{ n: number }>`select app.group_member_count(${viewerId}, ${row.id}) as n`.execute(db).then((result) => Number(result.rows[0]?.n ?? 0))
          : Promise.resolve(null),
        this.permissions.hasRight(access, 'approve_requests')
          ? db
              .selectFrom('app.join_requests')
              .select(sql<number>`count(*)::int`.as('n'))
              .where('conversation_id', '=', row.id)
              .where('status', '=', 'pending')
              .executeTakeFirstOrThrow()
              .then((result) => result.n)
          : Promise.resolve(null),
        this.accounts.photoUrl(row.photo_key),
      ]);
      result.set(row.id, {
        title: row.title ?? '',
        description: row.description,
        photoUrl,
        role: access.role,
        adminRights: ADMIN_RIGHTS.filter((right) => access.adminRights.has(right)),
        permissions: MEMBER_PERMISSIONS.filter((permission) => access.permissions.has(permission)),
        restricted: access.restricted,
        restrictedUntil: access.restrictedUntil ? new Date(access.restrictedUntil).toISOString() : null,
        memberCount: count,
        canViewMembers: this.permissions.canViewMembers(access, 'list'),
        settings: staff ? { defaultPermissions: [...access.defaultPermissions], hideMemberCount: access.hideMemberCount, hideMemberList: access.hideMemberList } : null,
        pendingRequests: pending,
        public: access.isPublic,
      });
    }
    return result;
  }

  list(viewerId: string): Promise<Chat[]> {
    return this.summaries(this.database.db, viewerId);
  }

  async get(viewerId: string, chatId: string): Promise<Chat> {
    const [chat] = await this.summaries(this.database.db, viewerId, [chatId]);
    if (!chat) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    return chat;
  }

  /**
   * Opens the private chat with a user: the existing one (its history stays readable whatever the
   * permissions now, P-26), or a new one if the viewer may message them.
   */
  async open(viewerId: string, userId: string): Promise<Chat> {
    if (userId === viewerId) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    const [low, high] = viewerId < userId ? [viewerId, userId] : [userId, viewerId];
    const db = this.database.db;
    const existing = await db
      .selectFrom('app.conversations')
      .select('id')
      .where('type', '=', 'private')
      .where('private_low', '=', low)
      .where('private_high', '=', high)
      .executeTakeFirst();
    if (existing) {
      return this.get(viewerId, existing.id);
    }
    const target = await this.permissions.relation(db, viewerId, userId);
    if (!target) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    await this.permissions.assertCanSend(db, viewerId, userId);
    const chatId = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('app.conversations')
        .values({ type: 'private', private_low: low, private_high: high, created_by: viewerId })
        .onConflict((conflict) => conflict.columns(['private_low', 'private_high']).where('type', '=', 'private').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!created) {
        // Opened by the other user at the same moment.
        const row = await trx
          .selectFrom('app.conversations')
          .select('id')
          .where('type', '=', 'private')
          .where('private_low', '=', low)
          .where('private_high', '=', high)
          .executeTakeFirstOrThrow();
        return row.id;
      }
      await trx
        .insertInto('app.conversation_members')
        .values([
          { conversation_id: created.id, user_id: low },
          { conversation_id: created.id, user_id: high },
        ])
        .execute();
      return created.id;
    });
    return this.get(viewerId, chatId);
  }

  /** Mark as read up to `seq` (P-20); reading also clears "marked as unread" and counts as delivered. */
  async read(viewerId: string, chatId: string, seq: number): Promise<Chat> {
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.permissions.chatAccess(trx, viewerId, chatId);
      const conversation = await trx.selectFrom('app.conversations').select('last_seq').where('id', '=', chatId).executeTakeFirstOrThrow();
      const target = Math.min(seq, Number(conversation.last_seq));
      const before = await trx
        .selectFrom('app.conversation_members')
        .select(['read_seq', 'delivered_seq'])
        .where('conversation_id', '=', chatId)
        .where('user_id', '=', viewerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const readSeq = Math.max(Number(before.read_seq), target);
      const deliveredSeq = Math.max(Number(before.delivered_seq), readSeq);
      if (readSeq !== Number(before.read_seq) || deliveredSeq !== Number(before.delivered_seq)) {
        await trx
          .updateTable('app.conversation_members')
          .set({ read_seq: readSeq, delivered_seq: deliveredSeq })
          .where('conversation_id', '=', chatId)
          .where('user_id', '=', viewerId)
          .execute();
      }
      // In a group, read and delivered positions reach only the member's own devices: who read what is not shown to
      // other members (and a hidden member list must not leak through them); the furthest position is in the summary.
      const others = access.type === 'private' ? [access.peerId!] : [];
      if (readSeq !== Number(before.read_seq)) {
        updates.addFor([viewerId, ...others], { kind: 'chat.read', chatId, data: access.type === 'private' ? { userId: viewerId, seq: readSeq } : { seq: readSeq } });
      }
      if (deliveredSeq !== Number(before.delivered_seq) && others.length > 0) {
        updates.addFor(others, { kind: 'chat.delivered', chatId, data: { userId: viewerId, seq: deliveredSeq } });
      }
      const cleared = await trx
        .updateTable('app.user_chat_state')
        .set({ marked_unread: false })
        .where('user_id', '=', viewerId)
        .where('conversation_id', '=', chatId)
        .where('marked_unread', '=', true)
        .executeTakeFirst();
      if (Number(cleared.numUpdatedRows) > 0) {
        updates.add({ userId: viewerId, kind: 'chat.state', chatId });
      }
    });
    return this.get(viewerId, chatId);
  }

  /** A device received the chat's messages up to `seq` (status "delivered" for the sender). */
  async delivered(viewerId: string, chatId: string, seq: number): Promise<void> {
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.permissions.chatAccess(trx, viewerId, chatId);
      const conversation = await trx.selectFrom('app.conversations').select('last_seq').where('id', '=', chatId).executeTakeFirstOrThrow();
      const target = Math.min(seq, Number(conversation.last_seq));
      const updated = await trx
        .updateTable('app.conversation_members')
        .set({ delivered_seq: target })
        .where('conversation_id', '=', chatId)
        .where('user_id', '=', viewerId)
        .where('delivered_seq', '<', String(target))
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) > 0 && access.type === 'private') {
        updates.add({ userId: access.peerId!, kind: 'chat.delivered', chatId, data: { userId: viewerId, seq: target } });
      }
    });
  }

  /** Pin (at most 5, P-19), archive, or mark as unread (P-20); the same on every device. */
  async setState(viewerId: string, chatId: string, body: { pinned?: boolean; archived?: boolean; unread?: boolean; mutedUntil?: string | null }): Promise<Chat> {
    await this.updateLog.run(async (trx, updates) => {
      await this.permissions.chatAccess(trx, viewerId, chatId);
      // One change of a user's chat-list state at a time, so the pinned-chat limit holds.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`chat-state:${viewerId}`}, 0))`.execute(trx);
      const current = await trx
        .selectFrom('app.user_chat_state')
        .selectAll()
        .where('user_id', '=', viewerId)
        .where('conversation_id', '=', chatId)
        .executeTakeFirst();
      const now = new Date();
      let pinnedAt = current?.pinned_at ?? null;
      let archivedAt = current?.archived_at ?? null;
      let markedUnread = current?.marked_unread ?? false;
      let mutedUntil = current?.muted_until ?? null;
      if (body.mutedUntil !== undefined) {
        mutedUntil = body.mutedUntil === null ? null : new Date(body.mutedUntil);
      }
      if (body.pinned !== undefined && body.pinned !== (pinnedAt !== null)) {
        if (body.pinned) {
          const pinned = await trx
            .selectFrom('app.user_chat_state')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('user_id', '=', viewerId)
            .where('pinned_at', 'is not', null)
            .executeTakeFirstOrThrow();
          if (Number(pinned.count) >= MESSAGING_RULES.maxPinnedChats) {
            throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
          }
          pinnedAt = now;
        } else {
          pinnedAt = null;
        }
      }
      if (body.archived !== undefined) {
        archivedAt = body.archived ? (archivedAt ?? now) : null;
      }
      if (body.unread !== undefined) {
        markedUnread = body.unread;
      }
      const sameTime = (a: Date | null, b: Date | null) => (a === null ? b === null : b !== null && new Date(a).getTime() === new Date(b).getTime());
      const changed =
        !current
          ? pinnedAt !== null || archivedAt !== null || markedUnread || mutedUntil !== null
          : pinnedAt !== current.pinned_at || archivedAt !== current.archived_at || markedUnread !== current.marked_unread || !sameTime(mutedUntil, current.muted_until);
      if (!changed) {
        return;
      }
      await trx
        .insertInto('app.user_chat_state')
        .values({ user_id: viewerId, conversation_id: chatId, pinned_at: pinnedAt, archived_at: archivedAt, marked_unread: markedUnread, muted_until: mutedUntil })
        .onConflict((conflict) =>
          conflict
            .columns(['user_id', 'conversation_id'])
            .doUpdateSet({ pinned_at: pinnedAt, archived_at: archivedAt, marked_unread: markedUnread, muted_until: mutedUntil }),
        )
        .execute();
      updates.add({ userId: viewerId, kind: 'chat.state', chatId });
    });
    return this.get(viewerId, chatId);
  }
}
