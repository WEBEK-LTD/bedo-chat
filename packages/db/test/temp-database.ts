import { randomBytes } from 'node:crypto';
import pg from 'pg';

export interface TempDatabase {
  url: string;
  drop(): Promise<void>;
}

/**
 * Creates an empty, uniquely named database on the server behind TEST_DATABASE_URL.
 * TEST_DATABASE_URL must point at a role that may create databases (e.g. the local or CI Postgres).
 */
export async function createTempDatabase(): Promise<TempDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error('TEST_DATABASE_URL is required for integration tests (see README).');
  }
  const name = `bedo_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  return {
    url: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query(`drop database if exists ${name} with (force)`);
      } finally {
        await client.end();
      }
    },
  };
}
