import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { otpMessage } from '@bedo/contracts';
import { describe, expect, it } from 'vitest';
import { WaabekClient } from '../src/otp/waabek.client.js';

/**
 * Sends ONE real WhatsApp message through Waabek with the production client. A manual developer check,
 * not part of any deployment: the services take the key from the Admin Dashboard (D-32). Runs only when
 * WAABEK_LIVE_TEST_KEY and WAABEK_LIVE_TEST_PHONE are set in the shell running it (never committed):
 *
 *   WAABEK_LIVE_TEST_KEY=... WAABEK_LIVE_TEST_PHONE=+2010XXXXXXXX pnpm --filter @bedo/worker test:live
 *
 * Nothing about the key is printed; the test only reports success or the HTTP status. The Admin
 * Dashboard's "Send test message" does the same check against the stored key.
 */
const phone = process.env.WAABEK_LIVE_TEST_PHONE;
const key = process.env.WAABEK_LIVE_TEST_KEY;
const enabled = Boolean(key && phone);

describe.runIf(enabled)('Waabek live delivery', () => {
  it('delivers a verification-code message to the test phone', async () => {
    expect(phone).toMatch(/^\+[1-9]\d{6,14}$/);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await new WaabekClient({ WAABEK_API_URL: process.env.WAABEK_API_URL ?? 'https://waabek.com/api/v1/send' }).send(key!, phone!, otpMessage(code));
  });
});

describe.runIf(!enabled)('Waabek live delivery', () => {
  it.skip('skipped: set WAABEK_LIVE_TEST_KEY and WAABEK_LIVE_TEST_PHONE to send one real message', () => undefined);
});
