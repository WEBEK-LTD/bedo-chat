import { z } from 'zod';
import { ADMIN_RIGHTS, groupDescriptionSchema, groupTitleSchema, MEMBER_PERMISSIONS, userPermissionsSchema } from './groups.js';

/**
 * Phase 10: the rest of the Admin Dashboard (D-44; spec §22). Users, groups and channels, reported messages,
 * the audit history, broadcast notifications (O-20) and statistics. O-18: admins read reported messages and the audit
 * history only, never a chat's messages otherwise. Every action is checked on the server and recorded in the admin
 * audit log; every view of the audit history is recorded too.
 */
export const ADMIN_CONSOLE_RULES = {
  pageSize: 50,
  reasonMinLength: 3,
  reasonMaxLength: 500,
  broadcastTitleMaxLength: 100,
  broadcastBodyMaxLength: 300,
} as const;

const uuid = z.string().uuid();
const timestamp = z.string();
const cursor = z.string().max(200).optional();
const reasonSchema = z.string().trim().min(ADMIN_CONSOLE_RULES.reasonMinLength).max(ADMIN_CONSOLE_RULES.reasonMaxLength);

export const USER_STATUSES = ['active', 'suspended', 'banned', 'deletion_requested', 'deleted'] as const;

/** A user as admins see them in lists. */
export const adminUserSummarySchema = z.object({
  id: z.string(),
  phone: z.string().nullable(),
  name: z.string().nullable(),
  username: z.string().nullable(),
  status: z.enum(USER_STATUSES),
  createdAt: timestamp,
  lastSeenAt: timestamp.nullable(),
});
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const adminUsersQuerySchema = z.object({
  /** Phone digits, name or username (part of it). */
  q: z.string().trim().max(64).optional(),
  status: z.enum(USER_STATUSES).optional(),
  cursor,
});
export const adminUsersResponseSchema = z.object({ users: z.array(adminUserSummarySchema), nextCursor: z.string().nullable() });

const historyEntrySchema = z.object({ at: timestamp, event: z.string(), detail: z.string().nullable() });

