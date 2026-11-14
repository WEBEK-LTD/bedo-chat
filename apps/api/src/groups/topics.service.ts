import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { type GroupTopic, type GroupTopicsResponse, TOPIC_RULES } from '@bedo/contracts';
import { sql } from 'kysely';
import type { Executor } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { MessagingLimitsService } from '../messaging/messaging-limits.service.js';
import { type ChatAccess, PermissionService } from '../messaging/permissions.service.js';
import { isMissingTopicsSchema, TopicsSchemaService } from '../messaging/topics-schema.service.js';
import { type UpdateCollector, UpdateLogService } from '../messaging/update-log.service.js';

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
const notAllowed = () => new AppError(HttpStatus.FORBIDDEN, 'NOT_ALLOWED');
const invalid = () => new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
/** The database update for topics has not been run yet. */
const unavailable = () => new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'FEATURE_UNAVAILABLE');

interface TopicRow {
  id: string;
  conversation_id: string;
  title: string;
  color: number;
  created_at: Date;
  closed_at: Date | null;
  last_message_at: Date | null;
  message_count: string | number;
}

/** Which messages of a chat a history page shows (D-63): all of them, General's (no topic) or one topic's. */
export type TopicFilter = { kind: 'all' } | { kind: 'general' } | { kind: 'topic'; topicId: string };

/**
 * D-63: topics in groups. The owner, or an admin with the right to change the group's info, turns topics on or off and
 * creates, renames, closes and reopens them (never deletes). Members post in open topics; in a closed topic only the
 * owner and admins post. Everything here first asks TopicsSchemaService whether the database update exists: until it
 * does, the list says "not available", changes answer FEATURE_UNAVAILABLE, and sending works exactly as before (a
 * message without a topic never touches the new tables or column).
 */
