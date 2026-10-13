// D-53: the site's Digital Asset Links, which let the Android app (Trusted Web Activity) open bedochat.com full
// screen. Android checks the certificate of the installed app against this list: the Google Play app signing key
// (apps installed from Google Play) and the upload key (the .apk built by the Apps workflow).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const PLAY_APP_SIGNING = 'AE:24:C2:17:29:C3:64:2F:E1:03:77:82:C2:05:8D:34:BF:B7:58:D9:8E:28:09:6A:1B:C1:E6:7B:5C:02:45:67';
const UPLOAD_KEY = 'D4:F8:B6:7E:F8:D2:49:DE:DF:0F:9B:91:F0:3F:36:89:F5:13:C6:E1:AF:79:67:05:9E:0C:FB:6B:46:6E:31:F2';

test('assetlinks.json links com.bedochat.app with both the Google Play signing key and the upload key', () => {
  const links = JSON.parse(readFileSync(new URL('../apps/web/public/.well-known/assetlinks.json', import.meta.url), 'utf8'));
  assert.equal(links.length, 1);
  const [link] = links;
  assert.deepEqual(link.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(link.target.namespace, 'android_app');
  assert.equal(link.target.package_name, 'com.bedochat.app');
  const prints = link.target.sha256_cert_fingerprints;
  for (const print of prints) assert.match(print, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, print);
  assert.ok(prints.includes(PLAY_APP_SIGNING), 'Google Play app signing key');
  assert.ok(prints.includes(UPLOAD_KEY), 'upload key');
  assert.equal(new Set(prints).size, prints.length);
});

test('the Android app is built for the same package name the site links', () => {
  const gradle = readFileSync(new URL('../apps/android/app/build.gradle', import.meta.url), 'utf8');
  assert.match(gradle, /applicationId 'com\.bedochat\.app'/);
  assert.match(gradle, /def siteHost = 'bedochat\.com'/);
});
