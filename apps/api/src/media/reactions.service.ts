import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Message } from '@bedo/contracts';
import type { AuthContext } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { MessagesService } from '../messaging/messages.service.js';
import { MessagingLimitsService } from '../messaging/messaging-limits.service.js';
import { PermissionService } from '../messaging/permissions.service.js';
import { UpdateLogService } from '../messaging/update-log.service.js';

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');

/**
 * Reactions (Phase 4): one emoji from the fixed set per person per message, on messages they can see that are not
 * deleted, in chats they may still send to. Both participants' devices hear about every change.
 */
@Injectable()
export class ReactionsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
    @Inject(MessagesService) private readonly messages: MessagesService,
  ) {}

  async set(auth: AuthContext, messageId: string, emoji: string | null): Promise<Message> {
    await this.limits.reactions(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const message = await trx
        .selectFrom('app.messages as m')
        .select(['m.id', 'm.conversation_id', 'm.deleted_at'])
        .where('m.id', '=', messageId)
        .where(({ not, exists, selectFrom }) =>
          not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', auth.userId))),
        )
        .executeTakeFirst();
      const access = message ? await this.permissions.findChatAccess(trx, auth.userId, message.conversation_id) : null;
      if (!message || !access || message.deleted_at !== null) {
        throw notFound();
      }
      let changed: boolean;
      if (emoji === null) {
        const removed = await trx.deleteFrom('app.message_reactions').where('message_id', '=', messageId).where('user_id', '=', auth.userId).executeTakeFirst();
        changed = Number(removed.numDeletedRows) > 0;
      } else {
        if (access.type === 'private') {
          await this.permissions.assertCanSend(trx, auth.userId, access.peerId!);
        } else {
          // In a group any member whose account may send can react (no group permission needed).
          const status = await this.permissions.userStatus(trx, auth.userId);
          if (status !== 'active' && status !== 'deletion_requested') {
            throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
          }
        }
        const written = await trx
          .insertInto('app.message_reactions')
          .values({ message_id: messageId, conversation_id: message.conversation_id, user_id: auth.userId, emoji })
          .onConflict((conflict) =>
            conflict
              .columns(['message_id', 'user_id'])
              .doUpdateSet({ emoji })
              .where('app.message_reactions.emoji', '<>', emoji),
          )
          .executeTakeFirst();
        changed = Number(written.numInsertedOrUpdatedRows ?? 0) > 0;
      }
      if (changed) {
        const hidden = await trx.selectFrom('app.message_hidden').select('user_id').where('message_id', '=', messageId).execute();
        const hiddenFor = new Set(hidden.map((row) => row.user_id));
        // Phase 9 (D-43): in a channel a reaction reaches the reactor's devices and the staff at once; subscribers see
        // the new counts the next time the post is loaded, so one reaction is not 5,000 update entries.
        const audience =
          access.type === 'channel'
            ? [...new Set([auth.userId, ...(await this.permissions.staffIds(trx, access.conversationId))])]
            : await this.permissions.audienceOf(trx, auth.userId, access);
        updates.addFor(
          audience.filter((userId) => !hiddenFor.has(userId)),
          { kind: 'message.reactions', chatId: message.conversation_id, messageId },
        );
      }
    });
    const [view] = await this.messages.visibleViews(this.database.db, auth.userId, [messageId]);
    if (!view) {
      throw notFound();
    }
    return view;
  }
}
