import { Inject, Injectable } from '@nestjs/common';
import { type GlobalSearchQuery, type GlobalSearchResponse, MEDIA_FILTER_KINDS, SEARCH_RULES } from '@bedo/contracts';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { likePattern } from './messages.service.js';
import { MessagingLimitsService } from './messaging-limits.service.js';
import { MESSAGE_COLUMNS, ViewsService } from './views.service.js';

/**
 * Global search (Phase 8, D-42; blueprint: Search §10). Postgres full text (whole words) and trigram matching
 * (parts of words, file names) behind this one service, so a dedicated engine can replace it later without changing
 * the apps. Access filtering comes first: the query starts from the user's own memberships, in chats that still exist,
 * and leaves out messages deleted for both sides or hidden for the user. Results are built by the same view code as
 * chat history, so a channel's posts never show who posted to subscribers, and filtering by sender is refused there.
 */
@Injectable()
export class SearchService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ViewsService) private readonly views: ViewsService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
  ) {}

  async search(viewerId: string, query: GlobalSearchQuery): Promise<GlobalSearchResponse> {
    await this.limits.searches(viewerId);
    const db = this.database.db;
    let builder = db
      .selectFrom('app.messages as m')
      .innerJoin('app.conversation_members as me', (join) => join.onRef('me.conversation_id', '=', 'm.conversation_id').on('me.user_id', '=', viewerId))
      .innerJoin('app.conversations as c', 'c.id', 'm.conversation_id')
      .leftJoin('app.files as f', 'f.id', 'm.file_id')
      .select(MESSAGE_COLUMNS.map((column) => `m.${column}` as const))
      .where('c.deleted_at', 'is', null)
      .where('m.deleted_at', 'is', null)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', viewerId))),
      );
    if (query.q) {
      const pattern = likePattern(query.q);
      builder = builder.where((eb) =>
        eb.or([
          eb(sql<string>`m.search_vector`, '@@', sql<string>`websearch_to_tsquery('simple', ${query.q})`),
          eb('m.text', 'ilike', pattern),
          eb('f.file_name', 'ilike', pattern),
        ]),
      );
    }
    if (query.kind !== 'messages') {
      builder = builder.where('f.kind', 'in', [...MEDIA_FILTER_KINDS[query.kind]]);
    }
    if (query.chatId) builder = builder.where('m.conversation_id', '=', query.chatId);
    if (query.fromUserId) {
      // D-40: in a channel only its owner and admins know who posted, so nobody else can search by sender there.
      builder = builder.where('m.sender_id', '=', query.fromUserId).where((eb) => eb.or([eb('c.type', '<>', 'channel'), eb('me.role', 'in', ['owner', 'admin'])]));
    }
    if (query.after) builder = builder.where('m.created_at', '>=', new Date(query.after));
    if (query.before) builder = builder.where('m.created_at', '<', new Date(query.before));
    if (query.cursor) builder = builder.where('m.id', '<', query.cursor);
    const rows = await builder.orderBy('m.id', 'desc').limit(SEARCH_RULES.pageSize + 1).execute();
    const page = rows.slice(0, SEARCH_RULES.pageSize);
    return {
      messages: await this.views.messages(db, viewerId, page),
      nextCursor: rows.length > SEARCH_RULES.pageSize ? page[page.length - 1]!.id : null,
    };
  }
}
