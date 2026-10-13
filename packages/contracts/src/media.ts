import { z } from 'zod';

/**
 * Phase 4: media, stickers, GIFs and reactions (D-38). Values approved with the Phase 4 decisions (O-09 to
 * O-12, O-30); the API enforces them, the apps use them for their own checks before uploading.
 */
export const MEDIA_RULES = {
  /** O-12: the largest file of any kind (the private bucket refuses anything bigger). */
  maxFileBytes: 50 * 1024 * 1024,
  /** Per kind, never above maxFileBytes. Photos are resized on the device first (longest side 2560 px). */
  maxBytes: {
    photo: 20 * 1024 * 1024,
    video: 50 * 1024 * 1024,
    audio: 50 * 1024 * 1024,
    voice: 20 * 1024 * 1024,
    video_note: 20 * 1024 * 1024,
    file: 50 * 1024 * 1024,
    gif: 8 * 1024 * 1024,
  },
  photoMaxSide: 2560,
  /** O-12: voice messages up to 15 minutes, video messages up to 60 seconds. */
  voiceMaxDurationMs: 15 * 60 * 1000,
  videoNoteMaxDurationMs: 60 * 1000,
  /** Previews made on the device (no server conversion, D-36): JPEG or WebP, longest side 480 px. */
  thumbnailMaxBytes: 200 * 1024,
  thumbnailMaxSide: 480,
  waveformMaxBars: 100,
  fileNameMaxLength: 255,
  /** Upload slots per user per hour; an unused slot expires after a day. */
  uploadsPerHour: 120,
  uploadSlotHours: 24,
  /** Signed download links: a file (or full-size picture) 5 minutes, previews an hour. */
  fileUrlSeconds: 300,
  thumbnailUrlSeconds: 3600,
  /** The media panel's page size. */
  mediaPageSize: 30,
  /** Stickers (O-10). */
  stickerMaxBytes: 512 * 1024,
  stickerMaxSide: 512,
  stickerPackNameMaxLength: 64,
  maxStickersPerPack: 120,
  /** GIFs (O-09). */
  gifSearchMaxLength: 50,
  gifPageSize: 24,
  gifSearchesPerMinute: 30,
  gifPreviewMaxBytes: 2 * 1024 * 1024,
  /** Reactions per user per minute (with pins and blocks under the peer-action guard). */
  reactionsPerMinute: 60,
  /** Phase 9: signed file links per user per minute (opening and saving files, playing voice messages). */
  fileLinksPerMinute: 300,
} as const;

export const FILE_KINDS = ['photo', 'video', 'audio', 'voice', 'video_note', 'file', 'gif'] as const;
export type FileKind = (typeof FILE_KINDS)[number];
/** Kinds a person uploads; GIFs come only from GIF search. */
export const UPLOAD_KINDS = ['photo', 'video', 'audio', 'voice', 'video_note', 'file'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/** The reactions offered (one per person per message). */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏', '🎉', '👎'] as const;

/**
 * File types each kind accepts, as detected from the stored bytes (the declared type is not trusted). Files of
 * kind "file" may be anything except programs (O-30: no malware scanning without a worker, so programs are
 * refused and every other file is only ever downloaded, never opened by the browser).
 */
export const MEDIA_TYPES: Record<Exclude<FileKind, 'file'>, readonly string[]> = {
  photo: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/flac', 'audio/webm', 'audio/aac'],
  voice: ['audio/ogg', 'audio/webm', 'audio/mp4'],
  video_note: ['video/mp4', 'video/webm'],
  gif: ['video/mp4'],
};

/** File names that are programs or scripts (O-30): refused as files. */
export const BLOCKED_FILE_EXTENSIONS = [
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1',
  'hta', 'jar', 'app', 'dmg', 'pkg', 'apk', 'deb', 'rpm', 'sh', 'reg', 'lnk', 'dll', 'sys', 'msp', 'gadget',
] as const;

export const extensionOf = (name: string): string => {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return match ? match[1]!.toLowerCase() : '';
};

const mimeType = z.string().trim().toLowerCase().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).max(100);
const dimension = z.number().int().min(1).max(20000);

