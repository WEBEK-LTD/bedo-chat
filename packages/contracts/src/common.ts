import { z } from 'zod';

/**
 * Where the API is on the site (D-36): the student web app, the Admin Dashboard and the API are one Netlify
 * site, so browsers call the API at this same-origin path (https://bedochat.com/api in production).
 */
export const API_BASE_PATH = '/api';

/** Machine-readable error codes returned by every Bedo Chat API endpoint. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
  // Phase 2
  'OTP_INVALID',
  'OTP_LOCKED',
  'TWO_STEP_INVALID',
  'TWO_STEP_REQUIRED',
  'TOTP_INVALID',
  'SESSION_INVALID',
  'ACCOUNT_DELETED',
  'ACCOUNT_BLOCKED',
  'USERNAME_TAKEN',
  'CSRF_REJECTED',
  // Phase 3.1
  'SETUP_UNAVAILABLE',
  'SETUP_TOKEN_INVALID',
  // D-33
  'RECOVERY_UNAVAILABLE',
  'RECOVERY_TOKEN_INVALID',
  'RECOVERY_TOKEN_USED',
  // Phase 3.2 (D-34)
  /** The same answer for an unknown number, an account without a password and a wrong password. */
  'CREDENTIALS_INVALID',
  /** The same answer for every setup-token problem (unknown number, no, wrong, expired, used or locked token). */
  'PASSWORD_SETUP_INVALID',
  'PASSWORD_IS_PHONE',
  'PASSWORD_TOO_COMMON',
  // Phase 3
  /** P-26: the same answer for a block by the other user and "Who can message: Nobody". */
  'CANNOT_MESSAGE',
  /** P-30: the signed-in user blocked this user and must unblock before sending. */
  'USER_BLOCKED',
  /** A fixed maximum was reached (pinned chats, folders). */
  'LIMIT_REACHED',
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const fieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/** The one error shape every endpoint returns. Internal details are never included. */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    fields: z.array(fieldErrorSchema).optional(),
    /** Seconds until the request may be retried (rate limits and resend cooldown). */
    retryAfterSeconds: z.number().int().positive().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

/** Header every state-changing request from a browser must carry (CSRF protection, see README). */
export const CSRF_HEADER = 'x-bedo-csrf';
export const CSRF_HEADER_VALUE = '1';

