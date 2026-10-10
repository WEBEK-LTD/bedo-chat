import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { UserPermissionsService } from '../groups/user-permissions.service.js';
import { AdminChatsService } from './admin-chats.service.js';
import { AdminChatsController, AdminConsoleController } from './admin-console.controller.js';
import { AdminConsoleService } from './admin-console.service.js';
import { AdminMediaController } from './admin-media.controller.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminAuthController, AdminBootstrapController, AdminController, AdminOtpRecoveryController } from './admin.controller.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminBootstrapService } from './admin-bootstrap.service.js';
import { AdminOperationsService } from './admin-operations.service.js';
import { AdminPasswordService } from './admin-password.service.js';
import { OtpRecoveryService } from './otp-recovery.service.js';
import { OtpSettingsService } from './otp-settings.service.js';

@Module({
  imports: [AuthModule, MediaModule, MessagingModule],
  controllers: [AdminAuthController, AdminBootstrapController, AdminOtpRecoveryController, AdminController, AdminMediaController, AdminUsersController, AdminConsoleController, AdminChatsController],
  providers: [AdminAuthService, AdminBootstrapService, OtpRecoveryService, OtpSettingsService, AdminOperationsService, AdminPasswordService, AdminAuthGuard, UserPermissionsService, AdminConsoleService, AdminChatsService],
})
export class AdminModule {}
