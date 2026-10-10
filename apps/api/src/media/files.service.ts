import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  type FileKind,
  type FileUrlResponse,
  MEDIA_FILTER_KINDS,
  MEDIA_RULES,
  MEDIA_TYPES,
  type MediaFilter,
  type Message,
  type UploadRequestBody,
  type UploadResponse,
  extensionOf,
  BLOCKED_FILE_EXTENSIONS,
} from '@bedo/contracts';
import type { Database } from '@bedo/db';
import { sql, type Transaction } from 'kysely';
import type { AuthContext } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { MessagingLimitsService } from '../messaging/messaging-limits.service.js';
import { PermissionService } from '../messaging/permissions.service.js';
import { MESSAGE_COLUMNS, ViewsService } from '../messaging/views.service.js';
import { CHAT_MEDIA_BUCKET, detectFileType, EXECUTABLE_TYPES, MediaStorage } from '../storage/media-storage.js';

/** Bytes read back from every upload to detect its real type. */
const HEAD_BYTES = 64;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
};

/** What a verified upload turned out to be. */
export interface VerifiedFile {
  fileId: string;
  mimeType: string;
  keepThumbnail: boolean;
}

const invalid = () => new AppError(HttpStatus.BAD_REQUEST, 'FILE_INVALID');
const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');

/**
 * The type a file of `kind` is stored as, given the type detected from its bytes; null when the kind does not
 * accept it. WebM and MP4 containers are named by what the kind holds (a voice message in WebM is audio).
 */
export function acceptedType(kind: FileKind, detected: string | null, declared: string): string | null {
  if (detected !== null && EXECUTABLE_TYPES.has(detected)) {
    return null;
  }
  if (kind === 'file') {
    return declared;
  }
  if (detected === null) {
    return null;
  }
  let type = detected;
  if (kind === 'voice' || kind === 'audio') {
    if (detected === 'video/webm') type = 'audio/webm';
    if (detected === 'video/mp4') type = 'audio/mp4';
  }
  return MEDIA_TYPES[kind].includes(type) ? type : null;
}

