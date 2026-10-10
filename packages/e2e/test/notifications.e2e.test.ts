import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, query, type Stack, startStack, waitForCode, WEB_URL } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
}

const SENDER = '+201000007001';
const READER = '+201000007002';

/**
 * Phase 7 end to end in a real browser (exit gate: badge counts match across devices): one person signed in on two
 * devices sees the same badge in both tabs as messages arrive, reading on one device clears it on the other, muting a
 * chat takes it out of the badge, a notification's link opens its chat, and the notification settings are kept.
 */
describe.runIf(enabled)('Phase 7 notifications and badges in the browser', () => {
  let stack: Stack;
  let browser: Browser;
  let sender: Page;
  let laptop: Page;
  let phone: Page;
  const contexts: BrowserContext[] = [];
  const violations: string[] = [];

  async function newPage(label: string): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    page.on('console', (message) => {
      if (/Content.Security.Policy|Refused to/i.test(message.text())) violations.push(`${label}: ${message.text()}`);
    });
    page.on('pageerror', (error) => violations.push(`${label} page error: ${error.message}`));
    return page;
  }

  async function signIn(page: Page, phoneNumber: string, name: string | null) {
    await stack.clearCooldown(phoneNumber);
    const previous = await stack.latestCode(phoneNumber);
    await page.goto(`${WEB_URL}/login`);
    await page.getByLabel('Phone number').fill(phoneNumber);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Verification code').fill(await waitForCode(stack, phoneNumber, previous));
    await page.getByRole('button', { name: 'Sign in' }).click();
    if (name) {
      await page.getByLabel('Name').fill(name);
      await page.getByRole('button', { name: 'Continue' }).click();
    }
    await page.waitForURL(`${WEB_URL}/`);
  }

  const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
  const titleIs = (page: Page, title: string) => page.waitForFunction((expected) => document.title === expected, title, { timeout: 20_000 });

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const number of [SENDER, READER]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [number]);
    }
    sender = await newPage('sender');
    await signIn(sender, SENDER, 'Sara Sender');
    laptop = await newPage('laptop');
    await signIn(laptop, READER, 'Rafi Reader');
    phone = await newPage('phone');
    await signIn(phone, READER, null);
    await query(stack.ownerUrl, `update app.users set username = 'rafi_reader' where phone = $1`, [READER]);
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('shows the same badge on both devices as messages arrive, and clears it on both after reading on one', async () => {
    await sender.getByRole('searchbox').fill('rafi_reader');
    await sender.getByRole('button', { name: /^Rafi Reader/ }).click();
    for (const text of ['Hello Rafi', 'Are you there?', 'Class moved to 3pm']) {
      await composer(sender).fill(text);
      await composer(sender).press('Enter');
    }
    await titleIs(laptop, '(3) Bedo Chat');
    await titleIs(phone, '(3) Bedo Chat');
    await shot(phone, '70-badge-phone');
    // Reading on the laptop clears the badge on the phone too.
    await laptop.getByRole('button', { name: /^Sara Sender/ }).click();
    await laptop.getByText('Class moved to 3pm').waitFor();
    await titleIs(laptop, 'Bedo Chat');
    await titleIs(phone, 'Bedo Chat');
  });

  it('leaves muted chats out of the badge on every device', async () => {
    await phone.getByRole('button', { name: 'Actions for Sara Sender' }).click();
    await phone.getByRole('menuitem', { name: 'Mute' }).click();
    await phone.getByRole('img', { name: 'Muted' }).waitFor();
    // Neither device has the chat open now (otherwise it would be read at once).
    await laptop.goto(`${WEB_URL}/`);
    await laptop.getByRole('img', { name: 'Muted' }).waitFor({ timeout: 20_000 });
    await composer(sender).fill('Muted, so no badge');
    await composer(sender).press('Enter');
    await phone.getByText('Muted, so no badge').first().waitFor({ timeout: 20_000 });
    await laptop.getByText('Muted, so no badge').first().waitFor({ timeout: 20_000 });
    expect(await phone.title()).toBe('Bedo Chat');
    expect(await laptop.title()).toBe('Bedo Chat');
    // Unmuting brings the unread message back into the badge, on both.
    await phone.getByRole('button', { name: 'Actions for Sara Sender' }).click();
    await phone.getByRole('menuitem', { name: 'Unmute' }).click();
    await titleIs(phone, '(1) Bedo Chat');
    await titleIs(laptop, '(1) Bedo Chat');
  });

  it('opens the chat a notification links to', async () => {
    const chatId = (await query<{ id: string }>(stack.ownerUrl, `select id from app.conversations where type = 'private' limit 1`)).rows[0]!.id;
    await phone.goto(`${WEB_URL}/?chat=${chatId}`);
    await phone.getByRole('region', { name: 'Chat with Sara Sender' }).waitFor();
    expect(new URL(phone.url()).search).toBe('');
  });

  it('keeps the notification settings', async () => {
    await phone.getByRole('button', { name: 'Settings' }).click();
    await phone.getByRole('button', { name: /Notifications/ }).click();
    const section = phone.getByRole('region', { name: 'Notify me about' });
    await section.getByLabel(/Groups/).uncheck();
    await section.getByLabel(/Show sender and text/).uncheck();
    await shot(phone, '71-notification-settings');
    await expect.poll(async () => (await query(stack.ownerUrl, 'select groups, previews, private_chats from app.notification_settings')).rows).toEqual([
      { groups: false, previews: false, private_chats: true },
    ]);
    await laptop.reload();
    await laptop.getByRole('button', { name: 'Settings' }).click();
    await laptop.getByRole('button', { name: /Notifications/ }).click();
    expect(await laptop.getByRole('region', { name: 'Notify me about' }).getByLabel(/Groups/).isChecked()).toBe(false);
  });

  it('caused no Content-Security-Policy violation or page error anywhere', () => {
    expect(violations).toEqual([]);
  });
});
