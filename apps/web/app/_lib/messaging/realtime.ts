import { getRealtimeChannel, realtimeHeartbeat, realtimeOffline } from '@bedo/api-client';
import { MESSAGING_RULES, type RealtimeChannelResponse, type RealtimeSignal, realtimeSignalSchema } from '@bedo/contracts';
import { type RealtimeChannel, RealtimeClient as SupabaseRealtime } from '@supabase/realtime-js';
import { ApiError } from '../api';

export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface RealtimeHandlers {
  /** The server answered a heartbeat: its current update seq (catch up when it differs). */
  onHeartbeat(serverSeq: number): void;
  /** Listening on the realtime channel (again): fetch anything missed while not listening. */
  onListening(): void;
  onSignal(signal: RealtimeSignal): void;
  onState(state: ConnectionState): void;
}

const HEARTBEAT_MS = MESSAGING_RULES.heartbeatSeconds * 1000;
const MAX_BACKOFF_MS = 30_000;

/**
 * The device's link to the server (D-36). Two parts, neither of which anything depends on alone:
 *  - a heartbeat over HTTP every 25 seconds: keeps the user online (P-18) and returns the current update seq,
 *    so the device catches up even if every realtime signal were lost;
 *  - its private Supabase Realtime channel, where the server sends short signals (new updates, typing,
 *    presence). Signals carry no content: the device fetches the updates over HTTP. The channel is private: the
 *    device joins with its own short-lived token, which allows receiving on that channel only and sending nothing.
 * Realtime reconnects by itself; when it is not configured or not reachable, the store polls instead. The
 * channel's name changes every hour; the device then asks for the new one and moves to it.
 */
export class RealtimeClient {
  private socket: SupabaseRealtime | null = null;
  private channel: RealtimeChannel | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** Moves to the channel's next name when the current one expires (every hour). */
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private failures = 0;
  private channelInfo: RealtimeChannelResponse | null = null;
  /** True while subscribed to the channel: signals arrive as they happen. */
  live = false;

  constructor(private readonly handlers: RealtimeHandlers) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.handlers.onState('connecting');
    window.addEventListener('online', this.beatNow);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisible);
    void this.beat();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.beatNow);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.closeChannel();
  }

  /** The channel's name changed: leave it and open the new one (signals missed meanwhile come with the next heartbeat). */
  private readonly rotate = () => {
    if (this.stopped) return;
    this.closeChannel();
    void this.openChannel();
  };

  private readonly beatNow = () => {
    if (this.stopped) return;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    void this.beat();
  };

  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.beatNow();
  };

  /** The page is closing: no longer online (best effort; otherwise it ends 60 s after the last heartbeat). */
  private readonly onPageHide = () => {
    void realtimeOffline({ keepalive: true }).catch(() => undefined);
  };

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => void this.beat(), delayMs);
  }

  private async beat(): Promise<void> {
    if (this.stopped) return;
    try {
      const { seq } = await realtimeHeartbeat();
      if (this.stopped) return;
      this.failures = 0;
      this.handlers.onState('online');
      this.handlers.onHeartbeat(seq);
      if (!this.channelInfo) void this.openChannel();
      this.schedule(HEARTBEAT_MS);
    } catch (error) {
      if (this.stopped) return;
      // A refused session is handled by the API layer (signed out); anything else is retried with backoff.
      if (error instanceof ApiError && error.code !== 'NETWORK' && error.status < 500 && error.status !== 429) {
        this.schedule(HEARTBEAT_MS);
        return;
      }
      this.handlers.onState('offline');
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.failures) * (0.5 + Math.random() / 2);
      this.failures += 1;
      this.schedule(delay);
    }
  }

  private async openChannel(): Promise<void> {
    let info: RealtimeChannelResponse;
    try {
      info = await getRealtimeChannel();
    } catch {
      return; // Tried again after the next heartbeat.
    }
    if (this.stopped || this.channelInfo) return;
    this.channelInfo = info;
    if (!info.enabled || !info.url || !info.apiKey || !info.topic || !info.accessToken) return;
    const accessToken = info.accessToken;
    if (info.expiresInSeconds !== null) {
      // A few seconds after the change (counted by the server's clock), spread over devices.
      const delay = Math.max(1_000, info.expiresInSeconds * 1000 + 2_000 + Math.random() * 20_000);
      this.rotateTimer = setTimeout(this.rotate, delay);
    }
    const socket = new SupabaseRealtime(`${info.url.replace(/\/$/, '')}/realtime/v1`, {
      params: { apikey: info.apiKey },
      // Protocol 1.0.0: plain JSON messages.
      vsn: '1.0.0',
    });
    // This device's token for its private channel (Realtime Authorization): it may receive there and nowhere else.
    // Set before joining, so the very first join carries it; kept across reconnects. The device asks for a new one
    // when the channel name changes.
    await socket.setAuth(accessToken);
    if (this.stopped || this.channelInfo !== info) {
      socket.disconnect();
      return;
    }
    const channel = socket.channel(info.topic, { config: { broadcast: { self: false, ack: false }, private: true } });
    channel.on('broadcast', { event: info.event }, (message: { payload?: unknown }) => {
      const parsed = realtimeSignalSchema.safeParse(message.payload);
      if (parsed.success) this.handlers.onSignal(parsed.data);
    });
    channel.subscribe((status) => {
      if (this.stopped) return;
      const live = status === 'SUBSCRIBED';
      const wasLive = this.live;
      this.live = live;
      if (live && !wasLive) this.handlers.onListening();
    });
    this.socket = socket;
    this.channel = channel;
  }

  private closeChannel(): void {
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.rotateTimer = null;
    this.live = false;
    const socket = this.socket;
    const channel = this.channel;
    this.socket = null;
    this.channel = null;
    this.channelInfo = null;
    if (channel && socket) {
      void socket.removeChannel(channel).finally(() => socket.disconnect());
    } else {
      socket?.disconnect();
    }
  }
}
