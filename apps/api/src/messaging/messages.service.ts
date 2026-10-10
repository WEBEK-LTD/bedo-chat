import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type DeleteMessagesBody,
  type ForwardMessagesBody,
  type Message,
  MESSAGING_RULES,
  type SendMessageBody,
} from '@bedo/contracts';
import type { Database } from '@bedo/db';
import { sql, type Transaction } from 'kysely';
import { AuditService, type Executor } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { FilesService, type VerifiedFile } from '../media/files.service.js';
import { GifsService } from '../media/gifs.service.js';
import { StickersService } from '../media/stickers.service.js';
import { MentionsService } from '../groups/mentions.service.js';
import { PollsService } from '../groups/polls.service.js';
import { MessagingLimitsService } from './messaging-limits.service.js';
import { NotificationsService } from './notifications.service.js';
import { type ChatAccess, PermissionService, type PostKind } from './permissions.service.js';
import { UpdateLogService } from './update-log.service.js';
import { MESSAGE_COLUMNS, type MessageRow, ViewsService } from './views.service.js';

/**
 * Phase 6: a scheduled message sent by the API when due (D-40). Its sender's limits were counted when it was
 * scheduled, and its file was checked then (it is ready, owned by the sender, and not sent before).
 */
export interface SendOptions {
  scheduled?: boolean;
}

/** Raised inside a transaction when another request with the same client id won the race. */
class DuplicateRequest extends Error {}

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');

/** Escapes LIKE wildcards so a search for "50%" matches the text "50%". */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

