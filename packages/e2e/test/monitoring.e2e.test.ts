import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, ADMIN_URL, createAdmin, launchBrowser, query, type Stack, startStack, totpNow } from './stack.js';

/** Set E2E_SCREENSHOTS=<folder> to save screenshots of the monitoring page. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
  }
}

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const ADMIN = '+201000017900';

/**
 * Phase 14.5: site monitoring in the Admin Dashboard. Before the first minute check it says monitoring starts soon;
 * after the site's minute calls it shows the site up; a gap shows as an incident and a WhatsApp alert to the Super
 * Admin; "Check now" measures on demand.
 */
describe.runIf(enabled)('Phase 14.5 site monitoring in the Admin Dashboard', () => {
  let stack: Stack;
  let browser: Browser;
  let context: BrowserContext;
  let admin: Page;
  const violations: string[] = [];

  beforeAll(async () => {
    stack = await startStack();
    browser = await launchBrowser();
    const secret = await createAdmin(stack, ADMIN, 'Head Office', 'super_admin');
    context = await browser.newContext();
    admin = await context.newPage();
    admin.on('console', (message) => {
      if (/Content.Security.Policy|Refused to/i.test(message.text())) violations.push(message.text());
    });
    admin.on('pageerror', (error) => violations.push(error.message));
    await admin.goto(`${ADMIN_URL}/login`);
    await admin.getByLabel('Phone number').fill(ADMIN);
    await admin.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Continue' }).click();
    await admin.getByLabel('Authenticator code').fill(totpNow(secret));
    await admin.getByRole('button', { name: 'Sign in' }).click();
    await admin.getByRole('heading', { name: 'Overview' }).waitFor();
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await stack?.stop();
  });

  const open = async () => {
    await admin.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Site monitoring' }).click();
    await admin.getByRole('heading', { name: 'Site monitoring' }).waitFor();
  };

  it('shows the site up after the minute checks, an outage as an incident, and checks on demand', async () => {
    await open();
    await admin.getByTestId('monitoring-status').getByText('Monitoring starts soon').waitFor();

    expect(await stack.minuteCall()).toBe(200);
    await admin.reload();
    await open();
    await admin.getByTestId('monitoring-status').getByText('Bedo Chat is up').waitFor();
    await admin.getByRole('img', { name: /ten-minute periods without a check/ }).waitFor();

    // The site could not be reached for a while: the next minute call records it and tells the Super Admin.
    await query(stack.ownerUrl, "update app.site_checks set checked_at = checked_at - interval '25 minutes'");
    expect(await stack.minuteCall()).toBe(200);
    await admin.reload();
    await open();
    const incidents = admin.getByRole('list', { name: 'Incidents' });
    await incidents.getByText('Site not reachable').waitFor();
    await incidents.getByText('Told on WhatsApp').waitFor();
    expect(stack.waabekMessages().some((message) => message.phone.replace('+', '') === ADMIN.replace('+', '') && /could not be reached/.test(message.text))).toBe(true);

    await admin.getByRole('button', { name: 'Check now' }).click();
    await admin.getByTestId('check-result').getByText(/^Working\. Database step/).waitFor();
    await shot(admin, '60-admin-monitoring');
    expect(violations).toEqual([]);
  });
});