/**
 * Files in chats (Phase 4, blueprint: Media). Upload slots are given only for a chat the person may send to; the
 * file is verified (real size and type) before the message that carries it exists; downloads are short-lived
 * signed links given only to people who can see a message carrying the file.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
    @Inject(MediaStorage) private readonly storage: MediaStorage,
    @Inject(ViewsService) private readonly views: ViewsService,
  ) {}

  private assertStorage(): void {
    if (!this.storage.enabled) {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'FEATURE_UNAVAILABLE');
    }
  }

  async createUpload(auth: AuthContext, body: UploadRequestBody): Promise<UploadResponse> {
    this.assertStorage();
    if (body.kind === 'file' && body.fileName && (BLOCKED_FILE_EXTENSIONS as readonly string[]).includes(extensionOf(body.fileName))) {
      throw invalid();
    }
    const db = this.database.db;
    const access = await this.permissions.chatAccess(db, auth.userId, body.chatId);
    await this.permissions.assertCanPost(db, auth.userId, access, 'media');
    await this.limits.uploads(auth.userId);

    const name = randomUUID();
    const nameExtension = body.fileName ? extensionOf(body.fileName) : '';
    const extension = body.kind === 'file' ? (/^[a-z0-9]{1,8}$/.test(nameExtension) ? nameExtension : '') : (EXTENSIONS[body.mimeType] ?? '');
    const objectPath = `${body.kind}/${name}${extension ? `.${extension}` : ''}`;
    const thumbnailPath = body.thumbnail ? `thumbs/${name}.${body.thumbnail.mimeType === 'image/webp' ? 'webp' : 'jpg'}` : null;
    // Files that are not media are always served as downloads, so the declared type only names an icon.
    const contentType = body.kind === 'file' ? 'application/octet-stream' : body.mimeType;
    const [upload, thumbnailUpload] = await Promise.all([
      this.storage.createUpload(CHAT_MEDIA_BUCKET, objectPath, contentType),
      thumbnailPath ? this.storage.createUpload(CHAT_MEDIA_BUCKET, thumbnailPath, body.thumbnail!.mimeType) : Promise.resolve(null),
    ]);
    const row = await db
      .insertInto('app.files')
      .values({
        owner_id: auth.userId,
        kind: body.kind,
        mime_type: body.mimeType,
        size_bytes: body.size,
        file_name: body.fileName ?? null,
        object_path: objectPath,
        thumbnail_path: thumbnailPath,
        width: body.width ?? null,
        height: body.height ?? null,
        duration_ms: body.durationMs ?? null,
        waveform: body.waveform ?? null,
      })
      .returning(['id', 'created_at'])
      .executeTakeFirstOrThrow();
    const expiresAt = new Date(new Date(row.created_at).getTime() + MEDIA_RULES.uploadSlotHours * 3600 * 1000).toISOString();
    return {
      fileId: row.id,
      upload: { url: upload.url, method: 'PUT', headers: upload.headers },
      thumbnailUpload: thumbnailUpload ? { url: thumbnailUpload.url, method: 'PUT', headers: thumbnailUpload.headers } : null,
      expiresAt,
    };
  }

  /**
   * Reads the uploaded file back before it is sent: it must exist, have exactly the declared size and be of a type
   * its kind accepts. A file that fails is removed (slot and object) so it cannot be sent later.
   */
  async verify(senderId: string, fileId: string): Promise<VerifiedFile> {
    this.assertStorage();
    const file = await this.database.db
      .selectFrom('app.files')
      .select(['id', 'owner_id', 'kind', 'mime_type', 'size_bytes', 'object_path', 'thumbnail_path', 'status', 'created_at'])
      .where('id', '=', fileId)
      .executeTakeFirst();
    if (!file || file.owner_id !== senderId) {
      throw notFound();
    }
    if (file.status !== 'pending') {
      // Already sent: a file is sent once, then forwarded.
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
    }
    const [stored, thumbnail] = await Promise.all([
      this.storage.head(CHAT_MEDIA_BUCKET, file.object_path, HEAD_BYTES),
      file.thumbnail_path ? this.storage.head(CHAT_MEDIA_BUCKET, file.thumbnail_path, HEAD_BYTES) : Promise.resolve(null),
    ]);
    if (!stored) {
      // Not uploaded (yet): the slot stays, so the upload can finish and the send be retried.
      throw invalid();
    }
    const type = acceptedType(file.kind, detectFileType(stored.head), file.mime_type);
    if (stored.size !== Number(file.size_bytes) || type === null) {
      await this.discard(file.id, [file.object_path, file.thumbnail_path]);
      throw invalid();
    }
    const thumbnailType = thumbnail ? detectFileType(thumbnail.head) : null;
    const keepThumbnail =
      thumbnail !== null && thumbnail.size <= MEDIA_RULES.thumbnailMaxBytes && (thumbnailType === 'image/jpeg' || thumbnailType === 'image/webp');
    return { fileId: file.id, mimeType: type, keepThumbnail };
  }

  /**
   * Phase 6: checks a file for a scheduled message and marks it ready, so it is kept (unused uploads are removed
   * after a day) and cannot be sent elsewhere first; the scheduled message then sends it when due.
   */
  async prepareForSchedule(senderId: string, fileId: string): Promise<string> {
    const verified = await this.verify(senderId, fileId);
    const ready = await this.database.db.transaction().execute((trx) => this.markReady(trx, senderId, verified));
    if (!ready) {
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
    }
    return verified.fileId;
  }

  /** A file prepared for a scheduled message: ready and owned by its sender. */
  async assertPrepared(senderId: string, fileId: string): Promise<string> {
    const file = await this.database.db.selectFrom('app.files').select(['id', 'owner_id', 'status']).where('id', '=', fileId).executeTakeFirst();
    if (!file || file.owner_id !== senderId || file.status !== 'ready') {
      throw notFound();
    }
    return file.id;
  }

  /** Marks a verified file ready in the sending transaction; false if it was used meanwhile. */
  async markReady(trx: Transaction<Database>, senderId: string, verified: VerifiedFile): Promise<boolean> {
    const updated = await trx
      .updateTable('app.files')
      .set({
        status: 'ready',
        ready_at: sql`now()`,
        mime_type: verified.mimeType,
        ...(verified.keepThumbnail ? {} : { thumbnail_path: null }),
      })
      .where('id', '=', verified.fileId)
      .where('owner_id', '=', senderId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  }

  private async discard(fileId: string, paths: Array<string | null>): Promise<void> {
    await this.database.db.deleteFrom('app.files').where('id', '=', fileId).where('status', '=', 'pending').execute();
    try {
      await this.storage.remove(CHAT_MEDIA_BUCKET, paths.filter((path): path is string => path !== null));
    } catch (error) {
      this.logger.warn(`Could not remove a refused upload: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * A signed link to the file of a message the viewer can see (member, not hidden for them, not deleted: D-38
   * keeps deleted files locked). Files that are not media are always downloaded under their own name.
   */
  async fileUrl(viewerId: string, messageId: string, download: boolean): Promise<FileUrlResponse> {
    this.assertStorage();
    await this.limits.fileLinks(viewerId);
    const db = this.database.db;
    const row = await db
      .selectFrom('app.messages as m')
      .innerJoin('app.files as f', 'f.id', 'm.file_id')
      .select(['m.conversation_id', 'm.deleted_at', 'f.kind', 'f.object_path', 'f.file_name', 'f.status'])
      .where('m.id', '=', messageId)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', viewerId))),
      )
      .executeTakeFirst();
    if (!row || row.deleted_at !== null || row.status !== 'ready' || !(await this.permissions.findChatAccess(db, viewerId, row.conversation_id))) {
      throw notFound();
    }
    const asDownload = row.kind === 'file' || download;
    const name = row.file_name ?? row.object_path.split('/').pop()!;
    const [url] = await this.storage.signedUrls(CHAT_MEDIA_BUCKET, [row.object_path], MEDIA_RULES.fileUrlSeconds, asDownload ? name : undefined);
    return { url: url!, expiresInSeconds: MEDIA_RULES.fileUrlSeconds };
  }

  /** The chat's media panel: messages with files of one group of kinds, newest first, in pages. */
  async media(viewerId: string, chatId: string, filter: MediaFilter, before?: number): Promise<Message[]> {
    const db = this.database.db;
    await this.permissions.chatAccess(db, viewerId, chatId);
    let builder = db
      .selectFrom('app.messages as m')
      .innerJoin('app.files as f', 'f.id', 'm.file_id')
      .select(MESSAGE_COLUMNS.map((column) => `m.${column}` as const))
      .where('m.conversation_id', '=', chatId)
      .where('m.file_id', 'is not', null)
      .where('m.deleted_at', 'is', null)
      .where('f.kind', 'in', [...MEDIA_FILTER_KINDS[filter]])
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('app.message_hidden as h').select('h.message_id').whereRef('h.message_id', '=', 'm.id').where('h.user_id', '=', viewerId))),
      );
    if (before !== undefined) {
      builder = builder.where('m.seq', '<', String(before));
    }
    const rows = await builder.orderBy('m.seq', 'desc').limit(MEDIA_RULES.mediaPageSize).execute();
    return this.views.messages(db, viewerId, rows);
  }
}
