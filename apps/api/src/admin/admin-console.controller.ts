import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, type PipeTransform, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  adminAccessSettingsBodySchema,
  adminAccessSettingsSchema,
  adminReviewAccountBodySchema,
  adminReviewAccountSchema,
  adminTestAccountsBodySchema,
  adminTestAccountsSchema,
  adminTestNumberRangeBodySchema,
  adminAddChatMembersBodySchema,
  adminAuditQuerySchema,
  adminAuditResponseSchema,
  adminBroadcastBodySchema,
  adminBroadcastSchema,
  adminBroadcastsResponseSchema,
  adminChatDetailSchema,
  adminChatMemberSchema,
  adminChatMembersQuerySchema,
  adminChatMembersResponseSchema,
  adminChatReasonBodySchema,
  adminChatsQuerySchema,
  adminChatsResponseSchema,
  adminCreateChatBodySchema,
  adminDecideReportBodySchema,
  adminReportSchema,
  adminReportsQuerySchema,
  adminReportsResponseSchema,
  adminMonitoringCheckSchema,
  adminMonitoringSchema,
  adminMonitoringSettingsBodySchema,
  adminSpeedCheckSchema,
  adminStatsSchema,
  adminUpdateChatBodySchema,
  adminUpdateChatMemberBodySchema,
  adminUserActionBodySchema,
  adminUserDetailSchema,
  adminUsersQuerySchema,
  adminUsersResponseSchema,
  addMembersResponseSchema,
  okResponseSchema,
} from '@bedo/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { requestInfo } from '../common/request-info.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdminAuthGuard, AdminRoles, CurrentAdmin } from './admin-auth.guard.js';
import type { AdminContext } from './admin-auth.service.js';
import { requirePhone } from '../auth/auth.controller.js';
import { ReviewAccountService } from '../auth/review-account.service.js';
import { TestAccountsService } from '../auth/test-accounts.service.js';
import { AdminChatsService } from './admin-chats.service.js';
import { AdminConsoleService } from './admin-console.service.js';
import { MonitoringService } from '../runtime/monitoring.service.js';

class IdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const result = z.string().uuid().safeParse(value);
    if (!result.success) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return result.data;
  }
}

/** Phase 10 (D-44): statistics, users, reports, the audit history and broadcasts. Moderators read and moderate. */
@Controller('v1/admin')
@UseGuards(AdminAuthGuard)
export class AdminConsoleController {
  constructor(
    @Inject(AdminConsoleService) private readonly console: AdminConsoleService,
    @Inject(MonitoringService) private readonly monitoring: MonitoringService,
    @Inject(ReviewAccountService) private readonly reviewAccounts: ReviewAccountService,
    @Inject(TestAccountsService) private readonly testAccounts: TestAccountsService,
  ) {}

  @Get('stats')
  @ResponseSchema(adminStatsSchema)
  stats() {
    return this.console.stats();
  }

  /** Phase 14.5: site monitoring, inside the dashboard. Every admin sees it and can check now. */
  @Get('monitoring')
  @ResponseSchema(adminMonitoringSchema)
  monitoringSummary() {
    return this.monitoring.summary();
  }

  @Post('monitoring/check')
  @HttpCode(200)
  @ResponseSchema(adminMonitoringCheckSchema)
  monitoringCheck() {
    return this.monitoring.checkNow();
  }

  @Put('monitoring/settings')
  @AdminRoles('super_admin')
  @ResponseSchema(okResponseSchema)
  async monitoringSettings(@CurrentAdmin() admin: AdminContext, @Body(new ZodValidationPipe(adminMonitoringSettingsBodySchema)) body: z.infer<typeof adminMonitoringSettingsBodySchema>) {
    await this.monitoring.setAlerts(admin.adminId, body.whatsappAlerts);
    return { ok: true as const };
  }

  /** Phase 14.4: where the server runs and how far the database is (slow sending is almost always this). */
  @Get('speed-check')
  @ResponseSchema(adminSpeedCheckSchema)
  speedCheck() {
    return this.console.speedCheck();
  }

  /** D-47: who can create an account. Every admin sees it; a Super Admin changes it. */
  @Get('settings/access')
  @ResponseSchema(adminAccessSettingsSchema)
  accessSettings() {
    return this.console.accessSettings();
  }

