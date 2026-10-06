import { type ChildProcess, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type OtpJobData, QUEUE_NAMES } from '@bedo/contracts';
import { defaultMigrationsDir, runMigrations } from '@bedo/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { destinationUrl, publicLocation, route, type RouterEnv } from '../../../deploy/cloudflare/worker.js';
import { headersFor, readSiteRules, resolveStatic } from '../../../scripts/netlify-site-rules.mjs';

/**
 * A complete local stack for browser tests: a fresh migrated database, the built API (connecting as the
 * least-privilege runtime role), the one Netlify site (D-26: the built web app, which includes the Admin
 * Dashboard's static export under /admin, served by `next start` behind the site's own netlify.toml rules),
 * and in front of them one local "site" that routes paths exactly like the production Cloudflare Worker (D-25):
 *   http://localhost:3100/        student web app      http://localhost:3100/admin  Admin Dashboard
 *   http://localhost:3100/api/... API (prefix removed, WebSocket upgrades passed through)
 *
 * The apps must be built with NEXT_PUBLIC_API_URL=http://localhost:3100/api (`pnpm e2e` does this). Codes are
 * read from the OTP job queue, exactly what the worker would send through Waabek; no WhatsApp is sent.
 */
export const SITE_PORT = 3100;
/** The one Netlify site (D-26): web app and Admin Dashboard. */
const NETLIFY_SITE_PORT = 3200;
/** `next start` for the built web app, behind the Netlify site's rules. */
const NEXT_PORT = 3202;
/** The one Netlify site's own address (the production equivalent is https://bedochat.netlify.app). */
export const NETLIFY_SITE_URL = `http://127.0.0.1:${NETLIFY_SITE_PORT}`;
const API_PORT = 4100;
export const SITE_URL = `http://localhost:${SITE_PORT}`;
export const WEB_URL = SITE_URL;
export const ADMIN_URL = `${SITE_URL}/admin`;
export const API_URL = `${SITE_URL}/api`;
/** Shared with the API like the production Worker's EDGE_SECRET. */
const EDGE_SECRET = randomBytes(32).toString('base64');
const ORIGINS: RouterEnv = {
  // D-26: both point at the same Netlify site.
  WEB_ORIGIN: `http://127.0.0.1:${NETLIFY_SITE_PORT}`,
  ADMIN_ORIGIN: `http://127.0.0.1:${NETLIFY_SITE_PORT}`,
  API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
};

/**
 * Local stand-in for the Cloudflare edge: the Worker's own route(), destinationUrl() and publicLocation()
 * decide where each request goes; the client IP is passed as X-Forwarded-For (the API trusts one proxy
 * hop here); the edge secret is added for the API only; upgrades are piped through.
 */
