import { Injectable } from '@nestjs/common';
import { GROUP_RULES } from '@bedo/contracts';
import { sql } from 'kysely';
import type { Executor } from '../audit/audit.service.js';

/** @username as typed in a message (usernames: 5-32 letters, digits or underscores, starting with a letter). */
const MENTION = /(^|[^A-Za-z0-9_@])@([A-Za-z][A-Za-z0-9_]{4,31})(?![A-Za-z0-9_])/g;

export function mentionedUsernames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    names.add(match[2]!.toLowerCase());
    if (names.size >= GROUP_RULES.maxMentions) break;
  }
  return [...names];
}

/**
 * Mentions (Phase 5): an @username in a group message that names a member of that group is recorded, so the member
 * sees it highlighted and (Phase 7) is notified. Names of non-members stay plain text; nothing tells the sender which.
 */
@Injectable()
export class MentionsService {
  async record(db: Executor, conversationId: string, messageId: string, text: string): Promise<void> {
    const names = mentionedUsernames(text);
    if (names.length === 0) {
      return;
    }
    await sql`
      insert into app.message_mentions (message_id, conversation_id, user_id)
      select ${messageId}::uuid, ${conversationId}::uuid, u.id
      from app.users u
      join app.conversation_members m on m.user_id = u.id and m.conversation_id = ${conversationId}
      where lower(u.username::text) in (${sql.join(names)})
      on conflict do nothing
    `.execute(db);
  }

  /** Which of these messages mention the viewer. */
  async mentioning(db: Executor, viewerId: string, messageIds: readonly string[]): Promise<Set<string>> {
    if (messageIds.length === 0) {
      return new Set();
    }
    const rows = await db.selectFrom('app.message_mentions').select('message_id').where('user_id', '=', viewerId).where('message_id', 'in', [...new Set(messageIds)]).execute();
    return new Set(rows.map((row) => row.message_id));
  }
}
