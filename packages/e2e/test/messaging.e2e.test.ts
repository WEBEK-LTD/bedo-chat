import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_CSP } from '../../../apps/web/csp.mjs';
import { ADMIN_URL, launchBrowser, query, type Stack, startStack, waitForCode, WEB_URL } from './stack.js';

/** Set E2E_SCREENSHOTS=<folder> to save screenshots of the main screens for review. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
}

const enabled = Boolean(process.env.TEST_DATABASE_URL);

const ANA = '+201000003001';
const BEN = '+201000003002';

/**
 * Phase 3 end to end in a real browser, on the one site (D-36: web app, Admin Dashboard and API on one origin) with
 * realtime through the Supabase Realtime stand-in: two users and a second device, live delivery and statuses, catching up after a
 * device was closed (local cache plus sync), typing, edits and deletions, blocks with the neutral answer,
 * and the Content-Security-Policy (D-31) on every page without a single violation.
 */
describe.runIf(enabled)('Phase 3 messaging in the browser (one site, Postgres, Supabase Realtime stand-in)', () => {
  let stack: Stack;
  let browser: Browser;
  let anaContext: BrowserContext;
  let anaPhone: Page;
  let anaLaptop: Page;
  let benContext: BrowserContext;
  let ben: Page;
  const contexts: BrowserContext[] = [];
  const violations: string[] = [];

  function watch(page: Page, label: string) {
    page.on('console', (message) => {
      if (/Content.Security.Policy|Refused to/i.test(message.text())) violations.push(`${label}: ${message.text()}`);
    });
    page.on('pageerror', (error) => violations.push(`${label} page error: ${error.message}`));
  }

  async function newContext(): Promise<BrowserContext> {
    const context = await browser.newContext();
    contexts.push(context);
    // Every CSP violation is also reported as an event; collect them from every page.
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        // Runs in the page: reports the violation to the test through the page's console.
        // eslint-disable-next-line no-console
        console.error(`Refused to load (CSP ${event.violatedDirective}): ${event.blockedURI}`);
      });
    });
    return context;
  }

  async function signIn(page: Page, phone: string, name: string | null) {
    await stack.clearCooldown(phone);
    const previous = await stack.latestCode(phone);
    await page.goto(`${WEB_URL}/login`);
    await page.getByLabel('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Verification code').fill(await waitForCode(stack, phone, previous));
    await page.getByRole('button', { name: 'Sign in' }).click();
    if (name) {
      await page.getByLabel('Name').fill(name);
      await page.getByRole('button', { name: 'Continue' }).click();
    }
    await page.waitForURL(`${WEB_URL}/`);
  }

  const messages = (page: Page) => page.getByRole('log', { name: 'Messages' });
  const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [ANA, BEN]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
    anaContext = await newContext();
    anaPhone = await anaContext.newPage();
    watch(anaPhone, 'ana-1');
    await signIn(anaPhone, ANA, 'Ana Lopez');
    benContext = await newContext();
    ben = await benContext.newPage();
    watch(ben, 'ben');
    await signIn(ben, BEN, 'Ben Carter');
    // Ana's second device: another browser, same account.
    const laptopContext = await newContext();
    anaLaptop = await laptopContext.newPage();
    watch(anaLaptop, 'ana-2');
    await signIn(anaLaptop, ANA, null);
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('serves every page with a strict Content-Security-Policy (D-31)', async () => {
    const page = await (await newContext()).newPage();
    watch(page, 'csp');
    const web = await page.goto(`${WEB_URL}/login`);
    const webPolicy = web!.headers()['content-security-policy'] ?? '';
    expect(webPolicy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(webPolicy).toContain("default-src 'none'");
    expect(webPolicy).toContain("frame-ancestors 'none'");
    // D-36: the API is the site itself ('self'); realtime is the Supabase project's WebSocket (here its stand-in).
    expect(webPolicy).toContain("connect-src 'self' https://localhost:3400 wss://localhost:3400;");
    expect(webPolicy).not.toMatch(/unsafe-inline|unsafe-eval/);
    // A fresh nonce on every response.
    const again = await page.goto(`${WEB_URL}/login`);
    expect(again!.headers()['content-security-policy']).not.toBe(webPolicy);
    const admin = await page.goto(`${ADMIN_URL}/login`);
    expect(admin!.headers()['content-security-policy']).toBe(ADMIN_CSP);
    await page.getByLabel('Phone number').waitFor();
    // The not-found page is styled without inline styles.
    const missing = await page.goto(`${WEB_URL}/no-such-page`);
    expect(missing!.status()).toBe(404);
    await page.getByText('This page does not exist.').waitFor();
    expect(violations).toEqual([]);
  });

  it('starts a chat by searching for a name and delivers messages live to every device', async () => {
    await anaPhone.getByRole('searchbox', { name: 'Search' }).fill('Be');
    await anaPhone.getByText('Type at least 3 characters to find people.').waitFor();
    await anaPhone.getByRole('searchbox', { name: 'Search' }).fill('Ben C');
    await anaPhone.getByRole('button', { name: /^Ben Carter/ }).click();
    await anaPhone.getByRole('region', { name: 'Chat with Ben Carter' }).waitFor();
    await composer(anaPhone).fill('Hello Ben, are you ready for the exam?');
    await composer(anaPhone).press('Enter');
    await messages(anaPhone).getByText('Hello Ben, are you ready for the exam?').waitFor();
    await shot(anaPhone, '20-chat-sent');

    // Ben sees the chat appear with an unread count, without reloading. D-36: within seconds, through his
    // realtime channel (devices not listening would only see it at the next 20-second check).
    const row = ben.getByRole('button', { name: /^Ana Lopez/ });
    await row.waitFor({ timeout: 5_000 });
    await ben.getByLabel('1 unread').waitFor({ timeout: 5_000 });
    // The signals carry no content: the message itself only ever travels over the API.
    expect(stack.broadcasts().length).toBeGreaterThan(0);
    // Every signal went to a private channel (only the device holding that channel's token receives it).
    expect(stack.broadcasts().every((broadcast) => broadcast.private)).toBe(true);
    expect(stack.refusedJoins()).toEqual([]);
    expect(JSON.stringify(stack.broadcasts())).not.toContain('ready for the exam');
    // Ana's other device has the chat and the message too.
    await anaLaptop.getByRole('button', { name: /^Ben Carter/ }).click();
    await messages(anaLaptop).getByText('Hello Ben, are you ready for the exam?').waitFor();

    // Ben opens the chat: Ana's devices show the message as seen.
    await row.click();
    await messages(ben).getByText('Hello Ben, are you ready for the exam?').waitFor();
    await messages(anaPhone).getByRole('img', { name: 'Seen' }).waitFor();
    await messages(anaLaptop).getByRole('img', { name: 'Seen' }).waitFor();
    await shot(ben, '21-chat-received');
  });

  it('shows typing and catches a closed device up from its local cache and sync', async () => {
    await composer(ben).pressSequentially('Yes, almost', { delay: 20 });
    await anaPhone.getByText('typing…').first().waitFor({ timeout: 5_000 });
    await composer(ben).press('Enter');
    await messages(anaPhone).getByText('Yes, almost').waitFor();
    // The indicator ends when the message arrives (and in any case after 6 seconds, P-18).
    await anaPhone.getByText('typing…').first().waitFor({ state: 'detached', timeout: 8_000 });

    // Ben's browser tab is closed; Ana writes twice; Ben opens Bedo Chat again.
    await ben.close();
    await composer(anaPhone).fill('First while you were away');
    await composer(anaPhone).press('Enter');
    await composer(anaPhone).fill('Second while you were away');
    await composer(anaPhone).press('Enter');
    await messages(anaPhone).getByText('Second while you were away').waitFor();
    ben = await benContext.newPage();
    watch(ben, 'ben-2');
    await ben.goto(`${WEB_URL}/`);
    await ben.getByRole('button', { name: /^Ana Lopez/ }).click();
    await messages(ben).getByText('First while you were away').waitFor();
    await messages(ben).getByText('Second while you were away').waitFor();
  });

  it('shows edits and deletions for both sides on every device, with the history kept', async () => {
    const original = messages(anaPhone).getByText('First while you were away');
    await original.hover();
    const bubble = anaPhone.locator('[id^="message-"]', { hasText: 'First while you were away' });
    await bubble.getByRole('button', { name: 'Message actions' }).click();
    await anaPhone.getByRole('menuitem', { name: 'Edit' }).click();
    await composer(anaPhone).fill('First (corrected)');
    await composer(anaPhone).press('Enter');
    await messages(ben).getByText('First (corrected)').waitFor();
    await messages(anaLaptop).getByText('First (corrected)').waitFor();

    const second = anaPhone.locator('[id^="message-"]', { hasText: 'Second while you were away' });
    await second.hover();
    await second.getByRole('button', { name: 'Message actions' }).click();
    await anaPhone.getByRole('menuitem', { name: 'Delete' }).click();
    await anaPhone.getByRole('button', { name: 'Delete for both' }).click();
    await expect.poll(async () => messages(ben).getByText('Second while you were away').count()).toBe(0);
    await messages(ben).getByText('This message was deleted.').waitFor();
    await messages(anaLaptop).getByText('This message was deleted.').waitFor();

    const history = await query<{ action: string; previous_text: string }>(
      stack.ownerUrl,
      'select action, previous_text from audit.message_revisions order by id',
    );
    expect(history.rows).toEqual([
      { action: 'edited', previous_text: 'First while you were away' },
      { action: 'deleted_for_both', previous_text: 'Second while you were away' },
    ]);
  });

  it('gives a blocked sender the neutral answer, and asks the blocker to unblock first', async () => {
    await ben.getByRole('button', { name: 'Chat actions' }).click();
    await ben.getByRole('menuitem', { name: 'Block user' }).click();
    await ben.getByText('You blocked this user.').waitFor();
    await composer(anaPhone).fill('Are you still there?');
    await composer(anaPhone).press('Enter');
    await anaPhone.getByText("You can't message this user").first().waitFor();
    await shot(anaPhone, '22-blocked');
    await expect.poll(async () => messages(ben).getByText('Are you still there?').count()).toBe(0);
    await ben.getByRole('button', { name: 'Unblock' }).click();
    await composer(ben).waitFor();
  });

  it('never sends screenshot events from the web app (P-28), and raised no CSP violation', async () => {
    const events = await query<{ n: number }>(stack.ownerUrl, 'select count(*)::int as n from audit.screenshot_events');
    expect(events.rows[0]!.n).toBe(0);
    expect(violations).toEqual([]);
  });
});
