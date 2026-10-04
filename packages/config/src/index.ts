import { z } from 'zod';

/**
 * Environment variables that must only ever exist on servers (secrets and connection strings).
 * The client-bundle guard (scripts/check-client-bundles.mjs) fails the build if any of these
 * names, or their configured values, appear in the web or admin client output (spec §1, D-05).
 */
export const SERVER_ONLY_ENV_NAMES = [
  'DATABASE_URL',
  'REDIS_URL',
  'WAABEK_API_KEY',
  'ACCESS_TOKEN_SECRET',
  'OTP_HMAC_SECRET',
  'ADMIN_TOTP_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'VAPID_PRIVATE_KEY',
  'EDGE_SECRET',
] as const;

/**
 * Server variables that are not secret (ports, limits, log levels). Every variable in a server
 * schema must appear in exactly one of the two lists; a test enforces this, so a new secret can
 * never be added without the bundle guard learning about it.
 */
export const NON_SECRET_SERVER_ENV_NAMES = [
  'NODE_ENV',
  'LOG_LEVEL',
  'API_HOST',
  'API_PORT',
  'API_TRUST_PROXY_HOPS',
  'CORS_ALLOWED_ORIGINS',
  'ADMIN_ORIGINS',
  'WEB_ORIGINS',
  'API_PUBLIC_PATH',
  'DATABASE_POOL_MAX',
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'HEALTH_CHECK_TIMEOUT_MS',
  'QUEUE_PREFIX',
  'WORKER_CONCURRENCY',
  'WORKER_HEARTBEAT_INTERVAL_MS',
  'SUPABASE_URL',
  'VAPID_PUBLIC_KEY',
  'VAPID_SUBJECT',
  'OTP_DELIVERY',
  'WAABEK_API_URL',
] as const;

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info');

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// or postgresql:// URL');

/**
 * Long-running services keep session state on each connection (statement timeout), which Supabase's
 * transaction-mode pooler on port 6543 does not preserve. Use the direct connection or the
 * session-mode pooler (port 5432).
 */
const runtimePostgresUrl = postgresUrl.refine((value) => {
  try {
    return new URL(value).port !== '6543';
  } catch {
    return false;
  }
}, 'must not use the transaction pooler (port 6543); use the direct connection or the session pooler (port 5432)');

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

const redisUrl = z
  .string()
  .min(1)
  .refine((value) => /^rediss?:\/\//.test(value), 'must be a redis:// or rediss:// URL');

const port = z.coerce.number().int().min(1).max(65535);

const commaSeparatedOrigins = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })));

/** BullMQ key prefix; lets several environments share one Redis without touching each other's queues. */
const queuePrefix = z
  .string()
  .regex(/^[a-z0-9][a-z0-9:_-]{0,39}$/, 'must be 1-40 lowercase letters, digits, ":", "_" or "-"')
  .default('bedo');

