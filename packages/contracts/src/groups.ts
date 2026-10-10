import { z } from 'zod';
import { characterCount } from './text.js';
import { publicUserSchema } from './users.js';

/**
 * Phase 5: groups (D-39). Values approved with the Phase 5 decisions (O-02, O-03, O-04, O-12 group size, O-21);
 * the API enforces them, the apps use them for their own checks.
 */
export const GROUP_RULES = {
  titleMaxLength: 128,
  descriptionMaxLength: 255,
  /** O-12: members per group. */
  maxMembers: 500,
  /** Blueprint rate limit: groups created per user per day. */
  groupsPerDay: 10,
  /** Members added in one request (creation included). */
  addAtOnce: 50,
  /** Active invite links per group. */
  maxInviteLinks: 20,
  inviteLinkNameMaxLength: 32,
  membersPageSize: 50,
  /** Polls. */
  pollQuestionMaxLength: 300,
  pollOptionMaxLength: 100,
  pollMinOptions: 2,
  pollMaxOptions: 10,
  pollExplanationMaxLength: 200,
  /** Mentions counted per message (the rest stay plain text). */
  maxMentions: 20,
  /** Membership, info and admin changes per user per minute (they notify every member's devices). */
  groupActionsPerMinute: 60,
} as const;

/** O-21 admin rights. The owner holds all of them. `post_messages` is for channels (Phase 6): who may publish. */
export const ADMIN_RIGHTS = ['change_info', 'delete_messages', 'restrict_members', 'invite_users', 'approve_requests', 'pin_messages', 'manage_admins', 'change_privacy', 'post_messages'] as const;
export type AdminRight = (typeof ADMIN_RIGHTS)[number];
/** Phase 6: the rights that apply in a group (no posting right: members post) or a channel (no member privacy). */
export function adminRightsFor(type: 'group' | 'channel' | 'private'): AdminRight[] {
  if (type === 'private') return [];
  return ADMIN_RIGHTS.filter((right) => (type === 'channel' ? right !== 'change_privacy' : right !== 'post_messages'));
}
/** O-21 member permissions: the group's defaults, minus what an admin restricts for one member. Admins have all. */
export const MEMBER_PERMISSIONS = ['send_messages', 'send_media', 'send_stickers', 'send_polls', 'add_members', 'pin_messages', 'change_info'] as const;
export type MemberPermission = (typeof MEMBER_PERMISSIONS)[number];
export const DEFAULT_MEMBER_PERMISSIONS: readonly MemberPermission[] = ['send_messages', 'send_media', 'send_stickers', 'send_polls', 'add_members', 'pin_messages'];
/** `subscriber`: a channel's readers (Phase 6). */
export const MEMBER_ROLES = ['owner', 'admin', 'member', 'subscriber'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

const uuid = z.string().uuid();
const timestamp = z.string();
const uniqueIds = (max: number) =>
  z
    .array(uuid)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, 'ids must be unique');

export const groupTitleSchema = z
  .string()
  .trim()
  .min(1)
  .refine((title) => characterCount(title) <= GROUP_RULES.titleMaxLength, `at most ${GROUP_RULES.titleMaxLength} characters`);
export const groupDescriptionSchema = z
  .string()
  .trim()
  .refine((text) => characterCount(text) <= GROUP_RULES.descriptionMaxLength, `at most ${GROUP_RULES.descriptionMaxLength} characters`);

/**
 * A group as one member sees it. Member privacy (§7): `memberCount` is null when the count is hidden from this member,
 * `canViewMembers` false when the list is; `settings` and `pendingRequests` are only for owners and admins (null for
 * everyone else). Nothing else about other members is in it.
 */
export const groupInfoSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  photoUrl: z.string().nullable(),
  role: z.enum(MEMBER_ROLES),
  /** The signed-in member's admin rights (all of them for the owner, none for a member). */
  adminRights: z.array(z.enum(ADMIN_RIGHTS)),
  /** What the signed-in member may do now (restrictions applied). */
  permissions: z.array(z.enum(MEMBER_PERMISSIONS)),
  /** When this member's restriction ends; null when not restricted or restricted until lifted (see `restricted`). */
  restrictedUntil: timestamp.nullable(),
  restricted: z.boolean(),
  memberCount: z.number().int().nonnegative().nullable(),
  canViewMembers: z.boolean(),
  settings: z
    .object({
      defaultPermissions: z.array(z.enum(MEMBER_PERMISSIONS)),
      hideMemberCount: z.boolean(),
      hideMemberList: z.boolean(),
    })
    .nullable(),
  /** Pending join requests, for members who may approve them. */
  pendingRequests: z.number().int().nonnegative().nullable(),
  /** Phase 6, channels: anyone in the academy can find and join it (false for groups). */
  public: z.boolean(),
});
export type GroupInfo = z.infer<typeof groupInfoSchema>;

