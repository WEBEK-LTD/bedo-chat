import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type BeforeApplicationShutdown, Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { ApiEnv } from '@bedo/config';
import {
  MESSAGING_RULES,
  REALTIME_CLOSE,
  REALTIME_PATH,
  type RealtimeClientMessage,
  realtimeClientMessageSchema,
  type RealtimeServerMessage,
} from '@bedo/contracts';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { UserAuthGuard } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { API_ENV } from '../config/tokens.js';
import { DatabaseService } from '../database/database.service.js';
import { ipBucket } from '../redis/rate-limit.service.js';
import { EDGE_SECRET_HEADER } from '../security/edge-guard.js';
import { userAppOrigins } from '../security/csrf.js';
import { ChatsService } from './chats.service.js';
import { PermissionService } from './permissions.service.js';
import { lastSeenToMinute, PresenceService } from './presence.service.js';
import { type BusMessage, RealtimeBusService } from './realtime-bus.service.js';
import { SyncService } from './sync.service.js';

const AUTH_TIMEOUT_MS = 10_000;
/** Heartbeats and sessions of open connections are checked this often. */
const WATCHDOG_INTERVAL_MS = 5_000;
/** Typing and delivered acknowledgements re-check the session when the last check is older than this. */
const SESSION_RECHECK_MS = 2_000;
/** Connections that have not authenticated yet, per client address and API instance. */
const MAX_PENDING_PER_IP = 20;
const HEARTBEAT_TIMEOUT_MS = MESSAGING_RULES.onlineTtlSeconds * 1000;
const MAX_MESSAGE_BYTES = 16 * 1024;
/** A device that stops reading this much queued output is disconnected (it will sync on reconnect). */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Inbound messages per connection: a bucket of 20, refilled at 10 per second. */
const BUCKET_SIZE = 20;
const BUCKET_REFILL_PER_MS = 10 / 1000;
/** Typing indicators are relayed at most every 2 seconds per chat; each lasts 6 seconds (P-18). */
const TYPING_RELAY_INTERVAL_MS = 2_000;

