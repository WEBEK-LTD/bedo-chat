import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminAuthController, AdminController } from './admin.controller.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminOperationsService } from './admin-operations.service.js';

@Module({
  imports: [AuthModule],
  controllers: [AdminAuthController, AdminController],
  providers: [AdminAuthService, AdminOperationsService, AdminAuthGuard],
})
export class AdminModule {}