@Injectable()
export class TopicsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
    @Inject(TopicsSchemaService) private readonly schema: TopicsSchemaService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Owner, or admin with change_info (a member's own change_info permission is not enough). */
  canManage(access: ChatAccess): boolean {
    return access.type === 'group' && this.permissions.hasRight(access, 'change_info');
  }

  /** Runs a topic query; a database without the update (after all) answers FEATURE_UNAVAILABLE. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isMissingTopicsSchema(error)) {
        this.schema.markMissing();
        throw unavailable();
      }
      throw error;
    }
  }

  /** The viewer's access to a group (a channel or private chat is no group: 404, as for other group routes). */
  private async groupAccess(db: Executor, viewerId: string, groupId: string): Promise<ChatAccess> {
    const access = await this.permissions.chatAccess(db, viewerId, groupId);
    if (access.type !== 'group') throw notFound();
    return access;
  }

  /** Which of these chats have topics on (none while the update is missing). Never throws for a missing update. */
  async enabledChats(db: Executor, chatIds: readonly string[]): Promise<Set<string>> {
    if (chatIds.length === 0 || !(await this.schema.available())) return new Set();
    try {
      const rows = await db.selectFrom('app.group_topic_settings').select('conversation_id').where('conversation_id', 'in', [...chatIds]).where('enabled', '=', true).execute();
      return new Set(rows.map((row) => row.conversation_id));
    } catch (error) {
      if (isMissingTopicsSchema(error)) {
        this.schema.markMissing();
        return new Set();
      }
      throw error;
    }
  }

  private async isEnabled(db: Executor, groupId: string): Promise<boolean> {
    const row = await db.selectFrom('app.group_topic_settings').select('enabled').where('conversation_id', '=', groupId).executeTakeFirst();
    return row?.enabled ?? false;
  }

  private static view(row: TopicRow): GroupTopic {
    return {
      id: row.id,
      chatId: row.conversation_id,
      title: row.title,
      color: row.color,
      closed: row.closed_at !== null,
      createdAt: new Date(row.created_at).toISOString(),
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      messageCount: Number(row.message_count),
    };
  }

  /**
   * A group's topics with their last message time and message count: per topic, the newest message by seq and a count,
   * both through the partial index on (conversation_id, topic_id, seq).
   */
  private async topicRows(db: Executor, groupId: string, topicId?: string): Promise<TopicRow[]> {
    const { rows } = await sql<TopicRow>`
      select t.id, t.conversation_id, t.title, t.color, t.created_at, t.closed_at,
        (select m.created_at from app.messages m
         where m.conversation_id = t.conversation_id and m.topic_id = t.id
         order by m.seq desc limit 1) as last_message_at,
        (select count(*) from app.messages m where m.conversation_id = t.conversation_id and m.topic_id = t.id) as message_count
      from app.group_topics t
      where t.conversation_id = ${groupId} ${topicId ? sql`and t.id = ${topicId}` : sql``}
      order by (t.closed_at is not null), t.created_at, t.id
    `.execute(db);
    return rows;
  }

  // ------------------------------------------------------------------------------------------ list

  async list(viewerId: string, groupId: string): Promise<GroupTopicsResponse> {
    const access = await this.groupAccess(this.db, viewerId, groupId);
    const canManage = this.canManage(access);
    if (!(await this.schema.available())) return { available: false, enabled: false, canManage: false, topics: [] };
    return this.guarded(async () => {
      const [enabled, rows] = await Promise.all([this.isEnabled(this.db, groupId), this.topicRows(this.db, groupId)]);
      return { available: true, enabled, canManage, topics: rows.map(TopicsService.view) };
    });
  }

  // --------------------------------------------------------------------------------------- changes

  /** Every change: the update must exist, the viewer must manage topics of this group; members hear of it. */
  private async change<T>(auth: AuthContext, groupId: string, work: (trx: Executor, access: ChatAccess, updates: UpdateCollector) => Promise<T>): Promise<T> {
    await this.limits.groupActions(auth.userId);
    if (!(await this.schema.available())) throw unavailable();
    return this.guarded(() =>
      this.updateLog.run(async (trx, updates) => {
        const access = await this.groupAccess(trx, auth.userId, groupId);
        if (!this.canManage(access)) throw notAllowed();
        const result = await work(trx, access, updates);
        // Members' devices fetch the group's summary (topicsEnabled) and, when shown, its topics again.
        updates.addFor(await this.permissions.memberIds(trx, groupId), { kind: 'chat.info', chatId: groupId });
        return result;
      }),
    );
  }

  async setEnabled(auth: AuthContext, groupId: string, enabled: boolean): Promise<GroupTopicsResponse> {
    await this.change(auth, groupId, async (trx) => {
      await trx
        .insertInto('app.group_topic_settings')
        .values({ conversation_id: groupId, enabled, updated_by: auth.userId })
        .onConflict((conflict) => conflict.column('conversation_id').doUpdateSet({ enabled, updated_by: auth.userId, updated_at: sql`now()` }))
        .execute();
    });
    return this.list(auth.userId, groupId);
  }

  async create(auth: AuthContext, groupId: string, body: { title: string; color: number }): Promise<GroupTopic> {
    const id = await this.change(auth, groupId, async (trx) => {
      // One creation at a time per group, so the limit holds.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`group-topics:${groupId}`}, 0))`.execute(trx);
      if (!(await this.isEnabled(trx, groupId))) throw invalid();
      const count = await trx.selectFrom('app.group_topics').select(sql<number>`count(*)::int`.as('n')).where('conversation_id', '=', groupId).executeTakeFirstOrThrow();
      if (count.n >= TOPIC_RULES.maxTopicsPerGroup) throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
      const row = await trx
        .insertInto('app.group_topics')
        .values({ conversation_id: groupId, title: body.title, color: body.color, created_by: auth.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    return this.one(groupId, id);
  }

  async update(auth: AuthContext, groupId: string, topicId: string, body: { title?: string | undefined; color?: number | undefined }): Promise<GroupTopic> {
    await this.change(auth, groupId, async (trx) => {
      const updated = await trx
        .updateTable('app.group_topics')
        .set({ ...(body.title !== undefined ? { title: body.title } : {}), ...(body.color !== undefined ? { color: body.color } : {}) })
        .where('id', '=', topicId)
        .where('conversation_id', '=', groupId)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) throw notFound();
    });
    return this.one(groupId, topicId);
  }

  /** Close (only the owner and admins post in it) or reopen. */
  async setClosed(auth: AuthContext, groupId: string, topicId: string, closed: boolean): Promise<GroupTopic> {
    await this.change(auth, groupId, async (trx) => {
      const topic = await trx.selectFrom('app.group_topics').select(['id', 'closed_at']).where('id', '=', topicId).where('conversation_id', '=', groupId).forUpdate().executeTakeFirst();
      if (!topic) throw notFound();
      if ((topic.closed_at !== null) === closed) return;
      await trx
        .updateTable('app.group_topics')
        .set(closed ? { closed_at: sql`now()`, closed_by: auth.userId } : { closed_at: null, closed_by: null })
        .where('id', '=', topicId)
        .execute();
    });
    return this.one(groupId, topicId);
  }

  private async one(groupId: string, topicId: string): Promise<GroupTopic> {
    const [row] = await this.guarded(() => this.topicRows(this.db, groupId, topicId));
    if (!row) throw notFound();
    return TopicsService.view(row);
  }

  // ---------------------------------------------------------------------------- sending, history

  /**
   * The topic a new message goes into (null: General), checked inside the send's transaction. Without a topic and
   * without a reply nothing is read (so sending works unchanged before the update). A topic needs a group with topics
   * on, the topic in that group, and either an open topic or the owner or an admin as sender; a reply goes into the
   * topic of the message it answers and may not name another one.
   */
  async topicForSend(trx: Executor, access: ChatAccess, chatId: string, topicId: string | undefined, replyToId: string | undefined): Promise<string | null> {
    if (topicId === undefined && replyToId === undefined) return null;
    if (access.type !== 'group' || !(await this.schema.available())) {
      if (topicId !== undefined) throw invalid();
      return null;
    }
    return this.guarded(async () => {
      if (!(await this.isEnabled(trx, chatId))) {
        // Topics off: everything goes to General, and naming a topic is refused.
        if (topicId !== undefined) throw invalid();
        return null;
      }
      let target = topicId ?? null;
      if (replyToId !== undefined) {
        const reply = await trx.selectFrom('app.messages').select('topic_id').where('id', '=', replyToId).where('conversation_id', '=', chatId).executeTakeFirst();
        // A missing reply is answered by the send's own check (404).
        const replyTopic = reply?.topic_id ?? null;
        if (reply && topicId !== undefined && replyTopic !== topicId) throw invalid();
        if (reply) target = replyTopic;
      }
      if (target === null) return null;
      const topic = await trx.selectFrom('app.group_topics').select(['conversation_id', 'closed_at']).where('id', '=', target).executeTakeFirst();
      if (!topic || topic.conversation_id !== chatId) throw invalid();
      if (topic.closed_at !== null && !this.permissions.isStaff(access)) throw notAllowed();
      return target;
    });
  }

  /** The history filter for `?topicId=`: only in groups, only once the update exists, and only this group's topics. */
  async historyFilter(db: Executor, access: ChatAccess, topicId: string | undefined): Promise<TopicFilter> {
    if (topicId === undefined) return { kind: 'all' };
    if (access.type !== 'group') throw invalid();
    if (!(await this.schema.available())) throw unavailable();
    if (topicId === 'general') return { kind: 'general' };
    const topic = await this.guarded(() => db.selectFrom('app.group_topics').select('conversation_id').where('id', '=', topicId).executeTakeFirst());
    if (!topic || topic.conversation_id !== access.conversationId) throw notFound();
    return { kind: 'topic', topicId };
  }
}
