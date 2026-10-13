import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptAtRest, encryptAtRest } from '@bedo/server-crypto';

/**
 * Authenticator-app codes (RFC 6238 TOTP: HMAC-SHA1, 30-second steps, 6 digits), compatible with
 * Google Authenticator, Microsoft Authenticator, 1Password and similar apps.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** HOTP (RFC 4226) for one counter value, with a configurable number of digits for test vectors. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function currentStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * Accepts the code for the current step or one step either side (clock drift), but never a step at or
 * before `lastUsedStep`, so a code cannot be replayed. Returns the matching step or null.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const now = currentStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) {
      continue;
    }
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) {
      return step;
    }
  }
  return null;
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** Name shown in the authenticator app. */
export const TOTP_ISSUER = 'Bedo Chat Admin';

export function otpauthUri(secret: Buffer, accountLabel: string): string {
  const issuer = TOTP_ISSUER;
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** AES-256-GCM encryption of authenticator secrets at rest (key: ADMIN_TOTP_KEY), shared format (@bedo/server-crypto). */
export function encryptSecret(key: Buffer, secret: Buffer): string {
  return encryptAtRest(key, secret);
}

export function decryptSecret(key: Buffer, encoded: string): Buffer {
  return decryptAtRest(key, encoded);
}
