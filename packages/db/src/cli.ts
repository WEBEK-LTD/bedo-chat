#!/usr/bin/env node
/* eslint-disable no-console -- command-line entry point */
import { loadEnv, migrationEnvSchema } from '@bedo/config';
import { getMigrationStatus, runMigrations } from './migrator.js';
import { defaultMigrationsDir } from './paths.js';

const USAGE = 'Usage: bedo-db <migrate|status>\n  MIGRATIONS_DIR overrides the default supabase/migrations directory.';

async function main(): Promise<number> {
  const command = process.argv[2];
  if (command !== 'migrate' && command !== 'status') {
    console.error(USAGE);
    return 2;
  }

  const env = loadEnv(migrationEnvSchema);
  const migrationsDir = process.env.MIGRATIONS_DIR ?? defaultMigrationsDir();

  if (command === 'migrate') {
    const result = await runMigrations({
      connectionString: env.DATABASE_URL,
      migrationsDir,
      logger: { info: (message) => console.log(message) },
    });
    console.log(
      result.applied.length === 0
        ? `Database is up to date (${result.alreadyApplied} migrations applied).`
        : `Applied ${result.applied.length} migration(s).`,
    );
    return 0;
  }

  const status = await getMigrationStatus({ connectionString: env.DATABASE_URL, migrationsDir });
  for (const entry of status) {
    const when = entry.appliedAt ? entry.appliedAt.toISOString() : '-';
    console.log(`${entry.state.padEnd(8)} ${entry.version}_${entry.name}  ${when}`);
  }
  const pending = status.filter((entry) => entry.state === 'pending').length;
  console.log(`${status.length - pending} applied, ${pending} pending.`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  },
);
