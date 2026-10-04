// D-26: one Netlify site serves both applications. The Admin Dashboard (apps/admin) is a static export under
// its /admin base path; this step puts that export into the student web app's public folder, at
// apps/web/public/admin, so the web app's build and its single Netlify deploy carry both applications.
//
// It runs as the first part of the web app's build (apps/web/package.json), after Turborepo has built the
// admin export (turbo.json: @bedo/web#build depends on @bedo/admin#build). It refuses to copy an export that
// is missing, incomplete or from a different admin build than the last one, so the combined artifact can
// never contain a stale or partial Admin Dashboard. apps/web/public/admin is generated, never committed.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/** Where the moved inline scripts go, under the admin base path (content-hashed, cached like other assets). */
export const INLINE_SCRIPT_DIR = '_next/static/inline';
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)((?:\s+(?:type="(?:text\/javascript|module)"|async|defer|id="[^"]*"|nonce="[^"]*"))*)\s*>([\s\S]*?)<\/script>/g;
/** Markup the Admin Dashboard's Content-Security-Policy (D-31) does not allow and that cannot be moved. */
const BLOCKED_MARKUP = [
  [/<style[\s>]/i, 'an inline <style> element'],
  [/\sstyle="/i, 'a style attribute'],
  [/\son[a-z]+="/i, 'an inline event handler'],
  [/<script(?![^>]*\ssrc=)[^>]*>(?!<\/script>)/i, 'an inline script that could not be moved'],
  [/javascript:/i, 'a javascript: URL'],
];

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(file);
    return entry.name.endsWith('.html') ? [file] : [];
  });
}

/**
 * D-31: the Admin Dashboard's pages are static files served with a fixed Content-Security-Policy that allows
 * same-origin script files only (no 'unsafe-inline', no per-request nonce on a static file). Next.js's static
 * export writes two small inline scripts into every page (the start of its page data); this moves each into a
 * content-hashed file under /admin/_next/static/inline/ and loads it from there, in the same place in the page,
 * so the scripts still run in the same order. Fails if a page holds anything else the policy would block.
 * Returns the number of scripts moved.
 */
export function externalizeInlineScripts(targetDir, basePath = '/admin') {
  let moved = 0;
  const outDir = path.join(targetDir, ...INLINE_SCRIPT_DIR.split('/'));
  for (const file of htmlFiles(targetDir)) {
    const html = readFileSync(file, 'utf8').replace(INLINE_SCRIPT, (_match, attributes, code) => {
      if (code.trim() === '') return _match;
      const name = `${createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 20)}.js`;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, name), code);
      moved += 1;
      const kept = attributes.replace(/\s+(?:async|defer|nonce="[^"]*")/g, '');
      return `<script${kept} src="${basePath}/${INLINE_SCRIPT_DIR}/${name}"></script>`;
    });
    for (const [pattern, what] of BLOCKED_MARKUP) {
      if (pattern.test(html)) {
        throw new Error(`Admin page ${path.relative(targetDir, file)} contains ${what}, which the Content-Security-Policy (D-31) blocks`);
      }
    }
    writeFileSync(file, html);
  }
  return moved;
}

/** Replaces `targetDir` with a copy of the admin export. Throws if the export cannot be used. */
export function bundleAdmin({ exportDir, nextDir, targetDir }) {
  const problems = checkAdminExport(exportDir, nextDir);
  if (problems.length > 0) {
    throw new Error(`Cannot add the Admin Dashboard to the web app:\n- ${problems.join('\n- ')}`);
  }
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(exportDir, targetDir, { recursive: true });
  return externalizeInlineScripts(targetDir);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  try {
    const moved = bundleAdmin({
      exportDir: path.join(repoRoot, 'apps/admin/out'),
      nextDir: path.join(repoRoot, 'apps/admin/.next'),
      targetDir: path.join(repoRoot, 'apps/web/public/admin'),
    });
    console.log(`Admin Dashboard export added to apps/web/public/admin (D-26); ${moved} inline scripts moved to files (D-31).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