export function startEdge(port: number, origins: RouterEnv, edgeSecret = EDGE_SECRET): Promise<http.Server> {
  const target = (rawUrl: string | undefined) => {
    const url = new URL(rawUrl ?? '/', 'http://edge.local');
    const routed = route(url.pathname, origins);
    const destination = destinationUrl(routed.origin, routed.path, url.search);
    if (!destination) throw new Error('refused');
    return { routed, destination, toApi: routed.origin === origins.API_ORIGIN };
  };
  const forwardHeaders = (request: http.IncomingMessage, host: string, toApi: boolean) => {
    const headers: http.OutgoingHttpHeaders = {
      ...request.headers,
      host,
      'x-forwarded-for': request.socket.remoteAddress ?? '',
      'x-forwarded-host': request.headers.host ?? '',
      'x-forwarded-proto': 'http',
    };
    delete headers['x-request-id'];
    delete headers['x-bedo-edge-secret'];
    if (toApi) headers['x-bedo-edge-secret'] = edgeSecret;
    return headers;
  };
  const server = http.createServer((request, response) => {
    let routing: ReturnType<typeof target>;
    try {
      routing = target(request.url);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const { routed, destination, toApi } = routing;
    const upstream = http.request(
      destination,
      { method: request.method, headers: forwardHeaders(request, destination.host, toApi) },
      (answer) => {
        const headers = { ...answer.headers };
        if (typeof headers.location === 'string') {
          headers.location = publicLocation(headers.location, routed.origin, SITE_URL, toApi ? '/api' : '');
        }
        response.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  server.on('upgrade', (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    let routing: ReturnType<typeof target>;
    try {
      routing = target(request.url);
    } catch {
      socket.destroy();
      return;
    }
    const { destination, toApi } = routing;
    const upstream = net.connect(Number(destination.port), destination.hostname, () => {
      const lines = [`${request.method} ${destination.pathname}${destination.search} HTTP/1.1`];
      for (const [name, value] of Object.entries(forwardHeaders(request, destination.host, toApi))) {
        for (const item of [value ?? []].flat()) lines.push(`${name}: ${item}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Local stand-in for the one Netlify site (D-26), in Netlify's order. The web app's public/ folder (which holds
 * the Admin Dashboard export under admin/) is what Netlify publishes as static files: a GET or HEAD that
 * Netlify's static file matching resolves to one of those files is answered with that file and the site's
 * [[headers]] for the path (apps/web/netlify.toml). Everything else goes to the Next.js server (`next start`),
 * as on Netlify, where the server function (path /*, preferStatic) comes before redirect rules.
 */
export function startNetlifySite(port: number, nextOrigin: string): Promise<http.Server> {
  const rules = readSiteRules();
  const publicDir = path.join(repoRoot, 'apps/web/public');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://site.local');
    const file = request.method === 'GET' || request.method === 'HEAD' ? resolveStatic(publicDir, url.pathname) : null;
    if (file) {
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        ...headersFor(rules, url.pathname),
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(file).pipe(response);
      return;
    }
    const destination = new URL(`${url.pathname}${url.search}`, nextOrigin);
    const upstream = http.request(destination, { method: request.method, headers: { ...request.headers, host: destination.host } }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}


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

function start(command: string, args: string[], cwd: string, env: Record<string, string>, output?: Buffer[]): ChildProcess {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', output ? 'pipe' : 'ignore', 'pipe'], detached: true });
  child.stderr?.on('data', (chunk: Buffer) => {
    output?.push(chunk);
    if (process.env.E2E_DEBUG) process.stderr.write(chunk);
  });
  child.stdout?.on('data', (chunk: Buffer) => output?.push(chunk));
  return child;
}

export interface Stack {
  ownerUrl: string;
  totpKey: Buffer;
  settingsKey: Buffer;
  latestCode(phone: string): Promise<string | null>;
  codeCount(phone: string): Promise<number>;
  /** Clears the 60-second resend cooldown so a second device can sign in straight away. */
  clearCooldown(phone: string): Promise<void>;
  /** Everything the API process wrote to stdout and stderr (its logs, at level info). */
  apiOutput(): string;
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
  const settingsKey = randomBytes(32);

  await query(adminUrl, `create database ${dbName}`);
  const ownerUrl = Object.assign(new URL(adminUrl), { pathname: `/${dbName}` }).toString();
  await runMigrations({ connectionString: ownerUrl, migrationsDir: defaultMigrationsDir() });
  await query(adminUrl, `create role ${login} login password '${password}' in role bedo_runtime`);
  const runtime = new URL(ownerUrl);
  runtime.username = login;
  runtime.password = password;

  const apiOutput: Buffer[] = [];
  const processes = [
    start('node', ['dist/main.js'], path.join(repoRoot, 'apps/api'), {
      NODE_ENV: 'development',
      // Request logs are kept so tests can check that no password or token ever reaches them (D-34).
      LOG_LEVEL: 'info',
      API_HOST: '127.0.0.1',
      API_PORT: String(API_PORT),
      DATABASE_URL: runtime.toString(),
      REDIS_URL: redisUrl,
      QUEUE_PREFIX: prefix,
      // D-25: both apps and the API share one origin; the API sits behind /api and one proxy hop.
      CORS_ALLOWED_ORIGINS: SITE_URL,
      ADMIN_ORIGINS: SITE_URL,
      WEB_ORIGINS: SITE_URL,
      API_PUBLIC_PATH: '/api',
      API_TRUST_PROXY_HOPS: '1',
      EDGE_SECRET,
      ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64'),
      OTP_HMAC_SECRET: randomBytes(32).toString('base64'),
      ADMIN_TOTP_KEY: totpKey.toString('base64'),
      SETTINGS_ENCRYPTION_KEY: settingsKey.toString('base64'),
    }, apiOutput),
    start('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(NEXT_PORT), '-H', '127.0.0.1'], path.join(repoRoot, 'apps/web'), {
      NODE_ENV: 'production',
    }),
  ];

  const site = await startNetlifySite(NETLIFY_SITE_PORT, `http://127.0.0.1:${NEXT_PORT}`);
  const edge = await startEdge(SITE_PORT, ORIGINS);
  const otpQueue = new Queue<OtpJobData>(QUEUE_NAMES.otp, { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }), prefix });
  const stop = async () => {
    edge.closeAllConnections();
    await new Promise((resolve) => edge.close(resolve));
    site.closeAllConnections();
    await new Promise((resolve) => site.close(resolve));
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
    (await otpQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized'])).filter((job) => job?.name === 'send' && job.data.phone === phone);

  return {
    ownerUrl,
    totpKey,
    settingsKey,
    async latestCode(phone) {
      const jobs = (await jobsFor(phone)).sort((a, b) => b.timestamp - a.timestamp);
      return jobs[0]?.data.code ?? null;
    },
    async codeCount(phone) {
      return (await jobsFor(phone)).length;
    },
    async clearCooldown(phone) {
      const redis = new Redis(redisUrl);
      await redis.del(`${prefix}:rl:otp:cooldown:${phone}`);
      await redis.quit();
    },
    apiOutput() {
      return Buffer.concat(apiOutput).toString('utf8');
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

// ---------------------------------------------------------------- admin passwords (D-34)

/** The password browser-test admins get: long enough, not a phone number, not a common password. */
export const ADMIN_PASSWORD = ['tidal', 'quartz', 'lantern', '0471'].join('-');

/** What the owner runs in the SQL editor: a one-time password setup token for that admin. */
export async function issuePasswordSetup(stack: Stack, phone: string): Promise<string> {
  return (await query<{ setup_token: string }>(stack.ownerUrl, 'select setup_token from app.issue_admin_password_setup($1)', [phone])).rows[0]!.setup_token;
}

/** Sets an admin's password through the edge, as the Set Password panel on /admin/login does. */
export async function setPasswordByApi(stack: Stack, phone: string, password = ADMIN_PASSWORD): Promise<void> {
  const setupToken = await issuePasswordSetup(stack, phone);
  const response = await fetch(`${API_URL}/v1/admin/auth/password/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE_URL, 'x-bedo-csrf': '1' },
    body: JSON.stringify({ phone, setupToken, password }),
  });
  if (!response.ok) {
    throw new Error(`Setting the admin password failed: ${response.status} ${await response.text()}`);
  }
}

/** Creates an admin the same way the admin-create command stores it (AES-256-GCM encrypted secret), with a password. */
export async function createAdmin(stack: Stack, phone: string, name: string, role: 'super_admin' | 'moderator'): Promise<Buffer> {
  const secret = randomBytes(20);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', stack.totpKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  await query(stack.ownerUrl, 'insert into app.admin_accounts (phone, name, role, totp_secret_enc) values ($1, $2, $3, $4)', [phone, name, role, encrypted]);
  await setPasswordByApi(stack, phone);
  return secret;
}
