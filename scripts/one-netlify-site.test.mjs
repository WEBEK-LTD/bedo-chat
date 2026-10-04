// D-26: one Netlify site serves the student web app and, under /admin, the Admin Dashboard's static export.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bundleAdmin, checkAdminExport } from './bundle-admin-into-web.mjs';
import { headersFor, parseSiteRules, pathMatches, readSiteRules, resolveStatic, staticCandidates } from './netlify-site-rules.mjs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/** The Admin Dashboard's security headers, as its own Next.js configuration set them before D-26. */
const ADMIN_SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), display-capture=(), geolocation=()',
};

test('the admin app is a static export under /admin, with no server-side configuration left', () => {
  const config = read('apps/admin/next.config.ts');
  assert.match(config, /basePath: '\/admin'/);
  assert.match(config, /output: 'export'/);
  // Static exports ignore these; the admin's headers live in apps/web/netlify.toml instead.
  assert.doesNotMatch(config, /headers\(\)|rewrites\(\)|redirects\(\)/);
});

test('the one Netlify site needs no routing rules: no redirects or rewrites, and no /admin catch-all', () => {
  // Netlify answers with a matching static file, or else the Next.js server function (path /*), before it
  // looks at redirect rules, so rules for these paths would never run.
  assert.deepEqual(readSiteRules().redirects, []);
  assert.doesNotMatch(read('apps/web/netlify.toml'), /^\s*\[\[redirects\]\]/m);
});

