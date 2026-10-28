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
    // D-54: the brand files too (logo, icon, the notification badge).
    const brand = ['/icons/bedo-icon.svg', '/icons/bedo-chat-logo.svg', '/icons/bedo-chat-logo-white.svg', '/icons/badge-96.png'];
    for (const path of [...manifest.body.icons.map((icon) => icon.src), '/icons/apple-touch-icon.png', '/favicon.ico', ...brand]) {
      const response = await fetch(`${SITE_URL}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(/^image\//);
    }
  });

  it('D-54: shows the Bedo Chat logo on both sign-in pages, navy on light screens and white on dark ones', async () => {
    for (const [url, scheme, file] of [
      [`${WEB_URL}/login`, 'light', 'bedo-chat-logo.svg'],
      [`${WEB_URL}/login`, 'dark', 'bedo-chat-logo-white.svg'],
      [`${ADMIN_URL}/login`, 'light', 'bedo-chat-logo.svg'],
      [`${ADMIN_URL}/login`, 'dark', 'bedo-chat-logo-white.svg'],
    ] as const) {
      const context = await browser.newContext({ ...PHONE, colorScheme: scheme });
      contexts.push(context);
      const page = await context.newPage();
      page.on('console', (message) => {
        if (/Content.Security.Policy|Refused to/i.test(message.text())) violations.push(`logo ${url}: ${message.text()}`);
      });
      await page.goto(url);
      const logo = page.getByRole('img', { name: 'Bedo Chat, Australian Dental Academy' });
      await logo.waitFor();
      // Exactly one of the two versions shows, and it is loaded.
      const shown = await logo.locator('img').evaluateAll((images) =>
        (images as HTMLImageElement[]).filter((img) => img.getBoundingClientRect().width > 0).map((img) => ({ src: img.src, loaded: img.complete && img.naturalWidth > 0 })),
      );
      expect(shown, `${url} ${scheme}`).toEqual([{ src: expect.stringContaining(`/icons/${file}`), loaded: true }]);
      await shot(page, `135-logo-${url.includes('/admin') ? 'admin' : 'web'}-${scheme}`);
    }
    expect(violations).toEqual([]);
  });

  it('D-57: the privacy policy and support pages open from the sign-in page, styled, with no policy refusal', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ ...PHONE, colorScheme: scheme });
      contexts.push(context);
      const page = await context.newPage();
      page.on('console', (message) => {
        if (/Content.Security.Policy|Refused to/i.test(message.text())) violations.push(`info ${scheme}: ${message.text()}`);
      });
      page.on('pageerror', (error) => violations.push(`info ${scheme} page error: ${error.message}`));
      for (const [link, heading, file] of [
        ['Privacy policy', 'Privacy policy', 'privacy'],
        ['Help and support', 'Help and support', 'support'],
      ] as const) {
        await page.goto(`${WEB_URL}/login`);
        await page.getByRole('navigation', { name: 'About Bedo Chat' }).getByRole('link', { name: link }).click();
        await page.getByRole('heading', { level: 1, name: heading }).waitFor();
        expect(new URL(page.url()).pathname).toBe(`/${file}`);
        // Its own stylesheet applies (card on the wallpaper), the right logo is loaded, and it fits a phone.
        const look = await page.evaluate(() => {
          const card = document.querySelector('.card');
          const img = document.querySelector('.brand img') as HTMLImageElement;
          return {
            radius: card ? getComputedStyle(card).borderTopLeftRadius : '',
            logo: img.currentSrc,
            loaded: img.complete && img.naturalWidth > 0,
          };
        });
        expect(look.radius, `${file} ${scheme}`).toBe('16px');
        expect(look.logo).toContain(scheme === 'dark' ? '/icons/bedo-chat-logo-white.svg' : '/icons/bedo-chat-logo.svg');
        expect(look.loaded).toBe(true);
        await fits(page, `${file} ${scheme}`);
        const response = await fetch(`${SITE_URL}/${file}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
        expect(response.headers.get('content-security-policy')).not.toContain('script-src');
        await shot(page, `136-${file}-${scheme}`);
        // Back to the app from the page.
        await page.getByRole('link', { name: 'Open Bedo Chat' }).click();
        await page.waitForURL(/\/login/);
      }
    }
    expect(violations).toEqual([]);
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

  it('text fields are at least 16px on touch screens, so iPhone does not zoom in when typing', async () => {
    const fontSize = (page: Page, selector: string) =>
      page.locator(selector).first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    // Phone (touch): the sign-in fields of both apps and the message box.
    const context = await browser.newContext(PHONE);
    contexts.push(context);
    const phone = await context.newPage();
    for (const url of [`${WEB_URL}/login`, `${ADMIN_URL}/login`]) {
      await phone.goto(url);
      await phone.locator('input:not([type="checkbox"])').first().waitFor();
      for (const field of await phone.locator('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), textarea, select').all()) {
        expect(await field.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)), url).toBeGreaterThanOrEqual(16);
      }
    }
    await ana.goto(`${WEB_URL}/`);
    await ana.getByRole('button', { name: /^Ben Brown/ }).first().click();
    await composer(ana).waitFor();
    expect(await composer(ana).evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    // Computer (mouse): the design's own sizes stay.
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contexts.push(desktop);
    const computer = await desktop.newPage();
    await computer.goto(`${WEB_URL}/login`);
    await computer.getByLabel('Phone number').waitFor();
    expect(await fontSize(computer, 'input[type="tel"], input[inputmode="tel"], input')).toBeLessThan(16);
  });

  it('holding a message or a chat opens its menu (Telegram-like), and the chat header stays on screen with the keyboard', async () => {
    const cdp = await ana.context().newCDPSession(ana);
    /** A finger held on the middle of an element for 700 ms (a long press), then lifted. */
    const hold = async (selector: ReturnType<Page['locator']>) => {
      const box = (await selector.boundingBox())!;
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await ana.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await ana.goto(`${WEB_URL}/`);
    await ana.getByRole('button', { name: /^Ben Brown/ }).first().click();
    await composer(ana).waitFor();
    // A message: its menu opens where it is held; Reply works from it.
    const bubble = ana.getByTestId('message-bubble').filter({ hasText: 'Hello Ben, see you in class' }).first();
    await hold(bubble);
    const messageMenu = ana.getByRole('menu', { name: 'Message actions' });
    await messageMenu.waitFor();
    await shot(ana, '140-phone-hold-message');
    await messageMenu.getByRole('menuitem', { name: 'Reply' }).click();
    await messageMenu.waitFor({ state: 'detached' });
    await ana.getByRole('button', { name: 'Cancel reply' }).waitFor();
    await ana.getByRole('button', { name: 'Cancel reply' }).click();
    // A tap (not a hold) does not open the menu.
    await bubble.tap();
    await ana.waitForTimeout(800);
    expect(await ana.getByRole('menu', { name: 'Message actions' }).count()).toBe(0);
    // The keyboard: on iPhone it covers the bottom of the page. The chat screen follows the visible area, so the
    // header with the chat's name stays at the top and the message box above the keyboard.
    await ana.setViewportSize({ width: 390, height: 480 });
    await ana.waitForTimeout(500);
    const header = await ana.getByRole('region', { name: 'Chat with Ben Brown' }).getByText('Ben Brown', { exact: true }).first().boundingBox();
    const box = await composer(ana).boundingBox();
    expect(header!.y).toBeGreaterThanOrEqual(0);
    expect(header!.y).toBeLessThan(80);
    expect(box!.y + box!.height).toBeLessThanOrEqual(480);
    await shot(ana, '141-phone-keyboard-space');
    await ana.setViewportSize(PHONE.viewport);
    // A chat in the list: hold it for its menu (Pin, Archive, …); the hold does not open the chat.
    await ana.goto(`${WEB_URL}/`);
    const row = ana.getByRole('button', { name: /^Ben Brown/ }).first();
    await row.waitFor();
    await hold(row);
    const chatMenu = ana.getByRole('menu', { name: 'Actions for Ben Brown' });
    await chatMenu.waitFor();
    expect(await composer(ana).count()).toBe(0);
    await shot(ana, '142-phone-hold-chat');
    await ana.keyboard.press('Escape');
    await chatMenu.waitFor({ state: 'detached' });
    // With a mouse, a right click opens the same menu.
    await row.click({ button: 'right' });
    await chatMenu.waitFor();
    await chatMenu.getByRole('menuitem', { name: 'Pin' }).click();
    await chatMenu.waitFor({ state: 'detached' });
    // Pinned: the menu now offers Unpin.
    await row.click({ button: 'right' });
    await chatMenu.getByRole('menuitem', { name: 'Unpin' }).click();
    expect(violations).toEqual([]);
  });

  it('swipes right to go back, like Telegram: from a chat, a Settings page and a profile', async () => {
    const cdp = await ana.context().newCDPSession(ana);
    /** A finger dragged from one point to another in small steps (about 60 frames a second), then lifted. */
    const swipe = async (from: { x: number; y: number }, to: { x: number; y: number }, options: { lift?: boolean; steps?: number } = {}) => {
      const steps = options.steps ?? 10;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      for (let step = 1; step <= steps; step += 1) {
        const point = { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
        await ana.waitForTimeout(16);
      }
      if (options.lift !== false) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    // Hidden from screen readers while it only shows under the swipe, so found by its element.
    const list = ana.locator('aside[aria-label="Chats"]');
    const openBen = async () => {
      await ana.getByRole('button', { name: /^Ben Brown/ }).first().click();
      await composer(ana).waitFor();
    };
    await ana.goto(`${WEB_URL}/`);
    await openBen();
    // A short drag and an upward scroll leave the chat open.
    await swipe({ x: 60, y: 420 }, { x: 110, y: 420 });
    await ana.waitForTimeout(400);
    expect(await composer(ana).isVisible()).toBe(true);
    await swipe({ x: 200, y: 600 }, { x: 215, y: 300 });
    await ana.waitForTimeout(400);
    expect(await composer(ana).isVisible()).toBe(true);
    // Half way: the chat follows the finger and the chat list shows underneath.
    await swipe({ x: 40, y: 420 }, { x: 220, y: 420 }, { lift: false });
    expect(await list.isVisible()).toBe(true);
    const moved = await ana.getByRole('region', { name: 'Chat with Ben Brown' }).boundingBox();
    expect(moved!.x).toBeGreaterThan(120);
    await shot(ana, '143-phone-swipe-back');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // Released past a third of the screen: back to the chat list.
    await composer(ana).waitFor({ state: 'detached' });
    await ana.getByRole('button', { name: /^Ben Brown/ }).first().waitFor();
    // The profile of the person: swiped away, the chat stays open.
    await openBen();
    await ana.getByRole('region', { name: 'Chat with Ben Brown' }).getByRole('button', { name: /Ben Brown/ }).first().click();
    const profile = ana.getByRole('dialog', { name: 'Profile' });
    await profile.waitFor();
    await swipe({ x: 40, y: 500 }, { x: 330, y: 500 });
    await profile.waitFor({ state: 'detached' });
    expect(await composer(ana).isVisible()).toBe(true);
    await swipe({ x: 40, y: 420 }, { x: 330, y: 420 });
    await composer(ana).waitFor({ state: 'detached' });
    // Settings: a page goes back to the menu (shown underneath while swiping), the menu closes Settings.
    await ana.getByRole('button', { name: 'Settings' }).click();
    await ana.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Privacy' }).click();
    await ana.getByRole('dialog', { name: 'Privacy' }).waitFor();
    await swipe({ x: 40, y: 500 }, { x: 230, y: 500 }, { lift: false });
    await ana.getByText('Edit profile').first().waitFor();
    await shot(ana, '144-phone-swipe-settings');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await ana.getByRole('dialog', { name: 'Privacy' }).waitFor({ state: 'detached' });
    await ana.getByRole('dialog', { name: 'Settings' }).waitFor();
    await swipe({ x: 40, y: 600 }, { x: 330, y: 600 });
    await ana.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });
    await ana.getByRole('button', { name: /^Ben Brown/ }).first().waitFor();
    expect(violations).toEqual([]);
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
