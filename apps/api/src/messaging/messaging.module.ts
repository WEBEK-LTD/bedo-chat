import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChannelsController, GroupsController, InvitesController, MyPermissionsController, PollsController } from '../groups/groups.controller.js';
import { GroupsService } from '../groups/groups.service.js';
import { MentionsService } from '../groups/mentions.service.js';
import { PollsService } from '../groups/polls.service.js';
import { UserPermissionsService } from '../groups/user-permissions.service.js';
import { FilesService } from '../media/files.service.js';
import { ChatMediaController, FilesController, GifsController, MessageMediaController, StickersController } from '../media/media.controller.js';
import { MediaModule } from '../media/media.module.js';
import { ReactionsService } from '../media/reactions.service.js';
import { BroadcastsService } from './broadcasts.service.js';
import { ChatsService } from './chats.service.js';
import { FoldersService } from './folders.service.js';
import { ChatsController, FoldersController, MessagesController, RealtimeController, SafetyAndSyncController, UsersController } from './messaging.controller.js';
import { MessagesService } from './messages.service.js';
import { MessagingLimitsService } from './messaging-limits.service.js';
import { PermissionService } from './permissions.service.js';
import { PresenceService } from './presence.service.js';
import { RealtimeActivityService } from './realtime-activity.service.js';
import { RealtimeBroadcaster, SupabaseBroadcaster } from './realtime-broadcaster.js';
import { NotificationSettingsController, ViewingController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { RealtimeService } from './realtime.service.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';
import { ChatScheduledController, InternalDispatchController, ScheduledController } from './scheduled.controller.js';
import { ScheduledService } from './scheduled.service.js';
import { SafetyService } from './safety.service.js';
import { SyncService } from './sync.service.js';
import { UpdateLogService } from './update-log.service.js';
import { UsersService } from './users.service.js';
import { ViewsService } from './views.service.js';

/** Phase 3: private messaging core (D-29 to D-31); Phase 4: files, stickers, GIFs and reactions (D-38); Phase 5: groups (D-39); Phase 6: channels and scheduled messages (D-40); Phase 7: notifications (D-41); Phase 8: global search (D-42). */
@Module({
  imports: [AuthModule, MediaModule],
  controllers: [
    UsersController,
    ChatsController,
    MessagesController,
    FoldersController,
    SafetyAndSyncController,
    RealtimeController,
    FilesController,
    MessageMediaController,
    ChatMediaController,
    StickersController,
    GifsController,
    GroupsController,
    InvitesController,
    PollsController,
    MyPermissionsController,
    ChannelsController,
    ChatScheduledController,
    ScheduledController,
    InternalDispatchController,
    NotificationSettingsController,
    ViewingController,
    SearchController,
  ],
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
    FilesService,
    ReactionsService,
    GroupsService,
    PollsService,
    MentionsService,
    UserPermissionsService,
    ScheduledService,
    NotificationsService,
    SearchService,
    BroadcastsService,
  ],
  exports: [PermissionService, RealtimeService, ScheduledService, UpdateLogService, BroadcastsService, NotificationsService, GroupsService],
})
export class MessagingModule {}
