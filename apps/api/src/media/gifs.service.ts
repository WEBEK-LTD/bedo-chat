import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { API_BASE_PATH, type GifSearchResponse, type GifSettingsResponse, MEDIA_RULES } from '@bedo/contracts';
import { decryptAtRest, encryptAtRest, parseAes256Key } from '@bedo/server-crypto';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import type { RequestInfo } from '../common/request-info.js';
import { API_ENV } from '../config/tokens.js';
import { DatabaseService } from '../database/database.service.js';
import { CHAT_MEDIA_BUCKET, detectFileType, MediaStorage } from '../storage/media-storage.js';
import { GifProvider, GifProviderError } from './gif-provider.js';

/** Purpose label for the GIPHY key in app.gif_settings (bound into the ciphertext). */
export const GIPHY_KEY_PURPOSE = 'bedo:app.gif_settings:giphy_key:v1';
const PREVIEW_SECONDS = 3600;

class GifRace extends Error {}

/**
 * GIFs (O-09): search through GIPHY with the academy's key (set by a Super Admin, stored encrypted like the Waabek
 * key), previews through the API (signed links, so the API is not an open proxy and GIPHY never sees students'
 * addresses), and sending: the GIF's MP4 is copied into the private chat storage once and then referenced by every
 * message that sends it, so a message never depends on GIPHY later.
 */
