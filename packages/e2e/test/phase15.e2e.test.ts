import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, query, type Stack, startStack, waitForCode, WEB_URL } from './stack.js';

/** Set E2E_SCREENSHOTS=<folder> to save screenshots of the country picker. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png` });
  }
}

const enabled = Boolean(process.env.TEST_DATABASE_URL);

const TURKISH = '+905321234567';
const AUSTRALIAN = '+61412345678';

/**
 * Phase 15 in the browser: the phone field with a country picker (Australia first, search by name or code, the
 * national 0 dropped, the full number sent to WhatsApp), and the sender's picture next to incoming messages.
 */
describe.runIf(enabled)('Phase 15 country picker and sender pictures', () => {
  let stack: Stack;
  let browser: Browser;
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

  const country = (page: Page) => page.getByRole('button', { name: /^Country: / });

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [TURKISH, AUSTRALIAN]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('signs in a Turkish number typed with its national 0 after choosing Türkiye', async () => {
    const page = await newPage('turkish');
    await page.goto(`${WEB_URL}/login`);
    // Australia is shown first, with its flag.
    await country(page).getByText('+61').waitFor();
    expect(await country(page).getAttribute('aria-label')).toBe('Country: Australia (+61)');
    await expect.poll(() => country(page).locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);

    await country(page).click();
    await page.getByRole('searchbox', { name: 'Search country or code' }).fill('tur');
    await page.waitForTimeout(500);
    await shot(page, '70-country-picker');
    await page.getByRole('option', { name: /Türkiye/ }).click();
    expect(await country(page).getAttribute('aria-label')).toBe('Country: Türkiye (+90)');
    // By calling code too.
    await country(page).click();
    await page.getByRole('searchbox', { name: 'Search country or code' }).fill('+90');
    expect(await page.getByRole('option').first().textContent()).toContain('Türkiye');
    await page.keyboard.press('Escape');

    const previous = await stack.latestCode(TURKISH);
    await page.getByLabel('Phone number').fill('0532 123 45 67');
    await page.getByRole('button', { name: 'Continue' }).click();
    // WhatsApp gets the full international number: the country code was added and the 0 dropped.
    const code = await waitForCode(stack, TURKISH, previous);
    await page.getByLabel('Verification code').fill(code);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Name').fill('Tuna Kaya');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(`${WEB_URL}/`);
  });

  it('switches the country by itself when a full international number is typed, and remembers the last country', async () => {
    const page = await newPage('australian');
    await page.goto(`${WEB_URL}/login`);
    await country(page).click();
    await page.getByRole('searchbox', { name: 'Search country or code' }).fill('egy');
    await page.getByRole('option', { name: /Egypt/ }).click();
    await page.getByLabel('Phone number').fill('+61 412 345 678');
    expect(await country(page).getAttribute('aria-label')).toBe('Country: Australia (+61)');
    expect(await page.getByLabel('Phone number').inputValue()).toBe('412345678');
    const previous = await stack.latestCode(AUSTRALIAN);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Verification code').fill(await waitForCode(stack, AUSTRALIAN, previous));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Name').fill('Abby Reid');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(`${WEB_URL}/`);

    // Abby writes to Tuna; Tuna sees Abby's picture next to her message (no picture uploaded: her initials).
    await page.getByRole('searchbox', { name: 'Search' }).fill('Tuna K');
    await page.getByRole('button', { name: /^Tuna Kaya/ }).click();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Merhaba Tuna!');
    await composer.press('Enter');
    await composer.fill('See you in class');
    await composer.press('Enter');
    await page.getByRole('log', { name: 'Messages' }).getByText('See you in class').waitFor();
    // Her own messages carry no picture.
    expect(await page.getByTestId('sender-avatar').count()).toBe(0);
  });

  it('shows the sender’s picture once under their run of messages', async () => {
    const tuna = await newPage('tuna-again');
    await stack.clearCooldown(TURKISH);
    const previous = await stack.latestCode(TURKISH);
    await tuna.goto(`${WEB_URL}/login`);
    await country(tuna).click();
    await tuna.getByRole('searchbox', { name: 'Search country or code' }).fill('90');
    await tuna.keyboard.press('Enter');
    await tuna.getByLabel('Phone number').fill('5321234567');
    await tuna.getByRole('button', { name: 'Continue' }).click();
    await tuna.getByLabel('Verification code').fill(await waitForCode(stack, TURKISH, previous));
    await tuna.getByRole('button', { name: 'Sign in' }).click();
    await tuna.waitForURL(`${WEB_URL}/`);
    await tuna.getByRole('button', { name: /^Abby Reid/ }).click();
    const log = tuna.getByRole('log', { name: 'Messages' });
    await log.getByText('See you in class').waitFor();
    // Two messages in a row from Abby: one picture, under the last.
    expect(await log.getByTestId('sender-avatar').count()).toBe(1);
    await log.getByTestId('sender-avatar').getByText('AR').waitFor();
    expect(violations).toEqual([]);
  });
});
