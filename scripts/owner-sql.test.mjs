import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildOwnerSql, migrations, OUTPUT } from './build-owner-sql.mjs';

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
