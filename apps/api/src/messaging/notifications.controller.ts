import { Body, Controller, Get, HttpCode, Inject, Patch, Post, UseGuards } from '@nestjs/common';
import { badgeResponseSchema, notificationSettingsSchema, okResponseSchema, updateNotificationSettingsBodySchema, viewingBodySchema } from '@bedo/contracts';
import type { z } from 'zod';
import { type AuthContext, CurrentAuth, UserAuthGuard } from '../auth/user-auth.guard.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DatabaseService } from '../database/database.service.js';
import { NotificationsService } from './notifications.service.js';

/** Phase 7: the signed-in user's notification settings and badge (D-41). */
@Controller('v1/me')
@UseGuards(UserAuthGuard)
export class NotificationSettingsController {
  constructor(
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get('notification-settings')
  @ResponseSchema(notificationSettingsSchema)
  get(@CurrentAuth() auth: AuthContext) {
    return this.notifications.settings(this.database.db, auth.userId);
  }

  @Patch('notification-settings')
  @ResponseSchema(notificationSettingsSchema)
  update(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(updateNotificationSettingsBodySchema)) body: z.infer<typeof updateNotificationSettingsBodySchema>) {
    return this.notifications.updateSettings(auth.userId, body);
  }

  @Get('badge')
  @ResponseSchema(badgeResponseSchema)
  async badge(@CurrentAuth() auth: AuthContext) {
    return { count: await this.notifications.badge(auth.userId) };
  }
}

/** Phase 7: which chat this device shows (it is not pushed about that chat while it does). */
@Controller('v1/realtime')
@UseGuards(UserAuthGuard)
export class ViewingController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Post('viewing')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async viewing(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(viewingBodySchema)) body: z.infer<typeof viewingBodySchema>) {
    await this.notifications.viewing(auth.userId, auth.sessionId, body.chatId);
    return { ok: true } as const;
  }
}
