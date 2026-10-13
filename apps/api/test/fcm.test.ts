import { generateKeyPairSync, verify } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FcmClient, fcmMessage, isFcmDeviceUrl, readServiceAccount } from '../src/delivery/fcm.js';

const DEVICE_TOKEN = 'dGVzdC10b2tlbg:APA91bH-' + 'x'.repeat(140);
const DEVICE = `https://fcm.googleapis.com/v1/bedochat-android/${DEVICE_TOKEN}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'bedo-chat-test',
  private_key_id: 'abc',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  client_email: 'firebase-adminsdk@bedo-chat-test.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('Android notifications through Firebase (D-58)', () => {
  let server: http.Server;
  let origin: string;
  const received: Received[] = [];
  let answer: { status: number; body?: string } = { status: 200, body: '{"name":"projects/bedo-chat-test/messages/1"}' };
  let tokenRequests = 0;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (body += chunk));
      request.on('end', () => {
        if (request.url === '/token') {
          tokenRequests += 1;
          received.push({ path: request.url, headers: request.headers, body });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ access_token: `access-${tokenRequests}`, expires_in: 3599, token_type: 'Bearer' }));
          return;
        }
        received.push({ path: request.url ?? '', headers: request.headers, body });
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body ?? '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    received.length = 0;
    answer = { status: 200, body: '{"name":"projects/bedo-chat-test/messages/1"}' };
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const client = (serviceAccount: string | undefined = ACCOUNT) => new FcmClient({ serviceAccount, tokenUrl: `${origin}/token`, origin });
  const sends = () => received.filter((item) => item.path !== '/token');

  it('recognises only the Android app’s device addresses, never Chrome’s Web Push addresses on the same host', () => {
    expect(isFcmDeviceUrl(DEVICE)).toBe(true);
    for (const url of [
      'https://fcm.googleapis.com/fcm/send/abc:APA91bHxyz', // Chrome Web Push
      'https://fcm.googleapis.com/wp/abc:APA91bHxyz', // Chrome Web Push (newer)
      `https://fcm.googleapis.com/v1/bedochat-android/${DEVICE_TOKEN}?x=1`,
      `https://fcm.googleapis.com:8443/v1/bedochat-android/${DEVICE_TOKEN}`,
      `http://fcm.googleapis.com/v1/bedochat-android/${DEVICE_TOKEN}`,
      `https://evil.example/v1/bedochat-android/${DEVICE_TOKEN}`,
      'https://fcm.googleapis.com/v1/bedochat-android/short',
      'https://fcm.googleapis.com/v1/bedochat-android/has%20space%20xxxxxxxxxxxxxxxxxxxxxx',
      'not a url',
    ]) {
      expect(isFcmDeviceUrl(url), url).toBe(false);
    }
  });

  it('reads the service account key file, also with escaped line breaks', () => {
    expect(readServiceAccount(ACCOUNT).projectId).toBe('bedo-chat-test');
    const escaped = ACCOUNT.replace(/\\n/g, '\\\\n');
    expect(readServiceAccount(escaped).clientEmail).toBe('firebase-adminsdk@bedo-chat-test.iam.gserviceaccount.com');
    expect(() => readServiceAccount('{"type":"authorized_user"}')).toThrow(/service account/);
    expect(() => readServiceAccount('not json')).toThrow();
  });

  it('sends a data message with the title, text, chat and link, signed with a token for the service account', async () => {
    const fcm = client();
    expect(fcm.enabled).toBe(true);
    await fcm.send(DEVICE, JSON.stringify({ title: 'Ana', body: 'Hello', tag: 'chat-1', url: '/?chat=1', badge: 3 }));
    const [tokenRequest] = received.filter((item) => item.path === '/token');
    const form = new URLSearchParams(tokenRequest!.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion')!.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claimSet = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as Record<string, unknown>;
    expect(claimSet.iss).toBe('firebase-adminsdk@bedo-chat-test.iam.gserviceaccount.com');
    expect(claimSet.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(claimSet.aud).toBe('https://oauth2.googleapis.com/token');
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);

    const [send] = sends();
    expect(send!.path).toBe('/v1/projects/bedo-chat-test/messages:send');
    expect(send!.headers.authorization).toMatch(/^Bearer access-\d+$/);
    expect(JSON.parse(send!.body)).toEqual({
      message: {
        token: DEVICE_TOKEN,
        data: { title: 'Ana', body: 'Hello', tag: 'chat-1', url: '/?chat=1', badge: '3' },
        android: { priority: 'HIGH', ttl: '3600s' },
      },
    });
  });

  it('reuses the access token, and gets a new one after a 401', async () => {
    const fcm = client();
    await fcm.send(DEVICE, '{"title":"a"}');
    await fcm.send(DEVICE, '{"title":"b"}');
    expect(received.filter((item) => item.path === '/token')).toHaveLength(1);
    answer = { status: 401, body: '{"error":{"status":"UNAUTHENTICATED"}}' };
    await expect(fcm.send(DEVICE, '{"title":"c"}')).rejects.toMatchObject({ statusCode: 401 });
    answer = { status: 200, body: '{}' };
    await fcm.send(DEVICE, '{"title":"d"}');
    expect(received.filter((item) => item.path === '/token')).toHaveLength(2);
  });

  it('reports tokens Firebase no longer knows as gone (410), and keeps the others', async () => {
    const fcm = client();
    for (const body of [
      '{"error":{"code":404,"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
      '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"The registration token is not a valid FCM registration token"}}',
    ]) {
      answer = { status: body.includes('404') ? 404 : 400, body };
      await expect(fcm.send(DEVICE, '{}')).rejects.toMatchObject({ statusCode: 410 });
    }
    answer = { status: 503, body: '{"error":{"status":"UNAVAILABLE"}}' };
    await expect(fcm.send(DEVICE, '{}')).rejects.toMatchObject({ statusCode: 503 });
    answer = { status: 400, body: '{"error":{"status":"INVALID_ARGUMENT","message":"Invalid JSON payload"}}' };
    await expect(fcm.send(DEVICE, '{}')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('sends nothing and fails nothing when the key is missing or unreadable', async () => {
    for (const serviceAccount of [undefined, '{"type":"service_account"}', 'garbage']) {
      const fcm = new FcmClient({ serviceAccount, tokenUrl: `${origin}/token`, origin });
      expect(fcm.enabled).toBe(false);
      await fcm.send(DEVICE, '{"title":"x"}');
    }
    expect(received).toHaveLength(0);
  });

  it('builds the message from any payload without failing', () => {
    expect(fcmMessage('t', {})).toEqual({ token: 't', data: { title: 'Bedo Chat', body: '', url: '/' }, android: { priority: 'HIGH', ttl: '3600s' } });
  });
});
