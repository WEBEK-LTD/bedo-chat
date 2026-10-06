import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_COOKIE_PATH,
  ADMIN_SESSION_RULES,
  adminBootstrapStatusResponseSchema,
  adminBootstrapTestBodySchema,
  adminBootstrapWaabekKeyBodySchema,
  adminPasswordChangeBodySchema,
  adminPasswordChangeResponseSchema,
  adminPasswordLoginBodySchema,
  adminPasswordLoginResponseSchema,
  adminPasswordSetupBodySchema,
  adminSessionResponseSchema,
  adminTotpSetupBodySchema,
  adminTotpSetupResponseSchema,
  adminTotpVerifyBodySchema,
  deletionDecisionBodySchema,
  deletionRequestDetailSchema,
  deletionRequestListQuerySchema,
  deletionRequestListResponseSchema,
  okResponseSchema,
  otpSettingsReplaceKeyBodySchema,
  otpSettingsReplaceKeyResponseSchema,
  otpSettingsResponseSchema,
  otpRecoveryStatusResponseSchema,
  otpRecoveryTestBodySchema,
  otpRecoveryWaabekKeyBodySchema,
  phoneListAddBodySchema,
  phoneListAddResponseSchema,
  phoneListImportBodySchema,
  phoneListImportResponseSchema,
  phoneListQuerySchema,
  phoneListResponseSchema,
  twoStepResetBodySchema,
  twoStepResetResponseSchema,
  waabekTestResponseSchema,
} from '@bedo/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { requestInfo } from '../common/request-info.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { API_ENV } from '../config/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { requirePhone } from '../auth/auth.controller.js';
import { DatabaseService } from '../database/database.service.js';
import { assertCsrf, publicCookiePath } from '../security/csrf.js';
import { AdminAuthGuard, AdminRoles, CurrentAdmin } from './admin-auth.guard.js';
import { type AdminContext, AdminAuthService } from './admin-auth.service.js';
import { AdminBootstrapService } from './admin-bootstrap.service.js';
import { AdminOperationsService } from './admin-operations.service.js';
import { AdminPasswordService } from './admin-password.service.js';
import { OtpRecoveryService } from './otp-recovery.service.js';
import { OtpSettingsService } from './otp-settings.service.js';

const uuid = z.string().uuid();

function setAdminCookie(reply: FastifyReply, env: ApiEnv, token: string): void {
  void reply.setCookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: publicCookiePath(env, ADMIN_SESSION_COOKIE_PATH),
    maxAge: ADMIN_SESSION_RULES.absoluteHours * 60 * 60,
  });
}

/**
 * Admin sign-in (D-19 as amended by D-34): phone + password, then the mandatory authenticator code. Public
 * endpoints, CSRF-checked (admin origins only) because they lead to the session cookie.
 */
@Controller('v1/admin/auth')
export class AdminAuthController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(AdminPasswordService) private readonly passwords: AdminPasswordService,
  ) {}

  @Post('password/login')
  @HttpCode(200)
  @ResponseSchema(adminPasswordLoginResponseSchema)
  login(@Body(new ZodValidationPipe(adminPasswordLoginBodySchema)) body: { phone: string; password: string }, @Req() request: FastifyRequest) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    return this.passwords.login(requirePhone(body.phone), body.password, requestInfo(request));
  }

  /** Sets a password with the owner's one-time setup token (D-34). Never signs anyone in. */
  @Post('password/setup')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async setPassword(
    @Body(new ZodValidationPipe(adminPasswordSetupBodySchema)) body: { phone: string; setupToken: string; password: string },
    @Req() request: FastifyRequest,
  ) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    await this.passwords.setWithToken(requirePhone(body.phone), body.setupToken, body.password, requestInfo(request));
    return { ok: true as const };
  }

  /** Phase 3.1: first sign-in of an account created by SQL; the server generates the authenticator secret. */
  @Post('totp/setup')
  @HttpCode(200)
  @ResponseSchema(adminTotpSetupResponseSchema)
  setupTotp(@Body(new ZodValidationPipe(adminTotpSetupBodySchema)) body: { pendingToken: string }, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    // The answer carries an authenticator secret: never cached anywhere.
    void reply.header('cache-control', 'no-store');
    return this.auth.setupTotp(body.pendingToken, requestInfo(request));
  }

  @Post('totp/verify')
  @HttpCode(200)
  @ResponseSchema(adminSessionResponseSchema)
  async verifyTotp(
    @Body(new ZodValidationPipe(adminTotpVerifyBodySchema)) body: { pendingToken: string; code: string },
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    const { admin, sessionToken } = await this.auth.verifyTotp(body.pendingToken, body.code, requestInfo(request));
    setAdminCookie(reply, this.env, sessionToken);
    return { admin };
  }
}

