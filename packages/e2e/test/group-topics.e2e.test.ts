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

const OWNER = '+201000006301';
const MEMBER = '+201000006302';

/**
 * D-63 end to end in a real browser: a group starts without topics; its owner turns Topics on in the group info and
 * creates a topic; both see the topic bar, post into a topic and General, and see only that topic's messages when it
 * is chosen; a closed topic takes the composer away from members; turning Topics off brings back one conversation with
 * every message. No Content-Security-Policy violation anywhere.
 */
describe.runIf(enabled)('D-63 topics in groups in the browser', () => {
  let stack: Stack;
  let browser: Browser;
  let owner: Page;
  let member: Page;
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
  const topicBar = (page: Page) => page.getByRole('navigation', { name: 'Topics' });
  /** A topic chip by its title (a closed topic's name also says "Closed"). */
  const tab = (page: Page, name: string) => topicBar(page).getByRole('tab', { name: new RegExp(`^${name}( Closed)?$`) });

  async function openInfo(page: Page) {
    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Group info' }).click();
    return page.getByRole('dialog', { name: 'Group info' });
  }

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    for (const phone of [OWNER, MEMBER]) {
      await query(stack.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    }
    owner = await newPage('owner');
    await signIn(owner, OWNER, 'Tara Teacher');
    member = await newPage('member');
    await signIn(member, MEMBER, 'Sami Student');
  });

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await browser?.close();
    await stack?.stop();
  });

  it('starts without topics: one conversation, no topic bar', async () => {
    await owner.getByRole('button', { name: 'New group' }).click();
    const dialog = owner.getByRole('dialog', { name: 'New group' });
    await dialog.getByLabel('Group name').fill('Chemistry class');
    await dialog.getByLabel('Add people').fill('Sami');
    await dialog.getByRole('list', { name: 'People found' }).getByRole('button', { name: 'Sami Student' }).click();
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await owner.getByRole('region', { name: 'Group Chemistry class' }).waitFor();
    await composer(owner).fill('Welcome to chemistry');
    await composer(owner).press('Enter');
    await member.getByRole('button', { name: /^Chemistry class/ }).click();
    await messages(member).getByText('Welcome to chemistry').waitFor({ timeout: 10_000 });
    expect(await topicBar(member).count()).toBe(0);
    // A member sees no Topics section while topics are off.
    const info = await openInfo(member);
    await info.getByRole('heading', { name: 'Members' }).waitFor();
    expect(await info.getByRole('region', { name: 'Topics' }).count()).toBe(0);
    await info.getByRole('button', { name: 'Close group info' }).click();
  });

  it('lets the owner turn topics on and create a topic in the group info', async () => {
    const info = await openInfo(owner);
    const section = info.getByRole('region', { name: 'Topics' });
    await section.getByRole('switch', { name: 'Topics' }).check();
    await section.getByRole('button', { name: 'New topic' }).click();
    const create = owner.getByRole('dialog', { name: 'New topic' });
    await create.getByLabel('Topic name').fill('Homework');
    await create.getByRole('button', { name: 'Colour 3' }).click();
    await create.getByRole('button', { name: 'Create topic' }).click();
    await section.getByText('Homework').waitFor();
    await shot(owner, '63-topics-info');
    await info.getByRole('button', { name: 'Close group info' }).click();
    await tab(owner, 'All').waitFor();
    await tab(owner, 'General').waitFor();
    await tab(owner, 'Homework').waitFor();
    // The member's device hears of it through sync.
    await tab(member, 'Homework').waitFor({ timeout: 15_000 });
  });

  it('posts into a topic and shows only that topic’s messages when it is chosen', async () => {
    await tab(owner, 'Homework').click();
    await composer(owner).fill('Read chapter 3');
    await composer(owner).press('Enter');
    await messages(owner).getByText('Read chapter 3').waitFor();
    expect(await messages(owner).getByText('Welcome to chemistry').count()).toBe(0);

    await tab(member, 'Homework').click();
    await messages(member).getByText('Read chapter 3').waitFor({ timeout: 10_000 });
    expect(await messages(member).getByText('Welcome to chemistry').count()).toBe(0);
    await composer(member).fill('Done with chapter 3');
    await composer(member).press('Enter');
    await messages(member).getByText('Done with chapter 3').waitFor();

    await tab(member, 'General').click();
    await messages(member).getByText('Welcome to chemistry').waitFor();
    expect(await messages(member).getByText('Read chapter 3').count()).toBe(0);
    await composer(member).fill('A question for everyone');
    await composer(member).press('Enter');
    await messages(member).getByText('A question for everyone').waitFor();

    // All shows everything, each message with its topic.
    await tab(member, 'All').click();
    for (const text of ['Welcome to chemistry', 'Read chapter 3', 'Done with chapter 3', 'A question for everyone']) await messages(member).getByText(text).waitFor();
    await shot(member, '63-topics-all');
    // The owner's General has the member's question, not the homework.
    await tab(owner, 'General').click();
    await messages(owner).getByText('A question for everyone').waitFor({ timeout: 10_000 });
    expect(await messages(owner).getByText('Done with chapter 3').count()).toBe(0);
  });

  it('takes the composer away from members in a closed topic', async () => {
    const info = await openInfo(owner);
    await info.getByRole('region', { name: 'Topics' }).getByRole('button', { name: 'Close Homework' }).click();
    await info.getByRole('region', { name: 'Topics' }).getByText('Closed', { exact: false }).waitFor();
    await info.getByRole('button', { name: 'Close group info' }).click();
    await tab(member, 'Homework').waitFor({ timeout: 15_000 });
    // The closed mark arrives with the next topic list.
    await topicBar(member).getByRole('img', { name: 'Closed' }).waitFor({ timeout: 15_000 });
    await tab(member, 'Homework').click();
    await member.getByText('This topic is closed. Only admins can post in it.').waitFor();
    expect(await composer(member).count()).toBe(0);
    // The owner still posts there.
    await tab(owner, 'Homework').click();
    await composer(owner).fill('Answers are posted');
    await composer(owner).press('Enter');
    await messages(member).getByText('Answers are posted').waitFor({ timeout: 10_000 });
  });

  it('turning topics off brings back one conversation with every message', async () => {
    const info = await openInfo(owner);
    await info.getByRole('region', { name: 'Topics' }).getByRole('switch', { name: 'Topics' }).uncheck();
    await info.getByRole('button', { name: 'Close group info' }).click();
    await topicBar(member).waitFor({ state: 'detached', timeout: 15_000 });
    for (const text of ['Welcome to chemistry', 'Read chapter 3', 'A question for everyone', 'Answers are posted']) await messages(member).getByText(text).waitFor();
    await composer(member).waitFor();
    expect(violations).toEqual([]);
  });
});
