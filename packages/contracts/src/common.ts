import { z } from 'zod';

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
