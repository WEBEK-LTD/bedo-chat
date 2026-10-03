import { z } from 'zod';

/**
 * Environment variables that must only ever exist on servers (secrets and connection strings).
 * The client-bundle guard (scripts/check-client-bundles.mjs) fails the build if any of these
 * names, or their configured values, appear in the web or admin client output (spec §1, D-05).
 */
export const SERVER_ONLY_ENV_NAMES = ['DATABASE_URL', 'REDIS_URL', 'WAABEK_API_KEY'] as const;

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
  'DATABASE_POOL_MAX',
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'HEALTH_CHECK_TIMEOUT_MS',
  'QUEUE_PREFIX',
  'WORKER_CONCURRENCY',
  'WORKER_HEARTBEAT_INTERVAL_MS',
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
  DATABASE_URL: runtimePostgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /** Server-side limit for any single statement; protects the pool from runaway or hung queries. */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
  REDIS_URL: redisUrl,
  QUEUE_PREFIX: queuePrefix,
  /** Upper bound for each dependency check in /health/ready. */
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  REDIS_URL: redisUrl,
  QUEUE_PREFIX: queuePrefix,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const migrationEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
});
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
