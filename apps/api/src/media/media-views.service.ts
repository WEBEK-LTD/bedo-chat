import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Attachment, MEDIA_RULES, type Reaction, REACTION_EMOJIS, type Sticker } from '@bedo/contracts';
import type { Executor } from '../audit/audit.service.js';
import { CHAT_MEDIA_BUCKET, MediaStorage, STICKERS_BUCKET } from '../storage/media-storage.js';

/** Preview links are signed for an hour and reused for 50 minutes. */
const THUMB_CACHE_MS = 50 * 60 * 1000;
const THUMB_CACHE_MAX = 10_000;
const REACTION_ORDER = new Map<string, number>(REACTION_EMOJIS.map((emoji, index) => [emoji, index]));

/**
 * The media parts of message views (Phase 4): attachments with signed preview links, stickers and reaction
 * counts. Callers pass only messages the viewer may see; nothing here checks membership.
 */
@Injectable()
export class MediaViewsService {
  private readonly logger = new Logger(MediaViewsService.name);
  private readonly thumbCache = new Map<string, { url: string; expires: number }>();

  constructor(@Inject(MediaStorage) private readonly storage: MediaStorage) {}

  /** Signed preview links by thumbnail path (missing when storage is unavailable: the app shows an icon). */
  private async thumbnails(paths: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const now = Date.now();
    const missing: string[] = [];
    for (const path of new Set(paths)) {
      const cached = this.thumbCache.get(path);
      if (cached && cached.expires > now) {
        result.set(path, cached.url);
      } else {
        missing.push(path);
      }
    }
    if (missing.length > 0 && this.storage.enabled) {
      try {
        const urls = await this.storage.signedUrls(CHAT_MEDIA_BUCKET, missing, MEDIA_RULES.thumbnailUrlSeconds);
        if (this.thumbCache.size + missing.length > THUMB_CACHE_MAX) {
          this.thumbCache.clear();
        }
        missing.forEach((path, index) => {
          result.set(path, urls[index]!);
          this.thumbCache.set(path, { url: urls[index]!, expires: now + THUMB_CACHE_MS });
        });
      } catch (error) {
        this.logger.warn(`Preview links unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  async attachments(db: Executor, fileIds: readonly string[]): Promise<Map<string, Attachment>> {
    const ids = [...new Set(fileIds)];
    const result = new Map<string, Attachment>();
    if (ids.length === 0) {
      return result;
    }
    const rows = await db
      .selectFrom('app.files')
      .select(['id', 'kind', 'mime_type', 'size_bytes', 'file_name', 'thumbnail_path', 'width', 'height', 'duration_ms', 'waveform'])
      .where('id', 'in', ids)
      .where('status', '=', 'ready')
      .execute();
    const thumbs = await this.thumbnails(rows.map((row) => row.thumbnail_path).filter((path): path is string => path !== null));
    for (const row of rows) {
      result.set(row.id, {
        id: row.id,
        kind: row.kind,
        mimeType: row.mime_type,
        size: Number(row.size_bytes),
        fileName: row.file_name,
        width: row.width,
        height: row.height,
        durationMs: row.duration_ms,
        waveform: row.waveform,
        thumbnailUrl: row.thumbnail_path ? (thumbs.get(row.thumbnail_path) ?? null) : null,
      });
    }
    return result;
  }

  stickerUrl(objectPath: string): string {
    return this.storage.publicUrl(STICKERS_BUCKET, objectPath);
  }

  async stickers(db: Executor, stickerIds: readonly string[]): Promise<Map<string, Sticker>> {
    const ids = [...new Set(stickerIds)];
    const result = new Map<string, Sticker>();
    if (ids.length === 0) {
      return result;
    }
    const rows = await db.selectFrom('app.stickers').select(['id', 'pack_id', 'emoji', 'object_path', 'width', 'height']).where('id', 'in', ids).execute();
    for (const row of rows) {
      result.set(row.id, { id: row.id, packId: row.pack_id, emoji: row.emoji, url: this.stickerUrl(row.object_path), width: row.width, height: row.height });
    }
    return result;
  }

  /** Reaction counts per message, in the order of the reaction set, with the viewer's own marked. */
  async reactions(db: Executor, viewerId: string, messageIds: readonly string[]): Promise<Map<string, Reaction[]>> {
    const ids = [...new Set(messageIds)];
    const result = new Map<string, Reaction[]>();
    if (ids.length === 0) {
      return result;
    }
    const rows = await db.selectFrom('app.message_reactions').select(['message_id', 'user_id', 'emoji']).where('message_id', 'in', ids).execute();
    const byMessage = new Map<string, Map<string, Reaction>>();
    for (const row of rows) {
      const counts = byMessage.get(row.message_id) ?? new Map<string, Reaction>();
      const entry = counts.get(row.emoji) ?? { emoji: row.emoji, count: 0, mine: false };
      entry.count += 1;
      entry.mine ||= row.user_id === viewerId;
      counts.set(row.emoji, entry);
      byMessage.set(row.message_id, counts);
    }
    for (const [messageId, counts] of byMessage) {
      result.set(
        messageId,
        [...counts.values()].sort((a, b) => (REACTION_ORDER.get(a.emoji) ?? 99) - (REACTION_ORDER.get(b.emoji) ?? 99)),
      );
    }
    return result;
  }
}
