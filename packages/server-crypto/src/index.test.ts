import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptAtRest,
  DecryptionError,
  decryptWaabekApiKey,
  encryptAtRest,
  encryptWaabekApiKey,
  parseAes256Key,
  WAABEK_API_KEY_PURPOSE,
} from './index.js';

const key = randomBytes(32);
// Obviously fake: no real key is ever used in tests.
const FAKE_API_KEY = 'fake-waabek-key-for-encryption-tests-0001';

describe('encryption at rest (AES-256-GCM)', () => {
  it('round-trips and never stores the plaintext', () => {
    const stored = encryptWaabekApiKey(key, FAKE_API_KEY);
    expect(stored).not.toContain(FAKE_API_KEY);
    expect(Buffer.from(stored, 'base64').toString('utf8')).not.toContain(FAKE_API_KEY);
    expect(decryptWaabekApiKey(key, stored)).toBe(FAKE_API_KEY);
  });

  it('uses a fresh IV for every encryption', () => {
    const a = encryptWaabekApiKey(key, FAKE_API_KEY);
    const b = encryptWaabekApiKey(key, FAKE_API_KEY);
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64').subarray(0, 12).equals(Buffer.from(b, 'base64').subarray(0, 12))).toBe(false);
  });

  it('refuses a wrong key, a tampered value, a truncated value and another purpose', () => {
    const stored = encryptWaabekApiKey(key, FAKE_API_KEY);
    expect(() => decryptWaabekApiKey(randomBytes(32), stored)).toThrow(DecryptionError);
    const tampered = Buffer.from(stored, 'base64');
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => decryptWaabekApiKey(key, tampered.toString('base64'))).toThrow(DecryptionError);
    expect(() => decryptWaabekApiKey(key, stored.slice(0, 20))).toThrow(DecryptionError);
    expect(() => decryptWaabekApiKey(key, '')).toThrow(DecryptionError);
    // A value encrypted for another field (or without a purpose) is not accepted as the Waabek key.
    expect(() => decryptWaabekApiKey(key, encryptAtRest(key, Buffer.from(FAKE_API_KEY)))).toThrow(DecryptionError);
    expect(() => decryptAtRest(key, stored)).toThrow(DecryptionError);
    expect(() => decryptAtRest(key, stored, 'bedo:other')).toThrow(DecryptionError);
  });

  it('never puts the key, the value or the plaintext into errors', () => {
    const stored = encryptWaabekApiKey(key, FAKE_API_KEY);
    const error = (() => {
      try {
        decryptWaabekApiKey(randomBytes(32), stored);
      } catch (caught) {
        return caught as Error;
      }
      return null;
    })();
    const text = `${error?.message} ${error?.stack ?? ''}`;
    for (const secret of [FAKE_API_KEY, stored, key.toString('base64')]) {
      expect(text).not.toContain(secret);
    }
  });

  it('keeps the stored format of Phase 2 authenticator secrets: base64(iv | tag | ciphertext), no purpose', () => {
    const secret = randomBytes(20);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    expect(decryptAtRest(key, legacy).equals(secret)).toBe(true);
  });

  it('accepts only 32-byte keys', () => {
    expect(parseAes256Key(key.toString('base64')).equals(key)).toBe(true);
    expect(() => parseAes256Key(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseAes256Key('')).toThrow(/32 bytes/);
    expect(() => encryptAtRest(randomBytes(31), Buffer.from('x'))).toThrow(/32 bytes/);
    expect(WAABEK_API_KEY_PURPOSE).toMatch(/waabek/);
  });
});
