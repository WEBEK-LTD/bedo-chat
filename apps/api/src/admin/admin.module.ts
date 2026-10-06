import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminAuthController, AdminBootstrapController, AdminController, AdminOtpRecoveryController } from './admin.controller.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminBootstrapService } from './admin-bootstrap.service.js';
import { AdminOperationsService } from './admin-operations.service.js';
import { AdminPasswordService } from './admin-password.service.js';
import { OtpRecoveryService } from './otp-recovery.service.js';
import { OtpSettingsService } from './otp-settings.service.js';

@Module({
  imports: [AuthModule],
  controllers: [AdminAuthController, AdminBootstrapController, AdminOtpRecoveryController, AdminController],
  providers: [AdminAuthService, AdminBootstrapService, OtpRecoveryService, OtpSettingsService, AdminOperationsService, AdminPasswordService, AdminAuthGuard],
})
export class AdminModule {}
