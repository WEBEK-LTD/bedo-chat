import { Module } from '@nestjs/common';
import { AccountSecurityService } from '../me/account-security.service.js';
import { MeController } from '../me/me.controller.js';
import { ProfileService } from '../me/profile.service.js';
import { PushConfigController } from '../me/push-config.controller.js';
import { AccountsService } from './accounts.service.js';
import { AuthController } from './auth.controller.js';
import { LoginService } from './login.service.js';
import { OtpService } from './otp.service.js';
import { SessionsService } from './sessions.service.js';
import { TokenService } from './token.service.js';
import { TwoStepService } from './two-step.service.js';
import { UserAuthGuard } from './user-auth.guard.js';

@Module({
  controllers: [AuthController, MeController, PushConfigController],
  providers: [
    AccountsService,
    OtpService,
    SessionsService,
    TokenService,
    TwoStepService,
    LoginService,
    UserAuthGuard,
    ProfileService,
    AccountSecurityService,
  ],
  // TokenService and UserAuthGuard: used by the Phase 3 messaging module (HTTP routes and realtime gateway).
  exports: [AccountsService, OtpService, SessionsService, TwoStepService, TokenService, UserAuthGuard],
})
export class AuthModule {}
