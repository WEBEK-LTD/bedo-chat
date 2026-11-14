import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, query, type Stack, startStack, waitForCode, WEB_URL } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/** Set E2E_SCREENSHOTS=<folder> to save screenshots of the main screens for review. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
}

const OWNER = '+201000018001';
const READER = '+201000018002';

/**
 * Comments on channel posts in a real browser: off until the channel's owner turns them on in the channel info; then a
 * subscriber opens a post's comments, comments, edits and replies; the owner sees the comments and deletes one. With
 * comments turned off again the button under the post goes. No Content-Security-Policy violation anywhere.
 */
describe.runIf(enabled)('comments on channel posts in the browser', () => {
  let stack: Stack;
  let browser: Browser;
  let owner: Page;
  let reader: Page;
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
    // "Delete this comment?" is a confirm() question.
    page.on('dialog', (dialog) => void dialog.accept());
    return page;
  }

  async function signIn(page: Page, phone: string, name: string) {
    await stack.clearCooldown(phone);
    const previous = await stack.latestCode(phone);
    await page.goto(`${WEB_URL}/login`);
    await page.getByLabel('Phone number').waitFor();
    await page.getByLabel('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Verification code').fill(await waitForCode(stack, phone, previous));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(`${WEB_URL}/`);
  }

  const messages = (page: Page) => page.getByRole('log', { name: 'Messages' });
  const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
  const commentsPanel = (page: Page) => page.getByRole('dialog', { name: 'Comments' });
  const commentBox = (page: Page) => commentsPanel(page).getByRole('textbox', { name: 'Comment', exact: true });

  async function channelInfo(page: Page) {
    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Channel info' }).click();
    return page.getByRole('dialog', { name: 'Channel info' });
  }

  /** Opens the channel from the chat list (again), so its posts and their comment counts load. */
  async function openChannel(page: Page) {
    await page.reload();
    await page.getByRole('button', { name: /^Physics news/ }).first().click();
    await page.getByRole('region', { name: 'Channel Physics news' }).waitFor();
  }

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [OWNER, READER]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
    owner = await newPage('owner');
    await signIn(owner, OWNER, 'Olga Teacher');
    reader = await newPage('reader');
    await signIn(reader, READER, 'Rami Student');
    await query(stack.ownerUrl, `insert into app.user_permissions (user_id, create_channels) select id, true from app.users where phone = $1`, [OWNER]);
    await owner.reload();
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('has no comments on a new channel until the owner turns them on', async () => {
    await owner.getByRole('button', { name: 'New channel' }).click();
    const dialog = owner.getByRole('dialog', { name: 'New channel' });
    await dialog.getByLabel('Channel name').fill('Physics news');
    await dialog.getByRole('button', { name: 'Create channel' }).click();
    await owner.getByRole('region', { name: 'Channel Physics news' }).waitFor();
    await composer(owner).fill('Lab reports are due on Thursday');
    await composer(owner).press('Enter');
    await messages(owner).getByText('Lab reports are due on Thursday').waitFor();
    expect(await owner.getByTestId('comments-button').count()).toBe(0);

    await reader.getByRole('searchbox').fill('Physics');
    const found = reader.getByRole('region', { name: 'Public channels' });
    await found.getByRole('button', { name: 'Join Physics news' }).click({ timeout: 10_000 });
    await messages(reader).getByText('Lab reports are due on Thursday').waitFor();
    expect(await reader.getByTestId('comments-button').count()).toBe(0);

    // Only the owner (and admins who may change the info) see the switch; it starts off.
    const info = await channelInfo(owner);
    const toggle = info.getByLabel('Comments', { exact: true });
    expect(await toggle.isChecked()).toBe(false);
    await toggle.check();
    await owner.getByText('Comments turned on.').waitFor();
    await shot(owner, '80-channel-comments-switch');
    await info.getByRole('button', { name: 'Close channel info' }).click();
    const readerInfo = await channelInfo(reader);
    expect(await readerInfo.getByLabel('Comments', { exact: true }).count()).toBe(0);
    await readerInfo.getByRole('button', { name: 'Close channel info' }).click();
  });

  it('lets a subscriber comment, edit and see the count under the post', async () => {
    await openChannel(reader);
    const button = messages(reader).getByTestId('comments-button');
    await button.getByText('Leave a comment').waitFor({ timeout: 10_000 });
    await button.click();
    const panel = commentsPanel(reader);
    await panel.getByText('No comments yet. Be the first to comment.').waitFor();
    await panel.getByText('Lab reports are due on Thursday').waitFor();
    await commentBox(reader).fill('Can we hand them in on Friday? https://example.com/lab');
    await commentBox(reader).press('Enter');
    const first = panel.getByTestId('comment').filter({ hasText: 'Can we hand them in on Friday?' });
    await first.waitFor();
    await first.getByText('Rami Student').waitFor();
    // Links open like in messages.
    expect(await first.getByRole('link', { name: 'https://example.com/lab' }).getAttribute('target')).toBe('_blank');
    expect(await first.locator('p[dir="auto"]').count()).toBeGreaterThan(0);

    await first.getByRole('button', { name: 'Actions for the comment by Rami Student' }).click();
    await reader.getByRole('menuitem', { name: 'Edit' }).click();
    await commentBox(reader).fill('Can we hand them in on Friday instead?');
    await panel.getByRole('button', { name: 'Save comment' }).click();
    const edited = panel.getByTestId('comment').filter({ hasText: 'Friday instead?' });
    await edited.getByText('edited').waitFor();
    await shot(reader, '81-channel-comments-panel');
    await panel.getByRole('button', { name: 'Close comments' }).click();
    await messages(reader).getByTestId('comments-button').getByText('1 comment').waitFor();
  });

  it('shows the comments to the owner, who replies and deletes a comment', async () => {
    await openChannel(owner);
    await messages(owner).getByTestId('comments-button').getByText('1 comment').waitFor({ timeout: 10_000 });
    await messages(owner).getByTestId('comments-button').click();
    const panel = commentsPanel(owner);
    const studentComment = panel.getByTestId('comment').filter({ hasText: 'Friday instead?' });
    await studentComment.waitFor();
    await studentComment.getByRole('button', { name: 'Actions for the comment by Rami Student' }).click();
    await owner.getByRole('menuitem', { name: 'Reply' }).click();
    await panel.getByText('Reply to Rami Student').waitFor();
    await commentBox(owner).fill('Yes, Friday is fine.');
    await commentBox(owner).press('Enter');
    const reply = panel.getByTestId('comment').filter({ hasText: 'Yes, Friday is fine.' });
    await reply.getByText('Rami Student', { exact: true }).waitFor();

    // The owner may delete anyone's comment.
    await studentComment.getByRole('button', { name: 'Actions for the comment by Rami Student' }).click();
    await owner.getByRole('menuitem', { name: 'Delete' }).click();
    await studentComment.waitFor({ state: 'detached' });
    await reply.getByText('Deleted comment').waitFor();
    await panel.getByRole('button', { name: 'Close comments' }).click();
    await messages(owner).getByTestId('comments-button').getByText('1 comment').waitFor();

    // The history keeps the text before the deletion and the edit (D-17).
    const history = await query<{ action: string; previous_text: string }>(stack.ownerUrl, 'select action, previous_text from audit.channel_comment_revisions order by id');
    expect(history.rows).toEqual([
      { action: 'edited', previous_text: 'Can we hand them in on Friday? https://example.com/lab' },
      { action: 'deleted', previous_text: 'Can we hand them in on Friday instead?' },
    ]);
  });

  it('the subscriber sees new comments in the open panel within seconds', async () => {
    await openChannel(reader);
    await messages(reader).getByTestId('comments-button').click();
    const panel = commentsPanel(reader);
    await panel.getByText('Yes, Friday is fine.').waitFor();
    await commentsPanel(owner).waitFor({ state: 'detached' });
    await messages(owner).getByTestId('comments-button').click();
    await commentBox(owner).fill('Reminder: bring your goggles.');
    await commentBox(owner).press('Enter');
    await panel.getByText('Reminder: bring your goggles.').waitFor({ timeout: 20_000 });
    await panel.getByRole('button', { name: 'Close comments' }).click();
    await commentsPanel(owner).getByRole('button', { name: 'Close comments' }).click();
  });

  it('removes the button when the owner turns comments off', async () => {
    const info = await channelInfo(owner);
    await info.getByLabel('Comments', { exact: true }).uncheck();
    await owner.getByText('Comments turned off.').waitFor();
    await info.getByRole('button', { name: 'Close channel info' }).click();
    await openChannel(reader);
    await messages(reader).getByText('Lab reports are due on Thursday').waitFor();
    expect(await reader.getByTestId('comments-button').count()).toBe(0);
  });

  it('caused no Content-Security-Policy violation or page error anywhere', () => {
    expect(violations).toEqual([]);
  });
});
