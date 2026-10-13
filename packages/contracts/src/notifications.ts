import { z } from 'zod';
import type { Chat } from './messaging.js';

/**
 * Phase 7: notifications (D-41, O-19). Pushes for new messages, mentions, replies and being added to a group or
 * channel. Mentions and replies notify even in a muted chat or a category turned off; previews (sender and text)
 * are on unless the person turns them off.
 */
export const notificationSettingsSchema = z.object({
  privateChats: z.boolean(),
  groups: z.boolean(),
  channels: z.boolean(),
  /** Show the sender and the text in notifications (off: "New message"). */
  previews: z.boolean(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = { privateChats: true, groups: true, channels: true, previews: true };

export const updateNotificationSettingsBodySchema = notificationSettingsSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'nothing to update');

/** The chat this device is showing (its page visible), or null. It is not pushed about that chat. */
export const viewingBodySchema = z.object({ chatId: z.string().uuid().nullable() });

export const badgeResponseSchema = z.object({ count: z.number().int().nonnegative() });

/** Unread counts stop here for the badge, as for each chat. */
export const BADGE_MAX = 9999;

/**
 * The badge (app icon and tab title): unread messages in chats that are not muted, a chat marked as unread counting
 * one. The API computes the same number for every push, so every device shows the same count.
 */
export function badgeCount(chats: readonly Pick<Chat, 'unreadCount' | 'markedUnread' | 'mutedUntil'>[], now = Date.now()): number {
  let total = 0;
  for (const chat of chats) {
    if (chat.mutedUntil !== null && new Date(chat.mutedUntil).getTime() > now) continue;
    total += chat.unreadCount > 0 ? chat.unreadCount : chat.markedUnread ? 1 : 0;
  }
  return Math.min(total, BADGE_MAX);
}