/**
 * Initial setup of the first Super Admin (Phase 3.1). Public endpoints, CSRF-checked; every change needs the
 * one-time setup token that the owner gets from app.open_admin_bootstrap() by SQL. Closed for good once the
 * first Super Admin has confirmed their authenticator.
 */
@Controller('v1/admin/bootstrap')
export class AdminBootstrapController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(AdminBootstrapService) private readonly bootstrap: AdminBootstrapService,
  ) {}

  @Get()
  @ResponseSchema(adminBootstrapStatusResponseSchema)
  status(@Req() request: FastifyRequest) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    return this.bootstrap.status();
  }

  @Post('waabek-key')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async saveWaabekKey(
    @Body(new ZodValidationPipe(adminBootstrapWaabekKeyBodySchema)) body: { setupToken: string; apiKey: string },
    @Req() request: FastifyRequest,
  ) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    await this.bootstrap.saveWaabekKey(body.setupToken, body.apiKey, requestInfo(request));
    return { ok: true as const };
  }

  @Post('test-message')
  @HttpCode(200)
  @ResponseSchema(waabekTestResponseSchema)
  testMessage(@Body(new ZodValidationPipe(adminBootstrapTestBodySchema)) body: { setupToken: string }, @Req() request: FastifyRequest) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    return this.bootstrap.sendTestMessage(body.setupToken, requestInfo(request));
  }
}

/**
 * Owner-only Waabek key recovery (D-33). Public endpoints, CSRF-checked; each needs the one-time recovery
 * token that the database owner gets from app.open_otp_settings_recovery() by SQL. They can only save a new
 * Waabek key and send a test message: no session, no sign-in, no change to any admin account.
 */
@Controller('v1/admin/otp-recovery')
export class AdminOtpRecoveryController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(OtpRecoveryService) private readonly recovery: OtpRecoveryService,
  ) {}

  @Get()
  @ResponseSchema(otpRecoveryStatusResponseSchema)
  status(@Req() request: FastifyRequest) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    return this.recovery.status();
  }

  @Post('waabek-key')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async saveWaabekKey(
    @Body(new ZodValidationPipe(otpRecoveryWaabekKeyBodySchema)) body: { recoveryToken: string; apiKey: string },
    @Req() request: FastifyRequest,
  ) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    await this.recovery.saveWaabekKey(body.recoveryToken, body.apiKey, requestInfo(request));
    return { ok: true as const };
  }

  @Post('test-message')
  @HttpCode(200)
  @ResponseSchema(waabekTestResponseSchema)
  testMessage(@Body(new ZodValidationPipe(otpRecoveryTestBodySchema)) body: { recoveryToken: string }, @Req() request: FastifyRequest) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    return this.recovery.sendTestMessage(body.recoveryToken, requestInfo(request));
  }
}

