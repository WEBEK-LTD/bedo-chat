import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildNeedles, clientOutputDirs, parseEnvFile, scan } from './check-client-bundles.mjs';
import { builtRoutes, checkRoutes, collectRoutes, forbiddenRouteDirs } from './check-web-routes.mjs';

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'bedo-check-'));
}

test('bundle guard finds a server-only variable name', () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, 'chunk.js'), 'const k = process.env.WAABEK_API_KEY;');
    const { findings } = scan([dir], buildNeedles(['WAABEK_API_KEY'], {}));
    assert.equal(findings.length, 1);
    assert.match(findings[0].label, /WAABEK_API_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundle guard finds a leaked secret value', () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, 'page.html'), '<script>var x="placeholder-value-for-tests"</script>');
    const needles = buildNeedles(['WAABEK_API_KEY'], { WAABEK_API_KEY: 'placeholder-value-for-tests' });
    const { findings } = scan([dir], needles);
    assert.ok(findings.some((finding) => finding.label === 'value of WAABEK_API_KEY'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundle guard finds the Waabek host and passes clean output', () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, 'a.js'), 'fetch("https://waabek.com/api/v1/send")');
    writeFileSync(path.join(dir, 'b.js'), 'console.log("hello")');
    const { findings, filesScanned } = scan([dir], buildNeedles([], {}));
    assert.equal(filesScanned, 2);
    assert.deepEqual(findings.map((finding) => path.basename(finding.file)), ['a.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('route check allows exactly / and /login, plus the API route handler (D-36)', () => {
  const dir = tempDir();
  try {
    mkdirSync(path.join(dir, 'login'));
    mkdirSync(path.join(dir, '(group)', 'settings'), { recursive: true });
    mkdirSync(path.join(dir, '_components'));
    writeFileSync(path.join(dir, 'page.tsx'), '');
    writeFileSync(path.join(dir, 'login', 'page.tsx'), '');
    writeFileSync(path.join(dir, '_components', 'page.tsx'), '');
    writeFileSync(path.join(dir, '(group)', 'settings', 'page.tsx'), '');
    const routes = collectRoutes(dir);
    assert.deepEqual(routes, ['/', '/login', '/settings']);
    assert.deepEqual(checkRoutes(routes).unexpected, ['/settings']);
    assert.equal(checkRoutes(['/', '/login', '/api/[[...path]]']).ok, true);
    assert.deepEqual(checkRoutes(['/']).missing, ['/login', '/api/[[...path]]']);
    // The API path is allowed only as a route handler, never as a page.
    mkdirSync(path.join(dir, 'api', '[[...path]]'), { recursive: true });
    writeFileSync(path.join(dir, 'api', '[[...path]]', 'route.ts'), '');
    assert.ok(collectRoutes(dir).includes('/api/[[...path]]'));
    rmSync(path.join(dir, 'api', '[[...path]]', 'route.ts'));
    writeFileSync(path.join(dir, 'api', '[[...path]]', 'page.tsx'), '');
    assert.ok(checkRoutes(collectRoutes(dir)).unexpected.includes('/api/[[...path]] (page)'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundle guard reads secret values from server .env files', () => {
  const env = parseEnvFile(
    '# comment\nexport DATABASE_URL="postgres://u:p@host/db" # quoted\nSUPABASE_SERVICE_ROLE_KEY=service-role-value   # inline comment  \n\nBAD LINE',
  );
  assert.deepEqual(env, { DATABASE_URL: 'postgres://u:p@host/db', SUPABASE_SERVICE_ROLE_KEY: 'service-role-value' });
  const needles = buildNeedles(['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], {}, env);
  assert.ok(needles.some((needle) => needle.text === 'postgres://u:p@host/db'));
});

test('bundle guard scans static output, prerendered pages and public/, including binary files', () => {
  const app = tempDir();
  try {
    for (const dir of ['.next/static', '.next/server/app', 'public']) mkdirSync(path.join(app, dir), { recursive: true });
    writeFileSync(path.join(app, 'public', 'leak.bin'), Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from('SUPABASE_SERVICE_ROLE_KEY')]));
    writeFileSync(path.join(app, '.next', 'server', 'app', 'index.body'), 'clean');
    const dirs = clientOutputDirs(app);
    assert.equal(dirs.length, 3);
    const { findings, filesScanned } = scan(dirs, buildNeedles(['SUPABASE_SERVICE_ROLE_KEY'], {}));
    assert.equal(filesScanned, 2);
    assert.deepEqual(findings.map((finding) => path.basename(finding.file)), ['leak.bin']);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('route check catches metadata routes, pages directories and built routes', () => {
  const web = tempDir();
  try {
    mkdirSync(path.join(web, 'app', 'login'), { recursive: true });
    writeFileSync(path.join(web, 'app', 'page.tsx'), '');
    writeFileSync(path.join(web, 'app', 'login', 'page.tsx'), '');
    writeFileSync(path.join(web, 'app', 'sitemap.ts'), '');
    assert.deepEqual(checkRoutes(collectRoutes(path.join(web, 'app'))).unexpected, ['/sitemap.ts (metadata route)']);

    mkdirSync(path.join(web, 'pages'));
    assert.deepEqual(forbiddenRouteDirs(web), ['pages']);

    assert.equal(builtRoutes(web), null);
    mkdirSync(path.join(web, '.next'));
    writeFileSync(
      path.join(web, '.next', 'app-path-routes-manifest.json'),
      JSON.stringify({ '/page': '/', '/login/page': '/login', '/_not-found/page': '/_not-found', '/x/page': '/x' }),
    );
    assert.deepEqual(builtRoutes(web), ['/', '/login', '/x']);
    assert.equal(checkRoutes(builtRoutes(web)).ok, false);
  } finally {
    rmSync(web, { recursive: true, force: true });
  }
});

test('every server-only variable reaches the build, so the bundle guard can catch a leaked value', async () => {
  const { readFileSync } = await import('node:fs');
  const { SERVER_ONLY_ENV_NAMES } = await import('../packages/config/dist/index.js');
  const turbo = JSON.parse(readFileSync(new URL('../turbo.json', import.meta.url), 'utf8'));
  const passThrough = turbo.tasks.build.passThroughEnv ?? [];
  for (const name of SERVER_ONLY_ENV_NAMES) {
    assert.ok(passThrough.includes(name), `${name} is missing from turbo.json tasks.build.passThroughEnv`);
  }
});

test('both Netlify config files build the one site (D-28) and publish from the repository root', async () => {
  const { readFileSync } = await import('node:fs');
  const { SERVER_ONLY_ENV_NAMES } = await import('../packages/config/dist/index.js');
  for (const app of ['web', 'admin']) {
    const toml = readFileSync(new URL(`../apps/${app}/netlify.toml`, import.meta.url), 'utf8');
    const value = (key) => toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
    // Netlify resolves paths in netlify.toml from the base directory (the repository root), not from
    // this app's folder: a bare ".next" would point at <repo>/.next.
    // D-28: whichever copy Netlify reads, it builds the one site from the web app (which includes the admin app).
    assert.equal(value('publish'), 'apps/web/.next', `apps/${app}/netlify.toml publish`);
    assert.equal(value('command'), 'pnpm turbo run build --filter=@bedo/web', `apps/${app}/netlify.toml command`);
    assert.equal(value('base'), undefined, `apps/${app}/netlify.toml must not set base`);
    for (const secret of SERVER_ONLY_ENV_NAMES) {
      assert.ok(!toml.includes(secret), `apps/${app}/netlify.toml must not mention ${secret}`);
    }
  }
});

test('Phase 6: the scheduled function is deployed every minute and proves itself the way the API expects', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  for (const app of ['web', 'admin']) {
    const toml = readFileSync(new URL(`../apps/${app}/netlify.toml`, import.meta.url), 'utf8');
    assert.match(toml, /^\[functions\]\s*\n\s*directory = "apps\/web\/netlify\/functions"$/m, `apps/${app}/netlify.toml [functions] directory`);
  }
  const fn = new URL('../apps/web/netlify/functions/scheduler.mts', import.meta.url);
  assert.ok(existsSync(fn), 'apps/web/netlify/functions/scheduler.mts exists');
  const source = readFileSync(fn, 'utf8');
  assert.match(source, /export const config = \{ schedule: '\* \* \* \* \*' \};/);
  assert.match(source, /'x-bedo-dispatch'/);
  assert.match(source, /\/api\/v1\/internal\/dispatch/);
  const purpose = source.match(/const DISPATCH_PURPOSE = '([^']+)'/)?.[1];
  const api = readFileSync(new URL('../apps/api/src/messaging/scheduled.service.ts', import.meta.url), 'utf8');
  assert.equal(api.match(/const DISPATCH_PURPOSE = '([^']+)'/)?.[1], purpose, 'the function and the API use the same purpose');
  // The function computes the token from the secret at run time; nothing secret is written in it.
  assert.doesNotMatch(source, /[0-9a-f]{64}/);
});

test('the web app sends its access token to every route that needs one', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../apps/web/app/_lib/api.ts', import.meta.url), 'utf8');
  const prefixes = [...source.match(/const USER_ROUTES = \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const document = JSON.parse(readFileSync(new URL('../apps/api/openapi/openapi.json', import.meta.url), 'utf8'));
  const missing = [];
  // P-28: screenshot events come from the iOS and Android apps only; the web app never calls the route.
  const notFromTheWeb = new Set(['/v1/screenshot-events']);
  for (const [path, operations] of Object.entries(document.paths)) {
    if (notFromTheWeb.has(path)) continue;
    for (const operation of Object.values(operations)) {
      const bearer = (operation.security ?? []).some((entry) => 'bearerAuth' in entry);
      if (bearer && !prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) missing.push(path);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
