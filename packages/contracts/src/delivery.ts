import { z } from 'zod';

/**
 * Messages the API delivers itself (D-36: there is no worker or queue): WhatsApp messages through Waabek and
 * Web Push notifications, sent right after the response that caused them.
 */

/** The exact message text sent through Waabek (spec §1). */
export function otpMessage(code: string): string {
  return `Your Bedo Chat verification code is: ${code}`;
}

/** The exact test message text (Admin Dashboard, Phase 3.1). */
export const WAABEK_TEST_MESSAGE =
  'Bedo Chat: this is a test message from the Admin Dashboard. WhatsApp delivery of verification codes is working.';

/**
 * Failure texts for WhatsApp delivery. They never contain the key, the number, the code or Waabek's response
 * body; they are recorded in the security history and mapped to a reason for the Admin Dashboard.
 */
export const OTP_DELIVERY_ERRORS = {
  notConfigured: 'OTP settings: no Waabek API key is configured',
  keyUnreadable: 'OTP settings: the stored Waabek API key cannot be decrypted',
  /** Followed by ": HTTP <status>", ": timed out" or ": network error". */
  waabekPrefix: 'Waabek send failed',
} as const;

/** One Web Push subscription, as stored. */
export const pushSubscriptionSnapshotSchema = z.object({
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
});

/** A notification for a user's sessions, optionally skipping one session. */
export const pushNotificationDataSchema = z.object({
  userId: z.string(),
  excludeSessionId: z.string().nullable(),
  notification: z.object({
    title: z.string().max(100),
    body: z.string().max(300),
    tag: z.string().max(60),
    /** Phase 7: the page a click opens (a path on the site, e.g. "/?chat=<id>"). */
    url: z.string().startsWith('/').max(200).optional(),
    /** Phase 7: the badge count on the app icon (computed on the server, D-41). */
    badge: z.number().int().nonnegative().optional(),
  }),
  /**
   * Explicit recipients, used when the subscriptions are removed in the same change (account deletion
   * approved: the user is told on every device just before the sessions end).
   */
  subscriptions: z.array(pushSubscriptionSnapshotSchema).optional(),
});
export type PushNotificationData = z.infer<typeof pushNotificationDataSchema>;
