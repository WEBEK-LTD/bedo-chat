import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChatsService } from './chats.service.js';
import { FoldersService } from './folders.service.js';
import { ChatsController, FoldersController, MessagesController, SafetyAndSyncController, UsersController } from './messaging.controller.js';
import { MessagesService } from './messages.service.js';
import { MessagingLimitsService } from './messaging-limits.service.js';
import { PermissionService } from './permissions.service.js';
import { PresenceService } from './presence.service.js';
import { RealtimeBusService } from './realtime-bus.service.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { SafetyService } from './safety.service.js';
import { SyncService } from './sync.service.js';
import { UpdateLogService } from './update-log.service.js';
import { UsersService } from './users.service.js';
import { ViewsService } from './views.service.js';

/** Phase 3: private messaging core (D-29 to D-31). */
@Module({
  imports: [AuthModule],
  controllers: [UsersController, ChatsController, MessagesController, FoldersController, SafetyAndSyncController],
  providers: [
    PermissionService,
    PresenceService,
    RealtimeBusService,
    UpdateLogService,
    ViewsService,
    MessagingLimitsService,
    ChatsService,
    MessagesService,
    FoldersService,
    SafetyService,
    UsersService,
    SyncService,
    RealtimeGateway,
  ],
  exports: [PermissionService, RealtimeGateway],
})
export class MessagingModule {}
