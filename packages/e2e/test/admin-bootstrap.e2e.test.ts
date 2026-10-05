import { decryptWaabekApiKey } from '@bedo/server-crypto';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, hotp, query, type Stack, startStack, waitForCode } from './stack.js';

/** Set E2E_SCREENSHOTS=<folder> to save screenshots of the main screens for review. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
}

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);
const executablePath = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const SUPER_PHONE = '+905446731942';
// Fake keys only (D-32): a real Waabek key never appears in tests.
const FIRST_KEY = 'fake-waabek-key-e2e-initial-0001';
const SECOND_KEY = 'fake-waabek-key-e2e-replaced-0002';
const RECOVERED_KEY = 'fake-waabek-key-e2e-recovered-0003';

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

const step = (offset = 0) => Math.floor(Date.now() / 30_000) + offset;

/**
 * Phase 3.1 in a real browser: the owner creates the Super Admin and opens the initial setup by SQL; the
 * sign-in page stores the first Waabek key; the Super Admin signs in with the WhatsApp code, sets up the
 * authenticator from the QR code / setup key; the setup closes for good; the key is replaced from the
 * dashboard with an authenticator code. The key is never shown in any page.
 */
describe.runIf(enabled)('Phase 3.1 initial Super Admin setup in the browser', () => {
  let stack: Stack;
  let browser: Browser;
  let page: Page;
  let setupToken: string;
  let secret: Buffer;
  const contexts: BrowserContext[] = [];

  async function newPage(): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    return context.newPage();
  }

  const storedKey = async () =>
    (await query<{ waabek_api_key_enc: string | null; version: string }>(stack.ownerUrl, 'select waabek_api_key_enc, version from app.otp_settings')).rows[0]!;

  beforeAll(async () => {
    stack = await startStack();
    browser = await chromium.launch({ executablePath, headless: true });
    // Exactly what the owner runs in the SQL editor.
    await query(stack.ownerUrl, "insert into app.admin_accounts (phone, name, role, status) values ('+905446731942', 'Academy Admin', 'super_admin', 'active')");
    setupToken = (await query<{ setup_token: string }>(stack.ownerUrl, 'select * from app.open_admin_bootstrap()')).rows[0]!.setup_token;
    page = await newPage();
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('stores the first Waabek key from the sign-in page with the setup token', async () => {
    await page.goto(`${ADMIN_URL}/login`);
    await page.getByRole('heading', { name: 'Initial setup' }).waitFor();
    await page.getByLabel('Setup token').fill('w'.repeat(43));
    await page.getByLabel('Waabek API key').fill(FIRST_KEY);
    await page.getByRole('button', { name: 'Save key' }).click();
    await page.getByText('The setup token is incorrect.').waitFor();
    await page.getByLabel('Setup token').fill(setupToken);
    await page.getByRole('button', { name: 'Save key' }).click();
    await page.getByText('The Waabek API key is saved.').waitFor();
    // The key field is cleared and the key is nowhere in the page.
    expect(await page.getByLabel(/Waabek API key/).inputValue()).toBe('');
    expect(await page.content()).not.toContain(FIRST_KEY);
    await shot(page, '31-initial-setup-saved');
    const row = await storedKey();
    expect(row.waabek_api_key_enc).not.toContain(FIRST_KEY);
    expect(decryptWaabekApiKey(stack.settingsKey, row.waabek_api_key_enc!)).toBe(FIRST_KEY);
  });

  it('signs in with the WhatsApp code and sets up the authenticator from the QR code and setup key', async () => {
    await page.getByRole('button', { name: 'Continue to sign in' }).click();
    await page.getByLabel('Phone number').fill(SUPER_PHONE);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('WhatsApp code').fill(await waitForCode(stack, SUPER_PHONE));
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('Set up your authenticator app. It is required for every admin sign-in.').waitFor();
    await page.getByRole('img', { name: /QR code for Bedo Chat Admin/ }).waitFor();
    const key = (await page.getByTestId('totp-setup-key').textContent()) ?? '';
    secret = base32Decode(key);
    expect(secret).toHaveLength(20);
    await shot(page, '32-authenticator-setup');

    await page.getByLabel('Code from the authenticator app').fill('000000');
    await page.getByRole('button', { name: 'Confirm and sign in' }).click();
    await page.getByText('The authenticator code is incorrect').waitFor();
    await page.getByLabel('Code from the authenticator app').fill(hotp(secret, step()));
    await page.getByRole('button', { name: 'Confirm and sign in' }).click();
    await page.getByText('Academy Admin · Super Admin').waitFor();

    const account = (await query<{ totp_confirmed_at: Date | null; totp_secret_enc: string | null }>(stack.ownerUrl, 'select * from app.admin_accounts where phone = $1', [SUPER_PHONE])).rows[0]!;
    expect(account.totp_confirmed_at).not.toBeNull();
    expect(account.totp_secret_enc).not.toBeNull();
    const bootstrap = (await query<{ closed_at: Date | null }>(stack.ownerUrl, 'select closed_at from app.admin_bootstrap')).rows[0]!;
    expect(bootstrap.closed_at).not.toBeNull();
  });

  it('no longer offers the initial setup once it is complete', async () => {
    const fresh = await newPage();
    await fresh.goto(`${ADMIN_URL}/login`);
    await fresh.getByLabel('Phone number').waitFor();
    await fresh.waitForLoadState('networkidle');
    expect(await fresh.getByRole('heading', { name: 'Initial setup' }).count()).toBe(0);
    await expect(query(stack.ownerUrl, 'select * from app.open_admin_bootstrap()')).rejects.toThrow(/cannot be opened again/);
  });

  it('shows the OTP / WhatsApp settings without the key and replaces the key with an authenticator code', async () => {
    await page.getByRole('button', { name: 'OTP / WhatsApp' }).click();
    await page.getByRole('heading', { name: 'OTP / WhatsApp (Waabek)' }).waitFor();
    await page.getByText('Saved (hidden)').waitFor();
    await page.getByText(/during initial setup/).waitFor();
    await shot(page, '33-otp-settings');

    await page.getByLabel('New Waabek API key').fill(SECOND_KEY);
    await page.getByLabel('Authenticator code').fill('000000');
    await page.getByRole('button', { name: 'Save new key' }).click();
    await page.getByText('The authenticator code is incorrect').waitFor();
    expect(decryptWaabekApiKey(stack.settingsKey, (await storedKey()).waabek_api_key_enc!)).toBe(FIRST_KEY);

    await page.getByLabel('New Waabek API key').fill(SECOND_KEY);
    await page.getByLabel('Authenticator code').fill(hotp(secret, step(1)));
    await page.getByRole('button', { name: 'Save new key' }).click();
    await page.getByText('The new Waabek API key is saved.', { exact: false }).waitFor();
    await page.getByText(/by Academy Admin/).waitFor();
    expect(await page.getByLabel('New Waabek API key').inputValue()).toBe('');
    const content = await page.content();
    expect(content).not.toContain(FIRST_KEY);
    expect(content).not.toContain(SECOND_KEY);
    const row = await storedKey();
    expect(decryptWaabekApiKey(stack.settingsKey, row.waabek_api_key_enc!)).toBe(SECOND_KEY);
    expect(row.version).toBe('2');

    const audit = await query<{ action: string; metadata: Record<string, unknown> }>(
      stack.ownerUrl,
      "select action, metadata from app.audit_log where action like 'otp_settings.%' order by id",
    );
    expect(audit.rows).toEqual([
      { action: 'otp_settings.waabek_key_replaced', metadata: { source: 'initial_setup', version: 1 } },
      { action: 'otp_settings.waabek_key_replaced', metadata: { source: 'admin_dashboard', version: 2 } },
    ]);
  });

  it('owner recovery (D-33): the recovery token saves a new key from the sign-in page and signs nobody in', async () => {
    const recoveryToken = (await query<{ recovery_token: string }>(stack.ownerUrl, 'select * from app.open_otp_settings_recovery()')).rows[0]!.recovery_token;
    const fresh = await newPage();
    await fresh.goto(`${ADMIN_URL}/login`);
    await fresh.getByRole('heading', { name: 'WhatsApp settings recovery' }).waitFor();
    expect(await fresh.getByRole('heading', { name: 'Initial setup' }).count()).toBe(0);
    await fresh.getByLabel('Recovery token').fill(recoveryToken);
    await fresh.getByLabel('New Waabek API key').fill(RECOVERED_KEY);
    await fresh.getByRole('button', { name: 'Save key' }).click();
    await fresh.getByText('The new Waabek API key is saved and used from the next message on.').waitFor();
    expect(await fresh.content()).not.toContain(RECOVERED_KEY);
    await shot(fresh, '34-owner-recovery');
    const row = await storedKey();
    expect(decryptWaabekApiKey(stack.settingsKey, row.waabek_api_key_enc!)).toBe(RECOVERED_KEY);
    expect(row.version).toBe('3');
    // Still on the sign-in page, not signed in.
    await fresh.getByLabel('Phone number').waitFor();
    const cookies = await fresh.context().cookies();
    expect(cookies.some((cookie) => cookie.name === 'bedo_admin_session')).toBe(false);

    // The signed-in Super Admin sees the change.
    await page.reload();
    await page.getByRole('button', { name: 'OTP / WhatsApp' }).click();
    await page.getByText(/by owner recovery/).waitFor();
  });
});
