import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Message, Poll, PollInput, PublicUser } from '@bedo/contracts';
import type { Database } from '@bedo/db';
import { sql, type Transaction } from 'kysely';
import type { Executor } from '../audit/audit.service.js';
import { AccountsService } from '../auth/accounts.service.js';
import type { AuthContext } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { MessagingLimitsService } from '../messaging/messaging-limits.service.js';
import { type ChatAccess, PermissionService } from '../messaging/permissions.service.js';
import { UpdateLogService } from '../messaging/update-log.service.js';

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');

/**
 * Polls and quizzes (Phase 5). A member sees the counts only after voting or once the poll is closed, and a quiz's
 * answer the same way; who voted is never part of a poll's view, and anonymous polls never reveal it at all. In a
 * group whose member list is hidden, only owners and admins may see the voters of a non-anonymous poll (O-03).
 */
@Injectable()
export class PollsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {}

  async create(trx: Transaction<Database>, conversationId: string, userId: string, input: PollInput): Promise<string> {
    const row = await trx
      .insertInto('app.polls')
      .values({
        conversation_id: conversationId,
        created_by: userId,
        question: input.question,
        options: input.options,
        kind: input.kind,
        anonymous: input.anonymous,
        multiple: input.kind === 'quiz' ? false : input.multiple,
        correct_option: input.kind === 'quiz' ? (input.correctOption ?? 0) : null,
        explanation: input.kind === 'quiz' ? (input.explanation ?? null) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /**
   * Phase 9: a forwarded poll is a new poll with the same question and options, belonging to the chat it is
   * forwarded to (its own votes, voters and closing), so nobody reaches the original's voters or closes it from
   * another chat.
   */
  async copy(trx: Transaction<Database>, pollId: string, conversationId: string, userId: string): Promise<string> {
    const source = await trx.selectFrom('app.polls').selectAll().where('id', '=', pollId).executeTakeFirstOrThrow();
    const row = await trx
      .insertInto('app.polls')
      .values({
        conversation_id: conversationId,
        created_by: userId,
        question: source.question,
        options: source.options,
        kind: source.kind,
        anonymous: source.anonymous,
        multiple: source.multiple,
        correct_option: source.correct_option,
        explanation: source.explanation,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Who hears that a poll's votes changed: everyone in the chat, but in a channel only the voter and the staff (D-43). */
  private async voteAudience(db: Executor, actorId: string, access: ChatAccess): Promise<string[]> {
    if (access.type === 'channel') {
      return [...new Set([actorId, ...(await this.permissions.staffIds(db, access.conversationId))])];
    }
    return this.permissions.audienceOf(db, actorId, access);
  }

  async views(db: Executor, viewerId: string, pollIds: readonly string[]): Promise<Map<string, Poll>> {
    const ids = [...new Set(pollIds)];
    const result = new Map<string, Poll>();
    if (ids.length === 0) {
      return result;
    }
    const [polls, counts, mine] = await Promise.all([
      db.selectFrom('app.polls').selectAll().where('id', 'in', ids).execute(),
      sql<{ poll_id: string; option: number; votes: string; voters: string }>`
        select v.poll_id, o.option, count(*) as votes,
          (select count(*) from app.poll_votes t where t.poll_id = v.poll_id) as voters
        from app.poll_votes v cross join lateral unnest(v.options) as o(option)
        where v.poll_id in (${sql.join(ids)})
        group by v.poll_id, o.option
      `.execute(db),
      db.selectFrom('app.poll_votes').select(['poll_id', 'options']).where('user_id', '=', viewerId).where('poll_id', 'in', ids).execute(),
    ]);
    const myVotes = new Map(mine.map((row) => [row.poll_id, row.options.map(Number)]));
    for (const poll of polls) {
      const voted = myVotes.get(poll.id) ?? null;
      const closed = poll.closed_at !== null;
      const reveal = voted !== null || closed;
      const pollCounts = counts.rows.filter((row) => row.poll_id === poll.id);
      const total = pollCounts.length > 0 ? Number(pollCounts[0]!.voters) : 0;
      result.set(poll.id, {
        id: poll.id,
        question: poll.question,
        kind: poll.kind,
        anonymous: poll.anonymous,
        multiple: poll.multiple,
        closed,
        options: poll.options.map((text, index) => ({
          text,
          votes: reveal ? Number(pollCounts.find((row) => Number(row.option) === index)?.votes ?? 0) : null,
        })),
        totalVoters: reveal ? total : null,
        myVotes: voted,
        correctOption: reveal && poll.kind === 'quiz' ? poll.correct_option : null,
        explanation: reveal && poll.kind === 'quiz' ? poll.explanation : null,
      });
    }
    return result;
  }

  /** The poll message, visible to the viewer and not deleted, with the viewer's access to its chat. */
  private async pollMessage(db: Executor, viewerId: string, messageId: string): Promise<{ pollId: string; access: ChatAccess }> {
    const message = await db
      .selectFrom('app.messages as m')
      // Phase 9: the poll must belong to the message's own chat.
      .innerJoin('app.polls as p', (join) => join.onRef('p.id', '=', 'm.poll_id').onRef('p.conversation_id', '=', 'm.conversation_id'))
      .select(['m.conversation_id', 'm.poll_id', 'm.deleted_at'])
      .where('m.id', '=', messageId)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', viewerId))),
      )
      .executeTakeFirst();
    const access = message ? await this.permissions.findChatAccess(db, viewerId, message.conversation_id) : null;
    if (!message || !access || !message.poll_id || message.deleted_at !== null) {
      throw notFound();
    }
    return { pollId: message.poll_id, access };
  }

  async vote(auth: AuthContext, messageId: string, options: number[] | null, view: (messageId: string) => Promise<Message>): Promise<Message> {
    await this.limits.reactions(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const { pollId, access } = await this.pollMessage(trx, auth.userId, messageId);
      const poll = await trx.selectFrom('app.polls').selectAll().where('id', '=', pollId).forUpdate().executeTakeFirstOrThrow();
      if (poll.closed_at !== null) {
        throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      }
      const existing = await trx.selectFrom('app.poll_votes').select('options').where('poll_id', '=', pollId).where('user_id', '=', auth.userId).executeTakeFirst();
      if (options === null) {
        // Taking a vote back: regular polls only (a quiz answer is final).
        if (poll.kind === 'quiz' || !existing) {
          throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
        }
        await trx.deleteFrom('app.poll_votes').where('poll_id', '=', pollId).where('user_id', '=', auth.userId).execute();
      } else {
        if (options.some((option) => option >= poll.options.length) || (!poll.multiple && options.length !== 1)) {
          throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
        }
        if (existing) {
          // A vote is changed by taking it back first (regular polls), never by voting again.
          throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
        }
        const status = await this.permissions.userStatus(trx, auth.userId);
        if (status !== 'active' && status !== 'deletion_requested') {
          throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
        }
        await trx.insertInto('app.poll_votes').values({ poll_id: pollId, user_id: auth.userId, options: [...options].sort((a, b) => a - b) }).execute();
      }
      updates.addFor(await this.voteAudience(trx, auth.userId, access), { kind: 'message.poll', chatId: access.conversationId, messageId });
    });
    return view(messageId);
  }

  /** Closing stops voting and shows the results to everyone: the poll's creator, or an admin who may delete messages. */
  async close(auth: AuthContext, messageId: string, view: (messageId: string) => Promise<Message>): Promise<Message> {
    // Phase 9: closing notifies every member's devices.
    await this.limits.groupActions(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const { pollId, access } = await this.pollMessage(trx, auth.userId, messageId);
      const poll = await trx.selectFrom('app.polls').select(['created_by', 'closed_at']).where('id', '=', pollId).forUpdate().executeTakeFirstOrThrow();
      if (poll.created_by !== auth.userId && !this.permissions.hasRight(access, 'delete_messages')) {
        throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ALLOWED');
      }
      if (poll.closed_at !== null) {
        return;
      }
      await trx.updateTable('app.polls').set({ closed_at: sql`now()` }).where('id', '=', pollId).execute();
      updates.addFor(await this.permissions.audienceOf(trx, auth.userId, access), { kind: 'message.poll', chatId: access.conversationId, messageId });
    });
    return view(messageId);
  }

  /** Who voted for each option: never for anonymous polls; with a hidden member list only for owners and admins. */
  async voters(viewerId: string, messageId: string): Promise<{ options: Array<{ voters: PublicUser[] }> }> {
    const db = this.database.db;
    const { pollId, access } = await this.pollMessage(db, viewerId, messageId);
    const poll = await db.selectFrom('app.polls').select(['anonymous', 'options']).where('id', '=', pollId).executeTakeFirstOrThrow();
    if (poll.anonymous || (access.type !== 'private' && !this.permissions.canViewMembers(access, 'list'))) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ALLOWED');
    }
    const votes = await db
      .selectFrom('app.poll_votes as v')
      .innerJoin('app.users as u', 'u.id', 'v.user_id')
      .select(['v.options', 'u.id', 'u.status', 'u.name', 'u.username', 'u.bio', 'u.photo_key'])
      .where('v.poll_id', '=', pollId)
      .orderBy('v.voted_at')
      .execute();
    const users = new Map<string, PublicUser>();
    for (const vote of votes) {
      users.set(vote.id, await this.accounts.toPublicUser(vote, { photoVisible: false }));
    }
    return {
      options: poll.options.map((_, index) => ({ voters: votes.filter((vote) => vote.options.map(Number).includes(index)).map((vote) => users.get(vote.id)!) })),
    };
  }
}