@Injectable()
export class MessagesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(ViewsService) private readonly views: ViewsService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(GifsService) private readonly gifs: GifsService,
    @Inject(StickersService) private readonly stickers: StickersService,
    @Inject(PollsService) private readonly polls: PollsService,
    @Inject(MentionsService) private readonly mentions: MentionsService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  /** What a new message carries, for the group permission it needs. */
  private static postKind(body: SendMessageBody): PostKind {
    return body.poll ? 'poll' : body.stickerId || body.gifId ? 'sticker' : body.fileId ? 'media' : 'text';
  }

  private async viewOne(db: Executor, viewerId: string, messageId: string): Promise<Message> {
    const row = await db.selectFrom('app.messages').select(MESSAGE_COLUMNS).where('id', '=', messageId).executeTakeFirstOrThrow();
    const [view] = await this.views.messages(db, viewerId, [row]);
    return view!;
  }

  /** Messages the viewer can see, by id, in seq order (hidden ones are left out). */
  async visibleViews(db: Executor, viewerId: string, messageIds: readonly string[]): Promise<Message[]> {
    if (messageIds.length === 0) {
      return [];
    }
    const rows = await db
      .selectFrom('app.messages as m')
      .select(MESSAGE_COLUMNS.map((column) => `m.${column}` as const))
      .where('m.id', 'in', [...new Set(messageIds)])
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', viewerId))),
      )
      .orderBy('m.seq')
      .execute();
    return this.views.messages(db, viewerId, rows);
  }

  private async existingRequest(senderId: string, clientId: string) {
    return this.database.db
      .selectFrom('app.message_requests')
      .selectAll()
      .where('sender_id', '=', senderId)
      .where('client_id', '=', clientId)
      .executeTakeFirst();
  }

  /** Allocates `count` message sequence numbers in a conversation (locks the conversation row). */
  private async allocateSeqs(trx: Transaction<Database>, chatId: string, count: number): Promise<number> {
    const row = await trx
      .updateTable('app.conversations')
      .set({ last_seq: sql`last_seq + ${count}`, last_message_at: sql`now()` })
      .where('id', '=', chatId)
      .returning('last_seq')
      .executeTakeFirstOrThrow();
    return Number(row.last_seq) - count + 1;
  }

  private async newIds(trx: Transaction<Database>, count: number): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`select app.uuid_v7() as id from generate_series(1, ${count})`.execute(trx);
    return rows.map((row) => row.id);
  }

  /** Who of the chat's members should hear about a message (not those who hid it). */
  private async audience(trx: Executor, members: readonly string[], messageId: string): Promise<string[]> {
    const hidden = await trx.selectFrom('app.message_hidden').select('user_id').where('message_id', '=', messageId).execute();
    const hiddenFor = new Set(hidden.map((row) => row.user_id));
    return members.filter((member) => !hiddenFor.has(member));
  }

  /**
   * Send (blueprint: Write path): text, a file with an optional caption, a sticker or a GIF. Re-sending with the same
   * client id returns the stored message. A file is read back and checked before the message exists (Phase 4).
   */
  async send(auth: AuthContext, chatId: string, body: SendMessageBody, options: SendOptions = {}): Promise<Message> {
    const previous = await this.existingRequest(auth.userId, body.clientId);
    if (previous) {
      return this.replay(auth.userId, previous, 'send', chatId);
    }
    if (!options.scheduled) {
      await this.limits.messages(auth.userId);
    }
    const kind = MessagesService.postKind(body);
    {
      // Membership and the right to post are checked before any file is fetched or checked (and again below).
      const access = await this.permissions.chatAccess(this.database.db, auth.userId, chatId);
      await this.permissions.assertCanPost(this.database.db, auth.userId, access, kind);
      if (body.poll && access.type === 'private') {
        // Polls are for groups (Phase 5) and channels (Phase 6).
        throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
      }
    }
    let verified: VerifiedFile | null = null;
    let fileId: string | null = null;
    if (body.fileId && options.scheduled) {
      fileId = await this.files.assertPrepared(auth.userId, body.fileId);
    } else if (body.fileId) {
      verified = await this.files.verify(auth.userId, body.fileId);
      fileId = verified.fileId;
    } else if (body.gifId) {
      fileId = await this.gifs.fileFor(auth.userId, body.gifId);
    }
    let messageId: string;
    try {
      messageId = await this.updateLog.run(async (trx, updates) => {
        const access = await this.permissions.chatAccess(trx, auth.userId, chatId);
        await this.permissions.assertCanPost(trx, auth.userId, access, kind);
        if (body.replyToId) {
          await this.assertVisibleInChat(trx, auth.userId, chatId, body.replyToId);
        }
        if (body.stickerId) {
          await this.stickers.assertSendable(trx, body.stickerId);
        }
        const pollId = body.poll ? await this.polls.create(trx, chatId, auth.userId, body.poll) : null;
        const [id] = await this.newIds(trx, 1);
        await this.claimRequest(trx, auth.userId, body.clientId, 'send', chatId, [id!]);
        if (verified && !(await this.files.markReady(trx, auth.userId, verified))) {
          throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
        }
        const seq = await this.allocateSeqs(trx, chatId, 1);
        await trx
          .insertInto('app.messages')
          .values({
            id: id!,
            conversation_id: chatId,
            seq,
            sender_id: auth.userId,
            client_id: body.clientId,
            kind: pollId ? 'poll' : fileId ? 'media' : body.stickerId ? 'sticker' : 'text',
            text: body.text ?? null,
            reply_to_id: body.replyToId ?? null,
            file_id: fileId,
            sticker_id: body.stickerId ?? null,
            poll_id: pollId,
          })
          .execute();
        if (access.type !== 'private' && body.text) {
          await this.mentions.record(trx, chatId, id!, body.text);
        }
        updates.addFor(await this.permissions.audienceOf(trx, auth.userId, access), { kind: 'message.new', chatId, messageId: id! });
        return id!;
      });
    } catch (error) {
      if (error instanceof DuplicateRequest) {
        const stored = await this.existingRequest(auth.userId, body.clientId);
        if (stored) {
          return this.replay(auth.userId, stored, 'send', chatId);
        }
      }
      throw error;
    }
    // Phase 7: the members are notified after the response (D-41).
    this.notifications.messagesCreated(chatId, [messageId], auth.userId);
    return this.viewOne(this.database.db, auth.userId, messageId);
  }

  private async claimRequest(trx: Transaction<Database>, senderId: string, clientId: string, kind: 'send' | 'forward', chatId: string, messageIds: string[]): Promise<void> {
    const claimed = await trx
      .insertInto('app.message_requests')
      .values({ sender_id: senderId, client_id: clientId, kind, conversation_id: chatId, message_ids: messageIds })
      .onConflict((conflict) => conflict.columns(['sender_id', 'client_id']).doNothing())
      .returning('client_id')
      .executeTakeFirst();
    if (!claimed) {
      throw new DuplicateRequest();
    }
  }

  private async replay(
    viewerId: string,
    stored: { kind: 'send' | 'forward'; conversation_id: string; message_ids: string[] },
    kind: 'send' | 'forward',
    chatId: string,
  ): Promise<Message> {
    if (stored.kind !== kind || stored.conversation_id !== chatId) {
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
    }
    // Phase 9: a retry shows the message only to someone still in the chat.
    await this.permissions.chatAccess(this.database.db, viewerId, chatId);
    return this.viewOne(this.database.db, viewerId, stored.message_ids[0]!);
  }

  private async assertVisibleInChat(db: Executor, viewerId: string, chatId: string, messageId: string): Promise<void> {
    const row = await db
      .selectFrom('app.messages as m')
      .select('m.id')
      .where('m.id', '=', messageId)
      .where('m.conversation_id', '=', chatId)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', viewerId))),
      )
      .executeTakeFirst();
    if (!row) {
      throw notFound();
    }
  }

  /** Edit one's own message; no time limit (O-27). The previous text goes to the audit history. */
  async edit(auth: AuthContext, messageId: string, text: string): Promise<Message> {
    await this.limits.messages(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const message = await this.lockOwnVisible(trx, auth.userId, messageId);
      const access = await this.permissions.chatAccess(trx, auth.userId, message.conversation_id);
      await this.permissions.assertCanPost(trx, auth.userId, access, 'text');
      if (message.kind === 'sticker' || message.kind === 'poll') {
        // Stickers and polls have no text to edit.
        throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN');
      }
      if (message.text === text) {
        return;
      }
      await this.audit.messageRevision(trx, {
        messageId,
        conversationId: message.conversation_id,
        senderId: message.sender_id,
        action: 'edited',
        previousText: message.text,
        newText: text,
        fileId: message.file_id,
        actor: { type: 'user', id: auth.userId },
        sessionId: auth.sessionId,
      });
      await trx.updateTable('app.messages').set({ text, edited_at: sql`now()` }).where('id', '=', messageId).execute();
      if (access.type !== 'private') {
        await this.mentions.record(trx, message.conversation_id, messageId, text);
      }
      updates.addFor(await this.audience(trx, await this.permissions.audienceOf(trx, auth.userId, access), messageId), {
        kind: 'message.edited',
        chatId: message.conversation_id,
        messageId,
      });
    });
    return this.viewOne(this.database.db, auth.userId, messageId);
  }

  /** The viewer's own message, not deleted and not hidden for them, locked for a change. */
  private async lockOwnVisible(trx: Transaction<Database>, viewerId: string, messageId: string) {
    const message = await trx.selectFrom('app.messages').select(MESSAGE_COLUMNS).where('id', '=', messageId).forUpdate().executeTakeFirst();
    if (!message || message.sender_id !== viewerId || message.deleted_at !== null) {
      throw notFound();
    }
    const access = await this.permissions.findChatAccess(trx, viewerId, message.conversation_id);
    const hidden = await trx.selectFrom('app.message_hidden').select('message_id').where('user_id', '=', viewerId).where('message_id', '=', messageId).executeTakeFirst();
    if (!access || hidden) {
      throw notFound();
    }
    return message;
  }

  /**
   * Delete for me (anyone, any message, P-29) or for both sides (the sender's own messages only); no time
   * limit (O-27). Each message's text goes to the audit history in the same transaction.
   */
  async delete(auth: AuthContext, body: DeleteMessagesBody): Promise<void> {
    // Phase 9: deleting for both notifies every member's devices.
    await this.limits.peerActions(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const access = await this.permissions.chatAccess(trx, auth.userId, body.chatId);
      const rows = await trx
        .selectFrom('app.messages')
        .select(MESSAGE_COLUMNS)
        .where('id', 'in', body.messageIds)
        .where('conversation_id', '=', body.chatId)
        .orderBy('seq')
        .forUpdate()
        .execute();
      const hidden = new Set(
        (
          await trx.selectFrom('app.message_hidden').select('message_id').where('user_id', '=', auth.userId).where('message_id', 'in', body.messageIds).execute()
        ).map((row) => row.message_id),
      );
      // Every selected message must exist in this chat and still be visible to the user.
      if (rows.length !== body.messageIds.length || rows.some((row) => hidden.has(row.id))) {
        throw notFound();
      }
      const actor = { type: 'user' as const, id: auth.userId };
      if (body.scope === 'me') {
        for (const row of rows) {
          await this.audit.messageRevision(trx, {
            messageId: row.id,
            conversationId: row.conversation_id,
            senderId: row.sender_id,
            action: 'deleted_for_me',
            previousText: row.text,
            fileId: row.file_id,
            stickerId: row.sticker_id,
            pollId: row.poll_id,
            actor,
            sessionId: auth.sessionId,
          });
        }
        await trx
          .insertInto('app.message_hidden')
          .values(rows.map((row) => ({ user_id: auth.userId, message_id: row.id, conversation_id: row.conversation_id })))
          .execute();
        for (const row of rows) {
          updates.add({ userId: auth.userId, kind: 'message.hidden', chatId: body.chatId, messageId: row.id });
        }
        return;
      }
      // Their own messages, or anyone's for a group admin with the right to delete messages (Phase 5).
      if (rows.some((row) => row.sender_id !== auth.userId) && !this.permissions.hasRight(access, 'delete_messages')) {
        throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN');
      }
      const members = await this.permissions.audienceOf(trx, auth.userId, access);
      for (const row of rows) {
        if (row.deleted_at !== null) {
          continue;
        }
        await this.audit.messageRevision(trx, {
          messageId: row.id,
          conversationId: row.conversation_id,
          senderId: row.sender_id,
          action: 'deleted_for_both',
          previousText: row.text,
          fileId: row.file_id,
          stickerId: row.sticker_id,
          pollId: row.poll_id,
          actor,
          sessionId: auth.sessionId,
        });
        await trx
          .updateTable('app.messages')
          .set({ text: null, deleted_at: sql`now()`, deleted_by: auth.userId })
          .where('id', '=', row.id)
          .execute();
        const audience = await this.audience(trx, members, row.id);
        updates.addFor(audience, { kind: 'message.deleted', chatId: body.chatId, messageId: row.id });
        const unpinned = await trx.deleteFrom('app.message_pins').where('conversation_id', '=', body.chatId).where('message_id', '=', row.id).executeTakeFirst();
        if (Number(unpinned.numDeletedRows) > 0) {
          updates.addFor(audience, { kind: 'message.unpinned', chatId: body.chatId, messageId: row.id });
        }
      }
    });
  }

  /**
   * Forward up to 100 messages to up to 10 chats (P-23). Each destination is a separate request with its
   * own client id; all succeed or none. The copies show the original sender ("Forwarded from"). Every copy
   * counts towards the 30 messages per minute (D-30).
   */
  async forward(auth: AuthContext, body: ForwardMessagesBody): Promise<Message[]> {
    const stored = await this.database.db
      .selectFrom('app.message_requests')
      .selectAll()
      .where('sender_id', '=', auth.userId)
      .where(
        'client_id',
        'in',
        body.targets.map((target) => target.clientId),
      )
      .execute();
    if (stored.length > 0) {
      return this.replayForward(auth.userId, body, stored);
    }
    // D-30: every message created counts, so forwarding N messages to T chats costs N x T.
    await this.limits.messages(auth.userId, body.messageIds.length * body.targets.length);
    let created: string[];
    try {
      created = await this.updateLog.run(async (trx, updates) => {
        const fromAccess = await this.permissions.chatAccess(trx, auth.userId, body.fromChatId);
        const sources = await trx
          .selectFrom('app.messages as m')
          .select(MESSAGE_COLUMNS.map((column) => `m.${column}` as const))
          .where('m.id', 'in', body.messageIds)
          .where('m.conversation_id', '=', body.fromChatId)
          .where('m.deleted_at', 'is', null)
          .where(({ not, exists, selectFrom }) =>
            not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', auth.userId))),
          )
          .orderBy('m.seq')
          .execute();
        if (sources.length !== body.messageIds.length) {
          throw notFound();
        }
        // Phase 9: an open quiz cannot be forwarded: a copy elsewhere would show its answer before the class answered.
        const pollIds = sources.map((source) => source.poll_id).filter((id): id is string => id !== null);
        if (pollIds.length > 0) {
          const openQuiz = await trx.selectFrom('app.polls').select('id').where('id', 'in', pollIds).where('kind', '=', 'quiz').where('closed_at', 'is', null).executeTakeFirst();
          if (openQuiz) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
        }
        const targets = [...body.targets].sort((a, b) => (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0));
        const accesses = await this.permissions.chatAccesses(trx, auth.userId, targets.map((target) => target.chatId));
        const kinds = new Set<PostKind>(sources.map((source) => (source.kind === 'poll' ? 'poll' : source.kind === 'sticker' ? 'sticker' : source.kind === 'media' ? 'media' : 'text')));
        for (const target of targets) {
          const access = accesses.get(target.chatId);
          if (!access) {
            throw notFound();
          }
          for (const kind of kinds) {
            await this.permissions.assertCanPost(trx, auth.userId, access, kind);
          }
        }
        const createdIds: string[] = [];
        const perChat: Array<[string, string[]]> = [];
        for (const target of targets) {
          const access = accesses.get(target.chatId)!;
          const ids = await this.newIds(trx, sources.length);
          await this.claimRequest(trx, auth.userId, target.clientId, 'forward', target.chatId, ids);
          const firstSeq = await this.allocateSeqs(trx, target.chatId, sources.length);
          // Phase 9: a forwarded poll is a new poll of the target chat (its own votes and voters).
          const pollCopies = new Map<string, string>();
          for (const source of sources) {
            if (source.poll_id) pollCopies.set(source.id, await this.polls.copy(trx, source.poll_id, target.chatId, auth.userId));
          }
          await trx
            .insertInto('app.messages')
            .values(
              sources.map((source, index) => ({
                id: ids[index]!,
                conversation_id: target.chatId,
                seq: firstSeq + index,
                sender_id: auth.userId,
                client_id: target.clientId,
                kind: source.kind,
                text: source.text,
                // The copy references the same stored file or sticker (blueprint: a forward shares the file).
                file_id: source.file_id,
                sticker_id: source.sticker_id,
                poll_id: pollCopies.get(source.id) ?? null,
                // The first origin is kept; a channel's own posts are forwarded as from the channel (D-40).
                ...(source.forward_from_user_id || source.forward_from_chat_id
                  ? { forward_from_user_id: source.forward_from_user_id, forward_from_chat_id: source.forward_from_chat_id }
                  : fromAccess.type === 'channel'
                    ? { forward_from_chat_id: body.fromChatId }
                    : { forward_from_user_id: source.sender_id }),
              })),
            )
            .execute();
          const audience = await this.permissions.audienceOf(trx, auth.userId, access);
          for (const id of ids) {
            updates.addFor(audience, { kind: 'message.new', chatId: target.chatId, messageId: id });
          }
          createdIds.push(...ids);
          perChat.push([target.chatId, ids]);
        }
        return { createdIds, perChat };
      }).then(({ createdIds, perChat }) => {
        for (const [chatId, ids] of perChat) this.notifications.messagesCreated(chatId, ids, auth.userId);
        return createdIds;
      });
    } catch (error) {
      if (error instanceof DuplicateRequest) {
        const again = await this.database.db
          .selectFrom('app.message_requests')
          .selectAll()
          .where('sender_id', '=', auth.userId)
          .where('client_id', 'in', body.targets.map((target) => target.clientId))
          .execute();
        return this.replayForward(auth.userId, body, again);
      }
      throw error;
    }
    return this.orderedViews(auth.userId, created);
  }

  private async replayForward(
    viewerId: string,
    body: ForwardMessagesBody,
    stored: Array<{ client_id: string; kind: 'send' | 'forward'; conversation_id: string; message_ids: string[] }>,
  ): Promise<Message[]> {
    const byClientId = new Map(stored.map((row) => [row.client_id, row]));
    // A retry must repeat the same request exactly; a partly reused set of client ids is a mistake.
    const complete =
      stored.length === body.targets.length &&
      body.targets.every((target) => {
        const row = byClientId.get(target.clientId);
        return row && row.kind === 'forward' && row.conversation_id === target.chatId && row.message_ids.length === body.messageIds.length;
      });
    if (!complete) {
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
    }
    // Phase 9: a retry shows the copies only to someone still in each chat.
    const accesses = await this.permissions.chatAccesses(this.database.db, viewerId, stored.map((row) => row.conversation_id));
    if (stored.some((row) => !accesses.has(row.conversation_id))) {
      throw notFound();
    }
    return this.orderedViews(
      viewerId,
      stored.flatMap((row) => row.message_ids),
    );
  }

  private async orderedViews(viewerId: string, ids: string[]): Promise<Message[]> {
    const views = await this.visibleViews(this.database.db, viewerId, ids);
    const byId = new Map(views.map((view) => [view.id, view]));
    return ids.map((id) => byId.get(id)).filter((view): view is Message => view !== undefined);
  }

  /** Pin or unpin a message for both participants (P-22). Pinning needs the right to send. */
  async setPinned(auth: AuthContext, messageId: string, pinned: boolean): Promise<Message> {
    await this.limits.peerActions(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const message = await trx.selectFrom('app.messages').select(MESSAGE_COLUMNS).where('id', '=', messageId).executeTakeFirst();
      const access = message ? await this.permissions.findChatAccess(trx, auth.userId, message.conversation_id) : null;
      if (!message || !access) {
        throw notFound();
      }
      await this.assertVisibleInChat(trx, auth.userId, message.conversation_id, messageId);
      if (pinned) {
        if (message.deleted_at !== null) {
          throw notFound();
        }
        await this.assertCanPin(trx, auth.userId, access);
        const added = await trx
          .insertInto('app.message_pins')
          .values({ conversation_id: message.conversation_id, message_id: messageId, pinned_by: auth.userId })
          .onConflict((conflict) => conflict.columns(['conversation_id', 'message_id']).doNothing())
          .executeTakeFirst();
        if (Number(added.numInsertedOrUpdatedRows ?? 0) > 0) {
          updates.addFor(await this.audience(trx, await this.permissions.audienceOf(trx, auth.userId, access), messageId), {
            kind: 'message.pinned',
            chatId: message.conversation_id,
            messageId,
          });
        }
        return;
      }
      if (access.type !== 'private') {
        await this.assertCanPin(trx, auth.userId, access);
      }
      const removed = await trx.deleteFrom('app.message_pins').where('conversation_id', '=', message.conversation_id).where('message_id', '=', messageId).executeTakeFirst();
      if (Number(removed.numDeletedRows) > 0) {
        updates.addFor(await this.audience(trx, await this.permissions.audienceOf(trx, auth.userId, access), messageId), {
          kind: 'message.unpinned',
          chatId: message.conversation_id,
          messageId,
        });
      }
    });
    return this.viewOne(this.database.db, auth.userId, messageId);
  }

  /** Pinning needs the right to send in a private chat, and the pin permission (or admin right) in a group. */
  private async assertCanPin(db: Executor, userId: string, access: ChatAccess): Promise<void> {
    if (access.type === 'private') {
      await this.permissions.assertCanSend(db, userId, access.peerId!);
      return;
    }
    if (!this.permissions.may(access, 'pin_messages', 'pin_messages')) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ALLOWED');
    }
  }

  /** Chat history, oldest first, in pages of at most 50 (P-17). */
  async history(viewerId: string, chatId: string, query: { before?: number; after?: number; limit?: number }): Promise<Message[]> {
    const db = this.database.db;
    await this.permissions.chatAccess(db, viewerId, chatId);
    const limit = query.limit ?? MESSAGING_RULES.refetchPageSize;
    let builder = db
      .selectFrom('app.messages as m')
      .select(MESSAGE_COLUMNS.map((column) => `m.${column}` as const))
      .where('m.conversation_id', '=', chatId)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', viewerId))),
      );
    if (query.after !== undefined) {
      builder = builder.where('m.seq', '>', String(query.after)).orderBy('m.seq', 'asc');
    } else {
      if (query.before !== undefined) {
        builder = builder.where('m.seq', '<', String(query.before));
      }
      builder = builder.orderBy('m.seq', 'desc');
    }
    const rows = await builder.limit(limit).execute();
    rows.sort((a, b) => Number(a.seq) - Number(b.seq));
    return this.views.messages(db, viewerId, rows);
  }

  /** Pinned messages of a chat the viewer can still see, most recently pinned first. */
  async pins(viewerId: string, chatId: string): Promise<Message[]> {
    const db = this.database.db;
    await this.permissions.chatAccess(db, viewerId, chatId);
    const rows = await db
      .selectFrom('app.message_pins as p')
      .innerJoin('app.messages as m', 'm.id', 'p.message_id')
      .select(MESSAGE_COLUMNS.map((column) => `m.${column}` as const))
      .where('p.conversation_id', '=', chatId)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', viewerId))),
      )
      .orderBy('p.pinned_at', 'desc')
      .execute();
    return this.views.messages(db, viewerId, rows as MessageRow[]);
  }

  /**
   * In-chat search (step 3.7): whole words through full text and parts of words through trigrams, in one
   * chat the viewer is a member of, never messages deleted for both sides or hidden for the viewer.
   */
  async search(viewerId: string, chatId: string, q: string, before?: number): Promise<Message[]> {
    await this.limits.searches(viewerId);
    const db = this.database.db;
    await this.permissions.chatAccess(db, viewerId, chatId);
    let builder = db
      .selectFrom('app.messages as m')
      .select(MESSAGE_COLUMNS.map((column) => `m.${column}` as const))
      .where('m.conversation_id', '=', chatId)
      .where('m.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb(sql<string>`m.search_vector`, '@@', sql<string>`websearch_to_tsquery('simple', ${q})`),
          eb(sql<string>`m.text`, 'ilike', likePattern(q)),
        ]),
      )
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', viewerId))),
      );
    if (before !== undefined) {
      builder = builder.where('m.seq', '<', String(before));
    }
    const rows = await builder.orderBy('m.seq', 'desc').limit(MESSAGING_RULES.chatSearchPageSize).execute();
    return this.views.messages(db, viewerId, rows);
  }
}
