import { z } from 'zod';
import { platformSchema, userStatusSchema } from './me.js';

export const ADMIN_SESSION_COOKIE = 'bedo_admin_session';
export const ADMIN_SESSION_COOKIE_PATH = '/v1/admin';
/** Admin session limits (P-13). */
export const ADMIN_SESSION_RULES = { absoluteHours: 12, idleMinutes: 30, pendingTokenSeconds: 5 * 60 } as const;

export const adminRoleSchema = z.enum(['super_admin', 'moderator']);
export const adminSchema = z.object({ id: z.string(), name: z.string(), role: adminRoleSchema });
export type AdminInfo = z.infer<typeof adminSchema>;

export const adminOtpRequestBodySchema = z.object({ phone: z.string().trim().min(5).max(32) });
export const adminOtpVerifyBodySchema = z.object({
  phone: z.string().trim().min(5).max(32),
  code: z.string().regex(/^\d{6}$/, 'must be 6 digits'),
});
export const adminOtpVerifyResponseSchema = z.object({
  status: z.literal('totp_required'),
  pendingToken: z.string(),
});
export const adminTotpVerifyBodySchema = z.object({
  pendingToken: z.string().min(10).max(200),
  code: z.string().regex(/^\d{6}$/, 'must be 6 digits'),
});
export const adminSessionResponseSchema = z.object({ admin: adminSchema });

export const phoneListItemSchema = z.object({
  phone: z.string(),
  note: z.string().nullable(),
  addedAt: z.string(),
  accountStatus: userStatusSchema.nullable(),
});
export const phoneListResponseSchema = z.object({
  items: z.array(phoneListItemSchema),
  nextCursor: z.string().nullable(),
});
export const phoneListQuerySchema = z.object({
  search: z.string().trim().max(32).optional(),
  cursor: z.string().max(40).optional(),
});
export const phoneListAddBodySchema = z.object({
  phone: z.string().trim().min(5).max(32),
  note: z.string().trim().min(1).max(200).optional(),
});
export const phoneListAddResponseSchema = z.object({ phone: z.string(), added: z.boolean() });
/** CSV import: one number per line, optional note in the second column (P-11). */
export const phoneListImportBodySchema = z.object({ csv: z.string().min(1).max(1_000_000) });
export const phoneListImportResponseSchema = z.object({
  added: z.number().int(),
  duplicates: z.array(z.string()),
  invalid: z.array(z.object({ line: z.number().int(), value: z.string(), reason: z.string() })),
});

export const deletionRequestStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export const deletionRequestItemSchema = z.object({
  id: z.string(),
  status: deletionRequestStatusSchema,
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  user: z.object({
    id: z.string(),
    phone: z.string().nullable(),
    name: z.string().nullable(),
    username: z.string().nullable(),
  }),
});
export const deletionRequestListResponseSchema = z.object({ items: z.array(deletionRequestItemSchema) });
export const deletionRequestListQuerySchema = z.object({ status: deletionRequestStatusSchema.default('pending') });

const historyEntry = z.object({ at: z.string(), event: z.string(), detail: z.string().nullable() });
export const deletionRequestDetailSchema = z.object({
  request: deletionRequestItemSchema.extend({ decisionReason: z.string().nullable(), decidedBy: z.string().nullable() }),
  account: z.object({
    status: userStatusSchema,
    createdAt: z.string(),
    bio: z.string().nullable(),
    twoStepEnabled: z.boolean(),
    activeSessions: z.array(
      z.object({ deviceName: z.string().nullable(), platform: platformSchema, lastUsedAt: z.string(), ip: z.string().nullable() }),
    ),
  }),
  identityHistory: z.array(historyEntry),
  accountEvents: z.array(historyEntry),
  securityEvents: z.array(historyEntry),
});
export type DeletionRequestDetail = z.infer<typeof deletionRequestDetailSchema>;
export const deletionDecisionBodySchema = z.object({ reason: z.string().trim().min(1).max(500).optional() });

export const twoStepResetBodySchema = z.object({
  phone: z.string().trim().min(5).max(32),
  /** How the user's identity was verified (D-12); stored in the audit history. */
  reason: z.string().trim().min(3).max(500),
});
export const twoStepResetResponseSchema = z.object({ reset: z.literal(true) });
