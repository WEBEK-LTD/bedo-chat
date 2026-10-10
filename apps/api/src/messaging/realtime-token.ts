import { createHmac, timingSafeEqual } from 'node:crypto';

/** The claim naming the one channel a device may receive on (checked by the realtime.messages policy). */
export const TOPIC_CLAIM = 'bedo_topic';
/** A device's token outlives its channel name a little, so it can move to the next name without a gap. */
export const TOKEN_GRACE_SECONDS = 5 * 60;

export interface RealtimeTokenClaims {
  aud: 'authenticated';
  role: 'authenticated';
  sub: string;
  iat: number;
  exp: number;
  [TOPIC_CLAIM]: string;
}

/**
 * A device's Supabase Realtime token (D-36, private channels): an HS256 JWT signed with the project's JWT secret, so
 * Supabase Realtime accepts it, for the role `authenticated`. Its only permission comes from the policy on
 * realtime.messages: receive broadcasts on the channel named in `bedo_topic` and nothing else; no policy lets a
 * device send. It expires a few minutes after its channel name changes (at most about an hour), and the server sends
 * nothing to a session once it is signed out.
 */
export function signRealtimeToken(secret: string, input: { userId: string; topic: string; expiresAt: Date }, now = Date.now()): string {
  const claims: RealtimeTokenClaims = {
    aud: 'authenticated',
    role: 'authenticated',
    sub: input.userId,
    iat: Math.floor(now / 1000),
    exp: Math.floor(input.expiresAt.getTime() / 1000) + TOKEN_GRACE_SECONDS,
    [TOPIC_CLAIM]: input.topic,
  };
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

/** Checks a token's signature and expiry; returns its claims, or null. Used by tests and stand-ins. */
export function verifyRealtimeToken(secret: string, token: string, now = Date.now()): RealtimeTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2]!, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: unknown };
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as RealtimeTokenClaims;
    if (header.alg !== 'HS256' || typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}
