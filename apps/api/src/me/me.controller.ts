import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import {
  deletionRequestResponseSchema,
  markNoticesReadBodySchema,
  meSchema,
  okResponseSchema,
  phoneChangeRequestBodySchema,
  phoneChangeVerifyBodySchema,
  photoConfirmBodySchema,
  photoUploadBodySchema,
  photoUploadResponseSchema,
  type Privacy,
  privacySchema,
  pushSubscriptionBodySchema,
  securityNoticesResponseSchema,
  sessionsResponseSchema,
  twoStepDisableBodySchema,
  twoStepSetBodySchema,
  twoStepStatusSchema,
  type UpdateMeBody,
  updateMeBodySchema,
  updatePrivacyBodySchema,
  otpRequestResponseSchema,
} from '@bedo/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { requestInfo } from '../common/request-info.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { requirePhone } from '../auth/auth.controller.js';
import { SessionsService } from '../auth/sessions.service.js';
import { type AuthContext, CurrentAuth, UserAuthGuard } from '../auth/user-auth.guard.js';
import { AccountSecurityService } from './account-security.service.js';
import { ProfileService } from './profile.service.js';

const uuidParam = z.string().uuid();

/** The signed-in user's own account (spec §2, §13). Bearer-token authenticated. */
@Controller('v1/me')
@UseGuards(UserAuthGuard)
export class MeController {
  constructor(
    @Inject(ProfileService) private readonly profile: ProfileService,
    @Inject(AccountSecurityService) private readonly security: AccountSecurityService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  @Get()
  @ResponseSchema(meSchema)
  me(@CurrentAuth() auth: AuthContext) {
    return this.profile.me(auth.userId);
  }

  @Patch()
  @ResponseSchema(meSchema)
  update(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(updateMeBodySchema)) body: UpdateMeBody) {
    return this.profile.update(auth.userId, body);
  }

  @Get('privacy')
  @ResponseSchema(privacySchema)
  privacy(@CurrentAuth() auth: AuthContext) {
    return this.profile.privacy(auth.userId);
  }

  @Patch('privacy')
  @ResponseSchema(privacySchema)
  updatePrivacy(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updatePrivacyBodySchema)) body: Partial<Privacy>,
    @Req() request: FastifyRequest,
  ) {
    return this.profile.updatePrivacy(auth.userId, body, requestInfo(request));
  }

  @Post('photo/upload')
  @HttpCode(200)
  @ResponseSchema(photoUploadResponseSchema)
  startPhotoUpload(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(photoUploadBodySchema)) body: z.infer<typeof photoUploadBodySchema>) {
    return this.profile.startPhotoUpload(auth.userId, body.contentType);
  }

  @Post('photo/confirm')
  @HttpCode(200)
  @ResponseSchema(meSchema)
  confirmPhoto(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(photoConfirmBodySchema)) body: { uploadId: string }) {
    return this.profile.confirmPhoto(auth.userId, body.uploadId);
  }

  @Delete('photo')
  @ResponseSchema(meSchema)
  removePhoto(@CurrentAuth() auth: AuthContext) {
    return this.profile.removePhoto(auth.userId);
  }

  @Post('phone/request')
  @HttpCode(200)
  @ResponseSchema(otpRequestResponseSchema)
  requestPhoneChange(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(phoneChangeRequestBodySchema)) body: { newPhone: string },
    @Req() request: FastifyRequest,
  ) {
    return this.security.requestPhoneChange(auth.userId, requirePhone(body.newPhone), requestInfo(request));
  }

  @Post('phone/verify')
  @HttpCode(200)
  @ResponseSchema(meSchema)
  async verifyPhoneChange(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(phoneChangeVerifyBodySchema)) body: z.infer<typeof phoneChangeVerifyBodySchema>,
    @Req() request: FastifyRequest,
  ) {
    await this.security.verifyPhoneChange(auth.userId, requirePhone(body.newPhone), body.code, body.twoStepPassword, requestInfo(request));
    return this.profile.me(auth.userId);
  }

  @Get('sessions')
  @ResponseSchema(sessionsResponseSchema)
  async listSessions(@CurrentAuth() auth: AuthContext) {
    return { sessions: await this.sessions.list(auth.userId, auth.sessionId) };
  }

  @Post('sessions/terminate-others')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async endOtherSessions(@CurrentAuth() auth: AuthContext, @Req() request: FastifyRequest) {
    await this.security.endOtherSessions(auth.userId, auth.sessionId, requestInfo(request));
    return { ok: true as const };
  }

  @Delete('sessions/:id')
  @ResponseSchema(okResponseSchema)
  async endSession(@CurrentAuth() auth: AuthContext, @Param('id') id: string, @Req() request: FastifyRequest) {
    if (!uuidParam.safeParse(id).success) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    await this.security.endSession(auth.userId, auth.sessionId, id, requestInfo(request));
    return { ok: true as const };
  }

  @Get('two-step')
  @ResponseSchema(twoStepStatusSchema)
  twoStepStatus(@CurrentAuth() auth: AuthContext) {
    return this.security.twoStepStatus(auth.userId);
  }

  @Put('two-step')
  @ResponseSchema(twoStepStatusSchema)
  setTwoStep(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(twoStepSetBodySchema)) body: z.infer<typeof twoStepSetBodySchema>,
    @Req() request: FastifyRequest,
  ) {
    return this.security.setTwoStep(auth.userId, body, requestInfo(request));
  }

  @Post('two-step/disable')
  @HttpCode(200)
  @ResponseSchema(twoStepStatusSchema)
  disableTwoStep(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(twoStepDisableBodySchema)) body: { currentPassword: string },
    @Req() request: FastifyRequest,
  ) {
    return this.security.disableTwoStep(auth.userId, body.currentPassword, requestInfo(request));
  }

  @Get('security-notices')
  @ResponseSchema(securityNoticesResponseSchema)
  notices(@CurrentAuth() auth: AuthContext) {
    return this.security.notices(auth.userId, auth.sessionId);
  }

  @Post('security-notices/read')
  @HttpCode(200)
  @ResponseSchema(securityNoticesResponseSchema)
  markRead(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(markNoticesReadBodySchema)) body: { ids?: string[] }) {
    return this.security.markNoticesRead(auth.userId, auth.sessionId, body.ids);
  }

  @Put('push-subscription')
  @ResponseSchema(okResponseSchema)
  async savePushSubscription(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(pushSubscriptionBodySchema)) body: z.infer<typeof pushSubscriptionBodySchema>,
  ) {
    await this.security.savePushSubscription(auth.userId, auth.sessionId, body);
    return { ok: true as const };
  }

  @Delete('push-subscription')
  @ResponseSchema(okResponseSchema)
  async removePushSubscription(@CurrentAuth() auth: AuthContext) {
    await this.security.removePushSubscription(auth.sessionId);
    return { ok: true as const };
  }

  @Post('deletion-request')
  @HttpCode(200)
  @ResponseSchema(deletionRequestResponseSchema)
  requestDeletion(@CurrentAuth() auth: AuthContext, @Req() request: FastifyRequest) {
    return this.security.requestDeletion(auth.userId, requestInfo(request));
  }
}
