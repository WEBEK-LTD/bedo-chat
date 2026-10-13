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

const OWNER = '+201000005001';
const MEMBER = '+201000005002';
const QUIET = '+201000005003';
const JOINER = '+201000005004';

/**
 * Phase 5 end to end in a real browser: creating a group with members, messages with sender names and @mentions,
 * a poll voted in the browser, member privacy as a normal member sees it, an invite link opened before signing in,
 * and member management from the group info panel. No Content-Security-Policy violation anywhere.
 */
describe.runIf(enabled)('Phase 5 groups in the browser', () => {
  let stack: Stack;
  let browser: Browser;
  let owner: Page;
  let member: Page;
  const contexts: BrowserContext[] = [];
  const violations: string[] = [];

  async function newPage(label: string): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL });
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

  async function signIn(page: Page, phone: string, name: string, path = '/login') {
    await stack.clearCooldown(phone);
    const previous = await stack.latestCode(phone);
    await page.goto(`${WEB_URL}${path}`);
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

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [OWNER, MEMBER, QUIET, JOINER]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
    owner = await newPage('owner');
    await signIn(owner, OWNER, 'Olga Teacher');
    member = await newPage('member');
    await signIn(member, MEMBER, 'Mark Student');
    const quiet = await newPage('quiet');
    await signIn(quiet, QUIET, 'Quinn Silent');
    await query(stack.ownerUrl, `update app.users set username = 'mark_student' where phone = $1`, [MEMBER]);
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('creates a group with members, who see it and the sender of each message', async () => {
    await owner.getByRole('button', { name: 'New group' }).click();
    const dialog = owner.getByRole('dialog', { name: 'New group' });
    await dialog.getByLabel('Group name').fill('Biology class');
    for (const name of ['Mark Student', 'Quinn Silent']) {
      await dialog.getByLabel('Add people').fill(name.slice(0, 5));
      await dialog.getByRole('list', { name: 'People found' }).getByRole('button', { name }).click();
    }
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await owner.getByRole('region', { name: 'Group Biology class' }).waitFor();
    await owner.getByText('3 members').waitFor();
    await composer(owner).fill('Welcome @mark_student, homework is in #week1');
    await composer(owner).press('Enter');

    await member.getByRole('button', { name: /^Biology class/ }).click();
    const welcome = messages(member).getByText('Welcome');
    await welcome.waitFor({ timeout: 10_000 });
    await messages(member).getByText('Olga Teacher').waitFor();
    // The mention of Mark is highlighted for him; the hashtag searches the chat.
    await messages(member).getByText('@mark_student').waitFor();
    await messages(member).getByRole('button', { name: '#week1' }).click();
    await member.getByRole('searchbox', { name: 'Search in chat' }).waitFor();
    expect(await member.getByRole('searchbox', { name: 'Search in chat' }).inputValue()).toBe('#week1');
    await member.getByRole('button', { name: 'Close search' }).click();
    await shot(member, '50-group-chat');
  });

  it('runs a poll in the browser, with results after voting', async () => {
    await owner.getByRole('button', { name: 'Create a poll' }).click();
    const dialog = owner.getByRole('dialog', { name: 'New poll' });
    await dialog.getByLabel('Question').fill('Exam on Monday or Tuesday?');
    await dialog.getByLabel('Option 1', { exact: true }).fill('Monday');
    await dialog.getByLabel('Option 2', { exact: true }).fill('Tuesday');
    await dialog.getByRole('button', { name: 'Send' }).click();
    const poll = messages(member).getByLabel('Poll');
    await poll.waitFor({ timeout: 10_000 });
    await poll.getByText('Vote to see the results').waitFor();
    await poll.getByRole('button', { name: 'Tuesday' }).click();
    await poll.getByText('100%').waitFor();
    await poll.getByText('1 vote').waitFor();
    await shot(member, '51-poll');
  });

  it('keeps the member list private from members when the owner turns privacy on', async () => {
    await owner.getByRole('button', { name: 'Chat actions' }).click();
    await owner.getByRole('menuitem', { name: 'Group info' }).click();
    const info = owner.getByRole('dialog', { name: 'Group info' });
    await info.getByRole('list').getByText('Quinn Silent').waitFor();
    await info.getByLabel('Hide the member list from members').check();
    await info.getByLabel('Hide the member count from members').check();
    await shot(owner, '52-group-info-owner');
    await info.getByRole('button', { name: 'Close group info' }).click();

    // Mark (a member) sees "Group", no count, and no list; Quinn never sent anything, so nothing names him.
    await member.getByText('Group', { exact: true }).first().waitFor({ timeout: 10_000 });
    await member.getByRole('button', { name: 'Chat actions' }).click();
    await member.getByRole('menuitem', { name: 'Group info' }).click();
    const memberInfo = member.getByRole('dialog', { name: 'Group info' });
    await memberInfo.getByText('The admins keep the member list private.').waitFor();
    expect(await member.content()).not.toContain('Quinn Silent');
    await memberInfo.getByRole('button', { name: 'Close group info' }).click();
  });

  it('lets someone ask to join with an invite link opened before signing in, and an admin approve it (Phase 15)', async () => {
    await owner.getByRole('button', { name: 'Chat actions' }).click();
    await owner.getByRole('menuitem', { name: 'Group info' }).click();
    const info = owner.getByRole('dialog', { name: 'Group info' });
    await info.getByRole('button', { name: 'New link', exact: true }).click();
    // Phase 15: a new link asks the admins to approve each join unless they turn that off.
    expect(await info.getByRole('checkbox', { name: /Admins approve each person who joins/ }).isChecked()).toBe(true);
    await info.getByRole('button', { name: 'Create link' }).click();
    const link = (await info.getByRole('region', { name: 'Invite links' }).locator('.font-mono').first().textContent())!;
    expect(link).toMatch(/\/\?join=[A-Za-z0-9_-]{22}$/);
    await info.getByRole('button', { name: 'Close group info' }).click();

    const joiner = await newPage('joiner');
    await signIn(joiner, JOINER, 'Jade Newcomer', link.replace(WEB_URL, ''));
    const dialog = joiner.getByRole('dialog', { name: 'Join group' });
    await dialog.getByText('Biology class').waitFor();
    // The count is hidden from members, so the preview does not show it either.
    expect(await dialog.getByText(/members/).count()).toBe(0);
    await dialog.getByRole('button', { name: 'Ask to join' }).click();
    await dialog.getByText('Your request was sent. An admin will review it.').waitFor();
    await dialog.getByRole('button', { name: 'Close' }).click();

    // The owner sees the request at the top of the chat and accepts it.
    await owner.getByRole('button', { name: '1 person asked to join' }).click({ timeout: 10_000 });
    const requests = owner.getByRole('dialog', { name: 'Group info' }).getByRole('region', { name: 'Join requests' });
    await requests.getByText('Jade Newcomer').waitFor();
    await requests.getByRole('button', { name: 'Approve' }).click();
    await owner.getByRole('dialog', { name: 'Group info' }).getByRole('button', { name: 'Close group info' }).click();
    await owner.getByRole('button', { name: '1 person asked to join' }).waitFor({ state: 'detached', timeout: 10_000 });

    await joiner.getByRole('button', { name: /^Biology class/ }).click({ timeout: 10_000 });
    await joiner.getByRole('region', { name: 'Group Biology class' }).waitFor();
    await messages(joiner).getByText('Welcome').waitFor();
    expect(new URL(joiner.url()).search).toBe('');
  });

  it('lets the owner restrict a member, who then cannot send', async () => {
    await owner.getByRole('button', { name: 'Chat actions' }).click();
    await owner.getByRole('menuitem', { name: 'Group info' }).click();
    const info = owner.getByRole('dialog', { name: 'Group info' });
    await info.getByRole('button', { name: 'Actions for Mark Student' }).click();
    await owner.getByRole('menuitem', { name: 'Restrict' }).click();
    const restrict = owner.getByRole('dialog', { name: 'Restrict Mark Student' });
    await restrict.getByRole('button', { name: 'Restrict' }).click();
    await info.getByText('Restricted').waitFor();
    await info.getByRole('button', { name: 'Close group info' }).click();
    await member.getByText(/The admins restricted you until/).waitFor({ timeout: 10_000 });
    expect(await composer(member).count()).toBe(0);
    const history = await query<{ action: string }>(stack.ownerUrl, `select action from audit.membership_events order by id`);
    expect(history.rows.map((row) => row.action)).toEqual(['created', 'added', 'added', 'request_approved', 'joined', 'restricted']);
  });

  it('caused no Content-Security-Policy violation or page error anywhere', () => {
    expect(violations).toEqual([]);
  });
});
