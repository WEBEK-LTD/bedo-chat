import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Environment variables that must only ever exist on servers (secrets and connection strings).
 * The client-bundle guard (scripts/check-client-bundles.mjs) fails the build if any of these
 * names, or their configured values, appear in the web or admin client output (spec §1, D-05).
 */
export const SERVER_ONLY_ENV_NAMES = [
  'DATABASE_URL',
  'WAABEK_API_KEY',
  'ACCESS_TOKEN_SECRET',
  'OTP_HMAC_SECRET',
  'ADMIN_TOTP_KEY',
  'SETTINGS_ENCRYPTION_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'VAPID_PRIVATE_KEY',
] as const;

/**
 * Server variables that are not secret (limits, log levels, public keys and URLs). Every variable in a server
 * schema must appear in exactly one of the two lists; a test enforces this, so a new secret can
 * never be added without the bundle guard learning about it.
 */
export const NON_SECRET_SERVER_ENV_NAMES = [
  'NODE_ENV',
  'LOG_LEVEL',
  'DATABASE_POOL_MAX',
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'HEALTH_CHECK_TIMEOUT_MS',
  'SUPABASE_URL',
  // The project's public (anon) key: browsers receive it to listen for realtime signals (D-36).
  'SUPABASE_ANON_KEY',
  'VAPID_PUBLIC_KEY',
  'VAPID_SUBJECT',
  'WAABEK_API_URL',
] as const;

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info');

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// or postgresql:// URL');

/**
 * The API's connection (D-36). On the website's server functions, Supabase's transaction pooler (port 6543)
 * is the recommended one: many short-lived instances share a few database connections. The session pooler
 * (port 5432) and the direct connection work too. The API keeps no session state on a connection (only
 * transaction-scoped locks; with the transaction pooler the statement timeout is enforced client-side).
 */
const runtimePostgresUrl = postgresUrl;

/** A random server secret: at least 32 characters (generate with `openssl rand -base64 48`). */
const serverSecret = z.string().min(32, 'must be at least 32 characters (generate with: openssl rand -base64 48)');

/** 32 random bytes, base64-encoded (generate with `openssl rand -base64 32`). */
const aes256Key = z.string().refine((value) => {
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'must be 32 random bytes, base64-encoded (generate with: openssl rand -base64 32)');

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined));

/**
 * The API, which runs inside the website's server functions on the one Netlify site (D-36): there is no
 * separate API host, port, proxy, edge secret or origin list. It answers at https://bedochat.com/api.
 */
/**
 * What a Supabase API key grants, from the key itself: a legacy JWT key's `role` claim (`anon` or
 * `service_role`), or a newer key's prefix (`sb_publishable_` or `sb_secret_`). `unknown` when it cannot tell.
 */
export function supabaseKeyKind(key: string): 'public' | 'secret' | 'unknown' {
  if (key.startsWith('sb_publishable_')) return 'public';
  if (key.startsWith('sb_secret_')) return 'secret';
  const parts = key.split('.');
  if (parts.length !== 3) return 'unknown';
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { role?: unknown };
    if (claims.role === 'anon') return 'public';
    if (claims.role === 'service_role') return 'secret';
  } catch {
    // not a JWT
  }
  return 'unknown';
}

/**
 * Whether a legacy Supabase key (an HS256 JWT such as the anon key) is signed with this JWT secret. `null` when the
 * key is not such a JWT (newer `sb_publishable_` keys), so nothing can be checked.
 */
