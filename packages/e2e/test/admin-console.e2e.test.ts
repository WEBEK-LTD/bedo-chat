import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, ADMIN_URL, createAdmin, launchBrowser, query, type Stack, startStack, totpNow, waitForCode, WEB_URL } from './stack.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
}

const ANA = '+201000010001';
const BEN = '+201000010002';
const SUPER_ADMIN = '+201000010901';
const MODERATOR = '+201000010902';
const REASON = 'Reviewed by the academy office';

/**
 * Phase 10 end to end in a real browser: the rest of the Admin Dashboard (D-44). A student reports a message; an
 * admin sees only that message and removes it for everyone; a group is created for a student and a member removed;
 * an account is suspended (signed out) and reactivated; a notification is broadcast; the audit history is read with a
 * reason (and the view recorded); a Moderator does not see the Super Admin areas.
 */
describe.runIf(enabled)('Phase 10 Admin Dashboard in the browser', () => {
  let stack: Stack;
  let browser: Browser;
  let ana: Page;
  let ben: Page;
  let admin: Page;
  let superSecret: Buffer;
  let moderatorSecret: Buffer;
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

  async function adminSignIn(page: Page, phone: string, secret: Buffer) {
    await page.goto(`${ADMIN_URL}/login`);
    await page.getByLabel('Phone number').fill(phone);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Authenticator code').fill(totpNow(secret));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Overview' }).waitFor();
  }

  async function giveReason(page: Page, button: string) {
    await page.getByLabel('Reason (kept in the admin history)').fill(REASON);
    await page.getByRole('button', { name: button, exact: true }).last().click();
  }

  const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
  const messages = (page: Page) => page.getByRole('log', { name: 'Messages' });

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const number of [ANA, BEN]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [number]);
    }
    superSecret = await createAdmin(stack, SUPER_ADMIN, 'Head Office', 'super_admin');
    moderatorSecret = await createAdmin(stack, MODERATOR, 'Floor Moderator', 'moderator');
    ana = await newPage('ana');
    await signIn(ana, ANA, 'Ana Lopez');
    ben = await newPage('ben');
    await signIn(ben, BEN, 'Ben Brown');
    await query(stack.ownerUrl, `update app.users set username = 'ben_brown' where phone = $1`, [BEN]);
    admin = await newPage('admin');
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('a student reports a message; the admin sees only that message and removes it for everyone (O-18)', async () => {
    await ana.getByRole('searchbox').fill('ben_brown');
    await ana.getByRole('button', { name: /^Ben Brown/ }).click();
    for (const text of ['A perfectly normal message', 'Something rude and hurtful']) {
      await composer(ana).fill(text);
      await composer(ana).press('Enter');
    }
    await ben.getByRole('button', { name: /^Ana Lopez/ }).click();
    const rude = ben.locator('[id^="message-"]', { hasText: 'Something rude and hurtful' });
    await rude.hover();
    await rude.getByRole('button', { name: 'Message actions' }).click();
    await ben.getByRole('menuitem', { name: 'Report' }).click();
    await ben.getByLabel('Inappropriate content').check();
    await ben.getByLabel('Details (optional)').fill('Please look at this');
    await ben.getByRole('button', { name: 'Send report' }).click();
    await ben.getByText('Report sent. Thank you.').waitFor();

    await adminSignIn(admin, SUPER_ADMIN, superSecret);
    await expect.poll(async () => admin.getByLabel('Open reports').textContent()).toBe('1');
    await shot(admin, '100-admin-overview');
    await admin.getByRole('button', { name: 'Reports' }).click();
    const card = admin.getByRole('listitem', { name: 'Report about Ana Lopez' });
    await card.getByText('Something rude and hurtful').waitFor();
    await card.getByText('Please look at this').waitFor();
    expect(await admin.getByText('A perfectly normal message').count()).toBe(0);
    await shot(admin, '101-admin-report');
    await card.getByRole('button', { name: 'Remove message' }).click();
    await card.getByLabel('Note (optional, kept with the decision)').fill('Removed after review');
    await card.getByRole('button', { name: 'Confirm decision' }).click();
    await card.getByText(/Message removed by Head Office/).waitFor();
    await messages(ben).getByText('This message was deleted.').waitFor({ timeout: 20_000 });
    await messages(ana).getByText('This message was deleted.').waitFor({ timeout: 20_000 });
    expect(await messages(ben).getByText('Something rude and hurtful').count()).toBe(0);
    await messages(ben).getByText('A perfectly normal message').waitFor();
  });

  it('creates a group owned by a student, then removes a member, without showing its messages', async () => {
    await admin.getByRole('button', { name: 'Groups and channels' }).click();
    await admin.getByRole('button', { name: 'New group or channel' }).click();
    await admin.getByLabel('Name', { exact: true }).fill('Physics 101');
    await admin.getByLabel('Owner', { exact: true }).fill('Ana');
    await admin.getByRole('button', { name: /^Ana Lopez/ }).click();
    await admin.getByLabel('Add members', { exact: true }).fill('ben_brown');
    await admin.getByRole('button', { name: /^Ben Brown/ }).click();
    await admin.getByLabel('Reason (kept in the admin history)').fill(REASON);
    await admin.getByRole('button', { name: 'Create group' }).click();
    await admin.getByRole('heading', { name: 'Physics 101' }).waitFor();
    await admin.getByText('Group · 2 members', { exact: true }).waitFor();
    await ana.getByRole('button', { name: /^Physics 101/ }).waitFor({ timeout: 20_000 });
    await ben.getByRole('button', { name: /^Physics 101/ }).waitFor({ timeout: 20_000 });
    await shot(admin, '102-admin-group');

    const benRow = admin.getByRole('list', { name: 'Members' }).getByRole('listitem').filter({ hasText: 'Ben Brown' });
    await benRow.getByRole('button', { name: 'Manage' }).click();
    await benRow.getByRole('button', { name: 'Remove', exact: true }).click();
    await giveReason(admin, 'Remove');
    await admin.getByText('Ben Brown was removed.').waitFor();
    await admin.getByText('Group · 1 member', { exact: true }).waitFor();
    await expect.poll(async () => ben.getByRole('button', { name: /^Physics 101/ }).count(), { timeout: 20_000 }).toBe(0);
    const ban = await query(stack.ownerUrl, `select b.banned_by_admin is not null as by_admin from app.chat_bans b join app.users u on u.id = b.user_id where u.phone = $1`, [BEN]);
    expect(ban.rows).toEqual([{ by_admin: true }]);
  });

  it('suspends an account (signed out at once) and reactivates it', async () => {
    await admin.getByRole('button', { name: 'Users', exact: true }).click();
    await admin.getByLabel('Search users').fill('Ben');
    await admin.getByRole('button', { name: 'Search', exact: true }).click();
    await admin.getByRole('list', { name: 'Users' }).getByRole('button', { name: /Ben Brown/ }).click();
    await admin.getByRole('heading', { name: 'Ben Brown' }).waitFor();
    await admin.getByRole('button', { name: 'Suspend', exact: true }).click();
    await giveReason(admin, 'Suspend');
    await admin.getByText('The account is suspended and every session has ended.').waitFor();
    await ben.reload();
    await ben.getByText('This account is blocked. Contact the academy.').waitFor({ timeout: 20_000 });
    await shot(admin, '103-admin-user-suspended');
    await admin.getByRole('button', { name: 'Reactivate', exact: true }).click();
    await giveReason(admin, 'Reactivate');
    await admin.getByText(/The account is active again/).waitFor();
    // Ben signs in again.
    await signIn(ben, BEN, null);
  });

  it('broadcasts a notification and reads the audit history with a reason, which is recorded', async () => {
    await admin.getByRole('button', { name: 'Broadcast notifications' }).click();
    await admin.getByLabel('Title', { exact: true }).fill('Academy closed Friday');
    await admin.getByLabel('Text', { exact: true }).fill('The academy is closed on Friday for maintenance.');
    await admin.getByRole('button', { name: 'Send notification' }).click();
    await admin.getByRole('button', { name: 'Send now' }).click();
    await admin.getByText('The notification is being sent.').waitFor();
    await admin.getByRole('list', { name: 'Sent notifications' }).getByText('Academy closed Friday').waitFor();
    await shot(admin, '104-admin-broadcast');

    await admin.getByRole('button', { name: 'Audit history' }).click();
    await admin.getByLabel('History', { exact: true }).selectOption('messages');
    await admin.getByLabel('Person (optional if a chat is chosen)', { exact: true }).fill('Ana');
    await admin.getByRole('button', { name: /^Ana Lopez/ }).click();
    await admin.getByLabel('Reason for looking (recorded)').fill(REASON);
    await admin.getByRole('button', { name: 'Show history' }).click();
    const entries = admin.getByRole('list', { name: 'History entries' });
    await entries.getByText('message deleted for both').waitFor();
    await entries.getByText('Something rude and hurtful').waitFor();
    await entries.getByText(/By admin Head Office/).waitFor();
    await shot(admin, '105-admin-audit');
    const views = await query(stack.ownerUrl, `select metadata->>'reason' as reason from app.audit_log where action = 'audit.viewed'`);
    expect(views.rows).toEqual([{ reason: REASON }]);
  });

  it('lets anyone with WhatsApp sign up once a Super Admin allows it (D-47)', async () => {
    const NEWCOMER = '+201000010077';
    await admin.getByRole('button', { name: 'Academy phone list' }).click();
    const access = admin.getByRole('group', { name: 'Who can create an account' });
    await access.getByLabel(/Only numbers on this list/).waitFor();
    expect(await access.getByLabel(/Only numbers on this list/).isChecked()).toBe(true);
    // The choice is saved first, then shown (a radio that follows the server).
    await access.getByLabel(/Anyone with a WhatsApp number/).click();
    await access.getByText(/Last changed .* by Head Office/).waitFor();
    expect(await access.getByLabel(/Anyone with a WhatsApp number/).isChecked()).toBe(true);
    await shot(admin, '106-admin-signup-open');
    const newcomer = await newPage('newcomer');
    await signIn(newcomer, NEWCOMER, 'New Student');
    expect((await query(stack.ownerUrl, 'select count(*)::int as n from app.academy_phone_list where phone = $1', [NEWCOMER])).rows[0]!.n).toBe(0);
    expect((await query(stack.ownerUrl, `select status from app.users where phone = $1`, [NEWCOMER])).rows).toEqual([{ status: 'active' }]);
    await access.getByLabel(/Only numbers on this list/).click();
    await expect.poll(async () => (await query(stack.ownerUrl, 'select signup_mode from app.access_settings')).rows[0]!.signup_mode).toBe('academy_list');
  });

  it('shows a Moderator the shared areas only', async () => {
    const page = await newPage('moderator');
    await adminSignIn(page, MODERATOR, moderatorSecret);
    expect(await page.getByRole('button', { name: 'Audit history' }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Broadcast notifications' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Groups and channels' }).click();
    await page.getByRole('button', { name: /Physics 101/ }).click();
    await page.getByRole('heading', { name: 'Physics 101' }).waitFor();
    expect(await page.getByRole('button', { name: 'Edit settings' }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Manage' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Users', exact: true }).click();
    await page.getByRole('list', { name: 'Users' }).getByRole('button', { name: /Ana Lopez/ }).click();
    await page.getByRole('button', { name: 'Suspend', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Ban', exact: true }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Delete account' }).count()).toBe(0);
    expect(violations).toEqual([]);
  });
});
