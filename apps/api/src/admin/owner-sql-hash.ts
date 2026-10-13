import { createHash } from 'node:crypto';
import { verify as bcryptVerify } from '@node-rs/bcrypt';

/**
 * D-35: the temporary password hash written by the owner's SQL script (docs/owner-sql/set-super-admin.sql).
 * Postgres cannot produce the API's Argon2id hash, so the script stores pgcrypto's bcrypt (cost 12) of the
 * password's SHA-256, base64-encoded (the SHA-256 step lets all 128 characters count; bcrypt alone reads only
 * the first 72 bytes). Exactly this form is accepted, and only until the first successful sign-in replaces it
 * with Argon2id. The database allows the same form (migration 20261006120000).
 */
const OWNER_SQL_HASH = /^\$2a\$12\$[./A-Za-z0-9]{53}$/;

export function isOwnerSqlHash(hash: string): boolean {
  return OWNER_SQL_HASH.test(hash);
}

/** The value the SQL script hashes: encode(digest(convert_to(password, 'UTF8'), 'sha256'), 'base64'). */
export function ownerSqlPrehash(password: string): string {
  return createHash('sha256').update(password, 'utf8').digest('base64');
}

export async function verifyOwnerSqlHash(hash: string, password: string): Promise<boolean> {
  if (!isOwnerSqlHash(hash)) {
    return false;
  }
  try {
    return await bcryptVerify(ownerSqlPrehash(password), hash);
  } catch {
    return false;
  }
}
