import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, query, type Stack, startStack, waitForCode, WEB_URL } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png` });
  }
}

const ANA = '+201000016001';
const BEN = '+201000016002';
const CARA = '+201000016003';

/**
 * The browser's push service is out of reach in the tests: its subscription is replaced by a stand-in with a push
 * service address, which the page saves with the real API like a real one.
 */
function fakePushService(id: string) {
  return `(() => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-${id}',
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BPk-e2e', auth: 'auth-e2e' } }; },
      unsubscribe: async () => { current = null; return true; },
    };
    let current = null;
    PushManager.prototype.getSubscription = async function () { return current; };
    PushManager.prototype.subscribe = async function () { current = subscription; return subscription; };
  })();`;
}

/**
 * D-55: notifications start without hunting for a setting. Where the device already allows them they are on at
 * sign-in; where a browser still has to ask, the chat screen offers the button; "Not now" puts it off for a week; a
 * device where they were turned off in Settings stays off.
 */
describe.runIf(enabled)('D-55 notifications on from the start', () => {
  let stack: Stack;
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  const violations: string[] = [];

  async function newPage(label: string, id: string, allowed: boolean): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext();
    contexts.push(context);
    if (allowed) await context.grantPermissions(['notifications'], { origin: WEB_URL });
    await context.addInitScript({ content: fakePushService(id) });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (/Content.Security.Policy|Refused to/i.test(message.text())) violations.push(`${label}: ${message.text()}`);
    });
    page.on('pageerror', (error) => violations.push(`${label} page error: ${error.message}`));
    return { page, context };
  }

  async function signIn(page: Page, phone: string, name: string) {
    await stack.clearCooldown(phone);
    const previous = await stack.latestCode(phone);
    await page.goto(`${WEB_URL}/login`);
    await page.getByLabel('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Verification code').fill(await waitForCode(stack, phone, previous));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(`${WEB_URL}/`);
  }

  const offer = (page: Page) => page.getByRole('region', { name: 'Get notifications' });
  const saved = async (phone: string) =>
    (
      await query<{ endpoint: string }>(
        stack.ownerUrl,
        'select s.endpoint from app.push_subscriptions s join app.users u on u.id = s.user_id where u.phone = $1',
        [phone],
      )
    ).rows.map((row) => row.endpoint);

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [ANA, BEN, CARA]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('turns them on at sign-in, with no button, where the device already allows notifications', async () => {
    const { page } = await newPage('cara', 'cara', true);
    await signIn(page, CARA, 'Cara Diaz');
    await expect.poll(() => saved(CARA), { timeout: 15_000 }).toEqual(['https://fcm.googleapis.com/fcm/send/e2e-cara']);
    await page.getByRole('searchbox', { name: 'Search' }).waitFor();
    expect(await offer(page).count()).toBe(0);

    // Turned off in Settings on this device: a new start does not turn them back on.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /Notifications/ }).click();
    await page.getByRole('button', { name: 'Turn off notifications' }).click();
    await page.getByRole('button', { name: 'Turn on notifications' }).waitFor();
    await expect.poll(() => saved(CARA)).toEqual([]);
    await page.reload();
    await page.getByRole('searchbox', { name: 'Search' }).waitFor();
    await page.waitForTimeout(2_000);
    expect(await saved(CARA)).toEqual([]);
    expect(await offer(page).count()).toBe(0);
  });

  it('offers the button where the browser has to ask, and turns them on with one click', async () => {
    const { page, context } = await newPage('ben', 'ben', false);
    await signIn(page, BEN, 'Ben Carter');
    await offer(page).waitFor({ timeout: 15_000 });
    await shot(page, '160-push-offer');
    expect(await saved(BEN)).toEqual([]);
    // The person allows notifications in the browser's question.
    await context.grantPermissions(['notifications'], { origin: WEB_URL });
    await offer(page).getByRole('button', { name: 'Turn on' }).click();
    await offer(page).waitFor({ state: 'detached' });
    await expect.poll(() => saved(BEN)).toEqual(['https://fcm.googleapis.com/fcm/send/e2e-ben']);
  });

  it('puts the offer off for a week with "Not now"', async () => {
    const { page } = await newPage('ana', 'ana', false);
    await signIn(page, ANA, 'Ana Lopez');
    await offer(page).waitFor({ timeout: 15_000 });
    await offer(page).getByRole('button', { name: 'Not now' }).click();
    await offer(page).waitFor({ state: 'detached' });
    await page.reload();
    await page.getByRole('searchbox', { name: 'Search' }).waitFor();
    await page.waitForTimeout(2_000);
    expect(await offer(page).count()).toBe(0);
    const until = await page.evaluate(() => Number(localStorage.getItem('bedo-push-banner-snoozed-until')));
    expect(until - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(violations).toEqual([]);
  });
});
