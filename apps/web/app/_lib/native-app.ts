/**
 * D-53: the iPhone app shows this website in a web view, which cannot receive Web Push. The app adds a message
 * handler named "bedo" (window.webkit.messageHandlers.bedo) through which the page asks it for notifications: the app
 * asks iOS for permission, registers with Apple, and answers with its device address, which the page saves like a
 * browser's. Outside the iPhone app (any browser, the Android app) none of this exists and nothing changes.
 */

export interface AppPushStatus {
  /** iOS notification permission for the app. */
  permission: 'granted' | 'denied' | 'default';
  /** https://api.push.apple.com/3/device/<token> once registered, else null. */
  endpoint: string | null;
}

interface Handler {
  postMessage(message: unknown): Promise<unknown>;
}

function handler(): Handler | null {
  if (typeof window === 'undefined') return null;
  const webkit = (window as Window & { webkit?: { messageHandlers?: { bedo?: Handler } } }).webkit;
  return webkit?.messageHandlers?.bedo ?? null;
}

/** Whether this page is running inside the Bedo Chat iPhone app. */
export function inIphoneApp(): boolean {
  return handler() !== null;
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

/** Asks iOS for permission (once; later the answer comes from Settings) and registers with Apple. */
export async function appEnablePush(): Promise<AppPushStatus> {
  return status(await handler()!.postMessage({ type: 'push-enable' }));
}

/** The number on the app icon (the same unread count as the website's, D-41). */
export function appSetBadge(count: number): void {
  void handler()
    ?.postMessage({ type: 'badge', count })
    .catch(() => undefined);
}

/** Opens the iPhone Settings page of the app (where notifications are turned back on after "Don't Allow"). */
export function appOpenSettings(): void {
  void handler()
    ?.postMessage({ type: 'open-settings' })
    .catch(() => undefined);
}
