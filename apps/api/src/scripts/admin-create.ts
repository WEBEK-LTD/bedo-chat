/* eslint-disable no-console -- command-line tool */
/**
 * Creates a system admin account (D-19, P-12): until admin management arrives in Phase 10, this is the
 * only way to create admins. Run with the table-owner DATABASE_URL and the same ADMIN_TOTP_KEY as the API.
 *
 *   node dist/scripts/admin-create.js --phone +201234567890 --name "Academy Admin" --role super_admin
 *
 * Prints the authenticator-app setup link once. Scan it (or type the secret) into the admin's
 * authenticator app; it is stored encrypted and cannot be shown again.
 */
import { parseArgs } from 'node:util';
import { adminCliEnvSchema, loadEnv } from '@bedo/config';
import { createDb } from '@bedo/db/runtime';
import { createAdmin } from '../admin/create-admin.js';

const USAGE = 'Usage: admin-create --phone <+international number> --name <1-64 chars> --role <super_admin|moderator>';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { phone: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } },
  });
  if (!values.phone || !values.name || !values.role) {
    console.error(USAGE);
    return 2;
  }
  const env = loadEnv(adminCliEnvSchema);
  const { db } = createDb({ connectionString: env.DATABASE_URL, poolMax: 1, applicationName: 'bedo-admin-cli' });
  try {
    const result = await createAdmin(db, Buffer.from(env.ADMIN_TOTP_KEY, 'base64'), {
      phone: values.phone,
      name: values.name,
      role: values.role,
    });
    if (!result.ok) {
      console.error(result.reason === 'phone_exists' ? 'An admin with this phone number already exists.' : USAGE);
      return result.reason === 'phone_exists' ? 1 : 2;
    }
    console.log(`Admin created: ${values.name.trim()} (${values.role}), id ${result.id}`);
    console.log('Add this account to the authenticator app now (shown only once):');
    console.log(`  Setup link: ${result.setupLink}`);
    console.log(`  Secret:     ${result.secret}`);
    return 0;
  } finally {
    await db.destroy();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