export const adminUserDetailSchema = z.object({
  user: adminUserSummarySchema.extend({ bio: z.string().nullable() }),
  twoStepEnabled: z.boolean(),
  permissions: userPermissionsSchema,
  sessions: z.array(z.object({ id: z.string(), deviceName: z.string().nullable(), platform: z.string(), createdAt: timestamp, lastUsedAt: timestamp, ip: z.string().nullable() })),
  counts: z.object({ groups: z.number().int(), channels: z.number().int(), messagesSent: z.number().int(), reportsAgainst: z.number().int(), reportsMade: z.number().int() }),
  deletionRequest: z.object({ id: z.string(), status: z.string(), requestedAt: timestamp }).nullable(),
  accountEvents: z.array(historyEntrySchema),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

/**
 * Suspend (sign-in and sending stopped, sessions ended, reversible), ban (the same, by a Super Admin), reactivate,
 * end every session, or delete the account (Super Admin; the original identity stays in the history, D-14).
 */
export const ADMIN_USER_ACTIONS = ['suspend', 'ban', 'reactivate', 'end_sessions', 'delete'] as const;
export const adminUserActionBodySchema = z.object({ action: z.enum(ADMIN_USER_ACTIONS), reason: reasonSchema });

// ------------------------------------------------------------------------------------ groups and channels

export const ADMIN_CHAT_TYPES = ['group', 'channel'] as const;
const userRefSchema = z.object({ id: z.string(), name: z.string().nullable(), username: z.string().nullable(), phone: z.string().nullable(), status: z.enum(USER_STATUSES) });
export type AdminUserRef = z.infer<typeof userRefSchema>;

export const adminChatsQuerySchema = z.object({ type: z.enum(ADMIN_CHAT_TYPES).optional(), q: z.string().trim().max(64).optional(), cursor });
export const adminChatSummarySchema = z.object({
  id: z.string(),
  type: z.enum(ADMIN_CHAT_TYPES),
  title: z.string(),
  public: z.boolean(),
  /** D-52: a channel every academy account is in, new accounts included (always false for groups). */
  everyone: z.boolean(),
  memberCount: z.number().int(),
  owner: userRefSchema.nullable(),
  createdAt: timestamp,
  lastMessageAt: timestamp.nullable(),
  deleted: z.boolean(),
});
export const adminChatsResponseSchema = z.object({ chats: z.array(adminChatSummarySchema), nextCursor: z.string().nullable() });

export const adminChatMemberSchema = z.object({
  user: userRefSchema,
  role: z.enum(['owner', 'admin', 'member', 'subscriber']),
  adminRights: z.array(z.enum(ADMIN_RIGHTS)),
  deniedPermissions: z.array(z.enum(MEMBER_PERMISSIONS)),
  restrictedUntil: timestamp.nullable(),
  joinedAt: timestamp,
});
export type AdminChatMember = z.infer<typeof adminChatMemberSchema>;

export const adminChatDetailSchema = adminChatSummarySchema.extend({
  description: z.string().nullable(),
  settings: z.object({
    defaultPermissions: z.array(z.enum(MEMBER_PERMISSIONS)),
    hideMemberCount: z.boolean(),
    hideMemberList: z.boolean(),
  }),
  admins: z.array(adminChatMemberSchema),
});
export type AdminChatDetail = z.infer<typeof adminChatDetailSchema>;
export const adminChatMembersQuerySchema = z.object({ after: uuid.optional() });
export const adminChatMembersResponseSchema = z.object({ members: z.array(adminChatMemberSchema), nextAfter: z.string().nullable() });

export const adminCreateChatBodySchema = z.object({
  type: z.enum(ADMIN_CHAT_TYPES),
  title: groupTitleSchema,
  description: groupDescriptionSchema.optional(),
  /** A user owns every group and channel (admins are not chat members). */
  ownerUserId: uuid,
  isPublic: z.boolean().default(false),
  /** D-52, channels only: every academy account becomes a subscriber, and every new account joins it. */
  everyone: z.boolean().default(false),
  memberIds: z.array(uuid).max(50).refine((ids) => new Set(ids).size === ids.length, 'ids must be unique').default([]),
  reason: reasonSchema,
});
export const adminUpdateChatBodySchema = z
  .object({
    title: groupTitleSchema.optional(),
    description: groupDescriptionSchema.optional(),
    isPublic: z.boolean().optional(),
    /** D-52, channels only. Turning it on adds every academy account (not people who left or were removed). */
    everyone: z.boolean().optional(),
    defaultPermissions: z
      .array(z.enum(MEMBER_PERMISSIONS))
      .refine((list) => new Set(list).size === list.length, 'permissions must be unique')
      .optional(),
    hideMemberCount: z.boolean().optional(),
    hideMemberList: z.boolean().optional(),
    reason: reasonSchema,
  })
  .refine((body) => Object.keys(body).length > 1, 'nothing to update');
export const adminChatReasonBodySchema = z.object({ reason: reasonSchema });
export const adminAddChatMembersBodySchema = z.object({
  userIds: z.array(uuid).min(1).max(50).refine((ids) => new Set(ids).size === ids.length, 'ids must be unique'),
  reason: reasonSchema,
});
export const adminUpdateChatMemberBodySchema = z
  .object({
    /** "owner" makes this member the owner (the old owner becomes an admin with every right). */
    role: z.enum(['owner', 'admin', 'member']).optional(),
    adminRights: z
      .array(z.enum(ADMIN_RIGHTS))
      .refine((list) => new Set(list).size === list.length, 'rights must be unique')
      .optional(),
    deniedPermissions: z
      .array(z.enum(MEMBER_PERMISSIONS))
      .refine((list) => new Set(list).size === list.length, 'permissions must be unique')
      .optional(),
    restrictedUntil: z.iso.datetime({ offset: true }).nullable().optional(),
    reason: reasonSchema,
  })
  .refine((body) => Object.keys(body).length > 1, 'nothing to update');

// ---------------------------------------------------------------------------------------- reports

export const REPORT_DECISIONS = ['dismissed', 'message_removed', 'user_suspended', 'user_banned'] as const;
export const adminReportsQuerySchema = z.object({ status: z.enum(['open', 'decided']).default('open'), cursor });
export const adminReportSchema = z.object({
  id: z.string(),
  reason: z.string(),
  details: z.string().nullable(),
  createdAt: timestamp,
  reporter: userRefSchema,
  reportedUser: userRefSchema,
  chat: z.object({ id: z.string(), type: z.string(), title: z.string().nullable() }).nullable(),
  /** O-18: the reported message only, as it was reported and as it is now. */
  message: z
    .object({
      id: z.string(),
      reportedText: z.string().nullable(),
      currentText: z.string().nullable(),
      kind: z.string(),
      attachmentKind: z.string().nullable(),
      deleted: z.boolean(),
      removedByAdmin: z.boolean(),
      sentAt: timestamp,
    })
    .nullable(),
  decision: z.object({ decision: z.enum(REPORT_DECISIONS), note: z.string().nullable(), admin: z.string(), decidedAt: timestamp }).nullable(),
  /** Other reports about the same user. */
  otherReports: z.number().int(),
});
export type AdminReport = z.infer<typeof adminReportSchema>;
export const adminReportsResponseSchema = z.object({ reports: z.array(adminReportSchema), nextCursor: z.string().nullable() });
export const adminDecideReportBodySchema = z.object({
  decision: z.enum(REPORT_DECISIONS),
  note: z.string().trim().min(1).max(ADMIN_CONSOLE_RULES.reasonMaxLength).optional(),
});

// ---------------------------------------------------------------------------------- audit history

/** D-17, D-18: what an investigation can look at. Every request records who looked, at what, and why. */
export const AUDIT_KINDS = ['messages', 'identity', 'membership', 'account', 'security', 'screenshots', 'admin'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export const adminAuditQuerySchema = z.object({
  kind: z.enum(AUDIT_KINDS),
  userId: uuid.optional(),
  chatId: uuid.optional(),
  /** Why the history is being read (recorded with the view). */
  reason: reasonSchema,
  cursor,
});
export const adminAuditEntrySchema = z.object({
  at: timestamp,
  event: z.string(),
  /** Who acted ("user <id>", "admin <name>", "system"). */
  actor: z.string().nullable(),
  /** Whom or what it concerns. */
  subject: z.string().nullable(),
  /** Old and new values, previous text, details. */
  detail: z.string().nullable(),
});
export const adminAuditResponseSchema = z.object({ entries: z.array(adminAuditEntrySchema), nextCursor: z.string().nullable() });

// -------------------------------------------------------------------------------------- broadcasts

export const adminBroadcastBodySchema = z
  .object({
    title: z.string().trim().min(1).max(ADMIN_CONSOLE_RULES.broadcastTitleMaxLength),
    body: z.string().trim().min(1).max(ADMIN_CONSOLE_RULES.broadcastBodyMaxLength),
    /** O-20: everyone, or the members of one group or channel. */
    audience: z.enum(['all', 'chat']),
    chatId: uuid.optional(),
  })
  .refine((body) => (body.audience === 'chat') === (body.chatId !== undefined), 'a chat audience needs its chat, and only it');
export const adminBroadcastSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  audience: z.enum(['all', 'chat']),
  chat: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
  status: z.enum(['sending', 'sent']),
  devices: z.number().int(),
  admin: z.string(),
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
});
export const adminBroadcastsResponseSchema = z.object({ broadcasts: z.array(adminBroadcastSchema) });

// ------------------------------------------------------------------------------------- speed check (Phase 14.4)

/**
 * Where the website's server runs and how long one database step takes from there. Region codes are the cloud's
 * (AWS: us-east-2 is Ohio, ap-southeast-2 is Sydney); null when unknown (a local run).
 */
export const adminSpeedCheckSchema = z.object({
  serverRegion: z.string().nullable(),
  databaseRegion: z.string().nullable(),
  /** The middle of three "select 1" round trips, in milliseconds. */
  databaseRoundTripMs: z.number(),
  /** True when both are known and the same; false when known and different. */
  sameRegion: z.boolean().nullable(),
});
export type AdminSpeedCheck = z.infer<typeof adminSpeedCheckSchema>;

// ------------------------------------------------------------------------------------- site monitoring (Phase 14.5)

export const MONITORING_INCIDENT_KINDS = ['outage', 'storage', 'whatsapp', 'database_slow'] as const;
export type MonitoringIncidentKind = (typeof MONITORING_INCIDENT_KINDS)[number];
/** A ten-minute step of the timeline: all checks fine, a problem, no check at all, or before monitoring started. */
export const MONITORING_TIMELINE_STATES = ['ok', 'problem', 'missing', 'none'] as const;
export type MonitoringTimelineState = (typeof MONITORING_TIMELINE_STATES)[number];

export const adminMonitoringSchema = z.object({
  /** up; problem (an open incident); not_reporting (no minute check for 3 minutes); not_started (never checked). */
  status: z.enum(['up', 'problem', 'not_reporting', 'not_started']),
  monitoringSince: z.string().nullable(),
  lastCheckAt: z.string().nullable(),
  serverRegion: z.string().nullable(),
  /** Percent of minutes with a successful check (null before the first check). */
  uptime: z.object({ day: z.number().nullable(), week: z.number().nullable(), month: z.number().nullable() }),
  databaseMs: z.object({ last: z.number().nullable(), average: z.number().nullable() }),
  storage: z.object({ ok: z.boolean().nullable(), ms: z.number().nullable(), checkedAt: z.string().nullable() }),
  whatsappFailuresDay: z.number().int(),
  whatsappAlerts: z.boolean(),
  timeline: z.array(z.object({ start: z.string(), state: z.enum(MONITORING_TIMELINE_STATES) })),
  incidents: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(MONITORING_INCIDENT_KINDS),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      detail: z.string().nullable(),
      alerted: z.boolean(),
    }),
  ),
});
export type AdminMonitoring = z.infer<typeof adminMonitoringSchema>;

