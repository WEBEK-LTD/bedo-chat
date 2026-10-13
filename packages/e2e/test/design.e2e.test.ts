import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, ADMIN_URL, createAdmin, launchBrowser, query, type Stack, startStack, totpNow, waitForCode, WEB_URL } from './stack.js';

/** Set E2E_SCREENSHOTS=<folder> to save screenshots of every screen below, light and dark, phone and computer. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png` });
  }
}

const enabled = Boolean(process.env.TEST_DATABASE_URL);

const ANA = '+201000014001';
const BEN = '+201000014002';
const CARA = '+201000014003';
const ADMIN = '+201000014900';

const LIGHT_BG = 'rgb(255, 255, 255)';
const DARK_BG = 'rgb(19, 28, 39)';

const SIZES = {
  computer: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
} as const;

/**
 * Phase 14 (D-48): the new look. Light and dark follow the device until the person picks one (student app:
 * Settings → Appearance, kept in a cookie so the first paint is already right; Admin Dashboard: the header button,
 * kept in this browser); the self-hosted Figtree font loads under the strict Content-Security-Policy.
 */
describe.runIf(enabled)('Phase 14 design: light and dark themes on the one site', () => {
  let stack: Stack;
  let browser: Browser;
  let adminSecret: Buffer;
  const contexts: BrowserContext[] = [];
  const violations: string[] = [];

  async function newPage(label: string, colorScheme: 'light' | 'dark', size: keyof typeof SIZES): Promise<Page> {
    const context = await browser.newContext({ colorScheme, viewport: SIZES[size], isMobile: size === 'phone', hasTouch: size === 'phone' });
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

  // An authenticator code works once (replay protection), so each sign-in waits for a fresh one.
  let lastCode = '';
  async function freshCode(): Promise<string> {
    while (totpNow(adminSecret) === lastCode) await new Promise((resolve) => setTimeout(resolve, 500));
    lastCode = totpNow(adminSecret);
    return lastCode;
  }

  async function adminSignIn(page: Page) {
    await page.goto(`${ADMIN_URL}/login`);
    await page.getByLabel('Phone number').fill(ADMIN);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Authenticator code').fill(await freshCode());
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Overview' }).waitFor();
  }

  const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const figtreeLoaded = (page: Page) =>
    page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].some((face) => face.family.replace(/"/g, '') === 'Figtree' && face.status === 'loaded');
    });
  const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

  async function openChatWithBen(page: Page) {
    await page.getByRole('button', { name: /^Ben Carter/ }).click();
    await page.getByRole('region', { name: 'Chat with Ben Carter' }).waitFor();
    await page.getByRole('log', { name: 'Messages' }).getByText('See you at nine').waitFor();
  }

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [ANA, BEN, CARA]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
    adminSecret = await createAdmin(stack, ADMIN, 'Head Office', 'super_admin');

    // A short conversation to look at: Ana writes to Ben, Ben answers.
    const ana = await newPage('setup-ana', 'light', 'computer');
    await signIn(ana, ANA, 'Ana Lopez');
    const ben = await newPage('setup-ben', 'light', 'computer');
    await signIn(ben, BEN, 'Ben Carter');
    await ana.getByRole('searchbox', { name: 'Search' }).fill('Ben C');
    await ana.getByRole('button', { name: /^Ben Carter/ }).click();
    await ana.getByRole('region', { name: 'Chat with Ben Carter' }).waitFor();
    for (const text of ['Hi Ben! Did you finish the reading for tomorrow?', 'The chapter on cell biology is long 😅']) {
      await composer(ana).fill(text);
      await composer(ana).press('Enter');
      await ana.getByRole('log', { name: 'Messages' }).getByText(text).waitFor();
    }
    await ben.getByRole('button', { name: /^Ana Lopez/ }).click();
    for (const text of ['Almost, two pages left.', 'See you at nine in the library']) {
      await composer(ben).fill(text);
      await composer(ben).press('Enter');
      await ben.getByRole('log', { name: 'Messages' }).getByText(text).waitFor();
    }
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const size of ['computer', 'phone'] as const) {
      it(`follows the device in ${scheme} on a ${size}: sign-in, chats, a chat and settings`, async () => {
        const page = await newPage(`${scheme}-${size}`, scheme, size);
        await page.goto(`${WEB_URL}/login`);
        await page.getByLabel('Phone number').waitFor();
        expect(await background(page)).toBe(scheme === 'dark' ? DARK_BG : LIGHT_BG);
        expect(await figtreeLoaded(page)).toBe(true);
        await shot(page, `${scheme}-${size}-01-sign-in`);

        await signIn(page, ANA, null);
        await page.getByRole('button', { name: /^Ben Carter/ }).waitFor();
        await shot(page, `${scheme}-${size}-02-chats`);
        await openChatWithBen(page);
        await shot(page, `${scheme}-${size}-03-chat`);

        if (size === 'phone') await page.getByRole('button', { name: 'Back to chats' }).click();
        await page.getByRole('button', { name: 'Settings' }).click();
        await page.getByRole('button', { name: 'Appearance' }).waitFor();
        await shot(page, `${scheme}-${size}-04-settings`);
        await page.getByRole('button', { name: 'Appearance' }).click();
        await shot(page, `${scheme}-${size}-05-appearance`);
        expect(await page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBeNull();
      });
    }
  }

  it('keeps the theme the student picked, from the first paint after a reload', async () => {
    const page = await newPage('picked', 'light', 'computer');
    await signIn(page, CARA, 'Cara Diaz');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Appearance' }).click();
    await page.getByRole('radio', { name: /^Dark/ }).check();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(await background(page)).toBe(DARK_BG);

    // The server writes the choice into the page itself, so there is no light flash before the script runs.
    const response = await page.goto(`${WEB_URL}/`);
    expect(await response!.text()).toMatch(/<html[^>]*data-theme="dark"/);
    expect(await background(page)).toBe(DARK_BG);

    // Back to the device's setting: the attribute goes and the device (light here) decides.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Appearance' }).click();
    await page.getByRole('radio', { name: /^Same as this device/ }).check();
    expect(await page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBeNull();
    expect(await background(page)).toBe(LIGHT_BG);
  });

  for (const scheme of ['light', 'dark'] as const) {
    for (const size of ['computer', 'phone'] as const) {
      it(`shows the Admin Dashboard in ${scheme} on a ${size}`, async () => {
        const page = await newPage(`admin-${scheme}-${size}`, scheme, size);
        await page.goto(`${ADMIN_URL}/login`);
        await page.getByLabel('Phone number').waitFor();
        expect(await background(page)).toBe(scheme === 'dark' ? DARK_BG : LIGHT_BG);
        expect(await figtreeLoaded(page)).toBe(true);
        await shot(page, `admin-${scheme}-${size}-01-sign-in`);
        await adminSignIn(page);
        await page.getByLabel('Accounts').first().waitFor();
        await shot(page, `admin-${scheme}-${size}-02-overview`);
        if (size === 'phone') {
          await page.getByRole('button', { name: 'Menu' }).click();
          await shot(page, `admin-${scheme}-${size}-03-menu`);
        }
        await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Users' }).click();
        await page.getByRole('heading', { name: 'Users' }).waitFor();
        await shot(page, `admin-${scheme}-${size}-04-users`);
      });
    }
  }

  it('lets an admin switch the dashboard theme and keeps it in this browser', async () => {
    const page = await newPage('admin-toggle', 'light', 'computer');
    await adminSignIn(page);
    const toggle = page.getByRole('button', { name: /^Theme: / });
    await expect.poll(() => toggle.getAttribute('title')).toBe('Theme: same as device');
    await toggle.click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await toggle.click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(await background(page)).toBe(DARK_BG);

    // Kept after a reload.
    await page.reload();
    await page.getByRole('heading', { name: 'Overview' }).waitFor();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await expect.poll(() => page.getByRole('button', { name: /^Theme: / }).getAttribute('title')).toBe('Theme: dark');
    await page.getByRole('button', { name: /^Theme: / }).click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBeNull();
    expect(violations).toEqual([]);
  });
});
