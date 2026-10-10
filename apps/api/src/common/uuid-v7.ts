import { randomBytes } from 'node:crypto';

/**
 * A time-ordered UUID (version 7, RFC 9562), made the same way as the database's app.uuid_v7() — 48-bit Unix time in
 * milliseconds, then random bits — so message ids keep falling into the right monthly partition. Made here rather
 * than asked from the database to save a round trip on every send (Phase 14.4).
 */
export function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((ms >> BigInt(8 * (5 - index))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
