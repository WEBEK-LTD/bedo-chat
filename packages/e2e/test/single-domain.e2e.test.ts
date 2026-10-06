import { createHash } from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD,
  ADMIN_URL,
  API_URL,
  createAdmin,
  NETLIFY_SITE_URL,
  query,
  SITE_URL,
  type Stack,
  startEdge,
  startStack,
  totpNow,
  waitForCode,
  WEB_URL,
} from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);
const executablePath = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const STUDENT = '+201000002001';
const ADMIN = '+201000002901';

/**
 * D-25 in a real browser: student app at /, Admin Dashboard at /admin, API at /api, all on one origin
 * behind an edge that routes exactly like the production Cloudflare Worker.
 */
describe.runIf(enabled)('one public domain: /, /login, /admin, /admin/login, /api (D-25)', () => {
  let stack: Stack;
  let browser: Browser;
  const contexts: BrowserContext[] = [];

  async function newContext(): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    contexts.push(context);
    return { context, page: await context.newPage() };
  }

  beforeAll(async () => {
    stack = await startStack();
    browser = await chromium.launch({ executablePath, headless: true });
    await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [STUDENT]);
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('routes each public path to the right application', async () => {
    const html = async (path: string) => {
      const response = await fetch(`${SITE_URL}${path}`, { redirect: 'manual' });
      return { status: response.status, body: await response.text() };
    };
    const login = await html('/login');
    expect(login.status).toBe(200);
    expect(login.body).toContain('<title>Sign in · Bedo Chat</title>');
    const root = await html('/');
    expect(root.status).toBe(200);
    expect(root.body).toContain('<title>Bedo Chat</title>');
    const adminLogin = await html('/admin/login');
    expect(adminLogin.status).toBe(200);
    expect(adminLogin.body).toContain('<title>Sign in · Bedo Chat Admin</title>');
    // The admin app's own files are served under /admin, separate from the student app's.
    expect(adminLogin.body).toMatch(/src="\/admin\/_next\/static\//);
    expect(login.body).not.toMatch(/src="\/admin\/_next\//);
    const admin = await html('/admin');
    expect(admin.status).toBe(200);
    expect(admin.body).toContain('<title>Bedo Chat Admin</title>');

    const ready = await fetch(`${API_URL}/health/ready`);
    expect(ready.status).toBe(200);
    expect((await ready.json()).status).toBe('ok');
    const me = await fetch(`${API_URL}/v1/me`);
    expect(me.status).toBe(401);
    expect((await me.json()).error.code).toBe('UNAUTHENTICATED');
    // The API host refuses requests that did not come through the edge (D-25 edge secret).
    const direct = await fetch('http://127.0.0.1:4100/v1/me');
    expect(direct.status).toBe(403);
    expect((await fetch('http://127.0.0.1:4100/health/live')).status).toBe(200);
    // Paths that look like other hosts never leave the configured origins.
    for (const path of ['//example.com/x', '/api//example.com/x', '/admin//example.com/x']) {
      const response = await fetch(`${SITE_URL}${path}`, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (location) expect(new URL(location, SITE_URL).origin, path).toBe(SITE_URL);
      expect(await response.text(), path).not.toContain('Example Domain');
    }
    // Look-alike paths belong to the student app, not to the admin app or the API.
    expect((await html('/administrator')).status).toBe(404);
    expect((await html('/apis')).status).toBe(404);
  });

  it('serves both applications from one Netlify site, with the Admin Dashboard under /admin (D-26)', async () => {
    const get = async (base: string, path: string) => {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' });
      const body = await response.text();
      return { status: response.status, headers: response.headers, body, title: /<title>([^<]*)<\/title>/.exec(body)?.[1] };
    };
    // The same answers through the public domain and from the Netlify site itself: one site, one deploy.
    for (const base of [SITE_URL, NETLIFY_SITE_URL]) {
      expect(await get(base, '/'), `${base}/`).toMatchObject({ status: 200, title: 'Bedo Chat' });
      expect(await get(base, '/login'), `${base}/login`).toMatchObject({ status: 200, title: 'Sign in · Bedo Chat' });
      expect(await get(base, '/admin'), `${base}/admin`).toMatchObject({ status: 200, title: 'Bedo Chat Admin' });
      expect(await get(base, '/admin/'), `${base}/admin/`).toMatchObject({ status: 200, title: 'Bedo Chat Admin' });
      expect(await get(base, '/admin/login'), `${base}/admin/login`).toMatchObject({ status: 200, title: 'Sign in · Bedo Chat Admin' });
      const sw = await get(base, '/sw.js');
      expect(sw.status).toBe(200);
      expect(sw.body).toContain('Bedo Chat service worker');
      // Unknown admin paths are not mapped to an admin page (no catch-all).
      expect((await get(base, '/admin/unknown')).status).toBe(404);
    }

    // Admin pages keep the Admin Dashboard's own security headers; student pages keep theirs.
    for (const path of ['/admin', '/admin/login']) {
      const { headers } = await get(SITE_URL, path);
      expect(headers.get('x-frame-options'), path).toBe('DENY');
      expect(headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(headers.get('referrer-policy'), path).toBe('strict-origin-when-cross-origin');
      expect(headers.get('permissions-policy'), path).toBe('camera=(), microphone=(), display-capture=(), geolocation=()');
    }
    expect((await get(SITE_URL, '/login')).headers.get('permissions-policy')).toBe(
      'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
    );

    // Every admin script and style file resolves under /admin/_next/, from the admin build.
    const adminLogin = await get(SITE_URL, '/admin/login');
    const assets = [...adminLogin.body.matchAll(/(?:src|href)="(\/[^"]*_next\/static\/[^"]+)"/g)].map((match) => match[1]!);
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of new Set(assets)) {
      expect(asset.startsWith('/admin/_next/static/'), asset).toBe(true);
      const file = await get(SITE_URL, asset);
      expect(file.status, asset).toBe(200);
      expect(file.headers.get('x-frame-options'), asset).toBe('DENY');
    }
    // The page data the admin app fetches when it moves to its sign-in page or prefetches it.
    for (const path of ['/admin/login.txt', '/admin/__next._tree.txt', '/admin/login/__next._tree.txt']) {
      const data = await get(SITE_URL, path);
      expect(data.status, path).toBe(200);
      expect(data.headers.get('x-frame-options'), path).toBe('DENY');
    }
  });

  it('opens /admin and /admin/login directly and after a reload', async () => {
    const { page } = await newContext();
    for (const path of ['/admin/login', '/admin']) {
      await page.goto(`${SITE_URL}${path}`);
      // Without an admin session the dashboard sends the visitor to its sign-in page.
      await page.waitForURL(`${ADMIN_URL}/login`);
      await page.getByLabel('Phone number').waitFor();
      expect(await page.title()).toBe('Sign in · Bedo Chat Admin');
      await page.reload();
      await page.getByLabel('Phone number').waitFor();
      expect(page.url()).toBe(`${ADMIN_URL}/login`);
      expect(await page.title()).toBe('Sign in · Bedo Chat Admin');
    }
  });

  it('signs a student in on /login, keeps the session in an /api-only cookie, and refreshes it', async () => {
    const { context, page } = await newContext();
    await page.goto(`${WEB_URL}/`);
    await page.waitForURL(`${WEB_URL}/login`);
    await page.getByLabel('Phone number').fill(STUDENT);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Verification code').fill(await waitForCode(stack, STUDENT));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Name').fill('Single Domain');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(`${WEB_URL}/`);
    await page.getByText('No chats yet.').waitFor();

    const cookies = await context.cookies(SITE_URL + '/api/v1/auth/refresh');
    const refresh = cookies.find((cookie) => cookie.name === 'bedo_refresh');
    expect(refresh).toMatchObject({ path: '/api/v1/auth', httpOnly: true, sameSite: 'Strict' });
    expect(await page.evaluate(() => document.cookie)).toBe('');

    const refreshed = await page.evaluate(async () => {
      const response = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'x-bedo-csrf': '1' }, credentials: 'include' });
      return { status: response.status, body: (await response.json()) as { status?: string } };
    });
    expect(refreshed).toMatchObject({ status: 200, body: { status: 'authenticated' } });
    await page.reload();
    await page.getByText('No chats yet.').waitFor();

    // A signed-in student is not an admin: /admin asks for admin sign-in, and the admin API refuses.
    await page.goto(`${ADMIN_URL}`);
    await page.waitForURL(`${ADMIN_URL}/login`);
    await page.getByRole('heading', { name: 'Bedo Chat Admin' }).waitFor();
    const adminCalls = await page.evaluate(async () => {
      const session = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'x-bedo-csrf': '1' } });
      const { accessToken } = (await session.json()) as { accessToken: string };
      const asCookie = await fetch('/api/v1/admin/phone-list', { headers: { 'x-bedo-csrf': '1' } });
      const asBearer = await fetch('/api/v1/admin/deletion-requests', { headers: { 'x-bedo-csrf': '1', authorization: `Bearer ${accessToken}` } });
      const change = await fetch('/api/v1/admin/phone-list', {
        method: 'POST',
        headers: { 'x-bedo-csrf': '1', 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ phone: '+201000002999' }),
      });
      return [asCookie.status, asBearer.status, change.status];
    });
    expect(adminCalls).toEqual([401, 401, 401]);
    expect((await query(stack.ownerUrl, "select 1 from app.academy_phone_list where phone = '+201000002999'")).rowCount).toBe(0);
  });

  it('signs an admin in on /admin/login, keeps the dashboard at /admin across reloads, and signs out', async () => {
    const secret = await createAdmin(stack, ADMIN, 'Single Domain Admin', 'super_admin');
    const { context, page } = await newContext();
    await page.goto(`${ADMIN_URL}`);
    await page.waitForURL(`${ADMIN_URL}/login`);
    await page.getByLabel('Phone number').fill(ADMIN);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Authenticator code').fill(totpNow(secret));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(`${ADMIN_URL}`);
    await page.getByRole('heading', { name: 'Academy phone list' }).waitFor();

    const cookie = (await context.cookies(SITE_URL + '/api/v1/admin/session')).find((entry) => entry.name === 'bedo_admin_session');
    expect(cookie).toMatchObject({ path: '/api/v1/admin', httpOnly: true, sameSite: 'Strict' });

    await page.reload();
    await page.getByRole('heading', { name: 'Academy phone list' }).waitFor();
    expect(page.url()).toBe(`${ADMIN_URL}`);
    // The admin session is no student session.
    expect(await page.evaluate(async () => (await fetch('/api/v1/me', { headers: { 'x-bedo-csrf': '1' } })).status)).toBe(401);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(`${ADMIN_URL}/login`);
    await page.goto(`${ADMIN_URL}`);
    await page.waitForURL(`${ADMIN_URL}/login`);
    const actions = await query<{ action: string }>(stack.ownerUrl, "select action from app.audit_log where actor_type = 'admin' order by id");
    expect(actions.rows.map((row) => row.action)).toEqual(expect.arrayContaining(['admin.signed_in', 'view.phone_list', 'admin.signed_out']));
  });
});

