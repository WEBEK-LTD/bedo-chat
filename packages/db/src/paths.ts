import { fileURLToPath } from 'node:url';

/** supabase/migrations at the repository root (this file compiles to packages/db/dist/paths.js). */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
}
