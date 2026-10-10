import { deflateSync } from 'node:zlib';
import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, query, type Stack, startStack, waitForCode, WEB_URL } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

const ANA = '+201000016001';
const BEN = '+201000016002';

/** A real PNG image (solid colour), so the browser can decode, resize and preview it. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, index) => rgb[index % 3]!)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Phase 14.4: the app opens from what this browser keeps. The chat list shows before the session check answers;
 * pictures are kept after their first download and shown again without the network; a session ended elsewhere
 * still signs the browser out and erases what it kept.
 */
describe.runIf(enabled)('Phase 14.4 opening from the browser cache', () => {
  let stack: Stack;
  let browser: Browser;
  let ana: Page;
  let ben: Page;
  let benContext: BrowserContext;
  const contexts: BrowserContext[] = [];

  async function signIn(phone: string, name: string): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
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
    return { page, context };
  }

  const messages = (page: Page) => page.getByRole('log', { name: 'Messages' });
  const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
  const keptPictures = (page: Page) => page.evaluate(async () => (await (await caches.open('bedo-media-v1')).keys()).length);

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [ANA, BEN]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
    ana = (await signIn(ANA, 'Ana Lopez')).page;
    const signedBen = await signIn(BEN, 'Ben Carter');
    ben = signedBen.page;
    benContext = signedBen.context;
    await ana.getByRole('searchbox', { name: 'Search' }).fill('Ben C');
    await ana.getByRole('button', { name: /^Ben Carter/ }).click();
    await composer(ana).fill('Notes for tomorrow');
    await composer(ana).press('Enter');
    await ana.getByLabel('Choose files').setInputFiles({ name: 'board.png', mimeType: 'image/png', buffer: png(600, 400, [30, 120, 200]) });
    await ana.getByText(/^Photo · /).waitFor();
    await ana.getByRole('button', { name: 'Send', exact: true }).click();
    await ben.getByRole('button', { name: /^Ana Lopez/ }).click();
    const photo = messages(ben).getByRole('button', { name: 'Open photo' });
    await photo.waitFor({ timeout: 10_000 });
    await photo.locator('img').evaluate(
      (img: HTMLImageElement) =>
        new Promise<void>((resolve) => {
          const check = () => (img.complete && img.naturalWidth > 0 ? resolve() : setTimeout(check, 100));
          check();
        }),
    );
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('keeps a picture after its first download and shows it again without the network', async () => {
    await expect.poll(() => keptPictures(ben)).toBeGreaterThan(0);
    // Storage is now unreachable: the picture still shows, from this browser.
    await benContext.route('https://localhost:3400/storage/**', (route) => route.abort());
    await ben.reload();
    await ben.getByRole('button', { name: /^Ana Lopez/ }).click();
    const photo = messages(ben).getByRole('button', { name: 'Open photo' });
    await photo.waitFor();
    await expect.poll(() => photo.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth && img.src.startsWith('blob:'))).toBeTruthy();
    await benContext.unroute('https://localhost:3400/storage/**');
  });

  it('shows the chats before the session check answers', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshAnswered = false;
    await benContext.route('**/api/v1/auth/refresh', async (route) => {
      await held;
      await route.continue();
      refreshAnswered = true;
    });
    await ben.reload();
    // The chat list (from this browser) is there while the server has not answered yet.
    await ben.getByRole('button', { name: /^Ana Lopez/ }).waitFor({ timeout: 5_000 });
    expect(refreshAnswered).toBe(false);
    release();
    await expect.poll(() => refreshAnswered).toBe(true);
    await benContext.unroute('**/api/v1/auth/refresh');
    // Once it answers, the app goes on as usual: new messages arrive.
    await ben.getByRole('button', { name: /^Ana Lopez/ }).click();
    await composer(ana).fill('Still there?');
    await composer(ana).press('Enter');
    await messages(ben).getByText('Still there?').waitFor({ timeout: 15_000 });
  });

  it('still signs out (and erases what it kept) when the session was ended elsewhere', async () => {
    await query(stack.ownerUrl, "update app.sessions set revoked_at = now(), revoke_reason = 'terminated_by_user' where user_id = (select id from app.users where phone = $1)", [BEN]);
    await ben.reload();
    await ben.waitForURL(`${WEB_URL}/login`, { timeout: 15_000 });
    await expect.poll(() => keptPictures(ben)).toBe(0);
    const account = await ben.evaluate(
      () =>
        new Promise<unknown>((resolve) => {
          const open = indexedDB.open('bedo-chat', 1);
          open.onsuccess = () => {
            const request = open.result.transaction('state', 'readonly').objectStore('state').get('account');
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => resolve('error');
          };
          open.onerror = () => resolve('error');
        }),
    );
    expect(account).toBeNull();
  });
});
