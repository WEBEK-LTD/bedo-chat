import { readFileSync } from 'node:fs';
import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, ADMIN_URL, createAdmin, launchBrowser, query, type Stack, startStack, totpNow, waitForCode, WEB_URL } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

const ANA = '+201000015001';
const BEN = '+201000015002';
const ADMIN = '+201000015900';

const manifest = JSON.parse(readFileSync(new URL('../../../apps/admin/public/starter-stickers/manifest.json', import.meta.url), 'utf8')) as {
  packs: Array<{ name: string; stickers: Array<{ file: string; emoji: string }> }>;
};
const TOTAL = manifest.packs.reduce((sum, pack) => sum + pack.stickers.length, 0);

/**
 * Phase 14.3: a Super Admin adds the starter sticker packs with one button; each sticker goes through the normal
 * upload (checked and stored), pressing the button again adds nothing twice, and students can send them.
 */
describe.runIf(enabled)('Phase 14.3 starter sticker packs', () => {
  let stack: Stack;
  let browser: Browser;
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

  async function signIn(phone: string, name: string): Promise<Page> {
    const page = await newPage(name);
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
    return page;
  }

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [ANA, BEN]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('adds all starter packs once, and students can send them', async () => {
    expect(manifest.packs).toHaveLength(6);
    expect(TOTAL).toBe(578);
    for (const pack of manifest.packs) expect(pack.stickers.length).toBeLessThanOrEqual(120);

    const secret = await createAdmin(stack, ADMIN, 'Sticker Admin', 'super_admin');
    const admin = await newPage('admin');
    await admin.goto(`${ADMIN_URL}/login`);
    await admin.getByLabel('Phone number').fill(ADMIN);
    await admin.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Continue' }).click();
    await admin.getByLabel('Authenticator code').fill(totpNow(secret));
    await admin.getByRole('button', { name: 'Sign in' }).click();
    await admin.getByRole('heading', { name: 'Overview' }).waitFor();
    await admin.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Stickers and GIFs' }).click();

    await admin.getByRole('button', { name: 'Add starter stickers' }).click();
    await admin.getByText('All starter stickers are in.').waitFor({ timeout: 240_000 });
    const counts = await query<{ name: string; n: number }>(
      stack.ownerUrl,
      'select p.name, count(s.id)::int as n from app.sticker_packs p left join app.stickers s on s.pack_id = p.id group by p.name order by p.name',
    );
    expect(Object.fromEntries(counts.rows.map((row) => [row.name, row.n]))).toEqual(Object.fromEntries(manifest.packs.map((pack) => [pack.name, pack.stickers.length])));
    // Packs show a few stickers until opened.
    const faces = admin.getByRole('article', { name: 'Pack Faces' });
    expect(await faces.getByRole('listitem').count()).toBe(12);
    await faces.getByRole('button', { name: /Show all \d+ stickers/ }).click();
    expect(await faces.getByRole('listitem').count()).toBe(manifest.packs[0]!.stickers.length);

    // Again: nothing is added twice.
    await admin.reload();
    await admin.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Stickers and GIFs' }).click();
    await admin.getByRole('button', { name: 'Add starter stickers' }).click();
    await admin.getByText('All starter stickers are in.').waitFor({ timeout: 60_000 });
    expect((await query<{ n: number }>(stack.ownerUrl, 'select count(*)::int as n from app.stickers')).rows[0]!.n).toBe(TOTAL);
    expect((await query<{ n: number }>(stack.ownerUrl, 'select count(*)::int as n from app.sticker_packs')).rows[0]!.n).toBe(6);

    // Students see the packs in the picker and can send one.
    const ana = await signIn(ANA, 'Ana Lopez');
    await signIn(BEN, 'Ben Carter');
    await ana.getByRole('searchbox', { name: 'Search' }).fill('Ben C');
    await ana.getByRole('button', { name: /^Ben Carter/ }).click();
    await ana.getByRole('region', { name: 'Chat with Ben Carter' }).waitFor();
    await ana.getByRole('button', { name: 'Emoji, stickers and GIFs' }).click();
    await ana.getByRole('tab', { name: 'Stickers' }).click();
    for (const pack of manifest.packs) await ana.getByRole('heading', { name: pack.name }).waitFor();
    const first = manifest.packs[0]!.stickers[0]!;
    await ana.getByRole('button', { name: `Send sticker ${first.emoji}` }).first().click();
    const sent = ana.getByRole('log', { name: 'Messages' }).getByRole('img', { name: `Sticker ${first.emoji}` });
    await sent.waitFor({ timeout: 10_000 });
    await expect.poll(() => sent.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(256);
    expect(violations).toEqual([]);
  });
});
