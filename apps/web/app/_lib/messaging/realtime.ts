import { MESSAGING_RULES, REALTIME_CLOSE, REALTIME_PATH, type RealtimeClientMessage, type RealtimeServerMessage } from '@bedo/contracts';
import { session } from '../api';

export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface RealtimeHandlers {
  /** Connected and authenticated; the device should now say which update it holds. */
  onReady(serverSeq: number): void;
  onMessage(message: RealtimeServerMessage): void;
  onState(state: ConnectionState): void;
}

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');
const HEARTBEAT_MS = MESSAGING_RULES.heartbeatSeconds * 1000;
const MAX_BACKOFF_MS = 30_000;

/** wss://bedochat.com/api/v1/realtime from https://bedochat.com/api (ws:// for local http). */
export function realtimeUrl(): string {
  const base = new URL(API_URL || '/api', window.location.href);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `${base.pathname.replace(/\/$/, '')}${REALTIME_PATH}`;
  base.search = '';
  return base.toString();
}

/**
 * The realtime connection (step 3.5): authenticates with the in-memory access token in its first message,
 * sends a heartbeat every 25 seconds, and reconnects with backoff whenever it drops (offline, server
 * restart, sleep). Nothing depends on it: every change is also fetched by sync after reconnecting.
 */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = true;
  private freshToken = false;

  constructor(private readonly handlers: RealtimeHandlers) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    window.addEventListener('online', this.reconnectNow);
    document.addEventListener('visibilitychange', this.onVisible);
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.reconnectNow);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.clearTimers();
    this.socket?.close(1000);
    this.socket = null;
  }

  send(message: RealtimeClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private readonly reconnectNow = () => {
    if (this.stopped || this.socket) return;
    this.attempts = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    void this.connect();
  };

  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.reconnectNow();
  };

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.heartbeat = null;
    this.retryTimer = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.handlers.onState('connecting');
    let token: string;
    try {
      token = await session.realtimeToken(this.freshToken);
      this.freshToken = false;
    } catch {
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(realtimeUrl());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth', token } satisfies RealtimeClientMessage));
    };
    socket.onmessage = (event) => {
      let message: RealtimeServerMessage;
      try {
        message = JSON.parse(String(event.data)) as RealtimeServerMessage;
      } catch {
        return;
      }
      if (message.type === 'ready') {
        this.attempts = 0;
        this.handlers.onState('online');
        this.heartbeat = setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_MS);
        this.handlers.onReady(message.seq);
        return;
      }
      this.handlers.onMessage(message);
    };
    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      this.clearTimers();
      this.handlers.onState('offline');
      if (this.stopped) return;
      // A refused token (expired after 10 minutes) is replaced once before the next attempt.
      if (event.code === REALTIME_CLOSE.unauthenticated) this.freshToken = true;
      if (event.code === REALTIME_CLOSE.forbidden) {
        // The account is blocked: the next HTTP request ends the session through the normal path.
        this.freshToken = true;
      }
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.handlers.onState('offline');
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts) * (0.5 + Math.random() / 2);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}
