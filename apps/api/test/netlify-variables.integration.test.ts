import { readFileSync } from 'node:fs';
import { apiEnvSchema, loadEnv } from '@bedo/config';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { encryptWaabekApiKey } from '@bedo/server-crypto';
import { type IntegrationEnv, query, SETTINGS_KEY, setupIntegrationEnv } from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const SCRIPT = readFileSync(new URL('../../../docs/owner-sql/netlify-variables.sql', import.meta.url), 'utf8');

/** Runs the owner script as the SQL Editor would (all statements at once) and returns the shown lines. */
async function runScript(ctx: IntegrationEnv, login: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: ctx.ownerUrl });
  await client.connect();
  try {
    const results = (await client.query(SCRIPT.replace("login_role   constant text := 'bedo_api'", `login_role   constant text := '${login}'`))) as unknown as pg.QueryResult[];
    return results.at(-1)!.rows.map((row) => Object.values(row)[0] as string);
  } finally {
    await client.end();
  }
}

/**
 * Phase 13 go-live: docs/owner-sql/netlify-variables.sql makes every server variable the site needs (D-36) from the
 * Supabase SQL Editor, so the owner needs no terminal or key generator.
 */
describe.runIf(enabled)('owner SQL: the Netlify server variables', () => {
  let ctx: IntegrationEnv | undefined;

  afterEach(async () => {
    await ctx?.teardown();
    ctx = undefined;
  });

  it('sets a new database password and makes keys the API accepts', async () => {
    ctx = await setupIntegrationEnv({}, { waabekKey: false });
    const login = new URL(ctx.runtimeUrl).username;
    const lines = await runScript(ctx, login);
    expect(lines.map((line) => line.split('=')[0])).toEqual([
      'DATABASE_URL',
      'ACCESS_TOKEN_SECRET',
      'OTP_HMAC_SECRET',
      'ADMIN_TOTP_KEY',
      'SETTINGS_ENCRYPTION_KEY',
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_JWT_SECRET',
    ]);
    const values = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    expect(values.DATABASE_URL).toMatch(new RegExp(`^postgresql://${login}\\.cspnnzoyuyxjiyhwzgqj:[0-9a-f]{48}@aws-0-ap-southeast-2\\.pooler\\.supabase\\.com:6543/postgres$`));
    expect(values.SUPABASE_URL).toBe('https://cspnnzoyuyxjiyhwzgqj.supabase.co');
    // The new password is the login's password now.
    const password = new URL(values.DATABASE_URL!).password;
    const runtime = Object.assign(new URL(ctx.runtimeUrl), { password });
    expect((await query(runtime.toString(), 'select current_user as who')).rows[0]!.who).toBe(login);
    // Every generated value passes the API's own checks (the Supabase lines are filled in by hand).
    const env = loadEnv(apiEnvSchema, {
      NODE_ENV: 'production',
      DATABASE_URL: values.DATABASE_URL,
      ACCESS_TOKEN_SECRET: values.ACCESS_TOKEN_SECRET,
      OTP_HMAC_SECRET: values.OTP_HMAC_SECRET,
      ADMIN_TOTP_KEY: values.ADMIN_TOTP_KEY,
      SETTINGS_ENCRYPTION_KEY: values.SETTINGS_ENCRYPTION_KEY,
    });
    expect(Buffer.from(env.ADMIN_TOTP_KEY, 'base64')).toHaveLength(32);
    expect(env.ADMIN_TOTP_KEY).not.toBe(env.SETTINGS_ENCRYPTION_KEY);
    // A second run makes new values.
    const again = await runScript(ctx, login);
    expect(again[1]).not.toBe(lines[1]);
  });

  it('stops without changing anything once secrets are stored with the current keys', async () => {
    ctx = await setupIntegrationEnv({}, { waabekKey: false });
    const login = new URL(ctx.runtimeUrl).username;
    await query(ctx.ownerUrl, 'update app.otp_settings set waabek_api_key_enc = $1', [encryptWaabekApiKey(SETTINGS_KEY, 'waabek-key-for-this-test')]);
    await expect(runScript(ctx, login)).rejects.toThrow(/already stored secrets/);
    // The old password still works.
    expect((await query(ctx.runtimeUrl, 'select 1 as ok')).rows[0]!.ok).toBe(1);
  });
});
