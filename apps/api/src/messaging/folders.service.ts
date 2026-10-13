import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { type Folder, MESSAGING_RULES } from '@bedo/contracts';
import type { Database } from '@bedo/db';
import { sql, type Transaction } from 'kysely';
import type { Executor } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { PermissionService } from './permissions.service.js';
import { UpdateLogService } from './update-log.service.js';

/** Chat folders (P-21): up to 10, names of 1 to 12 characters, chats chosen by hand, no automatic rules. */
@Injectable()
export class FoldersService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
  ) {}

  async list(db: Executor, userId: string): Promise<Folder[]> {
    const folders = await db.selectFrom('app.chat_folders').select(['id', 'name']).where('user_id', '=', userId).orderBy('created_at').orderBy('id').execute();
    if (folders.length === 0) {
      return [];
    }
    const items = await db
      .selectFrom('app.chat_folder_chats')
      .select(['folder_id', 'conversation_id'])
      .where(
        'folder_id',
        'in',
        folders.map((folder) => folder.id),
      )
      .execute();
    return folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      chatIds: items.filter((item) => item.folder_id === folder.id).map((item) => item.conversation_id),
    }));
  }

  listMine(userId: string): Promise<Folder[]> {
    return this.list(this.database.db, userId);
  }

  private async lockUserFolders(trx: Transaction<Database>, userId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`folders:${userId}`}, 0))`.execute(trx);
  }

  /** Only chats the user is a member of can go into their folders. */
  private async assertMemberOfAll(trx: Executor, userId: string, chatIds: readonly string[]): Promise<void> {
    const accesses = await this.permissions.chatAccesses(trx, userId, chatIds);
    if (accesses.size !== chatIds.length) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
  }

  private async setChats(trx: Transaction<Database>, folderId: string, chatIds: readonly string[]): Promise<void> {
    await trx.deleteFrom('app.chat_folder_chats').where('folder_id', '=', folderId).execute();
    if (chatIds.length > 0) {
      await trx
        .insertInto('app.chat_folder_chats')
        .values(chatIds.map((chatId) => ({ folder_id: folderId, conversation_id: chatId })))
        .execute();
    }
  }

  async create(userId: string, body: { name: string; chatIds: string[] }): Promise<Folder[]> {
    await this.updateLog.run(async (trx, updates) => {
      await this.lockUserFolders(trx, userId);
      const count = await trx
        .selectFrom('app.chat_folders')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= MESSAGING_RULES.maxFolders) {
        throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
      }
      await this.assertMemberOfAll(trx, userId, body.chatIds);
      const folder = await trx.insertInto('app.chat_folders').values({ user_id: userId, name: body.name }).returning('id').executeTakeFirstOrThrow();
      await this.setChats(trx, folder.id, body.chatIds);
      updates.add({ userId, kind: 'folders' });
    });
    return this.listMine(userId);
  }

  async update(userId: string, folderId: string, body: { name?: string; chatIds?: string[] }): Promise<Folder[]> {
    await this.updateLog.run(async (trx, updates) => {
      await this.lockUserFolders(trx, userId);
      const folder = await trx.selectFrom('app.chat_folders').select('id').where('id', '=', folderId).where('user_id', '=', userId).executeTakeFirst();
      if (!folder) {
        throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      }
      if (body.name !== undefined) {
        await trx.updateTable('app.chat_folders').set({ name: body.name }).where('id', '=', folderId).execute();
      }
      if (body.chatIds !== undefined) {
        await this.assertMemberOfAll(trx, userId, body.chatIds);
        await this.setChats(trx, folderId, body.chatIds);
      }
      updates.add({ userId, kind: 'folders' });
    });
    return this.listMine(userId);
  }

  async remove(userId: string, folderId: string): Promise<Folder[]> {
    await this.updateLog.run(async (trx, updates) => {
      await this.lockUserFolders(trx, userId);
      const removed = await trx.deleteFrom('app.chat_folders').where('id', '=', folderId).where('user_id', '=', userId).executeTakeFirst();
      if (Number(removed.numDeletedRows) === 0) {
        throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
      }
      updates.add({ userId, kind: 'folders' });
    });
    return this.listMine(userId);
  }
}