export function supabaseKeySignedWith(key: string, jwtSecret: string): boolean | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: unknown };
    if (header.alg !== 'HS256') return null;
  } catch {
    return null;
  }
  const expected = createHmac('sha256', jwtSecret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2]!, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const apiEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    LOG_LEVEL: logLevel,
    DATABASE_URL: runtimePostgresUrl,
    /**
     * Connections per server-function instance. Each instance serves one request at a time, so a small pool is
     * enough; many instances can run at once, so keep it small to stay within the database's connection limit.
     */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
    /** Server-side limit for any single statement; protects the pool from runaway or hung queries. */
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
    /** Upper bound for the database check in /health/ready. */
    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
    /** Signs access tokens (P-01); also derives each device's private realtime channel name (D-36). */
    ACCESS_TOKEN_SECRET: serverSecret,
    /** Keys the hash under which one-time codes are stored. */
    OTP_HMAC_SECRET: serverSecret,
    /** Encrypts admin authenticator-app secrets at rest (D-19). */
    ADMIN_TOTP_KEY: aes256Key,
    /**
     * Encrypts Admin Dashboard-managed secrets at rest, the Waabek API key (D-32). Infrastructure only:
     * never stored in the database, never sent to a browser, never set from the Admin Dashboard. Must
     * differ from ADMIN_TOTP_KEY. Required: the API does not start without a valid key.
     */
    SETTINGS_ENCRYPTION_KEY: aes256Key,
    /** Waabek's send endpoint (D-05, D-22). */
    WAABEK_API_URL: z.url({ protocol: /^https$/ }).default('https://waabek.com/api/v1/send'),
    /**
     * No longer used (D-32): the key is set from the Admin Dashboard. Refused when present, so no copy of
     * the key stays in the server environment.
     */
    WAABEK_API_KEY: optionalString,
    /**
     * Supabase project URL and service key: private profile pictures (P-15) and sending realtime signals
     * (D-36). Both or neither.
     */
    SUPABASE_URL: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
    SUPABASE_SERVICE_ROLE_KEY: optionalString,
    /**
     * The project's public (anon) key, handed to signed-in browsers so they can listen on their private
     * realtime channel (D-36). Without it devices still get every change, by checking every 20 seconds.
     */
    SUPABASE_ANON_KEY: optionalString,
    /**
     * The project's JWT secret (Supabase: Project Settings -> JWT Keys -> Legacy JWT Secret). The API signs each
     * device's short-lived realtime token with it, which lets that device receive on its own private channel and
     * nowhere else (D-36: Realtime Authorization). Required with SUPABASE_ANON_KEY; never sent to a browser.
     */
    SUPABASE_JWT_SECRET: optionalString.pipe(z.string().min(32, 'must be the project\'s JWT secret (at least 32 characters)').optional()),
    /** Web Push key pair and contact (D-21). All three or none: push is off without them. */
    VAPID_PUBLIC_KEY: optionalString,
    VAPID_PRIVATE_KEY: optionalString,
    VAPID_SUBJECT: optionalString,
  })
  .superRefine((env, ctx) => {
    // Compared as key bytes, so the same key written another way (padding, base64url) is caught too.
    if (Buffer.from(env.SETTINGS_ENCRYPTION_KEY, 'base64').equals(Buffer.from(env.ADMIN_TOTP_KEY, 'base64'))) {
      ctx.addIssue({ code: 'custom', path: ['SETTINGS_ENCRYPTION_KEY'], message: 'must be a different key from ADMIN_TOTP_KEY' });
    }
    if (Boolean(env.SUPABASE_URL) !== Boolean(env.SUPABASE_SERVICE_ROLE_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.SUPABASE_URL ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_URL'],
        message: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set together',
      });
    }
    if (env.SUPABASE_ANON_KEY && !env.SUPABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_URL'], message: 'is required when SUPABASE_ANON_KEY is set' });
    }
    // The anon key is handed to every signed-in browser (D-36): a service key there would give browsers full
    // access to the project. Checked from the key's own claims (legacy JWT keys) or prefix (newer keys).
    if (env.SUPABASE_ANON_KEY && (env.SUPABASE_ANON_KEY === env.SUPABASE_SERVICE_ROLE_KEY || supabaseKeyKind(env.SUPABASE_ANON_KEY) === 'secret')) {
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_ANON_KEY'], message: 'must be the public anon key, not the service role key' });
    }
    if (env.SUPABASE_SERVICE_ROLE_KEY && supabaseKeyKind(env.SUPABASE_SERVICE_ROLE_KEY) === 'public') {
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_SERVICE_ROLE_KEY'], message: 'must be the service role key, not the public anon key' });
    }
    // A value still holding the template's placeholder (docs/netlify-production.env): named, never echoed.
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === 'string' && value.includes('PASTE_')) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'still holds the template placeholder (PASTE_...): replace it with the real value' });
      }
    }
    // Realtime channels are private (D-36): a device listens only with a token the API signs with the JWT secret.
    if (Boolean(env.SUPABASE_ANON_KEY) !== Boolean(env.SUPABASE_JWT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.SUPABASE_ANON_KEY ? 'SUPABASE_JWT_SECRET' : 'SUPABASE_ANON_KEY'],
        message: 'SUPABASE_ANON_KEY and SUPABASE_JWT_SECRET must be set together (private realtime channels)',
      });
    }
    if (env.SUPABASE_JWT_SECRET && env.SUPABASE_JWT_SECRET === env.SUPABASE_SERVICE_ROLE_KEY) {
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_JWT_SECRET'], message: 'must be the JWT secret, not the service role key' });
    }
    // The legacy anon key is itself signed with the project's JWT secret: a mismatch means a secret from another
    // project, or a mistyped one, with which every device would be refused.
    if (env.SUPABASE_ANON_KEY && env.SUPABASE_JWT_SECRET && supabaseKeySignedWith(env.SUPABASE_ANON_KEY, env.SUPABASE_JWT_SECRET) === false) {
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_JWT_SECRET'], message: "is not this project's JWT secret (the anon key is not signed with it)" });
    }
    if (env.WAABEK_API_KEY !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['WAABEK_API_KEY'],
        message: 'is no longer used (D-32): remove it from the environment and set the Waabek API key from the Admin Dashboard',
      });
    }
    const vapid = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].filter(Boolean).length;
    if (vapid !== 0 && vapid !== 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAPID_PRIVATE_KEY'],
        message: 'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set together',
      });
    }
  });
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const migrationEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
});

/** Command-line admin tools (create admin accounts). Run with the table-owner connection. */
export const adminCliEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
  ADMIN_TOTP_KEY: aes256Key,
});
export type AdminCliEnv = z.infer<typeof adminCliEnvSchema>;
export type MigrationEnv = z.infer<typeof migrationEnvSchema>;

export class EnvValidationError extends Error {
  readonly issues: ReadonlyArray<{ variable: string; problem: string }>;

  constructor(issues: ReadonlyArray<{ variable: string; problem: string }>) {
    super(
      `Invalid environment configuration:\n${issues
        .map((issue) => `  - ${issue.variable}: ${issue.problem}`)
        .join('\n')}`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Parses environment variables against a schema.
 * Error messages name the variable and the problem but never echo the supplied value,
 * so secrets cannot leak into logs through a failed start-up.
 */
export function loadEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source: Record<string, string | undefined> = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => ({
    variable: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
    problem: issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : issue.message,
  }));
  throw new EnvValidationError(issues);
}
