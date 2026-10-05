import 'reflect-metadata';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorkerEnv } from '@bedo/config';
import { OTP_DELIVERY_ERRORS, otpMessage, WAABEK_TEST_MESSAGE } from '@bedo/contracts';
import type { DbHandle } from '@bedo/db';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OtpProcessor } from '../src/otp/otp.processor.js';
import { WaabekClient, WaabekError } from '../src/otp/waabek.client.js';
import { OtpConfigurationError, type WaabekKeyProvider } from '../src/otp/waabek-key.provider.js';

// An obviously fake key: the real key is only ever set from the Admin Dashboard (D-32).
const FAKE_KEY = 'fake-waabek-key-for-unit-tests-0001';

interface Captured {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/**
 * The real client against a local HTTP server that behaves like the Waabek endpoint documented in the
 * specification (POST JSON {to, message} with an X-API-Key header). No real WhatsApp message is sent.
 */
describe('WaabekClient', () => {
  let server: Server;
  let url: string;
  let status = 200;
  const requests: Captured[] = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        requests.push({ method: request.method, url: request.url, headers: request.headers, body });
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        // Echo-style error bodies must never reach errors or logs.
        response.end(JSON.stringify(status === 200 ? { success: true } : { error: `bad key ${request.headers['x-api-key']}` }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/send`;
  });

  afterEach(() => {
    requests.length = 0;
    status = 200;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = () => new WaabekClient({ WAABEK_API_URL: url });

  it('sends exactly the documented request: X-API-Key header, JSON body, number without "+"', async () => {
    await client().send(FAKE_KEY, '+201234567890', otpMessage('123456'));
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/api/v1/send');
    expect(request?.headers['x-api-key']).toBe(FAKE_KEY);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request!.body)).toEqual({ to: '201234567890', message: 'Your Bedo Chat verification code is: 123456' });
  });

  it('reports HTTP failures with the status only, never the key, number, message or response body', async () => {
    status = 401;
    const error = await client()
      .send(FAKE_KEY, '+201234567890', otpMessage('654321'))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WaabekError);
    expect((error as WaabekError).status).toBe(401);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
    for (const secret of [FAKE_KEY, '201234567890', '654321', 'bad key']) {
      expect(text).not.toContain(secret);
    }
  });

  it('refuses to send without a key and reports network failures without details', async () => {
    await expect(client().send('', '+201234567890', 'x')).rejects.toThrow(/no API key/);
    expect(requests).toHaveLength(0);
    const unreachable = new WaabekClient({ WAABEK_API_URL: 'http://127.0.0.1:1/api/v1/send' });
    const error = await unreachable.send(FAKE_KEY, '+201234567890', 'x').catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('Waabek send failed: network error');
  });
});

describe('OtpProcessor', () => {
  const job = { phone: '+201234567890', code: '246810', purpose: 'sign_in' as const };

  function processor(env: Partial<WorkerEnv>) {
    const waabek = { send: vi.fn().mockResolvedValue(undefined) };
    const keys = { currentKey: vi.fn().mockResolvedValue(FAKE_KEY) };
    const redis = { set: vi.fn().mockResolvedValue('OK') };
    const inserted: unknown[] = [];
    const database = {
      db: {
        insertInto: () => ({ values: (row: unknown) => ({ execute: async () => inserted.push(row) }) }),
      },
    };
    const instance = new OtpProcessor(
      { QUEUE_PREFIX: 'bedo', ...env } as WorkerEnv,
      waabek as unknown as WaabekClient,
      redis as unknown as Redis,
      database as unknown as DbHandle,
      keys as unknown as WaabekKeyProvider,
    );
    return { instance, waabek, redis, inserted, keys };
  }

  it('delivers through Waabek with the specified message', async () => {
    const { instance, waabek, redis } = processor({ NODE_ENV: 'production', OTP_DELIVERY: 'waabek' });
    await instance.process(job);
    expect(waabek.send).toHaveBeenCalledWith(FAKE_KEY, '+201234567890', 'Your Bedo Chat verification code is: 246810');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('never uses the test code sender outside NODE_ENV=test, even if it were configured', async () => {
    const { instance, waabek, redis } = processor({ NODE_ENV: 'production', OTP_DELIVERY: 'test-capture' });
    await instance.process(job);
    expect(redis.set).not.toHaveBeenCalled();
    expect(waabek.send).toHaveBeenCalledTimes(1);
  });

  it('sends the Admin Dashboard test message through the same key and client', async () => {
    const { instance, waabek, keys } = processor({ NODE_ENV: 'production', OTP_DELIVERY: 'waabek' });
    expect(await instance.processTest({ phone: '+201234567890' })).toEqual({ delivered: true });
    expect(keys.currentKey).toHaveBeenCalledTimes(1);
    expect(waabek.send).toHaveBeenCalledWith(FAKE_KEY, '+201234567890', WAABEK_TEST_MESSAGE);
  });

  it('does not send when the settings cannot be used', async () => {
    const { instance, waabek, keys } = processor({ NODE_ENV: 'production', OTP_DELIVERY: 'waabek' });
    keys.currentKey.mockRejectedValue(new OtpConfigurationError(OTP_DELIVERY_ERRORS.notConfigured));
    await expect(instance.process(job)).rejects.toThrow(OTP_DELIVERY_ERRORS.notConfigured);
    await expect(instance.processTest({ phone: '+201234567890' })).rejects.toThrow(OTP_DELIVERY_ERRORS.notConfigured);
    expect(waabek.send).not.toHaveBeenCalled();
  });

  it('captures the code only in automated tests', async () => {
    const { instance, waabek, redis, keys } = processor({ NODE_ENV: 'test', OTP_DELIVERY: 'test-capture' });
    await instance.process(job);
    expect(keys.currentKey).not.toHaveBeenCalled();
    expect(waabek.send).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('+201234567890'), '246810', 'EX', 300);
  });

  it('rejects malformed jobs', async () => {
    const { instance, waabek } = processor({ NODE_ENV: 'production', OTP_DELIVERY: 'waabek' });
    await expect(instance.process({ phone: '+201234567890', code: '12', purpose: 'sign_in' })).rejects.toThrow();
    expect(waabek.send).not.toHaveBeenCalled();
  });

  it('records a final delivery failure in the audit history without the code', async () => {
    const { instance, inserted } = processor({ NODE_ENV: 'production', OTP_DELIVERY: 'waabek' });
    await instance.onFinalFailure(job, new WaabekError(500, 'HTTP 500'));
    expect(inserted).toEqual([
      {
        subject_type: 'phone',
        subject_id: null,
        phone: '+201234567890',
        event: 'otp_delivery_failed',
        details: { purpose: 'sign_in', error: 'Waabek send failed: HTTP 500' },
      },
    ]);
    expect(JSON.stringify(inserted)).not.toContain('246810');
  });
});