/** Phase 2 admin areas (D-20): session, academy phone list, deletion requests, 2-Step reset. */
@Controller('v1/admin')
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(AdminPasswordService) private readonly passwords: AdminPasswordService,
    @Inject(AdminOperationsService) private readonly operations: AdminOperationsService,
    @Inject(OtpSettingsService) private readonly otpSettings: OtpSettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** Admin views are audited too: who looked at what, and when (D-17). */
  private async auditView(admin: AdminContext, action: string, request: FastifyRequest, target?: { type: string; id: string }) {
    const info = requestInfo(request);
    await this.audit.admin(this.database.db, {
      adminId: admin.adminId,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      ip: info.ip,
      userAgent: info.userAgent,
    });
  }

  @Get('session')
  @ResponseSchema(adminSessionResponseSchema)
  session(@CurrentAdmin() admin: AdminContext) {
    return { admin: { id: admin.adminId, name: admin.name, role: admin.role } };
  }

  @Post('session/logout')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async logout(@CurrentAdmin() admin: AdminContext, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(admin, requestInfo(request));
    void reply.clearCookie(ADMIN_SESSION_COOKIE, {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: publicCookiePath(this.env, ADMIN_SESSION_COOKIE_PATH),
    });
    return { ok: true as const };
  }

  /** Any signed-in admin changes their own password (D-34): current password + authenticator code. */
  @Post('account/password')
  @HttpCode(200)
  @ResponseSchema(adminPasswordChangeResponseSchema)
  async changePassword(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(adminPasswordChangeBodySchema)) body: { currentPassword: string; newPassword: string; totpCode: string },
    @Req() request: FastifyRequest,
  ) {
    const result = await this.passwords.change(admin, body.currentPassword, body.newPassword, body.totpCode, requestInfo(request));
    return { changed: true as const, otherSessionsEnded: result.otherSessionsEnded };
  }

  @Get('phone-list')
  @ResponseSchema(phoneListResponseSchema)
  async listPhones(
    @CurrentAdmin() admin: AdminContext,
    @Query(new ZodValidationPipe(phoneListQuerySchema)) query: { search?: string; cursor?: string },
    @Req() request: FastifyRequest,
  ) {
    await this.auditView(admin, 'view.phone_list', request);
    return this.operations.listPhones(query.search, query.cursor);
  }

  @Post('phone-list')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(phoneListAddResponseSchema)
  addPhone(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(phoneListAddBodySchema)) body: { phone: string; note?: string },
    @Req() request: FastifyRequest,
  ) {
    return this.operations.addPhone(admin, body.phone, body.note, requestInfo(request));
  }

  @Post('phone-list/import')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(phoneListImportResponseSchema)
  importPhones(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(phoneListImportBodySchema)) body: { csv: string },
    @Req() request: FastifyRequest,
  ) {
    return this.operations.importPhones(admin, body.csv, requestInfo(request));
  }

  @Get('deletion-requests')
  @ResponseSchema(deletionRequestListResponseSchema)
  async listDeletionRequests(
    @CurrentAdmin() admin: AdminContext,
    @Query(new ZodValidationPipe(deletionRequestListQuerySchema)) query: { status: 'pending' | 'approved' | 'rejected' },
    @Req() request: FastifyRequest,
  ) {
    await this.auditView(admin, 'view.deletion_requests', request);
    return this.operations.listDeletionRequests(query.status);
  }

  @Get('deletion-requests/:id')
  @ResponseSchema(deletionRequestDetailSchema)
  async deletionRequest(@CurrentAdmin() admin: AdminContext, @Param('id') id: string, @Req() request: FastifyRequest) {
    if (!uuid.safeParse(id).success) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    await this.auditView(admin, 'view.deletion_request', request, { type: 'deletion_request', id });
    return this.operations.deletionRequestDetail(id);
  }

  @Post('deletion-requests/:id/approve')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(deletionRequestDetailSchema)
  approve(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(deletionDecisionBodySchema)) body: { reason?: string },
    @Req() request: FastifyRequest,
  ) {
    if (!uuid.safeParse(id).success) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    return this.operations.approveDeletion(admin, id, body.reason, requestInfo(request));
  }

  @Post('deletion-requests/:id/reject')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(deletionRequestDetailSchema)
  reject(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(deletionDecisionBodySchema)) body: { reason?: string },
    @Req() request: FastifyRequest,
  ) {
    if (!uuid.safeParse(id).success) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    return this.operations.rejectDeletion(admin, id, body.reason, requestInfo(request));
  }

  @Post('users/two-step-reset')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(twoStepResetResponseSchema)
  resetTwoStep(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(twoStepResetBodySchema)) body: { phone: string; reason: string },
    @Req() request: FastifyRequest,
  ) {
    return this.operations.resetTwoStep(admin, body.phone, body.reason, requestInfo(request));
  }

  // OTP / WhatsApp (Waabek) settings (D-32): Super Admin only. The key is never returned.
  @Get('settings/otp')
  @AdminRoles('super_admin')
  @ResponseSchema(otpSettingsResponseSchema)
  async otpSettingsView(@CurrentAdmin() admin: AdminContext, @Req() request: FastifyRequest) {
    await this.auditView(admin, 'view.otp_settings', request);
    return this.otpSettings.get();
  }

  @Put('settings/otp/waabek-key')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(otpSettingsReplaceKeyResponseSchema)
  async replaceWaabekKey(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(otpSettingsReplaceKeyBodySchema)) body: { apiKey: string; totpCode: string },
    @Req() request: FastifyRequest,
  ) {
    const { version } = await this.otpSettings.replaceKey(admin, body.apiKey, body.totpCode, requestInfo(request));
    return { saved: true as const, version };
  }

  @Post('settings/otp/test-message')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(waabekTestResponseSchema)
  sendWaabekTest(@CurrentAdmin() admin: AdminContext, @Req() request: FastifyRequest) {
    return this.otpSettings.sendTest(admin, requestInfo(request));
  }
}
