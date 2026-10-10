import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, ADMIN_URL, createAdmin, launchBrowser, query, SITE_URL, type Stack, startStack, totpNow, waitForCode, WEB_URL } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: false });
  }
}

const ANA = '+201000013001';
const BEN = '+201000013002';
const ADMIN = '+201000013901';
/** An iPhone-sized screen (CSS pixels), touch input. */
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/**
 * Phase 13 (D-46) end to end: Bedo Chat as a website on a phone. The site is installable (manifest and icons for
 * "Add to Home Screen", which iPhone notifications need), and every main screen of the student app and the Admin
 * Dashboard fits a phone screen without sideways scrolling.
 */
describe.runIf(enabled)('Phase 13: the website on a phone', () => {
  let stack: Stack;
  let browser: Browser;
  let ana: Page;
  let ben: Page;
  const contexts: BrowserContext[] = [];
  const violations: string[] = [];

  async function phonePage(label: string): Promise<Page> {
    const context = await browser.newContext(PHONE);
    contexts.push(context);
    const page = await context.newPage();
    page.on('console', (message) => {
      if (/Content.Security.Policy|Refused to/i.test(message.text())) violations.push(`${label}: ${message.text()}`);
    });
    page.on('pageerror', (error) => violations.push(`${label} page error: ${error.message}`));
    return page;
  }

  /** Nothing on the page is wider than the screen (no sideways scrolling). */
  async function fits(page: Page, where: string) {
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: window.innerWidth }));
    expect(widths.page, `${where}: page ${widths.page}px wide on a ${widths.screen}px screen`).toBeLessThanOrEqual(widths.screen);
  }

  async function signIn(page: Page, phone: string, name: string) {
    await stack.clearCooldown(phone);
    const previous = await stack.latestCode(phone);
    await page.goto(`${WEB_URL}/login`);
    await fits(page, 'sign-in');
    await shot(page, '130-phone-login');
    await page.getByLabel('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Verification code').fill(await waitForCode(stack, phone, previous));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(`${WEB_URL}/`);
  }

  const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
  const messages = (page: Page) => page.getByRole('log', { name: 'Messages' });

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const number of [ANA, BEN]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [number]);
    }
    ana = await phonePage('ana');
    await signIn(ana, ANA, 'Ana Lopez');
    ben = await phonePage('ben');
    await signIn(ben, BEN, 'Ben Brown');
    await query(stack.ownerUrl, `update app.users set username = 'ben_brown' where phone = $1`, [BEN]);
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('is installable: manifest, icons and the Home Screen tags', async () => {
    const manifestHref = await ana.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBe('/manifest.webmanifest');
    expect(await ana.locator('link[rel="apple-touch-icon"]').getAttribute('href')).toBe('/icons/apple-touch-icon.png');
    expect(await ana.locator('meta[name="mobile-web-app-capable"], meta[name="apple-mobile-web-app-capable"]').count()).toBeGreaterThan(0);
    const manifest = await ana.evaluate(async () => {
      const response = await fetch('/manifest.webmanifest');
      return { status: response.status, body: (await response.json()) as { name: string; display: string; start_url: string; icons: Array<{ src: string; sizes: string; purpose: string }> } };
    });
    expect(manifest.status).toBe(200);
    expect(manifest.body).toMatchObject({ name: 'Bedo Chat', display: 'standalone', start_url: '/' });
    expect(manifest.body.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
    for (const path of [...manifest.body.icons.map((icon) => icon.src), '/icons/apple-touch-icon.png', '/favicon.ico']) {
      const response = await fetch(`${SITE_URL}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(/^image\//);
    }
  });

  it('fits every main screen of the student app on a phone', async () => {
    await fits(ana, 'chat list');
    await shot(ana, '131-phone-chats');
    await ana.getByRole('searchbox').fill('ben_brown');
    await ana.getByRole('button', { name: /^Ben Brown/ }).click();
    await composer(ana).fill('Hello Ben, see you in class');
    await composer(ana).press('Enter');
    await messages(ana).getByText('Hello Ben, see you in class').waitFor();
    await fits(ana, 'chat');
    await shot(ana, '132-phone-chat');

    await ben.getByRole('button', { name: /^Ana Lopez/ }).click();
    await messages(ben).getByText('Hello Ben, see you in class').waitFor();
    const bubble = ben.locator('[id^="message-"]', { hasText: 'Hello Ben, see you in class' });
    await bubble.getByRole('button', { name: 'Message actions' }).click();
    await ben.getByRole('menuitem', { name: 'Reply' }).waitFor();
    await fits(ben, 'message actions');
    // The open menu stays inside the screen.
    const menu = await ben.getByRole('menu', { name: 'Message actions' }).boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(PHONE.viewport.width);
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(PHONE.viewport.height);
    await shot(ben, '133-phone-message-actions');
    await ben.keyboard.press('Escape');
    await ben.getByRole('button', { name: 'Back to chats' }).click();
    await ben.getByRole('button', { name: /^Ana Lopez/ }).waitFor();

    await ana.getByRole('button', { name: 'Back to chats' }).click();
    await ana.getByRole('button', { name: 'New group' }).click();
    const dialog = ana.getByRole('dialog', { name: 'New group' });
    await dialog.getByLabel('Group name').fill('Phone group');
    await dialog.getByLabel('Add people').fill('Ben B');
    await dialog.getByRole('list', { name: 'People found' }).getByRole('button', { name: 'Ben Brown' }).click();
    await fits(ana, 'new group');
    await shot(ana, '134-phone-new-group');
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await ana.getByRole('region', { name: 'Group Phone group' }).waitFor();
    await fits(ana, 'group chat');
    await shot(ana, '135-phone-group');

    await ana.getByRole('button', { name: 'Back to chats' }).click();
    await ana.getByRole('button', { name: 'Settings' }).click();
    await fits(ana, 'settings');
    await shot(ana, '136-phone-settings');
    for (const section of ['Privacy', 'Notifications', 'Devices']) {
      await ana.getByRole('button', { name: section, exact: true }).click();
      await fits(ana, section);
      await shot(ana, `137-phone-settings-${section.toLowerCase()}`);
      await ana.getByRole('button', { name: /^Back/ }).first().click();
    }
  });

  it('fits the Admin Dashboard on a phone', async () => {
    const secret = await createAdmin(stack, ADMIN, 'Phone Admin', 'super_admin');
    const page = await phonePage('admin');
    await page.goto(`${ADMIN_URL}/login`);
    await fits(page, 'admin sign-in');
    await page.getByLabel('Phone number').fill(ADMIN);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Authenticator code').fill(totpNow(secret));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Overview' }).waitFor();
    await fits(page, 'admin overview');
    await shot(page, '138-phone-admin-overview');
    // The sections are behind the menu button on a phone.
    expect(await page.getByRole('navigation', { name: 'Sections' }).isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('navigation', { name: 'Sections' }).getByText('Phone Admin · Super Admin').waitFor();
    await fits(page, 'admin menu');
    await shot(page, '138-phone-admin-menu');
    await page.getByRole('button', { name: 'Menu' }).click();
    for (const [button, heading] of [
      ['Users', 'Users'],
      ['Groups and channels', 'Groups and channels'],
      ['Reports', 'Reports'],
      ['Broadcast notifications', 'Broadcast notifications'],
    ] as const) {
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: button, exact: true }).click();
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      await fits(page, `admin ${heading}`);
      await shot(page, `139-phone-admin-${heading.split(' ')[0]!.toLowerCase()}`);
    }
    expect(violations).toEqual([]);
  });
});
