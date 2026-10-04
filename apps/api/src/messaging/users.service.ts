import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { MESSAGING_RULES, type Peer } from '@bedo/contracts';
import { sql } from 'kysely';
import { AppError } from '../common/app-error.js';
import { normalizePhone } from '../common/phone.js';
import { DatabaseService } from '../database/database.service.js';
import { likePattern } from './messages.service.js';
import { MessagingLimitsService } from './messaging-limits.service.js';
import { ViewsService } from './views.service.js';

/**
 * Finding someone to start a private chat with (P-25): by name or username, at least 3 characters.
 * Not the Phase 8 global search. A phone number matches only when that user's phone-number privacy is
 * Everyone (and they have not blocked the searcher). Deleted accounts are never found.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ViewsService) private readonly views: ViewsService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
  ) {}

  async search(viewerId: string, query: string): Promise<Peer[]> {
    const db = this.database.db;
    const text = query.startsWith('@') ? query.slice(1) : query;
    if (text.length < MESSAGING_RULES.userSearchMinLength) {
      return [];
    }
    await this.limits.userSearches(viewerId);
    const pattern = likePattern(text);
    const phone = /^[+0-9][0-9\s().-]*$/.test(query) ? normalizePhone(query) : null;
    const rows = await db
      .selectFrom('app.users as u')
      .leftJoin('app.user_privacy as p', 'p.user_id', 'u.id')
      .select(['u.id'])
      .where('u.id', '<>', viewerId)
      .where('u.status', '<>', 'deleted')
      .where((eb) => {
        const conditions = [eb('u.name', 'ilike', pattern), eb(sql<string>`u.username::text`, 'ilike', pattern)];
        if (phone) {
          conditions.push(
            eb.and([
              eb('u.phone', '=', phone),
              eb(sql<string>`coalesce(p.phone_visibility, 'nobody')`, '=', 'everyone'),
              eb.not(eb.exists(eb.selectFrom('app.blocks as b').select('b.blocker_id').whereRef('b.blocker_id', '=', 'u.id').where('b.blocked_id', '=', viewerId))),
            ]),
          );
        }
        return eb.or(conditions);
      })
      .orderBy(sql`case when lower(u.username::text) = lower(${text}) then 0 when u.phone = ${phone ?? ''} then 0 else 1 end`)
      .orderBy('u.name')
      .orderBy('u.id')
      .limit(MESSAGING_RULES.userSearchLimit)
      .execute();
    const ids = rows.map((row) => row.id);
    const peers = await this.views.peers(db, viewerId, ids);
    return ids.map((id) => peers.get(id)).filter((peer): peer is Peer => peer !== undefined);
  }

  async profile(viewerId: string, userId: string): Promise<Peer> {
    const peer = userId === viewerId ? null : await this.views.peer(this.database.db, viewerId, userId);
    if (!peer) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    return peer;
  }
}