export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: port.default(4000),
  /**
   * Number of reverse proxies / load balancers in front of the API that append to X-Forwarded-For.
   * 0 (default) trusts no proxy: the client IP is the socket address and X-Request-Id from the
   * client is ignored. Never set it higher than the real number of hops.
   */
  API_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /** Exact origins of the user web app and admin app allowed to call the API from a browser. */
  CORS_ALLOWED_ORIGINS: commaSeparatedOrigins,
  /**
   * The Admin Dashboard's origins (also listed in CORS_ALLOWED_ORIGINS). Admin routes accept only these,
   * and the user's session cookie routes accept every other allowed origin, so the two apps cannot act
   * for each other.
   */
  ADMIN_ORIGINS: commaSeparatedOrigins,
  /**
   * The user web app's origins (also listed in CORS_ALLOWED_ORIGINS); the user's session cookie routes
   * accept only these. Optional: when empty it is every allowed origin that is not an admin origin. Set it
   * when both apps share one origin (D-25: everything on https://bedochat.com).
   */
  WEB_ORIGINS: commaSeparatedOrigins,
  /**
   * Shared secret the edge router (Cloudflare Worker) sends with every request (D-25). When set, the API
   * refuses requests without it, so nobody can reach the API host around the edge. Required in production
   * when API_PUBLIC_PATH is set.
   */
  EDGE_SECRET: optionalString.pipe(z.string().min(32, 'must be at least 32 characters').optional()),
  /**
   * Public path prefix in front of the API (D-25: "/api"; the edge removes it before forwarding). Session
   * cookies are scoped under it so the browser sends them only to the API. Empty when the API has its own
   * host name.
   */
  API_PUBLIC_PATH: z
    .string()
    .trim()
    .regex(/^(\/[a-z0-9-]+)*$/, 'must be empty or a path like /api')
    .default(''),
  DATABASE_URL: runtimePostgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /** Server-side limit for any single statement; protects the pool from runaway or hung queries. */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
  REDIS_URL: redisUrl,
  QUEUE_PREFIX: queuePrefix,
  /** Upper bound for each dependency check in /health/ready. */
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
  /** Signs access tokens (P-01). */
  ACCESS_TOKEN_SECRET: serverSecret,
  /** Keys the hash under which one-time codes are stored. */
  OTP_HMAC_SECRET: serverSecret,
  /** Encrypts admin authenticator-app secrets at rest (D-19). */
  ADMIN_TOTP_KEY: aes256Key,
  /** Supabase project URL and service key for private profile pictures (P-15). Both or neither. */
  SUPABASE_URL: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  /** Public half of the Web Push key pair, handed to browsers (D-21). Optional: push is off without it. */
  VAPID_PUBLIC_KEY: optionalString,
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.ADMIN_ORIGINS.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['ADMIN_ORIGINS'], message: "is required in production (the Admin Dashboard's origin)" });
  }
  for (const origin of env.ADMIN_ORIGINS) {
    if (!env.CORS_ALLOWED_ORIGINS.includes(origin)) {
      ctx.addIssue({ code: 'custom', path: ['ADMIN_ORIGINS'], message: 'every admin origin must also be in CORS_ALLOWED_ORIGINS' });
    }
  }
  for (const origin of env.WEB_ORIGINS) {
    if (!env.CORS_ALLOWED_ORIGINS.includes(origin)) {
      ctx.addIssue({ code: 'custom', path: ['WEB_ORIGINS'], message: 'every web origin must also be in CORS_ALLOWED_ORIGINS' });
    }
  }
  if (env.NODE_ENV === 'production' && env.API_PUBLIC_PATH && !env.EDGE_SECRET) {
    ctx.addIssue({ code: 'custom', path: ['EDGE_SECRET'], message: 'is required in production when the API is served behind the edge (API_PUBLIC_PATH)' });
  }
  const webOrigins = env.WEB_ORIGINS.length > 0 ? env.WEB_ORIGINS : env.CORS_ALLOWED_ORIGINS.filter((origin) => !env.ADMIN_ORIGINS.includes(origin));
  if (env.NODE_ENV === 'production' && webOrigins.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['WEB_ORIGINS'],
      message: "is required in production when the web app shares the Admin Dashboard's origin",
    });
  }
  if (Boolean(env.SUPABASE_URL) !== Boolean(env.SUPABASE_SERVICE_ROLE_KEY)) {
    ctx.addIssue({
      code: 'custom',
      path: [env.SUPABASE_URL ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_URL'],
      message: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set together',
    });
  }
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = z
  .object({
    NODE_ENV: nodeEnv,
    LOG_LEVEL: logLevel,
    REDIS_URL: redisUrl,
    QUEUE_PREFIX: queuePrefix,
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
    DATABASE_URL: runtimePostgresUrl,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
    /**
     * How one-time codes are delivered. "waabek" (default) sends real WhatsApp messages (D-05, D-22).
     * "test-capture" stores codes in Redis for automated tests only; it is refused unless NODE_ENV=test.
     */
    OTP_DELIVERY: z.enum(['waabek', 'test-capture']).default('waabek'),
    WAABEK_API_URL: z.url({ protocol: /^https$/ }).default('https://waabek.com/api/v1/send'),
    WAABEK_API_KEY: optionalString,
    VAPID_PUBLIC_KEY: optionalString,
    VAPID_PRIVATE_KEY: optionalString,
    VAPID_SUBJECT: optionalString,
  })
  .superRefine((env, ctx) => {
    if (env.OTP_DELIVERY === 'test-capture' && env.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_DELIVERY'],
        message: 'test-capture is only allowed when NODE_ENV=test; use waabek',
      });
    }
    if (env.OTP_DELIVERY === 'waabek' && !env.WAABEK_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['WAABEK_API_KEY'], message: 'is required when OTP_DELIVERY=waabek' });
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
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

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
