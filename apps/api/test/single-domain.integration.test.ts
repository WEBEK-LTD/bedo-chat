import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ADMIN_SESSION_COOKIE, CSRF_HEADER, CSRF_HEADER_VALUE, REFRESH_COOKIE } from '@bedo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentStep, encryptSecret, generateTotpSecret, hotp } from '../src/admin/totp.js';
import { type ApiHandler, CLIENT_IP_HEADER, createApiHandler } from '../src/serverless.js';
import { ADMIN_TEST_PASSWORD, clearCooldown, type IntegrationEnv, issuePasswordSetup, latestCode, query, setupIntegrationEnv, startApp, TOTP_KEY } from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const SITE = 'https://bedochat.test';
let counter = 0;
const nextPhone = () => `+2015${String(Date.now() % 1e4).padStart(4, '0')}${String(++counter).padStart(4, '0')}`;
let ipCounter = 0;
const nextIp = () => `198.51.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

/** What a browser sends from a page on https://bedochat.test to https://bedochat.test/api (D-36). */
const sameOriginWrite = { origin: SITE, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE };
/** Same-origin GET: browsers send no Origin header, only Fetch Metadata. */
const sameOriginRead = { 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE };

function cookieFrom(response: Response, name: string): { value: string; header: string } | null {
  const header = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
  return header ? { value: header.slice(name.length + 1).split(';')[0]!, header } : null;
}

/**
 * D-36: the student web app, the Admin Dashboard and the API are ONE Netlify site (https://bedochat.com); the
 * website's /api route hands requests to the API in the same process (serverless.ts). These tests go through
 * exactly that handler, with public URLs, as Netlify delivers them: no edge router, no edge secret, no origin
 * list, no separate API host.
 */
describe.runIf(enabled)('one site: the API inside the website (D-36)', () => {
  let ctx: IntegrationEnv;
  let site: ApiHandler;
  const pending: Array<Promise<unknown>> = [];

  const call = (method: string, path: string, options: { body?: unknown; headers?: Record<string, string>; ip?: string; host?: string } = {}) =>
    site.handle(
      new Request(`${options.host ?? SITE}/api${path}`, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          [CLIENT_IP_HEADER]: options.ip ?? nextIp(),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
      { after: (work) => void pending.push(work()) },
    );
  const post = (path: string, body: unknown, headers: Record<string, string> = sameOriginWrite, ip?: string) => call('POST', path, { body, headers, ip });

  async function student() {
    const phone = nextPhone();
    await query(ctx.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    await clearCooldown(ctx, phone);
    await post('/v1/auth/otp/request', { phone });
    await Promise.all(pending.splice(0));
    const verified = await post('/v1/auth/otp/verify', { phone, code: await latestCode(ctx.waabek, phone) });
    const body = (await verified.json()) as { accessToken: string };
    const refresh = cookieFrom(verified, REFRESH_COOKIE)!;
    return { accessToken: body.accessToken, refresh: refresh.value, setCookie: refresh.header };
  }

  async function admin() {
    const phone = nextPhone();
    const secret = generateTotpSecret();
    await query(ctx.ownerUrl, "insert into app.admin_accounts (phone, name, role, totp_secret_enc) values ($1, 'Office', 'super_admin', $2)", [
      phone,
      encryptSecret(TOTP_KEY, secret),
    ]);
    // D-34: the owner's setup token, the Set Password panel, then phone + password.
    const setupToken = await issuePasswordSetup(ctx.ownerUrl, phone);
    expect((await post('/v1/admin/auth/password/setup', { phone, setupToken, password: ADMIN_TEST_PASSWORD })).status).toBe(200);
    const login = await post('/v1/admin/auth/password/login', { phone, password: ADMIN_TEST_PASSWORD });
    expect(login.status).toBe(200);
    const session = await post('/v1/admin/auth/totp/verify', { pendingToken: ((await login.json()) as { pendingToken: string }).pendingToken, code: hotp(secret, currentStep(Date.now())) });
    expect(session.status).toBe(200);
    const cookie = cookieFrom(session, ADMIN_SESSION_COOKIE)!;
    return { cookie: `${ADMIN_SESSION_COOKIE}=${cookie.value}`, setCookie: cookie.header };
  }

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    site = createApiHandler(ctx.env as unknown as Record<string, string>, (): Promise<NestFastifyApplication> => startApp(ctx.env));
  });

  afterAll(async () => {
    await Promise.allSettled(pending);
    await site?.close();
    await ctx?.teardown();
  });

  it('serves the API at /api on the site itself, with nothing else to configure', async () => {
    const ready = await call('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ok', checks: { database: { status: 'up' } } });
    for (const name of ['API_ORIGIN', 'EDGE_SECRET', 'REDIS_URL', 'CORS_ALLOWED_ORIGINS', 'ADMIN_ORIGINS', 'WEB_ORIGINS', 'API_PUBLIC_PATH', 'API_TRUST_PROXY_HOPS']) {
      expect(name in ctx.env, name).toBe(false);
    }
    // A request with no edge secret or proxy header is answered: there is no separate API host to protect.
    expect((await call('POST', '/v1/auth/otp/request', { body: { phone: nextPhone() } })).status).toBe(200);
  });

  it('scopes both session cookies under /api so the browser sends them only to the API', async () => {
    const account = await student();
    expect(account.setCookie).toMatch(/; Path=\/api\/v1\/auth(;|$)/);
    expect(account.setCookie).toMatch(/HttpOnly/);
    expect(account.setCookie).toMatch(/SameSite=Strict/);
    const office = await admin();
    expect(office.setCookie).toMatch(/; Path=\/api\/v1\/admin(;|$)/);
  });

  it('refreshes and signs out a student from the site, and rejects cross-site, foreign-host or header-less attempts', async () => {
    const account = await student();
    const refresh = (headers: Record<string, string>, token: string, host?: string) =>
      call('POST', '/v1/auth/refresh', { headers: { ...headers, cookie: `${REFRESH_COOKIE}=${token}` }, host });

    const rotated = await refresh(sameOriginWrite, account.refresh);
    expect(rotated.status).toBe(200);
    const next = cookieFrom(rotated, REFRESH_COOKIE)!.value;

    for (const headers of <Array<Record<string, string>>>[
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      { 'sec-fetch-site': 'cross-site', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      { [CSRF_HEADER]: CSRF_HEADER_VALUE },
      { origin: SITE, 'sec-fetch-site': 'same-origin' },
      // Over HTTPS, a plain-http page on the same host does not count as the site.
      { origin: 'http://bedochat.test', 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      // A client cannot claim the scheme itself.
      { origin: 'http://bedochat.test', 'x-forwarded-proto': 'http', [CSRF_HEADER]: CSRF_HEADER_VALUE },
    ]) {
      expect(((await (await refresh(headers, next)).json()) as { error: { code: string } }).error.code).toBe('CSRF_REJECTED');
    }
    // The page's origin must be the host the request was sent to: bedochat.test's page cannot call another site's API.
    expect(((await (await refresh(sameOriginWrite, next, 'https://other.example')).json()) as { error: { code: string } }).error.code).toBe('CSRF_REJECTED');
    const out = await call('POST', '/v1/auth/logout', { headers: { ...sameOriginWrite, cookie: `${REFRESH_COOKIE}=${next}` } });
    expect(out.status).toBe(200);
    expect(((await (await refresh(sameOriginWrite, next)).json()) as { error: { code: string } }).error.code).toBe('SESSION_INVALID');
  });

  it('serves the admin session to same-origin reads and refuses cross-site ones', async () => {
    const office = await admin();
    const read = async (headers: Record<string, string>) => (await call('GET', '/v1/admin/session', { headers: { ...headers, cookie: office.cookie } })).json() as Promise<Record<string, { code?: string; role?: string }>>;
    expect((await read(sameOriginRead)).admin!.role).toBe('super_admin');
    expect((await read({ 'sec-fetch-site': 'cross-site', [CSRF_HEADER]: CSRF_HEADER_VALUE })).error!.code).toBe('CSRF_REJECTED');
    expect((await read({ origin: 'https://evil.example', [CSRF_HEADER]: CSRF_HEADER_VALUE })).error!.code).toBe('CSRF_REJECTED');
    expect((await read({ 'sec-fetch-site': 'same-origin' })).error!.code).toBe('CSRF_REJECTED');
    expect((await call('GET', '/v1/admin/phone-list', { headers: { ...sameOriginRead, cookie: office.cookie } })).status).toBe(200);
  });

  it('never lets a student session reach admin functions, or an admin session reach student routes', async () => {
    const account = await student();
    const studentCredentials = { ...sameOriginRead, authorization: `Bearer ${account.accessToken}`, cookie: `${REFRESH_COOKIE}=${account.refresh}` };
    for (const url of ['/v1/admin/session', '/v1/admin/phone-list', '/v1/admin/deletion-requests']) {
      expect((await call('GET', url, { headers: studentCredentials })).status, url).toBe(401);
    }
    for (const [url, body] of [
      ['/v1/admin/phone-list', { phone: nextPhone() }],
      ['/v1/admin/users/two-step-reset', { phone: nextPhone(), reason: 'not an admin' }],
    ] as const) {
      expect((await call('POST', url, { body, headers: { ...studentCredentials, origin: SITE } })).status, url).toBe(401);
    }
    const office = await admin();
    expect((await call('GET', '/v1/me', { headers: { ...sameOriginRead, cookie: office.cookie } })).status).toBe(401);
  });

  it("counts per-address code limits against Netlify's client address, never a header the client chose", async () => {
    const phone = nextPhone();
    const response = await call('POST', '/v1/auth/otp/request', {
      body: { phone },
      ip: '203.0.113.7',
      headers: { 'x-forwarded-for': '192.0.2.99', 'x-real-ip': '192.0.2.98' },
    });
    expect(response.status).toBe(200);
    const events = await query<{ ip: string }>(ctx.ownerUrl, "select host(ip) as ip from audit.security_events where phone = $1 and event like 'otp_requested%'", [phone]);
    expect(events.rows).toEqual([{ ip: '203.0.113.7' }]);
    expect((await query(ctx.ownerUrl, "select 1 from app.rate_events where bucket = 'otp-ip:203.0.113.7'")).rowCount).toBe(1);
    // A malformed address is never trusted: such requests share one budget.
    const other = nextPhone();
    await call('POST', '/v1/auth/otp/request', { body: { phone: other }, ip: 'not-an-ip' });
    const unknown = await query<{ ip: string }>(ctx.ownerUrl, "select host(ip) as ip from audit.security_events where phone = $1 and event like 'otp_requested%'", [other]);
    expect(unknown.rows).toEqual([{ ip: '0.0.0.0' }]);
  });

  it('delivers the sign-in code right after the response, through the platform keeping the work alive', async () => {
    const phone = nextPhone();
    await query(ctx.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    pending.length = 0;
    const response = await post('/v1/auth/otp/request', { phone });
    expect(response.status).toBe(200);
    // The code is sent after the response, in work handed to the platform (Next.js after(), Netlify waitUntil).
    expect(pending.length).toBeGreaterThan(0);
    await Promise.all(pending.splice(0));
    expect(await latestCode(ctx.waabek, phone)).toMatch(/^\d{6}$/);
    // A number that may not sign in gets the same answer and no message.
    const outsider = nextPhone();
    expect((await post('/v1/auth/otp/request', { phone: outsider })).status).toBe(200);
    await Promise.all(pending.splice(0));
    expect(await latestCode(ctx.waabek, outsider)).toBeNull();
  });
});
