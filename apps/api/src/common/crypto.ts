import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, URL-safe. Used for refresh tokens, admin sessions and short-lived step tokens. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as their SHA-256 hash, so a database leak does not leak usable tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Uniformly random 6-digit code from the cryptographic generator. */
export function randomOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** HMAC of a one-time code bound to its challenge id; the plain code is never stored. */
export function hashOtp(secret: string, challengeId: string, code: string): string {
  return createHmac('sha256', secret).update(`${challengeId}:${code}`, 'utf8').digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