export const adminMonitoringCheckSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  databaseMs: z.number(),
  storageOk: z.boolean().nullable(),
  storageMs: z.number().nullable(),
  serverRegion: z.string().nullable(),
});
export type AdminMonitoringCheck = z.infer<typeof adminMonitoringCheckSchema>;

export const adminMonitoringSettingsBodySchema = z.object({ whatsappAlerts: z.boolean() });

// ------------------------------------------------------------------------------------- statistics

export const adminStatsSchema = z.object({
  users: z.object({ total: z.number().int(), active: z.number().int(), suspended: z.number().int(), banned: z.number().int(), deletionRequested: z.number().int(), deleted: z.number().int() }),
  onlineNow: z.number().int(),
  activeLast24h: z.number().int(),
  messages: z.object({ last24h: z.number().int(), last7Days: z.number().int() }),
  groups: z.number().int(),
  channels: z.number().int(),
  openReports: z.number().int(),
  pendingDeletionRequests: z.number().int(),
  activeSessions: z.number().int(),
  pushDevices: z.number().int(),
  pendingScheduledMessages: z.number().int(),
});
export type AdminStats = z.infer<typeof adminStatsSchema>;

// ------------------------------------------------------------------------------- who can create an account

/** D-47: anyone with a WhatsApp number (the default), or only numbers on the academy phone list (D-06). */
export const SIGNUP_MODES = ['open', 'academy_list'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];
export const adminAccessSettingsSchema = z.object({
  signupMode: z.enum(SIGNUP_MODES),
  updatedBy: z.string().nullable(),
  updatedAt: timestamp.nullable(),
});
export type AdminAccessSettings = z.infer<typeof adminAccessSettingsSchema>;
export const adminAccessSettingsBodySchema = z.object({ signupMode: z.enum(SIGNUP_MODES) });