export const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MEDIA_RULES.fileNameMaxLength)
  // Path separators and control characters never reach a download name.
  .refine((name) => !/[\\/]/.test(name) && ![...name].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f), 'invalid file name');

export const uploadRequestBodySchema = z
  .object({
    /** The chat the file will be sent to (the right to send there is checked now and again when sending). */
    chatId: z.string().uuid(),
    kind: z.enum(UPLOAD_KINDS),
    mimeType,
    size: z.number().int().min(1).max(MEDIA_RULES.maxFileBytes),
    fileName: fileNameSchema.optional(),
    width: dimension.optional(),
    height: dimension.optional(),
    durationMs: z.number().int().min(0).max(24 * 3600 * 1000).optional(),
    waveform: z.array(z.number().int().min(0).max(100)).min(1).max(MEDIA_RULES.waveformMaxBars).optional(),
    /** A preview made on the device (photos, videos, video messages). */
    thumbnail: z.object({ mimeType: z.enum(['image/jpeg', 'image/webp']), size: z.number().int().min(1).max(MEDIA_RULES.thumbnailMaxBytes) }).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.size > MEDIA_RULES.maxBytes[body.kind]) {
      ctx.addIssue({ code: 'custom', path: ['size'], message: `at most ${MEDIA_RULES.maxBytes[body.kind]} bytes for ${body.kind}` });
    }
    if (body.kind === 'voice' && (body.durationMs ?? 0) > MEDIA_RULES.voiceMaxDurationMs) {
      ctx.addIssue({ code: 'custom', path: ['durationMs'], message: 'voice messages are at most 15 minutes' });
    }
    if (body.kind === 'video_note' && (body.durationMs ?? 0) > MEDIA_RULES.videoNoteMaxDurationMs) {
      ctx.addIssue({ code: 'custom', path: ['durationMs'], message: 'video messages are at most 60 seconds' });
    }
    if (body.waveform && body.kind !== 'voice') {
      ctx.addIssue({ code: 'custom', path: ['waveform'], message: 'only voice messages have a waveform' });
    }
    if (body.kind === 'file' && body.fileName && (BLOCKED_FILE_EXTENSIONS as readonly string[]).includes(extensionOf(body.fileName))) {
      ctx.addIssue({ code: 'custom', path: ['fileName'], message: 'programs cannot be sent' });
    }
  });
export type UploadRequestBody = z.infer<typeof uploadRequestBodySchema>;

/** Where and how to upload: a one-time signed URL each for the file and its preview. */
export const signedUploadSchema = z.object({
  url: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
});

export const uploadResponseSchema = z.object({
  fileId: z.string(),
  upload: signedUploadSchema,
  thumbnailUpload: signedUploadSchema.nullable(),
  /** Send the message before this; the slot is removed a day after it was made. */
  expiresAt: z.string(),
});
export type UploadResponse = z.infer<typeof uploadResponseSchema>;

/** A file as it appears on a message. Download links come from GET /v1/messages/{id}/file. */
export const attachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(FILE_KINDS),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  fileName: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  waveform: z.array(z.number().int()).nullable(),
  /** A signed preview link (valid an hour), when the sender's device made one. */
  thumbnailUrl: z.string().nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const fileUrlQuerySchema = z.object({
  /** "true": save the file instead of showing it (files that are not media always download). */
  download: z.enum(['true', 'false']).optional(),
});

export const fileUrlResponseSchema = z.object({
  /** Signed link to the file, valid for 5 minutes. Files that are not media always download. */
  url: z.string(),
  expiresInSeconds: z.number().int().positive(),
});
export type FileUrlResponse = z.infer<typeof fileUrlResponseSchema>;

export const stickerSchema = z.object({
  id: z.string(),
  packId: z.string(),
  emoji: z.string(),
  url: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});
export type Sticker = z.infer<typeof stickerSchema>;