@Injectable()
export class GifsService {
  private readonly logger = new Logger(GifsService.name);
  private readonly settingsKey: Buffer;
  private readonly previewKey: Buffer;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MediaStorage) private readonly storage: MediaStorage,
    @Inject(GifProvider) private readonly provider: GifProvider,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.settingsKey = parseAes256Key(env.SETTINGS_ENCRYPTION_KEY);
    this.previewKey = createHmac('sha256', env.ACCESS_TOKEN_SECRET).update('bedo gif previews v1').digest();
  }

  private async apiKey(): Promise<string | null> {
    const row = await this.database.db.selectFrom('app.gif_settings').select('giphy_key_enc').executeTakeFirst();
    if (!row?.giphy_key_enc) {
      return null;
    }
    try {
      return decryptAtRest(this.settingsKey, row.giphy_key_enc, GIPHY_KEY_PURPOSE).toString('utf8');
    } catch {
      this.logger.error('The stored GIPHY key cannot be decrypted (was SETTINGS_ENCRYPTION_KEY changed?)');
      return null;
    }
  }

  async settings(): Promise<GifSettingsResponse> {
    const row = await this.database.db
      .selectFrom('app.gif_settings as g')
      .leftJoin('app.admin_accounts as a', 'a.id', 'g.updated_by')
      .select(['g.giphy_key_enc', 'g.updated_at', 'g.updated_by', 'a.name as updated_by_name'])
      .executeTakeFirstOrThrow();
    return {
      configured: row.giphy_key_enc !== null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row.updated_by && row.updated_by_name ? { id: row.updated_by, name: row.updated_by_name } : null,
    };
  }

  /** Sets (or with an empty value, removes) the GIPHY key. The key is never returned, logged or audited. */
  async setKey(adminId: string, apiKey: string, info: RequestInfo): Promise<GifSettingsResponse> {
    if (apiKey) {
      // Phase 14.2: the key is tried with GIPHY before it is saved, so a wrong key is reported at once.
      try {
        await this.provider.search(apiKey, null, 0, 1);
      } catch (error) {
        const status = error instanceof GifProviderError ? error.status : null;
        if (status === 401 || status === 403) {
          throw new AppError(HttpStatus.BAD_REQUEST, 'GIPHY_KEY_INVALID');
        }
        // A rate limit means GIPHY knows the key; anything else (GIPHY unreachable) saves nothing.
        if (status !== 429) {
          this.logger.warn(`GIPHY key check failed: ${error instanceof Error ? error.message : String(error)}`);
          throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
        }
      }
    }
    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('app.gif_settings')
        .set({
          giphy_key_enc: apiKey ? encryptAtRest(this.settingsKey, Buffer.from(apiKey, 'utf8'), GIPHY_KEY_PURPOSE) : null,
          updated_by: adminId,
          updated_at: new Date(),
        })
        .execute();
      await this.audit.admin(trx, {
        adminId,
        action: apiKey ? 'gif_settings.giphy_key_set' : 'gif_settings.giphy_key_removed',
        targetType: 'gif_settings',
        ip: info.ip,
        userAgent: info.userAgent,
      });
    });
    return this.settings();
  }

  private sign(url: string, expires: number): string {
    return createHmac('sha256', this.previewKey).update(`${expires}\n${url}`).digest('base64url');
  }

  previewPath(url: string, now = Date.now()): string {
    const expires = Math.floor(now / 1000) + PREVIEW_SECONDS;
    return `${API_BASE_PATH}/v1/gifs/preview?u=${encodeURIComponent(url)}&e=${expires}&s=${this.sign(url, expires)}`;
  }

  async search(query: string | undefined, offset = 0): Promise<GifSearchResponse> {
    const key = await this.apiKey();
    if (!key) {
      return { enabled: false, gifs: [], nextOffset: null };
    }
    let result: Awaited<ReturnType<GifProvider['search']>>;
    try {
      result = await this.provider.search(key, query?.trim() || null, offset, MEDIA_RULES.gifPageSize);
    } catch (error) {
      this.logger.warn(`GIF search failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
    }
    const next = offset + MEDIA_RULES.gifPageSize;
    return {
      enabled: true,
      gifs: result.items.map((item) => ({ id: item.id, title: item.title, width: item.width, height: item.height, previewUrl: this.previewPath(item.previewUrl) })),
      nextOffset: result.items.length > 0 && next < Math.min(result.total, 5000) ? next : null,
    };
  }

  /** A preview image for a signed, unexpired link to a GIPHY media address. */
  async preview(url: string, expires: number, signature: string): Promise<{ body: Buffer; contentType: string }> {
    const expected = Buffer.from(this.sign(url, expires));
    const given = Buffer.from(signature);
    if (expires * 1000 < Date.now() || expected.length !== given.length || !timingSafeEqual(expected, given) || !this.provider.isMediaUrl(url)) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    let media: { body: Buffer; contentType: string };
    try {
      media = await this.provider.download(url, MEDIA_RULES.gifPreviewMaxBytes);
    } catch {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
    }
    const type = detectFileType(media.body);
    if (type !== 'image/gif' && type !== 'image/webp' && type !== 'image/jpeg' && type !== 'image/png') {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    return { body: media.body, contentType: type };
  }

  /**
   * The file that carries GIPHY GIF `gifId`: copied into chat storage the first time it is sent (as `senderId`),
   * reused afterwards.
   */
  async fileFor(senderId: string, gifId: string): Promise<string> {
    const existing = await this.database.db.selectFrom('app.gif_files').select('file_id').where('giphy_id', '=', gifId).executeTakeFirst();
    if (existing) {
      return existing.file_id;
    }
    if (!this.storage.enabled) {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'FEATURE_UNAVAILABLE');
    }
    const key = await this.apiKey();
    if (!key) {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'FEATURE_UNAVAILABLE');
    }
    let body: Buffer;
    let item: Awaited<ReturnType<GifProvider['get']>>;
    try {
      item = await this.provider.get(key, gifId);
      if (!item) {
        throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      }
      body = (await this.provider.download(item.mp4Url, MEDIA_RULES.maxBytes.gif)).body;
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.logger.warn(`GIF could not be fetched: ${error instanceof GifProviderError ? error.message : String(error)}`);
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
    }
    if (detectFileType(body) !== 'video/mp4' || body.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_INVALID');
    }
    const objectPath = `gif/${randomUUID()}.mp4`;
    await this.storage.put(CHAT_MEDIA_BUCKET, objectPath, body, 'video/mp4');
    try {
      return await this.database.db.transaction().execute(async (trx) => {
        const file = await trx
          .insertInto('app.files')
          .values({
            owner_id: senderId,
            kind: 'gif',
            mime_type: 'video/mp4',
            size_bytes: body.length,
            file_name: null,
            object_path: objectPath,
            thumbnail_path: null,
            width: item.width,
            height: item.height,
            status: 'ready',
            ready_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const claimed = await trx
          .insertInto('app.gif_files')
          .values({ giphy_id: gifId, file_id: file.id })
          .onConflict((conflict) => conflict.column('giphy_id').doNothing())
          .returning('file_id')
          .executeTakeFirst();
        if (!claimed) {
          throw new GifRace();
        }
        return file.id;
      });
    } catch (error) {
      if (!(error instanceof GifRace)) throw error;
      // Someone sent the same GIF at the same moment: use theirs and drop this copy.
      await this.storage.remove(CHAT_MEDIA_BUCKET, [objectPath]).catch(() => undefined);
      const winner = await this.database.db.selectFrom('app.gif_files').select('file_id').where('giphy_id', '=', gifId).executeTakeFirstOrThrow();
      return winner.file_id;
    }
  }
}