/** D-56: the store review account (Super Admins only: the answer holds the code). */
export const adminReviewAccountSchema = z.object({
  enabled: z.boolean(),
  phone: z.string().nullable(),
  code: z.string().nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: timestamp.nullable(),
});
export type AdminReviewAccount = z.infer<typeof adminReviewAccountSchema>;
export const adminReviewAccountBodySchema = z.object({
  enabled: z.boolean(),
  phone: z.string().trim().min(5).max(32),
  code: z.string().regex(/^\d{6}$/, 'must be 6 digits'),
});

/**
 * D-59: test accounts (Super Admins only: the answer holds the code). Ranges of numbers that sign in to the student
 * app with one fixed code; each number is its own account. Separate from the store review account.
 */
export const TEST_ACCOUNT_RULES = {
  /** Numbers in one range. */
  maxRangeSize: 1000,
  /** Ranges in all. */
  maxRanges: 50,
  /** Codes per address per hour for test numbers: their own allowance, so testing never uses up real students'. */
  maxCodesPerIpPerHour: 200,
} as const;
export const adminTestNumberRangeSchema = z.object({
  id: z.string(),
  firstPhone: z.string(),
  lastPhone: z.string(),
  /** How many numbers the range holds. */
  size: z.number().int(),
  /** How many of them have signed in at least once (have an account). */
  accounts: z.number().int(),
  addedBy: z.string().nullable(),
  addedAt: timestamp,
});
export type AdminTestNumberRange = z.infer<typeof adminTestNumberRangeSchema>;
export const adminTestAccountsSchema = z.object({
  enabled: z.boolean(),
  code: z.string().nullable(),
  ranges: z.array(adminTestNumberRangeSchema),
  updatedBy: z.string().nullable(),
  updatedAt: timestamp.nullable(),
});
export type AdminTestAccounts = z.infer<typeof adminTestAccountsSchema>;
export const adminTestAccountsBodySchema = z.object({
  enabled: z.boolean(),
  code: z.string().regex(/^\d{6}$/, 'must be 6 digits'),
});
export const adminTestNumberRangeBodySchema = z.object({
  firstPhone: z.string().trim().min(5).max(32),
  lastPhone: z.string().trim().min(5).max(32),
});