  @Put('settings/access')
  @AdminRoles('super_admin')
  @ResponseSchema(adminAccessSettingsSchema)
  setAccessSettings(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(adminAccessSettingsBodySchema)) body: z.infer<typeof adminAccessSettingsBodySchema>,
    @Req() request: FastifyRequest,
  ) {
    return this.console.setSignupMode(admin, body.signupMode, requestInfo(request));
  }

  /** D-56: the store review account. Super Admins only (the answer holds the fixed code). */
  @Get('settings/review-account')
  @AdminRoles('super_admin')
  @ResponseSchema(adminReviewAccountSchema)
  reviewAccount() {
    return this.reviewAccounts.settings();
  }

  @Put('settings/review-account')
  @AdminRoles('super_admin')
  @ResponseSchema(adminReviewAccountSchema)
  setReviewAccount(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(adminReviewAccountBodySchema)) body: z.infer<typeof adminReviewAccountBodySchema>,
    @Req() request: FastifyRequest,
  ) {
    const phone = requirePhone(body.phone);
    return this.reviewAccounts.update(admin, { ...body, phone }, requestInfo(request));
  }

  /** D-59: test accounts. Super Admins only (the answer holds the fixed code). */
  @Get('settings/test-accounts')
  @AdminRoles('super_admin')
  @ResponseSchema(adminTestAccountsSchema)
  testAccountsSettings() {
    return this.testAccounts.settings();
  }

  @Put('settings/test-accounts')
  @AdminRoles('super_admin')
  @ResponseSchema(adminTestAccountsSchema)
  setTestAccounts(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(adminTestAccountsBodySchema)) body: z.infer<typeof adminTestAccountsBodySchema>,
    @Req() request: FastifyRequest,
  ) {
    return this.testAccounts.update(admin, body, requestInfo(request));
  }

  @Post('settings/test-accounts/ranges')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(adminTestAccountsSchema)
  addTestNumberRange(
    @CurrentAdmin() admin: AdminContext,
    @Body(new ZodValidationPipe(adminTestNumberRangeBodySchema)) body: z.infer<typeof adminTestNumberRangeBodySchema>,
    @Req() request: FastifyRequest,
  ) {
    return this.testAccounts.addRange(admin, requirePhone(body.firstPhone), requirePhone(body.lastPhone), requestInfo(request));
  }

  @Delete('settings/test-accounts/ranges/:id')
  @AdminRoles('super_admin')
  @ResponseSchema(adminTestAccountsSchema)
  removeTestNumberRange(@CurrentAdmin() admin: AdminContext, @Param('id', new IdPipe()) id: string, @Req() request: FastifyRequest) {
    return this.testAccounts.removeRange(admin, id, requestInfo(request));
  }

  @Get('users')
  @ResponseSchema(adminUsersResponseSchema)
  users(@Query(new ZodValidationPipe(adminUsersQuerySchema)) query: z.infer<typeof adminUsersQuerySchema>) {
    return this.console.users(query);
  }

  @Get('users/:id')
  @ResponseSchema(adminUserDetailSchema)
  user(@Param('id', new IdPipe()) id: string) {
    return this.console.user(id);
  }

  /** Suspend, reactivate and end sessions: every admin; ban and delete: Super Admins (checked in the service). */
  @Post('users/:id/action')
  @HttpCode(200)
  @ResponseSchema(adminUserDetailSchema)
  userAction(@CurrentAdmin() admin: AdminContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(adminUserActionBodySchema)) body: z.infer<typeof adminUserActionBodySchema>, @Req() request: FastifyRequest) {
    return this.console.userAction(admin, id, body.action, body.reason, requestInfo(request));
  }

  @Get('reports')
  @ResponseSchema(adminReportsResponseSchema)
  reports(@Query(new ZodValidationPipe(adminReportsQuerySchema)) query: z.infer<typeof adminReportsQuerySchema>) {
    return this.console.reports(query.status, query.cursor);
  }

  @Post('reports/:id/decision')
  @HttpCode(200)
  @ResponseSchema(adminReportSchema)
  decide(@CurrentAdmin() admin: AdminContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(adminDecideReportBodySchema)) body: z.infer<typeof adminDecideReportBodySchema>, @Req() request: FastifyRequest) {
    return this.console.decideReport(admin, id, body.decision, body.note, requestInfo(request));
  }

  @Get('audit')
  @AdminRoles('super_admin')
  @ResponseSchema(adminAuditResponseSchema)
  audit(@CurrentAdmin() admin: AdminContext, @Query(new ZodValidationPipe(adminAuditQuerySchema)) query: z.infer<typeof adminAuditQuerySchema>, @Req() request: FastifyRequest) {
    return this.console.auditHistory(admin, query, requestInfo(request));
  }

  @Get('broadcasts')
  @AdminRoles('super_admin')
  @ResponseSchema(adminBroadcastsResponseSchema)
  broadcasts() {
    return this.console.listBroadcasts();
  }

  @Post('broadcasts')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(adminBroadcastSchema)
  broadcast(@CurrentAdmin() admin: AdminContext, @Body(new ZodValidationPipe(adminBroadcastBodySchema)) body: z.infer<typeof adminBroadcastBodySchema>, @Req() request: FastifyRequest) {
    return this.console.createBroadcast(admin, body, requestInfo(request));
  }
}

