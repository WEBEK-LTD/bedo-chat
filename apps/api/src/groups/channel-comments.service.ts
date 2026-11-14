import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { type ChannelComment, type ChannelCommentsResponse, type Chat, COMMENT_RULES, type CreateCommentBody } from '@bedo/contracts';
import type { ChannelCommentsTable, Database } from '@bedo/db';
import { type Selectable, sql, type Transaction } from 'kysely';
import type { Executor } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { ChatsService } from '../messaging/chats.service.js';
import { MessagingLimitsService } from '../messaging/messaging-limits.service.js';
import { type ChatAccess, PermissionService } from '../messaging/permissions.service.js';
import { UpdateLogService } from '../messaging/update-log.service.js';
import { ViewsService } from '../messaging/views.service.js';
import { ChannelCommentsFeature, missingTable } from './channel-comments.feature.js';

type CommentRow = Selectable<ChannelCommentsTable>;

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
const notAllowed = () => new AppError(HttpStatus.FORBIDDEN, 'NOT_ALLOWED');
const unavailable = () => new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'FEATURE_UNAVAILABLE');

/** Raised inside the transaction when another request with the same client id stored the comment first. */
class DuplicateRequest extends Error {}

const COLUMNS = [
  'id',
  'conversation_id',
  'post_message_id',
  'author_id',
  'client_id',
  'text',
  'reply_to_comment_id',
  'created_at',
  'edited_at',
  'deleted_at',
  'deleted_by',
] as const;

/** The post and the viewer's access to its channel. */
interface PostContext {
  postId: string;
  access: ChatAccess;
  enabled: boolean;
}

/**
 * Comments on channel posts (migration 20261115120000). Off in every channel until its owner, or an admin with the right
 * to change the channel info, turns them on. While they are on, every member of the channel who can see a post (and
 * whose account may send) comments on it; the author edits their comment, and the author, the owner or an admin with
 * the right to delete messages deletes it. Deleting keeps the row and its text goes to the history with every edit
 * (D-17). Comments count towards the message rate limit (D-30).
 *
 * Blocks work as in groups: they do not stop anyone from commenting, and an author's photo follows their privacy and
 * blocks (as on group messages). Comments make no update log entries and no notifications (a channel has up to 5,000
 * subscribers); the apps fetch them while a post's comments are open.
 *
 * Before the owner runs the database update the tables do not exist: every route here answers 503
 * FEATURE_UNAVAILABLE and nothing else changes.
 */
