import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  adminCliEnvSchema,
  apiEnvSchema,
  EnvValidationError,
  loadEnv,
  migrationEnvSchema,
  NON_SECRET_SERVER_ENV_NAMES,
  SERVER_ONLY_ENV_NAMES,
  supabaseKeySignedWith,
} from './index.js';

const JWT_SECRET = 'test-project-jwt-secret-0123456789-abcdefghij';

/** A legacy Supabase API key: an HS256 JWT with a role claim, signed with the project's JWT secret. */
function signedKey(role: string, secret: string): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'supabase', ref: 'ref', role })).toString('base64url');
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

const validApiEnv = {
  DATABASE_URL: 'postgresql://user:secret-password@localhost:5432/bedo',
  ACCESS_TOKEN_SECRET: 'a'.repeat(40),
  OTP_HMAC_SECRET: 'b'.repeat(40),
  ADMIN_TOTP_KEY: Buffer.alloc(32, 7).toString('base64'),
  SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
};

describe('apiEnvSchema', () => {
  it('applies defaults to a minimal valid environment', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv);
    expect(env.DATABASE_POOL_MAX).toBe(3);
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBe(15_000);
    expect(env.WAABEK_API_URL).toBe('https://waabek.com/api/v1/send');
    expect(env.NODE_ENV).toBe('development');
  });

  it('needs nothing about hosts, origins, proxies, an edge or Redis (D-36: one Netlify site)', () => {
    const env = loadEnv(apiEnvSchema, { ...validApiEnv, NODE_ENV: 'production' }) as Record<string, unknown>;
    for (const removed of [
      'API_ORIGIN',
      'EDGE_SECRET',
      'REDIS_URL',
      'QUEUE_PREFIX',
      'CORS_ALLOWED_ORIGINS',
      'ADMIN_ORIGINS',
      'WEB_ORIGINS',
      'API_PUBLIC_PATH',
      'API_TRUST_PROXY_HOPS',
      'API_HOST',
      'API_PORT',
    ]) {
      expect(removed in env, removed).toBe(false);
      expect(Object.keys(apiEnvSchema.shape), removed).not.toContain(removed);
    }
  });

  it('accepts the Supabase transaction pooler (recommended for server functions) and the session pooler', () => {
    for (const port of ['6543', '5432']) {
      expect(() =>
        loadEnv(apiEnvSchema, { ...validApiEnv, DATABASE_URL: `postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:${port}/postgres` }),
      ).not.toThrow();
    }
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, DATABASE_POOL_MAX: '50' })).toThrow(/DATABASE_POOL_MAX/);
  });

  it('rejects short secrets and a malformed TOTP key', () => {
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, ACCESS_TOKEN_SECRET: 'short' })).toThrow(/ACCESS_TOKEN_SECRET/);
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, ADMIN_TOTP_KEY: Buffer.from('too short').toString('base64') })).toThrow(/ADMIN_TOTP_KEY/);
  });

  it('requires SETTINGS_ENCRYPTION_KEY: 32 bytes, base64, different from ADMIN_TOTP_KEY (D-32)', () => {
    const { SETTINGS_ENCRYPTION_KEY: _omit, ...withoutKey } = validApiEnv;
    for (const NODE_ENV of ['production', 'development', 'test']) {
      expect(() => loadEnv(apiEnvSchema, { ...withoutKey, NODE_ENV })).toThrow(/SETTINGS_ENCRYPTION_KEY: is required/);
    }
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, SETTINGS_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') })).toThrow(
      /SETTINGS_ENCRYPTION_KEY: must be 32 random bytes/,
    );
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, SETTINGS_ENCRYPTION_KEY: 'not base64 at all!' })).toThrow(/SETTINGS_ENCRYPTION_KEY/);
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, SETTINGS_ENCRYPTION_KEY: validApiEnv.ADMIN_TOTP_KEY })).toThrow(
      /SETTINGS_ENCRYPTION_KEY: must be a different key from ADMIN_TOTP_KEY/,
    );
    // The same key bytes without padding, or in base64url, are the same key.
    const samePadless = validApiEnv.ADMIN_TOTP_KEY.replace(/=+$/, '');
    const sameUrlSafe = Buffer.from(validApiEnv.ADMIN_TOTP_KEY, 'base64').toString('base64url');
    for (const SETTINGS_ENCRYPTION_KEY of [samePadless, sameUrlSafe]) {
      expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, SETTINGS_ENCRYPTION_KEY })).toThrow(/must be a different key from ADMIN_TOTP_KEY/);
    }
    // The value is never echoed in the error.
    const tooShort = Buffer.from('short-key-value-1234').toString('base64');
    try {
      loadEnv(apiEnvSchema, { ...validApiEnv, SETTINGS_ENCRYPTION_KEY: tooShort });
    } catch (error) {
      expect(String(error)).not.toContain(tooShort);
    }
  });

  it('requires the Supabase URL and service key together, and the public key only with them (D-36 realtime)', () => {
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, SUPABASE_URL: 'https://ref.supabase.co' })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, SUPABASE_ANON_KEY: 'anon' })).toThrow(/SUPABASE_URL/);
    expect(() =>
      loadEnv(apiEnvSchema, { ...validApiEnv, SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'same-key', SUPABASE_ANON_KEY: 'same-key' }),
    ).toThrow(/SUPABASE_ANON_KEY: must be the public anon key/);
    const env = loadEnv(apiEnvSchema, { ...validApiEnv, SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_ANON_KEY: 'anon', SUPABASE_JWT_SECRET: JWT_SECRET });
    expect(env.SUPABASE_ANON_KEY).toBe('anon');
    // Swapped keys are caught from the keys themselves (legacy JWT role claim, or the newer key prefixes).
    const jwt = (role: string) => signedKey(role, JWT_SECRET);
    const swapped = { ...validApiEnv, SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: jwt('anon'), SUPABASE_ANON_KEY: jwt('service_role'), SUPABASE_JWT_SECRET: JWT_SECRET };
    expect(() => loadEnv(apiEnvSchema, swapped)).toThrow(/SUPABASE_ANON_KEY: must be the public anon key[\s\S]*SUPABASE_SERVICE_ROLE_KEY: must be the service role key/);
    expect(() =>
      loadEnv(apiEnvSchema, { ...validApiEnv, SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_x', SUPABASE_ANON_KEY: 'sb_secret_y', SUPABASE_JWT_SECRET: JWT_SECRET }),
    ).toThrow(/SUPABASE_ANON_KEY/);
    const right = loadEnv(apiEnvSchema, { ...validApiEnv, SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: jwt('service_role'), SUPABASE_ANON_KEY: jwt('anon'), SUPABASE_JWT_SECRET: JWT_SECRET });
    expect(right.SUPABASE_ANON_KEY).toBe(jwt('anon'));
  });

  it('requires the project JWT secret with the public key, and checks it against the key (private realtime channels)', () => {
    const base = { ...validApiEnv, SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: signedKey('service_role', JWT_SECRET) };
    expect(() => loadEnv(apiEnvSchema, { ...base, SUPABASE_ANON_KEY: signedKey('anon', JWT_SECRET) })).toThrow(
      /SUPABASE_JWT_SECRET: SUPABASE_ANON_KEY and SUPABASE_JWT_SECRET must be set together/,
    );
    expect(() => loadEnv(apiEnvSchema, { ...base, SUPABASE_JWT_SECRET: JWT_SECRET })).toThrow(/SUPABASE_ANON_KEY: SUPABASE_ANON_KEY and SUPABASE_JWT_SECRET/);
    expect(() => loadEnv(apiEnvSchema, { ...base, SUPABASE_ANON_KEY: signedKey('anon', JWT_SECRET), SUPABASE_JWT_SECRET: 'short' })).toThrow(
      /SUPABASE_JWT_SECRET: must be the project's JWT secret/,
    );
    // A secret from another project (or mistyped): the anon key is not signed with it.
    const other = 'another-projects-jwt-secret-value-0123456789';
    let message = '';
    try {
      loadEnv(apiEnvSchema, { ...base, SUPABASE_ANON_KEY: signedKey('anon', JWT_SECRET), SUPABASE_JWT_SECRET: other });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/SUPABASE_JWT_SECRET: is not this project's JWT secret/);
    expect(message).not.toContain(other);
    // Newer publishable keys are not JWTs: nothing to check against, accepted.
    expect(loadEnv(apiEnvSchema, { ...base, SUPABASE_ANON_KEY: 'sb_publishable_abc', SUPABASE_JWT_SECRET: other }).SUPABASE_JWT_SECRET).toBe(other);
    expect(supabaseKeySignedWith(signedKey('anon', JWT_SECRET), JWT_SECRET)).toBe(true);
    expect(supabaseKeySignedWith(signedKey('anon', JWT_SECRET), other)).toBe(false);
    expect(supabaseKeySignedWith('sb_publishable_abc', JWT_SECRET)).toBeNull();
  });

  it('names any value still holding the template placeholder', () => {
    expect(() =>
      loadEnv(apiEnvSchema, { ...validApiEnv, DATABASE_URL: 'postgresql://bedo_api.ref:PASTE_DB_PASSWORD@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres' }),
    ).toThrow(/DATABASE_URL: still holds the template placeholder/);
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, ACCESS_TOKEN_SECRET: 'PASTE_ACCESS_TOKEN_SECRET_HERE_0123456789' })).toThrow(
      /ACCESS_TOKEN_SECRET: still holds the template placeholder/,
    );
  });

  it('refuses WAABEK_API_KEY in the environment: the key is set from the Admin Dashboard (D-32)', () => {
    const value = 'fake-env-key-should-be-refused';
    let message = '';
    try {
      loadEnv(apiEnvSchema, { ...validApiEnv, WAABEK_API_KEY: value });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/WAABEK_API_KEY: is no longer used \(D-32\)/);
    expect(message).not.toContain(value);
    // An empty variable is treated as absent.
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, WAABEK_API_KEY: '' })).not.toThrow();
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, WAABEK_API_URL: 'http://waabek.example/send' })).toThrow(/WAABEK_API_URL/);
  });

  it('requires the three VAPID settings together', () => {
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, VAPID_PUBLIC_KEY: 'x' })).toThrow(/VAPID/);
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'y', VAPID_SUBJECT: 'mailto:a@b.c' })).not.toThrow();
  });

  it('reports missing variables by name', () => {
    try {
      loadEnv(apiEnvSchema, {});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const variables = (error as EnvValidationError).issues.map((issue) => issue.variable);
      expect(variables).toEqual(expect.arrayContaining(['DATABASE_URL', 'ACCESS_TOKEN_SECRET', 'SETTINGS_ENCRYPTION_KEY']));
    }
  });

  it('never echoes a supplied value in the error message', () => {
    const secret = 'mysql://root:super-secret-value@db';
    try {
      loadEnv(apiEnvSchema, { ...validApiEnv, DATABASE_URL: secret });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).not.toContain('super-secret-value');
    }
  });
});

describe('server variable classification', () => {
  it('includes the Waabek API key and the settings encryption key as server-only', () => {
    // WAABEK_API_KEY stays listed so the client-bundle guard keeps looking for its name and any value.
    expect(SERVER_ONLY_ENV_NAMES).toContain('WAABEK_API_KEY');
    expect(SERVER_ONLY_ENV_NAMES).toContain('SETTINGS_ENCRYPTION_KEY');
  });

  it('classifies every server variable as secret or non-secret, never both', () => {
    const secret = new Set<string>(SERVER_ONLY_ENV_NAMES);
    const nonSecret = new Set<string>(NON_SECRET_SERVER_ENV_NAMES);
    const allKeys = new Set([
      ...Object.keys(apiEnvSchema.shape),
      ...Object.keys(migrationEnvSchema.shape),
      ...Object.keys(adminCliEnvSchema.shape),
    ]);
    for (const key of allKeys) {
      expect(secret.has(key) || nonSecret.has(key), `${key} is not classified`).toBe(true);
      expect(secret.has(key) && nonSecret.has(key), `${key} is classified twice`).toBe(false);
    }
  });
});
