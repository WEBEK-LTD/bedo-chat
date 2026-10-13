import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { connectionTls } from './database.js';
import { SUPABASE_ROOT_CA_2021, SUPABASE_ROOT_CA_2021_SHA256 } from './supabase-ca.js';

describe('database TLS (D-36)', () => {
  it('verifies every Supabase connection in full against Supabase’s root certificate', () => {
    for (const url of [
      'postgresql://bedo_api.cspnnzoyuyxjiyhwzgqj:pw@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres',
      'postgresql://bedo_api.cspnnzoyuyxjiyhwzgqj:pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres',
      'postgresql://postgres:pw@db.cspnnzoyuyxjiyhwzgqj.supabase.co:5432/postgres',
    ]) {
      expect(connectionTls(url), url).toEqual({ ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true });
    }
  });

  it('reads the host exactly as node-postgres does', () => {
    const verified = { ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true };
    for (const url of [
      'postgresql://u:p@evil.example/db?host=x.supabase.com',
      'postgresql://u:p@X.SUPABASE.COM./db',
      'postgresql://u:p@%78.supabase.com/db',
      'postgresql://u:p@db.ref.supabase.co:5432/postgres',
    ]) {
      expect(connectionTls(url), url).toEqual(verified);
    }
  });

  it('keeps TLS options that still verify, refuses ones that do not, and leaves other hosts unchanged', () => {
    expect(connectionTls('postgresql://u:p@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=verify-full&sslrootcert=/x.crt')).toBeUndefined();
    for (const mode of ['disable', 'no-verify']) {
      expect(() => connectionTls(`postgresql://u:p@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=${mode}`), mode).toThrow(
        /must verify the server certificate/,
      );
    }
    expect(connectionTls('postgresql://u:p@localhost:5432/bedo')).toBeUndefined();
    expect(connectionTls('postgresql://u:p@localhost:5432/bedo?sslmode=disable')).toBeUndefined();
    expect(connectionTls('postgresql://u:p@supabase.com.evil.example:5432/x')).toBeUndefined();
    expect(connectionTls('postgresql://u:p@evilsupabase.com:5432/x')).toBeUndefined();
  });

  it('carries the Supabase Root 2021 CA downloaded from the project dashboard', () => {
    const cert = new X509Certificate(SUPABASE_ROOT_CA_2021);
    expect(cert.fingerprint256).toBe(SUPABASE_ROOT_CA_2021_SHA256);
    expect(cert.subject).toMatch(/CN=Supabase Root 2021 CA/);
    expect(cert.subject).toBe(cert.issuer);
    expect(cert.ca).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(Date.parse(cert.validTo)).toBeGreaterThan(Date.now());
  });
});
