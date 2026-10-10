import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_URL, launchBrowser, query, type Stack, startStack, waitForCode, WEB_URL } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/** Set E2E_SCREENSHOTS=<folder> to save screenshots of the main screens for review. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
}

const OWNER = '+201000006001';
const READER = '+201000006002';

/** The value a datetime-local input takes for a time (this machine's local time, to the minute). */
function localInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Phase 6 end to end in a real browser: a public channel created by a teacher allowed to, found and joined by a
 * student through search, read-only for the student (who sees posts as from the channel), and a post scheduled in
 * the browser that the site sends by itself when it is due. No Content-Security-Policy violation anywhere.
 */
describe.runIf(enabled)('Phase 6 channels and scheduled posts in the browser', () => {
  let stack: Stack;
  let browser: Browser;
  let owner: Page;
  let reader: Page;
  const contexts: BrowserContext[] = [];
  const violations: string[] = [];

  async function newPage(label: string): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        // eslint-disable-next-line no-console
        console.error(`Refused to load (CSP ${event.violatedDirective}): ${event.blockedURI}`);
      });
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (/Content.Security.Policy|Refused to/i.test(message.text())) violations.push(`${label}: ${message.text()}`);
    });
    page.on('pageerror', (error) => violations.push(`${label} page error: ${error.message}`));
    return page;
  }

  async function signIn(page: Page, phone: string, name: string) {
    await stack.clearCooldown(phone);
    const previous = await stack.latestCode(phone);
    await page.goto(`${WEB_URL}/login`);
    await page.getByLabel('Phone number').waitFor();
    await page.getByLabel('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Verification code').fill(await waitForCode(stack, phone, previous));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(`${WEB_URL}/`);
  }

  const messages = (page: Page) => page.getByRole('log', { name: 'Messages' });
  const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [OWNER, READER]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
    owner = await newPage('owner');
    await signIn(owner, OWNER, 'Olga Teacher');
    reader = await newPage('reader');
    await signIn(reader, READER, 'Rami Student');
    // O-21: an admin lets the teacher create channels (the Admin Dashboard does this; tested in Phase 5).
    await query(stack.ownerUrl, `insert into app.user_permissions (user_id, create_channels) select id, true from app.users where phone = $1`, [OWNER]);
    await owner.reload();
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('creates a public channel and posts to it', async () => {
    await owner.getByRole('button', { name: 'New channel' }).click();
    const dialog = owner.getByRole('dialog', { name: 'New channel' });
    await dialog.getByLabel('Channel name').fill('Math news');
    await dialog.getByLabel('Description (optional)').fill('Announcements for the math classes');
    await dialog.getByRole('button', { name: 'Create channel' }).click();
    await owner.getByRole('region', { name: 'Channel Math news' }).waitFor();
    await owner.getByText('1 subscriber', { exact: true }).waitFor();
    await composer(owner).fill('Welcome to Math news');
    await composer(owner).press('Enter');
    await messages(owner).getByText('Welcome to Math news').waitFor();
    await shot(owner, '60-channel-owner');
  });

  it('lets a student find and join it through search, read-only, without seeing who posted', async () => {
    await reader.getByRole('searchbox').fill('Math');
    const found = reader.getByRole('region', { name: 'Public channels' });
    await found.getByText('Math news').waitFor({ timeout: 10_000 });
    await shot(reader, '61-channel-search');
    await found.getByRole('button', { name: 'Join Math news' }).click();
    await reader.getByRole('region', { name: 'Channel Math news' }).waitFor();
    await messages(reader).getByText('Welcome to Math news').waitFor();
    await reader.getByText('2 subscribers', { exact: true }).waitFor();
    // Subscribers have no composer, only Mute; the teacher's name appears nowhere.
    expect(await composer(reader).count()).toBe(0);
    await reader.getByRole('button', { name: 'Mute' }).waitFor();
    expect(await reader.content()).not.toContain('Olga Teacher');
    await shot(reader, '62-channel-subscriber');
  });

  it('schedules a post in the browser, which the site sends by itself when it is due', async () => {
    await composer(owner).fill('Homework is due on Friday');
    await owner.getByRole('button', { name: 'Schedule message' }).click();
    const dialog = owner.getByRole('dialog', { name: 'Schedule message' });
    await dialog.getByLabel('Date and time').fill(localInput(new Date(Date.now() + 3 * 60_000)));
    await shot(owner, '63-schedule-dialog');
    await dialog.getByRole('button', { name: 'Schedule', exact: true }).click();
    await owner.getByText(/^Scheduled for /).waitFor();
    const pending = owner.getByRole('button', { name: 'Scheduled messages (1)' });
    await pending.waitFor();
    expect(await messages(reader).getByText('Homework is due on Friday').count()).toBe(0);
    await pending.click();
    const list = owner.getByRole('dialog', { name: 'Scheduled messages' });
    await list.getByText('Homework is due on Friday').waitFor();
    await shot(owner, '64-scheduled-list');
    await list.getByRole('button', { name: 'Close' }).click();

    // Its time comes (moved forward here instead of waiting three minutes); any request to the site then sends it
    // (the scheduled function would within a minute).
    const rows = await query(stack.ownerUrl, `update app.scheduled_messages set send_at = now() - interval '1 second' where status = 'pending' returning id`);
    expect(rows.rowCount).toBe(1);
    const deadline = Date.now() + 30_000;
    while ((await messages(reader).getByText('Homework is due on Friday').count()) === 0 && Date.now() < deadline) {
      await fetch(`${API_URL}/health/live`).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await messages(reader).getByText('Homework is due on Friday').waitFor({ timeout: 5_000 });
    await owner.getByRole('button', { name: /^Scheduled messages \(/ }).waitFor({ state: 'detached', timeout: 15_000 });
    const sent = await query<{ status: string }>(stack.ownerUrl, 'select status from app.scheduled_messages');
    expect(sent.rows).toEqual([{ status: 'sent' }]);
  });

  it('caused no Content-Security-Policy violation or page error anywhere', () => {
    expect(violations).toEqual([]);
  });
});
