/**
 * The Bedo Chat apps show this website in their own web view, which cannot receive Web Push. Each app gives the page
 * a channel to ask it for notifications: the app asks the phone for permission, registers with Apple (D-53, iPhone)
 * or Firebase (D-58, Android), and answers with its device address, which the page saves like a browser's.
 *
 * - iPhone: a message handler named "bedo" (window.webkit.messageHandlers.bedo); postMessage answers with a promise.
 * - Android: a web message listener named "bedoAndroid" (window.bedoAndroid), offered by the app to
 *   https://bedochat.com only; messages are strings, each answered with the same id.
 *
 * In a browser none of this exists and nothing changes.
 */

export interface AppPushStatus {
  /** The phone's notification permission for the app. */
  permission: 'granted' | 'denied' | 'default';
  /** The app's device address once registered (Apple or Firebase), else null. */
  endpoint: string | null;
}

interface Handler {
  postMessage(message: Record<string, unknown>): Promise<unknown>;
}

interface AndroidBridge {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** How long the page waits for the Android app's answer (the permission question may stay open a while). */
const ANDROID_TIMEOUT_MS = 5 * 60_000;

let androidHandler: Handler | null = null;

function iphoneHandler(): Handler | null {
  if (typeof window === 'undefined') return null;
  const webkit = (window as Window & { webkit?: { messageHandlers?: { bedo?: Handler } } }).webkit;
  return webkit?.messageHandlers?.bedo ?? null;
}

function androidBridge(): AndroidBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as Window & { bedoAndroid?: AndroidBridge }).bedoAndroid;
  return bridge && typeof bridge.postMessage === 'function' && typeof bridge.addEventListener === 'function' ? bridge : null;
}

/** The Android channel as a promise per message, like the iPhone's: each message carries an id, each answer the same. */
function makeAndroidHandler(bridge: AndroidBridge): Handler {
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  bridge.addEventListener('message', (event) => {
    let answer: { id?: unknown; result?: unknown; error?: unknown };
    try {
      answer = JSON.parse(String(event.data)) as typeof answer;
    } catch {
      return;
    }
    const call = typeof answer.id === 'number' ? waiting.get(answer.id) : undefined;
    if (!call) return;
    waiting.delete(answer.id as number);
    clearTimeout(call.timer);
    if (typeof answer.error === 'string') call.reject(new Error(answer.error));
    else call.resolve(answer.result);
  });
  return {
    postMessage(message) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error('The app did not answer'));
        }, ANDROID_TIMEOUT_MS);
        waiting.set(id, { resolve, reject, timer });
        bridge.postMessage(JSON.stringify({ ...message, id }));
      });
    },
  };
}

function handler(): Handler | null {
  const iphone = iphoneHandler();
  if (iphone) return iphone;
  const bridge = androidBridge();
  if (!bridge) return null;
  androidHandler ??= makeAndroidHandler(bridge);
  return androidHandler;
}

/** Whether this page is running inside a Bedo Chat app (iPhone or Android). */
export function inNativeApp(): boolean {
  return handler() !== null;
}

/** Whether this page is running inside the Bedo Chat iPhone app. */
export function inIphoneApp(): boolean {
  return iphoneHandler() !== null;
}

/** Whether this page is running inside the Bedo Chat Android app (D-58). */
export function inAndroidApp(): boolean {
  return iphoneHandler() === null && androidBridge() !== null;
}

function status(value: unknown): AppPushStatus {
  const answer = (value ?? {}) as { permission?: unknown; endpoint?: unknown };
  const permission = answer.permission === 'granted' || answer.permission === 'denied' ? answer.permission : 'default';
  return { permission, endpoint: typeof answer.endpoint === 'string' && answer.endpoint.startsWith('https://') ? answer.endpoint : null };
}

/** The app's notification permission and device address, without asking anything. */
export async function appPushStatus(): Promise<AppPushStatus> {
  return status(await handler()!.postMessage({ type: 'push-status' }));
}

/** Asks the phone for permission (once; later the answer comes from its Settings) and registers the device. */
export async function appEnablePush(): Promise<AppPushStatus> {
  return status(await handler()!.postMessage({ type: 'push-enable' }));
}

/** The keys saved with the app's address: they say which service it belongs to (the address itself does too). */
export function appPushKeys(): { p256dh: string; auth: string } {
  return inAndroidApp() ? { p256dh: 'fcm', auth: 'fcm' } : { p256dh: 'apns', auth: 'apns' };
}

/** The number on the app icon (the same unread count as the website's, D-41). */
export function appSetBadge(count: number): void {
  void handler()
    ?.postMessage({ type: 'badge', count })
    .catch(() => undefined);
}

/** Opens the phone's Settings page of the app (where notifications are turned back on after "Don't Allow"). */
export function appOpenSettings(): void {
  void handler()
    ?.postMessage({ type: 'open-settings' })
    .catch(() => undefined);
}
