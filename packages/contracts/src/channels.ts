import { z } from 'zod';
import { FILE_KINDS } from './media.js';
import { groupDescriptionSchema, groupTitleSchema } from './groups.js';
import { MESSAGING_RULES, messageTextSchema, sendMessageBodySchema } from './messaging.js';

/**
 * Phase 6: channels and scheduled messages (D-40). The API enforces these values; the apps use them for their own
 * checks.
 */
export const CHANNEL_RULES = {
  /** Subscribers per channel (the blueprint's academy-wide announcements; groups stay at 500). */
  maxSubscribers: 5000,
  /** Channels created per user per day. */
  channelsPerDay: 5,
  searchMinLength: 2,
  searchMaxLength: 64,
  searchResults: 20,
} as const;

export const SCHEDULE_RULES = {
  /** A message is scheduled at least this far ahead (the apps offer one minute or more). */
  minAheadSeconds: 5,
  /** And at most this far (blueprint: one year). */
  maxAheadDays: 365,
  /** Pending scheduled messages per user in one chat. */
  maxPendingPerChat: 100,
  /** A scheduled message the API could not send is retried this many times before it is marked failed. */
  maxAttempts: 5,
} as const;

const uuid = z.string().uuid();
const timestamp = z.string();

export const createChannelBodySchema = z.object({
  title: groupTitleSchema,
  description: groupDescriptionSchema.optional(),
  /** Public: every academy user can find and join it; private: invite links only. */
  isPublic: z.boolean().default(false),
});
export type CreateChannelBody = z.infer<typeof createChannelBodySchema>;

export const channelSearchQuerySchema = z.object({
  q: z.string().trim().min(CHANNEL_RULES.searchMinLength).max(CHANNEL_RULES.searchMaxLength),
});

/** A public channel in search results: what it is, how many subscribed, and whether the signed-in user did. */
export const publicChannelSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  photoUrl: z.string().nullable(),
  subscriberCount: z.number().int().nonnegative(),
  subscribed: z.boolean(),
});
export type PublicChannel = z.infer<typeof publicChannelSchema>;
export const channelSearchResponseSchema = z.object({ channels: z.array(publicChannelSchema) });

// ------------------------------------------------------------------------------------ Scheduled messages

const sendAtSchema = z.iso.datetime({ offset: true });

/** Schedule a message: the same body as sending one (its client id included), and when to send it. */
export const scheduleMessageBodySchema = z.object({
  sendAt: sendAtSchema,
  message: sendMessageBodySchema,
});
export type ScheduleMessageBody = z.infer<typeof scheduleMessageBodySchema>;

export const updateScheduledBodySchema = z
  .object({
    sendAt: sendAtSchema.optional(),
    /** New text or caption (not for stickers, GIFs and polls). */
    text: sendMessageBodySchema.shape.text,
  })
  .refine((body) => body.sendAt !== undefined || body.text !== undefined, 'nothing to update');

/**
 * A scheduled message as its author sees it (only the author does). `failed` with `error`: the API could not send it
 * when due (for example the author may no longer post there); it stays in the list until removed or sent again.
 */
export const scheduledMessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  clientId: z.string(),
  sendAt: timestamp,
  status: z.enum(['pending', 'failed']),
  error: z.string().nullable(),
  text: z.string().nullable(),
  /** What it carries besides text. */
  media: z.enum([...FILE_KINDS, 'sticker', 'poll']).nullable(),
  /** The file's name, for documents. */
  fileName: z.string().nullable(),
  pollQuestion: z.string().nullable(),
  replyToId: z.string().nullable(),
  createdAt: timestamp,
});
export type ScheduledMessage = z.infer<typeof scheduledMessageSchema>;
export const scheduledMessagesResponseSchema = z.object({ scheduled: z.array(scheduledMessageSchema) });
export const scheduledIdParamsSchema = z.object({ id: uuid });
/** The internal dispatch run (the scheduled Netlify function): how many messages it sent and how many failed. */
export const dispatchResponseSchema = z.object({ sent: z.number().int(), failed: z.number().int() });

// ------------------------------------------------------------------------------- Comments on channel posts

/**
 * Comments on channel posts (migration 20261115120000). Off in every channel until its owner, or an admin with the
 * right to change the channel info, turns them on. Comments are not announced to devices (no update log entries, no
 * notifications: a channel has up to 5,000 subscribers); the apps fetch them while a post's comments are open.
 */
export const COMMENT_RULES = {
  /** The same as a message (P-16). */
  textMaxLength: MESSAGING_RULES.textMaxLength,
  /** Comments per page, oldest first. */
  pageSize: 50,
  /** Characters of the replied-to comment shown in a reply. */
  replyPreviewLength: MESSAGING_RULES.replyPreviewLength,
  /** How often the apps refresh open comments (seconds). */
  refreshSeconds: 10,
} as const;

/** Turn comments on or off for a channel. */
export const channelCommentSettingsBodySchema = z.object({ enabled: z.boolean() });
export type ChannelCommentSettingsBody = z.infer<typeof channelCommentSettingsBodySchema>;

export const commentAuthorSchema = z.object({
  id: z.string(),
  /** "Deleted account" for deleted accounts. */
  displayName: z.string(),
  /** Only where the author's photo privacy and blocks allow. */
  photoUrl: z.string().nullable(),
  deleted: z.boolean(),
});

export const channelCommentSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  /** The channel post this comment is on. */
  postId: z.string(),
  author: commentAuthorSchema,
  clientId: z.string(),
  text: z.string(),
  /** The comment this one replies to (on the same post); its text is null once that comment was deleted. */
  replyTo: z.object({ id: z.string(), authorName: z.string(), text: z.string().nullable() }).nullable(),
  createdAt: timestamp,
  editedAt: timestamp.nullable(),
  /** The signed-in user wrote it: they may edit and delete it. */
  mine: z.boolean(),
  /** The signed-in user may delete it: its author, the channel's owner, or an admin with the right to delete messages. */
  canDelete: z.boolean(),
});
export type ChannelComment = z.infer<typeof channelCommentSchema>;

export const channelCommentsQuerySchema = z.object({
  /** The last comment id of the previous page: the next page holds the comments after it. */
  after: uuid.optional(),
});
export const channelCommentsResponseSchema = z.object({
  /** Oldest first, at most 50; deleted comments are left out. */
  comments: z.array(channelCommentSchema),
  /** Pass as `after` for the next page; null on the last page. */
  nextAfter: z.string().nullable(),
  /** All comments of the post. */
  count: z.number().int().nonnegative(),
  /** The signed-in user may comment now. */
  canComment: z.boolean(),
});
export type ChannelCommentsResponse = z.infer<typeof channelCommentsResponseSchema>;

export const createCommentBodySchema = z.object({
  /** Generated by the app once per comment and reused for every retry (never stores a duplicate). */
  clientId: uuid,
  text: messageTextSchema,
  /** Another comment of the same post. */
  replyToId: uuid.optional(),
});
export type CreateCommentBody = z.infer<typeof createCommentBodySchema>;
export const editCommentBodySchema = z.object({ text: messageTextSchema });
