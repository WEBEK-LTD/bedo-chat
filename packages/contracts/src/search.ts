import { z } from 'zod';
import { messageSchema } from './messaging.js';

/**
 * Phase 8: global search (D-42; blueprint: Search §10). Messages, files, images and voice messages across every chat
 * the signed-in user is in, filtered by words, kind, chat, sender and dates. Chats and people are found by the chat
 * list (the user's own chats) and people search (P-25). Every query starts from the user's own memberships: nothing
 * from a chat they are not in, nothing deleted, nothing they deleted for themselves.
 */
export const SEARCH_RULES = {
  maxLength: 100,
  pageSize: 30,
} as const;

/** "messages": any message; the others: messages carrying that kind of file (the chat media tabs' groups). */
export const SEARCH_KINDS = ['messages', 'media', 'files', 'voice'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

const uuid = z.string().uuid();
const instant = z.iso.datetime({ offset: true });

export const globalSearchQuerySchema = z
  .object({
    q: z.string().trim().max(SEARCH_RULES.maxLength).default(''),
    kind: z.enum(SEARCH_KINDS).default('messages'),
    /** Only this chat. */
    chatId: uuid.optional(),
    /** Only messages this person sent (never in channels where the user does not see who posts). */
    fromUserId: uuid.optional(),
    /** Sent at or after / before these times. */
    after: instant.optional(),
    before: instant.optional(),
    /** The `nextCursor` of the previous page. */
    cursor: uuid.optional(),
  })
  .refine(
    (query) => query.q.length > 0 || query.kind !== 'messages' || query.fromUserId !== undefined || query.after !== undefined || query.before !== undefined,
    'nothing to search for',
  );
export type GlobalSearchQuery = z.infer<typeof globalSearchQuerySchema>;

export const globalSearchResponseSchema = z.object({
  /** Newest first. */
  messages: z.array(messageSchema),
  nextCursor: z.string().nullable(),
});
export type GlobalSearchResponse = z.infer<typeof globalSearchResponseSchema>;
