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

  /**
   * Whether a number may get an account (sign-in of a new number, or a new number for an account). D-47: anyone
   * with a WhatsApp number (the default), or, when a Super Admin chooses so, only numbers on the academy phone list
   * (D-06). Either way never the number of an account deleted by an admin (D-14, D-24): its deletion is in the
   * identity history as the number cleared.
   */
  async mayUseNumber(db: Executor, phone: string): Promise<boolean> {
    const settings = await db.selectFrom('app.access_settings').select('signup_mode').executeTakeFirst();
    if ((settings?.signup_mode ?? 'academy_list') === 'academy_list') {
      const row = await db.selectFrom('app.academy_phone_list').select('phone').where('phone', '=', phone).executeTakeFirst();
      return Boolean(row);
    }
    const deleted = await db
      .selectFrom('audit.identity_history as h')
      .innerJoin('app.users as u', 'u.id', 'h.user_id')
      .select('h.user_id')
      .where('h.field', '=', 'phone')
      .where('h.old_value', '=', phone)
      .where('h.new_value', 'is', null)
      .where('u.status', '=', 'deleted')
      .executeTakeFirst();
    return !deleted;
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
  /**
   * `photoVisible: false` (Phase 3) leaves the picture out where the user's photo privacy or a block hides
   * it from the viewer; the caller decides this through the messaging permission service.
   */
  async toPublicUser(
    user: Pick<UserRow, 'id' | 'status' | 'name' | 'username' | 'bio' | 'photo_key'>,
    options: { photoVisible?: boolean } = {},
  ): Promise<PublicUser> {
    if (user.status === 'deleted') {
      return { id: user.id, deleted: true, displayName: DELETED_ACCOUNT_NAME, username: null, bio: null, photoUrl: null };
    }
    return {
      id: user.id,
      deleted: false,
      displayName: user.name ?? '',
      username: user.username,
      bio: user.bio,
      photoUrl: options.photoVisible === false ? null : await this.photoUrl(user.photo_key),
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
