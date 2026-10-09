import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ApiEnv } from '@bedo/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseBroadcaster } from '../src/messaging/realtime-broadcaster.js';
import { verifyRealtimeToken } from '../src/messaging/realtime-token.js';
import { testEnv } from './helpers.js';

/** The real Supabase Realtime broadcast client against a local stand-in for its HTTP endpoint. */
describe('Supabase Realtime broadcast (D-36)', () => {
  let server: http.Server;
  let url: string;
  let status = 202;
  const requests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      request.on('end', () => {
        requests.push({ path: request.url ?? '', headers: request.headers, body: JSON.parse(raw) as unknown });
        response.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const env = (overrides: Record<string, string>): ApiEnv => testEnv(overrides);

  const JWT_SECRET = 'project-jwt-secret-for-tests-0123456789abcdef';

  it('posts private-channel broadcasts with the service key, which never reaches the browser', async () => {
    const broadcaster = new SupabaseBroadcaster(
      env({ SUPABASE_URL: `${url}/`, SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests', SUPABASE_ANON_KEY: 'anon-key-for-tests', SUPABASE_JWT_SECRET: JWT_SECRET }),
    );
    expect(broadcaster.enabled).toBe(true);
    expect(broadcaster.client).toEqual({ url, apiKey: 'anon-key-for-tests' });
    await broadcaster.send([{ topic: 'bedo-abc', event: 'signal', payload: { type: 'updates' } }]);
    expect(requests.at(-1)).toMatchObject({
      path: '/realtime/v1/api/broadcast',
      headers: { apikey: 'service-role-key-for-tests', authorization: 'Bearer service-role-key-for-tests', 'content-type': 'application/json' },
      body: { messages: [{ topic: 'bedo-abc', event: 'signal', payload: { type: 'updates' }, private: true }] },
    });
    // Large fan-outs are sent in batches of 100.
    requests.length = 0;
    await broadcaster.send(Array.from({ length: 250 }, (_, index) => ({ topic: `t${index}`, event: 'signal', payload: {} })));
    expect(requests.map((request) => (request.body as { messages: unknown[] }).messages.length)).toEqual([100, 100, 50]);
    status = 500;
    await expect(broadcaster.send([{ topic: 't', event: 'signal', payload: {} }])).rejects.toThrow('HTTP 500');
    status = 202;
  });

  it("signs each device's token with the project's JWT secret, for its one channel", () => {
    const broadcaster = new SupabaseBroadcaster(
      env({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests', SUPABASE_ANON_KEY: 'anon-key-for-tests', SUPABASE_JWT_SECRET: JWT_SECRET }),
    );
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    const token = broadcaster.deviceToken({ userId: '6f1c0e2a-0000-4000-8000-000000000001', topic: 'bedo-abc', expiresAt })!;
    const [head] = token.split('.');
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString('utf8'))).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(verifyRealtimeToken(JWT_SECRET, token)).toMatchObject({ role: 'authenticated', aud: 'authenticated', sub: '6f1c0e2a-0000-4000-8000-000000000001', bedo_topic: 'bedo-abc' });
    expect(verifyRealtimeToken('a-different-secret-0123456789abcdefghijkl', token)).toBeNull();
    // Expired tokens are refused.
    const old = broadcaster.deviceToken({ userId: 'u', topic: 'bedo-abc', expiresAt: new Date(Date.now() - 60 * 60_000) })!;
    expect(verifyRealtimeToken(JWT_SECRET, old)).toBeNull();
  });

  it('is off without the project URL, service key, public key and JWT secret (devices then poll)', async () => {
    for (const overrides of [{}, { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests' }] as Array<Record<string, string>>) {
      const broadcaster = new SupabaseBroadcaster(env(overrides));
      expect(broadcaster.enabled).toBe(false);
      expect(broadcaster.client).toBeNull();
      expect(broadcaster.deviceToken({ userId: 'u', topic: 't', expiresAt: new Date(Date.now() + 60_000) })).toBeNull();
      requests.length = 0;
      await broadcaster.send([{ topic: 't', event: 'signal', payload: {} }]);
      expect(requests).toEqual([]);
    }
  });
});
