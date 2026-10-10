import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ReportBody } from '@bedo/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { MessagingLimitsService } from './messaging-limits.service.js';
import { PermissionService } from './permissions.service.js';
import { UpdateLogService } from './update-log.service.js';

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');

/** Blocks (P-26, P-30), reports (P-27) and screenshot event intake (P-28). */
@Injectable()
export class SafetyService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
  ) {}

  private async privateChatId(userA: string, userB: string): Promise<string | null> {
    const [low, high] = userA < userB ? [userA, userB] : [userB, userA];
    const row = await this.database.db
      .selectFrom('app.conversations')
      .select('id')
      .where('type', '=', 'private')
      .where('private_low', '=', low)
      .where('private_high', '=', high)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /**
   * Block or unblock a user. Only the blocker's own devices are told: the blocked user is never informed
   * (they get the neutral "You can't message this user" when they try to send, P-26).
   */
  async setBlocked(viewerId: string, userId: string, blocked: boolean): Promise<void> {
    if (userId === viewerId) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    const exists = await this.database.db.selectFrom('app.users').select('id').where('id', '=', userId).executeTakeFirst();
    if (!exists) {
      throw notFound();
    }
    await this.limits.peerActions(viewerId);
    const chatId = await this.privateChatId(viewerId, userId);
    await this.updateLog.run(async (trx, updates) => {
      const changed = blocked
        ? Number(
            (
              await trx
                .insertInto('app.blocks')
                .values({ blocker_id: viewerId, blocked_id: userId })
                .onConflict((conflict) => conflict.columns(['blocker_id', 'blocked_id']).doNothing())
                .executeTakeFirst()
            ).numInsertedOrUpdatedRows ?? 0,
          )
        : Number((await trx.deleteFrom('app.blocks').where('blocker_id', '=', viewerId).where('blocked_id', '=', userId).executeTakeFirst()).numDeletedRows);
      if (changed > 0) {
        updates.add({ userId: viewerId, kind: 'block', chatId, data: { userId, blocked } });
      }
    });
  }

  /**
   * Report a user or one of their messages (P-27). Kept permanently; reviewed in Phase 10. Phase 9: every attempt
   * counts against the daily limit, and a message in a channel where the reporter does not see who posts is reported
   * as the channel's post (the server records its author; the answer is the same whoever is named), so reports cannot
   * be used to find out who posted (D-40).
   */
  async report(viewerId: string, body: ReportBody): Promise<void> {
    if (body.userId === viewerId) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    await this.limits.reports(viewerId);
    const db = this.database.db;
    let reportedUserId = body.userId;
    let conversationId: string | null = null;
    let messageText: string | null = null;
    if (body.messageId) {
      const message = await db
        .selectFrom('app.messages')
        .select(['id', 'conversation_id', 'sender_id', 'text'])
        .where('id', '=', body.messageId)
        .executeTakeFirst();
      // Only a message in a chat the reporter is in and can still see.
      const access = message ? await this.permissions.findChatAccess(db, viewerId, message.conversation_id) : null;
      const hidden = message
        ? await db.selectFrom('app.message_hidden').select('message_id').where('user_id', '=', viewerId).where('message_id', '=', message.id).executeTakeFirst()
        : undefined;
      if (!message || !access || hidden) {
        throw notFound();
      }
      if (this.permissions.seesSenders(access)) {
        // Elsewhere the reporter sees the sender, so naming someone else is a mistake.
        if (message.sender_id !== body.userId) throw notFound();
      } else if (message.sender_id === viewerId) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
      }
      reportedUserId = message.sender_id;
      conversationId = message.conversation_id;
      messageText = message.text;
    } else {
      const target = await db.selectFrom('app.users').select('id').where('id', '=', body.userId).executeTakeFirst();
      if (!target) {
        throw notFound();
      }
    }
    await db
      .insertInto('app.reports')
      .values({
        reporter_id: viewerId,
        reported_user_id: reportedUserId,
        conversation_id: conversationId,
        message_id: body.messageId ?? null,
        reason: body.reason,
        details: body.details ?? null,
        message_text: messageText,
      })
      .execute();
  }

  /**
   * Screenshot intake (P-28): only sessions of the iOS and Android apps may report; the web app never
   * does, and a web, desktop or unknown session is refused. Stored in the permanent audit history.
   */
  async screenshot(
    auth: AuthContext,
    body: { chatId?: string; screen: string; messageIds?: string[]; occurredAt: string },
  ): Promise<void> {
    const db = this.database.db;
    const session = await db.selectFrom('app.sessions').select(['platform', 'device_name']).where('id', '=', auth.sessionId).executeTakeFirst();
    if (!session || (session.platform !== 'ios' && session.platform !== 'android')) {
      throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN');
    }
    const messageIds = [...new Set(body.messageIds ?? [])];
    if (messageIds.length > 0 && !body.chatId) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    if (body.chatId) {
      await this.permissions.chatAccess(db, auth.userId, body.chatId);
      if (messageIds.length > 0) {
        const found = await db
          .selectFrom('app.messages')
          .select('id')
          .where('conversation_id', '=', body.chatId)
          .where('id', 'in', messageIds)
          .execute();
        if (found.length !== messageIds.length) {
          throw notFound();
        }
      }
    }
    await this.limits.screenshotEvents(auth.userId);
    await this.audit.screenshotEvent(db, {
      userId: auth.userId,
      sessionId: auth.sessionId,
      platform: session.platform,
      deviceName: session.device_name,
      conversationId: body.chatId ?? null,
      screen: body.screen,
      messageIds,
      occurredAt: body.occurredAt,
    });
  }
}
