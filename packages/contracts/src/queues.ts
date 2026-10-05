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
  /** Phase 3: keeps monthly message partitions created ahead of time. */
  ensureMessagePartitions: 'ensure-message-partitions',
  /** Phase 3 (P-17): removes update-log entries and idempotency keys older than 30 days. */
  pruneUpdateLog: 'prune-update-log',
} as const;

export const heartbeatJobDataSchema = z.object({}).strict();
export type HeartbeatJobData = z.infer<typeof heartbeatJobDataSchema>;

/** Redis key the worker refreshes on every heartbeat job; scoped by QUEUE_PREFIX like the queues. */
export function workerHeartbeatKey(queuePrefix: string): string {
  return `${queuePrefix}:worker:heartbeat`;
}

/** Job names on the OTP queue. */
export const OTP_JOB_NAMES = {
  /** A one-time code. */
  send: 'send',
  /** A test message from the Admin Dashboard (Phase 3.1); the API waits for its result. */
  waabekTest: 'waabek-test',
} as const;

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

/** Admin Dashboard test message (Phase 3.1): same delivery path as codes, to one admin's number. */
export const waabekTestJobDataSchema = z.object({ phone: z.string() });
export type WaabekTestJobData = z.infer<typeof waabekTestJobDataSchema>;

/** The exact test message text. */
export const WAABEK_TEST_MESSAGE =
  'Bedo Chat: this is a test message from the Admin Dashboard. WhatsApp delivery of verification codes is working.';

/**
 * Failure texts the worker reports for OTP-queue jobs. They never contain the key, the number, the code or
 * Waabek's response body; the API maps them to a reason for the Admin Dashboard.
 */
export const OTP_DELIVERY_ERRORS = {
  notConfigured: 'OTP settings: no Waabek API key is configured',
  keyUnreadable: 'OTP settings: the stored Waabek API key cannot be decrypted',
  /** Followed by ": HTTP <status>", ": timed out" or ": network error". */
  waabekPrefix: 'Waabek send failed',
} as const;

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

/** Redis key where the test-only sender stores test messages (NODE_ENV=test only). */
export function testWaabekMessageKey(queuePrefix: string, phone: string): string {
  return `${queuePrefix}:test:waabek-test:${phone}`;
}

/** Redis key where the test-only code sender stores codes (NODE_ENV=test only). */
export function testOtpKey(queuePrefix: string, phone: string): string {
  return `${queuePrefix}:test:otp:${phone}`;
}
