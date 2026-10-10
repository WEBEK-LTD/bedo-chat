// D-31: the Content-Security-Policy of the one site (student web app and Admin Dashboard).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ADMIN_CSP, storageOrigin, webCsp } from '../apps/web/csp.mjs';
import { externalizeInlineScripts, INLINE_SCRIPT_DIR } from './bundle-admin-into-web.mjs';
import { headersFor, readSiteRules } from './netlify-site-rules.mjs';

const directives = (policy) =>
  Object.fromEntries(
    policy.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );

const NONCE = 'AAECAwQFBgcICQoLDA0ODxAR';

test('the admin pages get a strict policy from both netlify.toml files, equal to ADMIN_CSP', () => {
  for (const file of ['apps/web/netlify.toml', 'apps/admin/netlify.toml']) {
    const rules = readSiteRules(new URL(`../${file}`, import.meta.url));
    for (const pathname of ['/admin', '/admin/', '/admin/login', '/admin/_next/static/chunks/a.js']) {
      assert.equal(headersFor(rules, pathname)['Content-Security-Policy'], ADMIN_CSP, `${file} ${pathname}`);
    }
    // The web app's pages are not covered by these rules: their policy (with a nonce) comes from proxy.ts.
    assert.equal(headersFor(rules, '/')['Content-Security-Policy'], undefined);
    assert.equal(headersFor(rules, '/login')['Content-Security-Policy'], undefined);
  }
  const policy = directives(ADMIN_CSP);
  assert.deepEqual(policy['default-src'], ["'none'"]);
  for (const name of ['script-src', 'style-src', 'connect-src', 'font-src']) {
    assert.deepEqual(policy[name], ["'self'"], name);
  }
  assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
  assert.deepEqual(policy['object-src'], ["'none'"]);
  assert.deepEqual(policy['base-uri'], ["'none'"]);
  assert.doesNotMatch(ADMIN_CSP, /unsafe-|\*|https?:|wss?:/);
});

