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

test('route check allows exactly / and /login', () => {
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
    assert.equal(checkRoutes(['/', '/login']).ok, true);
    assert.deepEqual(checkRoutes(['/']).missing, ['/login']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundle guard reads secret values from server .env files', () => {
  const env = parseEnvFile(
    '# comment\nexport DATABASE_URL="postgres://u:p@host/db" # quoted\nREDIS_URL=redis://cache:6379   # inline comment  \n\nBAD LINE',
  );
  assert.deepEqual(env, { DATABASE_URL: 'postgres://u:p@host/db', REDIS_URL: 'redis://cache:6379' });
  const needles = buildNeedles(['DATABASE_URL', 'REDIS_URL'], {}, env);
  assert.ok(needles.some((needle) => needle.text === 'postgres://u:p@host/db'));
});

test('bundle guard scans static output, prerendered pages and public/, including binary files', () => {
  const app = tempDir();
  try {
    for (const dir of ['.next/static', '.next/server/app', 'public']) mkdirSync(path.join(app, dir), { recursive: true });
    writeFileSync(path.join(app, 'public', 'leak.bin'), Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from('REDIS_URL')]));
    writeFileSync(path.join(app, '.next', 'server', 'app', 'index.body'), 'clean');
    const dirs = clientOutputDirs(app);
    assert.equal(dirs.length, 3);
    const { findings, filesScanned } = scan(dirs, buildNeedles(['REDIS_URL'], {}));
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
