import type { ApiEnv } from '@bedo/config';
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH, TOKEN_RULES } from '@bedo/contracts';
import type { FastifyReply } from 'fastify';

/**
 * Refresh-token cookie (web). httpOnly, SameSite=Strict, scoped to /v1/auth, Secure in production.
 * It only works when the web app and the API share a registrable domain (P-14).
 */
export function setRefreshCookie(reply: FastifyReply, env: ApiEnv, token: string): void {
  void reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: TOKEN_RULES.refreshTokenIdleDays * 24 * 60 * 60,
  });
}

export function clearRefreshCookie(reply: FastifyReply, env: ApiEnv): void {
  void reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
}
