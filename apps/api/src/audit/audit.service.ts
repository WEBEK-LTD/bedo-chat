import { Injectable } from '@nestjs/common';
import type { AccountEvent, ActorType, Database, IdentityField, MessageRevisionAction } from '@bedo/db';
import type { Kysely, Transaction } from 'kysely';

export type Executor = Kysely<Database> | Transaction<Database>;

export interface Actor {
  type: ActorType;
  id: string | null;
}

export interface SecurityEventInput {
  subjectType: 'user' | 'admin' | 'phone';
  subjectId?: string | null;
  phone?: string | null;
  event: string;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Writes the permanent audit history (D-17). Every method takes the executor of the change it records,
 * so the record and the change commit together or not at all. The tables are append-only: the runtime
 * database role can only insert and read them.
 */
@Injectable()
export class AuditService {
  async identity(
    db: Executor,
    input: { userId: string; field: IdentityField; oldValue: string | null; newValue: string | null; actor: Actor },
  ): Promise<void> {
    if (input.oldValue === input.newValue) {
      return;
    }
    await db
      .insertInto('audit.identity_history')
      .values({
        user_id: input.userId,
        field: input.field,
        old_value: input.oldValue,
        new_value: input.newValue,
        actor_type: input.actor.type,
        actor_id: input.actor.id,
      })
      .execute();
  }

  async account(
    db: Executor,
    input: { userId: string; event: AccountEvent; actor: Actor; reason?: string | null; details?: Record<string, unknown> },
  ): Promise<void> {
    await db
      .insertInto('audit.account_events')
      .values({
        user_id: input.userId,
        event: input.event,
        actor_type: input.actor.type,
        actor_id: input.actor.id,
        reason: input.reason ?? null,
        details: input.details ?? {},
      })
      .execute();
  }

  async security(db: Executor, input: SecurityEventInput): Promise<void> {
    await db
      .insertInto('audit.security_events')
      .values({
        subject_type: input.subjectType,
        subject_id: input.subjectId ?? null,
        phone: input.phone ?? null,
        event: input.event,
        session_id: input.sessionId ?? null,
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
        details: input.details ?? {},
      })
      .execute();
  }

  /**
   * Phase 3: a message edit, "delete for me" or "delete for both sides", with the text as it was. The
   * database refuses the matching message change at commit unless this row is in the same transaction.
   */
  async messageRevision(
    db: Executor,
    input: {
      messageId: string;
      conversationId: string;
      senderId: string;
      action: MessageRevisionAction;
      previousText: string | null;
      newText?: string | null;
      actor: Actor;
      sessionId?: string | null;
    },
  ): Promise<void> {
    await db
      .insertInto('audit.message_revisions')
      .values({
        message_id: input.messageId,
        conversation_id: input.conversationId,
        sender_id: input.senderId,
        action: input.action,
        previous_text: input.previousText,
        new_text: input.newText ?? null,
        actor_type: input.actor.type,
        actor_id: input.actor.id,
        session_id: input.sessionId ?? null,
      })
      .execute();
  }

  /** Phase 3 (P-28): a screenshot reported by the iOS or Android app. */
  async screenshotEvent(
    db: Executor,
    input: {
      userId: string;
      sessionId: string;
      platform: 'ios' | 'android';
      deviceName: string | null;
      conversationId: string | null;
      screen: string;
      messageIds: string[];
      occurredAt: string;
    },
  ): Promise<void> {
    await db
      .insertInto('audit.screenshot_events')
      .values({
        user_id: input.userId,
        session_id: input.sessionId,
        platform: input.platform,
        device_name: input.deviceName,
        conversation_id: input.conversationId,
        screen: input.screen,
        message_ids: input.messageIds,
        occurred_at: input.occurredAt,
      })
      .execute();
  }

  /** Every admin action (D-17, Phase 2 requirement 12), in the baseline append-only app.audit_log. */
  /**
   * D-24: removes a number from the academy phone list and records the removed entry (number, note, who
   * added it and when) in the audit log, in the caller's transaction. Returns whether it was listed.
   */
  async removeFromPhoneList(
    db: Executor,
    input: { phone: string; reason: 'account_deleted' | 'phone_changed'; actor: { type: 'user' | 'admin'; id: string }; userId: string },
  ): Promise<boolean> {
    const removed = await db.deleteFrom('app.academy_phone_list').where('phone', '=', input.phone).returningAll().executeTakeFirst();
    await db
      .insertInto('app.audit_log')
      .values({
        actor_type: input.actor.type,
        actor_id: input.actor.id,
        action: 'phone_list.remove',
        target_type: 'phone',
        target_id: input.phone,
        metadata: {
          reason: input.reason,
          userId: input.userId,
          wasListed: Boolean(removed),
          entry: removed
            ? { note: removed.note, addedBy: removed.added_by, addedAt: new Date(removed.added_at).toISOString() }
            : null,
        },
      })
      .execute();
    return Boolean(removed);
  }

  async admin(
    db: Executor,
    input: {
      adminId: string;
      action: string;
      targetType?: string | null;
      targetId?: string | null;
      ip?: string | null;
      userAgent?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await db
      .insertInto('app.audit_log')
      .values({
        actor_type: 'admin',
        actor_id: input.adminId,
        action: input.action,
        target_type: input.targetType ?? null,
        target_id: input.targetId ?? null,
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
        metadata: input.metadata ?? {},
      })
      .execute();
  }
}
