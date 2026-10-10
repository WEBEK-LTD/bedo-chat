import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ADMIN_SESSION_COOKIE, CSRF_HEADER, CSRF_HEADER_VALUE } from '@bedo/contracts';
import { currentStep, encryptSecret, generateTotpSecret, hotp } from '../src/admin/totp.js';
import { ADMIN_ORIGIN, adminCsrf, adminPasswordLogin, cookieValue, type IntegrationEnv, nextAdminIp, query, setAdminPassword, TOTP_KEY } from './integration-env.js';

let counter = 0;
const nextPhone = () => `+2012${String(Date.now() % 1e4).padStart(4, '0')}${String(++counter).padStart(4, '0')}`;

export interface TestAdmin {
  id: string;
  phone: string;
  secret: Buffer;
  role: 'super_admin' | 'moderator';
}

/** An admin account with a password and an authenticator (as the owner SQL and first sign-in would leave it). */
export async function createTestAdmin(ctx: IntegrationEnv, app: NestFastifyApplication, role: TestAdmin['role']): Promise<TestAdmin> {
  const phone = nextPhone();
  const secret = generateTotpSecret();
  const row = await query<{ id: string }>(
    ctx.ownerUrl,
    'insert into app.admin_accounts (phone, name, role, totp_secret_enc) values ($1, $2, $3, $4) returning id',
    [phone, `${role} tester`, role, encryptSecret(TOTP_KEY, secret)],
  );
  await setAdminPassword(app, ctx.ownerUrl, phone);
  return { id: row.rows[0]!.id, phone, secret, role };
}

/** Signs the admin in (password, then authenticator code) and returns a client for admin requests. */
export async function adminClient(app: NestFastifyApplication, admin: TestAdmin) {
  const pending = await adminPasswordLogin(app, admin.phone);
  if (pending.statusCode !== 200) throw new Error(`admin password sign-in failed: ${pending.body}`);
  const session = await app.inject({
    method: 'POST',
    url: '/v1/admin/auth/totp/verify',
    headers: adminCsrf,
    payload: { pendingToken: pending.json().pendingToken, code: hotp(admin.secret, currentStep(Date.now())) },
    remoteAddress: nextAdminIp(),
  });
  if (session.statusCode !== 200) throw new Error(`admin authenticator sign-in failed: ${session.body}`);
  const cookie = `${ADMIN_SESSION_COOKIE}=${cookieValue(session.headers['set-cookie'], ADMIN_SESSION_COOKIE)}`;
  const headers = { cookie, origin: ADMIN_ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE };
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, body: response.body ? response.json() : null };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload ?? {}),
    put: (url: string, payload?: unknown) => call('PUT', url, payload),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload),
    del: (url: string) => call('DELETE', url),
  };
}
