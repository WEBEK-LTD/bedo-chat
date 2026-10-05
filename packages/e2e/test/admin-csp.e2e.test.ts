import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_CSP } from '../../../apps/web/csp.mjs';
import { ADMIN_URL, hotp, query, type Stack, startStack, waitForCode } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);
const executablePath = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const PHONE = '+201000003901';

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/\s+/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Every CSP violation is also reported through the page's console, where the test collects it. */
async function reportViolations(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      // eslint-disable-next-line no-console
      console.error(`Refused to load (CSP ${event.violatedDirective}): ${event.blockedURI}`);
    });
  });
}

/**
 * D-31 for the Admin Dashboard screens added in Phase 3.1: the initial setup panel, the authenticator setup
 * with its QR code, the OTP / WhatsApp settings and the owner recovery panel all work under the admin
 * Content-Security-Policy without a single violation.
 */
describe.runIf(enabled)('Admin Dashboard Phase 3.1 screens under the Content-Security-Policy (D-31)', () => {
  let stack: Stack;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const violations: string[] = [];

  beforeAll(async () => {
    stack = await startStack();
    browser = await chromium.launch({ executablePath, headless: true });
    context = await browser.newContext();
    await reportViolations(context);
    page = await context.newPage();
    page.on('console', (message) => {
      if (/Content.Security.Policy|Refused to/i.test(message.text())) violations.push(message.text());
    });
    page.on('pageerror', (error) => violations.push(`page error: ${error.message}`));
    await query(stack.ownerUrl, "insert into app.admin_accounts (phone, name, role, status) values ($1, 'CSP Admin', 'super_admin', 'active')", [PHONE]);
  });

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('initial setup, authenticator setup, OTP settings and owner recovery run without a CSP violation', async () => {
    const setupToken = (await query<{ setup_token: string }>(stack.ownerUrl, 'select * from app.open_admin_bootstrap()')).rows[0]!.setup_token;
    const response = await page.goto(`${ADMIN_URL}/login`);
    expect(response!.headers()['content-security-policy']).toBe(ADMIN_CSP);
    await page.getByRole('heading', { name: 'Initial setup' }).waitFor();
    await page.getByLabel('Setup token').fill(setupToken);
    await page.getByLabel('Waabek API key').fill('fake-waabek-key-csp-check-0001');
    await page.getByRole('button', { name: 'Save key' }).click();
    await page.getByText('The Waabek API key is saved.').waitFor();

    await page.getByRole('button', { name: 'Continue to sign in' }).click();
    await page.getByLabel('Phone number').fill(PHONE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('WhatsApp code').fill(await waitForCode(stack, PHONE));
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('img', { name: /QR code for Bedo Chat Admin/ }).waitFor();
    const secret = base32Decode((await page.getByTestId('totp-setup-key').textContent()) ?? '');
    await page.getByLabel('Code from the authenticator app').fill(hotp(secret, Math.floor(Date.now() / 30_000)));
    await page.getByRole('button', { name: 'Confirm and sign in' }).click();
    await page.getByText('CSP Admin · Super Admin').waitFor();
    await page.getByRole('button', { name: 'OTP / WhatsApp' }).click();
    await page.getByText('Saved (hidden)').waitFor();

    const recoveryToken = (await query<{ recovery_token: string }>(stack.ownerUrl, 'select * from app.open_otp_settings_recovery()')).rows[0]!.recovery_token;
    const other = await browser.newContext();
    await reportViolations(other);
    try {
      const recovery = await other.newPage();
      recovery.on('console', (message) => {
        if (/Content.Security.Policy|Refused to/i.test(message.text())) violations.push(message.text());
      });
      recovery.on('pageerror', (error) => violations.push(`page error: ${error.message}`));
      await recovery.goto(`${ADMIN_URL}/login`);
      await recovery.getByRole('heading', { name: 'WhatsApp settings recovery' }).waitFor();
      await recovery.getByLabel('Recovery token').fill(recoveryToken);
      await recovery.getByLabel('New Waabek API key').fill('fake-waabek-key-csp-check-0002');
      await recovery.getByRole('button', { name: 'Save key' }).click();
      await recovery.getByText('The new Waabek API key is saved and used from the next message on.').waitFor();
    } finally {
      await other.close();
    }
    expect(violations).toEqual([]);
  });
});