export const stickerPackSchema = z.object({ id: z.string(), name: z.string(), stickers: z.array(stickerSchema) });
export type StickerPack = z.infer<typeof stickerPackSchema>;
export const stickerPacksResponseSchema = z.object({ packs: z.array(stickerPackSchema) });

export const reactionSchema = z.object({ emoji: z.string(), count: z.number().int().positive(), mine: z.boolean() });
export type Reaction = z.infer<typeof reactionSchema>;
export const reactionBodySchema = z.object({ emoji: z.enum(REACTION_EMOJIS) });
export type ReactionBody = z.infer<typeof reactionBodySchema>;

export const MEDIA_FILTERS = ['media', 'files', 'voice'] as const;
export type MediaFilter = (typeof MEDIA_FILTERS)[number];
/** Which file kinds each tab of a chat's media panel shows. */
export const MEDIA_FILTER_KINDS: Record<MediaFilter, readonly FileKind[]> = {
  media: ['photo', 'video', 'gif', 'video_note'],
  files: ['file', 'audio'],
  voice: ['voice'],
};
export const chatMediaQuerySchema = z.object({
  kind: z.enum(MEDIA_FILTERS),
  before: z.coerce.number().int().positive().optional(),
});

export const gifSchema = z.object({
  id: z.string(),
  title: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  /** A preview image through the API (signed, valid an hour): GIPHY never sees the person's address. */
  previewUrl: z.string(),
});
export type Gif = z.infer<typeof gifSchema>;
export const gifSearchQuerySchema = z.object({
  q: z.string().trim().max(MEDIA_RULES.gifSearchMaxLength).optional(),
  offset: z.coerce.number().int().min(0).max(4999).optional(),
});
export const gifSearchResponseSchema = z.object({
  /** False until a Super Admin sets the GIPHY key. */
  enabled: z.boolean(),
  gifs: z.array(gifSchema),
  nextOffset: z.number().int().nullable(),
});
export type GifSearchResponse = z.infer<typeof gifSearchResponseSchema>;
export const gifPreviewQuerySchema = z.object({
  u: z.string().min(1).max(1000),
  e: z.coerce.number().int().positive(),
  s: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

// --------------------------------------------------------------------------------------------- Admin

export const adminStickerSchema = stickerSchema.extend({ removed: z.boolean() });
export const adminStickerPackSchema = z.object({
  id: z.string(),
  name: z.string(),
  archived: z.boolean(),
  createdAt: z.string(),
  stickers: z.array(adminStickerSchema),
});
export const adminStickerPacksResponseSchema = z.object({ packs: z.array(adminStickerPackSchema) });
export type AdminStickerPacksResponse = z.infer<typeof adminStickerPacksResponseSchema>;
export const stickerPackNameSchema = z.string().trim().min(1).max(MEDIA_RULES.stickerPackNameMaxLength);
export const createStickerPackBodySchema = z.object({ name: stickerPackNameSchema });
export const updateStickerPackBodySchema = z
  .object({ name: stickerPackNameSchema.optional(), archived: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, 'nothing to update');
export const addStickerBodySchema = z.object({
  emoji: z.string().trim().min(1).max(16),
  /** The image, base64: PNG or WebP, at most 512 KB and 512 x 512. */
  data: z.string().min(8).max(Math.ceil((MEDIA_RULES.stickerMaxBytes * 4) / 3) + 4),
});

/** A sticker image for the Admin Dashboard, whose security policy allows only pictures from the site or data URLs. */
export const adminStickerImageResponseSchema = z.object({ mimeType: z.enum(['image/png', 'image/webp']), data: z.string() });

export const gifSettingsResponseSchema = z.object({
  configured: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type GifSettingsResponse = z.infer<typeof gifSettingsResponseSchema>;
export const gifSettingsBodySchema = z.object({
  /** The GIPHY API key; an empty value turns GIF search off. Never returned. */
  apiKey: z.string().trim().max(200).regex(/^[A-Za-z0-9]*$/, 'letters and digits only'),
});