interface Connection {
  id: string;
  ws: WebSocket;
  userId: string | null;
  sessionId: string | null;
  /** Update seq the device holds; null until it asks to sync. */
  cursor: number | null;
  lastPing: number;
  pulling: boolean;
  pullAgain: boolean;
  typingRelayed: Map<string, number>;
  tokens: number;
  tokensAt: number;
  queue: Promise<void>;
  authTimer: NodeJS.Timeout | null;
  closed: boolean;
  ip: string;
  /** Counted among its address's connections that have not authenticated yet. */
  pending: boolean;
  sessionCheckedAt: number;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Realtime gateway (step 3.5, blueprint: Gateway): a WebSocket at /v1/realtime (https://bedochat.com/api/v1/realtime
 * through the edge). It accepts only upgrades that came through the edge router (EDGE_SECRET), from the
 * student web app's origin, and authenticates with the access token in the first message, checked by the
 * same code as HTTP requests. Every update a device receives is read through the sync service and every
 * short-lived event (typing, presence) passes the permission service before it is sent; nothing is pushed
 * that the HTTP API would not return to that user.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  private readonly byUser = new Map<string, Set<Connection>>();
  private readonly all = new Set<Connection>();
  private readonly allowedOrigins: string[];
  private readonly edgeSecret: Buffer | null;
  private readonly trustedHops: number;
  private readonly pendingByIp = new Map<string, number>();
  private server: Server | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private shuttingDown = false;
  /** Disconnect handling still running (last seen being written). */
  private readonly closing = new Set<Promise<void>>();

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(UserAuthGuard) private readonly auth: UserAuthGuard,
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(RealtimeBusService) private readonly bus: RealtimeBusService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {
    this.allowedOrigins = userAppOrigins(env);
    this.edgeSecret = env.EDGE_SECRET ? digest(env.EDGE_SECRET) : null;
    this.trustedHops = env.API_TRUST_PROXY_HOPS;
  }

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined;
    if (!server) {
      return;
    }
    this.server = server;
    server.on('upgrade', this.onUpgrade);
    this.unsubscribe = this.bus.onMessage((message) => this.onBusMessage(message));
    this.watchdog = setInterval(() => void this.checkConnections(), WATCHDOG_INTERVAL_MS);
    this.watchdog.unref();
  }

  /** Connected devices of a user on this instance (tests and diagnostics). */
  connectionCount(userId?: string): number {
    return userId ? (this.byUser.get(userId)?.size ?? 0) : this.all.size;
  }

  // ------------------------------------------------------------------------------------ handshake

  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => undefined);
    if (this.shuttingDown) {
      return reject(socket, 503, 'Service Unavailable');
    }
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    if (pathname !== REALTIME_PATH) {
      return reject(socket, 404, 'Not Found');
    }
    // D-25: only upgrades that came through the edge router (the HTTP edge guard does not see upgrades).
    if (this.edgeSecret) {
      const provided = request.headers[EDGE_SECRET_HEADER];
      if (typeof provided !== 'string' || !timingSafeEqual(digest(provided), this.edgeSecret)) {
        return reject(socket, 403, 'Forbidden');
      }
    }
    // Only the student web app's pages may open a connection (no other site, and not the Admin Dashboard
    // when it has its own origin).
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !this.allowedOrigins.includes(origin)) {
      return reject(socket, 403, 'Forbidden');
    }
    // IPv6 clients usually control a whole /64; all of it counts as one address, as for the HTTP limits.
    const ip = ipBucket(clientAddress(request, this.trustedHops));
    if ((this.pendingByIp.get(ip) ?? 0) >= MAX_PENDING_PER_IP) {
      return reject(socket, 429, 'Too Many Requests');
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.onConnection(ws, ip));
  };

  private onConnection(ws: WebSocket, ip: string): void {
    const now = Date.now();
    this.pendingByIp.set(ip, (this.pendingByIp.get(ip) ?? 0) + 1);
    const connection: Connection = {
      id: randomUUID(),
      ws,
      userId: null,
      sessionId: null,
      cursor: null,
      lastPing: now,
      pulling: false,
      pullAgain: false,
      typingRelayed: new Map(),
      tokens: BUCKET_SIZE,
      tokensAt: now,
      queue: Promise.resolve(),
      authTimer: null,
      closed: false,
      ip,
      pending: true,
      sessionCheckedAt: 0,
    };
    this.all.add(connection);
    connection.authTimer = setTimeout(() => this.close(connection, REALTIME_CLOSE.authTimeout), AUTH_TIMEOUT_MS);
    ws.on('error', () => undefined);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary || !this.takeToken(connection)) {
        this.close(connection, REALTIME_CLOSE.invalidMessage);
        return;
      }
      const message = parseClientMessage(data);
      if (!message) {
        this.close(connection, REALTIME_CLOSE.invalidMessage);
        return;
      }
      // One message at a time per connection, in order.
      connection.queue = connection.queue.then(() => this.handle(connection, message)).catch((error: unknown) => {
        this.logger.warn(`Realtime message failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    ws.on('close', () => {
      const done = this.onClosed(connection);
      this.closing.add(done);
      void done.finally(() => this.closing.delete(done));
    });
  }

  private takeToken(connection: Connection): boolean {
    const now = Date.now();
    connection.tokens = Math.min(BUCKET_SIZE, connection.tokens + (now - connection.tokensAt) * BUCKET_REFILL_PER_MS);
    connection.tokensAt = now;
    if (connection.tokens < 1) {
      return false;
    }
    connection.tokens -= 1;
    return true;
  }

  // ------------------------------------------------------------------------------------ messages

  private async handle(connection: Connection, message: RealtimeClientMessage): Promise<void> {
    if (connection.closed) {
      return;
    }
    if (message.type === 'auth') {
      await this.authenticate(connection, message.token);
      return;
    }
    if (!connection.userId || !connection.sessionId) {
      this.close(connection, REALTIME_CLOSE.unauthenticated);
      return;
    }
    switch (message.type) {
      case 'ping':
        await this.heartbeat(connection);
        return;
      case 'sync':
        connection.cursor = message.since;
        await this.pull(connection);
        return;
      case 'typing':
        if (await this.ensureSession(connection, SESSION_RECHECK_MS)) {
          await this.relayTyping(connection, message.chatId);
        }
        return;
      case 'delivered':
        if (!(await this.ensureSession(connection, SESSION_RECHECK_MS))) {
          return;
        }
        try {
          await this.chats.delivered(connection.userId, message.chatId, message.seq);
        } catch (error) {
          this.send(connection, { type: 'error', code: error instanceof AppError ? error.code : 'INTERNAL' });
        }
        return;
    }
  }

  private async authenticate(connection: Connection, token: string): Promise<void> {
    if (connection.userId) {
      return;
    }
    try {
      const auth = await this.auth.authenticate(token);
      if (connection.closed) {
        return;
      }
      connection.userId = auth.userId;
      connection.sessionId = auth.sessionId;
    } catch (error) {
      this.close(connection, error instanceof AppError && error.code === 'ACCOUNT_BLOCKED' ? REALTIME_CLOSE.forbidden : REALTIME_CLOSE.unauthenticated);
      return;
    }
    if (connection.authTimer) {
      clearTimeout(connection.authTimer);
      connection.authTimer = null;
    }
    this.releasePending(connection);
    connection.sessionCheckedAt = Date.now();
    const userId = connection.userId;
    const devices = this.byUser.get(userId) ?? new Set<Connection>();
    if (devices.size >= MESSAGING_RULES.maxConnectionsPerUser) {
      connection.userId = null;
      this.close(connection, REALTIME_CLOSE.tooManyConnections);
      return;
    }
    devices.add(connection);
    this.byUser.set(userId, devices);
    connection.lastPing = Date.now();
    this.send(connection, { type: 'ready', seq: await this.sync.currentSeq(userId) });
    await this.markOnline(connection);
  }

  /** P-18: every 25 seconds. Also re-checks the session, so a signed-out device is disconnected. */
  private async heartbeat(connection: Connection): Promise<void> {
    if (!(await this.ensureSession(connection, 0))) {
      return;
    }
    connection.lastPing = Date.now();
    this.send(connection, { type: 'pong' });
    await this.markOnline(connection);
  }

  /**
   * The connection's session is still valid (not signed out or ended, account not blocked or deleted),
   * checked at most `maxAgeMs` ago; otherwise the connection is closed and false returned.
   */
  private async ensureSession(connection: Connection, maxAgeMs: number): Promise<boolean> {
    if (connection.closed || !connection.userId || !connection.sessionId) {
      return false;
    }
    if (Date.now() - connection.sessionCheckedAt <= maxAgeMs) {
      return true;
    }
    try {
      await this.auth.checkSession(connection.sessionId, connection.userId);
      connection.sessionCheckedAt = Date.now();
      return !connection.closed;
    } catch (error) {
      this.close(connection, error instanceof AppError && error.code === 'ACCOUNT_BLOCKED' ? REALTIME_CLOSE.forbidden : REALTIME_CLOSE.unauthenticated);
      return false;
    }
  }

  private async markOnline(connection: Connection): Promise<void> {
    try {
      if (await this.presence.touch(connection.userId!, connection.id)) {
        await this.announcePresence(connection.userId!);
      }
    } catch (error) {
      this.logger.warn(`Presence update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Sends the device every update after its cursor, page by page. Concurrent triggers collapse into one
   * more round, so a burst of messages costs a few reads, not one per message.
   */
  private async pull(connection: Connection): Promise<void> {
    if (connection.pulling) {
      connection.pullAgain = true;
      return;
    }
    connection.pulling = true;
    try {
      do {
        connection.pullAgain = false;
        let more = true;
        while (more && !connection.closed && connection.cursor !== null) {
          // Nothing is read for a session that has ended since the last check (logout, device removed,
          // account blocked or deleted).
          if (!(await this.ensureSession(connection, 0))) {
            return;
          }
          const result = await this.sync.since(connection.userId!, connection.cursor);
          if (result.resync || result.updates.length > 0 || result.seq !== connection.cursor) {
            this.send(connection, { type: 'updates', sync: result });
          }
          connection.cursor = result.seq;
          more = result.hasMore && !result.resync;
        }
      } while (connection.pullAgain && !connection.closed);
    } catch (error) {
      this.logger.warn(`Realtime sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      connection.pulling = false;
    }
  }

  private async relayTyping(connection: Connection, chatId: string): Promise<void> {
    const now = Date.now();
    const last = connection.typingRelayed.get(chatId) ?? 0;
    if (now - last < TYPING_RELAY_INTERVAL_MS) {
      return;
    }
    connection.typingRelayed.set(chatId, now);
    if (connection.typingRelayed.size > 100) {
      connection.typingRelayed.clear();
    }
    const db = this.database.db;
    const access = await this.permissions.findChatAccess(db, connection.userId!, chatId);
    // Typing is shown only where a message could be sent (no block either way, messaging allowed).
    if (!access || !(await this.permissions.canSend(db, connection.userId!, access.peerId))) {
      return;
    }
    this.bus.sendEvent(access.peerId, { type: 'typing', chatId, userId: connection.userId! });
  }

  /** Tells the user's chat partners about a change of online state, where they may see it (P-31, blocks). */
  private async announcePresence(userId: string): Promise<void> {
    const db = this.database.db;
    const chats = await db
      .selectFrom('app.conversations')
      .select(['private_low', 'private_high'])
      .where('type', '=', 'private')
      .where((eb) => eb.or([eb('private_low', '=', userId), eb('private_high', '=', userId)]))
      .execute();
    const partners = chats.map((chat) => (chat.private_low === userId ? chat.private_high : chat.private_low)).filter((id): id is string => id !== null);
    if (partners.length === 0) {
      return;
    }
    const relations = await this.permissions.relationsToward(db, userId, partners);
    const state = (await this.presence.states([userId])).get(userId);
    if (!state) {
      return;
    }
    const presence = { online: state.online, lastSeenAt: state.online ? null : lastSeenToMinute(state.lastSeenMs) };
    for (const [partnerId, relation] of relations) {
      if (this.permissions.visibilities(relation).presence) {
        this.bus.sendEvent(partnerId, { type: 'presence', userId, presence });
      }
    }
  }

  // ------------------------------------------------------------------------------------ fan-out

  private onBusMessage(message: BusMessage): void {
    if (message.t === 'updates') {
      for (const userId of message.users) {
        for (const connection of this.byUser.get(userId) ?? []) {
          if (connection.cursor !== null) {
            void this.pull(connection);
          }
        }
      }
      return;
    }
    if (message.t === 'event') {
      for (const connection of this.byUser.get(message.to) ?? []) {
        // Short-lived events too go only to a device whose session is still valid (checked at most 2 s ago).
        void this.ensureSession(connection, SESSION_RECHECK_MS).then((valid) => {
          if (valid) this.send(connection, message.event);
        });
      }
    }
  }

  private send(connection: Connection, message: RealtimeServerMessage): void {
    if (connection.closed || connection.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (connection.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(connection, REALTIME_CLOSE.heartbeatTimeout);
      return;
    }
    connection.ws.send(JSON.stringify(message));
  }

  // ------------------------------------------------------------------------------------ lifecycle

  /**
   * Every 5 seconds: closes connections whose heartbeat stopped (60 s, P-18) and, in one query, those whose
   * session has ended, so a signed-out or blocked device stops receiving even short-lived events.
   */
  private async checkConnections(): Promise<void> {
    const now = Date.now();
    const authenticated: Connection[] = [];
    for (const connection of this.all) {
      if (!connection.userId || connection.closed) continue;
      if (now - connection.lastPing > HEARTBEAT_TIMEOUT_MS) {
        this.close(connection, REALTIME_CLOSE.heartbeatTimeout);
        continue;
      }
      authenticated.push(connection);
    }
    if (authenticated.length === 0) return;
    try {
      const rows = await this.database.db
        .selectFrom('app.sessions as s')
        .innerJoin('app.users as u', 'u.id', 's.user_id')
        .select(['s.id', 's.user_id', 's.revoked_at', 's.revoke_reason', 's.expires_at', 'u.status'])
        .where('s.id', 'in', [...new Set(authenticated.map((connection) => connection.sessionId!))])
        .execute();
      const sessions = new Map(rows.map((row) => [row.id, row]));
      const checkedAt = Date.now();
      for (const connection of authenticated) {
        const session = sessions.get(connection.sessionId!);
        const blocked = session?.status === 'suspended' || session?.status === 'banned';
        const valid =
          session &&
          session.user_id === connection.userId &&
          !session.revoked_at &&
          new Date(session.expires_at).getTime() > checkedAt &&
          !blocked &&
          session.status !== 'deleted';
        if (valid) {
          connection.sessionCheckedAt = Math.max(connection.sessionCheckedAt, checkedAt);
        } else {
          this.close(connection, blocked || session?.revoke_reason === 'account_blocked' ? REALTIME_CLOSE.forbidden : REALTIME_CLOSE.unauthenticated);
        }
      }
    } catch (error) {
      this.logger.warn(`Session check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private releasePending(connection: Connection): void {
    if (!connection.pending) return;
    connection.pending = false;
    const count = this.pendingByIp.get(connection.ip) ?? 0;
    if (count <= 1) this.pendingByIp.delete(connection.ip);
    else this.pendingByIp.set(connection.ip, count - 1);
  }

  private close(connection: Connection, code: number): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    try {
      connection.ws.close(code);
    } catch {
      connection.ws.terminate();
    }
    // A peer that never answers the closing handshake is cut off.
    setTimeout(() => connection.ws.terminate(), 5_000).unref();
  }

  private async onClosed(connection: Connection): Promise<void> {
    connection.closed = true;
    if (connection.authTimer) {
      clearTimeout(connection.authTimer);
    }
    this.all.delete(connection);
    const userId = connection.userId;
    this.releasePending(connection);
    if (!userId) {
      return;
    }
    const devices = this.byUser.get(userId);
    devices?.delete(connection);
    if (devices && devices.size === 0) {
      this.byUser.delete(userId);
    }
    try {
      if (await this.presence.remove(userId, connection.id)) {
        await this.announcePresence(userId);
      }
    } catch (error) {
      this.logger.warn(`Presence update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
    }
    this.unsubscribe?.();
    this.server?.off('upgrade', this.onUpgrade);
    const closing = [...this.all].map(
      (connection) =>
        new Promise<void>((resolve) => {
          if (connection.ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          connection.ws.once('close', () => resolve());
          this.close(connection, REALTIME_CLOSE.serverShutdown);
        }),
    );
    // Let each device's last seen be written before the database pool closes (bounded wait).
    const timeout = <T>(promise: Promise<T>) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
    await timeout(Promise.allSettled(closing));
    await timeout(Promise.allSettled([...this.closing]));
    this.wss.close();
  }
}

function parseClientMessage(data: RawData): RealtimeClientMessage | null {
  try {
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
    const parsed = realtimeClientMessageSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The client's address for an upgrade request, trusting exactly API_TRUST_PROXY_HOPS proxies, like the HTTP
 * routes do (the edge Worker passes the address Cloudflare saw in X-Forwarded-For).
 */
export function clientAddress(request: IncomingMessage, trustedHops: number): string {
  const forwarded = request.headers['x-forwarded-for'];
  const hops = (typeof forwarded === 'string' ? forwarded : '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .reverse();
  const chain = [request.socket.remoteAddress ?? 'unknown', ...hops];
  return chain[Math.min(trustedHops, chain.length - 1)] ?? 'unknown';
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