@Injectable()
export class ChannelCommentsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(ViewsService) private readonly views: ViewsService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(ChannelCommentsFeature) private readonly feature: ChannelCommentsFeature,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Runs `work` only when the feature is available; a missing table found on the way is reported the same way. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    if (!(await this.feature.available())) throw unavailable();
    try {
      return await work();
    } catch (error) {
      if (missingTable(error)) {
        this.feature.markMissing();
        throw unavailable();
      }
      throw error;
    }
  }

  private async enabled(db: Executor, channelId: string): Promise<boolean> {
    const row = await db.selectFrom('app.channel_comment_settings').select('enabled').where('conversation_id', '=', channelId).executeTakeFirst();
    return row?.enabled ?? false;
  }

  /** A post of a channel the viewer is in and can see (not deleted, not hidden for them); 404 otherwise. */
  private async post(db: Executor, viewerId: string, postId: string): Promise<PostContext> {
    const post = await db
      .selectFrom('app.messages as m')
      .select(['m.id', 'm.conversation_id', 'm.deleted_at'])
      .where('m.id', '=', postId)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', viewerId))),
      )
      .executeTakeFirst();
    if (!post || post.deleted_at !== null) throw notFound();
    const access = await this.permissions.findChatAccess(db, viewerId, post.conversation_id);
    if (!access || access.type !== 'channel') throw notFound();
    return { postId, access, enabled: await this.enabled(db, post.conversation_id) };
  }

  /** The account may send (P-26: not suspended, banned or deleted). */
  private async maySend(db: Executor, userId: string): Promise<boolean> {
    const status = await this.permissions.userStatus(db, userId);
    return status === 'active' || status === 'deletion_requested';
  }

  private async assertMaySend(db: Executor, userId: string): Promise<void> {
    if (!(await this.maySend(db, userId))) throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
  }

  /** Comment views for one viewer (authors as the viewer may see them; replies with a short preview). */
  private async commentViews(db: Executor, viewerId: string, access: ChatAccess, rows: readonly CommentRow[]): Promise<ChannelComment[]> {
    if (rows.length === 0) return [];
    const replyIds = [...new Set(rows.map((row) => row.reply_to_comment_id).filter((id): id is string => id !== null))];
    const replies = replyIds.length > 0 ? await db.selectFrom('app.channel_comments').select(['id', 'author_id', 'text', 'deleted_at']).where('id', 'in', replyIds).execute() : [];
    const authors = await this.views.peers(db, viewerId, [...rows.map((row) => row.author_id), ...replies.map((reply) => reply.author_id)]);
    const replyById = new Map(replies.map((reply) => [reply.id, reply]));
    const mayDeleteOthers = this.permissions.hasRight(access, 'delete_messages');
    return rows.map((row) => {
      const author = authors.get(row.author_id);
      const reply = row.reply_to_comment_id ? replyById.get(row.reply_to_comment_id) : undefined;
      const mine = row.author_id === viewerId;
      return {
        id: row.id,
        chatId: row.conversation_id,
        postId: row.post_message_id,
        author: { id: row.author_id, displayName: author?.displayName ?? '', photoUrl: author?.photoUrl ?? null, deleted: author?.deleted ?? false },
        clientId: row.client_id,
        text: row.text ?? '',
        replyTo: reply
          ? {
              id: reply.id,
              authorName: authors.get(reply.author_id)?.displayName ?? '',
              text: reply.deleted_at !== null || reply.text === null ? null : Array.from(reply.text).slice(0, COMMENT_RULES.replyPreviewLength).join(''),
            }
          : null,
        createdAt: new Date(row.created_at).toISOString(),
        editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
        mine,
        canDelete: mine || mayDeleteOthers,
      };
    });
  }

  private async viewOne(viewerId: string, commentId: string): Promise<ChannelComment> {
    const db = this.db;
    const row = await db.selectFrom('app.channel_comments').select(COLUMNS).where('id', '=', commentId).executeTakeFirst();
    const access = row ? await this.permissions.findChatAccess(db, viewerId, row.conversation_id) : null;
    if (!row || !access || row.deleted_at !== null) throw notFound();
    const [view] = await this.commentViews(db, viewerId, access, [row]);
    return view!;
  }

  // ------------------------------------------------------------------------------------------ setting

  /** Turn comments on or off for a channel: its owner, or an admin with the right to change the channel info. */
  async setEnabled(auth: AuthContext, channelId: string, enabled: boolean): Promise<Chat> {
    await this.guarded(async () => {
      await this.limits.groupActions(auth.userId);
      await this.updateLog.run(async (trx, updates) => {
        const access = await this.permissions.chatAccess(trx, auth.userId, channelId);
        if (access.type !== 'channel') throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
        this.permissions.assertRight(access, 'change_info');
        // The channel row first (the lock order of every chat change), so two changes run one at a time.
        await trx.selectFrom('app.conversations').select('id').where('id', '=', channelId).forUpdate().executeTakeFirst();
        if ((await this.enabled(trx, channelId)) === enabled) return;
        await trx
          .insertInto('app.channel_comment_settings')
          .values({ conversation_id: channelId, enabled, updated_by: auth.userId, updated_at: sql`now()` })
          .onConflict((conflict) => conflict.column('conversation_id').doUpdateSet({ enabled, updated_by: auth.userId, updated_at: sql`now()` }))
          .execute();
        // Like any change of the channel's info: members' devices fetch its summary again.
        updates.addFor(await this.permissions.memberIds(trx, channelId), { kind: 'chat.info', chatId: channelId });
      });
    });
    return this.chats.get(auth.userId, channelId);
  }

  // ------------------------------------------------------------------------------------------ comments

  /** A post's comments, oldest first, 50 per page (deleted ones left out). */
  async list(viewerId: string, postId: string, after?: string): Promise<ChannelCommentsResponse> {
    return this.guarded(async () => {
      const db = this.db;
      const post = await this.post(db, viewerId, postId);
      if (!post.enabled) throw notAllowed();
      const [rows, total, maySend] = await Promise.all([
        db
          .selectFrom('app.channel_comments')
          .select(COLUMNS)
          .where('post_message_id', '=', postId)
          .where('deleted_at', 'is', null)
          .$if(after !== undefined, (query) => query.where('id', '>', after!))
          .orderBy('id')
          .limit(COMMENT_RULES.pageSize + 1)
          .execute(),
        db
          .selectFrom('app.channel_comments')
          .select(sql<number>`count(*)::int`.as('n'))
          .where('post_message_id', '=', postId)
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow(),
        this.maySend(db, viewerId),
      ]);
      const page = rows.slice(0, COMMENT_RULES.pageSize);
      return {
        comments: await this.commentViews(db, viewerId, post.access, page),
        nextAfter: rows.length > COMMENT_RULES.pageSize ? page[page.length - 1]!.id : null,
        count: total.n,
        canComment: maySend,
      };
    });
  }

  private async existing(authorId: string, clientId: string) {
    return this.db.selectFrom('app.channel_comments').select(['id', 'post_message_id']).where('author_id', '=', authorId).where('client_id', '=', clientId).executeTakeFirst();
  }

  /** A stored comment answers a retry with the same client id, when it was for the same post. */
  private async replay(viewerId: string, stored: { id: string; post_message_id: string }, postId: string): Promise<ChannelComment> {
    if (stored.post_message_id !== postId) throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
    return this.viewOne(viewerId, stored.id);
  }

  async create(auth: AuthContext, postId: string, body: CreateCommentBody): Promise<ChannelComment> {
    return this.guarded(async () => {
      const previous = await this.existing(auth.userId, body.clientId);
      if (previous) return this.replay(auth.userId, previous, postId);
      // D-30: a comment counts as a message.
      await this.limits.messages(auth.userId);
      let id: string;
      try {
        id = await this.db.transaction().execute(async (trx) => {
          const post = await this.post(trx, auth.userId, postId);
          if (!post.enabled) throw notAllowed();
          await this.assertMaySend(trx, auth.userId);
          if (body.replyToId) {
            const target = await trx
              .selectFrom('app.channel_comments')
              .select('id')
              .where('id', '=', body.replyToId)
              .where('post_message_id', '=', postId)
              .where('deleted_at', 'is', null)
              .executeTakeFirst();
            if (!target) throw notFound();
          }
          const inserted = await trx
            .insertInto('app.channel_comments')
            .values({
              conversation_id: post.access.conversationId,
              post_message_id: postId,
              author_id: auth.userId,
              client_id: body.clientId,
              text: body.text,
              reply_to_comment_id: body.replyToId ?? null,
            })
            .onConflict((conflict) => conflict.columns(['author_id', 'client_id']).doNothing())
            .returning('id')
            .executeTakeFirst();
          if (!inserted) throw new DuplicateRequest();
          return inserted.id;
        });
      } catch (error) {
        if (error instanceof DuplicateRequest) {
          const stored = await this.existing(auth.userId, body.clientId);
          if (stored) return this.replay(auth.userId, stored, postId);
        }
        throw error;
      }
      return this.viewOne(auth.userId, id);
    });
  }

  /** The comment, locked for a change; 404 when it does not exist, was deleted, or its channel is not the viewer's. */
  private async lock(trx: Transaction<Database>, viewerId: string, commentId: string): Promise<{ row: CommentRow; access: ChatAccess }> {
    const row = await trx.selectFrom('app.channel_comments').select(COLUMNS).where('id', '=', commentId).forUpdate().executeTakeFirst();
    const access = row ? await this.permissions.findChatAccess(trx, viewerId, row.conversation_id) : null;
    if (!row || !access || row.deleted_at !== null) throw notFound();
    return { row, access };
  }

  /** Edit one's own comment while comments are on. The previous text goes to the history (D-17). */
  async edit(auth: AuthContext, commentId: string, text: string): Promise<ChannelComment> {
    return this.guarded(async () => {
      // D-30: edits count as messages.
      await this.limits.messages(auth.userId);
      await this.db.transaction().execute(async (trx) => {
        const { row } = await this.lock(trx, auth.userId, commentId);
        if (row.author_id !== auth.userId) throw notFound();
        const post = await this.post(trx, auth.userId, row.post_message_id);
        if (!post.enabled) throw notAllowed();
        await this.assertMaySend(trx, auth.userId);
        if (row.text === text) return;
        await trx
          .insertInto('audit.channel_comment_revisions')
          .values({
            comment_id: row.id,
            conversation_id: row.conversation_id,
            post_message_id: row.post_message_id,
            author_id: row.author_id,
            action: 'edited',
            previous_text: row.text!,
            new_text: text,
            actor_type: 'user',
            actor_id: auth.userId,
            session_id: auth.sessionId,
          })
          .execute();
        await trx.updateTable('app.channel_comments').set({ text, edited_at: sql`now()` }).where('id', '=', row.id).execute();
      });
      return this.viewOne(auth.userId, commentId);
    });
  }

  /**
   * Delete a comment: its author, or the channel's owner or an admin with the right to delete messages (also while
   * comments are off). The row stays; its text goes to the history (D-17).
   */
  async delete(auth: AuthContext, commentId: string): Promise<void> {
    await this.guarded(async () => {
      await this.limits.peerActions(auth.userId);
      await this.db.transaction().execute(async (trx) => {
        const { row, access } = await this.lock(trx, auth.userId, commentId);
        if (row.author_id !== auth.userId && !this.permissions.hasRight(access, 'delete_messages')) throw notAllowed();
        await trx
          .insertInto('audit.channel_comment_revisions')
          .values({
            comment_id: row.id,
            conversation_id: row.conversation_id,
            post_message_id: row.post_message_id,
            author_id: row.author_id,
            action: 'deleted',
            previous_text: row.text!,
            actor_type: 'user',
            actor_id: auth.userId,
            session_id: auth.sessionId,
          })
          .execute();
        await trx.updateTable('app.channel_comments').set({ text: null, deleted_at: sql`now()`, deleted_by: auth.userId }).where('id', '=', row.id).execute();
      });
    });
  }
}
