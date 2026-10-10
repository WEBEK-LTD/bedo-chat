import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { type AdminStickerPacksResponse, MEDIA_RULES, type StickerPack } from '@bedo/contracts';
import type { Database } from '@bedo/db';
import { sql, type Transaction } from 'kysely';
import { AuditService, type Executor } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import type { RequestInfo } from '../common/request-info.js';
import { DatabaseService } from '../database/database.service.js';
import { imageSize, MediaStorage, STICKERS_BUCKET } from '../storage/media-storage.js';
import { MediaViewsService } from './media-views.service.js';

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');

/**
 * Sticker packs (O-10): Super Admins upload PNG or WebP images (at most 512 KB and 512 x 512) into the public
 * "stickers" bucket; students pick from the packs that are not archived. A sticker is never deleted, only taken out
 * of its pack, so messages that carry it keep showing it.
 */
@Injectable()
export class StickersService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MediaStorage) private readonly storage: MediaStorage,
    @Inject(MediaViewsService) private readonly views: MediaViewsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** The packs students can pick from. */
  async available(): Promise<StickerPack[]> {
    const db = this.database.db;
    const packs = await db.selectFrom('app.sticker_packs').select(['id', 'name']).where('archived_at', 'is', null).orderBy('created_at').execute();
    if (packs.length === 0) {
      return [];
    }
    const stickers = await db
      .selectFrom('app.stickers')
      .select(['id', 'pack_id', 'emoji', 'object_path', 'width', 'height'])
      .where('pack_id', 'in', packs.map((pack) => pack.id))
      .where('removed_at', 'is', null)
      .orderBy('position')
      .orderBy('created_at')
      .execute();
    return packs
      .map((pack) => ({
        id: pack.id,
        name: pack.name,
        stickers: stickers
          .filter((sticker) => sticker.pack_id === pack.id)
          .map((sticker) => ({ id: sticker.id, packId: sticker.pack_id, emoji: sticker.emoji, url: this.views.stickerUrl(sticker.object_path), width: sticker.width, height: sticker.height })),
      }))
      .filter((pack) => pack.stickers.length > 0);
  }

  /** Refuses a sticker that does not exist, was taken out of its pack, or whose pack is archived. */
  async assertSendable(db: Executor, stickerId: string): Promise<void> {
    const row = await db
      .selectFrom('app.stickers as s')
      .innerJoin('app.sticker_packs as p', 'p.id', 's.pack_id')
      .select('s.id')
      .where('s.id', '=', stickerId)
      .where('s.removed_at', 'is', null)
      .where('p.archived_at', 'is', null)
      .executeTakeFirst();
    if (!row) {
      throw notFound();
    }
  }

  // ------------------------------------------------------------------------------------------ Admin

  async adminList(): Promise<AdminStickerPacksResponse> {
    const db = this.database.db;
    const packs = await db.selectFrom('app.sticker_packs').select(['id', 'name', 'archived_at', 'created_at']).orderBy('created_at').execute();
    const stickers =
      packs.length === 0
        ? []
        : await db
            .selectFrom('app.stickers')
            .select(['id', 'pack_id', 'emoji', 'object_path', 'width', 'height', 'removed_at'])
            .where('pack_id', 'in', packs.map((pack) => pack.id))
            .orderBy('position')
            .orderBy('created_at')
            .execute();
    return {
      packs: packs.map((pack) => ({
        id: pack.id,
        name: pack.name,
        archived: pack.archived_at !== null,
        createdAt: new Date(pack.created_at).toISOString(),
        stickers: stickers
          .filter((sticker) => sticker.pack_id === pack.id)
          .map((sticker) => ({
            id: sticker.id,
            packId: sticker.pack_id,
            emoji: sticker.emoji,
            url: this.views.stickerUrl(sticker.object_path),
            width: sticker.width,
            height: sticker.height,
            removed: sticker.removed_at !== null,
          })),
      })),
    };
  }

  async createPack(adminId: string, name: string, info: RequestInfo): Promise<AdminStickerPacksResponse> {
    await this.database.db.transaction().execute(async (trx) => {
      const pack = await trx.insertInto('app.sticker_packs').values({ name, created_by: adminId }).returning('id').executeTakeFirstOrThrow();
      await this.audit.admin(trx, { adminId, action: 'stickers.pack_created', targetType: 'sticker_pack', targetId: pack.id, ip: info.ip, userAgent: info.userAgent, metadata: { name } });
    });
    return this.adminList();
  }

  async updatePack(adminId: string, packId: string, change: { name?: string; archived?: boolean }, info: RequestInfo): Promise<AdminStickerPacksResponse> {
    await this.database.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('app.sticker_packs')
        .set({
          ...(change.name !== undefined ? { name: change.name } : {}),
          ...(change.archived !== undefined ? { archived_at: change.archived ? sql<Date>`coalesce(archived_at, now())` : null } : {}),
        })
        .where('id', '=', packId)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) {
        throw notFound();
      }
      await this.audit.admin(trx, { adminId, action: 'stickers.pack_updated', targetType: 'sticker_pack', targetId: packId, ip: info.ip, userAgent: info.userAgent, metadata: change });
    });
    return this.adminList();
  }

  async addSticker(adminId: string, packId: string, emoji: string, base64: string, info: RequestInfo): Promise<AdminStickerPacksResponse> {
    if (!this.storage.enabled) {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'FEATURE_UNAVAILABLE');
    }
    const data = Buffer.from(base64, 'base64');
    const size = imageSize(data);
    if (
      data.length === 0 ||
      data.length > MEDIA_RULES.stickerMaxBytes ||
      !size ||
      size.width > MEDIA_RULES.stickerMaxSide ||
      size.height > MEDIA_RULES.stickerMaxSide ||
      size.width < 1 ||
      size.height < 1
    ) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_INVALID');
    }
    const db = this.database.db;
    const pack = await db.selectFrom('app.sticker_packs').select('id').where('id', '=', packId).executeTakeFirst();
    if (!pack) {
      throw notFound();
    }
    const count = await db.selectFrom('app.stickers').select(sql<number>`count(*)::int`.as('n')).where('pack_id', '=', packId).where('removed_at', 'is', null).executeTakeFirstOrThrow();
    if (count.n >= MEDIA_RULES.maxStickersPerPack) {
      throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
    }
    const objectPath = `${packId}/${randomUUID()}.${size.type === 'image/png' ? 'png' : 'webp'}`;
    await this.storage.put(STICKERS_BUCKET, objectPath, data, size.type);
    await db.transaction().execute(async (trx: Transaction<Database>) => {
      const sticker = await trx
        .insertInto('app.stickers')
        .values({
          pack_id: packId,
          emoji,
          object_path: objectPath,
          mime_type: size.type,
          width: size.width,
          height: size.height,
          position: sql<number>`(select coalesce(max(position), 0) + 1 from app.stickers where pack_id = ${packId})`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.admin(trx, { adminId, action: 'stickers.sticker_added', targetType: 'sticker', targetId: sticker.id, ip: info.ip, userAgent: info.userAgent, metadata: { packId, emoji } });
    });
    return this.adminList();
  }

  /** The image of a sticker, for the Admin Dashboard (base64). */
  async adminImage(stickerId: string): Promise<{ mimeType: 'image/png' | 'image/webp'; data: string }> {
    const row = await this.database.db.selectFrom('app.stickers').select(['object_path', 'mime_type']).where('id', '=', stickerId).executeTakeFirst();
    if (!row) {
      throw notFound();
    }
    const object = await this.storage.head(STICKERS_BUCKET, row.object_path, MEDIA_RULES.stickerMaxBytes);
    if (!object) {
      throw notFound();
    }
    return { mimeType: row.mime_type, data: object.head.toString('base64') };
  }

  async removeSticker(adminId: string, stickerId: string, info: RequestInfo): Promise<AdminStickerPacksResponse> {
    await this.database.db.transaction().execute(async (trx) => {
      const updated = await trx.updateTable('app.stickers').set({ removed_at: sql<Date>`now()` }).where('id', '=', stickerId).where('removed_at', 'is', null).executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) {
        throw notFound();
      }
      await this.audit.admin(trx, { adminId, action: 'stickers.sticker_removed', targetType: 'sticker', targetId: stickerId, ip: info.ip, userAgent: info.userAgent });
    });
    return this.adminList();
  }
}