/** Minimal WebSocket server: echoes text frames and records the path it was asked for. */
function startEchoServer(): Promise<{ server: http.Server; port: number; paths: string[] }> {
  const paths: string[] = [];
  const server = http.createServer((_request, response) => response.writeHead(426).end());
  server.on('upgrade', (request: http.IncomingMessage, socket: net.Socket) => {
    paths.push(request.url ?? '');
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (frame: Buffer) => {
      const opcode = frame[0]! & 0x0f;
      if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      const length = frame[1]! & 0x7f;
      const mask = frame.subarray(2, 6);
      const text = Buffer.from(frame.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4]!)).toString();
      const reply = Buffer.from(`echo:${text}`);
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port, paths })),
  );
}

describe('WebSocket connections through /api (Phase 3 compatibility, D-25)', () => {
  it('passes a WebSocket upgrade on /api/* to the API origin with the prefix removed, in both directions', async () => {
    const echo = await startEchoServer();
    const edge = await startEdge(3110, {
      WEB_ORIGIN: 'http://127.0.0.1:9',
      ADMIN_ORIGIN: 'http://127.0.0.1:9',
      API_ORIGIN: `http://127.0.0.1:${echo.port}`,
    });
    try {
      const socket = new WebSocket('ws://127.0.0.1:3110/api/v1/realtime?client=web');
      const reply = await new Promise<string>((resolve, reject) => {
        socket.addEventListener('open', () => socket.send('ping'));
        socket.addEventListener('message', (event) => resolve(String(event.data)));
        socket.addEventListener('error', () => reject(new Error('WebSocket failed')));
        setTimeout(() => reject(new Error('timed out')), 5_000);
      });
      socket.close();
      expect(reply).toBe('echo:ping');
      expect(echo.paths).toEqual(['/v1/realtime?client=web']);
    } finally {
      edge.closeAllConnections();
      await new Promise((resolve) => edge.close(resolve));
      echo.server.closeAllConnections();
      await new Promise((resolve) => echo.server.close(resolve));
    }
  });
});
