import { z } from 'zod';

/** Profile rules (P-04 to P-07). */
export const PROFILE_RULES = {
  nameMaxLength: 64,
  usernamePattern: /^[A-Za-z][A-Za-z0-9_]{4,31}$/,
  bioMaxLength: 140,
  photoMaxBytes: 5 * 1024 * 1024,
  photoContentTypes: ['image/jpeg', 'image/png', 'image/webp'] as const,
} as const;

/** 2-Step Verification password rules (P-09). */
export const TWO_STEP_RULES = { passwordMin: 8, passwordMax: 128, hintMax: 64 } as const;

export const userStatusSchema = z.enum(['active', 'suspended', 'banned', 'deletion_requested', 'deleted']);

export const meSchema = z.object({
  id: z.string(),
  phone: z.string(),
  name: z.string().nullable(),
  username: z.string().nullable(),
  bio: z.string().nullable(),
  photoUrl: z.string().nullable(),
  status: userStatusSchema,
  twoStepEnabled: z.boolean(),
  /** False until the user has entered a name (P-03); the chat interface is not shown before that. */
  profileComplete: z.boolean(),
});
export type Me = z.infer<typeof meSchema>;

export const nameSchema = z.string().trim().min(1).max(PROFILE_RULES.nameMaxLength);
export const usernameSchema = z
  .string()
  .trim()
  .regex(PROFILE_RULES.usernamePattern, '5-32 letters, digits or underscores, starting with a letter');
export const bioSchema = z.string().trim().max(PROFILE_RULES.bioMaxLength);

export const updateMeBodySchema = z
  .object({
    name: nameSchema.optional(),
    /** null removes the username */
    username: usernameSchema.nullable().optional(),
    /** null or "" removes the bio */
    bio: bioSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to update');
export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;

export const visibilitySchema = z.enum(['everyone', 'nobody']);
export const privacySchema = z.object({
  phoneVisibility: visibilitySchema,
  lastSeenVisibility: visibilitySchema,
  photoVisibility: visibilitySchema,
  messagesFrom: visibilitySchema,
  callsFrom: visibilitySchema,
});
export type Privacy = z.infer<typeof privacySchema>;
export const updatePrivacyBodySchema = privacySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'nothing to update');

export const photoContentTypeSchema = z.enum(PROFILE_RULES.photoContentTypes);
export const photoUploadBodySchema = z.object({
  contentType: photoContentTypeSchema,
  size: z.number().int().positive().max(PROFILE_RULES.photoMaxBytes),
});
export const photoUploadResponseSchema = z.object({
  uploadId: z.string(),
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
});
export type PhotoUploadResponse = z.infer<typeof photoUploadResponseSchema>;
export const photoConfirmBodySchema = z.object({ uploadId: z.string().min(10).max(200) });

export const phoneChangeRequestBodySchema = z.object({ newPhone: z.string().trim().min(5).max(32) });
export const phoneChangeVerifyBodySchema = z.object({
  newPhone: z.string().trim().min(5).max(32),
  code: z.string().regex(/^\d{6}$/, 'must be 6 digits'),
  twoStepPassword: z.string().min(1).max(TWO_STEP_RULES.passwordMax).optional(),
});

export const platformSchema = z.enum(['web', 'ios', 'android', 'desktop']);
export const sessionSchema = z.object({
  id: z.string(),
  deviceName: z.string().nullable(),
  platform: platformSchema,
  ip: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  current: z.boolean(),
});
export const sessionsResponseSchema = z.object({ sessions: z.array(sessionSchema) });
export type SessionInfo = z.infer<typeof sessionSchema>;

export const twoStepStatusSchema = z.object({ enabled: z.boolean(), hint: z.string().nullable() });
export const twoStepPasswordSchema = z.string().min(TWO_STEP_RULES.passwordMin).max(TWO_STEP_RULES.passwordMax);
export const twoStepSetBodySchema = z.object({
  /** Required when 2-Step Verification is already enabled (changing the password). */
  currentPassword: z.string().min(1).max(TWO_STEP_RULES.passwordMax).optional(),
  newPassword: twoStepPasswordSchema,
  hint: z.string().trim().min(1).max(TWO_STEP_RULES.hintMax).optional(),
});
export const twoStepDisableBodySchema = z.object({
  currentPassword: z.string().min(1).max(TWO_STEP_RULES.passwordMax),
});

export const securityNoticeKindSchema = z.enum(['new_login', 'deletion_requested', 'deletion_rejected', 'two_step_reset']);
export const securityNoticeSchema = z.object({
  id: z.string(),
  kind: securityNoticeKindSchema,
  createdAt: z.string(),
  read: z.boolean(),
  details: z.object({
    deviceName: z.string().nullable().optional(),
    platform: platformSchema.optional(),
    ip: z.string().nullable().optional(),
  }),
});
export type SecurityNotice = z.infer<typeof securityNoticeSchema>;
export const securityNoticesResponseSchema = z.object({
  notices: z.array(securityNoticeSchema),
  unreadCount: z.number().int(),
});
export const markNoticesReadBodySchema = z.object({ ids: z.array(z.string().regex(/^\d+$/)).max(100).optional() });

export const pushConfigResponseSchema = z.object({ vapidPublicKey: z.string().nullable() });
/**
 * Browser push services a subscription endpoint may point to (Chrome and other Chromium browsers, Firefox,
 * Edge, Safari). The worker only ever sends to these hosts, never to an address a user typed in.
 */
export const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'] as const;

export function isPushServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && PUSH_SERVICE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export const pushSubscriptionBodySchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2000).refine(isPushServiceUrl, 'must be a browser push service address'),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export const deletionRequestResponseSchema = z.object({
  status: z.literal('deletion_requested'),
  requestedAt: z.string(),
});
