import { HttpStatus } from '@nestjs/common';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@bedo/contracts';
import type { ApiEnv } from '@bedo/config';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';

/**
 * CSRF protection for requests authenticated by a cookie (refresh, logout, every admin request).
 * Two independent checks:
 *  1. the browser-set Origin header must be one of the configured app origins, and
 *  2. a custom header must be present, which a cross-site form cannot send and which forces a
 *     CORS preflight that only the configured origins pass.
 * The cookies are also SameSite=Strict.
 */
export function assertCsrf(request: FastifyRequest, allowedOrigins: readonly string[]): void {
  const origin = request.headers.origin;
  const header = request.headers[CSRF_HEADER];
  if (typeof origin !== 'string' || !allowedOrigins.includes(origin) || header !== CSRF_HEADER_VALUE) {
    throw new AppError(HttpStatus.FORBIDDEN, 'CSRF_REJECTED');
  }
}

/** Origins allowed to use the user's session cookie: every allowed origin except the Admin Dashboard's. */
export function userAppOrigins(env: ApiEnv): string[] {
  return env.CORS_ALLOWED_ORIGINS.filter((origin) => !env.ADMIN_ORIGINS.includes(origin));
}