export const createGroupBodySchema = z.object({
  title: groupTitleSchema,
  description: groupDescriptionSchema.optional(),
  memberIds: uniqueIds(GROUP_RULES.addAtOnce).default([]),
});
export const updateGroupBodySchema = z
  .object({ title: groupTitleSchema.optional(), description: groupDescriptionSchema.optional() })
  .refine((body) => Object.keys(body).length > 0, 'nothing to update');
export const groupSettingsBodySchema = z
  .object({
    defaultPermissions: z
      .array(z.enum(MEMBER_PERMISSIONS))
      .refine((list) => new Set(list).size === list.length, 'permissions must be unique')
      .optional(),
    hideMemberCount: z.boolean().optional(),
    hideMemberList: z.boolean().optional(),
    /** Phase 6, channels only: public (found in search, joined directly) or private (invite links only). */
    isPublic: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to update');

export const groupMemberSchema = z.object({
  user: publicUserSchema,
  role: z.enum(MEMBER_ROLES),
  adminRights: z.array(z.enum(ADMIN_RIGHTS)),
  deniedPermissions: z.array(z.enum(MEMBER_PERMISSIONS)),
  restrictedUntil: timestamp.nullable(),
  joinedAt: timestamp,
});
export type GroupMember = z.infer<typeof groupMemberSchema>;
export const groupMembersQuerySchema = z.object({ after: uuid.optional() });
/** Only for members allowed to see the list (owner, admins, or when the list is not hidden). */
export const groupMembersResponseSchema = z.object({
  members: z.array(groupMemberSchema),
  count: z.number().int().nonnegative().nullable(),
  nextAfter: z.string().nullable(),
});
export type GroupMembersResponse = z.infer<typeof groupMembersResponseSchema>;

export const addMembersBodySchema = z.object({ userIds: uniqueIds(GROUP_RULES.addAtOnce).refine((ids) => ids.length > 0, 'at least one') });
export const addMembersResponseSchema = z.object({
  added: z.array(z.string()),
  /** Ids that could not be added (their privacy, a block, deleted accounts); never why. */
  notAdded: z.array(z.string()),
});
export const updateMemberBodySchema = z
  .object({
    /** "member" in a channel makes the admin a subscriber again. */
    role: z.enum(['admin', 'member']).optional(),
    adminRights: z
      .array(z.enum(ADMIN_RIGHTS))
      .refine((list) => new Set(list).size === list.length, 'rights must be unique')
      .optional(),
    deniedPermissions: z
      .array(z.enum(MEMBER_PERMISSIONS))
      .refine((list) => new Set(list).size === list.length, 'permissions must be unique')
      .optional(),
    /** The restriction ends then; null: until lifted. */
    restrictedUntil: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to update');
export const transferOwnershipBodySchema = z.object({ userId: uuid });

// ---------------------------------------------------------------------------------- Invite links

export const inviteLinkSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string().nullable(),
  createdAt: timestamp,
  expiresAt: timestamp.nullable(),
  usageLimit: z.number().int().nullable(),
  usageCount: z.number().int(),
  requiresApproval: z.boolean(),
  revoked: z.boolean(),
});
export type InviteLink = z.infer<typeof inviteLinkSchema>;
export const inviteLinksResponseSchema = z.object({ links: z.array(inviteLinkSchema) });
export const createInviteLinkBodySchema = z.object({
  name: z.string().trim().min(1).max(GROUP_RULES.inviteLinkNameMaxLength).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  usageLimit: z.number().int().min(1).max(100000).optional(),
  requiresApproval: z.boolean().default(false),
});
export const inviteCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/** What someone with a link sees before joining. The member count only when the group shows it to members. */
export const invitePreviewSchema = z.object({
  /** Phase 6: a group or a channel. */
  type: z.enum(['group', 'channel']),
  title: z.string(),
  description: z.string().nullable(),
  photoUrl: z.string().nullable(),
  memberCount: z.number().int().nullable(),
  requiresApproval: z.boolean(),
  /** Set when the signed-in user is already a member. */
  chatId: z.string().nullable(),
  /** The signed-in user already asked to join and waits for an admin. */
  requested: z.boolean(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;
export const joinResponseSchema = z.object({ status: z.enum(['joined', 'requested']), chatId: z.string().nullable() });

export const joinRequestSchema = z.object({ id: z.string(), user: publicUserSchema, requestedAt: timestamp });
export const joinRequestsResponseSchema = z.object({ requests: z.array(joinRequestSchema) });

// ------------------------------------------------------------------------------------------ Polls

export const pollInputSchema = z
  .object({
    question: z.string().trim().min(1).max(GROUP_RULES.pollQuestionMaxLength),
    options: z
      .array(z.string().trim().min(1).max(GROUP_RULES.pollOptionMaxLength))
      .min(GROUP_RULES.pollMinOptions)
      .max(GROUP_RULES.pollMaxOptions)
      .refine((options) => new Set(options.map((option) => option.toLowerCase())).size === options.length, 'options must differ'),
    kind: z.enum(['regular', 'quiz']).default('regular'),
    anonymous: z.boolean().default(true),
    multiple: z.boolean().default(false),
    /** Quiz: the index of the right answer. */
    correctOption: z.number().int().min(0).max(GROUP_RULES.pollMaxOptions - 1).optional(),
    explanation: z.string().trim().min(1).max(GROUP_RULES.pollExplanationMaxLength).optional(),
  })
  .superRefine((poll, ctx) => {
    if (poll.kind === 'quiz') {
      if (poll.correctOption === undefined || poll.correctOption >= poll.options.length) {
        ctx.addIssue({ code: 'custom', path: ['correctOption'], message: 'a quiz needs its right answer' });
      }
      if (poll.multiple) ctx.addIssue({ code: 'custom', path: ['multiple'], message: 'a quiz has one answer' });
    } else if (poll.correctOption !== undefined || poll.explanation !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['correctOption'], message: 'only a quiz has a right answer' });
    }
  });
export type PollInput = z.infer<typeof pollInputSchema>;

/**
 * A poll as one member sees it. Results (counts) only after voting or once closed; a quiz's right answer and
 * explanation the same. Who voted is never here (a separate endpoint, never for anonymous polls).
 */
export const pollSchema = z.object({
  id: z.string(),
  question: z.string(),
  kind: z.enum(['regular', 'quiz']),
  anonymous: z.boolean(),
  multiple: z.boolean(),
  closed: z.boolean(),
  options: z.array(z.object({ text: z.string(), votes: z.number().int().nullable() })),
  totalVoters: z.number().int().nullable(),
  myVotes: z.array(z.number().int()).nullable(),
  correctOption: z.number().int().nullable(),
  explanation: z.string().nullable(),
});
export type Poll = z.infer<typeof pollSchema>;
export const pollVoteBodySchema = z.object({
  options: z
    .array(z.number().int().min(0).max(GROUP_RULES.pollMaxOptions - 1))
    .min(1)
    .max(GROUP_RULES.pollMaxOptions)
    .refine((list) => new Set(list).size === list.length, 'options must be unique'),
});
export const pollVotersResponseSchema = z.object({
  options: z.array(z.object({ voters: z.array(publicUserSchema) })),
});

// ------------------------------------------------------------------------------ System permissions

/** O-21: what an admin lets one user do across Bedo Chat. */
export const userPermissionsSchema = z.object({
  createGroups: z.boolean(),
  createChannels: z.boolean(),
  scheduleMessages: z.boolean(),
});
export type UserPermissions = z.infer<typeof userPermissionsSchema>;
export const adminUserPermissionsQuerySchema = z.object({ phone: z.string().trim().min(5).max(32) });
export const adminUserPermissionsResponseSchema = z.object({
  user: z.object({ id: z.string(), phone: z.string(), name: z.string().nullable(), status: z.string() }),
  permissions: userPermissionsSchema,
});
export const adminUserPermissionsBodySchema = userPermissionsSchema.extend({ phone: z.string().trim().min(5).max(32) });
