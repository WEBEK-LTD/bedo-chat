import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertMigrationConnection, checksumOf, MigrationIntegrityError, readMigrationFiles } from './migrator.js';
import { defaultMigrationsDir } from './paths.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bedo-migrations-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readMigrationFiles', () => {
  it('returns migrations sorted by version and ignores non-SQL files', async () => {
    await writeFile(path.join(dir, '20261005000000_second.sql'), 'select 2;');
    await writeFile(path.join(dir, '20261004000000_first.sql'), 'select 1;');
    await writeFile(path.join(dir, 'README.md'), 'notes');
    const files = await readMigrationFiles(dir);
    expect(files.map((file) => file.fileName)).toEqual(['20261004000000_first.sql', '20261005000000_second.sql']);
    expect(files.every((file) => file.transactional)).toBe(true);
  });

  it('rejects badly named migration files', async () => {
    await writeFile(path.join(dir, '2026_bad-name.sql'), 'select 1;');
    await expect(readMigrationFiles(dir)).rejects.toBeInstanceOf(MigrationIntegrityError);
  });

  it('rejects two migrations with the same version', async () => {
    await writeFile(path.join(dir, '20261004000000_a.sql'), 'select 1;');
    await writeFile(path.join(dir, '20261004000000_b.sql'), 'select 2;');
    await expect(readMigrationFiles(dir)).rejects.toThrow(/share version/);
  });

  it('rejects empty migrations', async () => {
    await writeFile(path.join(dir, '20261004000000_empty.sql'), '  \n');
    await expect(readMigrationFiles(dir)).rejects.toThrow(/empty/);
  });

  it('detects the no-transaction marker', async () => {
    await writeFile(
      path.join(dir, '20261004000000_index.sql'),
      '-- bedo:no-transaction\ncreate index concurrently x on y (z);',
    );
    const [file] = await readMigrationFiles(dir);
    expect(file?.transactional).toBe(false);
  });

  it('rejects explicit transaction control in a transactional migration', async () => {
    await writeFile(path.join(dir, '20261004000000_tx.sql'), 'begin;\ncreate table x (id int);\ncommit;');
    await expect(readMigrationFiles(dir)).rejects.toThrow(/BEGIN\/COMMIT\/ROLLBACK/);
  });

  it('accepts PL/pgSQL blocks that use begin and end', async () => {
    await writeFile(
      path.join(dir, '20261004000000_fn.sql'),
      'create function f() returns void language plpgsql as $$\nbegin\n  perform 1;\nend;\n$$;',
    );
    await expect(readMigrationFiles(dir)).resolves.toHaveLength(1);
  });

  it('reads the real repository migrations', async () => {
    const files = await readMigrationFiles(defaultMigrationsDir());
    expect(files[0]?.fileName).toBe('20261004000000_baseline.sql');
  });
});

describe('checksumOf', () => {
  it('ignores CRLF versus LF line endings', () => {
    expect(checksumOf('select 1;\r\nselect 2;\r\n')).toBe(checksumOf('select 1;\nselect 2;\n'));
  });

  it('changes when content changes', () => {
    expect(checksumOf('select 1;')).not.toBe(checksumOf('select 2;'));
  });
});

describe('assertMigrationConnection', () => {
  it('refuses the Supabase transaction pooler port', () => {
    expect(() =>
      assertMigrationConnection('postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'),
    ).toThrow(/6543/);
  });

  it('accepts direct and session-mode connections', () => {
    expect(() => assertMigrationConnection('postgresql://postgres:pw@db.ref.supabase.co:5432/postgres')).not.toThrow();
    expect(() => assertMigrationConnection('postgresql://postgres@localhost/bedo')).not.toThrow();
  });
});
