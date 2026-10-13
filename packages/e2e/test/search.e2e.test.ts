import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, query, type Stack, startStack, waitForCode, WEB_URL } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
}

const ANA = '+201000008001';
const BEN = '+201000008002';
const CARA = '+201000008003';

/**
 * Phase 8 end to end in a real browser (exit gate: results never include inaccessible content): messages found
 * across chats from the chat list search, opened at the message; filters by kind and by sender; another pair's
 * conversation never appears.
 */
describe.runIf(enabled)('Phase 8 global search in the browser', () => {
  let stack: Stack;
  let browser: Browser;
  let ana: Page;
  let ben: Page;
  let cara: Page;
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

  const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
  async function say(page: Page, texts: string[]) {
    for (const text of texts) {
      await composer(page).fill(text);
      await composer(page).press('Enter');
    }
    await page.getByRole('log', { name: 'Messages' }).getByText(texts.at(-1)!).waitFor();
  }
  async function openChatWith(page: Page, username: string, name: string) {
    await page.getByRole('searchbox', { name: 'Search' }).fill(username);
    await page.getByRole('button', { name: new RegExp(`^${name}`) }).first().click();
    await page.getByRole('region', { name: `Chat with ${name}` }).waitFor();
  }

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [ANA, BEN, CARA]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
    ana = await newPage('ana');
    await signIn(ana, ANA, 'Ana Finder');
    ben = await newPage('ben');
    await signIn(ben, BEN, 'Ben Writer');
    cara = await newPage('cara');
    await signIn(cara, CARA, 'Cara Private');
    for (const [phone, username] of [[ANA, 'ana_finder'], [BEN, 'ben_writer'], [CARA, 'cara_private']] as const) {
      await query(stack.ownerUrl, 'update app.users set username = $2 where phone = $1', [phone, username]);
    }
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('finds a message across chats and opens the chat at it', async () => {
    await openChatWith(ben, 'ana_finder', 'Ana Finder');
    await say(ben, ['Physics exam moved to Thursday', 'Bring a calculator', 'And the lab book', 'See you there', 'Bye']);
    // Ben and Cara talk about physics too; Ana is not in that chat.
    await openChatWith(cara, 'ben_writer', 'Ben Writer');
    await say(cara, ['Physics secret between Cara and Ben']);

    await ana.getByRole('searchbox', { name: 'Search' }).fill('physics');
    const found = ana.getByRole('region', { name: 'Messages found' });
    await found.getByText('Physics exam moved to Thursday').waitFor({ timeout: 15_000 });
    await shot(ana, '80-search-results');
    expect(await found.getByText(/secret/).count()).toBe(0);
    expect(await ana.content()).not.toContain('Physics secret');
    await found.getByRole('button', { name: /Physics exam moved to Thursday/ }).click();
    await ana.getByRole('region', { name: 'Chat with Ben Writer' }).waitFor();
    await ana.getByRole('log', { name: 'Messages' }).getByText('Physics exam moved to Thursday').waitFor();
  });

  it('filters by kind and by sender', async () => {
    await ana.getByRole('searchbox', { name: 'Search' }).fill('calculator');
    const found = ana.getByRole('region', { name: 'Messages found' });
    await found.getByText('Bring a calculator').waitFor({ timeout: 15_000 });
    await found.getByRole('button', { name: 'Files', exact: true }).click();
    await found.getByText('No messages found.').waitFor();
    await found.getByRole('button', { name: 'Messages', exact: true }).click();
    await found.getByText('Bring a calculator').waitFor();

    // Messages from Ben, chosen from People, with no words.
    await ana.getByRole('searchbox', { name: 'Search' }).fill('ben_writer');
    await ana.getByRole('button', { name: 'Messages from Ben Writer' }).click();
    await ana.getByRole('searchbox', { name: 'Search' }).fill('');
    await found.getByText('From Ben Writer').waitFor();
    await found.getByText('Bye').waitFor({ timeout: 15_000 });
    await shot(ana, '81-search-from');
    expect(await found.getByRole('listitem').count()).toBe(5);
    await found.getByRole('button', { name: 'Any sender' }).click();
  });

  it('caused no Content-Security-Policy violation or page error anywhere', () => {
    expect(violations).toEqual([]);
  });
});
