// D-26: one Netlify site serves both applications. The Admin Dashboard (apps/admin) is a static export under
// its /admin base path; this step puts that export into the student web app's public folder, at
// apps/web/public/admin, so the web app's build and its single Netlify deploy carry both applications.
//
// It runs as the first part of the web app's build (apps/web/package.json), after Turborepo has built the
// admin export (turbo.json: @bedo/web#build depends on @bedo/admin#build). It refuses to copy an export that
// is missing, incomplete or from a different admin build than the last one, so the combined artifact can
// never contain a stale or partial Admin Dashboard. apps/web/public/admin is generated, never committed.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files every complete admin export has (pages for /admin and /admin/login, and their assets). */
export const REQUIRED_FILES = ['index.html', 'login.html'];

/**
 * Checks that `exportDir` is a complete export of the admin build in `nextDir`. Returns a list of problems
 * (empty when the export can be used).
 */
export function checkAdminExport(exportDir, nextDir) {
  if (!existsSync(exportDir) || !statSync(exportDir).isDirectory()) {
    return [`no admin export at ${exportDir}; build it first (pnpm turbo run build --filter=@bedo/web builds both apps)`];
  }
  const problems = REQUIRED_FILES.filter((file) => !existsSync(path.join(exportDir, file))).map((file) => `admin export is missing ${file}`);
  const buildIdFile = path.join(nextDir, 'BUILD_ID');
  if (!existsSync(buildIdFile)) {
    problems.push(`no admin build id at ${buildIdFile}`);
    return problems;
  }
  const buildId = readFileSync(buildIdFile, 'utf8').trim();
  // Next.js writes each build's manifest under _next/static/<build id>; a different id means the export is
  // left over from another build.
  if (!existsSync(path.join(exportDir, '_next', 'static', buildId))) {
    problems.push(`admin export does not belong to the latest admin build (${buildId})`);
  }
  const chunks = path.join(exportDir, '_next', 'static', 'chunks');
  if (!existsSync(chunks) || readdirSync(chunks).length === 0) {
    problems.push('admin export has no script or style files');
  }
  return problems;
}

/** Replaces `targetDir` with a copy of the admin export. Throws if the export cannot be used. */
export function bundleAdmin({ exportDir, nextDir, targetDir }) {
  const problems = checkAdminExport(exportDir, nextDir);
  if (problems.length > 0) {
    throw new Error(`Cannot add the Admin Dashboard to the web app:\n- ${problems.join('\n- ')}`);
  }
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(exportDir, targetDir, { recursive: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  try {
    bundleAdmin({
      exportDir: path.join(repoRoot, 'apps/admin/out'),
      nextDir: path.join(repoRoot, 'apps/admin/.next'),
      targetDir: path.join(repoRoot, 'apps/web/public/admin'),
    });
    console.log('Admin Dashboard export added to apps/web/public/admin (D-26).');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