/** Phase 10 (D-44): groups and channels. Every admin reads; Super Admins change. */
@Controller('v1/admin/chats')
@UseGuards(AdminAuthGuard)
export class AdminChatsController {
  constructor(@Inject(AdminChatsService) private readonly chats: AdminChatsService) {}

  @Get()
  @ResponseSchema(adminChatsResponseSchema)
  list(@Query(new ZodValidationPipe(adminChatsQuerySchema)) query: z.infer<typeof adminChatsQuerySchema>) {
    return this.chats.list(query);
  }

  @Post()
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(adminChatDetailSchema)
  create(@CurrentAdmin() admin: AdminContext, @Body(new ZodValidationPipe(adminCreateChatBodySchema)) body: z.infer<typeof adminCreateChatBodySchema>, @Req() request: FastifyRequest) {
    return this.chats.create(admin, body, requestInfo(request));
  }

  @Get(':id')
  @ResponseSchema(adminChatDetailSchema)
  detail(@Param('id', new IdPipe()) id: string) {
    return this.chats.detail(id);
  }

  @Patch(':id')
  @AdminRoles('super_admin')
  @ResponseSchema(adminChatDetailSchema)
  update(@CurrentAdmin() admin: AdminContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(adminUpdateChatBodySchema)) body: z.infer<typeof adminUpdateChatBodySchema>, @Req() request: FastifyRequest) {
    return this.chats.update(admin, id, body, requestInfo(request));
  }

  @Post(':id/delete')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(adminChatDetailSchema)
  remove(@CurrentAdmin() admin: AdminContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(adminChatReasonBodySchema)) body: z.infer<typeof adminChatReasonBodySchema>, @Req() request: FastifyRequest) {
    return this.chats.remove(admin, id, body.reason, requestInfo(request));
  }

  @Get(':id/members')
  @ResponseSchema(adminChatMembersResponseSchema)
  members(@Param('id', new IdPipe()) id: string, @Query(new ZodValidationPipe(adminChatMembersQuerySchema)) query: z.infer<typeof adminChatMembersQuerySchema>) {
    return this.chats.members(id, query.after);
  }

  @Post(':id/members')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(addMembersResponseSchema)
  addMembers(@CurrentAdmin() admin: AdminContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(adminAddChatMembersBodySchema)) body: z.infer<typeof adminAddChatMembersBodySchema>, @Req() request: FastifyRequest) {
    return this.chats.addMembers(admin, id, body.userIds, body.reason, requestInfo(request));
  }

  @Patch(':id/members/:userId')
  @AdminRoles('super_admin')
  @ResponseSchema(adminChatMemberSchema)
  updateMember(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new IdPipe()) id: string,
    @Param('userId', new IdPipe()) userId: string,
    @Body(new ZodValidationPipe(adminUpdateChatMemberBodySchema)) body: z.infer<typeof adminUpdateChatMemberBodySchema>,
    @Req() request: FastifyRequest,
  ) {
    return this.chats.updateMember(admin, id, userId, body, requestInfo(request));
  }

  @Post(':id/members/:userId/remove')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(okResponseSchema)
  async removeMember(
    @CurrentAdmin() admin: AdminContext,
    @Param('id', new IdPipe()) id: string,
    @Param('userId', new IdPipe()) userId: string,
    @Body(new ZodValidationPipe(adminChatReasonBodySchema)) body: z.infer<typeof adminChatReasonBodySchema>,
    @Req() request: FastifyRequest,
  ) {
    await this.chats.removeMember(admin, id, userId, body.reason, requestInfo(request));
    return { ok: true } as const;
  }
}
