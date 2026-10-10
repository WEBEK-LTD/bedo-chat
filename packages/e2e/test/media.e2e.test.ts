import { deflateSync } from 'node:zlib';
import { encryptAtRest } from '@bedo/server-crypto';
import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, createAdmin, launchBrowser, query, type Stack, startStack, totpNow, waitForCode, WEB_URL, ADMIN_PASSWORD } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/** Set E2E_SCREENSHOTS=<folder> to save screenshots of the main screens for review. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
}

const ANA = '+201000004001';
const BEN = '+201000004002';
const ADMIN = '+201000004009';

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

/** The start of an MP4 file (enough for the type check; the picker only shows the preview image). */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), Buffer.alloc(4000, 1)]);

/**
 * Phase 4 end to end in a real browser (D-36 one site; Supabase Storage, Realtime and GIPHY stand-ins; a fake
 * camera and microphone): photos with previews and progress, files that download under their name, voice messages
 * recorded and played, reactions seen live by the other side, GIFs searched and sent through the API, stickers
 * uploaded in the Admin Dashboard and sent, the media panel, and no Content-Security-Policy violation anywhere.
 */
describe.runIf(enabled)('Phase 4 media in the browser', () => {
  let stack: Stack;
  let browser: Browser;
  let ana: Page;
  let ben: Page;
  const contexts: BrowserContext[] = [];
  const violations: string[] = [];

  async function newPage(label: string): Promise<Page> {
    const context = await browser.newContext({ acceptDownloads: true });
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

  const messages = (page: Page) => page.getByRole('log', { name: 'Messages' });
  const composer = (page: Page) => page.getByRole('textbox', { name: /^(Message|Caption)$/ });

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [ANA, BEN]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
    ana = await newPage('ana');
    await signIn(ana, ANA, 'Ana Media');
    ben = await newPage('ben');
    await signIn(ben, BEN, 'Ben Media');
    await ana.getByRole('searchbox', { name: 'Search' }).fill('Ben M');
    await ana.getByRole('button', { name: /^Ben Media/ }).click();
    await composer(ana).fill('Hi Ben');
    await composer(ana).press('Enter');
    await ben.getByRole('button', { name: /^Ana Media/ }).click();
    await messages(ben).getByText('Hi Ben').waitFor();
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('sends a photo with a caption, shows its preview on both sides and opens it full size', async () => {
    await ana.getByLabel('Choose files').setInputFiles({ name: 'board.png', mimeType: 'image/png', buffer: png(1200, 800, [30, 120, 200]) });
    await ana.getByRole('list').getByText('board.png').waitFor();
    await ana.getByText(/^Photo · /).waitFor();
    await composer(ana).fill('The whiteboard');
    await ana.getByRole('button', { name: 'Send', exact: true }).click();

    // Ben receives it live: the preview (signed link to the private bucket) loads.
    const photo = messages(ben).getByRole('button', { name: 'Open photo' });
    await photo.waitFor({ timeout: 10_000 });
    await messages(ben).getByText('The whiteboard').waitFor();
    await expect.poll(() => photo.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    // The stored photo was resized and re-encoded on Ana's device (JPEG), and the preview is at most 480 px.
    const stored = [...stack.storageObjects().entries()];
    expect(stored.some(([key, object]) => key.startsWith('chat-media/photo/') && object.body[0] === 0xff && object.body[1] === 0xd8)).toBe(true);
    expect(stored.some(([key]) => key.startsWith('chat-media/thumbs/'))).toBe(true);

    await shot(ben, '40-photo-received');
    await photo.click();
    const viewer = ben.getByRole('dialog', { name: 'Photo' });
    await expect.poll(() => viewer.getByRole('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1200);
    await ben.keyboard.press('Escape');
    await viewer.waitFor({ state: 'detached' });
  });

  it('sends a document that the other side downloads under its own name', async () => {
    await ana.getByLabel('Choose files').setInputFiles({ name: 'notes week 3.txt', mimeType: 'text/plain', buffer: Buffer.from('Chapter 3: photosynthesis\n') });
    await ana.getByText(/^File · /).waitFor();
    await ana.getByRole('button', { name: 'Send', exact: true }).click();
    const card = messages(ben).getByText('notes week 3.txt');
    await card.waitFor({ timeout: 10_000 });
    const [download] = await Promise.all([ben.waitForEvent('download'), messages(ben).getByRole('button', { name: 'Download notes week 3.txt' }).click()]);
    expect(download.suggestedFilename()).toBe('notes week 3.txt');
    const path = await download.path();
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path!, 'utf8')).toBe('Chapter 3: photosynthesis\n');
    // Programs are refused before anything is uploaded.
    await ana.getByLabel('Choose files').setInputFiles({ name: 'setup.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ fake program') });
    await ana.getByRole('button', { name: 'Send', exact: true }).click();
    await messages(ana).getByText('This file could not be sent. Check its type and size.').or(messages(ana).getByText(/Please check the details/)).waitFor();
    await messages(ana).getByRole('button', { name: 'Cancel' }).click();
  });

  it('records a voice message with the microphone, which the other side plays', async () => {
    await ana.getByRole('button', { name: 'Record a voice message' }).click();
    await ana.getByRole('status', { name: 'Recording a voice message' }).waitFor();
    await ana.waitForTimeout(2200);
    await ana.getByRole('button', { name: 'Send voice message' }).click();
    const play = messages(ben).getByRole('button', { name: 'Play voice message' });
    await play.waitFor({ timeout: 15_000 });
    await play.click();
    await messages(ben).getByRole('button', { name: 'Pause voice message' }).waitFor();
    await shot(ben, '41-voice-playing');
    await expect.poll(() => ben.locator('audio').last().evaluate((audio: HTMLAudioElement) => audio.currentTime), { timeout: 10_000 }).toBeGreaterThan(0);
    // Speed: 1x -> 1.5x.
    await messages(ben).getByRole('button', { name: 'Playback speed 1x' }).click();
    expect(await ben.locator('audio').last().evaluate((audio: HTMLAudioElement) => audio.playbackRate)).toBe(1.5);
    const voice = [...stack.storageObjects().keys()].find((key) => key.startsWith('chat-media/voice/'));
    expect(voice).toBeTruthy();
  });

  it('shows a reaction to the other side live', async () => {
    const message = messages(ben).getByText('Hi Ben');
    await message.hover();
    await messages(ben).locator('#' + (await message.evaluate((element) => element.closest('[id^="message-"]')!.id))).getByRole('button', { name: 'React' }).click();
    await ben.getByRole('menuitemradio', { name: 'React 👍' }).click();
    await messages(ana).getByRole('button', { name: '👍 1' }).waitFor({ timeout: 10_000 });
    await messages(ben).getByRole('button', { name: '👍 1, yours' }).click();
    await messages(ana).getByRole('button', { name: '👍 1' }).waitFor({ state: 'detached', timeout: 10_000 });
  });

  it('searches GIFs through the API and sends one as a stored copy', async () => {
    stack.giphy.gifs.set('abcGif1', { id: 'abcGif1', title: 'Celebrate', mp4: MP4, preview: png(133, 100, [250, 200, 0]) });
    await query(stack.ownerUrl, 'update app.gif_settings set giphy_key_enc = $1', [encryptAtRest(stack.settingsKey, Buffer.from('E2eGiphyKey1'), 'bedo:app.gif_settings:giphy_key:v1')]);
    await ana.getByRole('button', { name: 'Emoji, stickers and GIFs' }).click();
    await ana.getByRole('tab', { name: 'GIFs' }).click();
    const gif = ana.getByRole('button', { name: 'Send GIF Celebrate' });
    await gif.waitFor();
    // The preview came through the site's own API, never from GIPHY directly.
    expect(await gif.locator('img').getAttribute('src')).toMatch(/^\/api\/v1\/gifs\/preview\?/);
    await expect.poll(() => gif.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(133);
    await shot(ana, '42-gif-picker');
    await gif.click();
    await messages(ben).getByLabel('GIF').waitFor({ timeout: 10_000 });
    expect(stack.giphy.keys.every((key) => key === 'E2eGiphyKey1')).toBe(true);
    expect([...stack.storageObjects().keys()].some((key) => key.startsWith('chat-media/gif/'))).toBe(true);
  });

  it('lets a Super Admin upload a sticker in the Admin Dashboard, which students then send', async () => {
    const secret = await createAdmin(stack, ADMIN, 'Media Admin', 'super_admin');
    const admin = await newPage('admin');
    await admin.goto(`${ADMIN_URL}/login`);
    await admin.getByLabel('Phone number').fill(ADMIN);
    await admin.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Continue' }).click();
    await admin.getByLabel('Authenticator code').fill(totpNow(secret));
    await admin.getByRole('button', { name: 'Sign in' }).click();
    await admin.getByText('Media Admin · Super Admin').waitFor();
    await admin.getByRole('button', { name: 'Stickers and GIFs' }).click();
    await admin.getByTestId('gif-key-status').getByText(/On: a GIPHY key is saved/).waitFor();
    await admin.getByLabel('New pack name').fill('Academy');
    await admin.getByRole('button', { name: 'Create pack' }).click();
    const pack = admin.getByRole('article', { name: 'Pack Academy' });
    await pack.getByRole('button', { name: 'Add sticker' }).click();
    await pack.locator('input[type="file"]').setInputFiles({ name: 'star.png', mimeType: 'image/png', buffer: png(256, 256, [255, 180, 0]) });
    await pack.getByLabel('Emoji').fill('⭐');
    await pack.getByRole('button', { name: 'Upload' }).click();
    const image = pack.getByRole('img', { name: 'Sticker ⭐' });
    await image.waitFor();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(256);
    await shot(admin, '43-admin-stickers');

    await ana.getByRole('button', { name: 'Emoji, stickers and GIFs' }).click();
    await ana.getByRole('tab', { name: 'Stickers' }).click();
    await ana.getByRole('button', { name: 'Send sticker ⭐' }).click();
    const sticker = messages(ben).getByRole('img', { name: 'Sticker ⭐' });
    await sticker.waitFor({ timeout: 10_000 });
    await expect.poll(() => sticker.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(256);
    await shot(ben, '44-chat-with-media');
  });

  it('lists the chat media by kind and keeps a deleted file away from the other side', async () => {
    await ben.getByRole('button', { name: 'Chat actions' }).click();
    await ben.getByRole('menuitem', { name: 'Shared media' }).click();
    const panel = ben.getByRole('dialog', { name: 'Shared media' });
    await panel.getByRole('list', { name: 'Photos and videos' }).getByRole('button').first().waitFor();
    expect(await panel.getByRole('list', { name: 'Photos and videos' }).getByRole('button').count()).toBe(2);
    await shot(ben, '45-media-panel');
    await panel.getByRole('tab', { name: 'Files' }).click();
    await panel.getByText('notes week 3.txt').waitFor();
    await panel.getByRole('tab', { name: 'Voice' }).click();
    await panel.getByRole('button', { name: 'Play voice message' }).waitFor();
    await panel.getByRole('button', { name: 'Close' }).click();

    // Ana deletes the photo for both sides: Ben's copy disappears and its file can no longer be fetched.
    const photoId = (await query<{ id: string }>(stack.ownerUrl, `select id from app.messages where kind = 'media' and text = 'The whiteboard'`)).rows[0]!.id;
    const photoRow = messages(ana).locator(`#message-${photoId}`);
    await photoRow.hover();
    await photoRow.getByRole('button', { name: 'Message actions' }).click();
    await ana.getByRole('menuitem', { name: 'Delete' }).click();
    await ana.getByRole('button', { name: 'Delete for both' }).click();
    await messages(ben).locator(`#message-${photoId}`).getByText('This message was deleted.').waitFor({ timeout: 10_000 });
    const status = await ben.evaluate(async (id) => (await fetch(`/api/v1/messages/${id}/file`, { headers: { 'x-bedo-csrf': '1' } })).status, photoId);
    expect([401, 404]).toContain(status);
  });

  it('caused no Content-Security-Policy violation or page error anywhere', () => {
    expect(violations).toEqual([]);
  });
});
