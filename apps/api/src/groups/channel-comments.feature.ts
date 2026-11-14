import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Executor } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';

/** While the tables are missing, look again this often (the owner may run the update while the site runs). */
const RECHECK_MS = 60 * 1000;

/** Postgres "undefined table": the comments database update (20261115120000) has not been run yet. */
export function missingTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '42P01';
}

/**
 * Whether comments on channel posts exist in this database, and the two facts other views need from them (which
 * channels have comments on, how many comments each post has).
 *
 * The site is deployed before the owner runs the database update, so the comment tables may be missing: then the
 * feature is unavailable and every other view behaves exactly as before (commentsEnabled and commentCount are null).
 * The tables are looked up with to_regclass, which never fails, so a missing table can never break a request or abort
 * a transaction; once present they are assumed to stay.
 */
@Injectable()
export class ChannelCommentsFeature {
  private present = false;
  private checkedAt = 0;

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async available(): Promise<boolean> {
    if (this.present) return true;
    if (this.checkedAt !== 0 && Date.now() - this.checkedAt < RECHECK_MS) return false;
    const { rows } = await sql<{ present: boolean }>`
      select (to_regclass('app.channel_comment_settings') is not null and to_regclass('app.channel_comments') is not null
        and to_regclass('audit.channel_comment_revisions') is not null) as present
    `.execute(this.database.db);
    this.present = rows[0]?.present === true;
    this.checkedAt = Date.now();
    return this.present;
  }

  /** A query found a table missing after all (it was removed): unavailable again until the next check. */
  markMissing(): void {
    this.present = false;
    this.checkedAt = Date.now();
  }

  /** The channels among `channelIds` that have comments on; null when the feature is unavailable. */
  async enabledChannels(db: Executor, channelIds: readonly string[]): Promise<Set<string> | null> {
    if (!(await this.available())) return null;
    const ids = [...new Set(channelIds)];
    if (ids.length === 0) return new Set();
    try {
      const rows = await db.selectFrom('app.channel_comment_settings').select('conversation_id').where('conversation_id', 'in', ids).where('enabled', '=', true).execute();
      return new Set(rows.map((row) => row.conversation_id));
    } catch (error) {
      if (missingTable(error) && !db.isTransaction) {
        this.markMissing();
        return null;
      }
      throw error;
    }
  }

  /**
   * Comment counts for channel posts, in ONE grouped query for a whole page of messages: for each post of a channel
   * with comments on, how many comments it has (0 when none). Posts of channels with comments off are left out. Null
   * when the feature is unavailable.
   */
  async counts(db: Executor, posts: ReadonlyArray<{ chatId: string; postId: string }>): Promise<Map<string, number> | null> {
    if (!(await this.available())) return null;
    const result = new Map<string, number>();
    if (posts.length === 0) return result;
    const chatIds = [...new Set(posts.map((post) => post.chatId))];
    const postIds = [...new Set(posts.map((post) => post.postId))];
    let rows: Array<{ chat_id: string; post_id: string | null; n: number }>;
    try {
      ({ rows } = await sql<{ chat_id: string; post_id: string | null; n: number }>`
        select s.conversation_id as chat_id, c.post_message_id as post_id, count(c.id)::int as n
        from app.channel_comment_settings s
        left join app.channel_comments c
          on c.conversation_id = s.conversation_id and c.deleted_at is null and c.post_message_id in (${sql.join(postIds)})
        where s.enabled and s.conversation_id in (${sql.join(chatIds)})
        group by s.conversation_id, c.post_message_id
      `.execute(db));
    } catch (error) {
      if (missingTable(error) && !db.isTransaction) {
        this.markMissing();
        return null;
      }
      throw error;
    }
    const enabled = new Set(rows.map((row) => row.chat_id));
    const byPost = new Map(rows.filter((row) => row.post_id !== null).map((row) => [row.post_id!, row.n]));
    for (const post of posts) {
      if (enabled.has(post.chatId)) result.set(post.postId, byPost.get(post.postId) ?? 0);
    }
    return result;
  }
}
