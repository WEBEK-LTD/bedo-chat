import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, runMigrations } from '../src/index.js';
import { createTempDatabase, type TempDatabase } from './temp-database.js';

/**
 * Phase 2 schema: the permanent audit history is append-only for the application, and the runtime
 * role has exactly the privileges the application needs (D-17, baseline role design).
 */
describe('Phase 2 schema against a real Postgres', () => {
  let database: TempDatabase;
  let runtimeUrl: string;
  const adminUrl = () => process.env.TEST_DATABASE_URL!;
  const login = `bedo_test_rt_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');

  async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await client.query<T>(sql, params);
    } finally {
      await client.end();
    }
  }

  let userId: string;

  beforeAll(async () => {
    database = await createTempDatabase();
    await runMigrations({ connectionString: database.url, migrationsDir: defaultMigrationsDir() });
    await q(adminUrl(), `create role ${login} login password '${password}' in role bedo_runtime`);
    const url = new URL(database.url);
    url.username = login;
    url.password = password;
    runtimeUrl = url.toString();
    const user = await q<{ id: string }>(database.url, "insert into app.users (phone, name) values ('+201000000001', 'Test') returning id");
    userId = user.rows[0]!.id;
  });

  afterAll(async () => {
    await database?.drop();
    await q(adminUrl(), `drop role if exists ${login}`);
  });

  describe('audit history is append-only for the runtime role', () => {
    const tables = ['audit.identity_history', 'audit.account_events', 'audit.security_events', 'app.audit_log'];

    it('can insert and read every audit table', async () => {
      await q(runtimeUrl, "insert into audit.identity_history (user_id, field, old_value, new_value, actor_type) values ($1, 'name', 'A', 'B', 'user')", [userId]);
      await q(runtimeUrl, "insert into audit.account_events (user_id, event, actor_type) values ($1, 'created', 'system')", [userId]);
      await q(runtimeUrl, "insert into audit.security_events (subject_type, subject_id, event) values ('user', $1, 'login_succeeded')", [userId]);
      await q(runtimeUrl, "insert into app.audit_log (actor_type, action) values ('system', 'test')");
      for (const table of tables) {
        const rows = await q(runtimeUrl, `select count(*)::int as n from ${table}`);
        expect(rows.rows[0]?.n, table).toBeGreaterThan(0);
      }
    });

    for (const table of tables) {
      it(`refuses UPDATE, DELETE and TRUNCATE on ${table}`, async () => {
        const column = table === 'audit.identity_history' ? 'new_value' : table === 'app.audit_log' ? 'action' : 'event';
        await expect(q(runtimeUrl, `update ${table} set ${column} = ${column}`)).rejects.toThrow(/permission denied/);
        await expect(q(runtimeUrl, `delete from ${table}`)).rejects.toThrow(/permission denied/);
        await expect(q(runtimeUrl, `truncate ${table}`)).rejects.toThrow(/permission denied/);
      });

      it(`refuses UPDATE and DELETE on ${table} even for the table owner (trigger)`, async () => {
        await expect(q(database.url, `delete from ${table}`)).rejects.toThrow(/append-only/);
        await expect(q(database.url, `truncate ${table}`)).rejects.toThrow(/append-only/);
      });
    }

    it('cannot disable the protecting triggers', async () => {
      await expect(q(runtimeUrl, 'alter table audit.identity_history disable trigger all')).rejects.toThrow(/must be owner/);
    });
  });

  describe('runtime role privileges on account tables', () => {
    it('cannot delete accounts, sessions, deletion requests, notices or code challenges', async () => {
      for (const table of ['app.users', 'app.sessions', 'app.account_deletion_requests', 'app.security_notices', 'app.otp_challenges']) {
        await expect(q(runtimeUrl, `delete from ${table}`), table).rejects.toThrow(/permission denied/);
      }
    });

    it('may remove phone-list entries (D-24) but never change them', async () => {
      await q(database.url, "insert into app.academy_phone_list (phone, added_by) values ('+201000000077', gen_random_uuid())");
      await expect(q(runtimeUrl, "update app.academy_phone_list set note = 'x'")).rejects.toThrow(/permission denied/);
      const removed = await q(runtimeUrl, "delete from app.academy_phone_list where phone = '+201000000077'");
      expect(removed.rowCount).toBe(1);
    });

    it('cannot create admin accounts or change an admin role', async () => {
      await expect(
        q(runtimeUrl, "insert into app.admin_accounts (phone, name, role, totp_secret_enc) values ('+201000000009', 'X', 'super_admin', 'x')"),
      ).rejects.toThrow(/permission denied/);
      await expect(q(runtimeUrl, "update app.admin_accounts set role = 'super_admin'")).rejects.toThrow(/permission denied/);
    });

    it('cannot rewrite who decided a deletion request after the fact other than through the decision columns', async () => {
      await expect(q(runtimeUrl, 'update app.account_deletion_requests set requested_at = now()')).rejects.toThrow(/permission denied/);
    });
  });

  describe('account constraints', () => {
    it('allows only one pending deletion request per user', async () => {
      await q(database.url, 'insert into app.account_deletion_requests (user_id) values ($1)', [userId]);
      await expect(q(database.url, 'insert into app.account_deletion_requests (user_id) values ($1)', [userId])).rejects.toThrow(
        /deletion_requests_one_pending/,
      );
    });

    it('refuses a deleted account that still carries identity', async () => {
      await expect(q(database.url, "update app.users set status = 'deleted' where id = $1", [userId])).rejects.toThrow(
        /users_deleted_has_no_identity/,
      );
    });

    it('enforces unique usernames ignoring case', async () => {
      await q(database.url, "update app.users set username = 'Student_One' where id = $1", [userId]);
      const other = await q<{ id: string }>(database.url, "insert into app.users (phone) values ('+201000000002') returning id");
      await expect(q(database.url, "update app.users set username = 'student_one' where id = $1", [other.rows[0]!.id])).rejects.toThrow(
        /users_username_key/,
      );
    });

    it('rejects malformed phone numbers and usernames', async () => {
      await expect(q(database.url, "insert into app.users (phone) values ('0123')")).rejects.toThrow(/check/);
      await expect(q(database.url, "update app.users set username = '1abc' where id = $1", [userId])).rejects.toThrow(/check/);
    });
  });
});
