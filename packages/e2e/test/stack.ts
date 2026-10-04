import { type ChildProcess, spawn } from 'node:child_process';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type OtpJobData, QUEUE_NAMES } from '@bedo/contracts';
import { defaultMigrationsDir, runMigrations } from '@bedo/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';

/**
 * A complete local stack for browser tests: a fresh migrated database, the built API (connecting as the
 * least-privilege runtime role), and the built web and admin apps served by `next start`.
 *
 * The apps must be built with NEXT_PUBLIC_API_URL pointing at API_URL (`pnpm e2e` does this). Codes are
 * read from the OTP job queue, exactly what the worker would send through Waabek; no WhatsApp is sent.
 */
export const API_PORT = 4100;
export const WEB_PORT = 3100;
export const ADMIN_PORT = 3101;
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const ADMIN_URL = `http://localhost:${ADMIN_PORT}`;

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    await client.end();
  }
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not start`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function start(command: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (process.env.E2E_DEBUG) process.stderr.write(chunk);
  });
  return child;
}

export interface Stack {
  ownerUrl: string;
  totpKey: Buffer;
  latestCode(phone: string): Promise<string | null>;
  codeCount(phone: string): Promise<number>;
  /** Clears the 60-second resend cooldown so a second device can sign in straight away. */
  clearCooldown(phone: string, scope?: 'otp' | 'otp-admin'): Promise<void>;
  stop(): Promise<void>;
}

export async function startStack(): Promise<Stack> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!adminUrl || !redisUrl) {
    throw new Error('TEST_DATABASE_URL and REDIS_URL are required for browser tests');
  }
  const suffix = randomBytes(5).toString('hex');
  const dbName = `bedo_e2e_${suffix}`;
  const login = `bedo_e2e_${suffix}`;
  const password = randomBytes(12).toString('hex');
  const prefix = `bedo-e2e-${suffix}`;
  const totpKey = randomBytes(32);

  await query(adminUrl, `create database ${dbName}`);
  const ownerUrl = Object.assign(new URL(adminUrl), { pathname: `/${dbName}` }).toString();
  await runMigrations({ connectionString: ownerUrl, migrationsDir: defaultMigrationsDir() });
  await query(adminUrl, `create role ${login} login password '${password}' in role bedo_runtime`);
  const runtime = new URL(ownerUrl);
  runtime.username = login;
  runtime.password = password;

  const processes = [
    start('node', ['dist/main.js'], path.join(repoRoot, 'apps/api'), {
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      API_HOST: '127.0.0.1',
      API_PORT: String(API_PORT),
      DATABASE_URL: runtime.toString(),
      REDIS_URL: redisUrl,
      QUEUE_PREFIX: prefix,
      CORS_ALLOWED_ORIGINS: `${WEB_URL},${ADMIN_URL}`,
      ADMIN_ORIGINS: ADMIN_URL,
      ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64'),
      OTP_HMAC_SECRET: randomBytes(32).toString('base64'),
      ADMIN_TOTP_KEY: totpKey.toString('base64'),
    }),
    start('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(WEB_PORT), '-H', '127.0.0.1'], path.join(repoRoot, 'apps/web'), {
      NODE_ENV: 'production',
    }),
    start('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(ADMIN_PORT), '-H', '127.0.0.1'], path.join(repoRoot, 'apps/admin'), {
      NODE_ENV: 'production',
    }),
  ];

  const otpQueue = new Queue<OtpJobData>(QUEUE_NAMES.otp, { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }), prefix });
  const stop = async () => {
    for (const child of processes) {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    }
    await otpQueue.obliterate({ force: true }).catch(() => undefined);
    await otpQueue.close();
    await (otpQueue.opts.connection as Redis).quit().catch(() => undefined);
    const redis = new Redis(redisUrl);
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await query(adminUrl, `drop database if exists ${dbName} with (force)`);
    await query(adminUrl, `drop role if exists ${login}`);
  };

  try {
    await Promise.all([waitForHttp(`${API_URL}/health/ready`), waitForHttp(`${WEB_URL}/login`), waitForHttp(`${ADMIN_URL}/login`)]);
  } catch (error) {
    await stop();
    throw error;
  }

  const jobsFor = async (phone: string) =>
    (await otpQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized'])).filter((job) => job?.data.phone === phone);

  return {
    ownerUrl,
    totpKey,
    async latestCode(phone) {
      const jobs = (await jobsFor(phone)).sort((a, b) => b.timestamp - a.timestamp);
      return jobs[0]?.data.code ?? null;
    },
    async codeCount(phone) {
      return (await jobsFor(phone)).length;
    },
    async clearCooldown(phone, scope = 'otp') {
      const redis = new Redis(redisUrl);
      await redis.del(`${prefix}:rl:${scope}:cooldown:${phone}`);
      await redis.quit();
    },
    stop,
  };
}

/** Polls for the code the API queued for this number. */
export async function waitForCode(stack: Stack, phone: string, previous: string | null = null): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = await stack.latestCode(phone);
    if (code && code !== previous) return code;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no code queued for ${phone}`);
}

// ---------------------------------------------------------------- authenticator app (RFC 6238)

export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

export function totpNow(secret: Buffer, offsetSteps = 0): string {
  return hotp(secret, Math.floor(Date.now() / 30_000) + offsetSteps);
}

/** Creates an admin the same way the admin-create command stores it (AES-256-GCM encrypted secret). */
export async function createAdmin(stack: Stack, phone: string, name: string, role: 'super_admin' | 'moderator'): Promise<Buffer> {
  const secret = randomBytes(20);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', stack.totpKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  await query(stack.ownerUrl, 'insert into app.admin_accounts (phone, name, role, totp_secret_enc) values ($1, $2, $3, $4)', [phone, name, role, encrypted]);
  return secret;
}
