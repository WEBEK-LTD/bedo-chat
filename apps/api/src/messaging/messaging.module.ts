import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChatsService } from './chats.service.js';
import { FoldersService } from './folders.service.js';
import { ChatsController, FoldersController, MessagesController, RealtimeController, SafetyAndSyncController, UsersController } from './messaging.controller.js';
import { MessagesService } from './messages.service.js';
import { MessagingLimitsService } from './messaging-limits.service.js';
import { PermissionService } from './permissions.service.js';
import { PresenceService } from './presence.service.js';
import { RealtimeActivityService } from './realtime-activity.service.js';
import { RealtimeBroadcaster, SupabaseBroadcaster } from './realtime-broadcaster.js';
import { RealtimeService } from './realtime.service.js';
import { SafetyService } from './safety.service.js';
import { SyncService } from './sync.service.js';
import { UpdateLogService } from './update-log.service.js';
import { UsersService } from './users.service.js';
import { ViewsService } from './views.service.js';

/** Phase 3: private messaging core (D-29 to D-31). */
@Module({
  imports: [AuthModule],
  controllers: [UsersController, ChatsController, MessagesController, FoldersController, SafetyAndSyncController, RealtimeController],
  providers: [
    PermissionService,
    PresenceService,
    { provide: RealtimeBroadcaster, useClass: SupabaseBroadcaster },
    RealtimeService,
    UpdateLogService,
    ViewsService,
    MessagingLimitsService,
    ChatsService,
    MessagesService,
    FoldersService,
    SafetyService,
    UsersService,
    SyncService,
    RealtimeActivityService,
  ],
  exports: [PermissionService, RealtimeService],
})
export class MessagingModule {}
