import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IntegrationEnv, query, setupIntegrationEnv } from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const SCRIPT = readFileSync(new URL('../../../docs/owner-sql/fix-row-level-security.sql', import.meta.url), 'utf8');

async function runScript(ctx: IntegrationEnv): Promise<Array<{ check: string; result: string }>> {
  const client = new pg.Client({ connectionString: ctx.ownerUrl });
  await client.connect();
  try {
    const results = (await client.query(SCRIPT)) as unknown as pg.QueryResult[];
    return results.at(-1)!.rows as Array<{ check: string; result: string }>;
  } finally {
    await client.end();
  }
}

/**
 * Go-live (Phase 13.2): newer Supabase projects switch row level security on for every new table, which locks the
 * API's own login out of Bedo Chat's tables. docs/owner-sql/fix-row-level-security.sql turns it off again on those
 * tables only, after checking that no Supabase API role can reach them.
 */
describe.runIf(enabled)('owner SQL: row level security on Bedo Chat tables', () => {
  let ctx: IntegrationEnv;

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('gives the API its tables back, and leaves realtime.messages protected', async () => {
    // As Supabase's automatic setting leaves them: on, with no policy.
    await query(
      ctx.ownerUrl,
      `do $$ declare t record; begin
         for t in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname in ('app', 'audit', 'app_meta') and c.relkind in ('r', 'p') loop
           execute format('alter table %I.%I enable row level security', t.nspname, t.relname);
         end loop; end $$`,
    );
    await expect(query(ctx.runtimeUrl, `insert into app.rate_counters (key, count, expires_at) values ('rl:test', 1, now())`)).rejects.toThrow(/row-level security/);

    expect(await runScript(ctx)).toEqual([
      { check: 'Bedo Chat tables with row level security on (should be none)', result: 'ok' },
      // The test database has no Supabase Realtime schema; on Supabase this line says ok.
      { check: 'row level security on realtime.messages (should stay on)', result: 'not in this database' },
    ]);
    await query(ctx.runtimeUrl, `insert into app.rate_counters (key, count, expires_at) values ('rl:test', 1, now())`);
    // Running it again changes nothing.
    expect((await runScript(ctx))[0]!.result).toBe('ok');
  });

  it('refuses when a Supabase API role could reach the tables', async () => {
    await query(ctx.ownerUrl, `do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; end $$`);
    await query(ctx.ownerUrl, 'grant usage on schema app to anon');
    await query(ctx.ownerUrl, 'alter table app.rate_counters enable row level security');
    try {
      await expect(runScript(ctx)).rejects.toThrow(/the role anon can use the schema app/);
      expect((await query(ctx.ownerUrl, `select relrowsecurity as on from pg_class where oid = 'app.rate_counters'::regclass`)).rows[0]!.on).toBe(true);
    } finally {
      await query(ctx.ownerUrl, 'revoke usage on schema app from anon');
      await query(ctx.ownerUrl, 'alter table app.rate_counters disable row level security');
    }
  });
});