test('the web app policy allows only the site (with its API, D-36) and the one Supabase project (Storage and Realtime)', () => {
  const STORAGE = 'https://abcdefghijklmnop.supabase.co';
  const policy = directives(webCsp({ nonce: NONCE, storage: STORAGE, https: true }));
  assert.deepEqual(policy['default-src'], ["'none'"]);
  assert.deepEqual(policy['script-src'], ["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
  assert.deepEqual(policy['style-src'], ["'self'", `'nonce-${NONCE}'`]);
  assert.deepEqual(policy['connect-src'], ["'self'", STORAGE, 'wss://abcdefghijklmnop.supabase.co']);
  assert.deepEqual(policy['img-src'], ["'self'", 'data:', 'blob:', STORAGE]);
  // Phase 4: chat videos, voice and video messages from the private bucket, and the page's own recordings.
  assert.deepEqual(policy['media-src'], ["'self'", 'blob:', STORAGE]);
  assert.deepEqual(policy['worker-src'], ["'self'"]);
  assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
  assert.deepEqual(policy['object-src'], ["'none'"]);
  assert.deepEqual(policy['form-action'], ["'self'"]);
  assert.ok('upgrade-insecure-requests' in policy);
  const production = webCsp({ nonce: NONCE, storage: STORAGE });
  assert.doesNotMatch(production, /unsafe-inline|unsafe-eval|\*/);
  // Without the Supabase project set, only the site itself (which includes the API) is allowed.
  const noStorage = directives(webCsp({ nonce: NONCE }));
  assert.deepEqual(noStorage['img-src'], ["'self'", 'data:', 'blob:']);
  assert.deepEqual(noStorage['media-src'], ["'self'", 'blob:']);
  assert.deepEqual(noStorage['connect-src'], ["'self'"]);
  assert.doesNotMatch(webCsp({ nonce: NONCE }), /wss?:|https?:/);
  // Local browser tests: plain http on localhost, no upgrade.
  const local = directives(webCsp({ nonce: NONCE, storage: 'https://localhost:3400' }));
  assert.deepEqual(local['connect-src'], ["'self'", 'https://localhost:3400', 'wss://localhost:3400']);
  assert.ok(!('upgrade-insecure-requests' in local));
  // next dev only: eval for React's debugging aids and inline styles of the dev overlay.
  const dev = directives(webCsp({ nonce: NONCE, dev: true }));
  assert.ok(dev['script-src'].includes("'unsafe-eval'"));
  assert.ok(dev['style-src'].includes("'unsafe-inline'"));
});

test('the storage origin must be one exact https origin', () => {
  assert.equal(storageOrigin('https://abcdefghijklmnop.supabase.co'), 'https://abcdefghijklmnop.supabase.co');
  assert.equal(storageOrigin('https://abcdefghijklmnop.supabase.co/'), 'https://abcdefghijklmnop.supabase.co');
  for (const bad of ['https://*.supabase.co', 'http://abc.supabase.co', 'https://abc.supabase.co/storage/v1', 'abc.supabase.co', 'https://user:pw@abc.supabase.co']) {
    assert.throws(() => storageOrigin(bad), /NEXT_PUBLIC_STORAGE_ORIGIN/, bad);
  }
});

test('the web app policy needs a real nonce', () => {
  assert.throws(() => webCsp({ nonce: '' }), /nonce/);
  assert.throws(() => webCsp({ nonce: "x' 'unsafe-inline" }), /nonce/);
});

test('the proxy covers the web app pages, never the Admin Dashboard, the API or static files', () => {
  const proxy = readFileSync(new URL('../apps/web/proxy.ts', import.meta.url), 'utf8');
  const source = /source: '([^']+)'/.exec(proxy)?.[1];
  assert.ok(source);
  // The matcher is a path pattern with one regular-expression group, as Next.js compiles it.
  const pattern = new RegExp(`^${source.replace(/\\\\/g, '\\')}$`);
  for (const page of ['/', '/login', '/missing-page']) assert.match(page, pattern, page);
  for (const other of ['/admin', '/admin/', '/admin/login', '/api', '/api/v1/me', '/_next/static/chunks/a.js', '/sw.js', '/favicon.ico', '/manifest.webmanifest', '/icons/icon-192.png', '/fonts/figtree-latin-wght-normal.woff2', '/flags/au.webp']) {
    assert.doesNotMatch(other, pattern, other);
  }
});

test('bundling moves the admin pages\' inline scripts into files and refuses markup the policy blocks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bedo-csp-'));
  try {
    const page =
      '<html><head><script src="/admin/_next/static/chunks/a.js" async=""></script></head><body>' +
      '<script>(self.__next_f=self.__next_f||[]).push([0])</script><script>self.__next_f.push([1,"x"])</script></body></html>';
    writeFileSync(path.join(root, 'index.html'), page);
    mkdirSync(path.join(root, 'login'), { recursive: true });
    writeFileSync(path.join(root, 'login', 'x.html'), page);
    assert.equal(externalizeInlineScripts(root), 4);
    const html = readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<script>/);
    const sources = [...html.matchAll(/src="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(sources.length, 3);
    for (const src of sources.slice(1)) {
      assert.match(src, new RegExp(`^/admin/${INLINE_SCRIPT_DIR}/[0-9a-f]{20}\\.js$`));
      assert.ok(existsSync(path.join(root, src.replace(/^\/admin\//, ''))));
    }
    // Order is kept: the first moved script is the page-data initialiser.
    assert.equal(readFileSync(path.join(root, sources[1].replace(/^\/admin\//, '')), 'utf8'), '(self.__next_f=self.__next_f||[]).push([0])');
    for (const blocked of ['<div style="color:red">x</div>', '<button onclick="x()">x</button>', '<style>a{}</style>', '<script nomodule>x()</script>']) {
      writeFileSync(path.join(root, 'index.html'), `<html><body>${blocked}</body></html>`);
      assert.throws(() => externalizeInlineScripts(root), /Content-Security-Policy/, blocked);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
