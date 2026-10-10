import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { UserPermissions } from '@bedo/contracts';
import { AuditService, type Executor } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';

/**
 * System permissions per user (O-21): create groups (on by default), create channels and schedule messages (off by
 * default). Admins change them from the Admin Dashboard; every change is in the admin history.
 */
@Injectable()
export class UserPermissionsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async forUser(db: Executor, userId: string): Promise<UserPermissions> {
    const row = await db.selectFrom('app.user_permissions').selectAll().where('user_id', '=', userId).executeTakeFirst();
    return { createGroups: row?.create_groups ?? true, createChannels: row?.create_channels ?? false, scheduleMessages: row?.schedule_messages ?? false };
  }

  // ---------------------------------------------------------------------- system permissions (O-21)

  async adminFind(phone: string) {
    const user = await this.db.selectFrom('app.users').select(['id', 'phone', 'name', 'status']).where('phone', '=', phone).executeTakeFirst();
    if (!user || !user.phone) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return { user: { id: user.id, phone: user.phone, name: user.name, status: user.status }, permissions: await this.forUser(this.db, user.id) };
  }

  async adminSet(adminId: string, phone: string, permissions: UserPermissions, info: { ip: string | null; userAgent: string | null }) {
    const found = await this.adminFind(phone);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('app.user_permissions')
        .values({ user_id: found.user.id, create_groups: permissions.createGroups, create_channels: permissions.createChannels, schedule_messages: permissions.scheduleMessages, updated_by: adminId })
        .onConflict((conflict) =>
          conflict.column('user_id').doUpdateSet({
            create_groups: permissions.createGroups,
            create_channels: permissions.createChannels,
            schedule_messages: permissions.scheduleMessages,
            updated_by: adminId,
            updated_at: new Date(),
          }),
        )
        .execute();
      await this.audit.admin(trx, {
        adminId,
        action: 'users.permissions_changed',
        targetType: 'user',
        targetId: found.user.id,
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { before: found.permissions, after: permissions },
      });
    });
    return this.adminFind(phone);
  }
}
