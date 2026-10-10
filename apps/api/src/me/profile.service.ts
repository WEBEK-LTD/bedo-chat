import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type Me,
  type PhotoUploadResponse,
  type Privacy,
  type UpdateMeBody,
} from '@bedo/contracts';
import type { IdentityField } from '@bedo/db';
import { AppError } from '../common/app-error.js';
import { hashToken, randomToken } from '../common/crypto.js';
import type { RequestInfo } from '../common/request-info.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountsService } from '../auth/accounts.service.js';
import { DatabaseService } from '../database/database.service.js';
import { EphemeralStore } from '../state/ephemeral.store.js';
import { detectImageType, ProfilePhotoStorage } from '../storage/profile-photo-storage.js';
import { PROFILE_RULES } from '@bedo/contracts';

const UPLOAD_TTL_SECONDS = 15 * 60;
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

interface PendingUpload {
  userId: string;
  key: string;
  contentType: keyof typeof EXTENSIONS;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505' &&
    (error as { constraint?: string }).constraint === constraint
  );
}

@Injectable()
export class ProfileService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EphemeralStore) private readonly store: EphemeralStore,
    @Inject(ProfilePhotoStorage) private readonly storage: ProfilePhotoStorage,
  ) {}

  async me(userId: string): Promise<Me> {
    const user = await this.accounts.findById(this.database.db, userId);
    if (!user) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED');
    }
    return this.accounts.toMe(user);
  }

  /** Name, username and bio. Each changed field is written to identity history (D-17). */
  async update(userId: string, body: UpdateMeBody): Promise<Me> {
    const changes: Partial<Record<'name' | 'username' | 'bio', string | null>> = {};
    if (body.name !== undefined) changes.name = body.name;
    if (body.username !== undefined) changes.username = body.username;
    if (body.bio !== undefined) changes.bio = body.bio && body.bio.length > 0 ? body.bio : null;

    try {
      await this.database.db.transaction().execute(async (trx) => {
        const current = await trx.selectFrom('app.users').selectAll().where('id', '=', userId).forUpdate().executeTakeFirstOrThrow();
        await trx.updateTable('app.users').set(changes).where('id', '=', userId).execute();
        for (const [field, value] of Object.entries(changes) as Array<[IdentityField, string | null]>) {
          await this.audit.identity(trx, {
            userId,
            field,
            oldValue: current[field as 'name' | 'username' | 'bio'],
            newValue: value,
            actor: { type: 'user', id: userId },
          });
        }
      });
    } catch (error) {
      if (isUniqueViolation(error, 'users_username_key')) {
        throw new AppError(HttpStatus.CONFLICT, 'USERNAME_TAKEN');
      }
      throw error;
    }
    return this.me(userId);
  }

  async privacy(userId: string): Promise<Privacy> {
    const row = await this.database.db
      .selectFrom('app.user_privacy')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return {
      phoneVisibility: row.phone_visibility,
      lastSeenVisibility: row.last_seen_visibility,
      photoVisibility: row.photo_visibility,
      messagesFrom: row.messages_from,
    };
  }

  async updatePrivacy(userId: string, body: Partial<Privacy>, info: RequestInfo): Promise<Privacy> {
    const before = await this.privacy(userId);
    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('app.user_privacy')
        .set({
          ...(body.phoneVisibility ? { phone_visibility: body.phoneVisibility } : {}),
          ...(body.lastSeenVisibility ? { last_seen_visibility: body.lastSeenVisibility } : {}),
          ...(body.photoVisibility ? { photo_visibility: body.photoVisibility } : {}),
          ...(body.messagesFrom ? { messages_from: body.messagesFrom } : {}),
        })
        .where('user_id', '=', userId)
        .execute();
      await this.audit.security(trx, {
        subjectType: 'user',
        subjectId: userId,
        event: 'privacy_changed',
        ip: info.ip,
        userAgent: info.userAgent,
        details: { before, after: { ...before, ...body } },
      });
    });
    return this.privacy(userId);
  }

  /** Step 1 of a profile-picture change: a one-time signed upload URL (P-07, P-15). */
  async startPhotoUpload(userId: string, contentType: keyof typeof EXTENSIONS): Promise<PhotoUploadResponse> {
    if (!this.storage.enabled) {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
    }
    const key = `${userId}/${randomUUID()}.${EXTENSIONS[contentType]}`;
    const upload = await this.storage.createUpload(key, contentType);
    const uploadId = randomToken();
    const pending: PendingUpload = { userId, key, contentType };
    await this.store.set(this.uploadKey(uploadId), JSON.stringify(pending), UPLOAD_TTL_SECONDS * 1000);
    return { uploadId, uploadUrl: upload.url, method: 'PUT', headers: upload.headers };
  }

  /** Step 2: checks the uploaded file's real size and type before it becomes the profile picture. */
  async confirmPhoto(userId: string, uploadId: string): Promise<Me> {
    if (!this.storage.enabled) {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
    }
    const raw = await this.store.take(this.uploadKey(uploadId));
    const pending = raw ? (JSON.parse(raw) as PendingUpload) : null;
    if (!pending || pending.userId !== userId) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    const stored = await this.storage.read(pending.key);
    if (!stored) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    const type = detectImageType(stored.head);
    if (stored.size > PROFILE_RULES.photoMaxBytes || !type) {
      await this.storage.remove(pending.key);
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
    }
    await this.setPhoto(userId, pending.key);
    return this.me(userId);
  }

  /** Removing the picture keeps the stored file: past pictures stay in identity history (P-07). */
  async removePhoto(userId: string): Promise<Me> {
    await this.setPhoto(userId, null);
    return this.me(userId);
  }

  private async setPhoto(userId: string, key: string | null): Promise<void> {
    await this.database.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom('app.users').select('photo_key').where('id', '=', userId).forUpdate().executeTakeFirstOrThrow();
      await trx.updateTable('app.users').set({ photo_key: key }).where('id', '=', userId).execute();
      await this.audit.identity(trx, {
        userId,
        field: 'photo',
        oldValue: current.photo_key,
        newValue: key,
        actor: { type: 'user', id: userId },
      });
    });
  }

  private uploadKey(uploadId: string): string {
    // Only a hash of the ticket is stored, like every other token.
    return `photo-upload:${hashToken(uploadId)}`;
  }
}