test("Netlify's static file matching serves the admin pages, and only them, from the admin export", () => {
  assert.deepEqual(staticCandidates('/admin/login'), [
    '/admin/login',
    '/admin/login.html',
    '/admin/login.htm',
    '/admin/login/index.html',
    '/admin/login/index.htm',
  ]);
  assert.deepEqual(staticCandidates('/admin/'), ['/admin/', '/admin.html', '/admin.htm', '/admin/index.html', '/admin/index.htm']);
  assert.deepEqual(staticCandidates('/sw.js'), ['/sw.js']);
  const root = mkdtempSync(path.join(tmpdir(), 'bedo-site-'));
  try {
    // The layout of apps/web/public after the build: the student's sw.js and the admin export.
    mkdirSync(path.join(root, 'admin', 'login'), { recursive: true });
    mkdirSync(path.join(root, 'admin', '_next', 'static', 'chunks'), { recursive: true });
    for (const file of ['sw.js', 'admin/index.html', 'admin/login.html', 'admin/login.txt', 'admin/login/__next._tree.txt', 'admin/_next/static/chunks/a.js']) {
      writeFileSync(path.join(root, file), '');
    }
    const served = (request) => {
      const file = resolveStatic(root, request);
      return file === null ? null : path.relative(root, file).split(path.sep).join('/');
    };
    assert.equal(served('/admin'), 'admin/index.html');
    assert.equal(served('/admin/'), 'admin/index.html');
    assert.equal(served('/admin/login'), 'admin/login.html');
    assert.equal(served('/admin/login/'), 'admin/login.html');
    assert.equal(served('/admin/login.txt'), 'admin/login.txt');
    assert.equal(served('/admin/_next/static/chunks/a.js'), 'admin/_next/static/chunks/a.js');
    assert.equal(served('/sw.js'), 'sw.js');
    // Student pages and anything unknown go to the Next.js server.
    for (const request of ['/', '/login', '/admin/unknown', '/administrator', '/api/v1/me']) {
      assert.equal(served(request), null, request);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('admin pages and files keep the Admin Dashboard security headers; student pages are not affected', () => {
  const rules = readSiteRules();
  for (const request of ['/admin', '/admin/', '/admin/login', '/admin/login.html', '/admin/index.txt', '/admin/_next/static/chunks/a.js']) {
    const headers = headersFor(rules, request);
    for (const [name, value] of Object.entries(ADMIN_SECURITY_HEADERS)) {
      assert.equal(headers[name], value, `${name} on ${request}`);
    }
  }
  assert.equal(headersFor(rules, '/admin/_next/static/chunks/a.js')['Cache-Control'], 'public, max-age=31536000, immutable');
  assert.equal(headersFor(rules, '/admin/login')['Cache-Control'], undefined);
  for (const request of ['/', '/login', '/sw.js', '/administrator']) {
    assert.deepEqual(headersFor(rules, request), {}, request);
  }
});

test('the site config keeps one build and one publish directory, and no server secrets', async () => {
  const toml = read('apps/web/netlify.toml');
  assert.match(toml, /^\s*command = "pnpm turbo run build --filter=@bedo\/web"$/m);
  assert.match(toml, /^\s*publish = "apps\/web\/\.next"$/m);
  const { SERVER_ONLY_ENV_NAMES } = await import('../packages/config/dist/index.js');
  for (const secret of SERVER_ONLY_ENV_NAMES) assert.ok(!toml.includes(secret), secret);
});

test('the web build always builds the admin export first, and neither build is replayed from cache', () => {
  const turbo = JSON.parse(read('turbo.json'));
  const web = turbo.tasks['@bedo/web#build'];
  const admin = turbo.tasks['@bedo/admin#build'];
  assert.ok(web.dependsOn.includes('@bedo/admin#build'));
  assert.ok(web.dependsOn.includes('^build'));
  // A replayed cache adds files but never removes old ones, so a cached build could leave files from an
  // earlier build in the combined artifact.
  assert.equal(web.cache, false);
  assert.equal(admin.cache, false);
  // The build environment rules are the same as every other build.
  for (const task of [web, admin]) {
    assert.deepEqual(task.env, turbo.tasks.build.env);
    assert.deepEqual(task.passThroughEnv, turbo.tasks.build.passThroughEnv);
  }
  const pkg = JSON.parse(read('apps/web/package.json'));
  assert.equal(pkg.scripts.build, 'node ../../scripts/bundle-admin-into-web.mjs && next build');
  assert.match(read('.gitignore'), /^apps\/web\/public\/admin\/$/m);
});

/** The value of `key` in a `[table]` of a netlify.toml (string values only). */
function tomlValue(toml, table, key) {
  const start = toml.indexOf(`\n[${table}]`);
  if (start < 0) return undefined;
  const end = toml.slice(start + 1).search(/\n\[/);
  const section = end < 0 ? toml.slice(start) : toml.slice(start, start + 1 + end);
  return new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm').exec(section)?.[1];
}

test('a Netlify build from apps/admin fails with the explicit one-site guard message (Phase 2.3.1)', () => {
  const command = tomlValue(read('apps/admin/netlify.toml'), 'build', 'command');
  assert.ok(command, 'apps/admin/netlify.toml has a build command');
  // Netlify runs the build command with a shell from the base directory (the repository root).
  const result = spawnSync('sh', ['-c', command], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 1, 'the build must fail');
  assert.equal(result.stdout, '');
  const message = result.stderr.trim();
  assert.match(message, /^ERROR: Bedo Chat production uses ONE Netlify site \(D-26\)\./);
  assert.match(message, /The production Package directory must be apps\/web, not apps\/admin\./);
  assert.match(message, /would deploy the Admin Dashboard alone at the site root/);
  assert.match(message, /Set the Package directory of the Netlify site to apps\/web and deploy again/);
});

test('the Student Web production build sets NEXT_PUBLIC_API_URL=https://bedochat.com/api (Phase 2.3.1)', () => {
  const toml = read('apps/web/netlify.toml');
  assert.equal(tomlValue(toml, 'build.environment', 'NEXT_PUBLIC_API_URL'), 'https://bedochat.com/api');
  // Set once, in the build environment of the one site (not per context, not elsewhere).
  assert.equal(toml.match(/NEXT_PUBLIC_API_URL\s*=/g)?.length, 1);
  assert.equal(tomlValue(read('apps/admin/netlify.toml'), 'build.environment', 'NEXT_PUBLIC_API_URL'), undefined);
});

function fakeExport(root, buildId = 'build-1') {
  const exportDir = path.join(root, 'out');
  const nextDir = path.join(root, '.next');
  mkdirSync(path.join(exportDir, '_next', 'static', buildId), { recursive: true });
  mkdirSync(path.join(exportDir, '_next', 'static', 'chunks'), { recursive: true });
  mkdirSync(nextDir, { recursive: true });
  writeFileSync(path.join(nextDir, 'BUILD_ID'), buildId);
  writeFileSync(path.join(exportDir, 'index.html'), '<title>Bedo Chat Admin</title>');
  writeFileSync(path.join(exportDir, 'login.html'), '<title>Sign in · Bedo Chat Admin</title>');
  writeFileSync(path.join(exportDir, '_next', 'static', 'chunks', 'a.js'), '');
  return { exportDir, nextDir };
}

test('bundling replaces the web app copy with the latest complete admin export', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bedo-bundle-'));
  try {
    const { exportDir, nextDir } = fakeExport(root);
    const targetDir = path.join(root, 'public', 'admin');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'left-over.js'), 'from an earlier build');
    bundleAdmin({ exportDir, nextDir, targetDir });
    assert.ok(existsSync(path.join(targetDir, 'index.html')));
    assert.ok(existsSync(path.join(targetDir, 'login.html')));
    assert.ok(existsSync(path.join(targetDir, '_next', 'static', 'chunks', 'a.js')));
    assert.ok(!existsSync(path.join(targetDir, 'left-over.js')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bundling refuses a missing, incomplete or out-of-date admin export', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bedo-bundle-'));
  try {
    assert.match(checkAdminExport(path.join(root, 'none'), path.join(root, '.next'))[0], /no admin export/);
    const { exportDir, nextDir } = fakeExport(root);
    assert.deepEqual(checkAdminExport(exportDir, nextDir), []);
    writeFileSync(path.join(nextDir, 'BUILD_ID'), 'build-2');
    assert.match(checkAdminExport(exportDir, nextDir).join(), /latest admin build/);
    writeFileSync(path.join(nextDir, 'BUILD_ID'), 'build-1');
    rmSync(path.join(exportDir, 'login.html'));
    assert.match(checkAdminExport(exportDir, nextDir).join(), /missing login\.html/);
    const targetDir = path.join(root, 'public', 'admin');
    assert.throws(() => bundleAdmin({ exportDir, nextDir, targetDir }), /Cannot add the Admin Dashboard/);
    assert.ok(!existsSync(targetDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the rules reader understands the parts of netlify.toml this site uses', () => {
  const rules = parseSiteRules(`
[build]
  command = "x"
[[redirects]]
  from = "/a"
  to = "/a.html"
  status = 200
  force = true
[[headers]]
  for = "/a/*"
  [headers.values]
    X-Test = "yes"
[build.environment]
  NODE_VERSION = "24"
`);
  assert.deepEqual(rules, {
    redirects: [{ from: '/a', to: '/a.html', status: 200, force: true }],
    headers: [{ for: '/a/*', values: { 'X-Test': 'yes' } }],
  });
  assert.ok(pathMatches('/a/*', '/a/b/c'));
  assert.ok(!pathMatches('/a/*', '/ab'));
  assert.ok(pathMatches('/a', '/a/'));
});
