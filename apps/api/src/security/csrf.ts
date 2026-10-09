import { HttpStatus } from '@nestjs/common';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@bedo/contracts';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';

/**
 * Public path of the API on the site (D-36: https://bedochat.com/api). The website's /api route hands every
 * request under it to the API with the prefix removed; cookies are scoped under it so the browser sends them
 * only to the API.
 */
export const API_PUBLIC_PATH = '/api';

/** The scheme the request arrived with, set by serverless.ts from the request URL (never taken from a client). */
export const FORWARDED_PROTO_HEADER = 'x-forwarded-proto';

/**
 * The request comes from a page on this same site. D-36: the student web app, the Admin Dashboard and the API
 * share one origin, so the only allowed origin is the request's own host (no list of origins to configure).
 * The browser-set Origin header must name this host; when the browser sends no Origin (same-origin reads), its
 * Fetch Metadata header must say the request is same-origin.
 */
export function isSameOrigin(request: FastifyRequest): boolean {
  const host = request.headers.host;
  if (typeof host !== 'string' || host.length === 0) {
    return false;
  }
  const origin = request.headers.origin;
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin);
      // Over HTTPS (production) only an https page of the site counts; serverless.ts sets the scheme the request
      // arrived with and removes any value a client sent.
      const secure = request.headers[FORWARDED_PROTO_HEADER] === 'https';
      const schemeOk = parsed.protocol === 'https:' || (!secure && parsed.protocol === 'http:');
      return schemeOk && parsed.host === new URL(`http://${host}`).host;
    } catch {
      return false;
    }
  }
  return request.headers['sec-fetch-site'] === 'same-origin';
}

/**
 * CSRF protection for requests authenticated by a cookie (refresh, logout, every admin request).
 * Two independent checks:
 *  1. the request comes from a page on this site (isSameOrigin); and
 *  2. a custom header is present, which a cross-site form cannot send and which a cross-site script can only
 *     send after a CORS preflight that the API never approves (it allows no other origin).
 * The cookies are also SameSite=Strict.
 */
export function assertCsrf(request: FastifyRequest): void {
  if (!isSameOrigin(request) || request.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
    throw new AppError(HttpStatus.FORBIDDEN, 'CSRF_REJECTED');
  }
}

/** Cookie path as the browser sees it: the public API prefix ("/api") plus the API path. */
export function publicCookiePath(path: string): string {
  return `${API_PUBLIC_PATH}${path}`;
}
