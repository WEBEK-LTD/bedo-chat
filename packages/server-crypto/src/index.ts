import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for server-side secrets (admin authenticator secrets, D-19; the Waabek API key,
 * D-32): AES-256-GCM with a random 96-bit IV and a 128-bit authentication tag. The stored form is
 * base64(iv | tag | ciphertext). Server-only: never import this from the web or admin apps.
 *
 * `purpose` (optional) is bound into the ciphertext as additional authenticated data, so a value
 * encrypted for one field cannot be decrypted as another. Values written without a purpose (admin
 * authenticator secrets since Phase 2) must be read without one.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const AES_256_KEY_BYTES = 32;

/** Thrown for every decryption failure. Never carries the key, the stored value or the plaintext. */
export class DecryptionError extends Error {
  constructor() {
    super('The stored value could not be decrypted');
    this.name = 'DecryptionError';
  }
}

/** Decodes a base64 AES-256 key; throws unless it is exactly 32 bytes. */
export function parseAes256Key(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(`Encryption key must be exactly ${AES_256_KEY_BYTES} bytes, base64-encoded`);
  }
  return key;
}

function assertKey(key: Buffer): void {
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(`Encryption key must be exactly ${AES_256_KEY_BYTES} bytes`);
  }
}

export function encryptAtRest(key: Buffer, plaintext: Buffer, purpose?: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (purpose !== undefined) {
    cipher.setAAD(Buffer.from(purpose, 'utf8'));
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptAtRest(key: Buffer, encoded: string, purpose?: string): Buffer {
  assertKey(key);
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new DecryptionError();
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    if (purpose !== undefined) {
      decipher.setAAD(Buffer.from(purpose, 'utf8'));
    }
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

/** Purpose label for the Waabek API key in app.otp_settings (D-32). */
export const WAABEK_API_KEY_PURPOSE = 'bedo:app.otp_settings:waabek_api_key:v1';

export function encryptWaabekApiKey(key: Buffer, apiKey: string): string {
  return encryptAtRest(key, Buffer.from(apiKey, 'utf8'), WAABEK_API_KEY_PURPOSE);
}

export function decryptWaabekApiKey(key: Buffer, encoded: string): string {
  return decryptAtRest(key, encoded, WAABEK_API_KEY_PURPOSE).toString('utf8');
}
