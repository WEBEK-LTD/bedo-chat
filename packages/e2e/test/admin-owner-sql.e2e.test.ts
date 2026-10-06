import { readFileSync } from 'node:fs';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, hotp, query, type Stack, startStack } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);
const executablePath = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const PHONE = '+905446731942';
const PASSWORD = ['harbour', 'violet', 'compass', '8826'].join('-');
const SCRIPT = readFileSync(new URL('../../../docs/owner-sql/set-super-admin.sql', import.meta.url), 'utf8');

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

/** The delivered owner script with only its three input values replaced, as the owner does in the SQL editor. */
const ownerScript = (password: string) =>
  SCRIPT.replace("input_password constant text := 'MY_PASSWORD_HERE';", `input_password constant text := '${password.replace(/'/g, "''")}';`);

/**
 * D-35 in a real browser: the owner runs ONE SQL script; the admin signs in on /admin/login with that password,
 * sets up the authenticator (still mandatory) and reaches the dashboard; the temporary hash becomes Argon2id.
 */
describe.runIf(enabled)('D-35 owner SQL password in the browser', () => {
  let stack: Stack;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    stack = await startStack();
    browser = await chromium.launch({ executablePath, headless: true });
    page = await (await browser.newContext()).newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await stack?.stop();
  });

  const hashOf = async () =>
    (await query<{ password_hash: string }>(stack.ownerUrl, 'select password_hash from app.admin_accounts where phone = $1', [PHONE])).rows[0]!.password_hash;

  it('a common password set by SQL is refused at the first sign-in like a wrong password', async () => {
    await query(stack.ownerUrl, ownerScript('Password1234'));
    await page.goto(`${ADMIN_URL}/login`);
    await page.getByLabel('Phone number').fill(PHONE);
    await page.getByLabel('Password', { exact: true }).fill('Password1234');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('The phone number or password is incorrect.').waitFor();
    expect(
      (await query(stack.ownerUrl, "select 1 from audit.security_events where event = 'admin_password_upgrade_refused' and details->>'reason' = 'too_common'")).rowCount,
    ).toBe(1);
    expect(await hashOf()).toMatch(/^\$2a\$12\$/);
  });

  it('signs in with the password from the SQL script, requires the authenticator, and upgrades the hash', async () => {
    await query(stack.ownerUrl, ownerScript(PASSWORD));
    expect(await hashOf()).toMatch(/^\$2a\$12\$/);
    await page.goto(`${ADMIN_URL}/login`);
    await page.getByLabel('Phone number').fill(PHONE);
    await page.getByLabel('Password', { exact: true }).fill('harbour-violet-compass-8827');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('The phone number or password is incorrect.').waitFor();

    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('Set up your authenticator app. It is required for every admin sign-in.').waitFor();
    expect((await page.context().cookies()).some((cookie) => cookie.name === 'bedo_admin_session')).toBe(false);
    const secret = base32Decode((await page.getByTestId('totp-setup-key').textContent()) ?? '');
    await page.getByLabel('Code from the authenticator app').fill(hotp(secret, Math.floor(Date.now() / 30_000)));
    await page.getByRole('button', { name: 'Confirm and sign in' }).click();
    await page.getByText('Academy Admin · Super Admin').waitFor();
    expect(await hashOf()).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(stack.apiOutput().includes(PASSWORD)).toBe(false);
  });
});
