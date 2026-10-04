// Tests for the Cloudflare edge router (deploy/cloudflare/worker.js, D-25), run with a stand-in fetch.
/* global Request, Response */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, test } from 'node:test';
import worker, { destinationUrl, publicLocation, route } from '../deploy/cloudflare/worker.js';

const env = {
  WEB_ORIGIN: 'https://bedo-web.netlify.app',
  ADMIN_ORIGIN: 'https://bedo-admin.netlify.app',
  API_ORIGIN: 'https://bedo-api.example',
  EDGE_SECRET: randomBytes(32).toString('base64'),
};
const realFetch = globalThis.fetch;
let calls = [];

function stubFetch(respond = () => new Response('ok')) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('routes /, /login, /admin, /admin/login and /api to the right origin', () => {
  assert.deepEqual(route('/', env), { origin: env.WEB_ORIGIN, path: '/' });
  assert.deepEqual(route('/login', env), { origin: env.WEB_ORIGIN, path: '/login' });
  assert.deepEqual(route('/_next/static/app.js', env), { origin: env.WEB_ORIGIN, path: '/_next/static/app.js' });
  assert.deepEqual(route('/admin', env), { origin: env.ADMIN_ORIGIN, path: '/admin' });
  assert.deepEqual(route('/admin/login', env), { origin: env.ADMIN_ORIGIN, path: '/admin/login' });
  assert.deepEqual(route('/admin/_next/static/app.js', env), { origin: env.ADMIN_ORIGIN, path: '/admin/_next/static/app.js' });
  assert.deepEqual(route('/api', env), { origin: env.API_ORIGIN, path: '/' });
  assert.deepEqual(route('/api/v1/auth/refresh', env), { origin: env.API_ORIGIN, path: '/v1/auth/refresh' });
  // Look-alike paths are not admin or API paths.
  assert.deepEqual(route('/administrator', env), { origin: env.WEB_ORIGIN, path: '/administrator' });
  assert.deepEqual(route('/apis', env), { origin: env.WEB_ORIGIN, path: '/apis' });
});

test('never fetches from any host but the configured origin, whatever the path looks like', async () => {
  stubFetch();
  for (const path of ['//evil.example/pwn.html', '/\\evil.example/x', '/api//evil.example/x?a=1', '/api/\\evil.example/', '/admin//evil.example/x', '///evil.example']) {
    calls = [];
    await worker.fetch(new Request(`https://bedochat.com${path}`), env);
    assert.equal(calls.length, 1, path);
    const fetched = new URL(calls[0].url);
    assert.ok([env.WEB_ORIGIN, env.ADMIN_ORIGIN, env.API_ORIGIN].includes(fetched.origin), `${path} -> ${calls[0].url}`);
  }
  assert.equal(destinationUrl(env.WEB_ORIGIN, '//evil.example/x', '').origin, env.WEB_ORIGIN);
  assert.equal(destinationUrl(env.API_ORIGIN, '/v1/me', '?a=1').href, 'https://bedo-api.example/v1/me?a=1');
});

test('forwards method, body, query and browser headers; sets the client IP from Cloudflare and the edge secret for the API only', async () => {
  stubFetch();
  const request = new Request('https://bedochat.com/api/v1/admin/phone-list?search=%2B20', {
    method: 'POST',
    body: '{"phone":"+201000000001"}',
    headers: {
      origin: 'https://bedochat.com',
      'sec-fetch-site': 'same-origin',
      'x-bedo-csrf': '1',
      cookie: 'bedo_admin_session=abc',
      'x-forwarded-for': '6.6.6.6',
      'x-request-id': 'client-chosen',
      'x-bedo-edge-secret': 'forged',
      'cf-connecting-ip': '203.0.113.9',
      'content-type': 'application/json',
    },
  });
  await worker.fetch(request, env);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://bedo-api.example/v1/admin/phone-list?search=%2B20');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(await new Response(init.body).text(), '{"phone":"+201000000001"}');
  for (const [name, value] of [
    ['origin', 'https://bedochat.com'],
    ['sec-fetch-site', 'same-origin'],
    ['x-bedo-csrf', '1'],
    ['cookie', 'bedo_admin_session=abc'],
    ['x-forwarded-for', '203.0.113.9'],
    ['x-forwarded-host', 'bedochat.com'],
    ['x-forwarded-proto', 'https'],
    ['x-bedo-edge-secret', env.EDGE_SECRET],
    ['x-request-id', null],
  ]) {
    assert.equal(init.headers.get(name), value, name);
  }

  // The secret never goes to the Netlify sites, even if a client sends one.
  await worker.fetch(new Request('https://bedochat.com/admin/login', { headers: { 'x-bedo-edge-secret': 'forged' } }), env);
  await worker.fetch(new Request('https://bedochat.com/login'), env);
  assert.equal(calls[1].init.headers.get('x-bedo-edge-secret'), null);
  assert.equal(calls[2].init.headers.get('x-bedo-edge-secret'), null);
});

test('passes WebSocket upgrade requests to the API unchanged (Phase 3 realtime)', async () => {
  stubFetch(() => new Response(null, { status: 200, headers: { 'x-upgraded': 'yes' } }));
  const key = randomBytes(16).toString('base64');
  const request = new Request('https://bedochat.com/api/v1/realtime', {
    headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': key, 'sec-websocket-version': '13' },
  });
  const response = await worker.fetch(request, env);
  assert.equal(calls[0].url, 'https://bedo-api.example/v1/realtime');
  assert.equal(calls[0].init.headers.get('upgrade'), 'websocket');
  assert.equal(calls[0].init.headers.get('sec-websocket-key'), key);
  // The origin's response (101 with the socket on Cloudflare) is returned untouched.
  assert.equal(response.headers.get('x-upgraded'), 'yes');
});

test('keeps visitors on bedochat.com when an origin redirects to itself, and never invents other hosts', async () => {
  stubFetch((url) =>
    url.startsWith(env.ADMIN_ORIGIN)
      ? new Response(null, { status: 308, headers: { location: `${env.ADMIN_ORIGIN}/admin/login` } })
      : new Response(null, { status: 307, headers: { location: '/login' } }),
  );
  const admin = await worker.fetch(new Request('https://bedochat.com/admin/'), env);
  assert.equal(admin.headers.get('location'), 'https://bedochat.com/admin/login');
  const web = await worker.fetch(new Request('https://bedochat.com/'), env);
  assert.equal(web.headers.get('location'), 'https://bedochat.com/login');

  assert.equal(publicLocation('/v1/x?a=1', env.API_ORIGIN, 'https://bedochat.com', '/api'), 'https://bedochat.com/api/v1/x?a=1');
  // Look-alike hosts are other hosts: left exactly as they are, never turned into bedochat.com addresses.
  for (const location of [
    'https://bedo-web.netlify.app.evil.example/x',
    'https://bedo-web.netlify.app@evil.example/x',
    'https://evil.example/x',
  ]) {
    assert.equal(publicLocation(location, env.WEB_ORIGIN, 'https://bedochat.com', ''), location);
  }
});

test('refuses to run without its three origins and the edge secret', async () => {
  for (const partial of [{ WEB_ORIGIN: env.WEB_ORIGIN }, { ...env, EDGE_SECRET: '' }]) {
    const response = await worker.fetch(new Request('https://bedochat.com/'), partial);
    assert.equal(response.status, 500);
  }
});
