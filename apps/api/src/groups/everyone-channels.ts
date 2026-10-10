import { CHANNEL_RULES } from '@bedo/contracts';
import { sql } from 'kysely';
import type { Actor, Executor } from '../audit/audit.service.js';

export interface EveryoneJoin {
  conversationId: string;
  userId: string;
}

/**
 * D-52: channels for everyone in the academy. Adds every account that is missing from an academy-wide channel as a
 * subscriber, with the membership history, in one statement. Scope it to one channel (the switch was just turned on),
 * one account (it was just created) or neither (the site's minute call catches up on everything else).
 *
 * Not added: accounts that are not active (suspended, banned, deleted), people removed from the channel (chat_bans),
 * and people who left it themselves. A channel stops growing at its subscriber limit.
 */
export async function joinEveryoneChannels(db: Executor, scope: { chatId?: string; userId?: string }, actor: Actor): Promise<EveryoneJoin[]> {
  const { rows } = await sql<{ conversation_id: string; user_id: string }>`
    with candidates as (
      select c.id as conversation_id, u.id as user_id,
             row_number() over (partition by c.id order by u.created_at, u.id) as position,
             (select count(*) from app.conversation_members m where m.conversation_id = c.id) as current_count
      from app.conversations c
      join app.group_settings s on s.conversation_id = c.id and s.academy_wide
      join app.users u on u.status in ('active', 'deletion_requested')
      where c.type = 'channel'
        and c.deleted_at is null
        ${scope.chatId ? sql`and c.id = ${scope.chatId}` : sql``}
        ${scope.userId ? sql`and u.id = ${scope.userId}` : sql``}
        and not exists (select 1 from app.conversation_members m where m.conversation_id = c.id and m.user_id = u.id)
        and not exists (select 1 from app.chat_bans b where b.conversation_id = c.id and b.user_id = u.id)
        and not exists (
          select 1 from audit.membership_events e where e.conversation_id = c.id and e.user_id = u.id and e.action = 'left'
        )
    ),
    added as (
      insert into app.conversation_members (conversation_id, user_id, role)
      select conversation_id, user_id, 'subscriber' from candidates
      where current_count + position <= ${CHANNEL_RULES.maxSubscribers}
      on conflict (conversation_id, user_id) do nothing
      returning conversation_id, user_id
    ),
    history as (
      insert into audit.membership_events (conversation_id, user_id, action, actor_type, actor_id, details)
      select conversation_id, user_id, 'added', ${actor.type}, ${actor.id}::uuid, '{"everyone": true}'::jsonb from added
    )
    select conversation_id, user_id from added
  `.execute(db);
  return rows.map((row) => ({ conversationId: row.conversation_id, userId: row.user_id }));
}
