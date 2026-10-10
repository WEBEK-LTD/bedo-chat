import { Inject, Injectable } from '@nestjs/common';
import { MESSAGING_RULES, type SyncResponse, type Update, UPDATE_KINDS, type UpdateKind } from '@bedo/contracts';
import { DatabaseService } from '../database/database.service.js';
import { ChatsService } from './chats.service.js';
import { FoldersService } from './folders.service.js';
import { MessagesService } from './messages.service.js';

const KINDS: ReadonlySet<string> = new Set(UPDATE_KINDS);
const MESSAGE_KINDS: ReadonlySet<UpdateKind> = new Set([
  'message.new',
  'message.edited',
  'message.deleted',
  'message.pinned',
  'message.unpinned',
  'message.reactions',
  'message.poll',
]);

/**
 * Sync (P-17, blueprint: Sync): a device sends the last update seq it holds and gets everything after
 * it, with the current state of the chats and messages involved, built for this user through the same
 * permission checks as every other read. A device more than 1,000 updates behind, or behind the 30-day
 * log, is told to re-fetch instead.
 */
@Injectable()
export class SyncService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(FoldersService) private readonly folders: FoldersService,
  ) {}

  async currentSeq(userId: string): Promise<number> {
    const state = await this.database.db.selectFrom('app.user_sync_state').select('last_seq').where('user_id', '=', userId).executeTakeFirst();
    return Number(state?.last_seq ?? 0);
  }

  async since(userId: string, since: number): Promise<SyncResponse> {
    const db = this.database.db;
    const state = await db.selectFrom('app.user_sync_state').select(['last_seq', 'pruned_through_seq']).where('user_id', '=', userId).executeTakeFirst();
    const last = Number(state?.last_seq ?? 0);
    const pruned = Number(state?.pruned_through_seq ?? 0);
    if (since > last || since < pruned || last - since > MESSAGING_RULES.resyncThreshold) {
      return { seq: last, updates: [], hasMore: false, resync: true, chats: [], messages: [], folders: null };
    }
    const rows = await db
      .selectFrom('app.update_log')
      .select(['seq', 'kind', 'conversation_id', 'message_id', 'data'])
      .where('user_id', '=', userId)
      .where('seq', '>', String(since))
      .orderBy('seq')
      .limit(MESSAGING_RULES.syncPageSize)
      .execute();
    const updates: Update[] = rows
      .filter((row) => KINDS.has(row.kind))
      .map((row) => ({
        seq: Number(row.seq),
        kind: row.kind as UpdateKind,
        chatId: row.conversation_id,
        messageId: row.message_id,
        data: row.data,
      }));
    const seq = rows.length > 0 ? Number(rows[rows.length - 1]!.seq) : since;
    const chatIds = [...new Set(updates.map((update) => update.chatId).filter((id): id is string => id !== null))];
    const messageIds = [...new Set(updates.filter((update) => MESSAGE_KINDS.has(update.kind) && update.messageId).map((update) => update.messageId!))];
    const [chats, messages, folders] = await Promise.all([
      this.chats.summaries(db, userId, chatIds),
      this.messages.visibleViews(db, userId, messageIds),
      updates.some((update) => update.kind === 'folders') ? this.folders.list(db, userId) : Promise.resolve(null),
    ]);
    // Messages of chats the user is no longer allowed to read are never sent, whatever the log says.
    const allowedChats = new Set(chats.map((chat) => chat.id));
    return {
      seq,
      // "chat.removed" concerns a chat the user is no longer in: it is kept so their devices drop it.
      updates: updates.filter((update) => update.chatId === null || allowedChats.has(update.chatId) || update.kind === 'chat.removed'),
      hasMore: seq < last,
      resync: false,
      chats,
      messages: messages.filter((message) => allowedChats.has(message.chatId)),
      folders,
    };
  }
}
