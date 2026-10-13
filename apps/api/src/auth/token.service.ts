import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { TOKEN_RULES } from '@bedo/contracts';
import { jwtVerify, SignJWT } from 'jose';
import { AppError } from '../common/app-error.js';
import { API_ENV } from '../config/tokens.js';

const ISSUER = 'bedo-api';
const AUDIENCE = 'bedo-app';

export interface AccessClaims {
  userId: string;
  sessionId: string;
}

/** Short-lived access tokens (P-01), HS256, bound to a session that is checked on every request. */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.key = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);
  }

  async issue(claims: AccessClaims): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_RULES.accessTokenSeconds}s`)
      .sign(this.key);
    return { token, expiresIn: TOKEN_RULES.accessTokenSeconds };
  }

  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new Error('missing claims');
      }
      return { userId: payload.sub, sessionId: payload.sid };
    } catch {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED');
    }
  }
}
