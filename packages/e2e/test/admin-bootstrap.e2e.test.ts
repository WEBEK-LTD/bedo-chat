import { decryptWaabekApiKey } from '@bedo/server-crypto';
import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, ADMIN_URL, hotp, launchBrowser, query, type Stack, startStack, WEB_URL } from './stack.js';

/** Set E2E_SCREENSHOTS=<folder> to save screenshots of the main screens for review. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
}

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const SUPER_PHONE = '+905446731942';
// Fake keys only (D-32): a real Waabek key never appears in tests.
const FIRST_KEY = 'fake-waabek-key-e2e-initial-0001';
const SECOND_KEY = 'fake-waabek-key-e2e-replaced-0002';
const RECOVERED_KEY = 'fake-waabek-key-e2e-recovered-0003';
const CHANGED_PASSWORD = 'harbour-violet-compass-8826';

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
 * sign-in page stores the first Waabek key; the Super Admin sets a password with the owner's one-time password
 * setup token (D-34), signs in with phone + password and sets up the authenticator from the QR code / setup
 * key; the setup closes for good; the key is replaced from the dashboard with an authenticator code; the
 * admin changes the password. Neither the key nor any password or token is shown in a page or written to the
 * API's logs.
 */
describe.runIf(enabled)('Phase 3.1 initial Super Admin setup in the browser', () => {
  let stack: Stack;
  let browser: Browser;
  let page: Page;
  let setupToken: string;
  let secret: Buffer;
  const secrets: string[] = [FIRST_KEY, SECOND_KEY, RECOVERED_KEY, ADMIN_PASSWORD, CHANGED_PASSWORD];
  const contexts: BrowserContext[] = [];

  async function newPage(): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    return context.newPage();
  }

  const storedKey = async () =>
    (await query<{ waabek_api_key_enc: string | null; version: string }>(stack.ownerUrl, 'select waabek_api_key_enc, version from app.otp_settings')).rows[0]!;

  beforeAll(async () => {
    stack = await startStack({ waabekKey: false });
    browser = await launchBrowser();
    // Exactly what the owner runs in the SQL editor.
    await query(stack.ownerUrl, "insert into app.admin_accounts (phone, name, role, status) values ('+905446731942', 'Academy Admin', 'super_admin', 'active')");
    setupToken = (await query<{ setup_token: string }>(stack.ownerUrl, 'select * from app.open_admin_bootstrap()')).rows[0]!.setup_token;
    secrets.push(setupToken);
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

  it('sets the first password on the sign-in page with the owner\'s setup token, without signing in (D-34)', async () => {
    await page.getByRole('button', { name: 'Continue to sign in' }).click();
    // No password yet: the answer is the same as for a wrong password.
    await page.getByLabel('Phone number').fill(SUPER_PHONE);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('The phone number or password is incorrect.').waitFor();

    // Exactly what the owner runs in the SQL editor.
    const passwordToken = (await query<{ setup_token: string }>(stack.ownerUrl, `select * from app.issue_admin_password_setup('${SUPER_PHONE}')`)).rows[0]!.setup_token;
    secrets.push(passwordToken);
    await page.getByRole('button', { name: 'Set password with a setup token' }).click();
    await page.getByRole('heading', { name: 'Set password' }).waitFor();
    // Phase 15: the number is carried over, shown as its country and the rest of the number.
    expect(await page.getByLabel('Admin phone number').inputValue()).toBe(SUPER_PHONE.slice(3));
    expect(await page.getByRole('button', { name: /^Country: / }).getAttribute('aria-label')).toBe('Country: Türkiye (+90)');
    await page.getByLabel('Setup token').fill('t'.repeat(43));
    await page.getByLabel('New password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByLabel('Confirm new password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Set password', exact: true }).click();
    await page.getByText(/The phone number or setup token is not valid/).waitFor();

    await page.getByLabel('Setup token').fill(passwordToken);
    await page.getByLabel('New password', { exact: true }).fill('short-pass');
    await page.getByLabel('Confirm new password').fill('short-pass');
    expect(await page.getByRole('button', { name: 'Set password', exact: true }).isDisabled()).toBe(true);
    await page.getByLabel('New password', { exact: true }).fill('Password1234');
    await page.getByLabel('Confirm new password').fill('Password1234-x');
    await page.getByText('The passwords do not match.').waitFor();
    await page.getByLabel('Confirm new password').fill('Password1234');
    await page.getByRole('button', { name: 'Set password', exact: true }).click();
    await page.getByText('This password is too common and easy to guess. Choose a different password.').waitFor();
    await page.getByLabel('New password', { exact: true }).fill(SUPER_PHONE);
    await page.getByLabel('Confirm new password').fill(SUPER_PHONE);
    await page.getByRole('button', { name: 'Set password', exact: true }).click();
    await page.getByText('The password cannot be your phone number. Choose a different password.').waitFor();
    await page.getByLabel('New password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByLabel('Confirm new password').fill(ADMIN_PASSWORD);
    await shot(page, '35-set-password');
    await page.getByRole('button', { name: 'Set password', exact: true }).click();
    await page.getByText('Your password is set. Sign in with it.').waitFor();
    expect(await page.content()).not.toContain(ADMIN_PASSWORD);
    expect(await page.content()).not.toContain(passwordToken);
    expect((await page.context().cookies()).some((cookie) => cookie.name === 'bedo_admin_session')).toBe(false);
    const stored = (await query<{ password_hash: string }>(stack.ownerUrl, 'select password_hash from app.admin_accounts where phone = $1', [SUPER_PHONE])).rows[0]!;
    expect(stored.password_hash).toMatch(/^\$argon2id\$/);
    // The token worked once.
    await page.getByRole('button', { name: 'Set password with a setup token' }).click();
    await page.getByLabel('Setup token').fill(passwordToken);
    await page.getByLabel('New password', { exact: true }).fill(CHANGED_PASSWORD);
    await page.getByLabel('Confirm new password').fill(CHANGED_PASSWORD);
    await page.getByRole('button', { name: 'Set password', exact: true }).click();
    await page.getByText(/The phone number or setup token is not valid/).waitFor();
    await page.getByRole('button', { name: 'Back to sign in' }).click();
  });

  it('signs in with phone and password and sets up the authenticator from the QR code and setup key', async () => {
    expect(await page.getByLabel('Phone number').inputValue()).toBe(SUPER_PHONE.slice(3));
    expect(await page.getByRole('button', { name: /^Country: / }).getAttribute('aria-label')).toBe('Country: Türkiye (+90)');
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await shot(page, '36-sign-in-password');
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

  it('D-56: a Super Admin turns on the store review account, which signs in with its fixed code and no WhatsApp', async () => {
    await page.getByRole('button', { name: 'OTP / WhatsApp' }).click();
    const section = page.getByRole('region', { name: 'Store review account' });
    await section.getByTestId('review-account-status').getByText('Off.').waitFor();
    await section.getByLabel('Phone number').fill('+61 400 000 999');
    await section.getByLabel('Fixed sign-in code').fill('135790');
    await section.getByRole('button', { name: 'Save and turn on' }).click();
    await section.getByTestId('review-account-status').getByText(/On for \+61400000999/).waitFor();
    await shot(page, '35-store-review-account');

    // The reviewer signs in to the student app with the number and the fixed code (not on the academy list).
    const reviewer = await newPage();
    await reviewer.goto(`${WEB_URL}/login`);
    await reviewer.getByLabel('Phone number').fill('+61400000999');
    await reviewer.getByRole('button', { name: 'Continue' }).click();
    await reviewer.getByLabel('Verification code').fill('135790');
    await reviewer.getByRole('button', { name: 'Sign in' }).click();
    await reviewer.getByLabel('Name').fill('Store Reviewer');
    await reviewer.getByRole('button', { name: 'Continue' }).click();
    await reviewer.waitForURL(`${WEB_URL}/`);

    // Turned off: back to WhatsApp codes only.
    await section.getByRole('button', { name: 'Turn off' }).click();
    await section.getByTestId('review-account-status').getByText('Off.', { exact: false }).waitFor();
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

  it('changes the password from Account: needs the current password and an authenticator code, signs out other sessions only', async () => {
    // A second session of the same admin (the replay marker is cleared so a new code can be used at once).
    await query(stack.ownerUrl, 'update app.admin_accounts set totp_last_step = null where phone = $1', [SUPER_PHONE]);
    const other = await newPage();
    await other.goto(`${ADMIN_URL}/login`);
    await other.getByLabel('Phone number').fill(SUPER_PHONE);
    await other.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await other.getByRole('button', { name: 'Continue' }).click();
    await other.getByLabel('Authenticator code').fill(hotp(secret, step()));
    await other.getByRole('button', { name: 'Sign in' }).click();
    await other.getByText('Academy Admin · Super Admin').waitFor();

    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('heading', { name: 'Change password' }).waitFor();
    await page.getByLabel('Current password').fill('not-the-current-password');
    await page.getByLabel('New password', { exact: true }).fill(CHANGED_PASSWORD);
    await page.getByLabel('Confirm new password').fill(CHANGED_PASSWORD);
    await page.getByLabel('Authenticator code').fill(hotp(secret, step(1)));
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await page.getByText('The current password or the authenticator code is incorrect.').waitFor();
    // The code field is emptied: a code works once.
    expect(await page.getByLabel('Authenticator code').inputValue()).toBe('');

    await page.getByLabel('Current password').fill(ADMIN_PASSWORD);
    await page.getByLabel('Authenticator code').fill(hotp(secret, step(1)));
    await shot(page, '37-change-password');
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await page.getByText('Your password is changed. 1 other session was signed out.').waitFor();
    expect(await page.content()).not.toContain(CHANGED_PASSWORD);

    // This session stays; the other one ends.
    await page.getByRole('button', { name: 'Deletion requests' }).click();
    await page.getByRole('heading', { name: 'Deletion requests' }).first().waitFor();
    await other.reload();
    await other.waitForURL(`${ADMIN_URL}/login`);

    // The old password no longer works; the new one does.
    await other.getByLabel('Phone number').fill(SUPER_PHONE);
    await other.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await other.getByRole('button', { name: 'Continue' }).click();
    await other.getByText('The phone number or password is incorrect.').waitFor();
    await other.getByLabel('Password', { exact: true }).fill(CHANGED_PASSWORD);
    await other.getByRole('button', { name: 'Continue' }).click();
    await other.getByLabel('Authenticator code').waitFor();
  });

  it('never writes a password, token or Waabek key to the API logs', async () => {
    const output = stack.apiOutput();
    // The request log is on (level info), so the sign-in requests are there — without their bodies.
    expect(output).toContain('/v1/admin/auth/password/login');
    expect(output).toContain('/v1/admin/auth/password/setup');
    expect(output).toContain('/v1/admin/account/password');
    for (const value of [...secrets, 'Password1234', 'not-the-current-password']) {
      expect(output.includes(value), value).toBe(false);
    }
  });
});
