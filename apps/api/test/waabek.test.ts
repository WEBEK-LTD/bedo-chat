import 'reflect-metadata';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OTP_DELIVERY_ERRORS, otpMessage, WAABEK_TEST_MESSAGE } from '@bedo/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../src/audit/audit.service.js';
import type { DatabaseService } from '../src/database/database.service.js';
import { OtpDeliveryService } from '../src/delivery/otp-delivery.service.js';
import { WaabekClient, WaabekError, type WaabekSender } from '../src/delivery/waabek.client.js';
import { OtpConfigurationError, type WaabekKeyProvider } from '../src/delivery/waabek-key.provider.js';
import { DeferredTasks } from '../src/runtime/deferred-tasks.service.js';

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
  let delayMs = 0;
  const requests: Captured[] = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        requests.push({ method: request.method, url: request.url, headers: request.headers, body });
        setTimeout(() => {
          response.statusCode = status;
          response.setHeader('content-type', 'application/json');
          // Echo-style error bodies must never reach errors or logs.
          response.end(JSON.stringify(status === 200 ? { success: true } : { error: `bad key ${request.headers['x-api-key']}` }));
        }, delayMs);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/send`;
  });

  afterEach(() => {
    requests.length = 0;
    status = 200;
    delayMs = 0;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = () => new WaabekClient({ WAABEK_API_URL: url });

  it('sends exactly the documented request: X-API-Key header, JSON body, number without "+"', async () => {
    await client().send(FAKE_KEY, '+201234567890', otpMessage('123456'), 5_000);
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
      .send(FAKE_KEY, '+201234567890', otpMessage('654321'), 5_000)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WaabekError);
    expect((error as WaabekError).status).toBe(401);
    expect((error as WaabekError).retryable).toBe(false);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
    for (const secret of [FAKE_KEY, '201234567890', '654321', 'bad key']) {
      expect(text).not.toContain(secret);
    }
    status = 503;
    expect(((await client().send(FAKE_KEY, '+201234567890', 'x', 5_000).catch((caught: unknown) => caught)) as WaabekError).retryable).toBe(true);
  });

  it('refuses to send without a key and reports network failures and timeouts without details', async () => {
    await expect(client().send('', '+201234567890', 'x', 5_000)).rejects.toThrow(/no API key/);
    expect(requests).toHaveLength(0);
    const unreachable = new WaabekClient({ WAABEK_API_URL: 'http://127.0.0.1:1/api/v1/send' });
    const error = await unreachable.send(FAKE_KEY, '+201234567890', 'x', 5_000).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('Waabek send failed: network error');
    delayMs = 500;
    const slow = await client().send(FAKE_KEY, '+201234567890', 'x', 100).catch((caught: unknown) => caught);
    expect((slow as Error).message).toBe('Waabek send failed: timed out');
  });
});

/** WhatsApp delivery inside the API (D-36): codes after the response, test messages while the admin waits. */
describe('OtpDeliveryService', () => {
  function service(options: { failures?: Error[]; key?: () => Promise<string> } = {}) {
    const failures = [...(options.failures ?? [])];
    const sent: Array<{ apiKey: string; phone: string; text: string }> = [];
    const sender: WaabekSender = {
      send: vi.fn(async (apiKey: string, phone: string, text: string) => {
        const failure = failures.shift();
        if (failure) throw failure;
        sent.push({ apiKey, phone, text });
      }),
    };
    const keys = { currentKey: vi.fn(options.key ?? (async () => FAKE_KEY)) } as unknown as WaabekKeyProvider;
    const recorded: unknown[] = [];
    const audit = { security: vi.fn(async (_db: unknown, input: unknown) => void recorded.push(input)) } as unknown as AuditService;
    const deferred = new DeferredTasks();
    const instance = new OtpDeliveryService(sender, keys, deferred, { db: {} } as unknown as DatabaseService, audit);
    return { instance, sent, recorded, deferred, sender };
  }

  it('sends a code after the request, with the specified message and the stored key', async () => {
    const { instance, sent, deferred } = service();
    const { background } = await deferred.runRequest(async () => instance.sendCode('+201234567890', '246810', 'sign_in'));
    // Nothing is sent before the response; the work is handed to the platform.
    expect(sent).toEqual([]);
    await background!();
    expect(sent).toEqual([{ apiKey: FAKE_KEY, phone: '+201234567890', text: 'Your Bedo Chat verification code is: 246810' }]);
  });

  it('tries once more after a temporary failure, and records a final failure without the code', async () => {
    const retried = service({ failures: [new WaabekError(503, 'HTTP 503', true)] });
    await (await retried.deferred.runRequest(async () => retried.instance.sendCode('+201234567890', '135790', 'sign_in'))).background!();
    expect(retried.sent).toHaveLength(1);
    expect(retried.recorded).toEqual([]);

    const refused = service({ failures: [new WaabekError(401, 'HTTP 401', false)] });
    await (await refused.deferred.runRequest(async () => refused.instance.sendCode('+201234567890', '246810', 'change_phone'))).background!();
    expect(refused.sender.send).toHaveBeenCalledTimes(1);
    expect(refused.recorded).toEqual([
      { subjectType: 'phone', subjectId: null, phone: '+201234567890', event: 'otp_delivery_failed', details: { purpose: 'change_phone', error: 'Waabek send failed: HTTP 401' } },
    ]);
    expect(JSON.stringify(refused.recorded)).not.toContain('246810');
  });

  it('does not send when the settings cannot be used', async () => {
    const { instance, sender, recorded, deferred } = service({
      key: async () => {
        throw new OtpConfigurationError(OTP_DELIVERY_ERRORS.notConfigured);
      },
    });
    await (await deferred.runRequest(async () => instance.sendCode('+201234567890', '246810', 'sign_in'))).background!();
    expect(sender.send).not.toHaveBeenCalled();
    expect(recorded).toMatchObject([{ event: 'otp_delivery_failed', details: { error: OTP_DELIVERY_ERRORS.notConfigured } }]);
    expect(await instance.sendTest('+201234567890')).toEqual({ delivered: false, reason: 'not_configured', httpStatus: null });
  });

  it('sends the Admin Dashboard test message through the same key and client, while the admin waits', async () => {
    const { instance, sent } = service();
    expect(await instance.sendTest('+201234567890')).toEqual({ delivered: true });
    expect(sent).toEqual([{ apiKey: FAKE_KEY, phone: '+201234567890', text: WAABEK_TEST_MESSAGE }]);
    const failing = service({ failures: [new WaabekError(401, 'HTTP 401', false)] });
    expect(await failing.instance.sendTest('+201234567890')).toEqual({ delivered: false, reason: 'rejected', httpStatus: 401 });
  });
});
