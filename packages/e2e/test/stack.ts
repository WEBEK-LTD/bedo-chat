import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync } from 'node:fs';
import { createCipheriv, createHash, createHmac, randomBytes, X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultMigrationsDir, runMigrations } from '@bedo/db';
import { encryptWaabekApiKey } from '@bedo/server-crypto';
import pg from 'pg';
import { type Browser, chromium } from 'playwright-core';
import { WebSocket, WebSocketServer } from 'ws';
import { headersFor, readSiteRules, resolveStatic } from '../../../scripts/netlify-site-rules.mjs';

/**
 * A complete local stack for browser tests (D-36): a fresh migrated database and the ONE Netlify site, which is
 * the whole of Bedo Chat: the built web app served by `next start` (its /api route runs the API in-process,
 * connecting as the least-privilege runtime role), with the Admin Dashboard's static export under /admin, behind
 * a local stand-in for Netlify's file serving and headers:
 *   http://localhost:3100/        student web app      http://localhost:3100/admin  Admin Dashboard
 *   http://localhost:3100/api/... API (the web app's own route handler)
 * Nothing else runs: no API server, no worker, no edge router, no Redis. Two outside services are replaced by
 * one local HTTPS stand-in (https://localhost:3400) that speaks their real protocols: Waabek's send endpoint
 * (codes are read from what "WhatsApp" received) and Supabase Realtime (the HTTP broadcast endpoint the API calls
 * and the Phoenix WebSocket the browser's @supabase/realtime-js connects to). The web app must be built with
 * NEXT_PUBLIC_STORAGE_ORIGIN=https://localhost:3400 (`pnpm e2e` does this) so its CSP allows the realtime socket.
 */
export const SITE_PORT = 3100;
/** `next start` for the built web app, behind the Netlify site's rules. */
const NEXT_PORT = 3202;
/** Stand-in for Waabek and Supabase Realtime (HTTPS, a certificate made for this run). */
export const SERVICES_PORT = 3400;
export const SITE_URL = `http://localhost:${SITE_PORT}`;
export const WEB_URL = SITE_URL;
export const ADMIN_URL = `${SITE_URL}/admin`;
export const API_URL = `${SITE_URL}/api`;
export const SERVICES_URL = `https://localhost:${SERVICES_PORT}`;
/** The fake Waabek key browser tests store in the settings when they do not set one themselves. */
export const E2E_WAABEK_KEY = 'fake-waabek-key-e2e-stack-0001';

/** A self-signed certificate for localhost, made once per test run (never committed). */
const certificate = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bedo-e2e-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  const pem = readFileSync(certPath, 'utf8');
  const spki = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
  return { keyPath, certPath, key: readFileSync(keyPath), cert: pem, spkiHash: createHash('sha256').update(spki).digest('base64') };
})();

const executablePath = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';

/** Chromium that trusts exactly this run's local HTTPS stand-in (by its key), and nothing else extra. */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath, headless: true, args: [`--ignore-certificate-errors-spki-list=${certificate.spkiHash}`] });
}

interface WaabekMessage {
  apiKey: string;
  phone: string;
  text: string;
}

interface Broadcast {
  topic: string;
  event: string;
  payload: unknown;
  private: boolean;
}

