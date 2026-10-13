import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildOwnerSql, buildUpdateScripts, LIVE_APPLIED_THROUGH, migrations, OUTPUT } from './build-owner-sql.mjs';

test('docs/owner-sql/apply-updates.sql is generated from the current migrations (run node scripts/build-owner-sql.mjs)', () => {
  assert.equal(readFileSync(OUTPUT, 'utf8'), buildOwnerSql());
});

test('the owner script applies every migration after the six applied by hand, each with its checksum', () => {
  const sql = buildOwnerSql();
  for (const migration of migrations().slice(6)) {
    assert.ok(sql.includes(migration.sql.replace(/\r\n/g, '\n').trimEnd()), migration.file);
    assert.ok(sql.includes(`'${migration.checksum}'`), migration.file);
  }
  // Values are never typed into it: nothing to fill in.
  assert.doesNotMatch(sql, /PASTE_|CHANGE_ME/);
});

test('each migration after the live state has its own update script, generated and up to date', () => {
  const all = migrations();
  const later = all.slice(all.findIndex((migration) => migration.version === LIVE_APPLIED_THROUGH) + 1);
  const updates = buildUpdateScripts();
  assert.equal(updates.length, later.length);
  updates.forEach((update, index) => {
    assert.ok(update.file.endsWith(`update-${later[index].version}.sql`));
    assert.equal(readFileSync(update.file, 'utf8'), update.sql);
    assert.ok(update.sql.includes(later[index].sql.replace(/\r\n/g, '\n').trimEnd()));
    assert.ok(update.sql.includes(`'${later[index].checksum}'`));
    assert.doesNotMatch(update.sql, /PASTE_|CHANGE_ME/);
  });
});
