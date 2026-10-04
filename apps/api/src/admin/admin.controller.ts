import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_COOKIE_PATH,
  ADMIN_SESSION_RULES,
  adminOtpRequestBodySchema,
  adminOtpVerifyBodySchema,
  adminOtpVerifyResponseSchema,
  adminSessionResponseSchema,
  adminTotpVerifyBodySchema,
  deletionDecisionBodySchema,
  deletionRequestDetailSchema,
  deletionRequestListQuerySchema,
  deletionRequestListResponseSchema,
  okResponseSchema,
  otpRequestResponseSchema,
  phoneListAddBodySchema,
  phoneListAddResponseSchema,
  phoneListImportBodySchema,
  phoneListImportResponseSchema,
  phoneListQuerySchema,
  phoneListResponseSchema,
  twoStepResetBodySchema,
  twoStepResetResponseSchema,
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
import { AdminOperationsService } from './admin-operations.service.js';

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

/** Admin sign-in (D-19). Public endpoints, CSRF-checked because they set the session cookie. */
@Controller('v1/admin/auth')
export class AdminAuthController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
  ) {}

  @Post('otp/request')
  @HttpCode(200)
  @ResponseSchema(otpRequestResponseSchema)
  requestCode(@Body(new ZodValidationPipe(adminOtpRequestBodySchema)) body: { phone: string }, @Req() request: FastifyRequest) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    return this.auth.requestCode(requirePhone(body.phone), requestInfo(request));
  }

  @Post('otp/verify')
  @HttpCode(200)
  @ResponseSchema(adminOtpVerifyResponseSchema)
  async verifyCode(@Body(new ZodValidationPipe(adminOtpVerifyBodySchema)) body: { phone: string; code: string }, @Req() request: FastifyRequest) {
    assertCsrf(request, this.env.ADMIN_ORIGINS);
    const pendingToken = await this.auth.verifyCode(requirePhone(body.phone), body.code, requestInfo(request));
    return { status: 'totp_required' as const, pendingToken };
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

/** Phase 2 admin areas (D-20): session, academy phone list, deletion requests, 2-Step reset. */
@Controller('v1/admin')
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(AdminOperationsService) private readonly operations: AdminOperationsService,
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
}
