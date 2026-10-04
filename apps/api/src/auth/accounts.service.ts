import { Inject, Injectable, Logger } from '@nestjs/common';
import { DELETED_ACCOUNT_NAME, type Me, type PublicUser } from '@bedo/contracts';
import type { UsersTable } from '@bedo/db';
import type { Selectable } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { ProfilePhotoStorage } from '../storage/profile-photo-storage.js';
import type { Executor } from '../audit/audit.service.js';

export type UserRow = Selectable<UsersTable>;

const PHOTO_URL_SECONDS = 60 * 60;

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProfilePhotoStorage) private readonly storage: ProfilePhotoStorage,
  ) {}

  get db() {
    return this.database.db;
  }

  async findByPhone(db: Executor, phone: string): Promise<UserRow | undefined> {
    return db.selectFrom('app.users').selectAll().where('phone', '=', phone).executeTakeFirst();
  }

  async findById(db: Executor, id: string): Promise<UserRow | undefined> {
    return db.selectFrom('app.users').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async isOnAcademyList(db: Executor, phone: string): Promise<boolean> {
    const row = await db.selectFrom('app.academy_phone_list').select('phone').where('phone', '=', phone).executeTakeFirst();
    return Boolean(row);
  }

  async hasTwoStep(db: Executor, userId: string): Promise<boolean> {
    const row = await db.selectFrom('app.two_step').select('user_id').where('user_id', '=', userId).executeTakeFirst();
    return Boolean(row);
  }

  async photoUrl(key: string | null): Promise<string | null> {
    if (!key || !this.storage.enabled) {
      return null;
    }
    try {
      return await this.storage.signedUrl(key, PHOTO_URL_SECONDS);
    } catch (error) {
      this.logger.warn(`Could not sign profile photo URL: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * The only way another user's identity leaves the API (D-14). Deleted accounts show as
   * "Deleted account" with nothing else. Privacy rules (P-08) are applied here as each feature arrives.
   */
  async toPublicUser(user: Pick<UserRow, 'id' | 'status' | 'name' | 'username' | 'bio' | 'photo_key'>): Promise<PublicUser> {
    if (user.status === 'deleted') {
      return { id: user.id, deleted: true, displayName: DELETED_ACCOUNT_NAME, username: null, bio: null, photoUrl: null };
    }
    return {
      id: user.id,
      deleted: false,
      displayName: user.name ?? '',
      username: user.username,
      bio: user.bio,
      photoUrl: await this.photoUrl(user.photo_key),
    };
  }

  async toMe(user: UserRow): Promise<Me> {
    return {
      id: user.id,
      phone: user.phone ?? '',
      name: user.name,
      username: user.username,
      bio: user.bio,
      photoUrl: await this.photoUrl(user.photo_key),
      status: user.status,
      twoStepEnabled: await this.hasTwoStep(this.db, user.id),
      profileComplete: user.name !== null,
    };
  }
}
