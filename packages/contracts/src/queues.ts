import { z } from 'zod';

/**
 * Background queues shared by the API (producer) and the worker (consumer).
 * Feature queues are added in the phase that introduces the feature.
 */
export const QUEUE_NAMES = {
  system: 'system',
  otp: 'otp',
  push: 'push',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const SYSTEM_JOB_NAMES = {
  heartbeat: 'heartbeat',
} as const;

/** Scheduled housekeeping (Phase 2): removes data that has no further use, never history. */
export const MAINTENANCE_JOB_NAMES = {
  pruneRetiredRefreshTokens: 'prune-retired-refresh-tokens',
} as const;

export const heartbeatJobDataSchema = z.object({}).strict();
export type HeartbeatJobData = z.infer<typeof heartbeatJobDataSchema>;

/** Redis key the worker refreshes on every heartbeat job; scoped by QUEUE_PREFIX like the queues. */
export function workerHeartbeatKey(queuePrefix: string): string {
  return `${queuePrefix}:worker:heartbeat`;
}

/** One-time code delivery job (API → worker → Waabek). Removed from Redis as soon as it completes. */
export const otpJobDataSchema = z.object({
  phone: z.string(),
  code: z.string().regex(/^\d{6}$/),
  purpose: z.enum(['sign_in', 'change_phone', 'admin_sign_in']),
});
export type OtpJobData = z.infer<typeof otpJobDataSchema>;

/** The exact message text sent through Waabek (spec §1). */
export function otpMessage(code: string): string {
  return `Your Bedo Chat verification code is: ${code}`;
}

/** Web Push job: deliver one notification to a user's sessions, optionally skipping one session. */
export const pushSubscriptionSnapshotSchema = z.object({
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
});

export const pushJobDataSchema = z.object({
  userId: z.string(),
  excludeSessionId: z.string().nullable(),
  notification: z.object({
    title: z.string().max(100),
    body: z.string().max(300),
    tag: z.string().max(60),
  }),
  /**
   * Explicit recipients, used when the subscriptions are removed in the same change (account deletion
   * approved: the user is told on every device just before the sessions end).
   */
  subscriptions: z.array(pushSubscriptionSnapshotSchema).optional(),
});
export type PushJobData = z.infer<typeof pushJobDataSchema>;

/** Redis key where the test-only code sender stores codes (NODE_ENV=test only). */
export function testOtpKey(queuePrefix: string, phone: string): string {
  return `${queuePrefix}:test:otp:${phone}`;
}