/** A device token's claims if it is an unexpired HS256 JWT signed with `secret` (as Supabase Realtime checks it). */
function realtimeClaims(token: unknown, secret: string): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (expected !== parts[2]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof claims.exp === 'number' && claims.exp * 1000 > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Waabek's send endpoint (POST JSON {to, message} with X-API-Key) and Supabase Realtime: its HTTP broadcast
 * endpoint (service key required) and its Phoenix WebSocket (protocol 1.0.0, public key required), delivering
 * each broadcast to the sockets that joined its topic. As in production (public access off, Realtime Authorization
 * with the realtime.messages policy), a join is accepted only for a private channel and with a token signed with the
 * project's JWT secret, for the role authenticated, whose bedo_topic claim is that channel; only private broadcasts
 * are delivered.
 */
function startServices(keys: { serviceKey: string; anonKey: string; jwtSecret: string }) {
  const messages: WaabekMessage[] = [];
  const broadcasts: Broadcast[] = [];
  const refusedJoins: Array<{ topic: string; reason: string }> = [];
  const joined = new Map<WebSocket, Set<string>>();
  const sockets = new Set<WebSocket>();

  const readBody = (request: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      request.on('end', () => resolve(raw));
    });

  const server = https.createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', SERVICES_URL);
      const body = await readBody(request);
      if (request.method === 'POST' && url.pathname === '/waabek/send') {
        const apiKey = String(request.headers['x-api-key'] ?? '');
        const parsed = JSON.parse(body) as { to: string; message: string };
        messages.push({ apiKey, phone: `+${parsed.to}`, text: parsed.message });
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/realtime/v1/api/broadcast') {
        if (request.headers.apikey !== keys.serviceKey || request.headers.authorization !== `Bearer ${keys.serviceKey}`) {
          response.writeHead(401).end();
          return;
        }
        const parsed = JSON.parse(body) as { messages: Array<Broadcast & { private?: boolean }> };
        for (const message of parsed.messages) {
          broadcasts.push({ topic: message.topic, event: message.event, payload: message.payload, private: message.private === true });
          if (message.private !== true) continue; // public channels are turned off
          const frame = JSON.stringify({
            topic: `realtime:${message.topic}`,
            event: 'broadcast',
            payload: { type: 'broadcast', event: message.event, payload: message.payload },
            ref: null,
          });
          for (const [socket, topics] of joined) {
            if (topics.has(`realtime:${message.topic}`) && socket.readyState === WebSocket.OPEN) socket.send(frame);
          }
        }
        response.writeHead(202).end();
        return;
      }
      response.writeHead(404).end();
    })();
  });

  const realtime = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', SERVICES_URL);
    if (url.pathname !== '/realtime/v1/websocket' || url.searchParams.get('apikey') !== keys.anonKey) {
      socket.destroy();
      return;
    }
    realtime.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      joined.set(ws, new Set());
      ws.on('close', () => {
        sockets.delete(ws);
        joined.delete(ws);
      });
      ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as { topic: string; event: string; payload: unknown; ref: string | null; join_ref?: string | null };
        const reply = (response: Record<string, unknown> = {}) =>
          ws.send(JSON.stringify({ topic: message.topic, event: 'phx_reply', payload: { status: 'ok', response }, ref: message.ref, join_ref: message.join_ref ?? null }));
        if (message.event === 'phx_join') {
          const join = (message.payload ?? {}) as { config?: { private?: unknown }; access_token?: unknown };
          const claims = realtimeClaims(join.access_token, keys.jwtSecret);
          const topic = message.topic.replace(/^realtime:/, '');
          const reason =
            join.config?.private !== true
              ? 'public channels are turned off'
              : !claims
                ? 'invalid or expired token'
                : claims.role !== 'authenticated' || claims.bedo_topic !== topic
                  ? 'You do not have permissions to read from this Channel topic'
                  : null;
          if (reason) {
            refusedJoins.push({ topic, reason });
            ws.send(JSON.stringify({ topic: message.topic, event: 'phx_reply', payload: { status: 'error', response: { reason } }, ref: message.ref, join_ref: message.join_ref ?? null }));
            return;
          }
          joined.get(ws)?.add(message.topic);
          reply({});
        } else if (message.event === 'phx_leave') {
          joined.get(ws)?.delete(message.topic);
          reply({});
        } else if (message.event === 'heartbeat') {
          reply({});
        }
      });
    });
  });

  return {
    messages,
    broadcasts,
    refusedJoins,
    /** Topics browsers are listening on right now. */
    listening: () => [...joined.values()].flatMap((topics) => [...topics]),
    listen: () => new Promise<void>((resolve) => server.listen(SERVICES_PORT, '127.0.0.1', () => resolve())),
    stop: async () => {
      for (const ws of sockets) ws.terminate();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
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
 * Local stand-in for the one Netlify site (D-26, D-36), in Netlify's order. The web app's public/ folder (which holds
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
    // As Netlify does for its server functions: the site's own Host is kept (the API compares the browser's
    // Origin with it), and the client's address is set in x-nf-client-connection-ip, replacing any value the
    // client sent.
    const headers: http.OutgoingHttpHeaders = { ...request.headers, 'x-nf-client-connection-ip': request.socket.remoteAddress ?? '' };
    const upstream = http.request(destination, { method: request.method, headers }, (answer) => {
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
  /** Every WhatsApp message the stand-in Waabek received (number, text and the key it was sent with). */
  waabekMessages(): WaabekMessage[];
  /** Every realtime broadcast the API sent (topic, event and the signal). */
  broadcasts(): Broadcast[];
  /** Realtime topics browsers are subscribed to right now. */
  listeningTopics(): string[];
  /** Channel joins the Realtime stand-in refused (no private channel, no or wrong token), with the reason. */
  refusedJoins(): Array<{ topic: string; reason: string }>;
  /** Clears the 60-second resend cooldown so a second device can sign in straight away. */
  clearCooldown(phone: string): Promise<void>;
  /** Everything the website's server process wrote (its logs, including the API's, at level info). */
  apiOutput(): string;
  stop(): Promise<void>;
}

export async function startStack(options: { waabekKey?: boolean } = {}): Promise<Stack> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error('TEST_DATABASE_URL is required for browser tests');
  }
  const suffix = randomBytes(5).toString('hex');
  const dbName = `bedo_e2e_${suffix}`;
  const login = `bedo_e2e_${suffix}`;
  const password = randomBytes(12).toString('hex');
  const totpKey = randomBytes(32);
  const settingsKey = randomBytes(32);
  const serviceKey = `service-${randomBytes(16).toString('hex')}`;
  const anonKey = `anon-${randomBytes(16).toString('hex')}`;
  const jwtSecret = randomBytes(32).toString('base64');

  await query(adminUrl, `create database ${dbName}`);
  const ownerUrl = Object.assign(new URL(adminUrl), { pathname: `/${dbName}` }).toString();
  await runMigrations({ connectionString: ownerUrl, migrationsDir: defaultMigrationsDir() });
  await query(adminUrl, `create role ${login} login password '${password}' in role bedo_runtime`);
  const runtime = new URL(ownerUrl);
  runtime.username = login;
  runtime.password = password;
  if (options.waabekKey !== false) {
    // As if a Super Admin had saved it in the Admin Dashboard (D-32): sign-in codes can be delivered.
    await query(ownerUrl, 'update app.otp_settings set waabek_api_key_enc = $1', [encryptWaabekApiKey(settingsKey, E2E_WAABEK_KEY)]);
  }

  const services = startServices({ serviceKey, anonKey, jwtSecret });
  await services.listen();

  const serverOutput: Buffer[] = [];
  const processes = [
    // The one site's server: Next.js (production build) with the API in its /api route. Its environment is
    // exactly what the Netlify site gets (D-36), with the two outside services pointed at the local stand-in.
    start('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(NEXT_PORT), '-H', '127.0.0.1'], path.join(repoRoot, 'apps/web'), {
      NODE_ENV: 'production',
      // Request logs are kept so tests can check that no password or token ever reaches them (D-34).
      LOG_LEVEL: 'info',
      DATABASE_URL: runtime.toString(),
      ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64'),
      OTP_HMAC_SECRET: randomBytes(32).toString('base64'),
      ADMIN_TOTP_KEY: totpKey.toString('base64'),
      SETTINGS_ENCRYPTION_KEY: settingsKey.toString('base64'),
      WAABEK_API_URL: `${SERVICES_URL}/waabek/send`,
      SUPABASE_URL: SERVICES_URL,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      SUPABASE_ANON_KEY: anonKey,
      SUPABASE_JWT_SECRET: jwtSecret,
      // Trusts this run's stand-in certificate, as the server trusts waabek.com and supabase.co in production.
      NODE_EXTRA_CA_CERTS: certificate.certPath,
    }, serverOutput),
  ];

  const site = await startNetlifySite(SITE_PORT, `http://127.0.0.1:${NEXT_PORT}`);
  const stop = async () => {
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
    await services.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await query(adminUrl, `drop database if exists ${dbName} with (force)`);
    await query(adminUrl, `drop role if exists ${login}`);
  };

  try {
    await Promise.all([waitForHttp(`${API_URL}/health/ready`), waitForHttp(`${WEB_URL}/login`), waitForHttp(`${ADMIN_URL}/login`)]);
  } catch (error) {
    if (process.env.E2E_DEBUG) process.stderr.write(Buffer.concat(serverOutput));
    await stop();
    throw error;
  }

  const codesFor = (phone: string) =>
    services.messages
      .filter((message) => message.phone === phone)
      .map((message) => /verification code is: (\d{6})$/.exec(message.text)?.[1])
      .filter((code): code is string => Boolean(code));

  return {
    ownerUrl,
    totpKey,
    settingsKey,
    async latestCode(phone) {
      return codesFor(phone).at(-1) ?? null;
    },
    async codeCount(phone) {
      return codesFor(phone).length;
    },
    waabekMessages: () => services.messages,
    broadcasts: () => services.broadcasts,
    listeningTopics: () => services.listening(),
    refusedJoins: () => services.refusedJoins,
    async clearCooldown(phone) {
      await query(ownerUrl, 'delete from app.ephemeral where key = $1', [`rl:otp:cooldown:${phone}`]);
    },
    apiOutput() {
      return Buffer.concat(serverOutput).toString('utf8');
    },
    stop,
  };
}

/** Polls for the code the API sent through (the stand-in) Waabek to this number. */
export async function waitForCode(stack: Stack, phone: string, previous: string | null = null): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = await stack.latestCode(phone);
    if (code && code !== previous) return code;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no code sent to ${phone}`);
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

/** Sets an admin's password through the site's /api, as the Set Password panel on /admin/login does. */
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
