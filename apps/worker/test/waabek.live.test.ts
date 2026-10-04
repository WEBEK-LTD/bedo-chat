import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { loadEnv, workerEnvSchema } from '@bedo/config';
import { otpMessage } from '@bedo/contracts';
import { describe, expect, it } from 'vitest';
import { WaabekClient } from '../src/otp/waabek.client.js';

/**
 * Sends ONE real WhatsApp message through Waabek with the production client. Runs only when both
 * WAABEK_API_KEY (server environment, never committed) and WAABEK_LIVE_TEST_PHONE are set:
 *
 *   WAABEK_API_KEY=... WAABEK_LIVE_TEST_PHONE=+2010XXXXXXXX pnpm --filter @bedo/worker test:live
 *
 * Nothing about the key is printed; the test only reports success or the HTTP status.
 */
const phone = process.env.WAABEK_LIVE_TEST_PHONE;
const enabled = Boolean(process.env.WAABEK_API_KEY && phone);

describe.runIf(enabled)('Waabek live delivery', () => {
  it('delivers a verification-code message to the test phone', async () => {
    expect(phone).toMatch(/^\+[1-9]\d{6,14}$/);
    const env = loadEnv(workerEnvSchema, {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://unused:6379',
      DATABASE_URL: 'postgresql://unused:unused@unused:5432/unused',
      OTP_DELIVERY: 'waabek',
      WAABEK_API_KEY: process.env.WAABEK_API_KEY,
      ...(process.env.WAABEK_API_URL ? { WAABEK_API_URL: process.env.WAABEK_API_URL } : {}),
    });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await new WaabekClient(env).send(phone!, otpMessage(code));
  });
});

describe.runIf(!enabled)('Waabek live delivery', () => {
  it.skip('skipped: set WAABEK_API_KEY and WAABEK_LIVE_TEST_PHONE to send one real message', () => undefined);
});
