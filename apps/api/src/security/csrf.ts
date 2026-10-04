import { HttpStatus } from '@nestjs/common';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@bedo/contracts';
import type { ApiEnv } from '@bedo/config';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';

/**
 * CSRF protection for requests authenticated by a cookie (refresh, logout, every admin request).
 * Two independent checks:
 *  1. the request must come from one of the configured app origins: the browser-set Origin header is
 *     one of them, or, when the browser sends no Origin (same-origin reads on one domain, D-25), its
 *     Fetch Metadata header says the request is same-origin; and
 *  2. a custom header must be present, which a cross-site form cannot send and which forces a
 *     CORS preflight that only the configured origins pass.
 * The cookies are also SameSite=Strict.
 */
export function assertCsrf(request: FastifyRequest, allowedOrigins: readonly string[]): void {
  const origin = request.headers.origin;
  const header = request.headers[CSRF_HEADER];
  const fromAllowedOrigin =
    typeof origin === 'string' ? allowedOrigins.includes(origin) : request.headers['sec-fetch-site'] === 'same-origin' && allowedOrigins.length > 0;
  if (!fromAllowedOrigin || header !== CSRF_HEADER_VALUE) {
    throw new AppError(HttpStatus.FORBIDDEN, 'CSRF_REJECTED');
  }
}

/**
 * Origins allowed to use the user's session cookie: WEB_ORIGINS when set (D-25, may equal the admin
 * origin on a single domain), otherwise every allowed origin except the Admin Dashboard's.
 */
export function userAppOrigins(env: ApiEnv): string[] {
  if (env.WEB_ORIGINS.length > 0) {
    return env.WEB_ORIGINS;
  }
  return env.CORS_ALLOWED_ORIGINS.filter((origin) => !env.ADMIN_ORIGINS.includes(origin));
}

/** Cookie path as the browser sees it: the public API prefix (D-25, e.g. "/api") plus the API path. */
export function publicCookiePath(env: ApiEnv, path: string): string {
  return `${env.API_PUBLIC_PATH}${path}`;
}
