import { describe, expect, it } from 'vitest';
import {
  adminCliEnvSchema,
  apiEnvSchema,
  EnvValidationError,
  loadEnv,
  migrationEnvSchema,
  NON_SECRET_SERVER_ENV_NAMES,
  SERVER_ONLY_ENV_NAMES,
  workerEnvSchema,
} from './index.js';

const validApiEnv = {
  DATABASE_URL: 'postgresql://user:secret-password@localhost:5432/bedo',
  REDIS_URL: 'redis://localhost:6379',
  ACCESS_TOKEN_SECRET: 'a'.repeat(40),
  OTP_HMAC_SECRET: 'b'.repeat(40),
  ADMIN_TOTP_KEY: Buffer.alloc(32, 7).toString('base64'),
  SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
};

const validWorkerEnv = {
  REDIS_URL: 'rediss://cache.example.com:6380',
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/bedo',
  SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
};

describe('apiEnvSchema', () => {
  it('applies defaults to a minimal valid environment', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv);
    expect(env.API_PORT).toBe(4000);
    expect(env.API_HOST).toBe('0.0.0.0');
    expect(env.API_TRUST_PROXY_HOPS).toBe(0);
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBe(15_000);
    expect(env.QUEUE_PREFIX).toBe('bedo');
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
    expect(env.NODE_ENV).toBe('development');
  });

  it('parses a comma-separated list of allowed origins', () => {
    const env = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      CORS_ALLOWED_ORIGINS: 'https://chat.example.com, https://admin.example.com',
    });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://chat.example.com', 'https://admin.example.com']);
  });

  it('rejects an origin that is not an http(s) URL', () => {
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, CORS_ALLOWED_ORIGINS: 'javascript:alert(1)' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects the Supabase transaction pooler port', () => {
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        DATABASE_URL: 'postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
      }),
    ).toThrow(/6543/);
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        DATABASE_URL: 'postgresql://postgres.ref:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres',
      }),
    ).not.toThrow();
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

  it('accepts one shared origin for both apps with explicit web origins and an /api prefix (D-25)', () => {
    const shared = { CORS_ALLOWED_ORIGINS: 'https://bedochat.com', ADMIN_ORIGINS: 'https://bedochat.com', API_PUBLIC_PATH: '/api' };
    const edge = { EDGE_SECRET: 'e'.repeat(40) };
    const env = loadEnv(apiEnvSchema, { ...validApiEnv, ...shared, ...edge, WEB_ORIGINS: 'https://bedochat.com', NODE_ENV: 'production' });
    // Behind the edge in production the edge secret is required, and must be long.
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, ...shared, WEB_ORIGINS: 'https://bedochat.com', NODE_ENV: 'production' })).toThrow(/EDGE_SECRET/);
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, EDGE_SECRET: 'short' })).toThrow(/EDGE_SECRET/);
    expect(env.WEB_ORIGINS).toEqual(['https://bedochat.com']);
    expect(env.API_PUBLIC_PATH).toBe('/api');
    // Without WEB_ORIGINS the student app would have no allowed origin at all.
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, ...shared, ...edge, NODE_ENV: 'production' })).toThrow(/WEB_ORIGINS/);
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, ...shared, WEB_ORIGINS: 'https://other.example' })).toThrow(/WEB_ORIGINS/);
    for (const path of ['api', '/api/', '/API', '/a b']) {
      expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, API_PUBLIC_PATH: path }), path).toThrow(/API_PUBLIC_PATH/);
    }
    expect(loadEnv(apiEnvSchema, validApiEnv).API_PUBLIC_PATH).toBe('');
  });

  it('requires every admin origin to be an allowed origin', () => {
    const origins = { CORS_ALLOWED_ORIGINS: 'https://chat.example.com,https://admin.example.com' };
    expect(loadEnv(apiEnvSchema, { ...validApiEnv, ...origins, ADMIN_ORIGINS: 'https://admin.example.com' }).ADMIN_ORIGINS).toEqual([
      'https://admin.example.com',
    ]);
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, ...origins, ADMIN_ORIGINS: 'https://other.example.com' })).toThrow(/ADMIN_ORIGINS/);
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, ...origins, NODE_ENV: 'production' })).toThrow(/ADMIN_ORIGINS/);
  });

  it('requires the Supabase URL and service key together', () => {
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, SUPABASE_URL: 'https://ref.supabase.co' })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  });

  it('reports missing variables by name', () => {
    try {
      loadEnv(apiEnvSchema, {});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const variables = (error as EnvValidationError).issues.map((issue) => issue.variable);
      expect(variables).toEqual(expect.arrayContaining(['DATABASE_URL', 'REDIS_URL']));
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

describe('workerEnvSchema', () => {
  it('requires REDIS_URL and applies worker defaults', () => {
    const env = loadEnv(workerEnvSchema, validWorkerEnv);
    expect(env.WORKER_CONCURRENCY).toBe(4);
    expect(env.WORKER_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(env.OTP_DELIVERY).toBe('waabek');
    expect(env.WAABEK_API_URL).toBe('https://waabek.com/api/v1/send');
  });

  it('requires SETTINGS_ENCRYPTION_KEY, which decrypts the Dashboard-managed Waabek key (D-32)', () => {
    const { SETTINGS_ENCRYPTION_KEY: _omit, ...withoutKey } = validWorkerEnv;
    for (const OTP_DELIVERY of ['waabek', 'test-capture']) {
      expect(() => loadEnv(workerEnvSchema, { ...withoutKey, OTP_DELIVERY, NODE_ENV: 'test' })).toThrow(/SETTINGS_ENCRYPTION_KEY: is required/);
    }
    expect(() => loadEnv(workerEnvSchema, { ...validWorkerEnv, SETTINGS_ENCRYPTION_KEY: Buffer.from('too-short').toString('base64') })).toThrow(
      /SETTINGS_ENCRYPTION_KEY/,
    );
  });

  it('refuses WAABEK_API_KEY in the environment: the key is set from the Admin Dashboard (D-32)', () => {
    const value = 'fake-env-key-should-be-refused';
    let message = '';
    try {
      loadEnv(workerEnvSchema, { ...validWorkerEnv, WAABEK_API_KEY: value });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/WAABEK_API_KEY: is no longer used \(D-32\)/);
    expect(message).not.toContain(value);
    // An empty variable is treated as absent.
    expect(() => loadEnv(workerEnvSchema, { ...validWorkerEnv, WAABEK_API_KEY: '' })).not.toThrow();
  });

  it('refuses the test code sender outside NODE_ENV=test', () => {
    for (const NODE_ENV of ['production', 'development']) {
      expect(() => loadEnv(workerEnvSchema, { ...validWorkerEnv, OTP_DELIVERY: 'test-capture', NODE_ENV })).toThrow(
        /OTP_DELIVERY/,
      );
    }
    expect(() => loadEnv(workerEnvSchema, { ...validWorkerEnv, OTP_DELIVERY: 'test-capture', NODE_ENV: 'test' })).not.toThrow();
  });

  it('requires the three VAPID settings together', () => {
    expect(() => loadEnv(workerEnvSchema, { ...validWorkerEnv, VAPID_PUBLIC_KEY: 'x' })).toThrow(/VAPID/);
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
      ...Object.keys(workerEnvSchema.shape),
      ...Object.keys(migrationEnvSchema.shape),
      ...Object.keys(adminCliEnvSchema.shape),
    ]);
    for (const key of allKeys) {
      expect(secret.has(key) || nonSecret.has(key), `${key} is not classified`).toBe(true);
      expect(secret.has(key) && nonSecret.has(key), `${key} is classified twice`).toBe(false);
    }
  });

  it('rejects an invalid queue prefix', () => {
    expect(() => loadEnv(workerEnvSchema, { ...validWorkerEnv, QUEUE_PREFIX: 'Bad Prefix' })).toThrow(
      EnvValidationError,
    );
  });
});
