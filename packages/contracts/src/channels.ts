import { z } from 'zod';
import { FILE_KINDS } from './media.js';
import { groupDescriptionSchema, groupTitleSchema } from './groups.js';
import { sendMessageBodySchema } from './messaging.js';

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
