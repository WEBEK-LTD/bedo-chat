import { Body, Controller, Get, Inject, Put, Query, Req, UseGuards } from '@nestjs/common';
import { adminUserPermissionsBodySchema, adminUserPermissionsQuerySchema, adminUserPermissionsResponseSchema } from '@bedo/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePhone } from '../auth/auth.controller.js';
import { requestInfo } from '../common/request-info.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { UserPermissionsService } from '../groups/user-permissions.service.js';
import { AdminAuthGuard, AdminRoles, CurrentAdmin } from './admin-auth.guard.js';
import type { AdminContext } from './admin-auth.service.js';

/** Phase 5 (O-21): a user's system permissions. Every admin reads; Super Admins change. */
@Controller('v1/admin/users')
@UseGuards(AdminAuthGuard)
export class AdminUsersController {
  constructor(@Inject(UserPermissionsService) private readonly permissions: UserPermissionsService) {}

  @Get('permissions')
  @ResponseSchema(adminUserPermissionsResponseSchema)
  get(@Query(new ZodValidationPipe(adminUserPermissionsQuerySchema)) query: z.infer<typeof adminUserPermissionsQuerySchema>) {
    return this.permissions.adminFind(requirePhone(query.phone));
  }

  @Put('permissions')
  @AdminRoles('super_admin')
  @ResponseSchema(adminUserPermissionsResponseSchema)
  set(@CurrentAdmin() admin: AdminContext, @Body(new ZodValidationPipe(adminUserPermissionsBodySchema)) body: z.infer<typeof adminUserPermissionsBodySchema>, @Req() request: FastifyRequest) {
    const { phone, ...permissions } = body;
    return this.permissions.adminSet(admin.adminId, requirePhone(phone), permissions, requestInfo(request));
  }
}
