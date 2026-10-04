import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import { SessionsService } from './sessions.service.js';
import { TokenService } from './token.service.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
}

type AuthedRequest = FastifyRequest & { auth?: AuthContext };

/**
 * Bearer-token authentication for the user API. The token's session is checked against the database on
 * every request, so logout, session termination and account blocks take effect immediately.
 */
@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED');
    }
    request.auth = await this.authenticate(header.slice('Bearer '.length).trim());
    return true;
  }

  /**
   * Checks an access token and its session. Shared by HTTP requests and the realtime gateway (Phase 3), so
   * both refuse ended sessions and blocked or deleted accounts the same way.
   */
  async authenticate(token: string): Promise<AuthContext> {
    const claims = await this.tokens.verify(token);
    await this.checkSession(claims.sessionId, claims.userId);
    return { userId: claims.userId, sessionId: claims.sessionId };
  }

  /**
   * Refuses a session that has ended or expired, or whose account is blocked or deleted. The realtime
   * gateway repeats this on every heartbeat, so a long-lived connection ends with its session.
   */
  async checkSession(sessionId: string, userId: string): Promise<void> {
    const session = await this.sessions.loadActive(sessionId, userId);
    if (!session) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED');
    }
    if (session.revoked_at) {
      if (session.revoke_reason === 'account_deleted') {
        throw new AppError(HttpStatus.UNAUTHORIZED, 'ACCOUNT_DELETED');
      }
      if (session.revoke_reason === 'account_blocked') {
        throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
      }
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED');
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED');
    }
    if (session.status === 'suspended' || session.status === 'banned') {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
    }
    if (session.status === 'deleted') {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'ACCOUNT_DELETED');
    }
  }
}

export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext => {
  const request = context.switchToHttp().getRequest<AuthedRequest>();
  if (!request.auth) {
    throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED');
  }
  return request.auth;
});
