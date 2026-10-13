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
const DAN = '+201000016004';
const EVA = '+201000016005';
const ANDROID_TOKEN = `e2e-android:APA91b${'x'.repeat(60)}`;

/**
 * D-58: the Android app's channel (window.bedoAndroid, a web message listener in the real app) replaced by a stand-in
 * that answers like the app: the phone's permission, then the Firebase address once allowed. Every message the page
 * sends is kept in window.__bedoAndroidSent for the test to read.
 */
function fakeAndroidApp(permission: 'default' | 'denied') {
  return `(() => {
    let state = ${JSON.stringify(permission)};
    const listeners = [];
    window.__bedoAndroidSent = [];
    const answer = (id, result) => setTimeout(() => listeners.forEach((listener) => listener({ data: JSON.stringify({ id, result }) })), 10);
    window.bedoAndroid = {
      addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
      postMessage(text) {
        const message = JSON.parse(text);
        window.__bedoAndroidSent.push(message);
        const endpoint = state === 'granted' ? 'https://fcm.googleapis.com/v1/bedochat-android/${ANDROID_TOKEN}' : null;
        if (message.type === 'push-status') answer(message.id, { permission: state, endpoint });
        else if (message.type === 'push-enable') {
          if (state === 'default') state = 'granted';
          answer(message.id, { permission: state, endpoint: state === 'granted' ? 'https://fcm.googleapis.com/v1/bedochat-android/${ANDROID_TOKEN}' : null });
        } else answer(message.id, true);
      },
    };
  })();`;
}

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

  async function androidPage(label: string, permission: 'default' | 'denied'): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    await context.addInitScript({ content: fakeAndroidApp(permission) });
    const page = await context.newPage();
    page.on('pageerror', (error) => violations.push(`${label} page error: ${error.message}`));
    return page;
  }

  const sentToApp = (page: Page) => page.evaluate(() => (window as unknown as { __bedoAndroidSent: Array<{ type: string }> }).__bedoAndroidSent.map((message) => message.type));

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
    for (const phone of [ANA, BEN, CARA, DAN, EVA]) {
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

  it('D-58: in the Android app, asks the phone at sign-in and saves the app’s Firebase address', async () => {
    const page = await androidPage('dan', 'default');
    await signIn(page, DAN, 'Dan Evans');
    await expect.poll(() => saved(DAN), { timeout: 15_000 }).toEqual([`https://fcm.googleapis.com/v1/bedochat-android/${ANDROID_TOKEN}`]);
    const keys = await query<{ p256dh: string; auth: string }>(
      stack.ownerUrl,
      'select s.p256dh, s.auth from app.push_subscriptions s join app.users u on u.id = s.user_id where u.phone = $1',
      [DAN],
    );
    expect(keys.rows).toEqual([{ p256dh: 'fcm', auth: 'fcm' }]);
    await page.getByRole('searchbox', { name: 'Search' }).waitFor();
    // No browser banner in the app; the app was asked for its status, then to turn notifications on, and given the badge.
    expect(await offer(page).count()).toBe(0);
    await expect.poll(() => sentToApp(page)).toEqual(expect.arrayContaining(['push-status', 'push-enable', 'badge']));
    // Settings → Notifications says they are on, and turns them off like on the website.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /Notifications/ }).click();
    await page.getByRole('button', { name: 'Turn off notifications' }).click();
    await expect.poll(() => saved(DAN)).toEqual([]);
  });

  it('D-58: in the Android app with notifications blocked, Settings opens the phone’s settings for the app', async () => {
    const page = await androidPage('eva', 'denied');
    await signIn(page, EVA, 'Eva Green');
    await page.getByRole('searchbox', { name: 'Search' }).waitFor();
    await page.waitForTimeout(1_500);
    expect(await saved(EVA)).toEqual([]);
    expect(await offer(page).count()).toBe(0);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /Notifications/ }).click();
    await page.getByText('Notifications are off for Bedo Chat on this phone.').waitFor();
    await page.getByRole('button', { name: 'Open Settings' }).click();
    await expect.poll(() => sentToApp(page)).toContain('open-settings');
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
