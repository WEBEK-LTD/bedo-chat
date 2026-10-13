import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApnsClient, apnsPayload, isApnsDeviceUrl, readApnsKey } from '../src/delivery/apns.js';

const TOKEN = 'a'.repeat(64);
const DEVICE = `https://api.push.apple.com/3/device/${TOKEN}`;
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

interface Received {
  headers: http2.IncomingHttpHeaders;
  body: string;
}

describe('iPhone notifications through APNs (D-53)', () => {
  let server: http2.Http2Server;
  let origin: string;
  const received: Received[] = [];
  let answer: { status: number; body?: string } = { status: 200 };
  const clients: ApnsClient[] = [];

  beforeAll(async () => {
    server = http2.createServer();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => (body += chunk));
      stream.on('end', () => {
        received.push({ headers, body });
        stream.respond({ ':status': answer.status, 'content-type': 'application/json' });
        stream.end(answer.body ?? '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    received.length = 0;
    answer = { status: 200 };
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const client = (overrides: Partial<ConstructorParameters<typeof ApnsClient>[0]> = {}) => {
    const made = new ApnsClient({ key: P8, keyId: 'ABCDE12345', teamId: 'TEAM123456', bundleId: 'com.bedochat.app', origin, ...overrides });
    clients.push(made);
    return made;
  };

  it('recognises only the iPhone app’s device addresses', () => {
    expect(isApnsDeviceUrl(DEVICE)).toBe(true);
    expect(isApnsDeviceUrl(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`)).toBe(true);
    for (const url of [
      'https://web.push.apple.com/QGx2abc', // Safari Web Push
      `https://api.push.apple.com/3/device/${TOKEN}?x=1`,
      `https://api.push.apple.com:443/3/device/${'g'.repeat(64)}`,
      `https://api.push.apple.com/3/device/short`,
      `http://api.push.apple.com/3/device/${TOKEN}`,
      `https://api.push.apple.com.evil.example/3/device/${TOKEN}`,
      'https://fcm.googleapis.com/fcm/send/abc',
    ]) {
      expect(isApnsDeviceUrl(url), url).toBe(false);
    }
  });

  it('reads the .p8 key however it was pasted', () => {
    const body = P8.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    for (const pasted of [P8, P8.replace(/\n/g, '\\n'), body, `  ${P8.replace(/\n/g, ' ')}  `]) {
      expect(readApnsKey(pasted).asymmetricKeyType).toBe('ec');
    }
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => readApnsKey(rsa)).toThrow(/Apple push key/);
  });

  it('sends the title, text, badge, chat grouping and link, signed with the key', async () => {
    const apns = client();
    expect(apns.enabled).toBe(true);
    await apns.send(DEVICE, JSON.stringify({ title: 'Ben Carter', body: 'See you at nine', tag: 'chat:1', url: '/?chat=1', badge: 3 }));
    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(headers['apns-topic']).toBe('com.bedochat.app');
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-collapse-id']).toBe('chat:1');
    expect(JSON.parse(body)).toEqual({
      aps: { alert: { title: 'Ben Carter', body: 'See you at nine' }, sound: 'default', badge: 3, 'thread-id': 'chat:1' },
      url: '/?chat=1',
    });
    // The provider token: ES256 over header.claims with the team and key IDs, verifiable with the key's public half.
    const [header, claims, signature] = String(headers.authorization).replace(/^bearer /, '').split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABCDE12345' });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({ iss: 'TEAM123456' });
    const ok = verify('sha256', Buffer.from(`${header}.${claims}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'));
    expect(ok).toBe(true);

    // The token is reused rather than made for every notification.
    await apns.send(DEVICE, JSON.stringify({ title: 'x', body: 'y' }));
    expect(received[1]!.headers.authorization).toBe(headers.authorization);
  });

  it('reports a device Apple says is gone as 410, so its address is removed', async () => {
    const apns = client();
    for (const [status, reason] of [
      [410, 'Unregistered'],
      [400, 'BadDeviceToken'],
      [400, 'DeviceTokenNotForTopic'],
    ] as const) {
      answer = { status, body: JSON.stringify({ reason }) };
      await expect(apns.send(DEVICE, '{}')).rejects.toMatchObject({ statusCode: 410, reason });
    }
    // Other refusals keep the address.
    answer = { status: 429, body: JSON.stringify({ reason: 'TooManyRequests' }) };
    await expect(apns.send(DEVICE, '{}')).rejects.toMatchObject({ statusCode: 429 });
  });

  it('sends nothing, and keeps working, when the key is missing or wrong', async () => {
    for (const apns of [client({ key: undefined, keyId: undefined, teamId: undefined }), client({ teamId: undefined }), client({ key: 'not a key' }), client({ keyId: 'short' })]) {
      expect(apns.enabled).toBe(false);
      await apns.send(DEVICE, '{}');
    }
    expect(received).toHaveLength(0);
  });

  it('turns a notification without fields into a plain Bedo Chat alert', () => {
    expect(apnsPayload({})).toEqual({ aps: { alert: { title: 'Bedo Chat', body: '' }, sound: 'default' }, url: '/' });
  });
});
