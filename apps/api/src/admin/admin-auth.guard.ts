import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ADMIN_SESSION_COOKIE } from '@bedo/contracts';
import type { AdminRole } from '@bedo/db';
import type { FastifyRequest } from 'fastify';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { requestInfo } from '../common/request-info.js';
import { DatabaseService } from '../database/database.service.js';
import { assertCsrf } from '../security/csrf.js';
import { type AdminContext, AdminAuthService } from './admin-auth.service.js';

type AdminRequest = FastifyRequest & { admin?: AdminContext };

const ROLES_KEY = 'bedo:admin-roles';
/** Restricts a route to the listed admin roles (P-12). Routes without it allow every admin role. */
export const AdminRoles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Admin session cookie authentication, origin and CSRF checks on every request, and role checks.
 * Student access tokens are never accepted here.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    // Every admin request, reads included, must come from a page of this site with the CSRF header, so no
    // other site can read or act on admin data. The student web app shares the origin (D-25, D-36): what keeps
    // it apart is the separate admin session cookie and the strict Content-Security-Policy (D-31).
    assertCsrf(request);
    const token = request.cookies[ADMIN_SESSION_COOKIE];
    if (!token) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED');
    }
    const admin = await this.auth.authenticate(token);
    const roles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (roles && !roles.includes(admin.role)) {
      // Refused attempts are part of the admin history too (D-17).
      const info = requestInfo(request);
      await this.audit.admin(this.database.db, {
        adminId: admin.adminId,
        action: 'admin.action_refused',
        ip: info.ip,
        userAgent: info.userAgent,
        metadata: { method: request.method, route: request.routeOptions.url ?? null, role: admin.role },
      });
      throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN');
    }
    request.admin = admin;
    return true;
  }
}

export const CurrentAdmin = createParamDecorator((_data: unknown, context: ExecutionContext): AdminContext => {
  const request = context.switchToHttp().getRequest<AdminRequest>();
  if (!request.admin) {
    throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED');
  }
  return request.admin;
});
