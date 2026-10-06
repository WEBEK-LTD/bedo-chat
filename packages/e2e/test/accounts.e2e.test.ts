import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, ADMIN_URL, createAdmin, query, type Stack, startStack, totpNow, waitForCode, WEB_URL } from './stack.js';

/** Set E2E_SCREENSHOTS=<folder> to save screenshots of the main screens for review. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
}

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);
const executablePath = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';

const STUDENT_A = '+201000001001';
const STUDENT_B = '+201000001002';
const UNLISTED = '+201000001099';
const SUPER_ADMIN = '+201000001901';
const MODERATOR = '+201000001902';

/**
 * Phase 2 end to end in a real browser: admin adds numbers, students sign in (with 2-Step Verification
 * and a second device), login alerts, ending sessions, account deletion approved in the admin dashboard,
 * 2-Step reset by an admin, and the Moderator's read-only access.
 */
describe.runIf(enabled)('Phase 2 in the browser (web + admin + API + Postgres + Redis)', () => {
  let stack: Stack;
  let browser: Browser;
  let adminPage: Page;
  let deviceOne: Page;
  let superSecret: Buffer;
  const contexts: BrowserContext[] = [];

  async function newPage(): Promise<Page> {
    const context = await browser.newContext();
    contexts.push(context);
    return context.newPage();
  }

  async function studentSignIn(page: Page, phone: string) {
    await stack.clearCooldown(phone);
    const previous = await stack.latestCode(phone);
    await page.goto(`${WEB_URL}/login`);
    await page.getByLabel('Phone number').fill(phone);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Verification code').waitFor();
    await page.getByLabel('Verification code').fill(await waitForCode(stack, phone, previous));
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  beforeAll(async () => {
    stack = await startStack();
    browser = await chromium.launch({ executablePath, headless: true });
    superSecret = await createAdmin(stack, SUPER_ADMIN, 'Head Office', 'super_admin');
    adminPage = await newPage();
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('admin signs in with phone, password and the authenticator app (D-34)', async () => {
    await adminPage.goto(`${ADMIN_URL}/login`);
    await adminPage.getByLabel('Phone number').fill(SUPER_ADMIN);
    await adminPage.getByLabel('Password', { exact: true }).fill('not-the-right-password');
    await adminPage.getByRole('button', { name: 'Continue' }).click();
    await adminPage.getByText('The phone number or password is incorrect.').waitFor();
    // The password field is emptied after every attempt.
    expect(await adminPage.getByLabel('Password', { exact: true }).inputValue()).toBe('');
    await adminPage.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await adminPage.getByRole('button', { name: 'Continue' }).click();
    await adminPage.getByLabel('Authenticator code').fill('000000');
    await adminPage.getByRole('button', { name: 'Sign in' }).click();
    await adminPage.getByText('The authenticator code is incorrect').waitFor();
    await adminPage.getByLabel('Authenticator code').fill(totpNow(superSecret));
    await adminPage.getByRole('button', { name: 'Sign in' }).click();
    await adminPage.getByRole('heading', { name: 'Academy phone list' }).waitFor();
    await adminPage.getByText('Head Office · Super Admin').waitFor();
    await shot(adminPage, '01-admin-phone-list');
  });

  it('admin adds a number and imports a CSV, with duplicates and invalid lines reported', async () => {
    await adminPage.getByLabel('Phone number').fill(STUDENT_A);
    await adminPage.getByLabel('Note (optional)').fill('Group A');
    await adminPage.getByRole('button', { name: 'Add', exact: true }).click();
    await adminPage.getByText(`${STUDENT_A} was added.`).waitFor();
    await adminPage.getByLabel('Or paste the numbers').fill(`phone,note\n${STUDENT_B},Group B\n${STUDENT_A},dup\nnot-a-phone`);
    await adminPage.getByRole('button', { name: 'Import' }).click();
    await adminPage.getByText('1 added, 1 already on the list, 1 not valid.').waitFor();
    await adminPage.getByRole('cell', { name: STUDENT_B }).waitFor();
    await shot(adminPage, '02-admin-import');
  });

  it('gives an unlisted number the same answer and sends no code', async () => {
    const page = await newPage();
    await page.goto(`${WEB_URL}/login`);
    await page.getByLabel('Phone number').fill(UNLISTED);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText(`If ${UNLISTED} is registered with the academy`).waitFor();
    await shot(page, '03-login-code');
    expect(await stack.codeCount(UNLISTED)).toBe(0);
  });

  it('signs a student in, asks a new account for a name, and opens the chat interface', async () => {
    deviceOne = await newPage();
    await studentSignIn(deviceOne, STUDENT_A);
    await deviceOne.getByRole('heading', { name: 'Your name' }).waitFor();
    await shot(deviceOne, '04-login-name');
    await deviceOne.getByLabel('Name').fill('Mona Adel');
    await deviceOne.getByRole('button', { name: 'Continue' }).click();
    await deviceOne.waitForURL(`${WEB_URL}/`);
    await deviceOne.getByText('No chats yet.').waitFor();

    // The session survives a reload (refresh cookie), without signing in again.
    await deviceOne.reload();
    await deviceOne.getByText('No chats yet.').waitFor();
  });

  it('edits the profile and privacy settings, with every change in identity history', async () => {
    await deviceOne.getByRole('button', { name: 'Settings' }).click();
    await deviceOne.getByRole('button', { name: 'Edit profile' }).click();
    await deviceOne.getByLabel('Username (optional)').fill('mona_adel');
    await deviceOne.getByLabel('Bio (optional)').fill('Second year');
    await deviceOne.getByRole('button', { name: 'Save' }).click();
    await deviceOne.getByText('Saved.').waitFor();
    await deviceOne.getByRole('button', { name: 'Back' }).click();
    await deviceOne.getByText('@mona_adel').waitFor();
    await shot(deviceOne, '05-settings-menu');

    await deviceOne.getByRole('button', { name: 'Privacy' }).click();
    await deviceOne.getByLabel('Who can see my last seen').selectOption('nobody');
    await deviceOne.getByRole('button', { name: 'Back' }).click();
    await deviceOne.getByRole('button', { name: 'Privacy' }).click();
    await expect.poll(() => deviceOne.getByLabel('Who can see my last seen').inputValue()).toBe('nobody');
    await deviceOne.getByRole('button', { name: 'Back' }).click();

    const history = await query<{ field: string }>(
      stack.ownerUrl,
      "select field from audit.identity_history h join app.users u on u.id = h.user_id where u.phone = $1 order by h.id",
      [STUDENT_A],
    );
    expect(history.rows.map((row) => row.field)).toEqual(['phone', 'name', 'username', 'bio']);
  });

  it('turns on 2-Step Verification', async () => {
    await deviceOne.getByRole('button', { name: '2-Step Verification' }).click();
    await deviceOne.getByRole('button', { name: 'Set password' }).click();
    await deviceOne.getByLabel('New password', { exact: true }).fill('blue river 42');
    await deviceOne.getByLabel('Repeat new password').fill('blue river 42');
    await deviceOne.getByLabel('Hint (optional)').fill('river');
    await deviceOne.getByRole('button', { name: 'Save' }).click();
    await deviceOne.getByText('2-Step Verification is on.').waitFor();
    await deviceOne.getByRole('button', { name: 'Back' }).click();
    await deviceOne.getByRole('button', { name: 'Close' }).click();
  });

  it('a second device needs the 2-Step password; the first device gets a login alert and can end that session', async () => {
    const deviceTwo = await newPage();
    await studentSignIn(deviceTwo, STUDENT_A);
    await deviceTwo.getByRole('heading', { name: '2-Step Verification' }).waitFor();
    await deviceTwo.getByText('Hint: river').waitFor();
    await shot(deviceTwo, '06-login-two-step');
    await deviceTwo.getByLabel('Password').fill('wrong password');
    await deviceTwo.getByRole('button', { name: 'Continue' }).click();
    await deviceTwo.getByText('Incorrect password.').waitFor();
    await deviceTwo.getByLabel('Password').fill('blue river 42');
    await deviceTwo.getByRole('button', { name: 'Continue' }).click();
    await deviceTwo.getByText('No chats yet.').waitFor();

    // Device one: the in-app login alert appears (on focus), and the session can be ended from Devices.
    await deviceOne.evaluate(() => window.dispatchEvent(new Event('focus')));
    await deviceOne.getByText(/New sign-in to your account on Chrome/).waitFor();
    await shot(deviceOne, '07-login-alert');
    await deviceOne.getByRole('button', { name: 'Review devices' }).click();
    await deviceOne.getByText('This device').waitFor();
    await shot(deviceOne, '08-devices');
    await deviceOne.getByRole('button', { name: 'End', exact: true }).click();
    await deviceOne.getByText('No other devices are signed in.').waitFor();
    await deviceOne.getByRole('button', { name: 'Back' }).click();
    await deviceOne.getByRole('button', { name: 'Close' }).click();

    // Device two is signed out on its next request.
    await deviceTwo.reload();
    await deviceTwo.waitForURL(`${WEB_URL}/login`);
    await deviceTwo.getByRole('heading', { name: 'Sign in to Bedo Chat' }).waitFor();
  });

  it('a student requests deletion; the admin reviews the history and approves; the student is signed out', async () => {
    await deviceOne.getByRole('button', { name: 'Settings' }).click();
    await deviceOne.getByRole('button', { name: 'Delete account' }).click();
    await deviceOne.getByRole('button', { name: 'Request account deletion' }).click();
    await deviceOne.getByRole('button', { name: 'Send request' }).click();
    await deviceOne.getByText('Your request to delete your account has been sent.').waitFor();
    await deviceOne.getByRole('button', { name: 'Back' }).click();
    await deviceOne.getByRole('button', { name: 'Close' }).click();
    await deviceOne.getByText('Account deletion requested.').waitFor();

    await adminPage.getByRole('button', { name: 'Deletion requests' }).click();
    await adminPage.getByRole('button', { name: /Mona Adel/ }).click();
    await adminPage.getByRole('heading', { name: 'Identity history' }).waitFor();
    await adminPage.getByText('username changed').waitFor();
    await adminPage.getByLabel('Reason (optional, kept in the audit history)').fill('Student graduated');
    await adminPage.getByRole('button', { name: 'Approve', exact: true }).click();
    await adminPage.getByRole('button', { name: 'Approve and delete' }).click();
    await adminPage.getByText(/Decided: .* by Head Office/).waitFor();
    // The identity the account had is still shown to admins.
    await adminPage.getByRole('heading', { name: 'Mona Adel' }).waitFor();
    await shot(adminPage, '09-admin-deletion-approved');

    await deviceOne.reload();
    await deviceOne.waitForURL(`${WEB_URL}/login`);
    await deviceOne.getByText('This account has been deleted.').waitFor();
    await shot(deviceOne, '10-login-deleted');

    const user = await query<{ status: string; phone: string | null; name: string | null }>(
      stack.ownerUrl,
      "select u.status, u.phone, u.name from app.users u join audit.account_events e on e.user_id = u.id where e.event = 'deletion_approved'",
    );
    expect(user.rows).toEqual([{ status: 'deleted', phone: null, name: null }]);
    const adminActions = await query<{ action: string }>(stack.ownerUrl, "select action from app.audit_log where actor_type = 'admin' order by id");
    expect(adminActions.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['admin.signed_in', 'phone_list.add', 'phone_list.import', 'view.deletion_request', 'account.deletion_approved']),
    );
  });

  it('an admin resets a forgotten 2-Step password after an identity check; the student is told', async () => {
    const student = await newPage();
    await studentSignIn(student, STUDENT_B);
    await student.getByLabel('Name').fill('Omar Samy');
    await student.getByRole('button', { name: 'Continue' }).click();
    await student.getByText('No chats yet.').waitFor();
    await student.getByRole('button', { name: 'Settings' }).click();
    await student.getByRole('button', { name: '2-Step Verification' }).click();
    await student.getByRole('button', { name: 'Set password' }).click();
    await student.getByLabel('New password', { exact: true }).fill('forgotten one 7');
    await student.getByLabel('Repeat new password').fill('forgotten one 7');
    await student.getByRole('button', { name: 'Save' }).click();
    await student.getByText('2-Step Verification is on.').waitFor();

    await adminPage.getByRole('button', { name: '2-Step reset' }).click();
    await adminPage.getByLabel('Account phone number').fill(STUDENT_B);
    await adminPage.getByLabel('How was the identity checked?').fill('Checked academy ID card in person');
    await adminPage.getByRole('button', { name: 'Continue' }).click();
    await adminPage.getByRole('button', { name: 'Reset', exact: true }).click();
    await adminPage.getByText(`2-Step Verification was reset for ${STUDENT_B}.`).waitFor();

    await student.getByRole('button', { name: 'Back' }).click();
    await student.getByRole('button', { name: 'Notifications' }).click();
    await student.getByText('An administrator reset your 2-Step Verification password at your request.').first().waitFor();
    await shot(student, '11-notifications');
  });

  it('a Moderator can view but not change anything, and admin sign-out ends the session', async () => {
    const moderatorSecret = await createAdmin(stack, MODERATOR, 'Floor Moderator', 'moderator');
    const page = await newPage();
    await page.goto(`${ADMIN_URL}/login`);
    await page.getByLabel('Phone number').fill(MODERATOR);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Authenticator code').fill(totpNow(moderatorSecret));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Floor Moderator · Moderator').waitFor();
    await page.getByText('Your Moderator role can view the list.').waitFor();
    expect(await page.getByRole('button', { name: '2-Step reset' }).count()).toBe(0);
    expect(await page.getByRole('heading', { name: 'Add a number' }).count()).toBe(0);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(`${ADMIN_URL}/login`);
    await page.goto(`${ADMIN_URL}/`);
    await page.waitForURL(`${ADMIN_URL}/login`);
  });
});
