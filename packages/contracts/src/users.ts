import { z } from 'zod';

/** What other users see instead of a deleted account's identity (D-14). */
export const DELETED_ACCOUNT_NAME = 'Deleted account';

/**
 * How one user appears to other users. Every feature that shows another user (chats in Phase 3,
 * groups, channels, calls) builds this view through the API's single `toPublicUser` function, so a
 * deleted account always appears as "Deleted account" with no name, username, bio or picture.
 */
export const publicUserSchema = z.object({
  id: z.string(),
  deleted: z.boolean(),
  displayName: z.string(),
  username: z.string().nullable(),
  bio: z.string().nullable(),
  photoUrl: z.string().nullable(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;
