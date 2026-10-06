import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ADMIN_SESSION_COOKIE, CSRF_HEADER, CSRF_HEADER_VALUE, REFRESH_COOKIE } from '@bedo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentStep, encryptSecret, generateTotpSecret, hotp } from '../src/admin/totp.js';
import {
  ADMIN_TEST_PASSWORD,
  clearCooldown,
  cookieValue,
  type IntegrationEnv,
  issuePasswordSetup,
  latestCode,
  query,
  setupIntegrationEnv,
  startApp,
  TOTP_KEY,
} from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);
const SITE = 'https://bedochat.test';
let counter = 0;
const nextPhone = () => `+2015${String(Date.now() % 1e4).padStart(4, '0')}${String(++counter).padStart(4, '0')}`;
let ipCounter = 0;
const nextIp = () => `10.90.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

const EDGE_SECRET = randomBytes(32).toString('base64');
/** Added by the edge router to every request it forwards to the API. */
const EDGE = { 'x-bedo-edge-secret': EDGE_SECRET };
/** What a browser sends from a page on https://bedochat.test to https://bedochat.test/api (D-25), via the edge. */
const sameOriginWrite = { ...EDGE, origin: SITE, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE };
/** Same-origin GET: browsers send no Origin header, only Fetch Metadata. */
const sameOriginRead = { ...EDGE, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE };

function setCookieHeader(setCookie: string | string[] | undefined, name: string): string | undefined {
  return [setCookie ?? []].flat().find((header) => header.startsWith(`${name}=`));
}

/**
 * D-25: student app, admin app and API on one origin (https://bedochat.com in production), the API behind
 * the /api path. The API behaves as the edge delivers requests: prefix removed, browser headers intact.
 */
describe.runIf(enabled)('single public domain (D-25)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;

  const post = (url: string, payload: unknown, headers: Record<string, string> = sameOriginWrite) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers, remoteAddress: nextIp() });

  async function student() {
    const phone = nextPhone();
    await query(ctx.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    await clearCooldown(ctx.redis, ctx.prefix, phone);
    await post('/v1/auth/otp/request', { phone });
    const verified = await post('/v1/auth/otp/verify', { phone, code: await latestCode(ctx.otpQueue, phone) });
    return {
      accessToken: verified.json().accessToken as string,
      refresh: cookieValue(verified.headers['set-cookie'], REFRESH_COOKIE)!,
      setCookie: setCookieHeader(verified.headers['set-cookie'], REFRESH_COOKIE),
    };
  }

  async function admin() {
    const phone = nextPhone();
    const secret = generateTotpSecret();
    await query(ctx.ownerUrl, "insert into app.admin_accounts (phone, name, role, totp_secret_enc) values ($1, 'Office', 'super_admin', $2)", [
      phone,
      encryptSecret(TOTP_KEY, secret),
    ]);
    // D-34: the owner's setup token, the Set Password panel, then phone + password — all through the edge.
    const setupToken = await issuePasswordSetup(ctx.ownerUrl, phone);
    expect((await post('/v1/admin/auth/password/setup', { phone, setupToken, password: ADMIN_TEST_PASSWORD })).statusCode).toBe(200);
    const pending = await post('/v1/admin/auth/password/login', { phone, password: ADMIN_TEST_PASSWORD });
    expect(pending.statusCode, pending.body).toBe(200);
    const session = await post('/v1/admin/auth/totp/verify', { pendingToken: pending.json().pendingToken, code: hotp(secret, currentStep(Date.now())) });
    expect(session.statusCode, session.body).toBe(200);
    return {
      cookie: `${ADMIN_SESSION_COOKIE}=${cookieValue(session.headers['set-cookie'], ADMIN_SESSION_COOKIE)}`,
      setCookie: setCookieHeader(session.headers['set-cookie'], ADMIN_SESSION_COOKIE),
    };
  }

  beforeAll(async () => {
    ctx = await setupIntegrationEnv({
      CORS_ALLOWED_ORIGINS: SITE,
      ADMIN_ORIGINS: SITE,
      WEB_ORIGINS: SITE,
      API_PUBLIC_PATH: '/api',
      EDGE_SECRET,
      // The Worker plus the host's load balancer, as in production.
      API_TRUST_PROXY_HOPS: '2',
    });
    app = await startApp(ctx.env);
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  it('scopes both session cookies under /api so the browser sends them only to the API', async () => {
    const account = await student();
    expect(account.setCookie).toMatch(/; Path=\/api\/v1\/auth(;|$)/);
    expect(account.setCookie).toMatch(/HttpOnly/);
    expect(account.setCookie).toMatch(/SameSite=Strict/);
    const office = await admin();
    expect(office.setCookie).toMatch(/; Path=\/api\/v1\/admin(;|$)/);
  });

  it('refreshes and signs out a student from the shared origin, and rejects cross-site or header-less attempts', async () => {
    const account = await student();
    const refresh = (headers: Record<string, string>, token = account.refresh) =>
      app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { ...EDGE, ...headers, cookie: `${REFRESH_COOKIE}=${token}` } });

    const rotated = await refresh(sameOriginWrite);
    expect(rotated.statusCode, rotated.body).toBe(200);
    const next = cookieValue(rotated.headers['set-cookie'], REFRESH_COOKIE)!;

    for (const headers of <Array<Record<string, string>>>[
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      { 'sec-fetch-site': 'cross-site', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      { [CSRF_HEADER]: CSRF_HEADER_VALUE },
      { origin: SITE, 'sec-fetch-site': 'same-origin' },
    ]) {
      expect((await refresh(headers, next)).json().error.code).toBe('CSRF_REJECTED');
    }
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { ...sameOriginWrite, cookie: `${REFRESH_COOKIE}=${next}` } });
    expect(out.statusCode).toBe(200);
    expect((await refresh(sameOriginWrite, next)).json().error.code).toBe('SESSION_INVALID');
  });

  it('serves the admin session to same-origin reads and refuses cross-site ones', async () => {
    const office = await admin();
    const read = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/v1/admin/session', headers: { ...EDGE, ...headers, cookie: office.cookie } });
    expect((await read(sameOriginRead)).json().admin.role).toBe('super_admin');
    expect((await read({ 'sec-fetch-site': 'cross-site', [CSRF_HEADER]: CSRF_HEADER_VALUE })).json().error.code).toBe('CSRF_REJECTED');
    expect((await read({ origin: 'https://evil.example', [CSRF_HEADER]: CSRF_HEADER_VALUE })).json().error.code).toBe('CSRF_REJECTED');
    expect((await read({ 'sec-fetch-site': 'same-origin' })).json().error.code).toBe('CSRF_REJECTED');
    const list = await app.inject({ method: 'GET', url: '/v1/admin/phone-list', headers: { ...sameOriginRead, cookie: office.cookie } });
    expect(list.statusCode).toBe(200);
  });

  it('never lets a student session reach admin functions, or an admin session reach student routes', async () => {
    const account = await student();
    const studentCredentials = {
      ...sameOriginRead,
      authorization: `Bearer ${account.accessToken}`,
      cookie: `${REFRESH_COOKIE}=${account.refresh}`,
    };
    for (const url of ['/v1/admin/session', '/v1/admin/phone-list', '/v1/admin/deletion-requests']) {
      const response = await app.inject({ method: 'GET', url, headers: studentCredentials });
      expect(response.statusCode, url).toBe(401);
    }
    for (const [url, payload] of [
      ['/v1/admin/phone-list', { phone: nextPhone() }],
      ['/v1/admin/users/two-step-reset', { phone: nextPhone(), reason: 'not an admin' }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, payload, headers: { ...studentCredentials, origin: SITE } });
      expect(response.statusCode, url).toBe(401);
    }
    // A student's sign-in code cannot start an admin session: admin sign-in takes no WhatsApp code at all (D-34).
    const phone = nextPhone();
    await query(ctx.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    await post('/v1/auth/otp/request', { phone });
    const code = await latestCode(ctx.otpQueue, phone);
    expect((await post('/v1/admin/auth/otp/verify', { phone, code })).statusCode).toBe(404);
    expect((await post('/v1/admin/auth/password/login', { phone, password: code ?? 'x' })).json().error.code).toBe('CREDENTIALS_INVALID');

    const office = await admin();
    const asStudent = await app.inject({ method: 'GET', url: '/v1/me', headers: { ...sameOriginRead, cookie: office.cookie } });
    expect(asStudent.statusCode).toBe(401);
  });

  it('answers only requests that came through the edge, except the health checks', async () => {
    const account = await student();
    for (const secret of [undefined, 'wrong', EDGE_SECRET.slice(0, -2)]) {
      const headers = { ...sameOriginRead, authorization: `Bearer ${account.accessToken}`, 'x-bedo-edge-secret': secret ?? '' };
      if (secret === undefined) delete (headers as Record<string, string>)['x-bedo-edge-secret'];
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers });
      expect(me.statusCode, String(secret)).toBe(403);
      expect(me.json().error.code).toBe('FORBIDDEN');
    }
    const direct = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: nextPhone() }, remoteAddress: nextIp() });
    expect(direct.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { ...sameOriginRead, authorization: `Bearer ${account.accessToken}` } })).statusCode).toBe(200);
    for (const url of ['/health/live', '/health/ready']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(200);
    }
  });

  it('counts per-IP code limits against the visitor, not the edge or the load balancer', async () => {
    const phone = nextPhone();
    // Load balancer (socket) <- Worker (appended by the load balancer) <- visitor (set by the Worker).
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { phone },
      remoteAddress: '10.0.0.1',
      headers: { ...sameOriginWrite, 'x-forwarded-for': '198.51.100.7, 172.70.1.1' },
    });
    expect(response.statusCode).toBe(200);
    const events = await query<{ ip: string }>(ctx.ownerUrl, "select host(ip) as ip from audit.security_events where phone = $1 and event like 'otp_requested%'", [phone]);
    expect(events.rows).toEqual([{ ip: '198.51.100.7' }]);
  });
});
