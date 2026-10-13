import type { AdminRole, Database } from '@bedo/db';
import type { Kysely } from 'kysely';
import { normalizePhone } from '../common/phone.js';
import { base32Encode, encryptSecret, generateTotpSecret, otpauthUri } from './totp.js';

export interface CreateAdminInput {
  phone: string;
  name: string;
  role: string;
}

export type CreateAdminResult =
  | { ok: true; id: string; phone: string; setupLink: string; secret: string }
  | { ok: false; reason: 'invalid_input' | 'phone_exists' };

/**
 * Creates a system admin with a new authenticator secret (D-19, P-12), recorded in the audit log.
 * The secret is stored encrypted with ADMIN_TOTP_KEY and returned once for the authenticator app.
 */
export async function createAdmin(db: Kysely<Database>, totpKey: Buffer, input: CreateAdminInput): Promise<CreateAdminResult> {
  const phone = normalizePhone(input.phone);
  const name = input.name.trim();
  if (!phone || name.length === 0 || name.length > 64 || (input.role !== 'super_admin' && input.role !== 'moderator')) {
    return { ok: false, reason: 'invalid_input' };
  }
  const role: AdminRole = input.role;
  const secret = generateTotpSecret();
  try {
    const admin = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('app.admin_accounts')
        .values({ phone, name, role, totp_secret_enc: encryptSecret(totpKey, secret) })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.audit_log')
        .values({
          actor_type: 'system',
          actor_id: null,
          action: 'admin.created_by_cli',
          target_type: 'admin',
          target_id: created.id,
          metadata: { role, name },
        })
        .execute();
      return created;
    });
    return { ok: true, id: admin.id, phone, setupLink: otpauthUri(secret, phone), secret: base32Encode(secret) };
  } catch (error) {
    if (error instanceof Error && error.message.includes('admin_accounts_phone_key')) {
      return { ok: false, reason: 'phone_exists' };
    }
    throw error;
  }
}
