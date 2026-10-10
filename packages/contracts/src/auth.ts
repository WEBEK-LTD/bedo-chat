import { z } from 'zod';
import { meSchema } from './me.js';

/** OTP rules (approved in the blueprint's Authentication section). */
export const OTP_RULES = {
  codeLength: 6,
  lifetimeSeconds: 5 * 60,
  maxWrongAttempts: 5,
  resendCooldownSeconds: 60,
  maxCodesPerPhonePerHour: 5,
  maxCodesPerIpPerHour: 20,
} as const;

/** Token lifetimes (P-01, P-02). */
export const TOKEN_RULES = {
  accessTokenSeconds: 10 * 60,
  /**
   * D-49: a device stays signed in. The session (and its cookie) is renewed every time the app is used, and ends
   * only on sign-out, from Devices, by an admin, or after 400 days without opening Bedo Chat at all (400 days is
   * the longest a browser keeps a cookie).
   */
  refreshTokenIdleDays: 400,
  /** Rotated-out refresh tokens are kept this long for reuse detection (an older one is simply unknown). */
  retiredTokenDays: 30,
  twoStepTokenSeconds: 5 * 60,
  maxTwoStepPasswordAttempts: 5,
} as const;

/** Name of the httpOnly refresh-token cookie, scoped to the auth endpoints. */
export const REFRESH_COOKIE = 'bedo_refresh';
export const REFRESH_COOKIE_PATH = '/v1/auth';

/** Phone number as typed by the user, international format with country code. Normalised by the server. */
export const phoneInputSchema = z.string().trim().min(5).max(32);
export const otpCodeSchema = z.string().regex(/^\d{6}$/, 'must be 6 digits');
export const deviceNameSchema = z.string().trim().min(1).max(100);

export const otpRequestBodySchema = z.object({ phone: phoneInputSchema });
export type OtpRequestBody = z.infer<typeof otpRequestBodySchema>;

/**
 * Always the same answer, whether or not the number is on the academy list (D-06):
 * the response never reveals which numbers can sign in.
 */
export const otpRequestResponseSchema = z.object({
  status: z.literal('accepted'),
  resendAfterSeconds: z.number().int(),
  expiresInSeconds: z.number().int(),
});
export type OtpRequestResponse = z.infer<typeof otpRequestResponseSchema>;

export const otpVerifyBodySchema = z.object({
  phone: phoneInputSchema,
  code: otpCodeSchema,
  deviceName: deviceNameSchema.optional(),
});
export type OtpVerifyBody = z.infer<typeof otpVerifyBodySchema>;

export const authenticatedResponseSchema = z.object({
  status: z.literal('authenticated'),
  accessToken: z.string(),
  accessTokenExpiresIn: z.number().int(),
  user: meSchema,
});
export type AuthenticatedResponse = z.infer<typeof authenticatedResponseSchema>;

export const twoStepRequiredResponseSchema = z.object({
  status: z.literal('two_step_required'),
  twoStepToken: z.string(),
  hint: z.string().nullable(),
});
export type TwoStepRequiredResponse = z.infer<typeof twoStepRequiredResponseSchema>;

export const otpVerifyResponseSchema = z.discriminatedUnion('status', [
  authenticatedResponseSchema,
  twoStepRequiredResponseSchema,
]);
export type OtpVerifyResponse = z.infer<typeof otpVerifyResponseSchema>;

export const twoStepVerifyBodySchema = z.object({
  twoStepToken: z.string().min(10).max(200),
  password: z.string().min(1).max(128),
});
export type TwoStepVerifyBody = z.infer<typeof twoStepVerifyBodySchema>;
